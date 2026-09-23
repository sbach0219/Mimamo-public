import AsyncStorage from '@react-native-async-storage/async-storage';

// 見守り側セッションの永続化（プロセスkill後の復帰用）。
// 歩く人側は locationTask.ts の 'activeWalk' キーで既に永続化されているが、
// 見守り側には対になるものが無かった（設計書 決定D・Phase3 §5-6）。
// 位置共有や検知はしないため、保存する情報はセッションIDと役割だけで十分。
//
// v3 Phase 1（design-v3-watcher-redesign §2.3）で複数見守りに拡張した。
// 保存形式は配列（'activeWatches'）だが、旧単数キー（'activeWatch'）で保存された
// 端末からアップデートしてくる経路があるため、読み取りは両方を見る。
const KEY = 'activeWatches';
const LEGACY_KEY = 'activeWatch';

// 同時に持てるライブ見守りの上限。無料は1件、グループ（月額サブスク）は複数。
//
// 有料側を D-11b の仮決め幅「3〜5人」の**下限**から始めるのは、あとから上げるのは
// 増量だが、下げるのは一度渡した機能を取り上げることになるため（§2.3 の
// 「機能を後から取り上げる形を作らない」と同じ原則）。運用値なので、上げるときは
// この定数1つを変えればよい。
//
// なお rules ではこの上限を強制できない（rules はクエリできず「自分のライブ
// セッションが何件あるか」を検証式に書けない。§2.5.3）。強制はクライアント制御と
// watchSessions スケジューラの事後検出の2層で、超過を見つけても自動終了はしない
// ——見守り中のセッションをサーバーが勝手に切るのは安全側でない。
export const FREE_CONCURRENT_WATCH_LIMIT = 1;
export const GROUP_CONCURRENT_WATCH_LIMIT = 3;

export function concurrentWatchLimit(groupActive: boolean): number {
  return groupActive ? GROUP_CONCURRENT_WATCH_LIMIT : FREE_CONCURRENT_WATCH_LIMIT;
}

export type ActiveWatch = { sessionId: string; role: 'watcher' };

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
    }
    // 旧形式（{ sessionId, role }）
    return typeof parsed?.sessionId === 'string' ? [parsed.sessionId] : [];
  } catch {
    return [];
  }
}

export async function getActiveWatches(): Promise<string[]> {
  const [raw, legacyRaw] = await Promise.all([
    AsyncStorage.getItem(KEY),
    AsyncStorage.getItem(LEGACY_KEY),
  ]);
  const ids = [...parseIds(raw), ...parseIds(legacyRaw)];
  return ids.filter((id, i) => ids.indexOf(id) === i);
}

// 旧単数APIの互換。先頭の1件を返す。
export async function getActiveWatch(): Promise<ActiveWatch | null> {
  const [first] = await getActiveWatches();
  return first ? { sessionId: first, role: 'watcher' } : null;
}

// 変更はすべて1本の直列キューに通す。
// 「全件読む → 加工 → 書き戻す」を並行に走らせると、同じ基底配列を読んだ後着の書き込みが
// 先着を消す。実際 watchListStore は1スナップショットの中から save と remove を
// await せずに撃つため、進行中の見守りの永続化が消えて次回起動で復帰できなくなる（M-1）。
let queue: Promise<void> = Promise.resolve();
function enqueue(work: () => Promise<void>): Promise<void> {
  queue = queue.then(work, work);
  return queue;
}

async function writeIds(ids: string[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(ids));
  // 旧キーは残しておくと getActiveWatches が終了済みセッションを拾い続けるので消す
  await AsyncStorage.removeItem(LEGACY_KEY).catch(() => {});
}

export function saveActiveWatch(sessionId: string): Promise<void> {
  return enqueue(async () => {
    const ids = await getActiveWatches();
    if (ids.includes(sessionId)) return;
    ids.push(sessionId);
    await writeIds(ids);
  });
}

// 1件だけ外す（そのセッションが終端したとき）。
export function removeActiveWatch(sessionId: string): Promise<void> {
  return enqueue(async () => {
    const ids = await getActiveWatches();
    if (!ids.includes(sessionId)) return;
    await writeIds(ids.filter((id) => id !== sessionId));
  });
}

export function clearActiveWatch(): Promise<void> {
  return enqueue(async () => {
    await AsyncStorage.removeItem(KEY);
    await AsyncStorage.removeItem(LEGACY_KEY);
  });
}
