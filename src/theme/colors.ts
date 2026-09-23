// =============================================================
// Mimamo（みまも）色トークン互換レイヤー
// 新規コードは theme/tokens.ts を直接 import すること
// =============================================================

import { color, dim } from './tokens';

export { dim };

export const colors = {
  night: color.night,
  pressed: color.pressed,
  yellow: color.action,
  orange: color.caution,
  red: color.danger,
  green: color.safe,
  sky: color.info,
  skyDeep: color.infoText,
  white: color.white,
  black: color.black,
  glass: color.glass,
  glassStroke: color.glassStroke,
  muted: color.muted,
  // cyan / blue / purple は定義しない（意図的削除）
} as const;
