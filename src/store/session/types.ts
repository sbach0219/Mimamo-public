import type { SessionStatus, SessionEndedBy } from '../../lib/sessionStatus';
import type { LocationMode } from '../../lib/locationMode';
import type { WalkStartResult } from '../../tasks/locationTask';
import type { DeliveryStatus } from '../../lib/serverDelivery';
import type { SentinelSensitivity, TransportMode, AnomalyType } from '../../lib/sentinel';
import type { Pair } from '../../lib/pairs';

export type Role = 'walker' | 'watcher';

export type Coord = { latitude: number; longitude: number };

export type ConnectionStatus = 'good' | 'unstable';

// 見守りモード。'hold'=ボタンを押し続ける（既存）／'sentinel'=AI異常検知（新規）。
// 旧データには mode が無いので、未設定は 'hold' とみなす（後方互換）。
export type WatchMode = 'hold' | 'sentinel';

// 見守りセッション復帰の結果。'dead' = 読めたが終端・期限切れ・別ユーザー、
// 'unreadable' = そもそも読めなかった（圏外・認証未復元）。前者だけが永続化を消してよい。
export type WatchRestoreResult =
  | { ok: true; status: SessionStatus }
  | { ok: false; reason: 'dead' | 'unreadable' };

export interface ChatMessage {
  id: string;
  text: string;
  sender: string; // "walker" | "watcher"
  acknowledged: boolean;
  pending: boolean; // まだサーバーに届いていない
}

export interface HistoryItem {
  id: string;
  role: Role;
  mode: WatchMode;
  estimatedMinutes: number;
  createdAt: Date;
  endedAt: Date | null;
  finalStatus: string;
}

export interface SessionState {
  authReady: boolean;
  uid: string | null;
  fcmToken: string | null;

  sessionId: string | null;
  pendingJoinId: string | null;
  // 参加処理の進行状況。RoleSelect と Start の両方が同じ状態を表示できるように
  // 画面のローカル state ではなくストアに持つ（deep link 参加はどちらの画面にいても走る）
  isJoining: boolean;
  joinError: string | null;
  status: SessionStatus;
  // 恒久ペア起点のセッションだけが持つ（ADR P3 決定2）。都度セッションは null のまま。
  pairId: string | null;
  messages: ChatMessage[];
  estimatedMinutes: number;
  isSessionExpired: boolean;
  myRole: Role | null;
  mode: WatchMode;
  // センチネルの感度（見守り側が設定時に選ぶ。旧セッションは medium 扱い）
  sentinelSensitivity: SentinelSensitivity;
  // 移動手段の宣言。'walk'=徒歩のみ（移動異常＝連れ去り検知を武装）
  transport: TransportMode;
  walkerLocation: Coord | null;
  homeLocation: Coord | null;
  routeCoordinates: Coord[];
  connectionStatus: ConnectionStatus;
  sessionCreatedAt: Date | null;
  // セッションの有効期限。時間延長はこの値に分を足す（extendTime参照）
  expiresAt: Date | null;
  walkStartedAt: Date | null;
  lastHeartbeatDate: Date | null;
  walkerBatteryLevel: number | null; // 0..1
  walkerBatteryState: string | null;
  // センチネル：検知された異常の種類（'stall'=停滞 / 'fall'=転倒）
  anomalyType: AnomalyType | null;
  // SOSが「音なし（サイレント）」で発信されたか。
  // 音を出すと危ない状況（尾行など）のシグナルなので見守り側にも共有する
  sosSilent: boolean;
  // SOS が発信された時刻。SOS画面の「要請検知 n分前」に使う
  sosAt: Date | null;
  // 見守る人がSOS画面を実際に開いた時刻。FCMの到達ではなく、家族の確認を示す。
  sosAcknowledgedAt: Date | null;
  // 歩く人の緊急連絡先（任意・見守る人が登録）。D-1 承認済み
  walkerPhone: string | null;
  // 位置共有がどの強さで動いているか（H-2）。歩く人の端末だけが書き、見守る人は読む。
  // null は「まだ書かれていない」＝判定不能なので、警告は出さない。
  locationMode: LocationMode | null;
  // 誰がこのセッションを終わらせたか。'watcher' のときだけ歩く人へ文言を出し分ける。
  endedBy: SessionEndedBy | null;
  // 相手の呼び名（任意・見守る人が設定時に入力）。v3 Phase 1 §2.3。
  // セッション文書に入るので、終端から7日の purge にそのまま乗る。
  walkerName: string | null;
  // 保存できたら true。rules 未反映の環境では false を返し、電話行を出さないだけにする
  saveWalkerPhone: (phone: string) => Promise<boolean>;
  // ローカル反映ではなく、Firestore のサーバー応答で「届いた」を判定する。
  sosDeliveryStatus: DeliveryStatus;
  // 自分の heartbeat がサーバーに届いた最後の時刻。歩く人側の「みまもられて
  // いるか」の判定材料（圏外だと書き込みが解決せず、この値が古くなる）
  lastHeartbeatOkAt: number | null;
  // センチネル：見守りからの安否確認の状態
  safetyCheckRequestedAt: Date | null;
  safetyCheckResponse: 'ok' | 'sos' | null;

