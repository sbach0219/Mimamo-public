// isPurgeable() の境界条件テスト。保持期間ポリシー（終端から7日で完全削除）の判定は
// 「誤って消す」と取り返しがつかないため、消さないべきケースを重点的に固定する。
// 実行: cd functions && npm test  （= node --test）
const test = require('node:test');
const assert = require('node:assert/strict');
const { isPurgeable, RETENTION_DAYS, TERMINAL_STATUSES } = require('../index.js');

// Firestore Timestamp のうち isPurgeable が使う toMillis() だけを持つ最小スタブ
const ts = (ms) => ({ toMillis: () => ms });

const NOW = Date.parse('2026-07-27T12:00:00+09:00');
const DAY = 24 * 60 * 60 * 1000;
const RETENTION_MS = RETENTION_DAYS * DAY;

function terminalSession(overrides = {}) {
  return {
    status: 'ended',
    terminalAt: ts(NOW - 8 * DAY), // 8日前に終了＝保持期間超過
    ...overrides,
  };
}

test('保持期間の定数が7日であること（ポリシー記載と一致させるための回帰ガード）', () => {
  assert.equal(RETENTION_DAYS, 7);
});

test('終端から7日を超えていれば true', () => {
  assert.equal(isPurgeable(terminalSession(), NOW), true);
});

test('ちょうど7日（等号）は true', () => {
  const s = terminalSession({ terminalAt: ts(NOW - RETENTION_MS) });
  assert.equal(isPurgeable(s, NOW), true);
});

test('7日にわずかに満たなければ false（1秒手前）', () => {
  const s = terminalSession({ terminalAt: ts(NOW - RETENTION_MS + 1000) });
  assert.equal(isPurgeable(s, NOW), false);
});

test('終端直後は false', () => {
  const s = terminalSession({ terminalAt: ts(NOW) });
  assert.equal(isPurgeable(s, NOW), false);
});

test('terminalAt が無ければ false（いつ終わったか不明なものは消さない）', () => {
  const s = terminalSession({ terminalAt: undefined });
  assert.equal(isPurgeable(s, NOW), false);
});

test('terminalAt が null でも false', () => {
  const s = terminalSession({ terminalAt: null });
  assert.equal(isPurgeable(s, NOW), false);
});

test('terminalAt が Timestamp でない（toMillis を持たない）なら false', () => {
  const s = terminalSession({ terminalAt: '2026-07-01T00:00:00Z' });
  assert.equal(isPurgeable(s, NOW), false);
});

test('terminalAt.toMillis() が NaN を返しても false', () => {
  const s = terminalSession({ terminalAt: { toMillis: () => NaN } });
  assert.equal(isPurgeable(s, NOW), false);
});

// 非終端ステータスは、どれだけ古くても絶対に消さない（進行中の見守りの保護）
for (const status of ['waiting', 'active', 'alert', 'anomaly', 'sos']) {
  test(`status='${status}'（非終端）は古くても false`, () => {
    const s = terminalSession({ status, terminalAt: ts(NOW - 365 * DAY) });
    assert.equal(isPurgeable(s, NOW), false);
  });
}

// 終端ステータスはいずれも保持期間を過ぎたら削除対象になる
for (const status of TERMINAL_STATUSES) {
  test(`status='${status}'（終端）は保持期間を過ぎたら true`, () => {
    const s = terminalSession({ status });
    assert.equal(isPurgeable(s, NOW), true);
  });
}

test('status が未知の文字列なら false（想定外は消さない側に倒す）', () => {
  const s = terminalSession({ status: 'something_new' });
  assert.equal(isPurgeable(s, NOW), false);
});

test('status が欠損していても false', () => {
  const s = terminalSession({ status: undefined });
  assert.equal(isPurgeable(s, NOW), false);
});

test('session が null/undefined でも例外を投げず false', () => {
  assert.equal(isPurgeable(null, NOW), false);
  assert.equal(isPurgeable(undefined, NOW), false);
});
