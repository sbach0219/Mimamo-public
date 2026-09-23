import {
  aggregateBanner,
  aggregateWatchTone,
  displayName,
  watchRowBadge,
  HEARTBEAT_STALE_MS,
  type WatchTarget,
} from '../aggregateWatchStatus';

const NOW = 1_800_000_000_000;

const target = (over: Partial<WatchTarget> = {}): WatchTarget => ({
  id: 's1',
  status: 'active',
  name: 'はるちゃん',
  lastHeartbeatAt: NOW - 5_000,
  anomalyType: null,
  sosSilent: false,
  ...over,
});

describe('watchRowBadge', () => {
  it('SOS・異常・応答なしはすべて緊急要請中（danger）', () => {
    for (const status of ['sos', 'anomaly', 'alert'] as const) {
      expect(watchRowBadge(target({ status }), NOW)).toMatchObject({ key: 'emergency', tone: 'danger' });
    }
  });

  it('active かつ heartbeat が新鮮なら「移動中・異常なし」（安全は宣言しない）', () => {
    const badge = watchRowBadge(target(), NOW);
    expect(badge).toMatchObject({ key: 'moving', tone: 'safe' });
    expect(badge.label).toBe('移動中・異常なし');
  });

  it('active でも heartbeat が閾値を超えたら caution へ落ちる', () => {
    const stale = target({ lastHeartbeatAt: NOW - HEARTBEAT_STALE_MS - 1 });
    expect(watchRowBadge(stale, NOW)).toMatchObject({ key: 'stale', tone: 'caution' });
  });

  it('heartbeat が一度も届いていない参加直後は caution にしない', () => {
    expect(watchRowBadge(target({ lastHeartbeatAt: null }), NOW)).toMatchObject({ key: 'moving' });
  });

  it('到着・参加待ちはそれぞれ専用のバッジ', () => {
    expect(watchRowBadge(target({ status: 'arrived' }), NOW)).toMatchObject({ key: 'arrived', tone: 'safe' });
    expect(watchRowBadge(target({ status: 'waiting' }), NOW)).toMatchObject({ key: 'waiting', tone: 'muted' });
  });

  // H-2: 位置の許可が拒否された歩行。heartbeat は届き続けるので、これが無いと
  // 「移動中・異常なし」で塗りつぶされる（安全アプリで最悪の静かな失敗）。
  it('位置が届いていない歩行は caution へ落ちる', () => {
    const badge = watchRowBadge(target({ locationMode: 'none' }), NOW);
    expect(badge).toMatchObject({ key: 'no_location', tone: 'caution' });
    expect(badge.label).toBe('位置が届いていません');
  });

  it('「使用中のみ許可」と未報告は警告にしない（過大な警告は注意色の意味を薄める）', () => {
    expect(watchRowBadge(target({ locationMode: 'foreground' }), NOW)).toMatchObject({ key: 'moving' });
    expect(watchRowBadge(target({ locationMode: null }), NOW)).toMatchObject({ key: 'moving' });
    expect(watchRowBadge(target(), NOW)).toMatchObject({ key: 'moving' });
  });

  it('緊急・到着・参加待ちは位置の有無より先に立つ', () => {
    expect(watchRowBadge(target({ status: 'sos', locationMode: 'none' }), NOW)).toMatchObject({ key: 'emergency' });
    expect(watchRowBadge(target({ status: 'arrived', locationMode: 'none' }), NOW)).toMatchObject({ key: 'arrived' });
    expect(watchRowBadge(target({ status: 'waiting', locationMode: 'none' }), NOW)).toMatchObject({ key: 'waiting' });
  });

  it('通信ごと途絶しているときは「とだえています」を先に出す', () => {
    const both = target({ locationMode: 'none', lastHeartbeatAt: NOW - HEARTBEAT_STALE_MS - 1 });
    expect(watchRowBadge(both, NOW)).toMatchObject({ key: 'stale' });
  });
});

describe('aggregateWatchTone', () => {
  it('ライブセッションが無ければ idle', () => {
    expect(aggregateWatchTone([], NOW)).toBe('idle');
  });

  it('1件でも緊急があれば danger が最優先', () => {
    const targets = [target({ id: 'a' }), target({ id: 'b', status: 'sos' })];
    expect(aggregateWatchTone(targets, NOW)).toBe('danger');
  });

  it('緊急が無く途絶があれば caution', () => {
    const targets = [target({ id: 'a' }), target({ id: 'b', lastHeartbeatAt: NOW - HEARTBEAT_STALE_MS - 1 })];
    expect(aggregateWatchTone(targets, NOW)).toBe('caution');
  });

  it('全件が active（新鮮）or arrived なら all_safe', () => {
    const targets = [target({ id: 'a' }), target({ id: 'b', status: 'arrived' })];
    expect(aggregateWatchTone(targets, NOW)).toBe('all_safe');
  });
});

describe('aggregateBanner（D-9: 事実ベース文言）', () => {
  it('idle ではバナーを出さない', () => {
    expect(aggregateBanner([], NOW)).toBeNull();
  });

  it('「安全」を宣言せず、異常を検知していない事実だけを言う', () => {
    const banner = aggregateBanner([target()], NOW)!;
    expect(banner.text).toBe('はるちゃんを見守り中・異常はありません');
    expect(banner.text).not.toMatch(/安全なエリア/);
  });

  it('複数人のときは人数で数える', () => {
    const banner = aggregateBanner([target({ id: 'a' }), target({ id: 'b', name: 'おじいちゃん' })], NOW)!;
    expect(banner.text).toBe('2人を見守り中・異常はありません');
  });

  it('途絶は相手の名前を添えて事実を言う', () => {
    const banner = aggregateBanner([target({ lastHeartbeatAt: NOW - HEARTBEAT_STALE_MS - 1 })], NOW)!;
    expect(banner).toMatchObject({ tone: 'caution', text: 'はるちゃんとの連絡がとだえています' });
  });

  it('SOS・音なしSOS・異常はそれぞれ通知と同じ語彙で言う', () => {
    expect(aggregateBanner([target({ status: 'sos' })], NOW)!.text).toBe('はるちゃんが緊急要請を送信しました');
    expect(aggregateBanner([target({ status: 'sos', sosSilent: true })], NOW)!.text)
      .toBe('はるちゃんが音なしの緊急要請を送信しました');
    expect(aggregateBanner([target({ status: 'anomaly', anomalyType: 'move' })], NOW)!.text)
      .toBe('はるちゃんが乗り物の速さで移動しています');
  });

  it('位置が届いていない歩行は集約バナーでも caution として言う（H-2）', () => {
    const banner = aggregateBanner([target({ locationMode: 'none' })], NOW)!;
    expect(banner).toMatchObject({ tone: 'caution', text: 'はるちゃんの位置が届いていません' });
    expect(aggregateWatchTone([target({ locationMode: 'none' })], NOW)).toBe('caution');
  });

  it('位置が届いていない1人がいれば「全員異常なし」とは言わない', () => {
    const targets = [target({ id: 's1' }), target({ id: 's2', name: 'おじいちゃん', locationMode: 'none' })];
    expect(aggregateBanner(targets, NOW)!.text).toBe('おじいちゃんの位置が届いていません');
  });

  it('呼び名が無いセッションでも文が成立する', () => {
    expect(displayName({ name: null })).toBe('歩く人');
    expect(displayName({ name: '  ' })).toBe('歩く人');
    expect(aggregateBanner([target({ name: null })], NOW)!.text).toBe('歩く人を見守り中・異常はありません');
  });
});
