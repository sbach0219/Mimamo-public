import { watchTone } from '../watchStatus';

const base = {
  online: true,
  walkStart: 'background' as const,
  lastHeartbeatOkAt: 1_000_000,
  now: 1_000_000,
  sessionLive: true,
};

describe('watchTone（歩く人に見せる見守り状態）', () => {
  test('位置共有が動いていて通信もあれば ok', () => {
    expect(watchTone(base)).toBe('ok');
  });

  test('圏外は「電波が弱い」にとどめる（止まったとは言わない）', () => {
    expect(watchTone({ ...base, online: false })).toBe('weak');
  });

  test('使用中のみ許可は weak（アプリを閉じると止まるため）', () => {
    expect(watchTone({ ...base, walkStart: 'foreground-only' })).toBe('weak');
  });

  test('位置権限が無い・開始に失敗したら stopped', () => {
    expect(watchTone({ ...base, walkStart: 'denied' })).toBe('stopped');
    expect(watchTone({ ...base, walkStart: 'failed' })).toBe('stopped');
  });

  test('heartbeat が長く届いていなければ stopped', () => {
    expect(watchTone({ ...base, now: base.lastHeartbeatOkAt + 100_001 })).toBe('stopped');
  });

  test('まだ一度も届いていない開始直後は stopped にしない', () => {
    expect(watchTone({ ...base, lastHeartbeatOkAt: null })).toBe('ok');
  });

  test('セッションが終わっていれば stopped', () => {
    expect(watchTone({ ...base, sessionLive: false })).toBe('stopped');
  });
});
