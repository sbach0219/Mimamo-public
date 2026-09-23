import { collection, doc, setDoc, updateDoc, getDoc, serverTimestamp, Timestamp } from '@react-native-firebase/firestore';
import { db } from '../../lib/firebase';
import { getFcmToken } from '../../lib/fcmToken';
import { saveActiveWatch, removeActiveWatch } from '../../lib/activeWatch';
import { canStartPairWalk, normalizeDestinationLabel } from '../../lib/pairs';
import type { SessionContext, SessionState } from './types';
import { tsToDate, parseTransport, parseSensitivity, normalizeWalkerName, sessionResetPatch, userError, assertNoLiveSession, hasLiveSessionState } from './model';

// Firestore の書き込み Promise はサーバー ack まで解決しないため、圏外で
// リンクを開くと「セッションに参加中...」のまま永久に止まる。参加処理にだけ
// 制限時間を設ける（キューされた書き込み自体は回線回復後に届く）。
const JOIN_TIMEOUT_MS = 20_000;

function withJoinTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(userError('つながりませんでした。通信を確認して、もう一度リンクを開いてください')), JOIN_TIMEOUT_MS)
    ),
  ]);
}

export function createLifecycleActions({ set, get, runtime, ensureSignedIn }: SessionContext): Pick<SessionState,
  'hasLiveSession' | 'createSession' | 'startPairWalk' | 'joinSession' | 'setPendingJoinId' | 'endSession' | 'abandonSession'
