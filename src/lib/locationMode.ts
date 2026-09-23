import type { WalkStartResult } from '../tasks/locationTask';

// 位置共有がいまどの強さで動いているか（品質・セキュリティ部 H-2）。
//
// startBackgroundWalk の結果はこれまで歩く人の画面のローカル state にしか入らず、
// 位置が1点も届かないまま heartbeat だけが届き続ける歩行が、見守り側には
// 「移動中・異常なし」に見えていた。安全アプリで最悪の「静かな失敗」なので、
// 結果をセッション文書に1語だけ残して見守り側にも同じ事実を見せる。
//
// 値を増やすときは firestore.rules の isValidLocationMode() も必ず一緒に直すこと
// （rules はビルド境界の外にあり、このファイルを import できない）。
export const LOCATION_MODES = ['background', 'foreground', 'none'] as const;

export type LocationMode = (typeof LOCATION_MODES)[number];

export function isLocationMode(value: unknown): value is LocationMode {
  return typeof value === 'string' && (LOCATION_MODES as readonly string[]).includes(value);
}

export function parseLocationMode(value: unknown): LocationMode | null {
  return isLocationMode(value) ? value : null;
}

// 歩行開始の結果を1語へ写す。'failed'（現在地が取れなかった）と 'denied'（拒否）は
// 見守り側から見れば同じ「位置が届かない」なので、区別せず 'none' にまとめる。
// 区別が要るのは歩く人の端末側の案内だけで、そちらは WalkStartResult をそのまま使う。
export function locationModeFor(result: WalkStartResult): LocationMode {
  if (result === 'background') return 'background';
  if (result === 'foreground-only') return 'foreground';
  return 'none';
}

// 位置が見守り側に届かない状態か。'foreground' は「アプリを開いているあいだは届く」
// ので、届いていない扱いにはしない（過大な警告は注意色の意味を薄める）。
export function isLocationMissing(mode: LocationMode | null): boolean {
  return mode === 'none';
}
