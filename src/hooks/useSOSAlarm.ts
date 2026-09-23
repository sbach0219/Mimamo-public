import { useEffect, useState } from 'react';
import { startSOSAlarm, stopSOSAlarm } from '../lib/alarm';

// SOS中のアラーム制御（歩く側の画面で使う）。
// shouldSound = 「SOS発信中 かつ 音ありモード」。
// 「音だけ止める（SOSは続ける）」ためのローカルミュートを持つ。
// 周囲への周知が済んだあと音を止めたい、というケースに対応する。
export function useSOSAlarm(shouldSound: boolean) {
  const [muted, setMuted] = useState(false);

  // SOSが終わった（とりけし・解決）らミュートを解除して次回に備える
  useEffect(() => {
    if (!shouldSound) setMuted(false);
  }, [shouldSound]);

  useEffect(() => {
    if (shouldSound && !muted) {
      startSOSAlarm();
      return () => stopSOSAlarm();
    }
    return undefined;
  }, [shouldSound, muted]);

  return {
    alarmSounding: shouldSound && !muted,
    muteAlarm: () => setMuted(true),
  };
}
