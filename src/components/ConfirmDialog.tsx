import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Modal, Animated, ScrollView, useWindowDimensions } from 'react-native';
import { SkyButton } from './SkyButton';
import { Icon, type IconName } from './Icon';
import { dim, type ThemeColor } from '../theme/tokens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useThemedStyles } from '../theme/ThemeContext';

// 取り返しのつかない操作の確認。両部の確定仕様（persona-ux-final-proposal §4-A/§4-B）で
// 「2択の大ボタンのみ・スライドや小ボタンの確認UIは禁止」と決まっているため、
// OS の Alert ではなくこの部品を使う（大ボタン・ひらがな・自動クローズが必要なため）。
// 既定（安全側）は左のキャンセル側で、視覚的にも主ボタンにする。
export function ConfirmDialog({
  visible,
  title,
  body,
  icon,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
  autoCancelMs,
  busy = false,
  errorText,
}: {
  visible: boolean;
  title: string;
  body?: string;
  icon?: IconName;
  cancelLabel: string;   // 安全側・既定
  confirmLabel: string;  // 実行側（取り返しがつかない方）
  onCancel: () => void;
  onConfirm: () => void;
  // 開いたまま放置されたときに、安全側へ倒して自動で閉じるまでの時間
  autoCancelMs?: number;
  busy?: boolean;
  // 失敗の理由はダイアログを閉じずにこの中で伝える（別の Alert を重ねない）
  errorText?: string | null;
}) {
  const { color } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const enter = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    enter.setValue(0);
    Animated.spring(enter, { toValue: 1, useNativeDriver: true, speed: 16, bounciness: 4 }).start();
  }, [visible, enter]);

  // 放置での自動クローズ。歩いている人がダイアログを開いたまま歩き続けると、
  // その間ずっと見守りが止まる（F-2 では滞在上限として必須）。
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    if (!visible || !autoCancelMs) return;
    const t = setTimeout(() => onCancelRef.current(), autoCancelMs);
    return () => clearTimeout(t);
  }, [visible, autoCancelMs]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      {/* 文字を大きくしてカードが伸びたとき、ノッチやホームバーに掛からないようにする */}
      <View style={[styles.scrim, { paddingTop: insets.top + 28, paddingBottom: insets.bottom + 28 }]}>
        <Animated.View
          style={[
            styles.card,
            // 文字を大きくした端末でもボタンに手が届くよう、本文側をスクロールさせる
            { maxHeight: windowHeight - insets.top - insets.bottom - 56 },
            { opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] },
          ]}
          accessibilityViewIsModal
        >
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            {icon && <Icon name={icon} size={56} />}
            <Text style={styles.title}>{title}</Text>
            {body ? <Text style={styles.body}>{body}</Text> : null}
            {errorText ? <Text style={styles.error}>{errorText}</Text> : null}
          </ScrollView>
          <View style={styles.buttons}>
            <SkyButton title={cancelLabel} variant="primary" onPress={onCancel} style={{ width: '100%' }} />
            <SkyButton
              title={confirmLabel}
              variant="danger"
              icon={<Icon name="warning" size={18} tint={color.white} />}
              loading={busy}
              onPress={onConfirm}
              style={{ width: '100%' }}
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  scrim: {
    flex: 1, backgroundColor: c.overlayScrim, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28,
  },
  card: {
    width: '100%', maxWidth: 420, gap: 12,
    paddingVertical: 28, paddingHorizontal: 22, borderRadius: 28,
    backgroundColor: c.cardNavy, borderWidth: 1.5, borderColor: dim(c.info, 0.4),
  },
  scrollContent: { alignItems: 'center', gap: 12 },
  title: { fontSize: 24, fontWeight: '800', color: c.text, textAlign: 'center' },
  error: { fontSize: 15, lineHeight: 23, fontWeight: '600', color: c.dangerText, textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 24, color: c.textSub, textAlign: 'center' },
  buttons: { alignSelf: 'stretch', gap: 10, marginTop: 6 },
});
