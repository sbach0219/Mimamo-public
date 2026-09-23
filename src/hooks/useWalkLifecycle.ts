import { useEffect, useRef, useState } from 'react';
import * as Battery from 'expo-battery';
import { haptics } from '../lib/haptics';
import { useSession } from '../store/sessionStore';
import { endedReasonFor, type SessionEndedReason } from '../components/SessionEndedOverlay';
import { noticeWalkStart } from '../lib/walkStartNotice';
import {
  startBackgroundWalk, stopBackgroundWalk, updateActiveWalkHome, type WalkStartResult,
} from '../tasks/locationTask';

// 両モード（ホールド / センチネル）の歩行画面で共通の土台。
// - セッション購読の開始/解放
// - バックグラウンド位置共有の開始/停止
// - ハートビート（30秒）とバッテリー報告（60秒）
// - 自宅位置の遅延反映
// - 到着検知（status === 'arrived'）→ お祝いオーバーレイ表示フラグ
//
// 注: ホールドモードの既存 MainScreen は出荷済みのため本フックを使わず現状維持。
// 本フックは新規のセンチネル画面で使用し、将来のリファクタで MainScreen も統合予定。
// **同じ終端処理（arrived / ended / cancelled）が MainScreen.tsx にも実装されている**
// （2026-08 アーキ点検 A-3）。どちらかを直したらもう一方も直すこと。統合は F-1 として
// 未着手（出荷済みのデッドマン挙動を実機検証なしに置き換えないための保留）。
// onLocationBlocked: 位置共有がまったく成立しなかった（denied / failed）ときに
// 歩行画面から出すための出口。画面側から渡す（H-2）。
export function useWalkLifecycle(onLocationBlocked?: () => void) {
  const session = useSession();
  // マウント時の1回きりの effect から呼ぶので、最新の関数を ref 経由で見る
  const onLocationBlockedRef = useRef(onLocationBlocked);
  onLocationBlockedRef.current = onLocationBlocked;
  const [showArrival, setShowArrival] = useState(false);
  // 相手側・サーバー側で終わったセッション（ended / cancelled）の表示
  const [endedReason, setEndedReason] = useState<SessionEndedReason | null>(null);
  // 位置共有が「常に許可」か「使用中のみ」かを画面に伝える（降格運転の可視化）
  const [walkStart, setWalkStart] = useState<WalkStartResult | null>(null);

  // マウント時：購読・位置共有・各種定期送信を開始
  useEffect(() => {
    session.listenToSession();

    const sessionId = useSession.getState().sessionId;
    if (sessionId) {
      const s = useSession.getState();
      startBackgroundWalk(sessionId, s.homeLocation, s.mode, s.sentinelSensitivity, s.transport)
        .then((result) => {
          setWalkStart(result);
          // 結果をセッション文書にも残す（H-2）。見守り側はこれを見て
          // 「位置が届いていません」を出す。
          useSession.getState().reportLocationMode(result);
          const blocked = result === 'denied' || result === 'failed';
          noticeWalkStart(result, blocked ? () => onLocationBlockedRef.current?.() : undefined);
        });
    }

    const heartbeat = setInterval(() => session.updateHeartbeat(), 30_000);
    session.updateHeartbeat();

    const reportBattery = async () => {
      const level = await Battery.getBatteryLevelAsync();
      const state = await Battery.getBatteryStateAsync();
      const stateStr =
        state === Battery.BatteryState.CHARGING ? 'charging'
        : state === Battery.BatteryState.FULL ? 'full'
        : state === Battery.BatteryState.UNPLUGGED ? 'unplugged' : 'unknown';
      if (level >= 0) session.updateBattery(level, stateStr);
    };
    reportBattery();
    const batteryTimer = setInterval(reportBattery, 60_000);

    return () => {
      clearInterval(heartbeat);
      clearInterval(batteryTimer);
      stopBackgroundWalk();
      const s = useSession.getState();
      s.stopConnectionMonitoring();
      s.stopListening();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自宅位置はリスナーで遅れて届くことがあるので、変化したらタスクへ反映
  useEffect(() => {
    updateActiveWalkHome(session.homeLocation);
  }, [session.homeLocation]);

  // バックグラウンドタスクが到着を検知したら、お祝いオーバーレイを出す
  useEffect(() => {
    if (session.status === 'arrived' && !showArrival) {
      haptics.success();
      setShowArrival(true);
      stopBackgroundWalk();
    }
    // 相手側やサーバー（期限切れの自動終了）でセッションが終わったら、位置共有を
    // 止めるだけでなく歩く人にもそう伝える。黙って止めると「見守られているつもり」
    // のまま歩き続けることになる。
    if (session.status === 'ended' || session.status === 'cancelled') {
      stopBackgroundWalk();
      setEndedReason((prev) => prev ?? endedReasonFor(session.status, session.endedBy));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.status]);

  return {
    showArrival,
    setShowArrival,
    endedReason,
    walkStart,
    foregroundOnly: walkStart === 'foreground-only',
  };
}
