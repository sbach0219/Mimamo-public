// セッション状態値の単一定義（architecture-review B-2）。
//
// これまで同じ集合が store の LIVE_SESSION_STATUSES・functions の TERMINAL_STATUSES・
// rules の isLiveSession・履歴画面のラベルへ4重に写されており、値を1つ増やすたびに
// 4箇所を暗黙に同期する必要があった。恒久ペアで状態の書き手が増える前に一本化する。
//
// firestore.rules と functions/index.js はビルド境界の外にあり、このファイルを
// import できない。値を変えるときは以下も必ず一緒に直すこと:
//   - firestore.rules  : isLiveSession() / isWalkerWritableStatus()
//   - functions/index.js : TERMINAL_STATUSES

export const SESSION_STATUSES = [
  'waiting', 'active', 'alert', 'anomaly', 'sos', 'arrived', 'ended', 'cancelled',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

// 「まだ終端していない」状態。セッションの復元可否（store / locationTask）の判定に使う。
// waiting を含むのは、歩く人の参加を待っている段階もセッションとしては生きているため。
export const LIVE_SESSION_STATUSES = [
  'waiting', 'active', 'alert', 'anomaly', 'sos',
] as const satisfies readonly SessionStatus[];

// 歩く人が位置・ハートビートを書いてよい状態（firestore.rules の isLiveSession と同値）。
// waiting は歩く人がまだ居ないので含まない。
export const WALKER_WRITABLE_STATUSES = [
  'active', 'alert', 'anomaly', 'sos',
] as const satisfies readonly SessionStatus[];

// これ以上セッションが進行しない状態。保持期間（7日）の起点になる。
export const TERMINAL_SESSION_STATUSES = [
  'arrived', 'ended', 'cancelled',
] as const satisfies readonly SessionStatus[];

// heartbeat がこれ以上とどいていなければ「とだえている」とみなす境界。
// 見守り側の接続判定（sessionStore の connectionStatus）と、ホームのリスト行バッジ
// （aggregateWatchStatus）が同じ値を見る必要がある。片方だけ変えると、同じセッションが
// 詳細画面では「とだえています」・ホームでは「移動中」に見える食い違いが起きる。
export const HEARTBEAT_STALE_SEC = 75;
export const HEARTBEAT_STALE_MS = HEARTBEAT_STALE_SEC * 1000;

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && (SESSION_STATUSES as readonly string[]).includes(value);
}

// Firestore から読んだ未知の値を安全に既定値へ丸める。
export function parseSessionStatus(value: unknown, fallback: SessionStatus = 'active'): SessionStatus {
  return isSessionStatus(value) ? value : fallback;
}

export function isLiveSessionStatus(value: unknown): boolean {
  return isSessionStatus(value) && (LIVE_SESSION_STATUSES as readonly string[]).includes(value);
}

export function isTerminalSessionStatus(value: unknown): boolean {
  return isSessionStatus(value) && (TERMINAL_SESSION_STATUSES as readonly string[]).includes(value);
}

// 終端を書いた主体。'watcher' は見守る人の操作（F-10 / E3）、'pair_revoked' は
// ペア解除に伴うサーバー側の終端（functions の onPairChange）。無印の 'ended' は
// 時間切れなどの自動終了で、歩く人への文言はこの3者で言い分ける。
export const SESSION_ENDED_BY = ['watcher', 'pair_revoked'] as const;
export type SessionEndedBy = typeof SESSION_ENDED_BY[number];

export function parseSessionEndedBy(value: unknown): SessionEndedBy | null {
  return typeof value === 'string' && (SESSION_ENDED_BY as readonly string[]).includes(value)
    ? (value as SessionEndedBy)
    : null;
}

// 歩く人に見せる終了理由。status と endedBy の組から決める写像で、歩行2画面
// （MainScreen / useWalkLifecycle）と SessionEndedOverlay が同じものを使う。
export type SessionEndedReason = 'ended' | 'cancelled' | 'watcher' | 'pair_revoked';

export function endedReasonFor(status: string, endedBy: SessionEndedBy | null): SessionEndedReason {
  if (status === 'cancelled') return 'cancelled';
  if (endedBy === 'watcher') return 'watcher';
  if (endedBy === 'pair_revoked') return 'pair_revoked';
  return 'ended';
}
