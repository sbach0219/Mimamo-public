
// デプロイ先リージョン。スケジュール関数は個別に指定済みだが、HTTP/callable も
// 同じところに置く（既定の us-central1 に単独で飛ぶと、レイテンシも運用の見通しも悪い）。
const FUNCTION_REGION = 'asia-northeast1';

// RevenueCat 側の entitlement 識別子。src/lib/purchases.ts の GROUP_ENTITLEMENT_ID と
// 同じ値にすること（ビルド境界が違うので import できない）。
const GROUP_ENTITLEMENT_ID = 'group';

// 終端状態（これ以上セッションが進行しない状態）。保持期間の起点になる。
const TERMINAL_STATUSES = ['ended', 'arrived', 'cancelled'];

// まだ進行中の状態。ペア解除で終端させる対象を引くのに使う（M-4）。
// 値の定義は src/lib/sessionStatus.ts の LIVE_SESSION_STATUSES と揃えること。
const LIVE_STATUSES = ['waiting', 'active', 'alert', 'anomaly', 'sos'];

// 保持期間。終端状態になってからこの期間が過ぎたセッションは記録ごと完全削除する。
// この値はプライバシーポリシーに明記される前提なので、変更するときは
// docs/legal/privacy-policy.md（およびサイトの privacy.html）も必ず一緒に直すこと。
const RETENTION_DAYS = 7;

const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

exports.RETENTION_DAYS = RETENTION_DAYS;

exports.TERMINAL_STATUSES = TERMINAL_STATUSES;

exports.FUNCTION_REGION = FUNCTION_REGION;
exports.RETENTION_MS = RETENTION_MS;
exports.LIVE_STATUSES = LIVE_STATUSES;
exports.GROUP_ENTITLEMENT_ID = GROUP_ENTITLEMENT_ID;
