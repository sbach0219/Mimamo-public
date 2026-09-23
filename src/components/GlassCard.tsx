import React from 'react';
import { View, ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeContext';

// elevated: 単なる入れ物としてのカード。枠を持たせず面と影で立たせる（昼は白＋影）。
// 枠は「選択状態を持つ要素」のために取っておき、枠の意味を薄めない。
export function GlassCard({ children, style, radius = 20, elevated = false }: {
  children: React.ReactNode;
  style?: ViewStyle;
  radius?: number;
  elevated?: boolean;
}) {
  const { color } = useTheme();
  const surface: ViewStyle = elevated
    ? {
        backgroundColor: color.cardNavy,
        shadowColor: color.black,
        shadowOpacity: 0.1,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 2,
      }
    : { backgroundColor: color.glass, borderWidth: 1, borderColor: color.glassStroke };

  return <View style={[surface, { borderRadius: radius }, style]}>{children}</View>;
}
