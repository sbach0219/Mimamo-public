import type { NavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from '../../navigation/types';
import type { SessionState } from '../../store/session/types';
import { routeNotificationTap } from '../notificationRouting';

// Mock the store boundary, not the router: native/Firebase APIs must never run here.
const restoreWatchSession = jest.fn();
const restoreWalkSession = jest.fn();
const joinSession = jest.fn();
let state: Pick<SessionState, 'sessionId' | 'myRole' | 'status' | 'mode' | 'estimatedMinutes'> & {
  restoreWatchSession: typeof restoreWatchSession;
  restoreWalkSession: typeof restoreWalkSession;
  joinSession: typeof joinSession;
};
const getState = jest.fn(() => state);

jest.mock('../../store/sessionStore', () => ({
  useSession: { getState: () => getState() },
}));

const navigate = jest.fn();
const nav = { navigate } as unknown as NavigationContainerRef<RootStackParamList>;

beforeEach(() => {
  jest.resetAllMocks();
  getState.mockImplementation(() => state);
  restoreWatchSession.mockResolvedValue({ ok: false });
  restoreWalkSession.mockResolvedValue(false);
  state = {
    sessionId: null, myRole: null, status: 'waiting', mode: 'hold', estimatedMinutes: 20,
    restoreWatchSession, restoreWalkSession, joinSession,
  };
});

afterEach(() => {
  // A notification is never consent to join a walk.
  expect(joinSession).not.toHaveBeenCalled();
});

test.each(['pair_active', 'pair_revoked', 'pair_stale'])(
  '%s opens connections without restoring a session', async (type) => {
    await routeNotificationTap(nav, { type, pairId: 'pair-1' });
    expect(navigate.mock.calls).toEqual([['Pairs']]);
    expect(getState).not.toHaveBeenCalled();
  },
);

test.each([{}, { type: 'sos' }, { type: 'watch_request', sessionId: '' }])(
  'missing session ID is ignored: %j', async (request) => {
    await routeNotificationTap(nav, request);
    expect(navigate).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
  },
);

test('a watch request opens consent without restoring or starting location sharing', async () => {
  await routeNotificationTap(nav, { type: 'watch_request', sessionId: 'requested' });
  expect(navigate.mock.calls).toEqual([['WatchRequest', { sessionId: 'requested' }]]);
  expect(getState).not.toHaveBeenCalled();
  expect(restoreWatchSession).not.toHaveBeenCalled();
  expect(restoreWalkSession).not.toHaveBeenCalled();
});

test.each(['sos', 'anomaly', 'alert', 'active'] as const)(
  'warm watcher uses current %s status and retains a home destination', async (status) => {
    Object.assign(state, { sessionId: 'current', myRole: 'watcher', status });
    // A delayed SOS notification must not reopen an already cancelled SOS.
    await routeNotificationTap(nav, { type: 'sos', sessionId: 'current' });
    expect(navigate.mock.calls).toEqual([
      ['WatcherTabs'], [status === 'sos' ? 'WatcherSos' : 'WatcherMonitor'],
    ]);
    expect(restoreWatchSession).not.toHaveBeenCalled();
    expect(restoreWalkSession).not.toHaveBeenCalled();
  },
);

test.each(['hold', 'sentinel'] as const)('warm walker returns to the %s mode', async (mode) => {
  Object.assign(state, { sessionId: 'current', myRole: 'walker', mode });
  await routeNotificationTap(nav, { type: 'local_check', sessionId: 'current' });
  expect(navigate.mock.calls).toEqual([
    [mode === 'sentinel' ? 'MainSentinel' : 'Main', { estimatedMinutes: 20 }],
  ]);
  expect(restoreWatchSession).not.toHaveBeenCalled();
  expect(restoreWalkSession).not.toHaveBeenCalled();
});

test.each(['watcher', 'walker'] as const)('warm %s message opens chat without resetting navigation', async (myRole) => {
  Object.assign(state, { sessionId: 'current', myRole });
  await routeNotificationTap(nav, { type: 'message', sessionId: 'current' });
  expect(navigate.mock.calls).toEqual([['Chat']]);
  expect(restoreWatchSession).not.toHaveBeenCalled();
  expect(restoreWalkSession).not.toHaveBeenCalled();
});

test.each(['sos', 'active'] as const)('cold watcher routes using restored %s, not stale store status', async (status) => {
  state.status = status === 'sos' ? 'active' : 'sos';
  restoreWatchSession.mockResolvedValue({ ok: true, status });
  await routeNotificationTap(nav, { type: 'sos', sessionId: 'restored' });
  expect(restoreWatchSession).toHaveBeenCalledWith('restored');
  expect(navigate.mock.calls).toEqual([
    ['WatcherTabs'], [status === 'sos' ? 'WatcherSos' : 'WatcherMonitor'],
  ]);
  expect(restoreWalkSession).not.toHaveBeenCalled();
});

test('cold watcher message opens chat above the watcher tabs', async () => {
  restoreWatchSession.mockResolvedValue({ ok: true, status: 'active' });
  await routeNotificationTap(nav, { type: 'message', sessionId: 'restored' });
  expect(restoreWatchSession).toHaveBeenCalledWith('restored');
  expect(navigate.mock.calls).toEqual([['WatcherTabs'], ['Chat']]);
  expect(restoreWalkSession).not.toHaveBeenCalled();
});

describe.each(['hold', 'sentinel'] as const)('cold %s walker', (mode) => {
  test.each(['local_check', 'message'])('%s uses freshly restored mode and duration', async (type) => {
    restoreWatchSession.mockRejectedValue(new Error('not a watcher'));
    restoreWalkSession.mockImplementation(async () => {
      // Replace the object, as a real store update does. Reading the old snapshot is a bug.
      state = { ...state, sessionId: 'restored', myRole: 'walker', mode, estimatedMinutes: 35 };
      return true;
    });
    await routeNotificationTap(nav, { type, sessionId: 'restored' });
    expect(restoreWatchSession).toHaveBeenCalledWith('restored');
    expect(restoreWalkSession).toHaveBeenCalledWith('restored');
    expect(navigate.mock.calls).toEqual([
      [mode === 'sentinel' ? 'MainSentinel' : 'Main', { estimatedMinutes: 35 }],
      ...(type === 'message' ? [['Chat']] : []),
    ]);
  });
});

test('navigation waits for successful restoration', async () => {
  let resolve!: (result: { ok: true; status: string }) => void;
  restoreWatchSession.mockReturnValue(new Promise((done) => { resolve = done; }));
  const routing = routeNotificationTap(nav, { type: 'sos', sessionId: 'pending' });
  expect(navigate).not.toHaveBeenCalled();
  resolve({ ok: true, status: 'sos' });
  await routing;
  expect(navigate.mock.calls).toEqual([['WatcherTabs'], ['WatcherSos']]);
});

describe.each(['unavailable', 'rejected'])('restoration %s', (failure) => {
  beforeEach(() => {
    if (failure === 'rejected') {
      restoreWatchSession.mockRejectedValue(new Error('offline'));
      restoreWalkSession.mockRejectedValue(new Error('offline'));
    }
  });

  test.each(['sos', 'message', 'local_check'])('%s never opens an unrelated session', async (type) => {
    state.sessionId = 'unrelated';
    await expect(routeNotificationTap(nav, { type, sessionId: 'gone' })).resolves.toBeUndefined();
    expect(navigate).not.toHaveBeenCalled();
    expect(restoreWalkSession).toHaveBeenCalledWith('gone');
  });

  test.each(['watch_ended', 'watch_auto_ended'])('%s has a destination even after the session ends', async (type) => {
    await routeNotificationTap(nav, { type, sessionId: 'ended' });
    expect(navigate.mock.calls).toEqual([['RoleSelect']]);
  });
});
