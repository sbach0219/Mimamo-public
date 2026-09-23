import React, { useId } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

// 主役円の背後に敷く放射光。
// iOS の shadow は半径 24 が実質の上限で、Android では色つきの影を描けない。
// 両 OS で同じ光を出すために Svg の放射グラデーションで描く。
// 情報を持たない装飾なので pointerEvents は常に none。
export function Glow({
  size,
  color,
  opacity = 0.35,
}: {
  size: number;
  color: string;
  opacity?: number;
}) {
  const d = size * 1.8;
  // useId() は ":r0:" のようにコロンを含み、SVG の url(#id) 参照では使えない
  const id = `glow-${useId().replace(/:/g, '')}`;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
      <Svg width={d} height={d}>
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={color} stopOpacity={opacity} />
            <Stop offset="55%" stopColor={color} stopOpacity={opacity * 0.35} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={d / 2} cy={d / 2} r={d / 2} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
