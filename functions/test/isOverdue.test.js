// isOverdue() の境界条件テスト。Node 標準の test runner（node:test）を使う。
// functions 側は本番デプロイ対象が小さく、jest 一式を新設するのは大げさなため、
// 依存追加なしで動く軽量テストとして functions/test 配下に置く。
// 実行: cd functions && npm test  （= node --test test/）
const test = require('node:test');
const assert = require('node:assert/strict');
const { isOverdue } = require('../index.js');

// Firestore Timestamp のうち isOverdue が使う toMillis() だけを持つ最小スタブ
const ts = (ms) => ({ toMillis: () => ms });

const NOW = Date.parse('2026-07-25T12:00:00+09:00');

function baseSession(overrides = {}) {
  return {
    status: 'active',
    walkerUid: 'walker-uid',
    startedAt: ts(NOW - 20 * 60 * 1000), // 20分前に出発
    estimatedMinutes: 10,                 // 予定は10分 → 10分超過中
    ...overrides,
  };
}

test('予定時間内（未超過）は false', () => {
  const s = baseSession({ startedAt: ts(NOW - 5 * 60 * 1000), estimatedMinutes: 10 });
  assert.equal(isOverdue(s, NOW), false);
});

test('予定時間を過ぎている（超過・未通知）は true', () => {
  const s = baseSession();
  assert.equal(isOverdue(s, NOW), true);
});

test('ちょうど超過の瞬間（等号）も true（5分粒度なので厳密一致もN15対象）', () => {
  const s = baseSession({ startedAt: ts(NOW - 10 * 60 * 1000), estimatedMinutes: 10 });
  assert.equal(isOverdue(s, NOW), true);
});

test('すでに同じ見積り分数で通知済みなら false（連打防止）', () => {
  const s = baseSession({ overdueNotifiedForMinutes: 10 });
  assert.equal(isOverdue(s, NOW), false);
});

test('notifiedForMinutes === estimatedMinutes の等号ケースも false（再武装しない）', () => {
  const s = baseSession({ estimatedMinutes: 15, overdueNotifiedForMinutes: 15 });
  assert.equal(isOverdue(s, NOW), false);
});

test('延長で estimatedMinutes が増えたあと再超過したら true（再武装）', () => {
  // 前回10分で通知済み。その後+15分延長（合計25分）し、25分超過した
  const s = baseSession({
    startedAt: ts(NOW - 30 * 60 * 1000),
    estimatedMinutes: 25,
    overdueNotifiedForMinutes: 10,
  });
  assert.equal(isOverdue(s, NOW), true);
});

test('延長したがまだ新しい予定時間には達していなければ false', () => {
  const s = baseSession({
    startedAt: ts(NOW - 12 * 60 * 1000),
    estimatedMinutes: 25,
    overdueNotifiedForMinutes: 10,
  });
  assert.equal(isOverdue(s, NOW), false);
});

test('walkerUid が無い（まだ歩く人が参加していない）なら false', () => {
  const s = baseSession({ walkerUid: undefined });
  assert.equal(isOverdue(s, NOW), false);
});

test('status が waiting（未参加）なら false', () => {
  const s = baseSession({ status: 'waiting' });
  assert.equal(isOverdue(s, NOW), false);
});

test('status が ended（終了済み）なら false', () => {
  const s = baseSession({ status: 'ended' });
  assert.equal(isOverdue(s, NOW), false);
});

test('status が sos でも false（対象は active/alert/anomaly のみ）', () => {
  const s = baseSession({ status: 'sos' });
  assert.equal(isOverdue(s, NOW), false);
});

test('status が alert でも対象（true になり得る）', () => {
  const s = baseSession({ status: 'alert' });
  assert.equal(isOverdue(s, NOW), true);
});

test('status が anomaly でも対象（true になり得る）', () => {
  const s = baseSession({ status: 'anomaly' });
  assert.equal(isOverdue(s, NOW), true);
});

test('startedAt が欠損していれば false', () => {
  const s = baseSession({ startedAt: undefined });
  assert.equal(isOverdue(s, NOW), false);
});

test('estimatedMinutes が欠損（数値でない）なら false', () => {
  const s = baseSession({ estimatedMinutes: undefined });
  assert.equal(isOverdue(s, NOW), false);
});

test('estimatedMinutes が数値でない型（文字列）なら false', () => {
  const s = baseSession({ estimatedMinutes: '10' });
  assert.equal(isOverdue(s, NOW), false);
});
