// =============================================================
// みまも デザイントークン v3（役割別2テーマ「昼と夜」）
// 夜（歩行側）= 従来のダーク。昼（見守り側）= 白×ピンク。
// semantic のキー構造は v2 と同一。画面は色を直接書かずここを経由する。
// 参照: docs/design-refresh-spec.md / docs/design-pink-proposal.md
// =============================================================

// ---------- パレット（生の値。画面からは直接使わず semantic 経由で） ----------
export const palette = {
  night1: '#0A0D33',   // site --night-1
  night2: '#0D1A59',   //（アプリ既存中間色。site --night-2 #16296B とは別値のまま維持）
  night3: '#1A3380',   // site --night-3
  gold: '#FFD60A',     // site ダーク --gold
  goldDeep: '#FF9F0A', // 旧 orange。caution 専用
  sky: '#6FA8E8',      // site ダーク --sky。枠線・大きい要素・ボタン地
  skyDeep: '#8FC0F2',  // site ダーク --sky-deep。小さい文字用（明るい方）
  green: '#34C759',
  red: '#FF3B30',
  redActive: '#FF1F14',  // SOS発信中（SOSButton 既存値の取り込み）
  redText: '#FF6961',    // 紺背景上の赤系文字（design-review E-2）
  navyInk: '#0C1128',    // site ダーク --btn-fg。sky/gold 地の上の文字
  cardNavy: '#121A4D',   // オーバーレイカード地（ArrivalOverlay 既存値）
  qrNavy: '#0E1A45',     // QR前景。site --navy-deep（旧 #0A1A40 を置換）
  navyChrome: '#0A1A40', // 夜側のヘッダー・画面下地（出荷済みの値。night1 とは別値のまま維持）
  white: '#FFFFFF',
  black: '#000000',
} as const;

// ---------- 昼パレット（design-pink-proposal §1.1。コントラスト実測済みの値） ----------
// 19pt 以下の文字に使ってよいピンクは rose / roseDeep のみ。
// roseSoft と透過ピンクは装飾専用（白文字を載せると 3.46:1 で不合格）。
export const dayPalette = {
  day1: '#FFFFFF',        // 背景グラデ上端
  day2: '#FFF3F7',        // 背景グラデ中間（ごく淡い桜）
  day3: '#FFE7F0',        // 背景グラデ下端
  rose: '#C2185B',        // 主行動・ブランドピンク（濃ローズ。白と 5.87:1）
  roseDeep: '#AD1457',    // 押下・強調
  roseSoft: '#E9538A',    // 装飾のみ
  rosePale: '#F3A9C8',    // 装飾のみ（夜空上の点・小さな装飾。lightColor.pressed の中間色と同値）
  blue: '#2B6CB0',        // 情報・リンク（白と 5.42:1）
  green: '#177C43',       // safe（白と 5.25:1）
  vermilion: '#D91E18',   // danger。ピンクと反対側の暖色赤（白と 5.06:1）
  vermilionDeep: '#B3261E',
  amber: '#9A5B00',       // caution の文字・枠（白と 5.43:1）
  amberFill: '#F2A33C',   // caution の塗り。上は ink 文字で 6.75:1
  ink: '#3B2530',         // 本文（白と 14.06:1）
  inkSub: '#6E5560',      // 補足文字（白と 6.71:1）
  inkFaint: '#8A6B77',    // 非活性・装飾のみ（白と 4.72:1）
} as const;

// ---------- semantic の形（夜・昼で同一キー） ----------
export type ThemeColor = {
  night: readonly [string, string, string];
  pressed: readonly [string, string, string];

  action: string;
  info: string;
  infoText: string;
  safe: string;
  danger: string;
  caution: string;
  cautionFill: string;

  dangerActive: string;
  dangerText: string;
  inkOnAccent: string;
  actionInk: string;
  safeInk: string;

  text: string;
  textSub: string;
  textFaint: string;

  glass: string;
  glassStroke: string;
  raised: string;
  raisedStroke: string;
  cardNavy: string;
  overlayScrim: string;
  criticalScrim: string;

  qrFg: string;
  // 夜画面の「役割ゲート」専用（白地×濃ローズ）。夜空の上に置く白いカードとして
  // 使い、行き先が昼テーマであることを入口の色で予告する。
  // 白地画面（昼テーマ）では使わない — 白地に白は成立しないため。
  // 両テーマ同値にしてあるのは、この色が背景テーマではなく行き先を表すから。
  dayGateBg: string;
  dayGateInk: string;
  dayGatePressed: string;
  // 装飾・非対話・非情報のブランドアクセント。ここに情報を載せない
  // （色を白に置き換えても意味が変わらないものだけに使う）
  brand: string;
  star: string;
  // 星のうちアクセント粒の色
  starAccent: string;
  starScale: number;

  white: string;
  black: string;
  muted: string;
};