  // actions
  initAuth: () => void;
  setFcmToken: (token: string | null) => void;
  createSession: (estimatedMinutes: number, home?: Coord | null, mode?: WatchMode, sensitivity?: SentinelSensitivity, transport?: TransportMode, walkerName?: string | null, options?: CreateSessionOptions) => Promise<string>;
  joinSession: (id: string, options?: StartOptions) => Promise<void>;
  // 恒久ペアを根拠に、歩く人が自分でセッションを作って歩き始める（ADR P3 決定2・E-4）。
  // 見守り手側にこの経路は存在しない（I-2: 位置共有の開始は常に歩く人の明示操作のみ）。
  startPairWalk: (pair: Pair, options: PairWalkOptions) => Promise<string>;
  // いま生きたセッションを抱えているか（C-2 の乗り替えガード判定）
  hasLiveSession: () => boolean;
  // 見守りセッションの永続化からの復帰（アプリkill後の再起動時、通知タップ時）。
  // Firestoreでセッションの生存（ended/期限切れでない・自分が watcherUid であること）を
  // 確認できた場合のみ state を復元する。
  // 戻り値で status をそのまま返すのは、呼び出し側が「SOS 画面へ直行するか」を
  // 判定するため（ストア経由で覗くと onSnapshot 到着前の値を読む。H-1）。
  // 失敗理由を区別するのは、通信失敗で永続化を消さないため（M-7）。
  restoreWatchSession: (id: string) => Promise<WatchRestoreResult>;
  // 歩行セッションの復帰（歩行中に kill された端末の再起動時）。restoreWatchSession と対称。
  restoreWalkSession: (id: string) => Promise<boolean>;
  setPendingJoinId: (id: string | null) => void;
  listenToSession: () => void;
  stopListening: () => void;
  updateStatus: (status: SessionStatus) => void;
  updateLocation: (coord: Coord) => void;
  triggerSOS: (silent?: boolean) => void;
  cancelSOS: () => void;
  acknowledgeSOS: () => void;
  // センチネル：異常検知の通知/解除・安否確認の送信/応答
  reportAnomaly: (type: string) => void;
  resolveAnomaly: () => void;
  requestSafetyCheck: () => void;
  respondSafetyCheck: (response: 'ok' | 'sos', silent?: boolean) => void;
  extendTime: (minutes: number) => void;
  updateBattery: (level: number, state: string) => void;
  // 歩く人の端末が自分の位置を地名に直して置いていく（D-14）。
  // 終端時に Functions がこれをペアの「最終確認」へ転記する。座標は転記しない。
  reportPlaceLabel: (label: string) => void;
  acknowledgeMessage: (id: string) => void;
  updateHeartbeat: () => void;
  // 位置共有の開始結果をセッション文書へ残す（H-2）。歩く人のみ。
  reportLocationMode: (result: WalkStartResult) => void;
  startConnectionMonitoring: () => void;
  stopConnectionMonitoring: () => void;
  sendMessage: (text: string) => void;
  setChatViewActive: (active: boolean) => void;
  endSession: (reason?: SessionStatus) => Promise<boolean>;
  abandonSession: () => Promise<void>;
  fetchHistory: () => Promise<HistoryItem[]>;
}

// C-2: 生きたセッションを抱えたまま別のセッションを始めようとしたときの扱い。
// 既定では拒否し、UI が確認をとったうえで replaceExisting を渡す。
export type StartOptions = { replaceExisting?: boolean };

// 見守り依頼をペア起点で作るときの追加情報（2026-08-26 決定①）。
export type CreateSessionOptions = StartOptions & { pairId?: string | null };

export type PairWalkOptions = StartOptions & {
  estimatedMinutes: number;
  mode?: WatchMode;
  sensitivity?: SentinelSensitivity;
  transport?: TransportMode;
  home?: Coord | null;
  // 「ひまわり学童保育室」のようなユーザー入力ラベル。座標・住所は入れない（I-1 / E-5）
  destinationLabel?: string;
};

// Internal action factories share one store and two session-scoped resources.
export type SessionContext = {
  set: import('zustand').StoreApi<SessionState>['setState'];
  get: () => SessionState;
  runtime: import('./runtime').SessionRuntime;
  ensureSignedIn: () => Promise<string>;
};
