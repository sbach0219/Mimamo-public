// 経路点の間引き（architecture-review B-4）。
//
// ホールドモードは最短5秒間隔で位置サンプルが届くため、間引かずに route サブコレクションへ
// 書くと長い外出で数千ドキュメントになる。見守り側の onSnapshot は更新のたびに全件を
// map し直すので、read 課金・メモリ・polyline 描画がセッション時間に対して線形に悪化する。
//
// 親ドキュメントの latitude/longitude は間引かずに毎回書く（「いまどこ」は鮮度が命）。
// 間引くのは軌跡の記録だけで、表示上は 25m 刻みで十分に道筋が分かる。
import { distanceMeters } from './sentinel';

export const ROUTE_MIN_DISTANCE_M = 25;
export const ROUTE_MIN_INTERVAL_MS = 30_000;

export type RouteSample = { latitude: number; longitude: number; at: number };

// 直前に記録した点が無ければ必ず記録する（軌跡の始点を落とさない）。
// 距離・時間のどちらかがしきい値を超えていれば記録する。時間側の条件があるのは、
// 立ち止まっている間も「まだ生きている軌跡」であることを残すため。
export function shouldRecordRoutePoint(last: RouteSample | null, next: RouteSample): boolean {
  if (!last) return true;
  if (next.at - last.at >= ROUTE_MIN_INTERVAL_MS) return true;
  return distanceMeters(last, next) >= ROUTE_MIN_DISTANCE_M;
}

// 間引きの判定に使う「直前に記録した点」を保持する小さな器。
// 前面ストアとバックグラウンドタスクがそれぞれ独立に1つ持つ（プロセス再起動で
// 消えても、余分な点が1つ書かれるだけで害はない）。
export class RouteThinner {
  private last: RouteSample | null = null;

  accept(sample: RouteSample): boolean {
    if (!shouldRecordRoutePoint(this.last, sample)) return false;
    this.last = sample;
    return true;
  }

  reset(): void {
    this.last = null;
  }
}
