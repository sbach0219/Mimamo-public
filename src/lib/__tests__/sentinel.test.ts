import {
  FallDetector,
  MoveAnomalyDetector,
  accelMagnitude,
  distanceMeters,
  sentinelParams,
  LOCAL_CHECK_SECONDS,
  FREEFALL_G,
  FALL_IMPACT_G,
  FALL_IMPACT_HARD_G,
  FALL_STILL_MS,
  ACCEL_UPDATE_MS,
  MOVE_SPEED_MPS,
  MOVE_SUSTAIN_MS,
} from '../sentinel';

describe('accelMagnitude', () => {
  it('静止時（重力のみ）は約1g', () => {
    expect(accelMagnitude(0, 0, 1)).toBeCloseTo(1);
    expect(accelMagnitude(0, 1, 0)).toBeCloseTo(1);
  });
  it('3軸の合成を返す', () => {
    expect(accelMagnitude(3, 4, 0)).toBeCloseTo(5);
  });
});

describe('distanceMeters', () => {
  it('同一点は0m', () => {
    const p = { latitude: 35.681236, longitude: 139.767125 };
    expect(distanceMeters(p, p)).toBe(0);
  });
  it('緯度0.001度は約111m', () => {
    const a = { latitude: 35.0, longitude: 139.0 };
    const b = { latitude: 35.001, longitude: 139.0 };
    const d = distanceMeters(a, b);
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });
});

describe('sentinelParams（感度→しきい値）', () => {
  it('low は鳴りにくい（300秒）', () => {
    expect(sentinelParams('low')).toEqual({ stallSeconds: 300, bgEscalateSeconds: 300 + LOCAL_CHECK_SECONDS });
  });
  it('medium は既定（180秒）', () => {
    expect(sentinelParams('medium')).toEqual({ stallSeconds: 180, bgEscalateSeconds: 180 + LOCAL_CHECK_SECONDS });
  });
  it('high は敏感（120秒）', () => {
    expect(sentinelParams('high')).toEqual({ stallSeconds: 120, bgEscalateSeconds: 120 + LOCAL_CHECK_SECONDS });
  });
});

// 加速度の時系列を 50ms 刻みで流し込むテストヘルパー。
// 各セグメントは [magnitude, durationMs]。転倒が検知されたらその時点で true を返す。
function runTrace(detector: FallDetector, segments: [number, number][], startT = 1_000_000): boolean {
  let t = startT;
  for (const [mag, duration] of segments) {
    for (let i = 0; i < duration / ACCEL_UPDATE_MS; i++) {
      if (detector.feed(mag, t)) return true;
      t += ACCEL_UPDATE_MS;
    }
  }
  return false;
}

describe('FallDetector', () => {
  const STILL = 1.0; // 倒れたまま静止
  const WALK_HI = 1.35; // 歩行の揺れ（静止トレランス外）
  const WALK_LO = 0.7;

  it('強い衝撃(3.5g)→静止3秒 で転倒を検知する（自由落下なしの直撃パス）', () => {
    const d = new FallDetector();
    expect(
      runTrace(d, [
        [STILL, 500],
        [3.5, 50],               // 衝撃
        [STILL, FALL_STILL_MS + 500], // 倒れたまま
      ])
    ).toBe(true);
  });

  it('中程度の衝撃(2.4g)単独では検知しない（勢いよく座った程度を拾わない）', () => {
    const d = new FallDetector();
    expect(
      runTrace(d, [
        [STILL, 500],
        [2.4, 50],
        [STILL, FALL_STILL_MS + 2000],
      ])
    ).toBe(false);
  });

  it('自由落下→中程度の衝撃(2.4g)→静止 で検知する（典型的な転倒パターン）', () => {
    const d = new FallDetector();
    expect(
      runTrace(d, [
        [STILL, 500],
        [0.2, 200],              // 自由落下（FREEFALL_MS=120ms 以上）
        [2.4, 50],               // 着地の衝撃（自由落下後なので 2.2g で足りる）
        [STILL, FALL_STILL_MS + 500],
      ])
    ).toBe(true);
  });

  it('衝撃のあと動き続けたら検知しない（ぶつけただけ・転んですぐ起きた）', () => {
    const d = new FallDetector();
    expect(
      runTrace(d, [
        [STILL, 500],
        [3.5, 50],
        [WALK_HI, 100], [WALK_LO, 100], [WALK_HI, 100], [WALK_LO, 100],
        [WALK_HI, 100], [WALK_LO, 100], [WALK_HI, 100], [WALK_LO, 100],
        [WALK_HI, 3000], // 揺れ続ける（settle window 超過で破棄）
        [STILL, FALL_STILL_MS + 1000], // その後静止しても衝撃は破棄済み
      ])
    ).toBe(false);
  });

  it('静止が3秒未満で動き出したら検知しない（すぐ起き上がった）', () => {
    const d = new FallDetector();
    expect(
      runTrace(d, [
        [STILL, 500],
        [3.5, 50],
        [STILL, FALL_STILL_MS - 1000], // 2秒静止
        [WALK_HI, 200], [WALK_LO, 200], // 動き出す
        [WALK_HI, 200], [WALK_LO, 200],
        [WALK_HI, 2500], // settle window を使い切る
      ])
    ).toBe(false);
  });

  it('通常歩行の揺れでは検知しない', () => {
    const d = new FallDetector();
    const segments: [number, number][] = [];
    for (let i = 0; i < 100; i++) segments.push([i % 2 === 0 ? WALK_HI : WALK_LO, 100]);
    expect(runTrace(d, segments)).toBe(false);
  });

  it('reset() で進行中の判定を破棄する', () => {
    const d = new FallDetector();
    runTrace(d, [[3.5, 50]]); // 衝撃だけ与える
    d.reset();
    // リセット後は静止が続いても検知しない
    expect(runTrace(d, [[STILL, FALL_STILL_MS + 1000]], 2_000_000)).toBe(false);
  });

  it('しきい値の関係が保たれている（回帰ガード）', () => {
    expect(FREEFALL_G).toBeLessThan(1);
    expect(FALL_IMPACT_G).toBeLessThan(FALL_IMPACT_HARD_G);
  });
});

