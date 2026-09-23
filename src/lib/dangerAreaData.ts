// 同梱の道路/建物密度メッシュ（assets/data/danger-area-jp.bin）を読み込む。
// 生成は scripts/danger-area/（OSM から。README 参照）。データはアプリ更新に同梱し、
// 配信基盤は作らない（設計 §7.2「鮮度の割り切り」）。
//
// 読み込みに失敗したら null を返し、判定側（readArea）は 'unknown' として静かに無効化する。
// 位置を外部に送らないための同梱方式なので、ここでネットワークには出ない。

import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { DangerAreaIndex } from './dangerArea';

let cached: Promise<DangerAreaIndex | null> | null = null;

export function loadDangerAreaIndex(): Promise<DangerAreaIndex | null> {
  if (!cached) {
    cached = load().catch((e) => {
      // 一度失敗したら同じプロセスでは再試行しない（ティックごとに失敗し続けるのを避ける）
      console.warn('danger-area data unavailable', e);
      return null;
    });
  }
  return cached;
}

async function load(): Promise<DangerAreaIndex> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const asset = Asset.fromModule(require('../../assets/data/danger-area-jp.bin'));
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error('danger-area data: no localUri');
  const bytes = await new File(asset.localUri).bytes();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return DangerAreaIndex.fromBinary(buffer);
}

// テスト・開発用: 読み込み結果を差し替える（シミュレータで判定を試すとき）
export function __setDangerAreaIndexForTesting(index: DangerAreaIndex | null): void {
  cached = Promise.resolve(index);
}
