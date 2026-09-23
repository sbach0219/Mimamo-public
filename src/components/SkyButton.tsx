import React from 'react';
import { Pressable, Text, StyleSheet, ViewStyle, View, ActivityIndicator } from 'react-native';
import { radius, type ThemeColor } from '../theme/tokens';
import { useTheme } from '../theme/ThemeContext';

// danger は「取り返しのつかない操作」用。色だけに頼らないよう、呼び出し側で
// 警告アイコンと文言を必ず添えること（危険色の3点セット規約）。
// dayGate は「昼の世界（見守り側）の入口」。既存の watcher（info 色）は他画面で
// ナビゲーション用に現役なので、意味を変えずに新設する。
type Variant = 'primary' | 'watcher' | 'success' | 'secondary' | 'danger' | 'dayGate';

const bgFor = (c: ThemeColor): Record<Variant, string> => ({
  primary: c.action,
  watcher: c.info,
  success: c.safe,
  secondary: c.raised,
  danger: c.danger,
  dayGate: c.dayGateBg,
});

const fgFor = (c: ThemeColor): Record<Variant, string> => ({
  primary: c.actionInk,
  watcher: c.inkOnAccent,
  success: c.safeInk,
  secondary: c.text,
  danger: c.white,
  dayGate: c.dayGateInk,
});

export function SkyButton({
  title,
  subtitle,
  icon,
  onPress,
  variant = 'primary',
  height = 56,
  disabled = false,
  loading = false,
  style,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string;
  // タイトル左のアイコンスロット（docs/icon-set.md）。文字列に絵文字を混ぜない
  icon?: React.ReactNode;
  onPress?: () => void;
  variant?: Variant;
  // ボタンの最低高さ。フォント設定を大きくするとこれを超えて伸びる
  height?: number;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  // 既定では「タイトル（＋サブタイトル）」を読み上げる。絵文字や記号を含む
  // タイトルなど、読み上げに向かない場合だけ呼び出し側で上書きする。
  accessibilityLabel?: string;
}) {
  const { color } = useTheme();
  const bg = bgFor(color)[variant];
  const fg = fgFor(color)[variant];

  const content = (
    <View style={styles.center}>
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          <View style={styles.titleRow}>
            {icon}
            <Text style={[styles.title, { color: fg }]}>{title}</Text>
          </View>
          {subtitle ? <Text style={[styles.subtitle, { color: fg }]}>{subtitle}</Text> : null}
        </>
      )}
    </View>
  );

  return (
    <Pressable
      onPress={disabled || loading ? undefined : onPress}
      disabled={disabled || loading}
      // VoiceOver で「ボタン」と読まれないと、承諾（はじめる）・到着確認（ついた！）・
      // 安否応答（だいじょうぶ！）という指定3経路がすべて押せる要素だと分からない（M-5）
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}。${subtitle}` : title)}
      style={({ pressed }) => [
        { minHeight: height, borderRadius: radius.pill, opacity: disabled ? 0.5 : 1, transform: [{ scale: pressed ? 0.96 : 1 }] },
        variant === 'secondary' && { borderWidth: 1, borderColor: color.raisedStroke },
        style,
      ]}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.fill,
            {
              minHeight: height,
              borderRadius: radius.pill,
              // dayGate（白地）は scale だけでは押下が伝わりにくいため、押下中は淡ピンクへ
              // （rose 文字 5.02:1 で AA 維持。roleselect-color-proposal 申し送り分）
              backgroundColor: variant === 'dayGate' && pressed ? color.dayGatePressed : bg,
            },
          ]}
        >
          {content}
        </View>
      )}
    </Pressable>
  );
}

// height は「最低の高さ」。端末のフォントサイズを上げても文字が切れないよう、
// 固定高ではなく minHeight＋余白で組む（既定のフォントサイズでは従来と同じ高さになる）。
const styles = StyleSheet.create({
  fill: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 8 },
  center: { alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 19, fontWeight: '700' },
  subtitle: { fontSize: 12, fontWeight: '400', marginTop: 2 },
});
