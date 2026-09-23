import React, { useMemo } from 'react';
import { SvgXml } from 'react-native-svg';
import { ICON_XML, ICON_XML_DAY, type IconName } from '../icons/icons.generated';
import { useTheme } from '../theme/ThemeContext';

export type { IconName };

const THEME_INK = { dark: /#FFFFFF/g, light: /#3B2530/g } as const;
const THEME_ACCENT = { dark: /#FFD60A/g, light: /#C2185B/g } as const;

// みまものオリジナルアイコン（docs/icon-set.md）。
// 状態の意味（緊急=赤など）はアイコンではなく背景・カード側が持つので、
// 色はテーマ2値（夜=白+金 / 昼=ink+rose）に固定。減光は opacity で調整する。
// アクセント地（rose/blue/green のベタ塗りボタン）の上に置くときだけ tint で
// 単色化する。昼の ink アイコンをそのまま載せると 3:1 を割るため。
// 線が潰れるため size は 14 未満にしない。
export function Icon({
  name,
  size = 24,
  opacity,
  tint,
}: {
  name: IconName;
  size?: number;
  opacity?: number;
  tint?: string;
}) {
  const { mode } = useTheme();
  const xml = useMemo(() => {
    const base = mode === 'light' ? ICON_XML_DAY[name] : ICON_XML[name];
    if (!tint) return base;
    return base.replace(THEME_INK[mode], tint).replace(THEME_ACCENT[mode], tint);
  }, [mode, name, tint]);
  return <SvgXml xml={xml} width={size} height={size} opacity={opacity} />;
}