// ---------- 夜（歩行側。v2 からの値の変更なし） ----------
export const darkColor: ThemeColor = {
  // 背景
  night: [palette.night1, palette.night2, palette.night3],
  pressed: ['#735909', '#B38C00', '#E6BF1A'], // ホールド押下中の昼

  // 4役割
  action: palette.gold,       // 主行動・ブランドの光（旧 yellow）
  info: palette.sky,          // 情報・AI・リンク。枠線/塗り/20pt以上の文字
  infoText: palette.skyDeep,  // 情報系の 19pt 以下の文字はこちら（AA確保）
  safe: palette.green,        // 安否OKのみ
  danger: palette.red,        // 緊急のみ
  caution: palette.goldDeep,  // 一次注意（異常検知・超過・caution枠）のみ
  cautionFill: palette.goldDeep,

  // 派生（意味固定）
  dangerActive: palette.redActive,
  dangerText: palette.redText,
  inkOnAccent: palette.navyInk, // gold/sky/green ボタン上の文字色
  actionInk: palette.black,     // action 地のボタン文字（既存 SkyButton の値）
  safeInk: palette.black,       // safe 地のボタン文字（同上）

  // テキスト（夜空上）
  text: palette.white,
  textSub: 'rgba(255,255,255,0.7)',   // 補足。これ未満の濃度を本文に使わない
  textFaint: 'rgba(255,255,255,0.5)', // 非活性・装飾のみ（情報を載せない）

  // 面・線
  glass: 'rgba(255,255,255,0.10)',
  glassStroke: 'rgba(255,255,255,0.20)',
  raised: 'rgba(255,255,255,0.15)',   // secondary ボタン・チップ地
  raisedStroke: 'rgba(255,255,255,0.35)',
  cardNavy: palette.cardNavy,
  overlayScrim: 'rgba(0,0,0,0.6)',
  criticalScrim: 'rgba(140,20,26,0.97)', // CheckOverlay critical（既存値固定）

  qrFg: palette.qrNavy,
  dayGateBg: dayPalette.day1,   // #FFFFFF（night1 上 18.78:1 / night3 上 11.48:1）
  dayGateInk: dayPalette.rose,  // #C2185B（白地 5.87:1。白地の内側でのみ使う）
  dayGatePressed: dayPalette.day3, // #FFE7F0（押下中の地。rose 文字 5.02:1 で AA 維持）
  // 夜空紺の上で使えるローズは2値だけ（rose #C2185B は night3 上 1.95:1 で不可）。
  // 面・枠・大きい字形は roseSoft、点・小さな装飾は rosePale。
  brand: dayPalette.roseSoft,      // #E9538A（夜空上 4.6〜5.4:1）
  star: palette.white,
  starAccent: dayPalette.rosePale, // #F3A9C8（夜空上 8.6〜10.1:1）
  starScale: 1,

  white: palette.white,
  black: palette.black,
  muted: 'rgba(255,255,255,0.5)',
};

// ---------- 昼（見守り側。design-pink-proposal §1.2 の対応表どおり） ----------
export const lightColor: ThemeColor = {
  night: [dayPalette.day1, dayPalette.day2, dayPalette.day3],
  pressed: ['#F9D2E2', dayPalette.rosePale, '#EC7FAE'],

  action: dayPalette.rose,
  info: dayPalette.blue,
  infoText: dayPalette.blue, // 昼では info と同値でよい（分離不要）
  safe: dayPalette.green,
  danger: dayPalette.vermilion,
  caution: dayPalette.amber,      // 文字・枠
  cautionFill: dayPalette.amberFill, // 塗り（上は ink 文字）

  dangerActive: dayPalette.vermilionDeep,
  dangerText: dayPalette.vermilionDeep,
  inkOnAccent: dayPalette.day1, // rose/blue/green 地の上は白文字
  actionInk: dayPalette.day1,
  safeInk: dayPalette.day1,

  text: dayPalette.ink,
  textSub: dayPalette.inkSub,
  textFaint: dayPalette.inkFaint,

  glass: 'rgba(194,24,91,0.06)',
  glassStroke: 'rgba(194,24,91,0.22)',
  raised: 'rgba(194,24,91,0.11)',
  raisedStroke: 'rgba(194,24,91,0.38)',
  cardNavy: dayPalette.day1,
  overlayScrim: 'rgba(59,37,48,0.45)',
  criticalScrim: 'rgba(140,20,26,0.97)', // 緊急表現はテーマ非依存で固定

  qrFg: dayPalette.roseDeep,
  dayGateBg: dayPalette.day1,
  dayGateInk: dayPalette.rose,
  dayGatePressed: dayPalette.day3,
  brand: dayPalette.rose,
  star: dayPalette.rose,
  // 昼は star と同値。アクセント粒を作らず、描画結果を現行のまま保つ
  starAccent: dayPalette.rose,
  // 昼の星は baseOpacity を約半分に（提案 §4 の上限 0.3）。明滅星のピークが
  // 0.8 なので、0.37 を掛けて 0.296 に収める
  starScale: 0.37,

  white: palette.white,
  black: palette.black,
  muted: dayPalette.inkFaint,
};

export type ThemeMode = 'dark' | 'light';

export const themeColors: Record<ThemeMode, ThemeColor> = {
  dark: darkColor,
  light: lightColor,
};

// 既定テーマ（歩行側 = 夜）。テーマ非対応の既存 import はこれを見続ける。
export const color = darkColor;

// ---------- 形状・余白・文字（design-review C-4 の実測ベース） ----------
// card: 18 は昼側のカードで最も多く直書きされていた半径。値を足したのではなく
// 実態に名前を付けたもの。
export const radius = { sm: 12, md: 16, card: 18, lg: 22, xl: 28, pill: 999 } as const;
export const space  = { xs: 6, sm: 10, md: 14, lg: 22, xl: 28 } as const;
// lead: 22 は主役円の中の文字とホールドの見出し。title 20 だと円内で弱く、
// hero 28 は fontScale 1.3x で円からはみ出すため、どちらにも寄せられない。
export const font   = { caption: 12, body: 15, sub: 17, title: 20, lead: 22, hero: 28, jumbo: 38 } as const;

export const dim = (hex: string, alpha: number) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
};
