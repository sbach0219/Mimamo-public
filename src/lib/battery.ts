import * as Battery from 'expo-battery';

// 端末の電池残量。見守り側の SOS 画面・状態表示で「あとどれくらい連絡が取れるか」を
// 見積もるために使う（docs/design-v3-watcher-redesign §8）。
//
// 取得できないときは null を返す。見守り側は行ごと非表示にする約束なので、
// 「0%」や灰色のプレースホルダを作らないこと。
export type BatterySnapshot = { batteryLevel: number; batteryState: string };

export async function readBattery(): Promise<BatterySnapshot | null> {
  try {
    const level = await Battery.getBatteryLevelAsync();
    if (!(level >= 0)) return null; // シミュレータ等では -1 が返る
    const state = await Battery.getBatteryStateAsync();
    return { batteryLevel: level, batteryState: stateLabel(state) };
  } catch {
    return null;
  }
}

function stateLabel(state: Battery.BatteryState): string {
  if (state === Battery.BatteryState.CHARGING) return 'charging';
  if (state === Battery.BatteryState.FULL) return 'full';
  if (state === Battery.BatteryState.UNPLUGGED) return 'unplugged';
  return 'unknown';
}
