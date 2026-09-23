import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import MapView, { Marker } from 'react-native-maps';
import { Icon } from '../components/Icon';
import { dim, type ThemeColor } from '../theme/tokens';
import { useTheme, useThemedStyles } from '../theme/ThemeContext';
import { useNow } from '../hooks/useNow';
import { useWatchList, ARRIVAL_NOTICE_MS } from '../store/watchListStore';
import { displayName, watchRowBadge } from '../lib/aggregateWatchStatus';
import { useWalkerAddress } from '../lib/useWalkerAddress';
import { relativeTime } from '../components/WatchTargetRow';
import { focusWatchSession } from '../lib/focusWatchSession';
import { WatcherConnectionNotice } from '../components/WatcherConnectionNotice';
import type { RootStackParamList } from '../navigation/types';

// ちずタブ（design-v3-watcher-redesign §4）。
// 下部シートはドラッグではなく「ピンをタップすると切り替わるカード」にする。
// 新しい依存（@gorhom/bottom-sheet）を入れず、ドラッグという P-C の苦手操作も避ける。

export default function WatcherMapScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { color } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const now = useNow();
  const items = useWatchList((s) => s.items);
  const arrivals = useWatchList((s) => s.arrivals);
  const mapRef = useRef<MapView>(null);

  // Phase 1 の検索は「対象者名でのしぼりこみ」だけ（場所検索は Phase 3）
  const [queryText, setQueryText] = useState('');
  const filtered = useMemo(() => {
    const q = queryText.trim();
    if (!q) return items;
    return items.filter((i) => displayName(i).includes(q));
  }, [items, queryText]);

  const located = filtered.filter((i) => i.location != null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = filtered.find((i) => i.id === selectedId) ?? located[0] ?? filtered[0] ?? null;
  // 注意（品質・セキュリティ部 L-6 / オーナー相談中）: v1 では逆ジオコーディングを
  // 緊急時だけに限っていたが、この下部カードは平時も選択中の相手の座標を住所へ直す。
  // iOS の reverseGeocodeAsync は座標を Apple へ送るため、「緊急時だけ住所にする」という
  // useWalkerAddress 冒頭の前提から外れている。方針が「平時は住所を出さない」に決まったら、
  // ここと WatcherHomeScreen の resolveAddress を status ベースの条件に変える。
  const address = useWalkerAddress(selected?.location ?? null, selected != null);

  // 全ピンが収まる初期表示。対象が増減したときだけ引き直す
  const key = located.map((i) => i.id).join(',');
  useEffect(() => {
    if (located.length === 0) return;
    mapRef.current?.fitToCoordinates(
      located.map((i) => i.location!),
      { edgePadding: { top: 120, right: 60, bottom: 260, left: 60 }, animated: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const arrival = arrivals.find((a) => now - a.at < ARRIVAL_NOTICE_MS);

  // SOS の全画面は status='sos' 専用（H-2）。異常検知・応答なしは詳細画面で受ける
  const openDetail = async () => {
    if (!selected) return;
    const status = await focusWatchSession(selected.id);
    if (!status) {
      Alert.alert('ひらけませんでした', '通信を確認して、もう一度お試しください。');
      return;
    }
    navigation.navigate(status === 'sos' ? 'WatcherSos' : 'WatcherMonitor');
  };

  return (
    <View style={styles.root}>
      <MapView ref={mapRef} style={StyleSheet.absoluteFill}>
        {located.map((i) => {
          const badge = watchRowBadge(i, now);
          const danger = badge.tone === 'danger';
          return (
            <Marker
              key={i.id}
              coordinate={i.location!}
              onPress={() => setSelectedId(i.id)}
              // ピンの区別は色だけに頼らず、必ず文言のラベルを添える（C-6）
              accessibilityLabel={`${displayName(i)}。${badge.label}`}
            >
              <View style={styles.pinWrap}>
                <View style={[styles.pinLabel, danger && { backgroundColor: color.danger, borderColor: color.danger }]}>
                  <Text style={[styles.pinLabelText, danger && { color: color.white }]}>{badge.label}</Text>
                </View>
                <View style={[styles.pinBody, danger && { borderColor: color.danger }]}>
                  <Icon name={i.status === 'arrived' ? 'home' : 'walk'} size={24} />
                </View>
              </View>
            </Marker>
          );
        })}
      </MapView>

      <SafeAreaView style={styles.topLayer} edges={['top']} pointerEvents="box-none">
        <View style={styles.searchBar}>
          {/* アイコンセットに虫眼鏡が無いため「見守り」の印を置く。
              qr-scan はスキャン機能と誤解されるので使わない（L-9） */}
          <Icon name="watch" size={18} opacity={0.7} />
          <TextInput
            style={styles.searchInput}
            value={queryText}
            onChangeText={setQueryText}
            placeholder="見守り対象者をさがす"
            placeholderTextColor={color.textFaint}
            returnKeyType="search"
            accessibilityLabel="見守り対象者を名前でさがす"
          />
          {queryText.length > 0 && (
            <Pressable onPress={() => setQueryText('')} hitSlop={8} accessibilityLabel="検索をけす">
              <Text style={styles.clear}>✕</Text>
            </Pressable>
          )}
        </View>

        {/* 圏外表示（M-1）。ピンの位置が古いままになるので、地図こそ要る */}
        <WatcherConnectionNotice />

        {arrival && (
          <View style={styles.arrivalBanner}>
            <Icon name="home" size={18} />
            {/* 「無事に」は観測していない評価語なので入れない（D-9 / L-1） */}
            <Text style={styles.arrivalText}>
              {arrival.name ?? '歩く人'}が到着しました（{relativeTime(now - arrival.at)}）
            </Text>
          </View>
        )}
      </SafeAreaView>

      <SafeAreaView style={styles.bottomLayer} edges={['bottom']} pointerEvents="box-none">
        <View style={styles.card}>
          {selected ? (
            <>
              <View style={styles.cardHead}>
                <View style={styles.avatar}><Icon name="walk" size={24} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{displayName(selected)}</Text>
                  <Text style={styles.state}>{cardState(selected, now)}</Text>
                </View>
                <Pressable
                  style={styles.detailBtn}
                  onPress={openDetail}
                  accessibilityRole="button"
                  accessibilityLabel={`${displayName(selected)}の状況を確認する`}
                >
                  <Text style={styles.detailBtnText}>状況確認へ</Text>
                </Pressable>
              </View>
              <View style={styles.addressRow}>
                <Icon name="pin" size={16} />
                <Text style={styles.addressText}>
                  {selected.location == null
                    ? 'いまの場所は まだ届いていません'
                    : address.text
                      ? `現在地: ${address.text}`
                      : '現在地の住所をさがしています…'}
                </Text>
              </View>
            </>
          ) : (
            <Text style={styles.emptyText}>
              {items.length === 0
                ? 'いま見守っている人はいません'
                : '名前でしぼりこんだ結果に、地図に出せる人がいません'}
            </Text>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

function cardState(item: { status: string; sosAt: Date | null; walkStartedAt: Date | null; sosSilent: boolean }, now: number): string {
  if (item.status === 'sos') {
    const since = item.sosAt ? `（${relativeTime(now - item.sosAt.getTime())}）` : '';
    return item.sosSilent ? `音なしの緊急要請を受信中${since}` : `緊急要請を受信中${since}`;
  }
  if (item.status === 'anomaly') return '異変を検知しました';
  if (item.status === 'alert') return '応答がありません';
  if (item.status === 'waiting') return '相手の参加を待っています';
  if (item.walkStartedAt) return `見守り中（${relativeTime(now - item.walkStartedAt.getTime())}から）`;
  return '見守り中';
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.night[0] },
  topLayer: { position: 'absolute', left: 0, right: 0, top: 0, gap: 10, padding: 12 },
  bottomLayer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 12 },

  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    minHeight: 48, paddingHorizontal: 16, borderRadius: 999,
    backgroundColor: c.white, borderWidth: 1, borderColor: c.glassStroke,
    shadowColor: c.black, shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
  searchInput: { flex: 1, fontSize: 15, color: c.text, paddingVertical: 10 },
  clear: { fontSize: 16, color: c.textSub, paddingHorizontal: 4 },

  arrivalBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12, borderRadius: 14,
    backgroundColor: c.white, borderWidth: 1.5, borderColor: c.safe,
  },
  arrivalText: { flex: 1, fontSize: 14, fontWeight: '700', color: c.text, lineHeight: 20 },

  pinWrap: { alignItems: 'center', gap: 2 },
  pinLabel: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999,
    backgroundColor: c.white, borderWidth: 1, borderColor: c.glassStroke,
  },
  pinLabelText: { fontSize: 11, fontWeight: '800', color: c.text },
  pinBody: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.white, borderWidth: 2.5, borderColor: c.safe,
  },

  card: {
    gap: 10, padding: 14, borderRadius: 20,
    backgroundColor: c.white, borderWidth: 1, borderColor: c.glassStroke,
    shadowColor: c.black, shadowOpacity: 0.15, shadowRadius: 12, shadowOffset: { width: 0, height: 3 }, elevation: 4,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  avatar: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.raised, borderWidth: 2, borderColor: c.glassStroke,
  },
  name: { fontSize: 18, fontWeight: '800', color: c.text },
  state: { fontSize: 13, color: c.textSub, marginTop: 2 },
  detailBtn: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: 18, borderRadius: 999,
    backgroundColor: c.action,
  },
  detailBtnText: { fontSize: 15, fontWeight: '800', color: c.actionInk },
  addressRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 10, borderRadius: 12, backgroundColor: dim(c.action, 0.06),
  },
  addressText: { flex: 1, fontSize: 13, color: c.text, lineHeight: 19 },
  emptyText: { fontSize: 14, color: c.textSub, textAlign: 'center', paddingVertical: 12 },
});
