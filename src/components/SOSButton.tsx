import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Animated } from 'react-native';
import { Icon } from './Icon';
import { colors } from '../theme/colors';
import { color, font, radius } from '../theme/tokens';

// SOSボタン（issue #2）。
// - 発信中はハローが脈動して「いまSOS中」であることをひと目で示す
// - 発信中はもう一度タップすると「とりけし」になる。ミュートボタンの斜線の
//   ように、ボタン下のラベルで on/off できることを直感的に伝える
// - アラームが鳴っている間は「音だけ止める」チップを出す
//   （周囲への周知が済んだあと、SOSは続けたまま静かにできる）
export function SOSButton({
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

  const haloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] });
  const haloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] });

  return (
    <View style={styles.wrap}>
      <View style={styles.btnWrap}>
      {active && (
        <Animated.View
          pointerEvents="none"
          style={[styles.halo, { opacity: haloOpacity, transform: [{ scale: haloScale }] }]}
        />
      )}
      <Pressable
        style={[styles.btn, active && styles.btnActive]}
        hitSlop={10}
        onPress={active ? onCancel : onTrigger}
        accessibilityRole="button"
        accessibilityLabel={active ? 'SOSをとりけす' : 'SOSを見守りの人に送る'}
      >
        <Text style={styles.sosText}>SOS</Text>
        {active && <Text style={styles.stateText}>発信中</Text>}
      </Pressable>
      </View>
      {/* ラベルは常時出す。子ども・高齢者は赤い丸だけでは用途が分からず、
          いざというとき「これを押せばいい」に到達できない（F-5） */}
      <Text style={[styles.caption, active && styles.captionActive]}>
        {active ? 'タップで とりけす' : 'こまったら おす'}
      </Text>
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
  // 円ではなく横長のカプセル。端末の文字サイズを上げても中身が切れないよう、
  // 高さは最低値＋余白で決める（円のままだと拡大した文字がはみ出す）。
  // 赤・白枠・SOSの文字という組み合わせはこのボタンだけなので、
  // 「SOSと同形状のピンク円形を作らない」規約はカプセル化後も成立する。
  wrap: { alignItems: 'center', gap: 3, minWidth: 96, maxWidth: 132 },
  halo: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    minHeight: 64,
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.red,
  },
  btnWrap: { alignSelf: 'stretch' },
  btn: {
    minHeight: 64, paddingVertical: 8, paddingHorizontal: 14,
    borderRadius: radius.pill, backgroundColor: colors.red,
    alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.white,
  },
  btnActive: {
    backgroundColor: color.dangerActive,
    borderColor: colors.yellow,
    shadowColor: colors.red, shadowOpacity: 0.9, shadowRadius: 10, shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  sosText: { color: colors.white, fontWeight: '800', fontSize: 19, textAlign: 'center' },
  stateText: { color: colors.yellow, fontWeight: '800', fontSize: 11, textAlign: 'center' },
  caption: { fontSize: font.caption, fontWeight: '700', color: colors.white, textAlign: 'center' },
  captionActive: { color: colors.white },
  muteChip: {
    marginTop: 2, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)',
  },
  muteChipRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  muteChipText: { fontSize: 11, fontWeight: '700', color: colors.white },
});
