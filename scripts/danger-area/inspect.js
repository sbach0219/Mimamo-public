#!/usr/bin/env node
// 生成した danger-area-jp.bin を点検する開発ツール。
//   node scripts/danger-area/inspect.js                      … 件数・サイズ・カバレッジ（1次メッシュ一覧）
//   node scripts/danger-area/inspect.js 35.6812 139.7671     … その座標の 3×3 密度と判定
//   node scripts/danger-area/inspect.js --grid 35.65 139.54 … 周囲 21×21 セルの占有図（. = 無, # = 有）
// メッシュ計算は src/lib/dangerArea.ts と同じ式（純 JS で写している）。
const fs = require('fs');
const path = require('path');

const file = process.env.DANGER_AREA_BIN || path.join(__dirname, '..', '..', 'assets', 'data', 'danger-area-jp.bin');
const buf = fs.readFileSync(file);
if (buf.toString('ascii', 0, 4) !== 'MMDA') throw new Error('bad magic');
const count = buf.readUInt32LE(8);
const codes = new Uint32Array(count);
const masks = new Uint16Array(count);
for (let i = 0; i < count; i++) {
  codes[i] = buf.readUInt32LE(12 + i * 4);
  masks[i] = buf.readUInt16LE(12 + count * 4 + i * 2);
}

const quarterCell = (lat, lng) => ({ row: Math.floor(lat * 480), col: Math.floor((lng - 100) * 320) });
const meshOfQuarter = ({ row, col }) => {
  const R = Math.floor(row / 4), C = Math.floor(col / 4);
  const code = Math.floor(R / 80) * 1e6 + Math.floor(C / 80) * 1e4 + Math.floor((R % 80) / 10) * 1e3
    + Math.floor((C % 80) / 10) * 100 + (R % 10) * 10 + (C % 10);
  return { code, sub: (row - R * 4) * 4 + (col - C * 4) };
};
const maskOf = (code) => {
  let lo = 0, hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (codes[mid] === code) return masks[mid];
    if (codes[mid] < code) lo = mid + 1; else hi = mid - 1;
  }
  return 0;
};
const occupied = (cell) => { const { code, sub } = meshOfQuarter(cell); return (maskOf(code) & (1 << sub)) !== 0; };
const density = (lat, lng) => {
  const { row, col } = quarterCell(lat, lng);
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (occupied({ row: row + dr, col: col + dc })) n++;
  return n;
};

const args = process.argv.slice(2);
if (args.length === 0) {
  const primaries = new Set();
  let cells = 0;
  for (let i = 0; i < count; i++) { primaries.add(Math.floor(codes[i] / 1e4)); cells += popcount(masks[i]); }
  console.log(`${file}\n  size=${(buf.length / 1e6).toFixed(2)}MB meshes(3次)=${count.toLocaleString()} quarter-cells=${cells.toLocaleString()}`);
  console.log(`  1次メッシュ(カバレッジ) ${primaries.size}件: ${[...primaries].sort().join(' ')}`);
} else if (args[0] === '--grid') {
  const lat = Number(args[1]), lng = Number(args[2]);
  const c = quarterCell(lat, lng);
  const lines = [];
  for (let dr = 10; dr >= -10; dr--) {
    let line = '';
    for (let dc = -10; dc <= 10; dc++) {
      line += dr === 0 && dc === 0 ? '@' : occupied({ row: c.row + dr, col: c.col + dc }) ? '#' : '.';
    }
    lines.push(line);
  }
  console.log(`${lat},${lng} 周囲 21×21 セル（≈5km四方）。@=現在地 #=道路/建物あり .=なし\n` + lines.join('\n'));
} else {
  const lat = Number(args[0]), lng = Number(args[1]);
  const { code, sub } = meshOfQuarter(quarterCell(lat, lng));
  const d = density(lat, lng);
  // カバレッジ（1次メッシュにデータが1件も無ければ判定しない）は src/lib/dangerArea.ts covers と同じ
  let covered = false;
  for (let i = 0; i < count && !covered; i++) covered = Math.floor(codes[i] / 1e4) === Math.floor(code / 1e4);
  const verdict = !covered ? 'unknown（データ外・判定しない）' : d <= 1 ? 'remote（人気のない場所）' : 'populated';
  console.log(`${lat},${lng}: 3次メッシュ ${code} 添字 ${sub} 占有=${occupied(quarterCell(lat, lng))} 3×3密度=${d} → ${verdict}`);
}

function popcount(x) { let n = 0; while (x) { n += x & 1; x >>>= 1; } return n; }
