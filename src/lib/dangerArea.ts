// 危険エリアアラート（Phase 3・設計 design-v3-watcher-redesign §7.2）の純ロジック。
//
// 「道路も建物も無い所に居続けている」ことを、端末に同梱した道路/建物密度メッシュだけで
// 判定する。位置を外部に送らず、圏外の山奥でも動く（方式B・オンデバイス）。
// 検知できるのは「道から外れたこと」であって「危険」そのものではない（偽陰性を必ず含む）。
//
// このファイルは React Native / Firebase に依存しない（jest で検証する）。
// 同梱データの読み込みは dangerAreaData.ts、検知の実行は tasks/locationTask.ts と hooks/useSentinel.ts。

import { distanceMeters, LOCAL_CHECK_SECONDS, type SentinelSensitivity } from './sentinel';

type Coord = { latitude: number; longitude: number };

// ───────────────────────────────────────────────────────────
// メッシュ（JIS X 0410 地域メッシュ）
// ───────────────────────────────────────────────────────────
//
// 3次メッシュ（緯度30秒×経度45秒 ≈ 1km）を 4×4 に割った「1/4メッシュ」（≈250m）を最小単位にする。
// データは「3次メッシュコード → 16bit マスク（どの1/4メッシュに道路/建物があるか）」の
// ソート済み配列。日本全土でも 3次メッシュは 40万件弱なので、コード u32 + マスク u16 で数MBに収まる。

// 1/4メッシュのグリッド座標（緯度は 1/480 度、経度は 1/320 度の刻み）。
// 3次メッシュのグリッドは緯度 1/120 度・経度 1/80 度で、その 4 倍。
export type QuarterCell = { row: number; col: number };

export function quarterCellOf(coord: Coord): QuarterCell {
  return {
    row: Math.floor(coord.latitude * 480),
    col: Math.floor((coord.longitude - 100) * 320),
  };
}

// 1/4メッシュのグリッド座標 → 親の3次メッシュコード（8桁）と、その中での添字（0..15、南西が0）
export function meshOfQuarter(cell: QuarterCell): { code: number; sub: number } {
  const R = Math.floor(cell.row / 4); // 3次メッシュの緯度方向の通し番号（1/120度単位）
  const C = Math.floor(cell.col / 4); // 経度方向（1/80度単位、東経100度基準）
  const p = Math.floor(R / 80);       // 1次（緯度40分 = 80 × 30秒）
  const q = Math.floor((R % 80) / 10); // 2次（緯度5分 = 10 × 30秒）
  const r = R % 10;
  const u = Math.floor(C / 80);       // 1次（経度1度 = 80 × 45秒）
  const v = Math.floor((C % 80) / 10); // 2次（経度7.5分）
  const w = C % 10;
  const code = p * 1_000_000 + u * 10_000 + q * 1_000 + v * 100 + r * 10 + w;
  const sub = (cell.row - R * 4) * 4 + (cell.col - C * 4);
  return { code, sub };
}

// 座標 → 3次メッシュコード（テスト・抑制単位・データ生成側との突き合わせ用）
export function meshCodeOf(coord: Coord): number {
  return meshOfQuarter(quarterCellOf(coord)).code;
}

// 3次メッシュコード → 1次メッシュコード（4桁）。データの有無（カバレッジ）判定に使う。
export function primaryMeshOf(code: number): number {
  return Math.floor(code / 10_000);
}

// ───────────────────────────────────────────────────────────
// 同梱データ（バイナリ）の形式と索引
// ───────────────────────────────────────────────────────────
//
// レイアウト（リトルエンディアン）:
//   0..3   "MMDA"（magic）
//   4      version = 1
//   5..7   予約（0）
//   8..11  count (u32)
//   12..   codes  u32 × count（昇順）
//   ...    masks  u16 × count（codes と同じ並び。bit i = 添字 i の1/4メッシュに道路/建物あり）
//
// マスクが 0 のメッシュはデータに含めない（含めても無害だが容量の無駄）。
// 「データに無いメッシュ」＝「道路も建物も無い」。ただし1次メッシュ単位で1件も無ければ
// 「データ対象外（海外・未生成）」として機能を無効化する（primaryCovered）。

