import {
  DangerAreaIndex,
  INITIAL_AREA_STATE,
  AREA_GRACE_MS,
  AREA_REARM_MS,
  HOME_EXCLUDE_M,
  acknowledgeArea,
  areaParams,
  isAreaArmed,
  meshCodeOf,
  meshOfQuarter,
  quarterCellOf,
  readArea,
  stepArea,
  type AreaState,
} from '../dangerArea';
import { LOCAL_CHECK_SECONDS } from '../sentinel';

// 東京駅（3次メッシュ 53394611 は国土地理院の公表値）
const TOKYO_STATION = { latitude: 35.681236, longitude: 139.767125 };
// 調布駅
const CHOFU = { latitude: 35.651944, longitude: 139.544167 };

describe('メッシュ計算（JIS X 0410）', () => {
  it('東京駅の3次メッシュコードは 53394611', () => {
    expect(meshCodeOf(TOKYO_STATION)).toBe(53394611);
  });
  it('調布駅の3次メッシュコードは 53393483', () => {
    // 緯度 35.651944 → 1次 53（35.333..）, 2次 3（+0.25）, 3次 8（+0.0667）
    // 経度 139.544167 → 1次 39, 2次 4（+0.5）, 3次 3（+0.0375）
    expect(meshCodeOf(CHOFU)).toBe(53393483);
  });
  it('1/4メッシュの添字は南西=0・北東=15', () => {
    // 3次メッシュ 53394611 の南西角の少し内側と北東角の少し内側
    const sw = { latitude: 35.675 + 0.0001, longitude: 139.7625 + 0.0001 };
    const ne = { latitude: 35.675 + 30 / 3600 - 0.0001, longitude: 139.7625 + 45 / 3600 - 0.0001 };
    expect(meshOfQuarter(quarterCellOf(sw))).toEqual({ code: 53394611, sub: 0 });
    expect(meshOfQuarter(quarterCellOf(ne))).toEqual({ code: 53394611, sub: 15 });
  });
  it('隣接する1/4メッシュは行・列が1ずつ違う', () => {
    const a = quarterCellOf(TOKYO_STATION);
    const north = quarterCellOf({ latitude: TOKYO_STATION.latitude + 1 / 480, longitude: TOKYO_STATION.longitude });
    const east = quarterCellOf({ latitude: TOKYO_STATION.latitude, longitude: TOKYO_STATION.longitude + 1 / 320 });
    expect(north).toEqual({ row: a.row + 1, col: a.col });
    expect(east).toEqual({ row: a.row, col: a.col + 1 });
  });
});

// 東京駅を含む1/4メッシュとその周囲を「道路あり」にした索引を作る
function indexAround(coord: { latitude: number; longitude: number }, radiusCells: number): DangerAreaIndex {
  const center = quarterCellOf(coord);
  const masks = new Map<number, number>();
  for (let dr = -radiusCells; dr <= radiusCells; dr++) {
    for (let dc = -radiusCells; dc <= radiusCells; dc++) {
      const { code, sub } = meshOfQuarter({ row: center.row + dr, col: center.col + dc });
      masks.set(code, (masks.get(code) ?? 0) | (1 << sub));
    }
  }
  const entries = [...masks.entries()].sort((a, b) => a[0] - b[0]) as [number, number][];
  return DangerAreaIndex.fromEntries(entries);
}

