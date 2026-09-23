import React from 'react';
import { View, StyleSheet } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { starGlyph } from '../theme/Background';
import { color } from '../theme/tokens';

// 主役円の周囲の四芒星。静止させる（明滅させない）。
// 常駐アニメーションは夜空の明滅星 6 個で上限（design-conventions §2-3）に達しており、
// ここで増やすと「静かな夜」の印象が崩れる。
//
// 座標は箱に対する比率で、ランダムにしない。ランダム配置だと見出しや主役円に
// 重なる並びが出る。いずれも中心から半径 0.28（＝主役円の外側）に置いてある。
type Spark = { x: number; y: number; size: number; opacity: number; tint: 'accent' | 'action' | 'white' };

const SPARKS: Spark[] = [
  { x: 0.08, y: 0.22, size: 20, opacity: 0.60, tint: 'accent' },
  { x: 0.90, y: 0.15, size: 14, opacity: 0.50, tint: 'action' },
  { x: 0.95, y: 0.58, size: 12, opacity: 0.45, tint: 'accent' },
  { x: 0.05, y: 0.70, size: 12, opacity: 0.40, tint: 'white' },
  { x: 0.80, y: 0.88, size: 16, opacity: 0.40, tint: 'accent' },
  { x: 0.16, y: 0.92, size: 10, opacity: 0.35, tint: 'action' },
];

const TINT = {
  accent: color.starAccent,
  action: color.action,
  white: color.white,
} as const;

export function Sparkles({ box }: { box: number }) {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
      <View style={{ width: box, height: box }}>
        {SPARKS.map((s, i) => (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: s.x * box - s.size / 2,
              top: s.y * box - s.size / 2,
              opacity: s.opacity,
            }}
          >
            <SvgXml xml={starGlyph(TINT[s.tint])} width={s.size} height={s.size} />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
