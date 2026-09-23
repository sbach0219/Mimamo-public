import type { NavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../store/sessionStore';

export type NotificationRouteRequest = { type?: string; sessionId?: string; pairId?: string };

// 恒久ペア由来の通知（ADR P3）。セッションが存在しない事象なので sessionId を持たず、
// 遷移先は「つながり」画面に固定される。
const PAIR_TYPES = new Set(['pair_active', 'pair_revoked', 'pair_stale']);

// 通知タップ時の遷移規約（設計書 決定D・Phase3 §5-7、v3 §2.2 でタブ化）。
// type === 'message' → チャット、それ以外 → 役割に応じた画面。
// すでに同じセッションを購読中（アプリがバックグラウンドから復帰しただけ＝warm）なら
// そのまま遷移する。別セッション・未起動（cold start）の場合は、見守り側の復元を試し、
// だめなら歩行側の復元を試す（A-4 で歩く人側の復帰経路も入ったため、cold start で
// 歩く人宛ての通知をタップしたケースもここで解決できる）。
// どちらでもなければ通常起動（RoleSelect）にフォールバックする。
//
// 見守り側の行き先はタブ（WatcherTabs）を土台にして、その上へ詳細を積む。
// タブを先に navigate しておくのは、通知から直接 SOS を開いたあと「もどる」で
// ホームに着地させるため（1枚スタックの密室を作らない）。
export async function routeNotificationTap(
  navRef: NavigationContainerRef<RootStackParamList>,
  request: NotificationRouteRequest,
): Promise<void> {
  const { type, sessionId } = request;

  if (type && PAIR_TYPES.has(type)) {
    navRef.navigate('Pairs');
    return;
  }

  if (!sessionId) return;

  // ペア起点の見守り依頼（2026-08-26 決定①）。まだ参加していないセッションなので
  // 復元経路（restoreWalkSession）には乗らない。承諾画面へ直接送る。
  // ここで自動参加させてはいけない——通知タップが位置共有の開始条件になってしまい、
  // 「承諾＝歩く人の端末上の明示操作」という不変条件（I-2）が骨抜きになる。
  if (type === 'watch_request') {
    navRef.navigate('WatchRequest', { sessionId });
    return;
  }

  const store = useSession.getState();
  const isSameSession = store.sessionId === sessionId;

  // SOS だけは専用の全画面へ。異常検知・応答なしは従来どおり詳細画面で受ける。
  // status は呼び出し側から渡す（復帰直後にストアを覗くと、購読が届く前の
  // 前セッションの値を読んでしまうため。H-1）
  const openWatcher = (status: string) => {
    navRef.navigate('WatcherTabs');
    if (status === 'sos') navRef.navigate('WatcherSos');
    else navRef.navigate('WatcherMonitor');
  };

  if (type === 'message') {
    if (isSameSession) {
      navRef.navigate('Chat');
      return;
    }
    const restored = await store.restoreWatchSession(sessionId).catch(() => ({ ok: false }) as const);
    if (restored.ok) {
      navRef.navigate('WatcherTabs');
      navRef.navigate('Chat');
      return;
    }
    if (await store.restoreWalkSession(sessionId).catch(() => false)) {
      const s = useSession.getState();
      navRef.navigate(s.mode === 'sentinel' ? 'MainSentinel' : 'Main', { estimatedMinutes: s.estimatedMinutes });
      navRef.navigate('Chat');
    }
    return;
  }

  if (isSameSession) {
    if (store.myRole === 'watcher') {
      // 購読中のセッションなので、ストアの status は最新
      openWatcher(store.status);
    } else if (store.myRole === 'walker') {
      navRef.navigate(store.mode === 'sentinel' ? 'MainSentinel' : 'Main', { estimatedMinutes: store.estimatedMinutes });
    }
    return;
  }

  const restored = await store.restoreWatchSession(sessionId).catch(() => ({ ok: false }) as const);
  if (restored.ok) {
    openWatcher(restored.status);
    return;
  }
  if (await store.restoreWalkSession(sessionId).catch(() => false)) {
    const s = useSession.getState();
    navRef.navigate(s.mode === 'sentinel' ? 'MainSentinel' : 'Main', { estimatedMinutes: s.estimatedMinutes });
    return;
  }
  // 終了の知らせは、そのセッションがもう復帰できないからこそ届く（L-6）。
  // ここで何もしないと cold start のタップが空振りになるので、歩く人の起点へ着地させる。
  if (type === 'watch_ended' || type === 'watch_auto_ended') navRef.navigate('RoleSelect');
}
