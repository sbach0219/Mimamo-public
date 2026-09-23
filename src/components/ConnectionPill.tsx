import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeContext';

export type PillState = 'online' | 'unstable' | 'offline';

const label: Record<PillState, string> = {
  online: 'つながっています',
  unstable: 'つうしんが不安定です',
  offline: 'インターネットがありません',
};

export function ConnectionPill({ state }: { state: PillState }) {
  const { mode, color } = useTheme();
  const light = mode === 'light';
  // 昼は淡い桜地に ink 文字。夜は従来どおり黒すりガラス地に白文字。
  // 「不安定」は昼だと action がブランドピンクになってしまうため caution 塗りを使う。
  const dot: Record<PillState, string> = {
    online: color.safe,
    unstable: light ? color.cautionFill : color.action,
    offline: color.danger,
  };
  return (
    <View
      style={[
        styles.pill,
        {
          backgroundColor: light ? color.glass : 'rgba(0,0,0,0.35)',
          borderColor: light ? color.glassStroke : 'rgba(255,255,255,0.15)',
        },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: dot[state], shadowColor: dot[state] }]} />
      <Text style={[styles.label, { color: light ? color.textSub : 'rgba(255,255,255,0.9)' }]}>{label[state]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  dot: { width: 8, height: 8, borderRadius: 4, shadowOpacity: 0.8, shadowRadius: 3 },
  label: { fontSize: 12, fontWeight: '600' },
});
