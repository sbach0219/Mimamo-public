import { HEARTBEAT_STALE_SEC, LIVE_SESSION_STATUSES, TERMINAL_SESSION_STATUSES } from '../../lib/sessionStatus';
import type { SentinelSensitivity, TransportMode } from '../../lib/sentinel';
import type { SessionState, StartOptions } from './types';

// 接続が「とだえている」とみなす秒数。ホームのリスト行バッジと同じ値を見る（sessionStatus.ts）
export const UNSTABLE_THRESHOLD = HEARTBEAT_STALE_SEC;

export const tsToDate = (v: any): Date | null =>
  v && typeof v.toDate === 'function' ? v.toDate() : null;

export const parseTransport = (v: any): TransportMode => (v === 'walk' ? 'walk' : 'vehicle_ok');

export const parseSensitivity = (v: any): SentinelSensitivity =>
  v === 'low' || v === 'high' ? v : 'medium';

export const parseWalkerName = (v: any): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v : null;

// rules と同じ上限（30文字）でクライアント側も切る。改行はリスト行を崩すので潰す。
export const WALKER_NAME_MAX = 30;

export function normalizeWalkerName(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, WALKER_NAME_MAX);
  return trimmed.length > 0 ? trimmed : null;
}

// セッション固有の値をすべて初期値へ落とすパッチ。
// 器（この store）は同時に1セッションしか持てないので、**別のセッションへ乗り換える前に
// 必ずこれを当てる**。listenToSession の patch は「フィールドが存在するときだけ上書き」
// する作りなので、これが無いと新しいセッションに無い値（位置・電話番号・電池・住所の元に
// なる座標）が前のセッションのまま残る。
// v3 でリストの行タップが日常操作になり、器の乗り換えが常時起きるようになったため、
// 復帰系（restoreWatchSession / restoreWalkSession）と endSession で共有する。
export function sessionResetPatch(): Partial<SessionState> {
  return {
    status: 'active',
    pairId: null,
    messages: [],
    walkerLocation: null,
    homeLocation: null,
    routeCoordinates: [],
    connectionStatus: 'good',
    sessionCreatedAt: null,
    expiresAt: null,
    walkStartedAt: null,
    lastHeartbeatDate: null,
    lastHeartbeatOkAt: null,
    walkerBatteryLevel: null,
    walkerBatteryState: null,
    anomalyType: null,
    sosSilent: false,
    sosAt: null,
    sosAcknowledgedAt: null,
    sosDeliveryStatus: 'idle',
    walkerPhone: null,
    walkerName: null,
    locationMode: null,
    endedBy: null,
    safetyCheckRequestedAt: null,
    safetyCheckResponse: null,
    isSessionExpired: false,
  };
}

// restoreWatchSession() の生存判定に使う許可リスト（L1）。ここに無い status
// （ended・cancelled・arrived 等の終端状態）は一律「復元しない」。
// 定義は lib/sessionStatus.ts に一本化した（同じ集合が store・functions・rules・
// 履歴ラベルへ多重に写されていたため。architecture-review B-2）。
export const isRestorableStatus = (v: unknown): boolean =>
  typeof v === 'string' && (LIVE_SESSION_STATUSES as readonly string[]).includes(v);

// 画面にそのまま出してよい文言であることの目印。
// Firestore の生エラー（英語・rules 拒否）をユーザーに見せないための区別。
export function userError(message: string): Error & { userFacing: true } {
  return Object.assign(new Error(message), { userFacing: true as const });
}

// C-2: 「同時に1セッション・1役割」という前提は store 全域に暗黙で埋まっているが、
// 乗り替えてよいかの確認だけが存在しなかった。生きたセッションを持ったまま
// createSession / joinSession / startPairWalk が走ると、購読は張り替わり activeWatch は
// 上書きされ、旧セッションは誰にも見られない幽霊として残る。
// 前提そのものの解消（複数セッション購読）は Stage 2 の store 改修に委ね、
// ここでは「黙って乗り替えない」ことだけを保証する。
export function assertNoLiveSession(state: SessionState, options?: StartOptions): void {
  if (options?.replaceExisting) return;
  if (!hasLiveSessionState(state)) return;
  throw userError('いま進行中の見守りがあります。先にそちらを終わらせてください');
}

export function hasLiveSessionState(state: SessionState): boolean {
  if (state.sessionId == null) return false;
  if (state.isSessionExpired) return false;
  return !(TERMINAL_SESSION_STATUSES as readonly string[]).includes(state.status);
}
