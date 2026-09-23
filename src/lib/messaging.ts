import {
  getMessaging,
  onMessage,
  onTokenRefresh,
} from '@react-native-firebase/messaging';
import { notify } from './notifications';
import { useSession } from '../store/sessionStore';
import { claimEndedNotice } from './endedNotice';

export { getFcmToken } from './fcmToken';

// Firestoreリスナー側（sessionStore.ts）が確実に代替表示してくれる type だけがスキップ対象。
// - sos / alert / anomaly: listenToSession の onSnapshot が newStatus 変化を見て
//   scheduleAlertNotification() をローカル通知する。
// - message: messages コレクションの onSnapshot が isChatViewActive を見て
//   （チャット画面を見ていなければ）ローカル通知する。チャット画面を見ている間は
//   メッセージがそのまま画面に流れるので、どちらの経路でも表示しないのが正しい。
// それ以外（heartbeat_lost/heartbeat_back/overdue/arrived/extended/safety_check/
// safety_ok/sos_cancel/anomaly_resolved 等）はクライアント側に代替表示が一切ないため、
// ここでスキップすると「静かな失敗」になる。sessionId が一致していても必ず表示する。
const LISTENER_COVERED_TYPES = new Set(['sos', 'alert', 'anomaly', 'message']);

// アプリ前面で受信したプッシュは、自前でローカル通知として表示する。
// ただし上記の LISTENER_COVERED_TYPES かつ現在購読中のセッションと同じ事象は
// Firestore リスナー側がすでに表示済みのため、ここで再表示すると二重にバナーが出る。
export function setupForegroundMessages(): () => void {
  const messaging = getMessaging();
  return onMessage(messaging, async (msg) => {
    const sessionId = msg.data?.sessionId as string | undefined;
    const type = msg.data?.type as string | undefined;
    const coveredByListener =
      !!type && LISTENER_COVERED_TYPES.has(type) && !!sessionId && sessionId === useSession.getState().sessionId;
    if (coveredByListener) return;
    // 見守りの終了は位置タスク側からも出る（L-5）。数秒内の重複だけ止める。
    if (sessionId && (type === 'watch_ended' || type === 'watch_auto_ended') && !claimEndedNotice(sessionId)) return;
    const title = msg.notification?.title ?? (msg.data?.title as string) ?? 'お知らせ';
    const body = msg.notification?.body ?? (msg.data?.body as string) ?? '';
    const channel = msg.data?.channel === 'alert' ? 'alert' : 'default';
    // ここで表示するローカル通知にも type/sessionId を引き継ぐ。タップ時のルーティング
    // （notificationRouting.ts）がリモート・ローカルを区別せず同じ規約で読めるようにするため。
    await notify(String(title), String(body), channel, { type, sessionId });
  });
}

// FCMトークンは端末側の都合でローテーションされることがある。
// 放置すると長時間セッションの途中から通知が届かなくなるため、更新を購読して反映する。
export function setupTokenRefresh(onNewToken: (token: string) => void): () => void {
  const messaging = getMessaging();
  return onTokenRefresh(messaging, (token) => {
    if (token) onNewToken(token);
  });
}
