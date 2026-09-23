import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SkyScreen } from '../theme/Background';
import { Icon } from '../components/Icon';
import { colors } from '../theme/colors';
import { color } from '../theme/tokens';
import { useSession, type HistoryItem } from '../store/sessionStore';
import type { ScreenProps } from '../navigation/types';

export default function HistoryScreen(_props: ScreenProps<'History'>) {
  const fetchHistory = useSession((s) => s.fetchHistory);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchHistory()
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fetchHistory]);

  return (
    <SkyScreen>
      <SafeAreaView style={{ flex: 1 }} edges={['bottom']}>
        {loading ? (
          <View style={styles.center}><ActivityIndicator color={colors.white} /></View>
        ) : items.length === 0 ? (
          <View style={styles.center}>
            <Icon name="moon" size={56} />
            <Text style={styles.emptyTitle}>まだ きろくは ありません</Text>
            <Text style={styles.emptySub}>みまもりが おわると、ここに ならびます</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
            {items.map((item) => (
              <View key={item.id} style={styles.row}>
                <Icon name={item.role === 'watcher' ? 'watch' : 'walk'} size={24} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.date}>{item.createdAt.toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Text>
                  <View style={styles.metaRow}>
                    <View style={[styles.dot, { backgroundColor: statusColor(item.finalStatus) }]} />
                    <Text style={styles.meta}>
                      {item.estimatedMinutes}分 · {item.mode === 'sentinel' ? '🛡️ AI見守り' : '👆 おまもり'} · {statusLabel(item.finalStatus)}
                    </Text>
                  </View>
                </View>
              </View>
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
    </SkyScreen>
  );
}

function statusLabel(s: string): string {
  switch (s) {
    case 'arrived': return '✅ 到着';
    case 'ended': return '終了';
    case 'cancelled': return 'キャンセル';
    case 'alert': case 'sos': return '⚠️ 緊急発生';
    case 'anomaly': return '⚠️ 異常検知で終了';
    case 'active': return '終了'; // 旧セッションが active のまま自動終了された場合など
    case 'waiting': return '未参加';
    default: return '終了';
  }
}
function statusColor(s: string): string {
  switch (s) {
    case 'arrived': return colors.green;
    case 'alert': case 'sos': case 'anomaly': return colors.red;
    case 'cancelled': case 'waiting': return colors.muted;
    default: return colors.muted;
  }
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: color.text },
  emptySub: { fontSize: 14, color: color.textSub, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.1)' },
  date: { color: colors.white, fontSize: 15 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  meta: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
});
