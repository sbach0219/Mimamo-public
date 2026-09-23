import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { collection, doc, updateDoc, addDoc, getDoc, serverTimestamp } from '@react-native-firebase/firestore';
import { auth, db } from '../lib/firebase';
import { notify } from '../lib/notifications';
import { readBattery } from '../lib/battery';
import {
  STALL_RADIUS_M, VEHICLE_SPEED_MPS, MOVE_SPEED_MPS, REST_AUTO_RESUME_MS,
  sentinelParams, MoveAnomalyDetector,
  type SentinelSensitivity, type TransportMode,
} from '../lib/sentinel';
import { LIVE_SESSION_STATUSES } from '../lib/sessionStatus';
import { RouteThinner } from '../lib/routeThinning';
import { claimEndedNotice } from '../lib/endedNotice';
import {
  INITIAL_AREA_STATE, readArea, stepArea, acknowledgeArea, isAreaArmed,
  type AreaState, type AreaEvent,
} from '../lib/dangerArea';
import { loadDangerAreaIndex } from '../lib/dangerAreaData';

// アプリを閉じていても位置・ハートビートを送り続けるバックグラウンドタスク。
// React コンテキスト外（ヘッドレス）で動くため、進行中セッションの情報は
// AsyncStorage に保存して受け渡す。
export const LOCATION_TASK = 'thousandsky-location';

const ACTIVE_KEY = 'activeWalk';
const ENTERED_KEY = 'activeWalkGeofenceEntered';
const STALL_KEY = 'activeWalkStall';            // { lastMovedAt, lat, lng }
const STALL_STAGE_KEY = 'activeWalkStallStage'; // '1'=本人確認通知済み / '2'=見守りへ通知済み
const MOVE_STAGE_KEY = 'activeWalkMoveStage';   // '1'=移動異常を通知済み（歩行に戻るまで再通知しない）
const AREA_KEY = 'activeWalkArea';              // AreaState（人気のない場所の連続滞在・段階・抑制）
const WALK_STATE_KEYS = [ACTIVE_KEY, ENTERED_KEY, STALL_KEY, STALL_STAGE_KEY, MOVE_STAGE_KEY, AREA_KEY];
const GEOFENCE_RADIUS = 15; // m
const GEOFENCE_DWELL = 120 * 1000; // ms
// 到着してよい状態かの確認（getDoc）の間隔。滞在中は毎サンプル聞きに行かない
const ARRIVAL_CHECK_COOLDOWN = 60 * 1000; // ms
let lastArrivalCheckAt = 0;

type Coord = { latitude: number; longitude: number };
type WatchMode = 'hold' | 'sentinel';
type ActiveWalk = {
  sessionId: string;
  home: Coord | null;
  mode?: WatchMode;
  sensitivity?: SentinelSensitivity;
  transport?: TransportMode; // 'walk'=移動異常（連れ去り）検知を武装
  restingUntil?: number; // 「休憩中」の期限（自動再開）。過ぎたら検知を再開する
};

// 移動異常の検出器。45秒窓の状態しか持たないため AsyncStorage 永続化はせず
// モジュールスコープで保持する（プロセス再起動で消えても許容）。
const moveDetector = new MoveAnomalyDetector();

// rules に弾かれた書き込み。オフラインのキュー待ちとは違い、待っても成功しない。
function isPermissionDenied(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code ?? '';
  return typeof code === 'string' && code.includes('permission-denied');
}

// 位置タスクを止めてよいのは「セッションが本当に終わっている」と確認できたときだけ。
// 停止は ACTIVE_KEY ごと消す＝再起動時の歩行復帰（A-4）も失われる不可逆操作なので、
// 一時的な拒否（rules 伝播の途中・時計ずれ・読み取り失敗）では止めない。
const LIVE_STATUSES: readonly string[] = LIVE_SESSION_STATUSES;
const DENIED_TOLERANCE = 3; // 終端を確認できない拒否がこの回数続いたら諦めて停止する
let deniedStreak = 0;

