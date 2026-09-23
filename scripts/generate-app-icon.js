// assets/appicon/final/*.svg（採用中の白×ピンク版）からアプリアイコンの PNG 群を書き出す。
// 出力先は assets/appicon/final/（ソースと並べた記録）と assets/（app.json が参照する実体）。
// 変換には rsvg-convert（brew install librsvg）を使う。
// アイコンを変更したら `node scripts/generate-app-icon.js` を実行すること。
//
// 旧版（夜空＋金の光跡）は assets/appicon/night-legacy/ に退避してある。
// icon-assets/ のハートピン案は不採用のため、このスクリプトの対象外。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'assets', 'appicon', 'final');
const OUT_DIRS = [SRC_DIR, path.join(ROOT, 'assets')];

// [ファイル名（.svg / .png 共通）, 一辺のピクセル数]
const TARGETS = [
  ['icon', 1024],
  ['android-icon-background', 1024],
  ['android-icon-foreground', 1024],
  ['android-icon-monochrome', 1024],
  ['splash-icon', 1024],
  ['favicon', 256],
];

for (const [name, size] of TARGETS) {
  const svg = path.join(SRC_DIR, `${name}.svg`);
  const png = execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svg], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'buffer',
  });
  for (const dir of OUT_DIRS) {
    fs.writeFileSync(path.join(dir, `${name}.png`), png);
  }
  console.log(`${name}.svg -> ${name}.png (${size}px, ${png.length} bytes)`);
}
