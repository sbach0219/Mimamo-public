import { useEffect } from 'react';
import { readBattery } from '../lib/battery';
import { useSession } from '../store/sessionStore';

// 歩く人の端末から電池残量を60秒ごとに送る（§8）。
// ホールド型（MainScreen）には元から入っていたが、センチネル歩行では届いておらず、
// 見守り側の SOS 画面で残量が出ないままだった。両画面から同じフックを使う。
//
// 送信間隔は既存の60秒のまま。新しいタイマーの粒度を増やさない。
const REPORT_INTERVAL_MS = 60_000;

export function useBatteryReport(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const report = async () => {
      const snapshot = await readBattery();
      if (cancelled || !snapshot) return;
      useSession.getState().updateBattery(snapshot.batteryLevel, snapshot.batteryState);
    };
    report();
    const timer = setInterval(report, REPORT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);
}