// 経路点の間引き（B-4）。45秒窓の moveDetector と同じ理由で AsyncStorage には
// 永続化しない（プロセス再起動で消えても、余分な点が1つ書かれるだけ）。
const routeThinner = new RouteThinner();

async function handleWriteDenied(sessionId: string, ref: ReturnType<typeof doc>): Promise<void> {
  let status: string | null = null;
  try {
    const snap = await getDoc(ref);
    status = snap.exists() ? ((snap.data()?.status as string) ?? null) : null;
  } catch {
    status = null; // 読めない＝終端かどうか不明
  }

  const terminal = status != null && !LIVE_STATUSES.includes(status);
  if (!terminal) {
    deniedStreak += 1;
    if (deniedStreak < DENIED_TOLERANCE) return; // まだ様子を見る
  }
  deniedStreak = 0;

  // 黙って止めると「位置を送っているつもり」のまま歩き続けることになる。
  // サーバーからの watch_ended と二重になり得るが、通知許可を切っている端末では
  // こちらが唯一の合図なので消さない。重複だけを短時間の記憶で抑える（L-5）。
  if (claimEndedNotice(sessionId)) {
    await notify(
      '見守りが おわりました',
      'いまの場所を おくるのを とめたよ。つづけるときは アプリをひらいてね。',
      'default',
      { type: 'session_ended', sessionId },
    );
  }
  await stopBackgroundWalk();
}