export const DANGER_AREA_MAGIC = 0x41444d4d; // "MMDA" を LE で読んだ値
export const DANGER_AREA_VERSION = 1;
const HEADER_BYTES = 12;

export class DangerAreaIndex {
  private constructor(
    private readonly codes: Uint32Array,
    private readonly masks: Uint16Array,
    private readonly primaries: Set<number>,
  ) {}

  get size(): number {
    return this.codes.length;
  }

  // コードとマスクの組から構築（テスト・生成スクリプト用）。codes は昇順であること。
  static fromEntries(entries: ReadonlyArray<readonly [code: number, mask: number]>): DangerAreaIndex {
    const codes = new Uint32Array(entries.length);
    const masks = new Uint16Array(entries.length);
    const primaries = new Set<number>();
    entries.forEach(([code, mask], i) => {
      if (i > 0 && code <= codes[i - 1]) throw new Error(`codes must be strictly ascending at ${i}`);
      codes[i] = code;
      masks[i] = mask;
      primaries.add(primaryMeshOf(code));
    });
    return new DangerAreaIndex(codes, masks, primaries);
  }

  static fromBinary(buffer: ArrayBuffer): DangerAreaIndex {
    const view = new DataView(buffer);
    if (buffer.byteLength < HEADER_BYTES) throw new Error('danger-area data: too short');
    if (view.getUint32(0, true) !== DANGER_AREA_MAGIC) throw new Error('danger-area data: bad magic');
    const version = view.getUint8(4);
    if (version !== DANGER_AREA_VERSION) throw new Error(`danger-area data: unsupported version ${version}`);
    const count = view.getUint32(8, true);
    const expected = HEADER_BYTES + count * 4 + count * 2;
    if (buffer.byteLength < expected) throw new Error('danger-area data: truncated');
    // 型付き配列はオフセットの整列が必要なので、境界が合わないときはコピーする
    const codes = new Uint32Array(count);
    const masks = new Uint16Array(count);
    const primaries = new Set<number>();
    let prev = -1;
    for (let i = 0; i < count; i++) {
      const code = view.getUint32(HEADER_BYTES + i * 4, true);
      if (code <= prev) throw new Error(`danger-area data: not sorted at ${i}`);
      prev = code;
      codes[i] = code;
      masks[i] = view.getUint16(HEADER_BYTES + count * 4 + i * 2, true);
      primaries.add(primaryMeshOf(code));
    }
    return new DangerAreaIndex(codes, masks, primaries);
  }

  // 生成スクリプトと共有する直列化。fromBinary の逆。
  static toBinary(entries: ReadonlyArray<readonly [code: number, mask: number]>): ArrayBuffer {
    const count = entries.length;
    const buf = new ArrayBuffer(HEADER_BYTES + count * 4 + count * 2);
    const view = new DataView(buf);
    view.setUint32(0, DANGER_AREA_MAGIC, true);
    view.setUint8(4, DANGER_AREA_VERSION);
    view.setUint32(8, count, true);
    entries.forEach(([code, mask], i) => {
      view.setUint32(HEADER_BYTES + i * 4, code, true);
      view.setUint16(HEADER_BYTES + count * 4 + i * 2, mask, true);
    });
    return buf;
  }

  // この座標を含む1次メッシュ（約80km四方）にデータが1件でもあるか。
  // 無ければ海外や未生成地域なので、判定は行わない（静かに無効化）。
  covers(coord: Coord): boolean {
    return this.primaries.has(primaryMeshOf(meshCodeOf(coord)));
  }

