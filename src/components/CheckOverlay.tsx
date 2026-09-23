import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SkyButton } from './SkyButton';
import { Icon, type IconName } from './Icon';
import { colors, dim } from '../theme/colors';

// 画面の色は「見守りに異常として伝わっているか」だけで決まる。
// caution = まだ伝えていない本人への一次確認、critical = 伝達済み／SOS。
// 通知チャンネル（alert）とは独立した軸なので、tone と通知の強さは一致しない。
export type CheckTone = 'caution' | 'critical';

// 歩く人に出す確認オーバーレイ。センチネルの「本人確認」と「安否確認」で共用。
export function CheckOverlay({
  tone,
  icon = 'warning',
  title,
  sub,
  remaining,
  safeLabel = 'だいじょうぶ！',
  onSafe,
  secondaryLabel,
  onSecondary,
}: {
  tone: CheckTone;
  icon?: IconName;
  title: string;
  sub: string;
  remaining?: number; // 表示する残り秒数（任意）
  safeLabel?: string;
  onSafe: () => void;
  secondaryLabel: string;
  onSecondary: () => void;
}) {
  const caution = tone === 'caution';
  // 全画面が1フレームで真紅／紺に変わると「故障した」ように見えるため、
  // 立ち上がりだけ 150ms 丸める。文言・色・二段階設計には触れない。
  // ハプティクスはここでは鳴らさない: 表示のきっかけ（MainScreen.triggerAlert の
  // haptics.error / useSentinel.startLocalCheck の haptics.warning）で必ず鳴っており、
  // ここで足すと二重になる。
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 150, useNativeDriver: true }).start();
  }, [fade]);

  return (
    <Animated.View style={[styles.overlay, caution ? styles.overlayCaution : styles.overlayCritical, { opacity: fade }]}>
      <SafeAreaView style={styles.inner}>
        <View style={[styles.card, caution && styles.cardCaution]}>
          <Icon name={icon} size={88} />
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.sub}>{sub}</Text>
          {typeof remaining === 'number' && (
            <Text style={styles.remaining}>あと {remaining} びょう</Text>
          )}
        </View>
        <SkyButton title={safeLabel} variant="success" height={76} style={{ width: '85%' }} onPress={onSafe} />
        <Pressable style={styles.secondary} onPress={onSecondary}>
          <Text style={styles.secondaryText}>{secondaryLabel}</Text>
        </Pressable>
      </SafeAreaView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  overlayCritical: { backgroundColor: 'rgba(140,20,26,0.97)' },
  overlayCaution: { backgroundColor: dim(colors.night[0], 0.97) },
  inner: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 22, paddingHorizontal: 32 },
  card: { alignSelf: 'stretch', alignItems: 'center', gap: 22 },
  cardCaution: {
    paddingVertical: 28, paddingHorizontal: 24, borderRadius: 28,
    backgroundColor: colors.glass, borderWidth: 1, borderColor: dim(colors.orange, 0.5),
  },
  title: { fontSize: 38, fontWeight: '800', color: colors.white, textAlign: 'center' },
  sub: { fontSize: 17, color: 'rgba(255,255,255,0.85)', textAlign: 'center' },
  remaining: { fontSize: 18, fontWeight: '700', color: colors.yellow },
  secondary: {
    paddingHorizontal: 20, paddingVertical: 12, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)',
  },
  secondaryText: { color: colors.white, fontWeight: '600' },
});