function distanceMeters(a: Coord, b: Coord): number {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// アプリが背面のあいだ、電池残量を位置ティックに相乗りさせて送る（§8）。
// 前面の useBatteryReport は背面では動かないため、これが無いと見守り側の
// SOS 画面に出る残量が歩き出しの値のまま古くなる。
// 位置の書き込みは待たせないので別の書き込みにし、そのぶん頻度を60秒に絞る。
// 取得できない端末（headless から expo-battery が使えない等）では黙って省略する。
const BATTERY_REPORT_INTERVAL_MS = 60_000;
let lastBatteryReportAt = 0;
function reportBatteryFromTask(ref: ReturnType<typeof doc>): void {
  if (Date.now() - lastBatteryReportAt < BATTERY_REPORT_INTERVAL_MS) return;
  lastBatteryReportAt = Date.now();
  readBattery()
    .then((battery) => { if (battery) return updateDoc(ref, battery); })
    .catch(() => {});
}

// 位置サンプル1件の処理。バックグラウンドタスクと前面ウォッチ（「使用中のみ許可」時の
// フォールバック）の両方から呼ばれるため、React コンテキストに依存しない形で切り出す。
async function processLocationSample(
  coord: Coord,
  speed: number | null | undefined,
  accuracy?: number | null,
): Promise<void> {
  if (!auth.currentUser) return; // 匿名認証が復元されていなければ書けない

  const raw = await AsyncStorage.getItem(ACTIVE_KEY);
  if (!raw) return;
  const active = JSON.parse(raw) as ActiveWalk;
  if (!active?.sessionId) return;

  const ref = doc(db, 'sessions', active.sessionId);

  // 位置の送信は待たない。圏外だと Firestore の Promise はサーバー ack まで
  // 解決しないため、await すると後段の転倒・停滞・移動異常の検知が丸ごと止まる
  // （通信が悪いときこそ検知は動いていてほしい）。
  // オフラインならキューに乗って次回以降に届く。permission-denied だけはキューに
  // 乗らないので、終端を確認したうえでタスクを止める。
  const onDenied = (e: unknown) => {
    if (isPermissionDenied(e)) return handleWriteDenied(active.sessionId, ref);
    deniedStreak = 0;
    return undefined;
  };
  updateDoc(ref, {
    latitude: coord.latitude,
    longitude: coord.longitude,
    locationUpdatedAt: serverTimestamp(),
    lastHeartbeat: serverTimestamp(),
  }).then(() => { deniedStreak = 0; }, onDenied);
  reportBatteryFromTask(ref);
  // 軌跡は間引いて書く（B-4）。親docの座標は毎サンプル更新しているので鮮度は落ちない。
  if (routeThinner.accept({ ...coord, at: Date.now() })) {
    addDoc(collection(db, 'sessions', active.sessionId, 'route'), {
      lat: coord.latitude,
      lng: coord.longitude,
      timestamp: serverTimestamp(),
    }).catch(() => {}); // 経路は親docの座標があれば復元できるので、失敗しても静かに捨てる
  }

  // 移動異常（連れ去り）検知：徒歩宣言セッションでは両モードで動かす
  // （連れ去りリスクが高い子どもはホールドモード利用が主のため）
  if (active.transport === 'walk') {
    await detectMove(active, coord, speed);
  }

  // 危険エリア（人気のない場所への進入）：徒歩宣言セッションのみ武装（Phase 3・設計 §7.2）。
  // 前面・背面のどちらでもここが唯一の判定点（前面 UI はイベントで追従する）。
  if (isAreaArmed(active.transport)) {
    await detectArea(active, coord, accuracy);
  }

  // センチネルモード：位置停滞の検知（バックグラウンド）
  if (active.mode === 'sentinel') {
    await detectStall(active, coord, speed);
  }

  // ジオフェンス到着判定（15m 圏内に2分以上）
  if (active.home) {
    const d = distanceMeters(coord, active.home);
    if (d <= GEOFENCE_RADIUS) {
      const enteredRaw = await AsyncStorage.getItem(ENTERED_KEY);
      const entered = enteredRaw ? Number(enteredRaw) : null;
      if (entered == null) {
        await AsyncStorage.setItem(ENTERED_KEY, String(Date.now()));
      } else if (Date.now() - entered >= GEOFENCE_DWELL) {
        // 自動到着で終端させてよいのは平常時（と応答なしアラート中）だけ。
        // SOS・異常検知の最中に 'arrived' で上書きすると、自宅前での転倒や
        // 自宅付近での連れ去りという、まさに守りたい場面で緊急状態が黙って消える。
        // 判定できない・保留すべきときは ENTERED_KEY を残し、解除後に再判定する。
        // （手動の SlideToArrive は本人の明示操作なので、この保留の対象外）
        // 保留中は位置サンプルのたびに getDoc したくないので、確認は60秒に1回まで。
        if (Date.now() - lastArrivalCheckAt < ARRIVAL_CHECK_COOLDOWN) return;
        lastArrivalCheckAt = Date.now();
        let current: string | null = null;
        try {
          const snap = await getDoc(ref);
          current = snap.exists() ? ((snap.data()?.status as string) ?? null) : null;
        } catch {
          return; // 読めないときは書かない
        }
        if (current !== 'active' && current !== 'alert') return;
        try {
          await updateDoc(ref, { status: 'arrived', endedAt: serverTimestamp() });
        } catch (e) {
          if (isPermissionDenied(e)) await handleWriteDenied(active.sessionId, ref);
          return;
        }
        await notify('ついたね！🎉', '無事に到着しました', 'default', { type: 'arrived', sessionId: active.sessionId });
        await stopBackgroundWalk();
      }
    } else {
      await AsyncStorage.removeItem(ENTERED_KEY);
      lastArrivalCheckAt = 0; // 圏外に出たら次の到着判定は待たずに行う
    }
  }
}

TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(
  LOCATION_TASK,
  async ({ data, error }) => {
    if (error) return;
    const locations = data?.locations;
    if (!locations || locations.length === 0) return;
    const last = locations[locations.length - 1];
    await processLocationSample(
      { latitude: last.coords.latitude, longitude: last.coords.longitude },
      last.coords.speed,
      last.coords.accuracy,
    );
  }
);

// ───────────────────────────────────────────────────────────
// 危険エリア（人気のない場所への進入）検知
// ───────────────────────────────────────────────────────────
//
// 判定の状態は AsyncStorage（AREA_KEY）に持つ。headless の bg タスクはティックごとに
// 状態を持たないため、停滞（STALL_KEY）と同じやり方で受け渡す。
// 前面 UI（useSentinel）には同一プロセス内のリスナーで知らせる。bg タスクは同じ JS
// ランタイムで動くので、前面にいるあいだはこのリスナーが CheckOverlay を出す。

type AreaListener = (event: Exclude<AreaEvent, null>) => void;
const areaListeners = new Set<AreaListener>();

// 前面 UI が検知イベントを購読する（解除関数を返す）
export function subscribeAreaEvents(listener: AreaListener): () => void {
  areaListeners.add(listener);
  return () => { areaListeners.delete(listener); };
}

function emitArea(event: Exclude<AreaEvent, null>): void {
  areaListeners.forEach((l) => { try { l(event); } catch {} });
}

async function readAreaState(): Promise<AreaState> {
  try {
    const raw = await AsyncStorage.getItem(AREA_KEY);
    return raw ? { ...INITIAL_AREA_STATE, ...(JSON.parse(raw) as Partial<AreaState>) } : INITIAL_AREA_STATE;
  } catch {
    return INITIAL_AREA_STATE;
  }
}

async function writeAreaState(state: AreaState): Promise<void> {
  await AsyncStorage.setItem(AREA_KEY, JSON.stringify(state));
}

async function detectArea(active: ActiveWalk, coord: Coord, accuracy: number | null | undefined): Promise<void> {
  // 「休憩中」は停滞と同じく判定しない（前面の本人確認も休憩中は出さないため、揃える）
  if (active.restingUntil && Date.now() < active.restingUntil) return;

  const index = await loadDangerAreaIndex(); // 同梱データが無い・壊れている → null → 判定しない
  const reading = readArea(index, { ...coord, accuracy }, active.home);
  const prev = await readAreaState();
  const { state, event } = stepArea(prev, reading, Date.now(), active.sensitivity ?? 'medium');
  if (state !== prev) await writeAreaState(state);
  if (!event) return;

  if (event === 'local_check') {
    // まず本人へ。見守りへはまだ知らせない（確定原則: 二段階確認）
    await notify(
      'だいじょうぶ？🌙',
      'みちの ない ところに はいったみたい。アプリをひらいて おしえてね。',
      'alert',
      { type: 'local_check', sessionId: active.sessionId },
    );
  } else if (event === 'escalate') {
    // 無応答 → 見守りへ（status='anomaly' への変更で Cloud Function が FCM 送信）。
    // active のときだけ（arrived/sos 等を上書きしない）
    try {
      const ref = doc(db, 'sessions', active.sessionId);
      const snap = await getDoc(ref);
      if (snap.exists() && snap.data()?.status === 'active') {
        await updateDoc(ref, {
          status: 'anomaly',
          anomaly: { type: 'area', detectedAt: serverTimestamp() },
          safetyCheck: null,
        });
      }
    } catch {}
  }
  emitArea(event);
}

// 本人が「ここは だいじょうぶ」と答えた（前面の CheckOverlay から）。
// その滞在が終わる（人気のある場所に戻る）まで再発火しない。
export async function acknowledgeAreaDetection(): Promise<void> {
  const prev = await readAreaState();
  await writeAreaState(acknowledgeArea(prev));
}

// 前面が本人確認の無応答で見守りへエスカレートしたことを bg 側へ共有（二重通知防止）
export async function markAreaEscalated(): Promise<void> {
  const prev = await readAreaState();
  if (prev.stage !== 2) await writeAreaState({ ...prev, stage: 2 });
}

// センチネル：位置停滞を検知し、本人確認通知 →（無応答で）見守りへエスカレーション。
// 静止中はロケーション更新が届かない端末もあるため、前面の useSentinel が主・本関数は補助。
async function detectStall(active: ActiveWalk, coord: Coord, speed: number | null | undefined): Promise<void> {
  // 「休憩中」（期限つき・自動再開）は検知しない
  if (active.restingUntil && Date.now() < active.restingUntil) {
    await AsyncStorage.multiRemove([STALL_KEY, STALL_STAGE_KEY]);
    return;
  }
  const now = Date.now();

  // 乗り物相当の速度が出ていれば「移動中」とみなす（駅・信号での停止を停滞と誤検知しない）。
  // ただし徒歩宣言（transport='walk'）では乗り物にいるはずがなく、
  // 乗り物速度は detectMove 側が異常として扱うため、この抑制は適用しない。
  const inVehicle = active.transport !== 'walk'
    && typeof speed === 'number' && speed >= VEHICLE_SPEED_MPS;

  const raw = await AsyncStorage.getItem(STALL_KEY);
  const prev = raw ? (JSON.parse(raw) as { lastMovedAt: number; lat: number; lng: number }) : null;
  if (!prev) {
    await AsyncStorage.setItem(STALL_KEY, JSON.stringify({ lastMovedAt: now, lat: coord.latitude, lng: coord.longitude }));
    return;
  }

  const moved = inVehicle
    || distanceMeters({ latitude: prev.lat, longitude: prev.lng }, coord) > STALL_RADIUS_M;
  if (moved) {
    await AsyncStorage.setItem(STALL_KEY, JSON.stringify({ lastMovedAt: now, lat: coord.latitude, lng: coord.longitude }));
    await AsyncStorage.removeItem(STALL_STAGE_KEY);
    return;
  }

  const { stallSeconds, bgEscalateSeconds } = sentinelParams(active.sensitivity ?? 'medium');
  const stalledSec = (now - prev.lastMovedAt) / 1000;
  const stageRaw = await AsyncStorage.getItem(STALL_STAGE_KEY);
  const stage = stageRaw ? Number(stageRaw) : 0;

  if (stalledSec >= bgEscalateSeconds && stage < 2) {
    // 現在 active のときだけ見守りへエスカレーション（arrived/sos 等を上書きしない）
    try {
      const ref = doc(db, 'sessions', active.sessionId);
      const snap = await getDoc(ref);
      if (snap.exists() && snap.data()?.status === 'active') {
        await updateDoc(ref, {
          status: 'anomaly',
          anomaly: { type: 'stall', detectedAt: serverTimestamp() },
          safetyCheck: null, // 前回の安否確認の応答が残っていると「解決済み」に見えるためクリア
        });
      }
    } catch {}
    await AsyncStorage.setItem(STALL_STAGE_KEY, '2');
  } else if (stalledSec >= stallSeconds && stage < 1) {
    await notify('だいじょうぶ？🌙', 'うごきが とまっているみたい。アプリをひらいて おしえてね。', 'alert', { type: 'local_check', sessionId: active.sessionId });
    await AsyncStorage.setItem(STALL_STAGE_KEY, '1');
  }
}

// 移動異常（連れ去りの可能性）：徒歩のはずのセッションが乗り物速度で移動し続けたら、
// 停滞・転倒と違い時間が命なので「本人への確認」と「見守りへの通報」を同時に行う（二段同時）。
// 本人が乗り物から降りて歩行に戻れば自動で再武装される。
let slowStreak = 0; // 通知後、歩行速度のサンプルが続いた回数（再武装判定用）

async function detectMove(active: ActiveWalk, coord: Coord, speed: number | null | undefined): Promise<void> {
  const now = Date.now();
  const fast = typeof speed === 'number' && speed >= MOVE_SPEED_MPS;

  const notified = await AsyncStorage.getItem(MOVE_STAGE_KEY);
  if (notified) {
    // 通知済み。歩行速度に戻ったら（bg tick 2回連続 ≈ 40秒）再武装する。
    // 乗り続けている間は再通知しない（本人がOKしたのに鳴り続けるのを防ぐ）。
    slowStreak = fast ? 0 : slowStreak + 1;
    if (slowStreak >= 2) {
      slowStreak = 0;
      moveDetector.reset();
      await AsyncStorage.removeItem(MOVE_STAGE_KEY);
    }
    return;
  }
  slowStreak = 0;

  if (moveDetector.feed(speed, coord, now)) {
    await AsyncStorage.setItem(MOVE_STAGE_KEY, '1');
    // ① 本人へ（誤検知なら本人がアプリから解除できる）
    await notify('だいじょうぶ？🚗', 'のりものの はやさで うごいているみたい。アプリをひらいて おしえてね。', 'alert', { type: 'local_check', sessionId: active.sessionId });
    // ② 見守りへ（status='anomaly' への変更で Cloud Function がFCM送信）
    try {
      const ref = doc(db, 'sessions', active.sessionId);
      const snap = await getDoc(ref);
      if (snap.exists() && snap.data()?.status === 'active') {
        await updateDoc(ref, {
          status: 'anomaly',
          anomaly: { type: 'move', detectedAt: serverTimestamp() },
          safetyCheck: null,
        });
      }
    } catch {}
  }
}

// 歩行開始の結果。
// 'background'      = 「常に許可」。アプリを閉じていても見守りが続く（本来の姿）
// 'foreground-only' = 「使用中のみ許可」。アプリを開いている間だけ見守れる（降格運転）
// 'denied'          = 位置情報そのものが不許可。見守りは成立しない
// 'failed'          = 権限はあるが位置取得を開始できなかった
export type WalkStartResult = 'background' | 'foreground-only' | 'denied' | 'failed';

// 「使用中のみ許可」時の前面ウォッチ。startLocationUpdatesAsync はバックグラウンド
// 権限が必須なので、そちらが使えない場合にこの購読で位置共有を成立させる。
let foregroundSub: Location.LocationSubscription | null = null;

function watchOptions(mode: WatchMode): Location.LocationOptions {
  const isSentinel = mode === 'sentinel';
  return {
    accuracy: Location.Accuracy.Balanced,
    // センチネルは静止中でも届くよう時間ベース寄りにする（停滞検知のため）
    distanceInterval: isSentinel ? 0 : 10,
    timeInterval: isSentinel ? 20000 : 5000,
  };
}

async function startForegroundWatch(mode: WatchMode): Promise<boolean> {
  stopForegroundWatch();
  try {
    foregroundSub = await Location.watchPositionAsync(watchOptions(mode), (loc) => {
      processLocationSample(
        { latitude: loc.coords.latitude, longitude: loc.coords.longitude },
        loc.coords.speed,
        loc.coords.accuracy,
      ).catch(() => {});
    });
    return true;
  } catch (error) {
    console.warn('foreground location watch failed', error);
    return false;
  }
}

function stopForegroundWatch(): void {
  foregroundSub?.remove();
  foregroundSub = null;
}

async function clearWalkState(): Promise<void> {
  await AsyncStorage.multiRemove(WALK_STATE_KEYS);
}

// 歩行開始：位置共有を開始する。
// 「常に許可」ならバックグラウンドタスク、「使用中のみ許可」なら前面ウォッチで動かす。
// 前面のみでも歩行画面は useKeepAwake で点灯し続けるため、画面を開いたまま歩けば
// 位置共有・検知は機能する（アプリを閉じると止まり、見守り側には通信途絶として見える）。
export async function startBackgroundWalk(
  sessionId: string,
  home: Coord | null,
  mode: WatchMode = 'hold',
  sensitivity: SentinelSensitivity = 'medium',
  transport: TransportMode = 'vehicle_ok',
): Promise<WalkStartResult> {
  moveDetector.reset();
  routeThinner.reset();
  deniedStreak = 0;
  lastArrivalCheckAt = 0;
  stopForegroundWatch();
  await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify({ sessionId, home, mode, sensitivity, transport } satisfies ActiveWalk));
  await AsyncStorage.multiRemove(WALK_STATE_KEYS.filter((k) => k !== ACTIVE_KEY));

  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    await clearWalkState();
    return 'denied';
  }

  const bg = await Location.requestBackgroundPermissionsAsync().catch(() => null);
  if (bg?.status === 'granted') {
    const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
    if (already) return 'background';
    try {
      await Location.startLocationUpdatesAsync(LOCATION_TASK, {
        ...watchOptions(mode),
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        activityType: Location.ActivityType.Fitness,
        foregroundService: {
          notificationTitle: 'みまも 見守り中',
          notificationBody: '現在地を見守る人に共有しています',
          notificationColor: '#FFD60A',
        },
      });
      return 'background';
    } catch (error) {
      // 権限はあるのに開始できなかった場合も、前面ウォッチで見守りを成立させる
      console.warn('background location start failed', error);
    }
  }

  if (await startForegroundWatch(mode)) return 'foreground-only';

  await clearWalkState();
  return 'failed';
}

