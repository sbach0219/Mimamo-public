import { doc, getDoc } from '@react-native-firebase/firestore';
import { db } from '../../lib/firebase';
import { getFcmToken } from '../../lib/fcmToken';
import { saveActiveWatch } from '../../lib/activeWatch';
import { parseSessionStatus } from '../../lib/sessionStatus';
import type { SessionContext, SessionState } from './types';
import { tsToDate, parseTransport, parseSensitivity, parseWalkerName, sessionResetPatch, isRestorableStatus } from './model';

// 復帰したセッションに、いまの端末トークンを書き直す。
// FCM トークンはアプリを閉じている間にもローテートする。復帰時に登録し直さないと、
// セッション文書には古いトークンが残ったままになり、以後この端末宛ての通知
// （歩く人なら安否確認・チャット）が丸ごと届かなくなる。
async function refreshMyFcmToken(get: () => SessionState): Promise<void> {
  try {
    const token = (await getFcmToken()) ?? get().fcmToken;
    if (token) get().setFcmToken(token); // 役割に応じたフィールドへ書き込む
  } catch {
    // トークンが取れなくても復帰自体は成立させる
  }
}
export function createRestorationActions({ set, get, runtime, ensureSignedIn }: SessionContext): Pick<SessionState,
  'restoreWatchSession' | 'restoreWalkSession'
> {
  return {
    restoreWatchSession: async (id) => {
      const uid = await ensureSignedIn().catch(() => null);
      if (!uid) return { ok: false, reason: 'unreadable' };
      let snap;
      try {
        snap = await getDoc(doc(db, 'sessions', id));
      } catch {
        // オフライン等。「読めなかった」ことを呼び出し側へ伝える。ここを 'dead' と
        // 同じ扱いにすると、圏外で起動しただけで永続化が消え、次回の復帰も失われる（M-7）
        return { ok: false, reason: 'unreadable' };
      }
      if (!snap.exists()) return { ok: false, reason: 'dead' };
      const data = snap.data() ?? {};
      if (data.watcherUid !== uid) return { ok: false, reason: 'dead' }; // 別ユーザーの見守りセッションは復元しない
      const expiresAt = tsToDate(data.expiresAt);
      if (expiresAt && expiresAt < new Date()) return { ok: false, reason: 'dead' };
      // 生存判定は許可リスト方式にする（'ended' だけを弾くデナイリストだと、
      // 'cancelled' 等の他の終端ステータスが残っていた場合に誤って復帰してしまう。
      // 将来ステータスが増えても安全側に倒れるよう、生きているものだけを明示的に許可する）。
      if (!isRestorableStatus(data.status)) return { ok: false, reason: 'dead' };
      const status = parseSessionStatus(data.status);
      // 別セッションを購読中だった場合に備え、切り替え前に一旦リスナーを止める
      // （listenToSession() 自身も同じ理由で呼び出し時に stopListening() している）
      get().stopListening();
      set({
        ...sessionResetPatch(),
        sessionId: id,
        myRole: 'watcher',
        // status は onSnapshot を待たずにここで入れる。呼び出し側（起動復帰・通知タップ）は
        // await 直後にこれを見て SOS 画面へ進むかを決めるため、購読の到着を待つと
        // 常に前のセッションの残り値を読むことになる（H-1）
        status,
        walkerName: parseWalkerName(data.walkerName),
        walkerPhone: typeof data.walkerPhone === 'string' && data.walkerPhone.length > 0 ? data.walkerPhone : null,
        sosAt: status === 'sos' ? tsToDate(data.sosAt) : null,
        sosSilent: status === 'sos' && data.sosSilent === true,
        sosAcknowledgedAt: status === 'sos' ? tsToDate(data.sosAcknowledgedAt) : null,
        pairId: typeof data.pairId === 'string' ? data.pairId : null,
        estimatedMinutes: typeof data.estimatedMinutes === 'number' ? data.estimatedMinutes : 10,
        mode: data.mode === 'sentinel' ? 'sentinel' : 'hold',
        sentinelSensitivity: parseSensitivity(data.sentinelSensitivity),
        transport: parseTransport(data.transport),
        homeLocation: typeof data.homeLatitude === 'number' && typeof data.homeLongitude === 'number'
          ? { latitude: data.homeLatitude, longitude: data.homeLongitude }
          : null,
      });
      // listenToSession() は画面（WatcherMonitorScreen）の初回マウント副作用に依存しており、
      // 画面がすでにスタック上にある状態でここに来た場合（例: 通知タップによる別セッションへの
      // 復元）は再マウントが起きず購読が張られない。復元成功時は必ずここで自分で確立する。
      // listenToSession() 自身も呼び出し時に stopListening() するため二重購読にはならない。
      get().listenToSession();
      // 恒久ペア起点のセッションは歩く人が作るので、見守り手は createSession を通らない
      // ＝ activeWatch が一度も書かれていない。ここで永続化しておかないと、通知から
      // 開いた見守りが次の cold start で復帰できない（見守っているつもりで画面が無い）。
      saveActiveWatch(id).catch(() => { });
      await refreshMyFcmToken(get);
      return { ok: true, status };
    },

    // 歩行中にアプリが kill されると、OS は位置タスクを生かし続けるので位置と
    // ハートビートは届き続ける。しかし JS 側に復帰経路がないと、SOS・到着連絡・
    // 時間延長・ホールドのデッドマン判定に二度と到達できないまま「見守られている
    // ように見えるだけ」の状態になる。watcher 側と同じ形で復帰させる。
    restoreWalkSession: async (id) => {
      const uid = await ensureSignedIn().catch(() => null);
      if (!uid) return false;
      let snap;
      try {
        snap = await getDoc(doc(db, 'sessions', id));
      } catch {
        return false; // オフライン等。次回起動時にまた試す
      }
      if (!snap.exists()) return false;
      const data = snap.data() ?? {};
      if (data.walkerUid !== uid) return false; // 自分が歩く人でないセッションは復帰しない
      const expiresAt = tsToDate(data.expiresAt);
      if (expiresAt && expiresAt < new Date()) return false;
      if (!isRestorableStatus(data.status)) return false;
      if (data.status === 'waiting') return false; // 歩き始めていないセッションは対象外
      get().stopListening();
      set({
        // 見守り側と同じく、乗り換え前に前のセッションの値を落とす（H-3）
        ...sessionResetPatch(),
        sessionId: id,
        myRole: 'walker',
        status: parseSessionStatus(data.status),
        pairId: typeof data.pairId === 'string' ? data.pairId : null,
        estimatedMinutes: typeof data.estimatedMinutes === 'number' ? data.estimatedMinutes : 10,
        mode: data.mode === 'sentinel' ? 'sentinel' : 'hold',
        sentinelSensitivity: parseSensitivity(data.sentinelSensitivity),
        transport: parseTransport(data.transport),
        homeLocation: typeof data.homeLatitude === 'number' && typeof data.homeLongitude === 'number'
          ? { latitude: data.homeLatitude, longitude: data.homeLongitude }
          : null,
        isSessionExpired: false,
      });
      runtime.routeThinner.reset();
      get().listenToSession();
      await refreshMyFcmToken(get);
      return true;
    },
  };
}
