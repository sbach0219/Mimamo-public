import type { AnomalyType } from './sentinel';
import { HEARTBEAT_STALE_MS, type SessionStatus } from './sessionStatus';
import { isLocationMissing, type LocationMode } from './locationMode';

// 見守り側ホームの「集約バナー」と「リスト行の状態バッジ」の純ロジック
// （docs/design-v3-watcher-redesign §3.1 / §7.1）。
//
// 設計上の要点はふたつ。
// 1. 新しいサーバー状態を発明しない。既存の status × heartbeat の写像に徹する。
// 2. **システムが観測した事実だけを言う**（D-9）。「安全なエリアにいます」のような
//    検証できない評価は文言に載せない。言えるのは「見守り中で、異常は検知していない」まで。
//
// 表示に使う純ロジックなので watchStatus.ts（歩く人側の watchTone）と同じ扱いで
// ここに切り出し、jest で固定する。

// 途絶の境界は sessionStore の接続判定と同じ値を使う（定義は sessionStatus.ts）。
export { HEARTBEAT_STALE_MS };

// 呼び名（walkerName）が未設定のときの表示名。「◯◯さん」と さん を足さないのは、
// 呼び名がすでに「おじいちゃん」「はるちゃん」のような呼びかけの形で入るため。
export const DEFAULT_WALKER_LABEL = '歩く人';

export type WatchTarget = {
  id: string;
  status: SessionStatus;
  // 見守る人が設定時に入力した相手の呼び名（任意）
  name: string | null;
  // 最後に heartbeat がサーバーへ届いた時刻（ミリ秒）。未受信なら null
  lastHeartbeatAt: number | null;
  // 歩く人の端末で位置共有がどの強さで動いているか（H-2）。
  // null は「まだ報告が届いていない」＝判定不能なので、警告には使わない。
  locationMode?: LocationMode | null;
  anomalyType: AnomalyType | null;
  sosSilent: boolean;
};

export type WatchTone = 'danger' | 'caution' | 'safe' | 'muted';

export type WatchBadge = {
  key: 'emergency' | 'moving' | 'stale' | 'no_location' | 'arrived' | 'waiting';
  label: string;
  tone: WatchTone;
};

export function displayName(target: { name: string | null }): string {
  const name = target.name?.trim();
  return name && name.length > 0 ? name : DEFAULT_WALKER_LABEL;
}

// heartbeat がまだ一度も届いていないうちは「とだえている」とは言わない。
// 参加直後の数十秒を毎回 caution で出すと、注意色が意味を失う。
function heartbeatStale(target: WatchTarget, now: number): boolean {
  return target.lastHeartbeatAt != null && now - target.lastHeartbeatAt > HEARTBEAT_STALE_MS;
}

export function watchRowBadge(target: WatchTarget, now: number): WatchBadge {
  if (target.status === 'sos' || target.status === 'anomaly' || target.status === 'alert') {
    return { key: 'emergency', label: '緊急要請中', tone: 'danger' };
  }
  if (target.status === 'arrived') return { key: 'arrived', label: '到着しました', tone: 'safe' };
  if (target.status === 'waiting') return { key: 'waiting', label: '参加を待っています', tone: 'muted' };
  if (heartbeatStale(target, now)) {
    return { key: 'stale', label: '連絡がとだえています', tone: 'caution' };
  }
  // 位置の許可が拒否された歩行（H-2）。heartbeat は届き続けるので、これを見ないと
  // 「移動中・異常なし」で塗りつぶされる。とだえより後に置いているのは、通信ごと
  // 切れているほうが先に伝えるべき事実だから。
  if (isLocationMissing(target.locationMode ?? null)) {
    return { key: 'no_location', label: '位置が届いていません', tone: 'caution' };
  }
  // D-9 の原則をバッジにも通す。システムが言えるのは「異常を検知していない」までで、
  // 「安全」は検証していない（仕様§3.1 の表の文言も本実装に合わせて改訂した）。
  return { key: 'moving', label: '移動中・異常なし', tone: 'safe' };
}

export type AggregateTone = 'danger' | 'caution' | 'all_safe' | 'idle';

export function aggregateWatchTone(targets: WatchTarget[], now: number): AggregateTone {
  if (targets.length === 0) return 'idle';
  if (targets.some((t) => watchRowBadge(t, now).key === 'emergency')) return 'danger';
  if (targets.some((t) => ['stale', 'no_location'].includes(watchRowBadge(t, now).key))) return 'caution';
  return 'all_safe';
}

export type AggregateBanner = { tone: AggregateTone; text: string };

// 集約バナーの文言（§7.1 の確定表）。idle は「出さない」が正解なので null を返す。
export function aggregateBanner(targets: WatchTarget[], now: number): AggregateBanner | null {
  const tone = aggregateWatchTone(targets, now);
  if (tone === 'idle') return null;

  if (tone === 'danger') {
    const target = targets.find((t) => watchRowBadge(t, now).key === 'emergency')!;
    return { tone, text: `${displayName(target)}${emergencyPhrase(target)}` };
  }
  if (tone === 'caution') {
    const stale = targets.find((t) => watchRowBadge(t, now).key === 'stale');
    if (stale) return { tone, text: `${displayName(stale)}との連絡がとだえています` };
    // 位置が届いていない歩行（H-2）。「見守れていない」という事実だけを言い、
    // 相手の行動を評価しない（D-9）。
    const noLocation = targets.find((t) => watchRowBadge(t, now).key === 'no_location')!;
    return { tone, text: `${displayName(noLocation)}の位置が届いていません` };
  }
  // 「異常はありません」までしか言わない（D-9）。安全であることは保証していない。
  const who = targets.length === 1 ? displayName(targets[0]) : `${targets.length}人`;
  return { tone, text: `${who}を見守り中・異常はありません` };
}

// 緊急の内訳。既存の通知文言（sessionStore の scheduleAlertNotification）と
// 同じ語彙を使う。同じ出来事が通知と画面で別の言い方になると、利用者は
// 「別のことが起きた」と受け取る。
function emergencyPhrase(target: WatchTarget): string {
  if (target.status === 'sos') {
    return target.sosSilent ? 'が音なしの緊急要請を送信しました' : 'が緊急要請を送信しました';
  }
  if (target.status === 'alert') return 'から応答がありません';
  if (target.anomalyType === 'move') return 'が乗り物の速さで移動しています';
  if (target.anomalyType === 'fall') return 'が転んだかもしれません';
  if (target.anomalyType === 'area') return 'が人気のない場所に入ったようです';
  return 'の動きが止まっています';
}