> {
  return {
    hasLiveSession: () => hasLiveSessionState(get()),

    createSession: async (estimatedMinutes, home, mode = 'hold', sensitivity = 'medium', transport = 'vehicle_ok', walkerName = null, options) => {
      assertNoLiveSession(get(), options);
      const uid = await ensureSignedIn().catch(() => null);
      if (!uid) throw new Error('認証エラーが発生しました');
      // 起動時に通知を拒否→設定アプリで後から許可、のケースを救うため、
      // まだトークンが無ければここでも取得を試みる（起動時1回だけだと永遠に空のまま）
      if (!get().fcmToken) {
        const token = await getFcmToken();
        if (token) get().setFcmToken(token);
      }
      const ref = doc(collection(db, 'sessions'));
      const expiresAt = new Date(Date.now() + estimatedMinutes * 60_000 + 1_800_000);
      const data: Record<string, any> = {
        status: 'waiting',
        estimatedMinutes,
        mode,
        watcherUid: uid,
        createdAt: serverTimestamp(),
        expiresAt: Timestamp.fromDate(expiresAt),
      };
      if (mode === 'sentinel') data.sentinelSensitivity = sensitivity;
      data.transport = transport;
      // ペア起点の「見守り依頼」（2026-08-26 決定①）。この時点では walkerUid は空で、
      // 位置は1点も流れない。歩く人が端末で承諾（joinSession）して初めて動き出す。
      const pairId = options?.pairId ?? null;
      if (pairId) data.pairId = pairId;
      // 呼び名は任意。空欄なら書かない（フィールドを持たないセッションが既定）
      const name = normalizeWalkerName(walkerName);
      if (name) data.walkerName = name;
      const token = get().fcmToken;
      if (token) data.watcherFcmToken = token;
      if (home) {
        data.homeLatitude = home.latitude;
        data.homeLongitude = home.longitude;
      }
      await setDoc(ref, data);
      // 旧セッションの購読を必ず切る（H-4）。残したままだと、旧セッションの
      // スナップショットが新しい sessionId の state を上書きし続ける。
      get().stopListening();
      runtime.routeThinner.reset();
      set({
        // 新しい見守りを作るときも、器に残っている前のセッションの値を落とす（H-3 と同型。
        // v3 ではホームの「＋追加する」が直前まで見ていた見守りの上に重なる）
        ...sessionResetPatch(),
        sessionId: ref.id, estimatedMinutes, myRole: 'watcher', homeLocation: home ?? null,
        mode, sentinelSensitivity: sensitivity, transport, expiresAt, walkerName: name,
        pairId, status: 'waiting', isSessionExpired: false,
      });
      // 見守りセッションの永続化（プロセスkill後に見守り画面へ復帰できるように）
      saveActiveWatch(ref.id).catch(() => { });
      return ref.id;
    },

    // 恒久ペア起点の歩行開始（ADR P3 決定2・E-4）。
    // 歩く人が自分でセッション文書を作るので waiting を経ない（歩き始め＝作成）。
    // 「見守り手が遠隔で相手の位置共有を開始する」経路はここにも rules にも作らない（I-2）。
    startPairWalk: async (pair, options) => {
      assertNoLiveSession(get(), options);
      const uid = await ensureSignedIn().catch(() => null);
      if (!uid) throw userError('認証エラーが発生しました');
      if (!canStartPairWalk(pair, uid)) {
        throw userError('このつながりでは歩きはじめられません。つながりを確認してください');
      }
      if (!get().fcmToken) {
        const token = await getFcmToken();
        if (token) get().setFcmToken(token);
      }
      const {
        estimatedMinutes, mode = 'sentinel', sensitivity = 'medium',
        transport = 'vehicle_ok', home = null, destinationLabel,
      } = options;
      const ref = doc(collection(db, 'sessions'));
      const expiresAt = new Date(Date.now() + estimatedMinutes * 60_000 + 1_800_000);
      const data: Record<string, any> = {
        status: 'active',
        pairId: pair.id,
        watcherUid: pair.watcherUid,
        walkerUid: uid,
        estimatedMinutes,
        mode,
        transport,
        createdAt: serverTimestamp(),
        startedAt: serverTimestamp(),
        expiresAt: Timestamp.fromDate(expiresAt),
      };
      if (mode === 'sentinel') data.sentinelSensitivity = sensitivity;
      const label = normalizeDestinationLabel(destinationLabel ?? '');
      if (label) data.destinationLabel = label;
      const token = get().fcmToken;
      if (token) data.walkerFcmToken = token;
      if (home) {
        data.homeLatitude = home.latitude;
        data.homeLongitude = home.longitude;
      }
      await setDoc(ref, data);
      get().stopListening();
      runtime.routeThinner.reset();
      set({
        // 器に残っている前のセッションの値を必ず落とす（H-3）。これが無いと、SOS で
        // 終わった歩行の直後に新しい歩行を始めたとき、sosAt や safetyCheck が
        // 幽霊として乗ったまま status だけ active になる。
        ...sessionResetPatch(),
        sessionId: ref.id, pairId: pair.id, myRole: 'walker', status: 'active',
        estimatedMinutes, mode, sentinelSensitivity: sensitivity, transport,
        homeLocation: home, expiresAt, isSessionExpired: false, messages: [],
        routeCoordinates: [], joinError: null,
      });
      return ref.id;
    },

    joinSession: async (id, options) => {
      set({ isJoining: true, joinError: null });
      try {
        assertNoLiveSession(get(), options);
        const uid = await ensureSignedIn().catch((e) => { throw userError(e?.message ?? '認証エラーが発生しました'); });
        if (!uid) throw userError('認証エラーが発生しました');
        // createSession と同様、起動時に未許可だった場合の再取得を試みる
        if (!get().fcmToken) {
          const token = await getFcmToken();
          if (token) get().setFcmToken(token);
        }
        const ref = doc(db, 'sessions', id);
        const snap = await withJoinTimeout(getDoc(ref));
        if (!snap.exists()) throw userError('セッションが見つかりません');
        const data = snap.data() ?? {};
        const expiresAt = tsToDate(data.expiresAt);
        if (expiresAt && expiresAt < new Date()) throw userError('このセッションは有効期限が切れています');
        if (data.status === 'ended') throw userError('このセッションはすでに終了しています');
        if (data.status === 'cancelled') throw userError('この見守りはキャンセルされました。もう一度リンクを作ってもらってください');
        // 見守る人が自分のリンクを開いた場合。参加させると myRole が walker に
        // 上書きされ、activeWatch は watcher のまま残って状態がねじれる。
        if (data.watcherUid === uid) {
          throw userError('これはあなたが作った見守りリンクです。歩く人に送ってください');
        }
        if (data.walkerUid && data.walkerUid !== uid) {
          throw userError('この見守りには、すでに別の人が参加しています');
        }
        const joinData: Record<string, any> = {
          walkerUid: uid,
          status: 'active',
          startedAt: serverTimestamp(),
        };
        const token = get().fcmToken;
        if (token) joinData.walkerFcmToken = token;
        try {
          await withJoinTimeout(updateDoc(ref, joinData));
        } catch (e) {
          // 制限時間で諦めたあとに書き込みが遅れて成立することがある。その場合
          // サーバー上は active なのに端末は未参加＝「誰も歩いていない見守り」に
          // なってしまうため、一度だけ実際の状態を確認して拾い直す。
          const restored = await Promise.race([
            get().restoreWalkSession(id).catch(() => false),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
          ]);
          if (!restored) throw e;
          set({ pendingJoinId: null });
          return;
        }
        runtime.routeThinner.reset();
        get().stopListening();
        set({
          // 乗り換え前に前のセッションの値を落とす（H-3。startPairWalk と同型）
          ...sessionResetPatch(),
          sessionId: id,
          estimatedMinutes: typeof data.estimatedMinutes === 'number' ? data.estimatedMinutes : 10,
          pendingJoinId: null,
          myRole: 'walker',
          status: 'active',
          isSessionExpired: false,
          pairId: typeof data.pairId === 'string' ? data.pairId : null,
          mode: data.mode === 'sentinel' ? 'sentinel' : 'hold',
          sentinelSensitivity: parseSensitivity(data.sentinelSensitivity),
          transport: parseTransport(data.transport),
        });
      } catch (e: any) {
        // 失敗時は pendingJoinId を必ずクリアする。残したままだと、同じ見守りリンクを
        // もう一度開いても値が変わらず（Object.is 一致）RoleSelect の自動参加 effect が
        // 再発火しないため、一時的なネットワークエラー等からのリトライが不可能になる。
        // 自分で組み立てた文言だけを画面に出す（rules 拒否などの生の英語を見せない）。
        const message = e?.userFacing
          ? e.message
          : 'つながりませんでした。通信を確認して、もう一度リンクを開いてください';
        if (__DEV__ && !e?.userFacing) console.warn('joinSession failed', e);
        set({ joinError: message, pendingJoinId: null });
        throw e;
      } finally {
        set({ isJoining: false });
      }
    },

    setPendingJoinId: (id) => set({ pendingJoinId: id }),

    endSession: async (reason = 'ended') => {
      const { sessionId, myRole } = get();
      if (!sessionId) return false;
      const patch: Record<string, any> = { status: reason, endedAt: serverTimestamp() };
      // 「誰が終わらせたか」は歩く人への文言と通知の分岐にだけ使う付随情報
      // （watcher-exit ADR 決定D）。status の許可リストには影響させない。
      if (myRole === 'watcher' && reason === 'ended') patch.endedBy = 'watcher';
      try {
        await updateDoc(doc(db, 'sessions', sessionId), patch);
      } catch (error) {
        console.warn('session end failed', error);
        return false;
      }
      get().stopListening();
      get().stopConnectionMonitoring();
      // 見守り側が自分で終了した場合（例: 参加待ちタイムアウトのキャンセル）の永続化解除
      if (myRole === 'watcher') removeActiveWatch(sessionId).catch(() => { });
      runtime.sosDeliveryRequestId += 1;
      runtime.routeThinner.reset();
      set({ ...sessionResetPatch(), sessionId: null, pairId: null, myRole: null, joinError: null });
      return true;
    },

    // 位置共有が成立しなかった歩行の後始末（H-2 / M-C）。サーバー側はキャンセルとして
    // 終端させる。見守り側から見ると「位置が届かないまま異常な歩行が続いている」
    // ように見え、実際には歩いていないという最悪の食い違いになるため。
    // 書き込みが通らなかったときでも端末側の器は必ず空ける——生きたセッションが
    // 残ると、次に届いた参加リンクがブロックされて開けなくなる。
    abandonSession: async () => {
      if (await get().endSession('cancelled')) return;
      get().stopListening();
      get().stopConnectionMonitoring();
      runtime.routeThinner.reset();
      set({ ...sessionResetPatch(), sessionId: null, pairId: null, myRole: null, joinError: null });
    },
  };
}
