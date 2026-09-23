// 放置GCの自動終了通知は expiresAt の6時間後に走るため、20分の見守りでも
// 深夜に鳴りうる（L-3）。急ぎでも安全にも関わらない知らせなので、夜は出さない。
// 実行: cd functions && npm test  （= node --test test/）
const test = require('node:test');
const assert = require('node:assert/strict');
const { isQuietHourJst } = require('../index.js');

const jst = (iso) => Date.parse(iso);

test('JST 22時から翌6時台までは静かにする', () => {
  assert.equal(isQuietHourJst(jst('2026-09-02T22:00:00+09:00')), true);
  assert.equal(isQuietHourJst(jst('2026-09-03T02:30:00+09:00')), true);
  assert.equal(isQuietHourJst(jst('2026-09-03T06:59:59+09:00')), true);
});

test('JST 7時から21時台は通知してよい', () => {
  assert.equal(isQuietHourJst(jst('2026-09-03T07:00:00+09:00')), false);
  assert.equal(isQuietHourJst(jst('2026-09-03T12:00:00+09:00')), false);
  assert.equal(isQuietHourJst(jst('2026-09-03T21:59:59+09:00')), false);
});

test('判定はサーバーの実行タイムゾーンに依らない（絶対時刻から作る）', () => {
  // 同じ瞬間を UTC 表記で渡しても結果は変わらない
  assert.equal(isQuietHourJst(jst('2026-09-02T13:00:00Z')), true);  // JST 22:00
  assert.equal(isQuietHourJst(jst('2026-09-02T03:00:00Z')), false); // JST 12:00
});