// 速度プロファイルを流し込むヘルパー。各セグメントは [speedMps, durationMs, moving]。
// moving=true なら speed に応じて座標を北へ進める（false は GPSジッタで座標が進まない想定）。
const TICK_MS = 5000; // 前面の位置更新間隔相当
function runMoveTrace(
  detector: MoveAnomalyDetector,
  segments: [number | null, number, boolean?][],
): boolean {
  let t = 1_000_000;
  let lat = 35.0;
  const lng = 139.0;
  for (const [speed, duration, moving = true] of segments) {
    for (let i = 0; i < duration / TICK_MS; i++) {
      if (detector.feed(speed, { latitude: lat, longitude: lng }, t)) return true;
      t += TICK_MS;
      if (moving && typeof speed === 'number') lat += (speed * (TICK_MS / 1000)) / 111_111;
    }
  }
  return false;
}

describe('MoveAnomalyDetector（移動異常＝連れ去り検知）', () => {
  const WALK = 1.4;   // ふつうの歩行
  const CAR = 11;     // ≈40km/h
  const SPRINT = 6.0; // 子どもの全力ダッシュ相当

  it('車の速度で移動し続けたら検知する', () => {
    const d = new MoveAnomalyDetector();
    expect(runMoveTrace(d, [[WALK, 30_000], [CAR, MOVE_SUSTAIN_MS + 15_000]])).toBe(true);
  });

  it('ふつうの歩行では検知しない', () => {
    const d = new MoveAnomalyDetector();
    expect(runMoveTrace(d, [[WALK, 300_000]])).toBe(false);
  });

  it('短距離ダッシュ（持続しない）では検知しない', () => {
    const d = new MoveAnomalyDetector();
    expect(runMoveTrace(d, [
      [WALK, 30_000], [SPRINT, 20_000], [WALK, 120_000],
    ])).toBe(false);
  });

  it('GPSの瞬間的な速度スパイク（座標は進まない）では検知しない', () => {
    const d = new MoveAnomalyDetector();
    // 速度だけ乗り物級・座標はその場（マルチパス誤差の典型）
    expect(runMoveTrace(d, [[WALK, 30_000], [30, MOVE_SUSTAIN_MS + 60_000, false]])).toBe(false);
  });

  it('速度サンプルの一時欠損（grace内）は継続扱いで検知する', () => {
    const d = new MoveAnomalyDetector();
    expect(runMoveTrace(d, [
      [CAR, 20_000],
      [null, 10_000],  // 10秒欠損（MOVE_GRACE_MS=30秒以内）
      [CAR, MOVE_SUSTAIN_MS],
    ])).toBe(true);
  });

  it('長く途切れたら仕切り直す（合算しない）', () => {
    const d = new MoveAnomalyDetector();
    expect(runMoveTrace(d, [
      [CAR, 30_000],
      [WALK, 60_000],  // 30秒(grace)を超える途切れ
      [CAR, 30_000],   // 再開したが単体では45秒に満たない
    ])).toBe(false);
  });

  it('しきい値の妥当性（回帰ガード）', () => {
    expect(MOVE_SPEED_MPS * 3.6).toBeGreaterThanOrEqual(19); // ≈20km/h
    expect(MOVE_SUSTAIN_MS).toBeGreaterThanOrEqual(30_000);
  });
});
