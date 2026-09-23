// assets/icons/*.svg を src/icons/icons.generated.ts に文字列として取り込む。
// Metro に SVG トランスフォーマを足すとネイティブ再ビルドと設定が増えるため、
// 実体は SVG ファイルのまま置き、ビルド前に一度だけ TS へ変換する方式にしている。
// アイコンを追加・修正したら `node scripts/generate-icons.js` を実行すること。
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'assets', 'icons');
const OUT_FILE = path.join(__dirname, '..', 'src', 'icons', 'icons.generated.ts');

// 昼テーマ（白背景）用の再配色。元データは夜テーマ資産なので値は書き換えず、
// 生成時に線＝ink / アクセント＝rose へ置換した第2セットを追加する
// （docs/design-pink-proposal §5-③）。
const DAY_SUBSTITUTIONS = [
  [/#FFFFFF/g, '#3B2530'], // 線・面（白 → ink）
  [/#FFD60A/g, '#C2185B'], // アクセント（gold → rose）
];

function toDay(xml) {
  return DAY_SUBSTITUTIONS.reduce((acc, [re, to]) => acc.replace(re, to), xml);
}

const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.svg')).sort();

const sources = files.map((f) => ({
  name: f.replace(/\.svg$/, ''),
  xml: fs.readFileSync(path.join(SRC_DIR, f), 'utf8').trim(),
}));

const entries = sources.map((s) => `  '${s.name}': ${JSON.stringify(s.xml)},`);
const dayEntries = sources.map((s) => `  '${s.name}': ${JSON.stringify(toDay(s.xml))},`);

const out = `// このファイルは scripts/generate-icons.js が生成する。直接編集しないこと。
// 元データ: assets/icons/*.svg（viewBox 24×24 / stroke #FFFFFF 1.8 / アクセント #FFD60A）
// ICON_XML_DAY は同じ形のまま線 #3B2530 / アクセント #C2185B へ置換した昼テーマ版。

export const ICON_XML = {
${entries.join('\n')}
} as const;

export type IconName = keyof typeof ICON_XML;

export const ICON_XML_DAY: Record<IconName, string> = {
${dayEntries.join('\n')}
};
`;

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, out);
console.log(`generated ${files.length} icons -> ${path.relative(process.cwd(), OUT_FILE)}`);