  private maskOf(code: number): number {
    // 二分探索（codes は昇順）
    let lo = 0;
    let hi = this.codes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const c = this.codes[mid];
      if (c === code) return this.masks[mid];
      if (c < code) lo = mid + 1;
      else hi = mid - 1;
    }
    return 0;
  }

  // この1/4メッシュに道路または建物があるか
  occupied(cell: QuarterCell): boolean {
    const { code, sub } = meshOfQuarter(cell);
    return (this.maskOf(code) & (1 << sub)) !== 0;
  }

  // 現在地の1/4メッシュと周囲8メッシュ（3×3 ≈ 750m四方）のうち、道路/建物のあるものの数（0..9）
  density(coord: Coord): number {
    const { row, col } = quarterCellOf(coord);
    let n = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (this.occupied({ row: row + dr, col: col + dc })) n++;
      }
    }
    return n;
  }
}

// ───────────────────────────────────────────────────────────
// 「人気のない場所」の判定
// ───────────────────────────────────────────────────────────

// 3×3 の1/4メッシュにこの数以下しか道路/建物が無ければ「人気のない場所」とみなす。
// 0 だと道路脇 250m の GPS 誤差で判定が揺れるため、隣接1マスまでは許容する。
export const REMOTE_MAX_OCCUPIED = 1;
// 自宅からこの距離以内は判定しない（自宅が郊外の一軒家でも鳴らさない）
export const HOME_EXCLUDE_M = 300;
// これより精度の悪い位置は判定に使わない（GPS 飛び対策。判定を進めも戻しもしない）
export const AREA_MAX_ACCURACY_M = 100;

export type AreaSample = Coord & { accuracy?: number | null };

// 判定可能な位置か（データ対象内・精度十分・自宅圏外）と、人気のない場所か。
// 'unknown' = 判定材料にならないサンプル（データ外・精度不良）。状態を進めも戻しもしない。
export type AreaReading = 'remote' | 'populated' | 'unknown';

export function readArea(
  index: DangerAreaIndex | null,
  sample: AreaSample,
  home: Coord | null,
): AreaReading {
  if (!index) return 'unknown';
  if (typeof sample.accuracy === 'number' && sample.accuracy > AREA_MAX_ACCURACY_M) return 'unknown';
  if (!index.covers(sample)) return 'unknown';
  if (home && distanceMeters(home, sample) <= HOME_EXCLUDE_M) return 'populated';
  return index.density(sample) <= REMOTE_MAX_OCCUPIED ? 'remote' : 'populated';
}

// ───────────────────────────────────────────────────────────
// 検知の状態機械（前面・バックグラウンド共用。状態は JSON 化できる純データ）
// ───────────────────────────────────────────────────────────
//
// 「人気のない場所に連続 N 分」で本人へローカル確認（stage 1）→ さらに LOCAL_CHECK_SECONDS
// 無応答なら見守りへエスカレーション（stage 2）。人気のある場所へ出れば途中でも取り下げる。
// 本人が「ここは だいじょうぶ」と答えたら、その滞在が終わる（人気のある場所に REARM_MS 居る）まで
// 再発火しない（suppressed）。瞬間の通過では鳴らないよう、連続滞在のみを数える。

export type AreaState = {
  remoteSince: number | null; // 人気のない場所に入った時刻（連続滞在の起点）
  lastRemoteAt: number;       // 直近で remote だった時刻（サンプル欠損の許容用）
  stage: 0 | 1 | 2;           // 0=未検知 / 1=本人確認中 / 2=見守りへ通知済み
  suppressed: boolean;        // 本人が「ここは だいじょうぶ」と答えた（滞在中は再発火しない）
  populatedSince: number | null; // suppressed 中、人気のある場所に居続けている起点（再武装判定）
};

export const INITIAL_AREA_STATE: AreaState = {
  remoteSince: null,
  lastRemoteAt: 0,
  stage: 0,
  suppressed: false,
  populatedSince: null,
};

