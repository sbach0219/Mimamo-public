import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Animated } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Icon } from './Icon';
import { color, font, radius, space } from '../theme/tokens';

// センチネル画面の中央 240pt の SOS 円。
// 左上カプセルの SOSButton とは別部品にしてある。SOSButton は出荷済みで
// 色・挙動の変更禁止リストに載っており、共通化するとそちらに手が入るため
// （ホールド画面では SOSButton が現役なので、両方が並存する）。
const SIZE = 240;
// 破線リングは円の内側 12pt に置く
const RING_INSET = 12;

export function HeroSOSButton({
  active,
  onTrigger,
  onCancel,
  alarmSounding = false,
  onMuteAlarm,
}: {
  active: boolean;
  onTrigger: () => void;
  onCancel: () => void;
  alarmSounding?: boolean;
  onMuteAlarm?: () => void;
}) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  const haloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] });
  const haloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] });
  const ink = active ? color.white : color.actionInk;

  return (
    <View style={styles.wrap}>
      <View style={styles.circleWrap}>
        {active && (
          <Animated.View
            pointerEvents="none"
            style={[styles.halo, { opacity: haloOpacity, transform: [{ scale: haloScale }] }]}
          />
        )}
        <Pressable
          style={[styles.circle, active && styles.circleActive]}
          onPress={active ? onCancel : onTrigger}
          accessibilityRole="button"
          accessibilityLabel={active ? 'SOSをとりけす' : 'SOSを見守りの人に送る'}
        >
          <Svg width={SIZE} height={SIZE} style={StyleSheet.absoluteFill} pointerEvents="none">
            <Circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={SIZE / 2 - RING_INSET}
              fill="none"
              stroke={ink}
              strokeOpacity={active ? 0.85 : 1}
              strokeWidth={2.5}
              strokeDasharray="9 7"
            />
          </Svg>
          <Icon name="sos" size={56} tint={ink} />
          {/* 円は物理寸法が主役なので、中の文字は倍率を 1.3 で止めて行数を固定する */}
          <Text style={[styles.label, { color: ink }]} maxFontSizeMultiplier={1.3}>
            {active ? 'タップで\nとりけす' : 'こまったら\nおす'}
          </Text>
          {active && (
            <Text style={styles.state} maxFontSizeMultiplier={1.3}>SOS はっしんちゅう</Text>
          )}
        </Pressable>
      </View>
      {alarmSounding && onMuteAlarm && (
        <Pressable
          style={styles.muteChip}
          onPress={onMuteAlarm}
          accessibilityRole="button"
          accessibilityLabel="アラームの音だけ止める。SOSは続く"
        >
          <View style={styles.muteChipRow}>
            <Icon name="mute" size={14} />
            <Text style={styles.muteChipText}>音だけ止める</Text>
          </View>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.sm },
  circleWrap: { width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
  halo: {
    position: 'absolute',
    width: SIZE, height: SIZE, borderRadius: SIZE / 2,
    backgroundColor: color.danger,
  },
  circle: {
    width: SIZE, height: SIZE, borderRadius: SIZE / 2,
    alignItems: 'center', justifyContent: 'center', gap: space.xs,
    paddingHorizontal: 20,
    backgroundColor: color.action,
  },
  circleActive: { backgroundColor: color.dangerActive },
  label: {
    fontSize: font.lead, fontWeight: '800', lineHeight: 28, textAlign: 'center',
  },
  // 白 on #FF1F14 は 3.85:1。17pt bold（22.7px）以上なら「大きい文字」扱いで
  // 3:1 に合格する。これ未満に下げないこと
  state: { fontSize: font.sub, fontWeight: '800', color: color.white, textAlign: 'center' },
  muteChip: {
    paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.pill,
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.raisedStroke,
  },
  muteChipRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  muteChipText: { fontSize: font.caption, fontWeight: '700', color: color.text },
});
