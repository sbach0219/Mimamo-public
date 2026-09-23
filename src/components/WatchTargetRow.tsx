import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Icon, type IconName } from './Icon';
import { dim, radius, type ThemeColor } from '../theme/tokens';
import { useTheme, useThemedStyles } from '../theme/ThemeContext';
import { displayName, watchRowBadge, type WatchBadge } from '../lib/aggregateWatchStatus';
import { useWalkerAddress } from '../lib/useWalkerAddress';
import type { WatchListItem } from '../store/watchListStore';

// 見守り対象リストの1行（design-v3-watcher-redesign §3.1）。
// ホーム・メッセージ・ちずの下部カードで同じ写像を使い、同じ相手が画面ごとに
// 違う状態に見えることを防ぐ。
//
// fontScale 1.5x（C-1）: 固定高を持たせず minHeight + 可変にし、バッジは
// 名前の下へ折り返せるようにしてある。
export function WatchTargetRow({
  item,
  now,
  onPress,
  resolveAddress = false,
  subtitleOverride,
}: {
  item: WatchListItem;
  now: number;
  onPress: () => void;
  // 住所の逆ジオコーディングを行うか。平時に全行ぶん引くと通信も電池も無駄なので、
  // 画面側が「いま見えている先頭の行だけ」のように絞って渡す。
  resolveAddress?: boolean;
  subtitleOverride?: string;
}) {
  const { color } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const badge = watchRowBadge(item, now);
  const address = useWalkerAddress(item.location, resolveAddress);
  const tone = badgeTone(color, badge);

  const subtitle = subtitleOverride ?? buildSubtitle(item, now, address.text);

  return (
    <Pressable
      style={[styles.row, badge.tone === 'danger' && styles.rowDanger]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${displayName(item)}。${badge.label}。${subtitle}`}
    >
      <View style={[styles.avatar, badge.tone === 'danger' && { borderColor: color.danger }]}>
        <Icon name="walk" size={26} />
      </View>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.name}>{displayName(item)}</Text>
          <View style={[styles.badge, { backgroundColor: tone.fill, borderColor: tone.border }]}>
            {tone.icon && <Icon name={tone.icon} size={13} tint={tone.ink} />}
            <Text style={[styles.badgeText, { color: tone.ink }]}>{badge.label}</Text>
          </View>
        </View>
        <Text style={styles.sub}>{subtitle}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

// 色だけに意味を載せない（C-6）。danger と caution にはアイコンを必ず添える。
function badgeTone(c: ThemeColor, badge: WatchBadge): {
  fill: string; border: string; ink: string; icon: IconName | null;
} {
  switch (badge.tone) {
    case 'danger':
      return { fill: c.danger, border: c.danger, ink: c.white, icon: 'warning' };
    case 'caution':
      // 同じ caution でも「通信がとだえた」と「位置が届いていない」は別の事実なので、
      // 色以外の手がかり（アイコン）も分ける（C-6: 色単独で意味を載せない）
      return {
        fill: c.cautionFill, border: c.caution, ink: c.text,
        icon: badge.key === 'no_location' ? 'pin' : 'signal',
      };
    case 'safe':
      // 0.14 だと合成地の上で safe 文字が 4.35:1 になり AA を割る。0.08 で 4.72:1
      return { fill: dim(c.safe, 0.08), border: dim(c.safe, 0.45), ink: c.safe, icon: null };
    default:
      return { fill: c.raised, border: c.glassStroke, ink: c.textSub, icon: null };
  }
}

function buildSubtitle(item: WatchListItem, now: number, address: string | null): string {
  if (item.status === 'waiting') return 'タップすると リンクをもう一度おくれます';
  // 位置が届いていない歩行（H-2）。「最終確認 さっき」だけを出すと、heartbeat が
  // 新しいぶん正常に見えてしまう。行の副文で理由を言い切る。
  if (item.locationMode === 'none') return '歩く人の端末で 位置の許可がありません';
  const at = item.lastHeartbeatAt ?? item.walkStartedAt?.getTime() ?? item.createdAt?.getTime() ?? null;
  if (at == null) return '最終確認: まだ届いていません';
  const where = address ? `（${address}）` : '';
  return `最終確認: ${relativeTime(now - at)}${where}`;
}

export function relativeTime(elapsedMs: number): string {
  const sec = Math.max(0, Math.floor(elapsedMs / 1000));
  if (sec < 60) return 'さっき';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  return `${Math.floor(hour / 24)}日前`;
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    minHeight: 64, paddingVertical: 12, paddingHorizontal: 14, borderRadius: radius.card,
    backgroundColor: c.cardNavy, borderWidth: 1.5, borderColor: c.glassStroke,
  },
  rowDanger: { borderColor: c.danger, backgroundColor: dim(c.danger, 0.06) },
  avatar: {
    width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.raised, borderWidth: 2, borderColor: c.glassStroke,
  },
  body: { flex: 1, gap: 4 },
  // fontScale 1.5x で名前とバッジが1行に収まらなくなるため、折り返しを許す
  titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  name: { fontSize: 18, fontWeight: '800', color: c.text },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, borderWidth: 1,
  },
  badgeText: { fontSize: 13, fontWeight: '800' },
  sub: { fontSize: 13, color: c.textSub, lineHeight: 19 },
  chevron: { fontSize: 26, color: c.textFaint },
});
