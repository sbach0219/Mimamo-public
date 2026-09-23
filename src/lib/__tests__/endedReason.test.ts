import { endedReasonFor } from '../sessionStatus';

// 歩く人が「なぜ終わったのか」を取り違えると、もう一度おねがいすべきかの判断ができない。
describe('endedReasonFor', () => {
  it('見守る人が終えたときは watcher', () => {
    expect(endedReasonFor('ended', 'watcher')).toBe('watcher');
  });

  it('ペア解除による終了は pair_revoked（時間切れと言い切らない）', () => {
    expect(endedReasonFor('ended', 'pair_revoked')).toBe('pair_revoked');
  });

  it('endedBy が無い終了は ended（時間切れ・自動終了）', () => {
    expect(endedReasonFor('ended', null)).toBe('ended');
  });

  it('cancelled は endedBy より優先する（成立しなかった依頼の説明が先）', () => {
    expect(endedReasonFor('cancelled', null)).toBe('cancelled');
    expect(endedReasonFor('cancelled', 'watcher')).toBe('cancelled');
    expect(endedReasonFor('cancelled', 'pair_revoked')).toBe('cancelled');
  });
});
