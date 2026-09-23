import { create } from 'zustand';
import {
  collection, deleteField, doc, getDoc, onSnapshot, query, setDoc, updateDoc, where,
  serverTimestamp, Timestamp,
} from '@react-native-firebase/firestore';
import { auth, db } from '../lib/firebase';
import { DEFAULT_AVATAR_ID } from '../lib/avatars';
import {
  INVITE_TTL_MS, canAcceptInvite, canRevoke, isPairMember, parsePair, roleInPair,
  type Pair, type WalkerLabel,
} from '../lib/pairs';
import { useProfile } from './profileStore';
import { ensureSignedIn, userError } from './sessionStore';

// 恒久ペア（ADR P3 決定2 / Stage 1）。
//
// 招待は二重同意で成立する:
//   1. 見守り手が pairs 文書を status:'invited'・自分の席だけ埋めて作成する。
//      推測不可能な pairId がそのまま招待トークン（QR / リンク）になる。有効期限24時間。
//   2. 受け手がリンクを開き、空席へ自分の uid を書き込むと status:'active' になる。
//   3. 成立・解除はどちらも相手へ通知する（O-2。functions/index.js の onPairChange）。
//
// Stage 1 は現行方向（見守り手が招待を作り、歩く人の席が空く）のみ。
// 逆方向（D-6 遠隔招待）は安全装置3点セットと一緒に Stage 3 で解禁する。

interface PairState {
  pairs: Pair[];
  pairsLoaded: boolean;
  // deep link / QR から届いた招待。画面が拾って受諾フローを出す
  pendingInvitePairId: string | null;
  isAccepting: boolean;
  pairError: string | null;

  subscribeMyPairs: () => void;
  unsubscribeMyPairs: () => void;
  setPendingInvitePairId: (id: string | null) => void;
  clearPairError: () => void;

  createInvite: () => Promise<string>;
  fetchInvite: (pairId: string) => Promise<Pair | null>;
  acceptInvite: (pairId: string) => Promise<Pair>;
  revokePair: (pairId: string) => Promise<void>;
  // 見守る人が預かる相手の呼び名・年齢（D-8）。null で「預かるのをやめる」。
  setWalkerLabel: (pairId: string, label: WalkerLabel | null) => Promise<void>;
  // 表示名・アバターを変えたら、相手が見ている複製も更新する
  syncProfileToPairs: () => Promise<void>;
}

// 見守り手として / 歩く人としての2本を別々に購読する。Firestore は OR クエリを
// 素直に扱えないため、2つの結果をこのマップで束ねてから1つの配列にする。
let asWatcherUnsub: (() => void) | null = null;
let asWalkerUnsub: (() => void) | null = null;
const bucket: { watcher: Pair[]; walker: Pair[] } = { watcher: [], walker: [] };

function mergeBuckets(): Pair[] {
  const byId = new Map<string, Pair>();
  for (const p of [...bucket.watcher, ...bucket.walker]) byId.set(p.id, p);
  // 生きている関係を先に、次に招待中、最後に解除済み。同順位は新しい順。
  const rank = (p: Pair) => (p.status === 'active' ? 0 : p.status === 'invited' ? 1 : 2);
  return [...byId.values()].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
  });
}

