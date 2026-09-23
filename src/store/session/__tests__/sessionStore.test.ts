import { getDoc, onSnapshot, setDoc, updateDoc } from '@react-native-firebase/firestore';
import { onAuthStateChanged, signInAnonymously } from '@react-native-firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { auth } from '../../../lib/firebase';
import { notify } from '../../../lib/notifications';
import { saveActiveWatch, removeActiveWatch } from '../../../lib/activeWatch';
import { createSessionStore } from '../createSessionStore';
import { useSession, ensureSignedIn } from '../../sessionStore';

jest.mock('../../../lib/firebase', () => ({ auth: { currentUser: null }, db: {} }));
jest.mock('@react-native-firebase/auth', () => ({
  signInAnonymously: jest.fn(), onAuthStateChanged: jest.fn(),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));
jest.mock('@react-native-firebase/firestore', () => ({
  doc: jest.fn((base, ...parts) => parts.length ? parts.join('/') : `${base}/new-session`),
  collection: jest.fn((_db, ...parts) => parts.join('/')),
  query: jest.fn((ref) => ref), orderBy: jest.fn(), where: jest.fn(), limit: jest.fn(),
  getDoc: jest.fn(), getDocs: jest.fn(), setDoc: jest.fn(), updateDoc: jest.fn(), addDoc: jest.fn(),
  onSnapshot: jest.fn(), serverTimestamp: () => 'server-time',
  Timestamp: { fromDate: (date: Date) => date },
}));
jest.mock('../../../lib/fcmToken', () => ({ getFcmToken: jest.fn(async () => 'fresh-token') }));
jest.mock('../../../lib/haptics', () => ({ haptics: { success: jest.fn() } }));
jest.mock('../../../lib/notifications', () => ({ notify: jest.fn() }));
jest.mock('../../../lib/activeWatch', () => ({
  saveActiveWatch: jest.fn(), removeActiveWatch: jest.fn(),
}));
jest.mock('../../../lib/watchPreferences', () => ({ saveWatcherPhonePreference: jest.fn() }));

type Store = ReturnType<typeof createSessionStore>['useSession'];
const stores: Store[] = [];
const listeners = new Map<string, (snapshot: any) => void>();
const unsubscribers: jest.Mock[] = [];
const makeStore = () => {
  const manager = createSessionStore();
  stores.push(manager.useSession);
  return manager;
};
const timestamp = (date: Date) => ({ toDate: () => date });
const snapshot = (data: Record<string, unknown>) => ({ exists: () => true, data: () => data });

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers();
  Object.assign(globalThis, { __DEV__: false });
  Object.assign(auth, { currentUser: { uid: 'me' } });
  // resetAllMocks also clears these reference-building implementations.
  const firestore = jest.requireMock('@react-native-firebase/firestore');
  const ref = (path: string) => ({ path, id: path.split('/').pop() });
  firestore.doc.mockImplementation((base: { path: string }, ...parts: string[]) => ref(parts.length ? parts.join('/') : `${base.path}/new-session`));
  firestore.collection.mockImplementation((_db: unknown, ...parts: string[]) => ref(parts.join('/')));
  firestore.query.mockImplementation((value: unknown) => value);
  jest.mocked(updateDoc).mockResolvedValue(undefined);
  jest.mocked(setDoc).mockResolvedValue(undefined);
  jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
  jest.mocked(AsyncStorage.setItem).mockResolvedValue();
  jest.mocked(saveActiveWatch).mockResolvedValue();
  jest.mocked(removeActiveWatch).mockResolvedValue();
  jest.requireMock('../../../lib/fcmToken').getFcmToken.mockResolvedValue('fresh-token');
  listeners.clear();
  unsubscribers.length = 0;
  jest.mocked(onSnapshot).mockImplementation(((ref: { path: string }, optionsOrCallback: any, callback?: any) => {
    listeners.set(ref.path, callback ?? optionsOrCallback);
    const unsubscribe = jest.fn();
    unsubscribers.push(unsubscribe);
    return unsubscribe;
  }) as any);
});

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.getState().stopListening();
    store.getState().stopConnectionMonitoring();
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('public facade still exposes the store and shared sign-in entry point', async () => {
  expect(await ensureSignedIn()).toBe('me');
  expect(useSession.getState().triggerSOS).toEqual(expect.any(Function));
  expect(useSession.getState().restoreWatchSession).toEqual(expect.any(Function));
});

test('restoration replaces the previous session, resets private fields and refreshes the token', async () => {
  const { useSession: store } = makeStore();
  store.setState({ sessionId: 'old', myRole: 'watcher', walkerPhone: '12345678', walkerLocation: { latitude: 1, longitude: 2 } });
  store.getState().listenToSession();
  const oldUnsubscribers = [...unsubscribers];
  const sosAt = new Date();
  jest.mocked(getDoc).mockResolvedValue(snapshot({
    watcherUid: 'me', status: 'sos', sosAt: timestamp(sosAt), sosSilent: true,
    expiresAt: timestamp(new Date(Date.now() + 60_000)), walkerName: '家族',
  }) as any);

  expect(await store.getState().restoreWatchSession('new')).toEqual({ ok: true, status: 'sos' });
  oldUnsubscribers.forEach(unsubscribe => expect(unsubscribe).toHaveBeenCalledTimes(1));
  expect(store.getState()).toMatchObject({
    sessionId: 'new', status: 'sos', myRole: 'watcher', sosAt, sosSilent: true,
    walkerName: '家族', walkerPhone: null, walkerLocation: null, fcmToken: 'fresh-token',
  });
  expect(saveActiveWatch).toHaveBeenCalledWith('new');
  expect(updateDoc).toHaveBeenCalledWith(expect.objectContaining({ path: 'sessions/new' }), { watcherFcmToken: 'fresh-token' });
  expect(listeners.has('sessions/new')).toBe(true);
});

