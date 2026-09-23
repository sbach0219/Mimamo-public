# 危険エリアアラートの同梱データ（scripts/danger-area）

Phase 3「危険エリアアラート」（`docs/design-v3-watcher-redesign.md` §7.2）が端末内で照合する
「道路/建物密度メッシュ」`assets/data/danger-area-jp.bin` を OSM から生成する。

- 読み手: `src/lib/dangerArea.ts`（形式の正はこのファイルのコメント）
- 判定の実行: `src/tasks/locationTask.ts` `detectArea`（前面・背面とも唯一の判定点）
- 前面 UI: `src/hooks/useSentinel.ts` → `MainSentinelScreen` の CheckOverlay

## 生成手順

```bash
pip install osmium          # pyosmium 4.x（macOS arm64 は wheel あり）
# Geofabrik から地方抽出をダウンロード（例: 関東 ~400MB）
#   https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf
python3 scripts/danger-area/build.py kanto-latest.osm.pbf -o assets/data/danger-area-jp.bin
node scripts/danger-area/inspect.js                      # 件数・サイズ・カバレッジ
node scripts/danger-area/inspect.js 35.6812 139.7671     # 東京駅 → populated のはず
node scripts/danger-area/inspect.js --grid 35.72 139.20  # 奥多摩あたりの占有図
```

日本全土（`japan-latest.osm.pbf` ~2GB）は node 位置キャッシュに数GBのメモリを使う。
まず地方抽出で精度とサイズを見る（設計のスパイク①）。

実測（2026-09-03、RAM 24GB の Mac）:
- 関東抽出 496MB: 242秒・ピークメモリ 2.2GB・出力 0.17MB（3次メッシュ 27,700件）
- **日本全土 2.5GB: 1102秒（約18分）・出力 1.66MB（3次メッシュ 277,095件）** ← 現在の同梱データ
メモリが足りなければ `--index sparse_mem_array` または `--index dense_file_array,/tmp/nodes.cache`。
18分かかるので、エージェントから回すときは nohup で切り離す（バックグラウンド実行の10分上限で死ぬ）。

## 設計上の決め事

| 項目 | 値 | 理由 |
|---|---|---|
| 最小単位 | 1/4メッシュ（≈250m） | 設計 §7.2「約250mメッシュ」。JIS X 0410 の3次メッシュを 4×4 分割 |
| 「道路」に数える highway | 生活道路〜歩道・自転車道（`POPULATED_HIGHWAYS`） | **登山道 path・林道/農道 track は数えない**。数えると山中で鳴らなくなる |
| 建物 | `building=*` の way 全部 | 道路が無くても建物があれば人の生活圏 |
| remote 判定 | 3×3 セル（≈750m四方）の占有数 ≤ 1 | 道路脇 250m の GPS 誤差で判定が揺れないように隣接1マス許容（`REMOTE_MAX_OCCUPIED`） |
| データ無し地域 | 1次メッシュ（≈80km四方）に1件も無ければ判定しない | 海外・未生成地域で誤って鳴らさない（`covers`） |
| 鮮度 | アプリ更新に同梱。配信基盤なし | 「道路が無い山地」は変化が極めて遅い |

## データ更新のとき

1. 新しい PBF で `build.py` を回し、`inspect.js` で自宅周辺・既知の山道を点検する
2. `assets/data/danger-area-jp.bin` を差し替えてコミット（数MB。OTA でも配れるが、
   Phase 3 初回は `expo-file-system` 追加のためネイティブビルドが必要）
3. サイズが大きく変わったら `DangerAreaIndex` の形式バージョン（`DANGER_AREA_VERSION`）は
   据え置きでよい（形式は変えていない）
