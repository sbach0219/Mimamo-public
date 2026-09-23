import { canStartWalk } from '../walkGate';

describe('canStartWalk', () => {
  it('参加済みの walker だけ歩行画面に入れる', () => {
    expect(canStartWalk('abc123', 'walker')).toBe(true);
  });

  it('セッション未参加は入れない', () => {
    expect(canStartWalk(null, null)).toBe(false);
    expect(canStartWalk(null, 'walker')).toBe(false);
  });

  it('見守り役はセッションがあっても歩行画面には入れない', () => {
    expect(canStartWalk('abc123', 'watcher')).toBe(false);
  });

  it('終端したセッションでは入れない（見守り終了の通知タップで歩行が再起動しない）', () => {
    for (const status of ['ended', 'arrived', 'cancelled']) {
      expect(canStartWalk('abc123', 'walker', status)).toBe(false);
    }
  });

  it('進行中の status は従来どおり通る', () => {
    for (const status of ['waiting', 'active', 'alert', 'anomaly', 'sos']) {
      expect(canStartWalk('abc123', 'walker', status)).toBe(true);
    }
  });

  it('status 未指定・未知の値は入場条件に影響させない', () => {
    expect(canStartWalk('abc123', 'walker')).toBe(true);
    expect(canStartWalk('abc123', 'walker', null)).toBe(true);
    expect(canStartWalk('abc123', 'walker', 'unknown')).toBe(true);
  });
});