test('unreadable restoration preserves the current session and saved watch', async () => {
  const { useSession: store } = makeStore();
  store.setState({ sessionId: 'old', myRole: 'watcher' });
  jest.mocked(getDoc).mockRejectedValue(new Error('offline'));
  expect(await store.getState().restoreWatchSession('new')).toEqual({ ok: false, reason: 'unreadable' });
  expect(store.getState().sessionId).toBe('old');
  expect(removeActiveWatch).not.toHaveBeenCalled();
  expect(onSnapshot).not.toHaveBeenCalled();
});

test.each(['ended', 'arrived', 'cancelled', 'unknown'])('restoration refuses %s sessions', async status => {
  const { useSession: store } = makeStore();
  jest.mocked(getDoc).mockResolvedValue(snapshot({ watcherUid: 'me', status }) as any);
  expect(await store.getState().restoreWatchSession('dead')).toEqual({ ok: false, reason: 'dead' });
  expect(store.getState().sessionId).toBeNull();
});

test('starting a new session clears old SOS data and persists the new watch', async () => {
  const { useSession: store } = makeStore();
  store.setState({ status: 'sos', sosSilent: true, sosAt: new Date(), walkerPhone: '12345678', walkerName: '前の人' });
  const id = await store.getState().createSession(20);
  expect(id).toBe('new-session');
  expect(store.getState()).toMatchObject({
    sessionId: id, status: 'waiting', sosAt: null, sosSilent: false, walkerPhone: null, walkerName: null,
  });
  expect(setDoc).toHaveBeenCalledWith(expect.objectContaining({ path: 'sessions/new-session' }), expect.objectContaining({ watcherUid: 'me', status: 'waiting', estimatedMinutes: 20 }));
  expect(saveActiveWatch).toHaveBeenCalledWith(id);
});

test('late SOS delivery cannot overwrite the state after the session ends', async () => {
  const { useSession: store } = makeStore();
  let deliver!: () => void;
  jest.mocked(updateDoc).mockImplementationOnce(() => new Promise<void>(resolve => { deliver = resolve; }));
  store.setState({ sessionId: 'walk', myRole: 'walker' });
  store.getState().triggerSOS(true);
  expect(store.getState().sosDeliveryStatus).toBe('sending');
  await jest.advanceTimersByTimeAsync(8000);
  expect(store.getState().sosDeliveryStatus).toBe('unconfirmed');
  expect(await store.getState().endSession('arrived')).toBe(true);
  deliver();
  await Promise.resolve();
  expect(store.getState()).toMatchObject({ sessionId: null, sosDeliveryStatus: 'idle', sosSilent: false });
});

test('failed end keeps the active session and listeners; successful end releases them', async () => {
  const { useSession: store } = makeStore();
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  store.setState({ sessionId: 'watch', myRole: 'watcher' });
  store.getState().listenToSession();
  store.getState().startConnectionMonitoring();
  jest.mocked(updateDoc).mockRejectedValueOnce(new Error('denied'));
  expect(await store.getState().endSession()).toBe(false);
  expect(store.getState().sessionId).toBe('watch');
  unsubscribers.forEach(unsubscribe => expect(unsubscribe).not.toHaveBeenCalled());
  expect(await store.getState().endSession()).toBe(true);
  unsubscribers.forEach(unsubscribe => expect(unsubscribe).toHaveBeenCalledTimes(1));
  expect(jest.getTimerCount()).toBe(0);
  expect(removeActiveWatch).toHaveBeenCalledWith('watch');
  warning.mockRestore();
});

test('subscriptions notify on a new SOS once, and timers belong to each store', () => {
  const a = makeStore().useSession;
  const b = makeStore().useSession;
  a.setState({ sessionId: 'a', myRole: 'watcher' });
  b.setState({ sessionId: 'b', myRole: 'watcher' });
  a.getState().listenToSession();
  b.getState().listenToSession();
  listeners.get('sessions/a')!(snapshot({ status: 'active' }));
  listeners.get('sessions/a')!(snapshot({ status: 'sos' }));
  listeners.get('sessions/a')!(snapshot({ status: 'sos' }));
  expect(notify).toHaveBeenCalledTimes(1);
  b.getState().startConnectionMonitoring();
  expect(jest.getTimerCount()).toBe(2);
  a.getState().stopConnectionMonitoring();
  expect(jest.getTimerCount()).toBe(1);
  expect(b.getState().status).toBe('active');
});

test('cold-start sign-in waits for restored auth and never creates a replacement user', async () => {
  Object.assign(auth, { currentUser: null });
  const manager = makeStore();
  let restore!: (user: any) => void;
  jest.mocked(onAuthStateChanged).mockImplementation((_auth, callback) => {
    restore = callback as typeof restore;
    return jest.fn();
  });
  manager.useSession.getState().initAuth();
  const pending = manager.ensureSignedIn();
  expect(signInAnonymously).not.toHaveBeenCalled();
  Object.assign(auth, { currentUser: { uid: 'restored' } });
  restore({ uid: 'restored' });
  expect(await pending).toBe('restored');
  expect(signInAnonymously).not.toHaveBeenCalled();
});

test('auth timeout on a previously used device refuses to replace its identity', async () => {
  Object.assign(auth, { currentUser: null });
  jest.mocked(AsyncStorage.getItem).mockResolvedValue('1');
  const manager = makeStore();
  const pending = manager.ensureSignedIn();
  const check = expect(pending).rejects.toThrow('認証の準備中');
  await jest.advanceTimersByTimeAsync(3000);
  await check;
  expect(signInAnonymously).not.toHaveBeenCalled();
});