export const usePairs = create<PairState>((set, get) => ({
  pairs: [],
  pairsLoaded: false,
  pendingInvitePairId: null,
  isAccepting: false,
  pairError: null,

  subscribeMyPairs: () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    get().unsubscribeMyPairs();
    const attach = (field: 'watcherUid' | 'walkerUid', key: 'watcher' | 'walker') =>
      onSnapshot(
        query(collection(db, 'pairs'), where(field, '==', uid)),
        (snap) => {
          if (!snap) return;
          bucket[key] = snap.docs.map((d) => parsePair(d.id, d.data()));
          set({ pairs: mergeBuckets(), pairsLoaded: true });
        },
        () => set({ pairsLoaded: true }),
      );
    asWatcherUnsub = attach('watcherUid', 'watcher');
    asWalkerUnsub = attach('walkerUid', 'walker');
  },

  unsubscribeMyPairs: () => {
    asWatcherUnsub?.();
    asWalkerUnsub?.();
    asWatcherUnsub = asWalkerUnsub = null;
    bucket.watcher = [];
    bucket.walker = [];
  },

  setPendingInvitePairId: (id) => set({ pendingInvitePairId: id }),
  clearPairError: () => set({ pairError: null }),

  // entitlement ゲート（v3移行設計書 §2.5 / D-11: 月額サブスク）は rules 側にあり、
  // 資格が無ければこの書き込み自体が拒まれる。画面側（PairsScreen）でも先に止めて
  // いるのは、失敗を見せる前に「なぜできないか」を言うため。
  // 同時見守り人数の上限は rules では強制できない（§2.5.3）ので、そちらは
  // クライアント制御と watchSessions の事後検出の2層で守る。
  createInvite: async () => {
    const uid = await ensureSignedIn().catch(() => null);
    if (!uid) throw userError('認証エラーが発生しました');
    const profile = useProfile.getState().profile;
    const ref = doc(collection(db, 'pairs'));
    await setDoc(ref, {
      status: 'invited',
      createdByUid: uid,
      watcherUid: uid,
      walkerUid: '',
      watcherDisplayName: profile.displayName,
      watcherAvatar: profile.avatar,
      walkerDisplayName: '',
      walkerAvatar: DEFAULT_AVATAR_ID,
      createdAt: serverTimestamp(),
      inviteExpiresAt: Timestamp.fromDate(new Date(Date.now() + INVITE_TTL_MS)),
    });
    return ref.id;
  },

  fetchInvite: async (pairId) => {
    await ensureSignedIn().catch(() => null);
    try {
      const snap = await getDoc(doc(db, 'pairs', pairId));
      return snap.exists() ? parsePair(snap.id, snap.data()) : null;
    } catch {
      // 期限切れ・解除済みの招待は rules が get 自体を拒む。区別せず「見つからない」に丸める
      return null;
    }
  },

  acceptInvite: async (pairId) => {
    set({ isAccepting: true, pairError: null });
    try {
      const uid = await ensureSignedIn().catch(() => null);
      if (!uid) throw userError('認証エラーが発生しました');
      const pair = await get().fetchInvite(pairId);
      if (!pair) throw userError('この招待は見つかりません。期限が切れているかもしれません');
      if (isPairMember(pair, uid)) {
        set({ pendingInvitePairId: null });
        return pair;
      }
      if (pair.createdByUid === uid) {
        throw userError('これはあなたが作った招待です。相手にわたしてください');
      }
      if (pair.status === 'revoked') throw userError('このつながりは解除されています');
      if (!canAcceptInvite(pair, uid)) {
        throw userError('この招待は期限が切れています。もう一度つくってもらってください');
      }
      const profile = useProfile.getState().profile;
      await updateDoc(doc(db, 'pairs', pairId), {
        walkerUid: uid,
        status: 'active',
        acceptedAt: serverTimestamp(),
        walkerDisplayName: profile.displayName,
        walkerAvatar: profile.avatar,
      });
      set({ pendingInvitePairId: null });
      return { ...pair, walkerUid: uid, status: 'active' as const };
    } catch (e: any) {
      const message = e?.userFacing
        ? e.message
        : 'つながれませんでした。通信を確認して、もう一度ひらいてください';
      if (__DEV__ && !e?.userFacing) console.warn('acceptInvite failed', e);
      set({ pairError: message, pendingInvitePairId: null });
      throw e;
    } finally {
      set({ isAccepting: false });
    }
  },

  revokePair: async (pairId) => {
    const uid = auth.currentUser?.uid;
    if (!uid) throw userError('認証エラーが発生しました');
    const pair = get().pairs.find((p) => p.id === pairId);
    // 招待中（まだ相手が居ない）ものも取り消せる。相手が居ないので通知は起きない。
    if (pair && !canRevoke(pair, uid) && !(pair.status === 'invited' && pair.createdByUid === uid)) {
      throw userError('このつながりは解除できません');
    }
    await updateDoc(doc(db, 'pairs', pairId), {
      status: 'revoked',
      revokedAt: serverTimestamp(),
      revokedByUid: uid,
    });
  },

  setWalkerLabel: async (pairId, label) => {
    const uid = auth.currentUser?.uid;
    if (!uid) throw userError('認証エラーが発生しました');
    const pair = get().pairs.find((p) => p.id === pairId);
    if (pair && (pair.status !== 'active' || pair.watcherUid !== uid)) {
      // 書けるのは見守る人だけ（rules と同じ判断をクライアントでも先に下す）。
      // 歩く人が自分の年齢を書く経路は作らない——入力者と用途（110番通報で伝える人）を
      // 一致させる、という §9 の判断そのもの。
      throw userError('この呼び名は変えられません');
    }
    // null は「預かるのをやめる」。フィールドごと消して、空の器を残さない。
    await updateDoc(doc(db, 'pairs', pairId), { walkerLabel: label ?? deleteField() });
  },

  syncProfileToPairs: async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const profile = useProfile.getState().profile;
    const targets = get().pairs.filter((p) => p.status !== 'revoked' && isPairMember(p, uid));
    await Promise.all(
      targets.map((p) => {
        const role = roleInPair(p, uid);
        const patch = role === 'watcher'
          ? { watcherDisplayName: profile.displayName, watcherAvatar: profile.avatar }
          : { walkerDisplayName: profile.displayName, walkerAvatar: profile.avatar };
        return updateDoc(doc(db, 'pairs', p.id), patch).catch(() => {});
      }),
    );
  },
}));
