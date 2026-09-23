import { useSession } from '../store/sessionStore';
import { parseSessionStatus, type SessionStatus } from './sessionStatus';

// リスト（ホーム・ちず・メッセージ）から1件の見守りを開くときの共通手順。
//
// sessionStore は「いま開いている1セッション」を持つ器なので、詳細・チャット・SOS へ
// 進む前に、その器を目的のセッションへ向け直す必要がある。restoreWatchSession は
// 生存確認・前のセッションの値の破棄・購読の張り替え・FCMトークンの再登録まで
// 面倒を見るので、リスト側はこれを呼ぶだけでよい。
//
// 戻り値はサーバーで確認した status（開けなければ null）。行き先の判定にはこれを使う。
// リスト側が持つ status は購読が届いた時点のもので、タップした瞬間には古くなり得る。
export async function focusWatchSession(sessionId: string): Promise<SessionStatus | null> {
  const store = useSession.getState();
  // すでに開いているセッションなら、購読が最新の status を持っている
  if (store.sessionId === sessionId && store.myRole === 'watcher') return parseSessionStatus(store.status);
  try {
    const result = await store.restoreWatchSession(sessionId);
    return result.ok ? result.status : null;
  } catch {
    return null;
  }
}

// 緊急対応中に器を別のセッションへ向け直してよいか（M-7）。
// SOS・異変・応答なしの対応中に別の行を開くと、いま見ている緊急セッションの
// 購読が切れて画面の中身が入れ替わる。FCM は届き続けるので致命ではないが、
// 「いま見ていたものが消える」ことは緊急時にしてよい失敗ではない。
// targetSessionId 省略時は「これから作る新しいセッション」の意味（ペア依頼の送信）。
export function isEmergencySwitchBlocked(targetSessionId?: string): boolean {
  const store = useSession.getState();
  if (targetSessionId != null && store.sessionId === targetSessionId) return false;
  if (!store.hasLiveSession()) return false;
  return store.status === 'sos' || store.status === 'anomaly' || store.status === 'alert';
}
