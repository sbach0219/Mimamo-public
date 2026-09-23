import React from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Icon } from '../components/Icon';
import { WatchTargetRow } from '../components/WatchTargetRow';
import { radius, type ThemeColor } from '../theme/tokens';
import { useThemedStyles } from '../theme/ThemeContext';
import { useNow } from '../hooks/useNow';
import { useWatchList } from '../store/watchListStore';
import { focusWatchSession, isEmergencySwitchBlocked } from '../lib/focusWatchSession';
import { WatcherConnectionNotice } from '../components/WatcherConnectionNotice';
import type { RootStackParamList } from '../navigation/types';

// メッセージタブ（design-v3-watcher-redesign §10 Phase1-8）。
// 会話はセッションに1本ずつぶら下がるので、リストは見守り対象そのものになる。
// 行をタップすると、その見守りへ器を向け直してから既存のチャット画面を開く。
export default function WatcherMessagesScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const styles = useThemedStyles(makeStyles);
  const now = useNow();
  const items = useWatchList((s) => s.items);
  // 参加待ちのセッションには相手がいないので、会話の相手として並べない
  const chattable = items.filter((i) => i.status !== 'waiting');

  const openChat = async (id: string) => {
    // 行タップの緊急ガード（M-7）。ホームと同じ判定を使う
    if (isEmergencySwitchBlocked(id)) {
      Alert.alert(
        'いまは 緊急の対応中です',
        'ほかの見守りをひらく前に、いまの緊急への対応を終わらせてください。',
      );
      return;
    }
    const ok = await focusWatchSession(id);
    if (!ok) {
      Alert.alert('ひらけませんでした', '通信を確認して、もう一度お試しください。');
      return;
    }
    navigation.navigate('Chat');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* 圏外表示（M-1） */}
        <WatcherConnectionNotice />
        <Text style={styles.title}>メッセージ</Text>
        {chattable.length === 0 ? (
          <View style={styles.emptyCard}>
            <Icon name="chat" size={40} opacity={0.6} />
            <Text style={styles.emptyTitle}>やりとりできる相手がいません</Text>
            <Text style={styles.emptyText}>
              見守りがはじまると、ここから歩く人とチャットできます。
            </Text>
          </View>
        ) : (
          chattable.map((item) => (
            <WatchTargetRow
              key={item.id}
              item={item}
              now={now}
              subtitleOverride="タップするとチャットをひらきます"
              onPress={() => openChat(item.id)}
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.night[0] },
  content: { padding: 16, gap: 14, paddingBottom: 32 },
  title: { fontSize: 22, fontWeight: '800', color: c.text },
  emptyCard: {
    alignItems: 'center', gap: 8, padding: 22, borderRadius: radius.card,
    backgroundColor: c.cardNavy, borderWidth: 1.5, borderColor: c.glassStroke,
  },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: c.text },
  emptyText: { fontSize: 13, color: c.textSub, textAlign: 'center', lineHeight: 20 },
});