describe('DangerAreaIndex', () => {
  it('バイナリ直列化の往復で同じ判定になる', () => {
    const src = indexAround(TOKYO_STATION, 2);
    const entries: [number, number][] = [];
    // fromEntries で作った索引を再現するため、同じ入力を直列化して読み戻す
    const center = quarterCellOf(TOKYO_STATION);
    const masks = new Map<number, number>();
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const { code, sub } = meshOfQuarter({ row: center.row + dr, col: center.col + dc });
      masks.set(code, (masks.get(code) ?? 0) | (1 << sub));
    }
    for (const e of [...masks.entries()].sort((a, b) => a[0] - b[0])) entries.push(e);
    const bin = DangerAreaIndex.toBinary(entries);
    const back = DangerAreaIndex.fromBinary(bin);
    expect(back.size).toBe(src.size);
    expect(back.density(TOKYO_STATION)).toBe(9);
    expect(back.density(CHOFU)).toBe(0);
  });
  it('壊れたデータは例外になる（黙って誤判定しない）', () => {
    expect(() => DangerAreaIndex.fromBinary(new ArrayBuffer(4))).toThrow();
    const bad = DangerAreaIndex.toBinary([[53394611, 1]]);
    new DataView(bad).setUint32(0, 0, true);
    expect(() => DangerAreaIndex.fromBinary(bad)).toThrow(/magic/);
    expect(() => DangerAreaIndex.fromEntries([[2, 1], [1, 1]])).toThrow(/ascending/);
  });
  it('密度は3×3の占有セル数', () => {
    const idx = indexAround(TOKYO_STATION, 0); // 中心1セルだけ
    expect(idx.density(TOKYO_STATION)).toBe(1);
    const idx3 = indexAround(TOKYO_STATION, 1);
    expect(idx3.density(TOKYO_STATION)).toBe(9);
    // 2セル離れると 3×3 の端にかかるだけ
    const twoEast = { latitude: TOKYO_STATION.latitude, longitude: TOKYO_STATION.longitude + 2 / 320 };
    expect(idx3.density(twoEast)).toBe(3);
  });
  it('カバレッジは1次メッシュ単位', () => {
    const idx = indexAround(TOKYO_STATION, 1);
    expect(idx.covers(CHOFU)).toBe(true); // 同じ1次メッシュ 5339
    expect(idx.covers({ latitude: 43.06, longitude: 141.35 })).toBe(false); // 札幌
  });
});

describe('readArea', () => {
  const idx = indexAround(TOKYO_STATION, 1);
  it('索引が無ければ unknown（機能を静かに無効化）', () => {
    expect(readArea(null, TOKYO_STATION, null)).toBe('unknown');
  });
  it('精度の悪い位置は unknown', () => {
    expect(readArea(idx, { ...CHOFU, accuracy: 150 }, null)).toBe('unknown');
    expect(readArea(idx, { ...CHOFU, accuracy: 30 }, null)).toBe('remote');
  });
  it('データ対象外の地域は unknown', () => {
    expect(readArea(idx, { latitude: 43.06, longitude: 141.35 }, null)).toBe('unknown');
  });
  it('道路のある所は populated・無い所は remote', () => {
    expect(readArea(idx, TOKYO_STATION, null)).toBe('populated');
    expect(readArea(idx, CHOFU, null)).toBe('remote');
  });
  it('自宅の近くは remote にしない', () => {
    const nearHome = { latitude: CHOFU.latitude + 0.001, longitude: CHOFU.longitude }; // ≈111m
    expect(readArea(idx, nearHome, CHOFU)).toBe('populated');
    const farFromHome = { latitude: CHOFU.latitude + 0.005, longitude: CHOFU.longitude }; // ≈555m
    expect(farFromHome.latitude - CHOFU.latitude).toBeGreaterThan(HOME_EXCLUDE_M / 111_000);
    expect(readArea(idx, farFromHome, CHOFU)).toBe('remote');
  });
});

describe('areaParams（感度→滞在しきい値）', () => {
  it('low=480s / medium=300s / high=180s、本人確認の猶予は共通', () => {
    expect(areaParams('low')).toEqual({ dwellSeconds: 480, escalateSeconds: 480 + LOCAL_CHECK_SECONDS });
    expect(areaParams('medium')).toEqual({ dwellSeconds: 300, escalateSeconds: 300 + LOCAL_CHECK_SECONDS });
    expect(areaParams('high')).toEqual({ dwellSeconds: 180, escalateSeconds: 180 + LOCAL_CHECK_SECONDS });
  });
});

// remote/populated の読みを 20 秒刻みで流し込み、発生したイベントを集める
function run(
  readings: Array<['remote' | 'populated' | 'unknown', number]>,
  start: AreaState = INITIAL_AREA_STATE,
  sensitivity: 'low' | 'medium' | 'high' = 'medium',
  tickMs = 20_000,
) {
  let state = start;
  let t = 1_000_000;
  const events: Array<{ t: number; event: string }> = [];
  for (const [reading, durationMs] of readings) {
    for (let i = 0; i < durationMs / tickMs; i++) {
      const r = stepArea(state, reading, t, sensitivity);
      state = r.state;
      if (r.event) events.push({ t: t - 1_000_000, event: r.event });
      t += tickMs;
    }
  }
  return { state, events, t };
}

