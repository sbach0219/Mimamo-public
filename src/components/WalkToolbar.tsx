import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Icon } from './Icon';
import { color, dim, radius } from '../theme/tokens';

// 通信状態や本文に重ねない。SOS はホールド画面だけ既存の部品を渡す。
export function WalkToolbar({ onCall, onChat, sos }: {
  onCall: () => void;
  onChat: () => void;
  sos?: React.ReactNode;
}) {
  return (
    <View style={styles.toolbar}>
      {sos ?? <Text style={styles.brand}>みまも</Text>}
      <View style={styles.actions}>
        <Pressable
          onPress={onCall}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="警察や消防に緊急通報する"
        >
          <Icon name="phone" size={20} />
          <Text style={styles.label}>でんわ</Text>
        </Pressable>
        <Pressable
          onPress={onChat}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="見守りの人とチャットする"
        >
          <Icon name="chat" size={20} />
          <Text style={styles.label}>チャット</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    flexWrap: 'wrap', gap: 12, paddingHorizontal: 20, paddingVertical: 8,
  },
  brand: { fontSize: 22, fontWeight: '800', color: color.text },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: {
    minHeight: 64, minWidth: 64, paddingHorizontal: 12, paddingVertical: 8,
    alignItems: 'center', justifyContent: 'center', gap: 4,
    borderRadius: radius.md, backgroundColor: dim(color.white, 0.06),
    borderWidth: 1, borderColor: color.glassStroke,
  },
  pressed: { backgroundColor: color.raised },
  label: { fontSize: 17, fontWeight: '600', color: color.text },
});
