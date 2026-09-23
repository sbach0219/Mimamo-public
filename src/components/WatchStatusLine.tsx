import React from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { color, dim, font, radius } from '../theme/tokens';
import { type WatchTone } from '../lib/watchStatus';

// 歩く人に「いま みまもられているか」を1行で見せる（判定は lib/watchStatus.ts）。
// 色だけに頼らない（ドット＋文言＋色の3点セット）。黄色は「電波が弱いだけ」と
// 分かる言い方にして、必要以上に不安にさせない。
const TEXT: Record<WatchTone, { label: string; hint?: string }> = {
  ok: { label: 'みまもられているよ' },
  weak: { label: 'でんぱが よわいよ', hint: 'つながったら じどうで おくるよ' },
  stopped: { label: 'みまもりが とまっているよ', hint: 'アプリを ひらいたままに してね' },
};

// ピルの左右には絶対配置の 44pt ボタン（左上 SOS／電話・右上チャット）が乗る。
// その幅と余白を引いた分だけを本文に使う（375 端末で 199 / 390 で 214 / 430 で 254）。
const SIDE_RESERVE = 176;

export function WatchStatusLine({
  tone,
  hint,
  meta,
  fullWidth = false,
}: {
  tone: WatchTone;
  hint?: string;
  // ok のときだけ出る補足（「目安 20分 · あるいて 5分」）。weak/stopped は
  // 状態の説明のほうが優先なので、その hint に負ける
  meta?: string;
  // 上部操作を通常フローへ移した画面では左右の予約幅は不要。
  fullWidth?: boolean;
}) {
  const { width } = useWindowDimensions();
  const t = TEXT[tone];
  const text = hint ?? t.hint ?? meta;
  const dotColor = tone === 'ok' ? color.safe : tone === 'weak' ? color.caution : color.danger;
  return (
    <View
      style={[
        styles.row,
        { maxWidth: width - (fullWidth ? 48 : SIDE_RESERVE) },
        tone === 'ok' ? styles.ok : tone === 'weak' ? styles.weak : styles.stopped,
      ]}
      accessibilityRole="text"
      accessibilityLabel={text ? `${t.label}。${text}` : t.label}
    >
      <View style={[styles.dot, { backgroundColor: dotColor, shadowColor: dotColor }]} />
      <View style={styles.textCol}>
        <Text style={styles.label}>{t.label}</Text>
        {text ? <Text style={styles.hint}>{text}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8, alignSelf: 'center',
    minHeight: 44, paddingHorizontal: 16, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1,
  },
  ok: { backgroundColor: dim(color.safe, 0.15), borderColor: dim(color.safe, 0.5) },
  weak: { backgroundColor: dim(color.caution, 0.15), borderColor: dim(color.caution, 0.55) },
  stopped: { backgroundColor: dim(color.danger, 0.18), borderColor: color.danger },
  // 2行に折れたときもドットが1行目の高さに残るよう、行の中心へ手で寄せる
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, shadowOpacity: 0.8, shadowRadius: 3 },
  textCol: { flexShrink: 1 },
  label: { fontSize: font.body, fontWeight: '700', color: color.text },
  hint: { fontSize: font.caption, color: color.textSub, marginTop: 1 },
});