// 感度 → 「人気のない場所」に何秒居たら本人確認するか（停滞と同じ low=鳴りにくい / high=敏感）
export function areaParams(sensitivity: SentinelSensitivity) {
  const dwellSeconds = sensitivity === 'low' ? 480 : sensitivity === 'high' ? 180 : 300;
  return {
    dwellSeconds,
    // バックグラウンドで見守りへ通知するまで（本人確認の猶予を含む）
    escalateSeconds: dwellSeconds + LOCAL_CHECK_SECONDS,
  };
}

// サンプル欠損（トンネル・GPS 途絶）をこの時間まで許容する。bg tick は 20 秒毎。
export const AREA_GRACE_MS = 90_000;
// 抑制中、人気のある場所にこれだけ居たら「その滞在は終わった」とみなし再武装する
export const AREA_REARM_MS = 120_000;

export type AreaEvent =
  | 'local_check'   // stage 0→1: 本人へ「山の方に入ったみたい。だいじょうぶ？」
  | 'escalate'      // stage 1→2: 無応答 → 見守りへ通知
  | 'cleared'       // stage 1→0: 人気のある場所へ出た（本人確認を取り下げ）
  | 'rearmed'       // suppressed → 通常（滞在が終わった）
  | null;

// 位置サンプル1件で状態を進める。副作用なし。
export function stepArea(
  state: AreaState,
  reading: AreaReading,
  t: number,
  sensitivity: SentinelSensitivity,
): { state: AreaState; event: AreaEvent } {
  if (reading === 'unknown') return { state, event: null };

  if (state.suppressed) {
    if (reading === 'remote') {
      return { state: { ...state, populatedSince: null, lastRemoteAt: t }, event: null };
    }
    const since = state.populatedSince ?? t;
    if (t - since >= AREA_REARM_MS) {
      return { state: { ...INITIAL_AREA_STATE }, event: 'rearmed' };
    }
    return { state: { ...state, populatedSince: since }, event: null };
  }

  if (reading === 'populated') {
    // 人気のある場所へ出た。本人確認中なら取り下げる。通知済み（stage 2）は見守り側の
    // 安否確認フローに委ねるので、ここでは戻さない（本人が解除する）。
    if (state.stage === 2) return { state, event: null };
    // 何も始まっていなければ同じ状態を返す（bg タスクがティックごとに書き込まないため）
    if (state.stage === 0 && state.remoteSince == null) return { state, event: null };
    const event: AreaEvent = state.stage === 1 ? 'cleared' : null;
    return { state: { ...INITIAL_AREA_STATE }, event };
  }

  // reading === 'remote'
  let remoteSince = state.remoteSince;
  if (remoteSince == null || t - state.lastRemoteAt > AREA_GRACE_MS) {
    // 初回、または欠損が長すぎた → 仕切り直し（stage は維持: 通知済みを繰り返さない）
    remoteSince = t;
    if (state.stage === 0) {
      return { state: { ...state, remoteSince, lastRemoteAt: t }, event: null };
    }
  }
  const next: AreaState = { ...state, remoteSince, lastRemoteAt: t };
  const { dwellSeconds, escalateSeconds } = areaParams(sensitivity);
  const dwellSec = (t - remoteSince) / 1000;

  if (state.stage === 0 && dwellSec >= dwellSeconds) {
    return { state: { ...next, stage: 1 }, event: 'local_check' };
  }
  if (state.stage === 1 && dwellSec >= escalateSeconds) {
    return { state: { ...next, stage: 2 }, event: 'escalate' };
  }
  return { state: next, event: null };
}

// 本人が「ここは だいじょうぶ」と答えた（前面の CheckOverlay / 通知経由）。
// その滞在中は再発火しない。
export function acknowledgeArea(state: AreaState): AreaState {
  return { ...INITIAL_AREA_STATE, suppressed: true, lastRemoteAt: state.lastRemoteAt };
}

// 武装条件。乗り物ありのセッションは郊外を高速通過するため誤報源になるので既定オフ
// （'move' 検知と同じ整理。設計 §7.2「誤検知対策」）。
export function isAreaArmed(transport: 'walk' | 'vehicle_ok' | undefined): boolean {
  return transport === 'walk';
}
