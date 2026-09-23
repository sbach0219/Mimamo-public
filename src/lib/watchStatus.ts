import type { WalkStartResult } from '../tasks/locationTask';

// 歩く人に「いま みまもられているか」を返す判定。
// 位置は送れているのにデッドマン判定は止まっている、といった食い違いは本人にも
// 見守る人にも見えないまま起きる（architecture-review A-8）。表示に使う純ロジック
// なのでここに切り出してテストする。
export type WatchTone = 'ok' | 'weak' | 'stopped';

// heartbeat がこれ以上とどいていなければ「とまっている」とみなす。
// 送信間隔は30秒なので、2回分の取りこぼしを許容する余裕を持たせている。
export const HEARTBEAT_STALE_MS = 100_000;

export function watchTone(input: {
  online: boolean;
  walkStart: WalkStartResult | null;
  lastHeartbeatOkAt: number | null;
  now: number;
  sessionLive: boolean;
}): WatchTone {
  if (!input.sessionLive) return 'stopped';
  if (input.walkStart === 'denied' || input.walkStart === 'failed') return 'stopped';
  // 一度も届いていないうちは、まだ準備中なので「とまっている」とは言わない
  if (input.lastHeartbeatOkAt != null && input.now - input.lastHeartbeatOkAt > HEARTBEAT_STALE_MS) {
    return 'stopped';
  }
  if (!input.online) return 'weak';
  // 「使用中のみ許可」はアプリを閉じると止まる＝いまは見守れているが条件付き
  if (input.walkStart === 'foreground-only') return 'weak';
  return 'ok';
}
