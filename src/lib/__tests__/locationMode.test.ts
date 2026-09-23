import {
  LOCATION_MODES,
  isLocationMissing,
  isLocationMode,
  locationModeFor,
  parseLocationMode,
} from '../locationMode';

// H-2: 位置共有の結果をセッション文書へ1語で残す写像。
// この1語だけが、見守り側が「位置が届いていない歩行」を知る唯一の手がかりになる。

describe('locationModeFor', () => {
  it('バックグラウンド許可はそのまま background', () => {
    expect(locationModeFor('background')).toBe('background');
  });

  it('「使用中のみ許可」は foreground（見守りは成立している）', () => {
    expect(locationModeFor('foreground-only')).toBe('foreground');
  });

  it('拒否と開始失敗は、見守り側から見れば同じ「届かない」なので none にまとめる', () => {
    expect(locationModeFor('denied')).toBe('none');
    expect(locationModeFor('failed')).toBe('none');
  });

  it('返る値は必ず rules と共有している許可リストの中にある', () => {
    for (const result of ['background', 'foreground-only', 'denied', 'failed'] as const) {
      expect(LOCATION_MODES).toContain(locationModeFor(result));
    }
  });
});

describe('parseLocationMode', () => {
  it('未設定・未知の値は null（判定不能）に丸める', () => {
    expect(parseLocationMode(undefined)).toBeNull();
    expect(parseLocationMode(null)).toBeNull();
    expect(parseLocationMode('always')).toBeNull();
    expect(parseLocationMode(1)).toBeNull();
  });

  it('既知の値はそのまま通す', () => {
    for (const mode of LOCATION_MODES) {
      expect(parseLocationMode(mode)).toBe(mode);
      expect(isLocationMode(mode)).toBe(true);
    }
  });
});

describe('isLocationMissing', () => {
  it('none だけが「届いていない」', () => {
    expect(isLocationMissing('none')).toBe(true);
  });

  it('foreground と未報告は警告にしない', () => {
    expect(isLocationMissing('foreground')).toBe(false);
    expect(isLocationMissing('background')).toBe(false);
    expect(isLocationMissing(null)).toBe(false);
  });
});
