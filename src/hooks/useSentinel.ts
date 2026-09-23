import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import { Accelerometer } from 'expo-sensors';
import { haptics } from '../lib/haptics';
import { notify } from '../lib/notifications';
import { useSession } from '../store/sessionStore';
import {
  resetStallState, markStallStage, markMoveNotified,
  subscribeAreaEvents, acknowledgeAreaDetection, markAreaEscalated,
} from '../tasks/locationTask';
import {
  STALL_RADIUS_M, LOCAL_CHECK_SECONDS, distanceMeters, sentinelParams,
  ACCEL_UPDATE_MS, VEHICLE_SPEED_MPS, VEHICLE_SUPPRESS_MS,
  accelMagnitude, FallDetector, MoveAnomalyDetector,
  type AnomalyType, type SentinelSensitivity, type TransportMode,
} from '../lib/sentinel';

// AIセンチネルの前面検知エンジン。
// Phase 1：位置停滞。Phase 2：加速度による転倒（前面中心）＋ 乗り物フィルタ。
// 流れ: 異常検知 → 本人へ「大丈夫?」(localCheck) → 無応答(LOCAL_CHECK_SECONDS) で見守りへ通知。
// 本人が動く / 「だいじょうぶ」を押すと解除（見守りへは通知しない）。
//
// resting=true（休憩中）や status!=='active' の間は検知を止める。
// sensitivity は見守り側がセッション作成時に選んだ感度（停滞しきい値に反映）。
// transport='walk'（徒歩宣言）なら乗り物速度を「移動異常＝連れ去りの可能性」として検知し、
// 乗り物による誤検知抑制は無効化する。
export function useSentinel(
  resting: boolean,
  sensitivity: SentinelSensitivity = 'medium',
  transport: TransportMode = 'vehicle_ok',
) {
  const [localCheck, setLocalCheck] = useState(false);
  const [remaining, setRemaining] = useState(LOCAL_CHECK_SECONDS);
  // いま出している本人確認が「停滞」か「転倒」か（オーバーレイ文言・エスカレーションの種別に使う）
  const [localCheckReason, setLocalCheckReason] = useState<AnomalyType | null>(null);

  const lastMovedRef = useRef(Date.now());
  const lastPosRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const checkStartRef = useRef<number | null>(null);
  const reasonRef = useRef<AnomalyType | null>(null);
  const subRef = useRef<Location.LocationSubscription | null>(null);
  // resting/transport を最新値で参照するためのミラー（各コールバックはクロージャ固定のため）
  const restingRef = useRef(resting);
  const transportRef = useRef(transport);
  // 直近で「乗り物」とみなした時刻（活動種別フィルタ）。0=未検知。
  const lastVehicleRef = useRef(0);
  // 転倒パターン検出器（前面のみ）
  const fallRef = useRef(new FallDetector());
  // 移動異常（連れ去り）検出器（transport='walk' のみ稼働）
  const moveRef = useRef(new MoveAnomalyDetector());
  const accelSubRef = useRef<{ remove: () => void } | null>(null);

  useEffect(() => { restingRef.current = resting; }, [resting]);
  useEffect(() => { transportRef.current = transport; }, [transport]);

  // 本人確認の開始（停滞・転倒・人気のない場所で共用）
  const startLocalCheck = (reason: AnomalyType) => {
    checkStartRef.current = Date.now();
    reasonRef.current = reason;
    setLocalCheckReason(reason);
    setLocalCheck(true);
    setRemaining(LOCAL_CHECK_SECONDS);
    haptics.warning();
    // 'area' は判定も通知も locationTask 側で済んでいる（ここはオーバーレイを出すだけ）
    if (reason === 'area') return;
    // bg タスクへ「本人確認は通知済み」を共有（Android での二重通知防止）
    markStallStage(1).catch(() => {});
    // 前面でも音・バナーで気づかせる（画面を見ていない高齢者向け）。
    // バックグラウンドならこの通知が唯一の合図になる。
    const sessionId = useSession.getState().sessionId ?? undefined;
    if (reason === 'fall') {
      notify('だいじょうぶ？🌙', 'ころんだかもしれません。アプリをひらいて おしえてね。', 'alert', { type: 'local_check', sessionId });
    } else {
      notify('だいじょうぶ？🌙', 'うごきが とまっているみたい。アプリをひらいて おしえてね。', 'alert', { type: 'local_check', sessionId });
    }
  };

  const clearLocalCheck = () => {
    checkStartRef.current = null;
    reasonRef.current = null;
    setLocalCheck(false);
    setLocalCheckReason(null);
  };

  // 乗り物中か（活動種別フィルタ）
  const inVehicle = () => Date.now() - lastVehicleRef.current < VEHICLE_SUPPRESS_MS;

  // 位置の購読（前面）。動いたら停滞タイマーをリセット。速度から乗り物も推定。
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.status !== 'granted') {
          const req = await Location.requestForegroundPermissionsAsync();
          if (req.status !== 'granted') return;
        }
        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 5 },
          (loc) => {
            const spd = loc.coords.speed;
            const cur = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };

            if (transportRef.current === 'walk') {
              // 徒歩宣言：乗り物速度そのものが異常。成立したら「本人確認」と
              // 「見守りへの通報」を同時に行う（連れ去りは時間が命のため二段同時）
              if (
                !restingRef.current &&
                useSession.getState().status === 'active' &&
                moveRef.current.feed(spd, cur, Date.now())
              ) {
                markMoveNotified().catch(() => {}); // bg タスクとの二重通知防止
                haptics.warning();
                notify('だいじょうぶ？🚗', 'のりものの はやさで うごいているみたい。だいじょうぶなら アプリで おしえてね。', 'alert', { type: 'local_check', sessionId: useSession.getState().sessionId ?? undefined });
                useSession.getState().reportAnomaly('move');
              }
            } else if (typeof spd === 'number' && spd >= VEHICLE_SPEED_MPS) {
              // 乗り物あり：速度は誤検知抑制（停滞/転倒の判定停止）に使う
              lastVehicleRef.current = Date.now();
            }
            if (!lastPosRef.current) {
              lastPosRef.current = cur;
              lastMovedRef.current = Date.now();
              return;
            }
            if (distanceMeters(lastPosRef.current, cur) > STALL_RADIUS_M) {
              lastPosRef.current = cur;
              lastMovedRef.current = Date.now();
              // 動いた → 進行中の本人確認はキャンセル（見守りへは通知しない）。
              // ただし「人気のない場所」の確認は動いても消えない（山道を歩き続けている
              // 最中こそ聞きたい）。人気のある場所へ出れば locationTask が 'cleared' を送る。
              if (checkStartRef.current && reasonRef.current !== 'area') {
                clearLocalCheck();
                resetStallState().catch(() => {}); // bg 側の停滞タイマーも巻き戻す
              }
            }
          }
        );
        if (mounted) subRef.current = sub;
        else sub.remove();
      } catch {
        // 位置が使えない環境では検知を行わない（SOS等の手動操作は引き続き可能）
      }
    })();
    return () => {
      mounted = false;
      subRef.current?.remove();
      subRef.current = null;
    };
  }, []);

  // 加速度の購読（前面のみ・転倒検知）。背景は OS 制約が大きいため位置停滞に委ねる（設計 §5.5）。
  useEffect(() => {
    let mounted = true;
    let appStateSub: { remove: () => void } | null = null;

    const subscribe = async () => {
      if (accelSubRef.current) return;
      try {
        const available = await Accelerometer.isAvailableAsync();
        if (!available || !mounted) return;
      } catch {
        return; // シミュレータ等で加速度が無い場合は転倒検知を行わない
      }
      Accelerometer.setUpdateInterval(ACCEL_UPDATE_MS);
      fallRef.current.reset();
      accelSubRef.current = Accelerometer.addListener(({ x, y, z }) => {
        // 検知対象外の状態では蓄積をリセットして抜ける
        if (
          restingRef.current ||
          useSession.getState().status !== 'active' ||
          checkStartRef.current != null || // すでに本人確認中
          inVehicle()
        ) {
          fallRef.current.reset();
          return;
        }
        if (fallRef.current.feed(accelMagnitude(x, y, z), Date.now())) {
          startLocalCheck('fall');
        }
      });
    };

    const unsubscribe = () => {
      accelSubRef.current?.remove();
      accelSubRef.current = null;
      fallRef.current.reset();
    };

    // 前面のときだけ購読（背景では更新が来ず、電池も無駄になるため）
    if (AppState.currentState === 'active') subscribe();
    appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') subscribe();
      else unsubscribe();
    });

    return () => {
      mounted = false;
      appStateSub?.remove();
      unsubscribe();
    };
  }, []);

  // 人気のない場所への進入（Phase 3）。判定は locationTask（前面・背面共通）が行い、
  // ここはイベントに追従してオーバーレイを出す／引っ込めるだけ。
  useEffect(() => {
    return subscribeAreaEvents((event) => {
      const status = useSession.getState().status;
      if (event === 'local_check') {
        // 別の本人確認（停滞・転倒）が出ているならそちらを優先（同時に2枚は出さない）
        if (restingRef.current || status !== 'active' || checkStartRef.current != null) return;
        startLocalCheck('area');
      } else if (event === 'cleared' || event === 'escalate') {
        // 人気のある場所へ出た／bg が先に見守りへ知らせた → 前面の確認は畳む
        // （escalate 後は status が 'anomaly' になり、画面側が「見守りに知らせました」を出す）
        if (reasonRef.current === 'area') clearLocalCheck();
      }
    });
  }, []);

  // 1秒ごとの評価（停滞検知＋本人確認のカウントダウン）
  useEffect(() => {
    const { stallSeconds } = sentinelParams(sensitivity);
    const t = setInterval(() => {
      const status = useSession.getState().status;
      // 監視は status==='active' のときだけ。休憩中・異常中・到着後などは止める。
      if (resting || status !== 'active') {
        lastMovedRef.current = Date.now();
        fallRef.current.reset();
        if (checkStartRef.current) clearLocalCheck();
        return;
      }
      const now = Date.now();
      if (checkStartRef.current == null) {
        // 乗り物中は停滞とみなさない（信号待ち等の誤検知を抑制）
        if (inVehicle()) {
          lastMovedRef.current = now;
          return;
        }
        // 停滞検知
        const stalledSec = (now - lastMovedRef.current) / 1000;
        if (stalledSec >= stallSeconds) {
          startLocalCheck('stall');
        }
      } else {
        // 本人確認中：残り時間を更新し、0で見守りへエスカレーション
        const remain = Math.max(0, LOCAL_CHECK_SECONDS - Math.floor((now - checkStartRef.current) / 1000));
        setRemaining(remain);
        if (remain <= 0) {
          const reason = reasonRef.current ?? 'stall';
          clearLocalCheck();
          // bg 側でも「エスカレート済み」に（二重通知防止）
          if (reason === 'area') markAreaEscalated().catch(() => {});
          else markStallStage(2).catch(() => {});
          useSession.getState().reportAnomaly(reason);
        }
      }
    }, 1000);
    return () => clearInterval(t);
  }, [resting, sensitivity]);

  // 本人が「だいじょうぶ」を押したとき
  const resolveLocalCheck = () => {
    const reason = reasonRef.current;
    lastMovedRef.current = Date.now();
    fallRef.current.reset();
    clearLocalCheck();
    if (reason === 'area') {
      // 「ここは だいじょうぶ」→ その滞在が終わるまで再発火しない（設計 §7.2）
      acknowledgeAreaDetection().catch(() => {});
      return;
    }
    // bg タスクの停滞タイマーもリセット（放置すると本人確認後に bg がエスカレートしてしまう）
    resetStallState().catch(() => {});
  };

  return { localCheck, remaining, resolveLocalCheck, localCheckReason };
}