describe('stepArea（検知の状態機械）', () => {
  it('人気のない場所に5分居たら本人確認、さらに60秒で見守りへ', () => {
    const { events, state } = run([['remote', 7 * 60_000]]);
    expect(events).toEqual([
      { t: 300_000, event: 'local_check' },
      { t: 360_000, event: 'escalate' },
    ]);
    expect(state.stage).toBe(2);
  });
  it('感度 high なら3分で本人確認', () => {
    const { events } = run([['remote', 4 * 60_000]], INITIAL_AREA_STATE, 'high');
    expect(events[0]).toEqual({ t: 180_000, event: 'local_check' });
  });
  it('瞬間の通過では鳴らない（連続滞在のみ数える）', () => {
    const { events } = run([
      ['remote', 2 * 60_000], ['populated', 60_000],
      ['remote', 2 * 60_000], ['populated', 60_000],
      ['remote', 2 * 60_000],
    ]);
    expect(events).toEqual([]);
  });
  it('本人確認中に人気のある場所へ出たら取り下げる（見守りへは通知しない）', () => {
    const { events, state } = run([['remote', 5 * 60_000 + 20_000], ['populated', 20_000]]);
    expect(events).toEqual([
      { t: 300_000, event: 'local_check' },
      { t: 320_000, event: 'cleared' },
    ]);
    expect(state.stage).toBe(0);
  });
  it('通知済み（stage 2）は人気のある場所へ出ても自動では戻さない', () => {
    const { state } = run([['remote', 7 * 60_000], ['populated', 5 * 60_000]]);
    expect(state.stage).toBe(2);
  });
  it('unknown（精度不良・データ外）は状態を進めも戻しもしない', () => {
    const { events } = run([['remote', 4 * 60_000], ['unknown', 10 * 60_000]]);
    expect(events).toEqual([]);
    const { events: e2 } = run([['remote', 4 * 60_000], ['unknown', 40_000], ['remote', 60_000]]);
    // unknown の40秒は grace 内なので連続滞在として数え続ける → 4分+40秒+20秒 で 5分到達
    expect(e2).toEqual([{ t: 300_000, event: 'local_check' }]);
  });
  it('サンプル欠損が grace を超えたら滞在の起点を仕切り直す', () => {
    const first = run([['remote', 4 * 60_000]]);
    // grace を超える空白
    const t = first.t + AREA_GRACE_MS + 1;
    const r = stepArea(first.state, 'remote', t, 'medium');
    expect(r.event).toBeNull();
    expect(r.state.remoteSince).toBe(t);
  });
  it('「ここは だいじょうぶ」の後は、滞在が終わるまで再発火しない', () => {
    const first = run([['remote', 5 * 60_000 + 20_000]]);
    expect(first.state.stage).toBe(1);
    const acked = acknowledgeArea(first.state);
    expect(acked.suppressed).toBe(true);
    const during = run([['remote', 30 * 60_000]], acked);
    expect(during.events).toEqual([]);
    // 人気のある場所に REARM_MS 居たら再武装し、その後の滞在では再び鳴る
    const rearm = run([['populated', AREA_REARM_MS + 20_000]], during.state);
    expect(rearm.events.map((e) => e.event)).toEqual(['rearmed']);
    expect(rearm.state.suppressed).toBe(false);
    const again = run([['remote', 6 * 60_000]], rearm.state);
    expect(again.events.map((e) => e.event)).toEqual(['local_check']);
  });
  it('抑制中に人気のある場所へ出ても、再武装前に remote へ戻れば数え直し', () => {
    const acked = acknowledgeArea(INITIAL_AREA_STATE);
    const r = run([['populated', 60_000], ['remote', 60_000], ['populated', 60_000]], acked);
    expect(r.events).toEqual([]);
    expect(r.state.suppressed).toBe(true);
  });
  it('人気のある場所を歩いているだけなら状態オブジェクトを作り直さない（bg の無駄な書き込み防止）', () => {
    const r = stepArea(INITIAL_AREA_STATE, 'populated', 1_000_000, 'medium');
    expect(r.state).toBe(INITIAL_AREA_STATE);
    expect(r.event).toBeNull();
  });
  it('状態は JSON で往復できる（bg タスクの AsyncStorage 永続化）', () => {
    const { state } = run([['remote', 3 * 60_000]]);
    const back = JSON.parse(JSON.stringify(state)) as AreaState;
    expect(back).toEqual(state);
  });
});

describe('isAreaArmed', () => {
  it('徒歩宣言のセッションだけ武装する', () => {
    expect(isAreaArmed('walk')).toBe(true);
    expect(isAreaArmed('vehicle_ok')).toBe(false);
    expect(isAreaArmed(undefined)).toBe(false);
  });
});
