// sanitizePlaceLabel() の検証（D-14）。
// ペアの「最終確認」はセッションの7日 purge の外にある文書へ書かれるため、
// 座標がここをすり抜けると「セッションが消えても位置が残る」ことになる。
// 通す・通さないの境界を固定して、その事故を再発させない。
// 実行: cd functions && npm test  （= node --test）
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePlaceLabel, sanitizeDestinationLabel } = require('../index.js');

test('地名はそのまま通る', () => {
  assert.equal(sanitizePlaceLabel('東京都 世田谷区 三軒茶屋'), '東京都 世田谷区 三軒茶屋');
});

test('前後の空白と連続空白は整える', () => {
  assert.equal(sanitizePlaceLabel('  東京都   世田谷区  '), '東京都 世田谷区');
});

test('座標そのものは地名として受け取らない', () => {
  assert.equal(sanitizePlaceLabel('35.6812, 139.7671'), null);
  assert.equal(sanitizePlaceLabel('35.6812°N 139.7671°E'), null);
  assert.equal(sanitizePlaceLabel('-35.6812,-139.7671'), null);
});

test('空・空白のみ・文字列でないものは null', () => {
  assert.equal(sanitizePlaceLabel(''), null);
  assert.equal(sanitizePlaceLabel('   '), null);
  assert.equal(sanitizePlaceLabel(undefined), null);
  assert.equal(sanitizePlaceLabel(null), null);
  assert.equal(sanitizePlaceLabel(35.68), null);
});

test('長すぎる文字列は上限で切る（ペアは purge の外なので器を固定する）', () => {
  const long = 'あ'.repeat(200);
  assert.equal(sanitizePlaceLabel(long).length, 60);
});

test('地名に数字が混じっていても通る（丁目・番地）', () => {
  assert.equal(sanitizePlaceLabel('世田谷区 三軒茶屋 2-1-1'), '世田谷区 三軒茶屋 2-1-1');
});

// M-4: 以前は「数字と記号だけ」しか弾かず、文字が1つ混ざれば座標が通り抜けた。
test('文字に紛れ込ませた座標も丸ごと捨てる', () => {
  assert.equal(sanitizePlaceLabel('自宅 35.681236,139.767125'), null);
  assert.equal(sanitizePlaceLabel('東京 35.6812°N 139.7671°E'), null);
  assert.equal(sanitizePlaceLabel('ここ N35.68 E139.76'), null);
});

test('十進度に見えない小数は通す（地名に紛れる普通の数字を巻き添えにしない）', () => {
  assert.equal(sanitizePlaceLabel('国道 246 号'), '国道 246 号');
  assert.equal(sanitizePlaceLabel('3.5キロ地点'), '3.5キロ地点');
});

test('目的地ラベルは30文字までに切る（サーバー側でも器を固定する）', () => {
  assert.equal(sanitizeDestinationLabel('ひまわり学童保育室'), 'ひまわり学童保育室');
  assert.equal(sanitizeDestinationLabel('あ'.repeat(500)).length, 30);
  assert.equal(sanitizeDestinationLabel('  '), null);
  assert.equal(sanitizeDestinationLabel(12345), null);
});
