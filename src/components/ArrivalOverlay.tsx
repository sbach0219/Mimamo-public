import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Polyline } from 'react-native-svg';
import { SkyButton } from './SkyButton';
import { Icon } from './Icon';
import { Glow } from './Glow';
import { Sparkles } from './Sparkles';
import { StarField } from '../theme/Background';
import { color as darkColorTokens, dim, font, radius, space, type ThemeColor, type ThemeMode } from '../theme/tokens';
import { useTheme, useThemedStyles } from '../theme/ThemeContext';

// full variant の主役円。放射光の箱は 176 * 1.8
const FULL_CIRCLE = 176;
const FULL_BOX = 317;

// 到着時のお祝いオーバーレイ。歩行側（夜）と見守り側（昼）で共用する。
// 文言は役割でトーンが違うため（歩行＝ひらがな分かち書き / 見守り＝漢字かな交じり）、
// 既定値は歩行側にし、見守り側は呼び出し側から差し替える。
export function ArrivalOverlay({
  onDone,
  title = 'ついたね！',
  sub = 'おつかれさま 🎉',
  note = '見守りの人に つたえたよ ✓',
  doneLabel = 'おわる',
  doneVariant = 'primary',
  variant = 'card',
}: {
  onDone: () => void;
  title?: string;
  sub?: string;
  note?: string;
  doneLabel?: string;
  doneVariant?: 'primary' | 'success';
  // full は夜（歩行側）専用の全画面表示。昼は card にフォールバックする
  variant?: 'card' | 'full';
}) {
  const styles = useThemedStyles(makeStyles);
  const { mode } = useTheme();
  const { width } = useWindowDimensions();
  // 感情のピークに 0.25 秒の「間」を作る。紙吹雪などは足さない（世界観に対して過剰）
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(enter, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 6 }).start();
  }, [enter]);

  const cardStyle = {
    opacity: enter,
    transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }],
  };

  if (variant === 'full' && mode === 'dark') {
    return (
      <View style={styles.full}>
        <LinearGradient
          colors={darkColorTokens.night}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <StarField />
        <Animated.View style={[styles.fullBody, cardStyle]}>
          <View style={styles.fullHero}>
            <Glow size={FULL_CIRCLE} color={darkColorTokens.action} opacity={0.35} />
            <Sparkles box={FULL_BOX} />
            <View style={styles.fullCircle}>
              {/* 丸チェックのアセットが無いので Svg で直に描く */}
              <Svg width={FULL_CIRCLE * 0.44} height={FULL_CIRCLE * 0.44} viewBox="0 0 100 100">
                <Polyline
                  points="18,52 40,74 82,26"
                  fill="none"
                  stroke={darkColorTokens.action}
                  strokeWidth={6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
            </View>
          </View>
          <Text style={styles.fullTitle}>{title}</Text>
          <Text style={styles.sub}>{sub}</Text>
          <Text style={styles.note}>{note}</Text>
          <SkyButton
            title={doneLabel}
            variant={doneVariant}
            style={{ width: Math.min(280, width - 64) }}
            onPress={onDone}
          />
        </Animated.View>
      </View>
    );
  }

  return (
    <View style={styles.overlayDim}>
      <Animated.View style={[styles.card, cardStyle]}>
        <Icon name="home" size={88} />
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.sub}>{sub}</Text>
        <Text style={styles.note}>{note}</Text>
        <SkyButton title={doneLabel} variant={doneVariant} style={{ width: 220 }} onPress={onDone} />
      </Animated.View>
    </View>
  );
}

const makeStyles = (c: ThemeColor, mode: ThemeMode) => {
  const light = mode === 'light';
  return StyleSheet.create({
    overlayDim: {
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: c.overlayScrim, alignItems: 'center', justifyContent: 'center',
    },
    card: {
      // 端末幅 375 で本文が2行に折れないよう、左右の余白は 24/24 まで詰める
      alignItems: 'center', gap: 14, paddingVertical: 40, paddingHorizontal: 24, marginHorizontal: 24,
      borderRadius: radius.xl, backgroundColor: c.cardNavy,
      // 到着＝このアプリの感情のピーク。夜側の枠と光だけをブランドのローズにして、
      // 見守る側が同時に見ている昼の到着画面と「祝いの色」を家族の2画面で揃える。
      // 行動（カード内の「おわる」ボタン）は金のまま＝祝いはローズ、行動は金の分担。
      borderWidth: 1.5, borderColor: light ? dim(c.safe, 0.4) : dim(c.brand, 0.45),
      shadowColor: light ? c.black : c.brand,
      shadowOpacity: light ? 0.12 : 0.35,
      shadowRadius: light ? 12 : 24,
      shadowOffset: { width: 0, height: light ? 4 : 0 },
      // Android の elevation 影は着色できないので、夜は光を足さない（iOS のみ）
      elevation: light ? 3 : 0,
    },
    title: { fontSize: 29, fontWeight: '800', color: c.text, textAlign: 'center' },
    sub: { fontSize: 17, color: light ? c.textSub : 'rgba(255,255,255,0.9)', textAlign: 'center' },
    note: { fontSize: font.body, fontWeight: '600', color: c.infoText, textAlign: 'center' },
    // 夜の全画面 variant。スクリムではなく空そのものを敷く
    full: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    fullBody: {
      flex: 1, alignItems: 'center', justifyContent: 'center',
      gap: space.md, paddingHorizontal: space.xl,
    },
    fullHero: {
      width: FULL_BOX, height: FULL_BOX, alignItems: 'center', justifyContent: 'center',
      marginBottom: space.xs,
    },
    fullCircle: {
      width: FULL_CIRCLE, height: FULL_CIRCLE, borderRadius: FULL_CIRCLE / 2,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.cardNavy, borderWidth: 6, borderColor: c.action,
    },
    // CheckOverlay の全画面見出しと同格（全画面の感情の瞬間は 38）
    fullTitle: { fontSize: font.jumbo, fontWeight: '800', color: c.action, textAlign: 'center' },
  });
};
