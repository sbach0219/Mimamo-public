import { isEmergencySwitchBlocked } from '../focusWatchSession';

const state = {
  sessionId: null as string | null,
  status: 'active',
  hasLiveSession: () => true,
};

jest.mock('../../store/sessionStore', () => ({
  useSession: { getState: () => state },
}));

// 緊急対応中に器を別のセッションへ向け直すと、いま見ている画面の中身が入れ替わる。
describe('isEmergencySwitchBlocked', () => {
  beforeEach(() => {
    state.sessionId = 's-current';
    state.status = 'active';
    state.hasLiveSession = () => true;
  });

  it('SOS・異変・応答なしの対応中は、別のセッションへ切り替えない', () => {
    for (const status of ['sos', 'anomaly', 'alert']) {
      state.status = status;
      expect(isEmergencySwitchBlocked('s-other')).toBe(true);
    }
  });

  it('同じセッションなら切り替わらないので止めない', () => {
    state.status = 'sos';
    expect(isEmergencySwitchBlocked('s-current')).toBe(false);
  });

  it('新しい見守りを作るとき（対象IDなし）も緊急中は止める', () => {
    state.status = 'sos';
    expect(isEmergencySwitchBlocked()).toBe(true);
  });

  it('平常時と、器が空のときは止めない', () => {
    expect(isEmergencySwitchBlocked('s-other')).toBe(false);
    state.status = 'sos';
    state.hasLiveSession = () => false;
    expect(isEmergencySwitchBlocked('s-other')).toBe(false);
  });
});
