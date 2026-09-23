import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SentinelSensitivity, TransportMode } from './sentinel';

// 前回の見守り設定（R-4）。毎回おなじ設定を作り直す手間をなくすために端末へ残す。
// 端末内のみ。セッション文書ではないので、サーバーには送らない。
// 電話番号もここに含める（見守る人が毎回入力し直さずに済むようにする。D-1 承認済み）。
export type WatchPreferences = {
  minutes: number;
  mode: 'hold' | 'sentinel';
  sensitivity: SentinelSensitivity;
  transport: TransportMode;
  hasHome: boolean;
  walkerPhone?: string;
  // 相手の呼び名（v3 §2.3）。毎回入れ直させないため端末に覚えるが、
  // 端末内のみ・見守りを作るときにその見守りへ写すだけ。
  walkerName?: string;
  savedAt: number;
};

const KEY = 'lastWatchPreferences';

// 器がまだ無いときに使う最小の既定値（M-10）。
// 恒久ペア経由だけを使う見守り手は WatcherSetup を一度も通らないため、この器が
// 作られない。作られていないと電話番号の端末保存も削除も黙って no-op になり、
// 「登録したはずの番号が次の見守りに引き継がれない」「消したつもりが消えていない」
// という、どちらも本人には見えない失敗になる。値は WatcherHomeScreen の
// ペア依頼のフォールバック（20分・AIおまかせ・乗り物もあり）と揃えてある。
const DEFAULT_PREFERENCES: Omit<WatchPreferences, 'savedAt'> = {
  minutes: 20,
  mode: 'sentinel',
  sensitivity: 'medium',
  transport: 'vehicle_ok',
  hasHome: false,
};

export async function loadWatchPreferences(): Promise<WatchPreferences | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as WatchPreferences;
    return typeof p?.minutes === 'number' ? p : null;
  } catch {
    return null;
  }
}

export async function saveWatchPreferences(p: Omit<WatchPreferences, 'savedAt'>): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify({ ...p, savedAt: Date.now() }));
  } catch {
    // 保存できなくても見守り自体は成立するので黙って諦める
  }
}

// 電話番号カードを「あとで」で閉じたことを覚える（毎回出さない）
const PHONE_PROMPT_KEY = 'phonePromptDismissed';

export async function isPhonePromptDismissed(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(PHONE_PROMPT_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function dismissPhonePrompt(): Promise<void> {
  await AsyncStorage.setItem(PHONE_PROMPT_KEY, '1').catch(() => {});
}

// 端末に覚えている緊急連絡先を消す（設定画面から。ポリシー上の削除手段）
export async function clearStoredPhone(): Promise<void> {
  const prev = await loadWatchPreferences();
  if (!prev) return; // そもそも器が無い＝覚えている番号も無い
  const { walkerPhone, ...rest } = prev;
  await saveWatchPreferences(rest);
}

// 端末に覚えている相手の呼び名を消す（設定タブから。walkerPhone と同じ扱い）。
// 「他人に関する情報」を端末に持つ以上、消す手段は必ず用意する（仕様§9 / M-4）
export async function clearStoredName(): Promise<void> {
  const prev = await loadWatchPreferences();
  if (!prev) return; // そもそも器が無い＝覚えている呼び名も無い
  const { walkerName, ...rest } = prev;
  await saveWatchPreferences(rest);
}

// 電話番号だけを更新する（見守り中の画面から後追いで登録されるため）。
// 器が無ければ最小の既定値から作る（M-10）。ここで諦めると、ペア経由だけを使う
// 見守り手は電話番号を端末に覚えられず、削除する対象も永久に生まれない。
export async function saveWatcherPhonePreference(walkerPhone: string): Promise<void> {
  const prev = (await loadWatchPreferences()) ?? DEFAULT_PREFERENCES;
  await saveWatchPreferences({ ...prev, walkerPhone });
}

// 「20分・おまもりボタン・歩きだけ」形式の要約（再利用カード・設定サマリで使う）
export function describeWatchPreferences(p: {
  minutes: number;
  mode: 'hold' | 'sentinel';
  transport: TransportMode;
  hasHome?: boolean;
}): string {
  const parts = [
    `${p.minutes}分`,
    p.mode === 'sentinel' ? 'AIおまかせ見守り' : 'おまもりボタン',
    p.transport === 'walk' ? '歩きだけ' : '乗り物もあり',
  ];
  if (p.hasHome) parts.push('自宅ピンあり');
  return parts.join('・');
}
