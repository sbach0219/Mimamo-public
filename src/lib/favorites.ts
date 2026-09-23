import AsyncStorage from '@react-native-async-storage/async-storage';

// Swift版 FavoritesStore（UserDefaults）の移植。最近の見守り相手を保存。
export interface FavoritePartner {
  sessionId: string;
  label: string;
  savedAt: number;
}

const KEY = 'favoritePartners';

export async function loadFavorites(): Promise<FavoritePartner[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as FavoritePartner[]) : [];
  } catch {
    return [];
  }
}

export async function addFavorite(sessionId: string, label: string): Promise<void> {
  const items = (await loadFavorites()).filter((i) => i.sessionId !== sessionId);
  items.unshift({ sessionId, label, savedAt: Date.now() });
  await AsyncStorage.setItem(KEY, JSON.stringify(items.slice(0, 10)));
}

export async function removeFavorite(sessionId: string): Promise<void> {
  const items = (await loadFavorites()).filter((i) => i.sessionId !== sessionId);
  await AsyncStorage.setItem(KEY, JSON.stringify(items));
}