// 進行中の歩行セッションID（アプリ再起動時の復帰判定に使う）。
// 位置タスクは OS 側で生き続けるため、このキーが残っていれば「歩いている途中」である。
export async function getActiveWalkSessionId(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as ActiveWalk)?.sessionId ?? null;
  } catch {
    return null;
  }
}

// 到着までの自宅位置を後から更新（リスナーで遅れて届く場合があるため）
export async function updateActiveWalkHome(home: Coord | null): Promise<void> {
  const raw = await AsyncStorage.getItem(ACTIVE_KEY);
  if (!raw) return;
  const cur = JSON.parse(raw) as ActiveWalk;
  cur.home = home;
  await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify(cur));
}

// 「休憩中」の切替をバックグラウンドタスクへ反映（検知の一時停止）。
// 戻し忘れが危険なので期限つき（REST_AUTO_RESUME_MS 後に自動で検知再開）。
export async function setActiveWalkResting(resting: boolean): Promise<void> {
  const raw = await AsyncStorage.getItem(ACTIVE_KEY);
  if (!raw) return;
  const cur = JSON.parse(raw) as ActiveWalk;
  cur.restingUntil = resting ? Date.now() + REST_AUTO_RESUME_MS : undefined;
  await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify(cur));
  if (resting) await AsyncStorage.multiRemove([STALL_KEY, STALL_STAGE_KEY]);
}

