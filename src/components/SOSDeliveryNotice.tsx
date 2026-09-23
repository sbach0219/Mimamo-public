import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { color, radius } from '../theme/tokens';
import type { DeliveryStatus } from '../lib/serverDelivery';

export function SOSDeliveryNotice({
  status,
  silent,
  watcherAcknowledged,
}: {
  status: DeliveryStatus;
  silent: boolean;
  watcherAcknowledged: boolean;
}) {
  if (status === 'idle') return null;

  // 歩く人が読む画面なので、ひらがな分かち書きにそろえる（docs/design-conventions.md）。
  // パニック時に漢字は読めない前提で組む。
  const content = status === 'sending'
    ? { title: 'おくっています…', body: 'まだ とどいたか わからないよ。この画面のまま まっててね', tone: styles.sending }
    : status === 'delivered'
      ? watcherAcknowledged
        ? { title: '✓ とどいたよ', body: 'みまもりの人が きづいたよ。あんぜんな ところで まっててね', tone: styles.delivered }
        : { title: 'おくったよ', body: 'みまもりの人が みるのを まっているよ', tone: styles.delivered }
      : status === 'unconfirmed'
        ? {
          title: 'まだ とどいていないよ',
          body: silent
            ? 'あんぜんなら、チャットや 110・119 への れんらくも かんがえてね'
            : 'ちかくの人や 110・119 にも たすけを もとめてね',
          tone: styles.unconfirmed,
        }
        : { title: 'おくれなかったよ', body: 'まわりの人か 110・119 に ちょくせつ たすけを もとめてね', tone: styles.failed };

  return (
    <View style={[styles.card, content.tone]} accessibilityLiveRegion="assertive">
      <Text style={styles.title}>{content.title}</Text>
      <Text style={styles.body}>{content.body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', borderRadius: radius.md, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11, gap: 3 },
  sending: { backgroundColor: 'rgba(255,214,10,0.16)', borderColor: 'rgba(255,214,10,0.65)' },
  delivered: { backgroundColor: 'rgba(52,199,89,0.16)', borderColor: 'rgba(52,199,89,0.72)' },
  unconfirmed: { backgroundColor: 'rgba(255,159,10,0.18)', borderColor: 'rgba(255,159,10,0.76)' },
  failed: { backgroundColor: 'rgba(255,59,48,0.2)', borderColor: color.danger },
  title: { color: color.text, fontWeight: '800', fontSize: 16 },
  body: { color: color.textSub, fontSize: 13, lineHeight: 19 },
});
