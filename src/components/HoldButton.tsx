import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Animated, type ViewStyle } from 'react-native';
import { color, dim, font, radius } from '../theme/tokens';
import { haptics } from '../lib/haptics';

// 「押し続けて確定する」操作の共通部品。
// 単純タップにしない理由は、歩行画面が点灯したままでポケットや手の中の接触が
// 現実にあるため。長押しには進行の可視化を必須とする規約（提案書 §0-Q2）に従い、
// 押しているあいだバーが伸びる。満了しても確定はせず、呼び出し側が確認を出す。
export function HoldButton({
  label,
  holdingLabel,
  durationMs,
  onComplete,
  tone = 'plain',
  style,
  accessibilityLabel,
  accessibilityHint,
}: {
  label: string;
  holdingLabel: string;
  durationMs: number;
  onComplete: () => void;
  tone?: 'plain' | 'safe';
  style?: ViewStyle;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const [holding, setHolding] = useState(false);
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  const start = () => {
    setHolding(true);
    haptics.tap();
    progress.setValue(0);
    animRef.current = Animated.timing(progress, {
      toValue: 1,
      duration: durationMs,
      useNativeDriver: false,
    });
    animRef.current.start(({ finished }) => {
      if (!finished) return;
      setHolding(false);
      progress.setValue(0);
      haptics.success();
      onComplete();
    });
  };

  const cancel = () => {
    animRef.current?.stop();
    animRef.current = null;
    setHolding(false);
    Animated.timing(progress, { toValue: 0, duration: 120, useNativeDriver: false }).start();
  };

  const width = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <Pressable
      onPressIn={start}
      onPressOut={cancel}
      style={[styles.wrap, style]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint ?? '長押しすると確認が出ます'}
    >
      <View style={[styles.track, holding && styles.trackHolding, tone === 'safe' && styles.trackSafe]}>
        <Animated.View style={[styles.fill, tone === 'safe' && styles.fillSafe, { width }]} />
        <Text style={styles.label}>{holding ? holdingLabel : label}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // 文字を大きくしても画面幅を超えないようにする（親は alignItems:'center'）
  wrap: { minHeight: 44, justifyContent: 'center', maxWidth: '100%' },
  track: {
    minHeight: 36, paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: radius.pill, overflow: 'hidden', justifyContent: 'center',
    backgroundColor: color.glass,
    borderWidth: 1, borderColor: color.raisedStroke,
  },
  trackHolding: { borderColor: color.textFaint },
  // 到着は safe（緑）。スライダーと同じ意味色にそろえる
  trackSafe: { backgroundColor: dim(color.safe, 0.14), borderColor: dim(color.safe, 0.55) },
  fill: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  fillSafe: { backgroundColor: dim(color.safe, 0.45) },
  // 「おわる」「おしたままで つたえる」は終端操作。13pt は小さい
  label: { fontSize: font.body, fontWeight: '700', color: color.text, textAlign: 'center' },
});
