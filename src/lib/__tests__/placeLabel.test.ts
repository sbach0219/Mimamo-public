import { coarsePlaceLabel, normalizePlaceLabel, PLACE_LABEL_MAX } from '../placeLabel';

// 地名ラベル（D-14）が、座標をペア文書へ運ぶ運び屋にならないことを固定する。
//
// ペアはセッションの7日 purge の外にある文書なので、ここをすり抜けた座標は
// 「見守りが終わっても位置が残る」ことになる。同じ判定は functions の
// sanitizePlaceLabel にもあり（ビルド境界が違うので式を複製している）、
// 片方だけ緩めると穴が開く。
describe('normalizePlaceLabel（地名ラベルの入口）', () => {
  test('地名はそのまま通る', () => {
    expect(normalizePlaceLabel('東京都 世田谷区 三軒茶屋')).toBe('東京都 世田谷区 三軒茶屋');
  });

  test('前後・連続の空白は整える', () => {
    expect(normalizePlaceLabel('  東京都   世田谷区  ')).toBe('東京都 世田谷区');
  });

  test('座標そのものは受け取らない', () => {
    expect(normalizePlaceLabel('35.6812, 139.7671')).toBeNull();
    expect(normalizePlaceLabel('35.6812°N 139.7671°E')).toBeNull();
  });

  test('文字に紛れ込ませた座標も丸ごと捨てる（部分的に削らない）', () => {
    // 削って「それらしい地名」に仕立てると、どこまで消えたか分からず危ない
    expect(normalizePlaceLabel('自宅 35.681236,139.767125')).toBeNull();
    expect(normalizePlaceLabel('ここ N35.68 E139.76')).toBeNull();
  });

  test('十進度に見えない数字は巻き添えにしない', () => {
    expect(normalizePlaceLabel('世田谷区 三軒茶屋 2-1-1')).toBe('世田谷区 三軒茶屋 2-1-1');
    expect(normalizePlaceLabel('国道 246 号')).toBe('国道 246 号');
    expect(normalizePlaceLabel('3.5キロ地点')).toBe('3.5キロ地点');
  });

  test('空・空白のみ・未定義は null', () => {
    expect(normalizePlaceLabel('')).toBeNull();
    expect(normalizePlaceLabel('   ')).toBeNull();
    expect(normalizePlaceLabel(null)).toBeNull();
    expect(normalizePlaceLabel(undefined)).toBeNull();
  });

  test('長すぎる文字列は上限で切る', () => {
    expect(normalizePlaceLabel('あ'.repeat(200))?.length).toBe(PLACE_LABEL_MAX);
  });
});


// 番地付き住所は実質的に座標。110番通報用の文字列（useWalkerAddress の text）を
// そのままペアへ保存すると「見守り終了時にどの建物にいたか」が7日残り、
// 「ペアは位置を見る権利ではない」（I-1）が実質的に後退する。
describe('coarsePlaceLabel（保存してよい粗さ）', () => {
  test('都道府県・市区町村・町名までに落とし、番地と建物名を捨てる', () => {
    expect(coarsePlaceLabel({
      region: '東京都', city: '世田谷区', district: '三軒茶屋',
      street: '2-1-5', streetNumber: '5', name: '○○ハイツ',
    } as any)).toBe('東京都 世田谷区 三軒茶屋');
  });

  test('欠けている要素は詰めて出す', () => {
    expect(coarsePlaceLabel({ region: '北海道', city: null, district: '美瑛町' })).toBe('北海道 美瑛町');
    expect(coarsePlaceLabel({ region: '東京都' })).toBe('東京都');
  });

  test('同じ語の重複は1つにまとめる', () => {
    expect(coarsePlaceLabel({ region: '京都府', city: '京都市', district: '京都市' }))
      .toBe('京都府 京都市');
  });

  test('取れなければ null（空の器を残さない）', () => {
    expect(coarsePlaceLabel({})).toBeNull();
    expect(coarsePlaceLabel(null)).toBeNull();
    expect(coarsePlaceLabel({ region: '  ', city: '' })).toBeNull();
  });

  test('粗い地名の側でも座標は弾く', () => {
    expect(coarsePlaceLabel({ region: '35.681236', city: '139.767125' })).toBeNull();
  });
});
