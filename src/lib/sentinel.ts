// AIセンチネル（異常検知）の共通定義。
// Phase 1: 位置停滞 / Phase 2: 転倒（加速度・前面中心）＋乗り物フィルタ
// Phase 2.5: 転倒検知の3段化（自由落下→衝撃→静止）・感度設定・休憩の自動再開

export type SentinelSensitivity = 'low' | 'medium' | 'high';

// UI表示用の感度ラベル
export const SENSITIVITY_LABEL: Record<SentinelSensitivity, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

// 異常の種類。'stall'=停滞 / 'fall'=転倒（前面加速度）/ 'move'=移動異常（連れ去り検知）/
// 'area'=人気のない場所への進入（道路/建物の無いメッシュに連続滞在。lib/dangerArea.ts）。
export type AnomalyType = 'stall' | 'fall' | 'move' | 'area';

export const ANOMALY_TYPES: readonly AnomalyType[] = ['stall', 'fall', 'move', 'area'];

// Firestore から読んだ値を AnomalyType に絞る（未知の値は null）
export function parseAnomalyType(v: unknown): AnomalyType | null {
  return typeof v === 'string' && (ANOMALY_TYPES as readonly string[]).includes(v) ? (v as AnomalyType) : null;
}

// 移動手段の宣言（見守り側が設定時に選ぶ）。
// 'walk'=徒歩だけの予定 → 乗り物速度での移動を「移動異常（連れ去りの可能性）」として検知する。
// 'vehicle_ok'=乗り物もあり（既定・従来挙動）→ 乗り物速度は誤検知抑制に使う。
export type TransportMode = 'walk' | 'vehicle_ok';

// この範囲内の移動は「動いていない」とみなす（GPS誤差を吸収）
export const STALL_RADIUS_M = 30;
// 本人への「大丈夫?」の猶予。無応答ならこの後に見守りへエスカレーション
export const LOCAL_CHECK_SECONDS = 60;
// 見守りの「安否確認」への応答猶予（UI表示用）
export const SAFETY_CHECK_SECONDS = 120;

// 感度 → 停滞しきい値のマッピング（低=鳴りにくい / 高=敏感）。
// LOCAL_CHECK_SECONDS（本人確認の猶予）は全感度で共通。
export function sentinelParams(sensitivity: SentinelSensitivity) {
  const stallSeconds = sensitivity === 'low' ? 300 : sensitivity === 'high' ? 120 : 180;
  return {
    stallSeconds,
    // バックグラウンドで見守りへ通知するまでの停滞秒数（本人確認の猶予を含む）
    bgEscalateSeconds: stallSeconds + LOCAL_CHECK_SECONDS,
  };
}

// 既定（medium）の値。感度未指定の旧セッションとの互換用。
export const STALL_SECONDS = sentinelParams('medium').stallSeconds;
export const BG_ESCALATE_SECONDS = sentinelParams('medium').bgEscalateSeconds;

// 「休憩中」は戻し忘れが危険なので、この時間で自動的に見守りへ復帰する
export const REST_AUTO_RESUME_MINUTES = 30;
export const REST_AUTO_RESUME_MS = REST_AUTO_RESUME_MINUTES * 60_000;

type Coord = { latitude: number; longitude: number };

