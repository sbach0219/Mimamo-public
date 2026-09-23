#!/usr/bin/env python3
"""OSM の PBF から「道路/建物密度メッシュ」(assets/data/danger-area-jp.bin) を生成する。

危険エリアアラート（Phase 3・docs/design-v3-watcher-redesign.md §7.2）の同梱データ。
アプリ側の読み手は src/lib/dangerArea.ts（DangerAreaIndex.fromBinary）。形式はそちらのコメントが正。

    1/4メッシュ（3次メッシュ ≈1km を 4×4 に割った ≈250m）ごとに
    「道路（人の生活圏の道）または建物がかかっているか」を 1bit で持つ。
    3次メッシュコード(u32) → 16bit マスク、の昇順配列。

何を「人気のある道」と数えるか（POPULATED_HIGHWAYS）:
    生活道路・歩道・自転車道まで含める。登山道 (path)・林道/農道 (track)・馬道 (bridleway) は
    **含めない**。この機能が拾いたいのは「道路網から外れて山に入った」状態で、
    登山道を "道路あり" にすると山中で一切鳴らなくなる。
    誤検知（大きな公園・河川敷）は本人ローカル確認で吸収する設計（§7.2）。

使い方:
    pip install osmium              # pyosmium 4.x
    python3 scripts/danger-area/build.py kanto-latest.osm.pbf -o assets/data/danger-area-jp.bin
    python3 scripts/danger-area/build.py japan-latest.osm.pbf -o assets/data/danger-area-jp.bin

    入力は Geofabrik の抽出 (https://download.geofabrik.de/asia/japan.html) を想定。
    日本全土 (~2GB) は node の位置キャッシュに数GBのメモリを使う。まず地方抽出で試すこと。
"""
from __future__ import annotations

import argparse
import math
import struct
import sys
import time

try:
    import osmium
    from osmium import filter as osm_filter
except ImportError:  # pragma: no cover
    sys.exit("pyosmium が必要です: pip install osmium")

MAGIC = b"MMDA"
VERSION = 1

# 「人の生活圏の道」とみなす highway 値。path/track/bridleway は意図的に外している（上記）。
POPULATED_HIGHWAYS = {
    "motorway", "motorway_link", "trunk", "trunk_link",
    "primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "unclassified", "residential",
    "living_street", "service", "pedestrian", "footway", "cycleway",
    "steps", "busway", "road",
}

# 線分を辿るときの刻み（m）。1/4メッシュは約250m四方なので 60m 刻みなら取りこぼさない
STEP_M = 60.0


def quarter_cell(lat: float, lon: float) -> tuple[int, int]:
    """src/lib/dangerArea.ts quarterCellOf と同じ"""
    return math.floor(lat * 480), math.floor((lon - 100) * 320)


def mesh_of_quarter(row: int, col: int) -> tuple[int, int]:
    """src/lib/dangerArea.ts meshOfQuarter と同じ。(3次メッシュコード, 添字0..15)"""
    R, C = row // 4, col // 4
    p, q, r = R // 80, (R % 80) // 10, R % 10
    u, v, w = C // 80, (C % 80) // 10, C % 10
    code = p * 1_000_000 + u * 10_000 + q * 1_000 + v * 100 + r * 10 + w
    sub = (row - R * 4) * 4 + (col - C * 4)
    return code, sub


class Rasterizer:
    def __init__(self) -> None:
        self.masks: dict[int, int] = {}
        self.ways = 0
        self.skipped = 0

    def mark(self, lat: float, lon: float) -> None:
        if not (20.0 <= lat <= 50.0 and 120.0 <= lon <= 155.0):
            return  # 日本周辺以外（データ外）は捨てる。1次メッシュのコードが負になるのも防ぐ
        row, col = quarter_cell(lat, lon)
        code, sub = mesh_of_quarter(row, col)
        self.masks[code] = self.masks.get(code, 0) | (1 << sub)

    def segment(self, a: tuple[float, float], b: tuple[float, float]) -> None:
        (lat1, lon1), (lat2, lon2) = a, b
        # 近似距離（m）。1度 ≈ 111km、経度は cos(lat) で縮む
        dy = (lat2 - lat1) * 111_000.0
        dx = (lon2 - lon1) * 111_000.0 * math.cos(math.radians((lat1 + lat2) / 2))
        n = max(1, int(math.hypot(dx, dy) / STEP_M))
        for i in range(n + 1):
            t = i / n
            self.mark(lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t)

    def way(self, w) -> None:  # osmium.osm.Way
        tags = w.tags
        hw = tags.get("highway")
        if hw is not None:
            if hw not in POPULATED_HIGHWAYS:
                return
        elif "building" not in tags:
            return
        coords: list[tuple[float, float]] = []
        for n in w.nodes:
            try:
                loc = n.location
                if not loc.valid():
                    continue
                coords.append((loc.lat, loc.lon))
            except osmium.InvalidLocationError:
                continue  # 抽出範囲の縁で node が欠けている
        if len(coords) < 2:
            if len(coords) == 1:
                self.mark(*coords[0])
            else:
                self.skipped += 1
            return
        self.ways += 1
        for a, b in zip(coords, coords[1:]):
            self.segment(a, b)


def write_binary(masks: dict[int, int], path: str) -> int:
    codes = sorted(masks)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sBxxxI", MAGIC, VERSION, len(codes)))
        f.write(struct.pack(f"<{len(codes)}I", *codes))
        f.write(struct.pack(f"<{len(codes)}H", *(masks[c] for c in codes)))
    return 12 + len(codes) * 6


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pbf", help="入力 .osm.pbf")
    ap.add_argument("-o", "--out", default="assets/data/danger-area-jp.bin")
    ap.add_argument("--index", default="flex_mem", help="node 位置キャッシュの種類（flex_mem / sparse_mem_array / dense_file_array,<file>）")
    args = ap.parse_args()

    started = time.time()
    r = Rasterizer()
    # highway / building を持つ way だけを C++ 側で選別してから Python に渡す。
    # with_locations は filter より前に付ける（node の位置は filter に関係なくキャッシュされる）。
    fp = (
        osmium.FileProcessor(args.pbf, osmium.osm.NODE | osmium.osm.WAY)
        .with_locations(args.index)
        .with_filter(osm_filter.EntityFilter(osmium.osm.WAY))
        .with_filter(osm_filter.KeyFilter("highway", "building"))
    )
    for obj in fp:
        r.way(obj)
        if r.ways % 200_000 == 0 and r.ways:
            print(f"  ways={r.ways:,} meshes={len(r.masks):,} {time.time() - started:.0f}s", file=sys.stderr)

    size = write_binary(r.masks, args.out)
    occupied = sum(bin(m).count("1") for m in r.masks.values())
    print(
        f"done: ways={r.ways:,} (skipped {r.skipped:,}) meshes(3次)={len(r.masks):,} "
        f"quarter-cells={occupied:,} → {args.out} {size / 1e6:.2f} MB in {time.time() - started:.0f}s"
    )


if __name__ == "__main__":
    main()
