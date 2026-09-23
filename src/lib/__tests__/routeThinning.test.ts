import {
  RouteThinner, shouldRecordRoutePoint,
  ROUTE_MIN_DISTANCE_M, ROUTE_MIN_INTERVAL_MS,
} from '../routeThinning';

// 東京駅付近。緯度1度 ≈ 111km なので、0.001度 ≈ 111m。
const base = { latitude: 35.681, longitude: 139.767 };
const north = (meters: number) => ({
  latitude: base.latitude + meters / 111_000,
  longitude: base.longitude,
});

describe('shouldRecordRoutePoint', () => {
  test('最初の点は必ず記録する（軌跡の始点を落とさない）', () => {
    expect(shouldRecordRoutePoint(null, { ...base, at: 0 })).toBe(true);
  });

  test('しきい値未満の移動・短い間隔では記録しない', () => {
    const last = { ...base, at: 0 };
    const next = { ...north(ROUTE_MIN_DISTANCE_M - 10), at: 5_000 };
    expect(shouldRecordRoutePoint(last, next)).toBe(false);
  });

  test('しきい値以上動いたら記録する', () => {
    const last = { ...base, at: 0 };
    const next = { ...north(ROUTE_MIN_DISTANCE_M + 5), at: 5_000 };
    expect(shouldRecordRoutePoint(last, next)).toBe(true);
  });

  test('立ち止まっていても一定時間が過ぎたら記録する（軌跡が生きている印）', () => {
    const last = { ...base, at: 0 };
    expect(shouldRecordRoutePoint(last, { ...base, at: ROUTE_MIN_INTERVAL_MS })).toBe(true);
  });
});

describe('RouteThinner', () => {
  test('採用した点だけが次の比較基準になる', () => {
    const thinner = new RouteThinner();
    expect(thinner.accept({ ...base, at: 0 })).toBe(true);
    // 15m ずつ2回動く。1回目は不採用だが、2回目は始点から30m なので採用される
    // （不採用の点を基準にしてしまうと、ゆっくり歩く人の軌跡が永久に伸びない）
    expect(thinner.accept({ ...north(15), at: 5_000 })).toBe(false);
    expect(thinner.accept({ ...north(30), at: 10_000 })).toBe(true);
  });

  test('reset 後は最初の点として扱う', () => {
    const thinner = new RouteThinner();
    thinner.accept({ ...base, at: 0 });
    thinner.reset();
    expect(thinner.accept({ ...base, at: 1_000 })).toBe(true);
  });
});