// 2点間の距離（メートル, haversine）
export function distanceMeters(a: Coord, b: Coord): number {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ───────────────────────────────────────────────────────────
// 転倒検知（前面・加速度）と 活動種別フィルタ（誤検知対策）
// ───────────────────────────────────────────────────────────

// expo-sensors の加速度は g 単位（静止時の合成 magnitude ≈ 1.0）。
export const ACCEL_UPDATE_MS = 50;           // 加速度サンプリング間隔（20Hz）

// 転倒パターン：自由落下 →（1秒以内に）衝撃 → 静止、が基本形。
// 自由落下を伴わない場合（つまずいて手をつく等）は、より強い衝撃のみ採用して
// 「ベンチに勢いよく座った」程度の日常動作を拾わないようにする。
export const FREEFALL_G = 0.45;              // 合成加速度がこれ以下なら「落下中」
export const FREEFALL_MS = 120;              // 自由落下がこれだけ続けば成立
export const FREEFALL_IMPACT_WINDOW_MS = 1000; // 自由落下終了→衝撃までの猶予
export const FALL_IMPACT_G = 2.2;            // 自由落下後に認める衝撃しきい値
export const FALL_IMPACT_HARD_G = 3.2;       // 自由落下なしで単独採用する強い衝撃
export const FALL_STILL_TOL_G = 0.18;        // |mag-1| がこの範囲なら「静止（倒れたまま）」
export const FALL_STILL_MS = 3000;           // 衝撃後 これだけ静止が続けば転倒確定
export const FALL_SETTLE_WINDOW_MS = 6000;   // 衝撃からこの時間内に静止へ入らなければ誤検知として破棄

// 活動種別フィルタ：GPS速度から「乗り物」を推定し、停滞/転倒の判定を一時停止する。
// （信号待ちで止まる車・電車を異常と誤検知しないため。専用の活動認識モジュールは使わず速度で代替）
export const VEHICLE_SPEED_MPS = 4.2;        // ≈15km/h 以上は徒歩でなく乗り物とみなす
export const VEHICLE_SUPPRESS_MS = 60000;    // 乗り物を検知してからこの時間は判定を抑制

// 加速度3軸の合成（重力込み。静止時は ≈1.0g）
export function accelMagnitude(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

// ───────────────────────────────────────────────────────────
// 移動異常（連れ去り）検知 — transport='walk' のセッションのみ武装
// ───────────────────────────────────────────────────────────

// 「徒歩のはずが乗り物の速さで運ばれている」ことの判定しきい値。
// 持続時間＋実変位の両方を要求するのは、GPSマルチパスの瞬間的な速度スパイクと、
// 子どもの短距離ダッシュ（20km/h は出るが続かない・進まない）を弾くため。
export const MOVE_SPEED_MPS = 5.6;             // ≈20km/h 以上を「乗り物の速さ」とみなす
export const MOVE_SUSTAIN_MS = 45_000;         // これだけ継続したら成立
export const MOVE_MIN_DISPLACEMENT_M = 300;    // かつ実際にこれだけ移動していること
export const MOVE_GRACE_MS = 30_000;           // GPSサンプル欠損をこの時間まで許容（bg tickは20秒毎）

type MoveCoord = { latitude: number; longitude: number };

// 移動異常の状態機械（純ロジック・副作用なし＝テスト可能）。
// feed(speedMps, pos, tMs) を位置更新ごとに呼び、
// 「乗り物速度が MOVE_SUSTAIN_MS 継続 かつ 開始地点から MOVE_MIN_DISPLACEMENT_M 以上移動」
// が成立した瞬間に true を返す。速度が MOVE_GRACE_MS を超えて途切れたら仕切り直す。
export class MoveAnomalyDetector {
  private startAt: number | null = null;   // 高速移動の開始時刻
  private startPos: MoveCoord | null = null;
  private lastFastAt = 0;                  // 直近で高速だった時刻（欠損許容用）

  reset(): void {
    this.startAt = null;
    this.startPos = null;
    this.lastFastAt = 0;
  }

  feed(speed: number | null | undefined, pos: MoveCoord, t: number): boolean {
    const fast = typeof speed === 'number' && speed >= MOVE_SPEED_MPS;

    if (!fast) {
      // 一時的な欠損（トンネル・GPS飛び）は grace 内なら開始時刻を保持。
      // それを超えて途切れたら「乗り物をやめた」とみなし仕切り直す。
      if (this.startAt != null && t - this.lastFastAt > MOVE_GRACE_MS) this.reset();
      return false;
    }

    this.lastFastAt = t;
    if (this.startAt == null || this.startPos == null) {
      this.startAt = t;
      this.startPos = pos;
      return false;
    }

    // 成立判定は「いま高速で移動しているサンプル」でのみ行う
    // （grace 窓の間にタイマーだけ伸びて成立するのを防ぐ）
    if (
      t - this.startAt >= MOVE_SUSTAIN_MS &&
      distanceMeters(this.startPos, pos) >= MOVE_MIN_DISPLACEMENT_M
    ) {
      this.reset();
      return true;
    }
    return false;
  }
}

// 転倒パターンの状態機械（純ロジック・副作用なし＝テスト可能）。
// 加速度の合成値 mag を時系列で feed(mag, tMs) し、
// 「(自由落下→)衝撃 → 一定時間の静止」が成立した瞬間に true を返す。
// 誤検知は前面の本人確認（だいじょうぶ？）で吸収する前提（設計 §5.4）。
export class FallDetector {
  private freefallStart: number | null = null; // 進行中の自由落下の開始時刻
  private freefallUntil = 0;                   // 自由落下成立後、衝撃を認める期限
  private impactAt: number | null = null;      // 直近の衝撃時刻
  private stillStart: number | null = null;    // 連続した静止の開始時刻

  reset(): void {
    this.freefallStart = null;
    this.freefallUntil = 0;
    this.impactAt = null;
    this.stillStart = null;
  }

  feed(mag: number, t: number): boolean {
    // 自由落下の追跡（衝撃前のみ意味を持つ）
    if (mag <= FREEFALL_G) {
      if (this.freefallStart == null) this.freefallStart = t;
      if (t - this.freefallStart >= FREEFALL_MS) {
        this.freefallUntil = t + FREEFALL_IMPACT_WINDOW_MS;
      }
    } else {
      this.freefallStart = null;
    }

    // 衝撃：自由落下直後なら 2.2g、単独なら 3.2g 以上を「転倒の衝撃」とみなす
    const threshold = t <= this.freefallUntil ? FALL_IMPACT_G : FALL_IMPACT_HARD_G;
    if (mag >= threshold) {
      this.impactAt = t;
      this.stillStart = null; // 衝撃直後はまだ動いているので静止タイマーをリセット
      return false;
    }
    if (this.impactAt == null) return false;

    // 衝撃から一定時間 静止へ入らなければ「ぶつけただけ」等として破棄
    if (t - this.impactAt > FALL_SETTLE_WINDOW_MS) {
      this.reset();
      return false;
    }

    const still = Math.abs(mag - 1) <= FALL_STILL_TOL_G;
    if (!still) {
      this.stillStart = null; // まだ動いている（起き上がった・歩き続けている）
      return false;
    }
    if (this.stillStart == null) this.stillStart = t;
    if (t - this.stillStart >= FALL_STILL_MS) {
      this.reset();
      return true; // 衝撃 → 静止が継続 → 転倒成立
    }
    return false;
  }
}
