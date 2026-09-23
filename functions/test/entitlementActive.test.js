// entitlementActive() の判定（D-11: 月額サブスク）。
// ここが誤ると「払っている人が使えない」か「払っていない人が使える」のどちらかが起きる。
// 前者のほうが痛いので、知らないイベントでは状態を動かさない（null を返す）ことを固定する。
// 実行: cd functions && npm test  （= node --test）
const test = require('node:test');
const assert = require('node:assert/strict');
const { entitlementActive, shouldApplyEvent, asUidList } = require('../index.js');

const HOUR = 3600_000;

test('購入・更新・キャンセル取り消しは資格あり', () => {
  for (const type of ['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE']) {
    assert.equal(entitlementActive({ type, expiration_at_ms: Date.now() + 30 * 24 * HOUR }), true, type);
  }
});

test('期限切れ・返金・一時停止は資格なし', () => {
  for (const type of ['EXPIRATION', 'REFUND', 'SUBSCRIPTION_PAUSED']) {
    assert.equal(entitlementActive({ type }), false, type);
  }
});

test('TRANSFER は失効として扱わない（移転先へ資格を渡さないまま移転元を落とさない）', () => {
  // 購読が別のストアアカウントへ移っただけで、誰かが使えなくなる話ではない。
  // app_user_id だけを見て一律 false にすると、機種変更後の本人が締め出される。
  assert.equal(entitlementActive({ type: 'TRANSFER' }), null);
});

test('CANCELLATION では資格を落とさない（自動更新を止めただけで、期限までは使える）', () => {
  assert.equal(entitlementActive({ type: 'CANCELLATION' }), null);
});

test('知らないイベント種別では状態を動かさない', () => {
  assert.equal(entitlementActive({ type: 'SOMETHING_NEW' }), null);
  assert.equal(entitlementActive({}), null);
  assert.equal(entitlementActive(null), null);
});

test('更新イベントでも期限が過去なら資格なしへ倒す（遅れて届いた再送への保険）', () => {
  assert.equal(entitlementActive({ type: 'RENEWAL', expiration_at_ms: Date.now() - HOUR }), false);
});

test('期限が入っていない購入（非更新型）は資格あり', () => {
  assert.equal(entitlementActive({ type: 'NON_RENEWING_PURCHASE' }), true);
});


// shouldApplyEvent: 再送と順序逆転は現実に起きる。「期限が未来の RENEWAL が REFUND の後に届いて
// 資格が復活する」は、遅延した1通で有料機能が無期限に開く事故になる。

test('同じイベントIDは二度適用しない', () => {
  const existing = { entitlements: { group: { lastEventId: 'e1', lastEventAtMs: 1000 } } };
  assert.equal(shouldApplyEvent(existing, 'e1', 2000), false);
});

test('古いイベントは適用しない（順序逆転で資格が復活しない）', () => {
  const existing = { entitlements: { group: { lastEventId: 'e2', lastEventAtMs: 5000 } } };
  assert.equal(shouldApplyEvent(existing, 'e3', 4000), false);
  assert.equal(shouldApplyEvent(existing, 'e3', 5000), true);
  assert.equal(shouldApplyEvent(existing, 'e3', 6000), true);
});

test('記録が無ければ適用する（初回）', () => {
  assert.equal(shouldApplyEvent(null, 'e1', 1000), true);
  assert.equal(shouldApplyEvent({}, 'e1', 1000), true);
});

test('時刻が分からないときは適用する（判断材料が無いのに捨てない）', () => {
  const existing = { entitlements: { group: { lastEventId: 'e1' } } };
  assert.equal(shouldApplyEvent(existing, 'e2', undefined), true);
});

test('移転の相手は文字列でも配列でも受ける', () => {
  assert.deepEqual(asUidList('uid-a'), ['uid-a']);
  assert.deepEqual(asUidList(['uid-a', 'uid-b']), ['uid-a', 'uid-b']);
  assert.deepEqual(asUidList(['uid-a', '', 3, null]), ['uid-a']);
  assert.deepEqual(asUidList(undefined), []);
  assert.deepEqual(asUidList(''), []);
});
