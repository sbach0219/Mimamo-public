import { create } from 'zustand';
import { doc, onSnapshot } from '@react-native-firebase/firestore';
import { auth, db } from '../lib/firebase';
import { concurrentWatchLimit } from '../lib/activeWatch';
import { isPurchasesConfigured } from '../lib/purchases';

// 課金資格（D-11: 月額サブスク / v3移行設計書 §2.5.3）。
//
// 書き手は Cloud Functions（RevenueCat webhook）だけで、クライアントは自分の分を
// 読むだけ。rules の users 許可リストに entitlements は入っていないので、
// 本人でも書けない。purchasePlan() の直後に webhook が users を更新し、この購読が
// 拾って画面が切り替わる（数秒の遅れがあるため、購入直後だけは SDK の戻り値も見る）。
//
// フェイルモードの方針: 読めないとき・キー未設定のときは **無料枠として扱う**。
// 資格を過大に見積もって rules に弾かれるより、UI が控えめに出るほうがよい。
// 逆に、安全機能（SOS・異常検知・通知）はこの状態を一切参照しない——課金状態で
// 安全の挙動が変わる設計にしない（§2.5.1）。

export type GroupEntitlement = {
  active: boolean;
  expiresAt: Date | null;
};

interface EntitlementState {
  group: GroupEntitlement;
  loaded: boolean;
  // 購入直後の楽観的な反映。webhook が users を書くまでの数秒を埋める。
  optimisticActive: boolean;
  optimisticUntil: number;

  subscribe: () => void;
  unsubscribe: () => void;
  markPurchased: () => void;
  // サーバーがまだ資格を認めていないのに購入は済んでいる状態か（失敗文言の出し分け）
  isAwaitingServerEntitlement: () => boolean;
  // 資格を持っているか（楽観的な反映を含む）
  isGroupActive: () => boolean;
  // 同時に見守れる人数
  watchLimit: () => number;
  // 購入導線を出してよいか。オーナーのストア設定が済むまでは出さない
  canShowPaywall: () => boolean;
}

// 楽観フラグの寿命。webhook の反映は通常数秒で、これを過ぎても来ないなら
// 「遅い」ではなく「壊れている」。
const OPTIMISTIC_TTL_MS = 60_000;

let unsub: (() => void) | null = null;

const tsToDate = (v: any): Date | null => (v && typeof v.toDate === 'function' ? v.toDate() : null);

function parseGroup(data: Record<string, any> | undefined): GroupEntitlement {
  const g = data?.entitlements?.group;
  return {
    active: g?.active === true,
    expiresAt: tsToDate(g?.expiresAt),
  };
}

export const useEntitlement = create<EntitlementState>((set, get) => ({
  group: { active: false, expiresAt: null },
  loaded: false,
  optimisticActive: false,
  optimisticUntil: 0,

  subscribe: () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    get().unsubscribe();
    unsub = onSnapshot(
      doc(db, 'users', uid),
      (snap) => {
        const group = parseGroup(snap?.data());
        // サーバーが「あり」を返したら楽観的フラグは役目を終える。
        // 「なし」を返したときは消さない——webhook がまだ届いていないだけの可能性がある。
        set(group.active
          ? { group, loaded: true, optimisticActive: false, optimisticUntil: 0 }
          : { group, loaded: true });
      },
      () => set({ loaded: true }),
    );
  },

  unsubscribe: () => {
    unsub?.();
    unsub = null;
  },

  markPurchased: () => set({ optimisticActive: true, optimisticUntil: Date.now() + OPTIMISTIC_TTL_MS }),

  // 楽観フラグは時限にする。webhook が届かない障害（キー未設定・関数の失敗）では
  // サーバーが永久に active を返さず、フラグが下りないままアプリは「使えるつもり」で
  // 固定される。そのあいだ rules は拒否し続けるので、ユーザーには
  // 「つくれませんでした。通信を確認して…」という原因を誤らせる文言だけが出る。
  isGroupActive: () => {
    const s = get();
    if (s.group.active) return true;
    return s.optimisticActive && Date.now() < s.optimisticUntil;
  },

  // 「サーバーはまだ資格を認めていないが、購入直後ではある」状態。
  // 失敗文言を「通信を確認して」ではなく「お支払いの反映を待っています」に
  // 出し分けるために使う。
  isAwaitingServerEntitlement: () => {
    const s = get();
    return !s.group.active && s.optimisticActive;
  },

  watchLimit: () => concurrentWatchLimit(get().isGroupActive()),

  canShowPaywall: () => isPurchasesConfigured(),
}));
