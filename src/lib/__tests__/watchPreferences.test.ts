import { saveWatcherPhonePreference, loadWatchPreferences, clearStoredPhone } from '../watchPreferences';

const store = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: async (k: string, v: string) => { store.set(k, v); },
  },
}));

// ペア経由だけを使う見守り手は WatcherSetup を通らないため、設定の器が作られない。
// 器が無いことを理由に諦めると、番号の保存も削除も本人に見えないまま no-op になる（M-10）。
describe('saveWatcherPhonePreference', () => {
  beforeEach(() => store.clear());

  it('器が無くても既定値から作って番号を覚える', async () => {
    await saveWatcherPhonePreference('0312345678');
    const p = await loadWatchPreferences();
    expect(p?.walkerPhone).toBe('0312345678');
    expect(p?.minutes).toBe(20);
    expect(p?.mode).toBe('sentinel');
    expect(p?.transport).toBe('vehicle_ok');
    expect(p?.hasHome).toBe(false);
  });

  it('既存の器があれば、そちらの設定は壊さない', async () => {
    store.set('lastWatchPreferences', JSON.stringify({
      minutes: 45, mode: 'hold', sensitivity: 'high', transport: 'walk', hasHome: true, savedAt: 1,
    }));
    await saveWatcherPhonePreference('09000000000');
    const p = await loadWatchPreferences();
    expect(p?.minutes).toBe(45);
    expect(p?.mode).toBe('hold');
    expect(p?.hasHome).toBe(true);
    expect(p?.walkerPhone).toBe('09000000000');
  });

  it('覚えた番号は設定から消せる（器ごと消さない）', async () => {
    await saveWatcherPhonePreference('0312345678');
    await clearStoredPhone();
    const p = await loadWatchPreferences();
    expect(p?.walkerPhone).toBeUndefined();
    expect(p?.minutes).toBe(20);
  });
});
