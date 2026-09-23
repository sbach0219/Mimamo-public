import React, { useEffect, useRef, useMemo } from 'react';
import { View, StyleSheet, Animated, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SvgXml } from 'react-native-svg';
import { useTheme } from './ThemeContext';

// ===== 空のグラデーション背景（夜＝紺 / 昼＝白×淡ピンク）=====
export function NightBackground({ pressed = false }: { pressed?: boolean }) {
  const { color } = useTheme();
  return (
    <LinearGradient
      colors={pressed ? color.pressed : color.night}
      start={{ x: 0.5, y: 0 }}
      end={{ x: 0.5, y: 1 }}
      style={StyleSheet.absoluteFill}
    />
  );
}

// ===== 星 =====
// 大半は静止させ、明滅するのは先頭6個だけにする。常駐アニメーションを
// 減らして印象を静かにし、JSスレッドと電池の負荷も下げる狙い。
type StarDef = {
  x: number; y: number; size: number; baseOpacity: number;
  animated: boolean; duration: number; delay: number;
};

const ANIMATED_STARS = 6;
// そのうち先頭2粒だけをブランド色にする。アイコン〜昼〜夜を繋ぐ最小の糸で、
// 3粒以上にすると偶然固まったときに「桃色の空」に見えて夜空の世界観を侵食する。
const ACCENT_STARS = 2;
// 昼の星。形が読める大きさまで拡大し、そのぶん数を絞る
const DAY_STARS = 8;
const DAY_STAR_SIZE: [number, number] = [10, 16];
const NIGHT_STAR_SIZE: [number, number] = [1.5, 3.5];

function makeStars(count: number, [minSize, maxSize]: [number, number]): StarDef[] {
  return Array.from({ length: count }, (_, i) => {
    const animated = i < ANIMATED_STARS;
    return {
      x: Math.random(),
      y: Math.random(),
      size: minSize + Math.random() * (maxSize - minSize),
      baseOpacity: animated ? 0.5 + Math.random() * 0.3 : 0.25 + Math.random() * 0.3,
      animated,
      duration: 4000 + Math.random() * 2000,
      delay: Math.random() * 6000,
    };
  });
}

// 昼の星は四芒星の形で描く。白地に小さな丸を撒くと「画面の汚れ」に見えて
// 意図が伝わらなかったため（実機スクショで確認）。形が読める最小サイズまで
// 大きくし、そのぶん数を減らす。アイコンの✦・夜空の星と同じ形になる。
const FOUR_POINT_STAR =
  'M12 3.4 Q12 12 20.6 12 Q12 12 12 20.6 Q12 12 3.4 12 Q12 12 12 3.4 Z';

export function starGlyph(tint: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${FOUR_POINT_STAR}" fill="${tint}"/></svg>`;
}

function StarShape({ def, w, h, tint, shape, opacity }: {
  def: StarDef; w: number; h: number; tint: string; shape: 'dot' | 'star'; opacity: number;
}) {
  if (shape === 'star') {
    return (
      <View style={{ position: 'absolute', left: def.x * w, top: def.y * h, opacity }}>
        <SvgXml xml={starGlyph(tint)} width={def.size} height={def.size} />
      </View>
    );
  }
  return <View style={{ ...starLayout(def, w, h, tint), opacity }} />;
}

function starLayout(def: StarDef, w: number, h: number, tint: string) {
  return {
    position: 'absolute' as const,
    left: def.x * w,
    top: def.y * h,
    width: def.size,
    height: def.size,
    borderRadius: def.size / 2,
    backgroundColor: tint,
  };
}

function TwinklingStar({ def, w, h, tint, scale, shape }: {
  def: StarDef; w: number; h: number; tint: string; scale: number; shape: 'dot' | 'star';
}) {
  const anim = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: def.duration, delay: def.delay, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.5, duration: def.duration, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [anim, def]);

  const opacity = Animated.multiply(anim, def.baseOpacity * scale);
  if (shape === 'star') {
    return (
      <Animated.View style={{ position: 'absolute', left: def.x * w, top: def.y * h, opacity }}>
        <SvgXml xml={starGlyph(tint)} width={def.size} height={def.size} />
      </Animated.View>
    );
  }
  return <Animated.View style={{ ...starLayout(def, w, h, tint), opacity }} />;
}

// 星の色と濃さはテーマ既定を使う。明示指定したいときだけ prop で上書きする。
export function StarField({ opacity = 1, color: tintProp, scale: scaleProp }: {
  opacity?: number;
  color?: string;
  scale?: number;
}) {
  const { color, mode } = useTheme();
  const tint = tintProp ?? color.star;
  // 外から色を明示指定されたときは、アクセント粒もその色に倒す
  const accentTint = tintProp ?? color.starAccent;
  const scale = scaleProp ?? color.starScale;
  const { width, height } = useWindowDimensions();
  // 昼は形が読めるところまで大きくし（10〜16px）、そのぶん8個に絞る。
  // 夜は従来どおり 1.5〜3.5px の点を24個（見た目・負荷とも不変）。
  const light = mode === 'light';
  const count = light ? DAY_STARS : 24;
  const sizeRange = light ? DAY_STAR_SIZE : NIGHT_STAR_SIZE;
  const shape: 'dot' | 'star' = light ? 'star' : 'dot';
  const stars = useMemo(() => makeStars(count, sizeRange), [count, sizeRange]);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }]}>
      {stars.map((s, i) => {
        // 先頭2粒は必ず明滅星（ANIMATED_STARS が6のため）
        const starTint = i < ACCENT_STARS ? accentTint : tint;
        return s.animated ? (
          <TwinklingStar key={i} def={s} w={width} h={height} tint={starTint} scale={scale} shape={shape} />
        ) : (
          <StarShape
            key={i} def={s} w={width} h={height} tint={starTint} shape={shape}
            opacity={s.baseOpacity * scale}
          />
        );
      })}
    </View>
  );
}

// 画面全体を夜空背景＋星で包む共通ラッパー
export function SkyScreen({ children, pressed = false, starOpacity = 1 }: {
  children: React.ReactNode;
  pressed?: boolean;
  starOpacity?: number;
}) {
  return (
    <View style={{ flex: 1 }}>
      <NightBackground pressed={pressed} />
      <StarField opacity={starOpacity} />
      {children}
    </View>
  );
}
