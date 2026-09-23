import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Icon } from './Icon';
import { dim, radius, type ThemeColor } from '../theme/tokens';
import { useThemedStyles } from '../theme/ThemeContext';
import { avatarEmoji } from '../lib/avatars';
import { describeLastSession, watcherFacingName, type Pair } from '../lib/pairs';

// 見守り対象リストの「いま見守っていないペア」の行（v3移行設計書 §3.1 の最終行）。
//
// ライブセッションの行（WatchTargetRow）と器を揃えつつ、**状態バッジを持たない**のが
// 決定的な違い。ペアがあるだけでは相手の状態は何も分からず、分からないことを
// 「異常なし」と書けば嘘になる（D-9 の原則そのもの）。出せるのは
// 「まえの見守り: n分前・地名」という過去の事実だけで、それも7日で消える（D-14）。
export function PairTargetRow({
  pair, now, dormant = false, onPress,
}: {
  pair: Pair;
  now: number;
  // グループ機能の資格が切れている間（§2.5.3 の「休眠」）。関係は残すが、
  // 見守り手からの依頼は出せない。**行を消さない**のが要点で、消すと
  // 「データを人質に取らない」という約束が見た目の上で破れる。
  dormant?: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const name = watcherFacingName(pair);
  const last = describeLastSession(pair.lastSessionSummary, new Date(now));
  // 相手が長期不達（I-5）。黙って放置せず、行の上に必ず出す。
  const stale = pair.staleSince != null;

  const sub = stale
    ? 'しばらく連絡が取れていません。もう一度招待してください'
    : dormant
      ? 'グループ機能を再開すると、また見守りをおねがいできます'
      : last ?? 'まだ 見守りの記録はありません';

  const badgeText = stale ? '連絡がとれません' : dormant ? '休眠中' : '見守っていません';

  return (
    <Pressable
      style={[styles.row, stale && styles.rowStale, dormant && styles.rowDormant]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}。${badgeText}。${sub}`}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarEmoji}>{avatarEmoji(pair.walkerAvatar)}</Text>
      </View>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.name}>{name}</Text>
          <View style={styles.badge}>
            {stale && <Icon name="warning" size={13} />}
            <Text style={styles.badgeText}>{badgeText}</Text>
          </View>
        </View>
        <Text style={styles.sub}>{sub}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    minHeight: 64, paddingVertical: 12, paddingHorizontal: 14, borderRadius: radius.card,
    backgroundColor: c.glass, borderWidth: 1.5, borderColor: c.glassStroke,
  },
  rowStale: { borderColor: c.caution, backgroundColor: c.cautionFill },
  rowDormant: { opacity: 0.7 },
  avatar: {
    width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.raised, borderWidth: 2, borderColor: c.glassStroke,
  },
  avatarEmoji: { fontSize: 26 },
  body: { flex: 1, gap: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  name: { fontSize: 18, fontWeight: '800', color: c.text },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, borderWidth: 1,
    backgroundColor: c.raised, borderColor: dim(c.glassStroke, 1),
  },
  badgeText: { fontSize: 12, fontWeight: '800', color: c.textSub },
  sub: { fontSize: 13, color: c.textSub, lineHeight: 19 },
  chevron: { fontSize: 26, color: c.textFaint },
});