// 停滞検知の内部状態をリセットする。
// 前面で本人が「だいじょうぶ」を押した（＝異常を解除した）とき、
// バックグラウンド側の停滞タイマーも巻き戻さないと、本人確認の後に
// bg タスクが古い停滞時刻でエスカレートしてしまう。
export async function resetStallState(): Promise<void> {
  await AsyncStorage.multiRemove([STALL_KEY, STALL_STAGE_KEY]);
}

// 前面の検知エンジンが通知/エスカレーションを行ったことを bg 側へ共有する
// （Android では bg タスクと前面 JS が並走するため、二重通知を防ぐ）。
export async function markStallStage(stage: 1 | 2): Promise<void> {
  await AsyncStorage.setItem(STALL_STAGE_KEY, String(stage));
}

// 前面が移動異常を通知済みであることを bg 側へ共有（二重通知防止）
export async function markMoveNotified(): Promise<void> {
  await AsyncStorage.setItem(MOVE_STAGE_KEY, '1');
}

// 歩行終了：位置更新（バックグラウンドタスク・前面ウォッチとも）を停止する
export async function stopBackgroundWalk(): Promise<void> {
  moveDetector.reset();
  routeThinner.reset();
  deniedStreak = 0;
  lastArrivalCheckAt = 0;
  stopForegroundWatch();
  await AsyncStorage.multiRemove(WALK_STATE_KEYS);
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => {});
}
