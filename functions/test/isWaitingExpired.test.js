// isWaitingExpired() の境界条件テスト（H-4）。
// 「参加を待っています」の30分自動キャンセルは、これまで見守り画面を開いている
// あいだしか走らなかった。サーバー側へ移した判定を、消してよいものだけを true に
// する方向で固定する（判断がつかないものは必ず false）。
// 実行: cd functions && npm test  （= node --test test/）
const test = require('node:test');
const assert = require('node:assert/strict');
const { isWaitingExpired, WAITING_TIMEOUT_MS } = require('../index.js');

const ts = (ms) => ({ toMillis: () => ms });
const NOW = Date.parse('2026-09-02T12:00:00+09:00');

function waitingSession(overrides = {}) {
  return {
    status: 'waiting',
    watcherUid: 'watcher-uid',
    createdAt: ts(NOW - 45 * 60 * 1000), // 45分前に作った依頼
    ...overrides,
  };
}

test('タイムアウトは30分', () => {
  assert.equal(WAITING_TIMEOUT_MS, 30 * 60 * 1000);
});

test('30分を過ぎた参加待ちは true', () => {
  assert.equal(isWaitingExpired(waitingSession(), NOW), true);
});

test('ちょうど30分（等号）も true', () => {
  const s = waitingSession({ createdAt: ts(NOW - WAITING_TIMEOUT_MS) });
  assert.equal(isWaitingExpired(s, NOW), true);
});

test('まだ30分たっていなければ false', () => {
  const s = waitingSession({ createdAt: ts(NOW - 29 * 60 * 1000) });
  assert.equal(isWaitingExpired(s, NOW), false);
});

test('ペア起点の依頼（pairId 付き）も同じ扱い（M-6）', () => {
  const s = waitingSession({ pairId: 'pair-1' });
  assert.equal(isWaitingExpired(s, NOW), true);
});

test('すでに参加済み（active）なら false', () => {
  assert.equal(isWaitingExpired(waitingSession({ status: 'active' }), NOW), false);
});

test('終端済み（cancelled / ended / arrived）なら false', () => {
  for (const status of ['cancelled', 'ended', 'arrived']) {
    assert.equal(isWaitingExpired(waitingSession({ status }), NOW), false);
  }
});

test('createdAt が無い（サーバー時刻が未解決）なら false', () => {
  assert.equal(isWaitingExpired(waitingSession({ createdAt: undefined }), NOW), false);
});

test('createdAt が Timestamp でない型なら false', () => {
  assert.equal(isWaitingExpired(waitingSession({ createdAt: NOW - 60 * 60 * 1000 }), NOW), false);
});

test('セッションそのものが無ければ false', () => {
  assert.equal(isWaitingExpired(null, NOW), false);
  assert.equal(isWaitingExpired(undefined, NOW), false);
});
