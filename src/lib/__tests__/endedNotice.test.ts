import { claimEndedNotice, resetEndedNotices } from '../endedNotice';

// 終了の知らせは FCM とローカルの2経路で届く。片方に寄せるとゼロ通知の穴が開くので
// 両方残し、短時間の重複だけを止める（L-5）。
describe('claimEndedNotice', () => {
  beforeEach(() => resetEndedNotices());

  it('最初の1通は出す', () => {
    expect(claimEndedNotice('s-1', 1_000)).toBe(true);
  });

  it('同じセッションの直後の重複は止める', () => {
    claimEndedNotice('s-1', 1_000);
    expect(claimEndedNotice('s-1', 3_000)).toBe(false);
  });

  it('別のセッションは止めない', () => {
    claimEndedNotice('s-1', 1_000);
    expect(claimEndedNotice('s-2', 1_000)).toBe(true);
  });

  it('窓を過ぎたら、もう一度出す（消えるより余分に出るほうが安全）', () => {
    claimEndedNotice('s-1', 1_000);
    expect(claimEndedNotice('s-1', 1_000 + 10_001)).toBe(true);
  });
});
