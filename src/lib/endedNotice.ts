// 見守りの終了は2つの経路で歩く人に届く。サーバーからの FCM（watch_ended /
// watch_auto_ended）と、位置タスクが書き込み拒否から気づいて出すローカル通知である。
// どちらか片方に寄せるとゼロ通知の穴が開く——通知許可を切っている端末には FCM が
// 出ず、アプリが落ちている端末では位置タスクが動かない。両方残したうえで、同じ
// セッションについて短い時間に重ねて出すことだけをここで止める。
//
// 端末内・プロセス内の記憶にすぎない（永続化しない）。取りこぼしても余分な通知が
// 1通増えるだけで、消えるより安全な側に倒れる。
const DEDUPE_WINDOW_MS = 10_000;

const shownAt = new Map<string, number>();

// 出してよければ true を返し、同時にこのセッションを「出した」として記録する。
export function claimEndedNotice(sessionId: string, now: number = Date.now()): boolean {
  for (const [id, at] of shownAt) {
    if (now - at > DEDUPE_WINDOW_MS) shownAt.delete(id);
  }
  const last = shownAt.get(sessionId);
  if (last != null && now - last <= DEDUPE_WINDOW_MS) return false;
  shownAt.set(sessionId, now);
  return true;
}

// テスト用。プロセス内の記憶を空にする。
export function resetEndedNotices(): void {
  shownAt.clear();
}
