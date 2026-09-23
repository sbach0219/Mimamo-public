import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import MapView, { Marker } from 'react-native-maps';
import { Icon } from '../components/Icon';
import { WatchTargetRow, relativeTime } from '../components/WatchTargetRow';
import { PairTargetRow } from '../components/PairTargetRow';
import { dim, radius, type ThemeColor } from '../theme/tokens';
import { useTheme, useThemedStyles } from '../theme/ThemeContext';
import { haptics } from '../lib/haptics';
import { useNow } from '../hooks/useNow';
import { useWatchList, ARRIVAL_NOTICE_MS, type WatchListItem } from '../store/watchListStore';
import { aggregateBanner, displayName } from '../lib/aggregateWatchStatus';
import { loadWatchPreferences } from '../lib/watchPreferences';
import { useSession } from '../store/sessionStore';
import { usePairs } from '../store/pairStore';
import { useEntitlement } from '../store/entitlementStore';
import { roleInPair, watcherFacingName, type Pair } from '../lib/pairs';
import { focusWatchSession, isEmergencySwitchBlocked } from '../lib/focusWatchSession';
import { WatcherConnectionNotice } from '../components/WatcherConnectionNotice';
import type { RootStackParamList } from '../navigation/types';

// 見守り側のホーム（design-v3-watcher-redesign §3）。
// 上から「緊急」「到着」「人のようす」「地図」「おしらせ」。
// 危険なものほど上に来る順序を崩さない。

// みまもからのおしらせ（Phase 1 はアプリ同梱の静的Tips）。
// 配信基盤（Firestore announcements）は Phase 3。ここでは日替わりで1件出す。
const TIPS = [
  '見守りは「はじめる」「おわる」がはっきりしたお約束です。歩く人が終えると、位置の共有もそこで止まります。',
  '緊急連絡先を登録しておくと、SOSが届いたときに「本人に電話する」がすぐ押せます。',
  '通知を許可しておいてください。アプリを閉じていても、SOSや異変のおしらせは届きます。',
  '位置情報と電話番号は、見守りが終わってから7日で自動的に消えます。',
];

export default function WatcherHomeScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { color } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const now = useNow();
  const items = useWatchList((s) => s.items);
  const arrivals = useWatchList((s) => s.arrivals);
  const loading = useWatchList((s) => s.loading);
  const uid = useSession((s) => s.uid);
  const pairs = usePairs((s) => s.pairs);
  const groupActive = useEntitlement((s) => s.isGroupActive());
  const watchLimit = useEntitlement((s) => s.watchLimit());
  const canShowPaywall = useEntitlement((s) => s.canShowPaywall());

  // 自分が見守り手として成立しているペアのうち、いまライブセッションが無いもの。
  // ライブがあるペアはセッションの行（WatchTargetRow）で出るので、二重に並べない。
  const livePairIds = new Set(items.map((i) => i.pairId).filter((v): v is string => v != null));
  const idlePairs: Pair[] = pairs.filter(
    (p) => p.status === 'active' && roleInPair(p, uid ?? '') === 'watcher' && !livePairIds.has(p.id),
  );

  const banner = aggregateBanner(items, now);
  const emergency = items.find((i) => i.status === 'sos' || i.status === 'anomaly' || i.status === 'alert');
  // 上限判定と「参加待ち」の案内に使う（M-5）
  const joined = items.filter((i) => i.status !== 'waiting');
  const waiting = items.find((i) => i.status === 'waiting');
  const located = items.filter((i) => i.location != null);
  // 到着（H-5）。終端したセッションはリストから外れるので、そのままだと
  // ホームでは行が消えるだけで「着いたのか、通信が切れたのか」が分からない。
  // ちずタブと同じ ARRIVAL_NOTICE_MS・同じ文言で出す（評価語は入れない。D-9）。
  const arrival = arrivals.find((a) => now - a.at < ARRIVAL_NOTICE_MS);
  const tip = TIPS[Math.floor(Date.now() / 86_400_000) % TIPS.length];

  // 行き先はサーバーで確認した status で決める。SOS の全画面は status='sos' 専用で、
  // 異常検知（anomaly）・応答なし（alert）を「SOSが届いています」で見せると
  // 過大表示になり、空振りの学習で本物のSOSへの反応を鈍らせる（H-2）。
  const openTarget = async (item: WatchListItem) => {
    // 緊急対応中に器を差し替えない（M-7）。これまでガードは confirmPairRequest に
    // しか無く、行タップの経路には無かったため、SOS の対応中に別の行を開くと
    // SOS 側の購読が切れて画面の中身が入れ替わっていた。
    if (isEmergencySwitchBlocked(item.id)) {
      Alert.alert(
        'いまは 緊急の対応中です',
        'ほかの見守りをひらく前に、いまの緊急への対応を終わらせてください。',
      );
      return;
    }
    const status = await focusWatchSession(item.id);
    if (!status) {
      Alert.alert('ひらけませんでした', '通信を確認して、もう一度お試しください。');
      return;
    }
    navigation.navigate(status === 'sos' ? 'WatcherSos' : 'WatcherMonitor');
  };

  // ペアへ見守りを依頼する（2026-08-26 決定①）。作るのは walkerUid が空の
  // 待機セッションで、この時点では位置は1点も流れない。相手が端末で「はじめる」を
  // 押して初めて動き出す。見守り手が遠隔で位置共有を開始する経路はここにも rules にも無い。
  const requestPairWatch = async (pair: Pair) => {
    const prefs = await loadWatchPreferences().catch(() => null);
    const minutes = prefs?.minutes ?? 20;
    try {
      await useSession.getState().createSession(
        minutes, null, prefs?.mode ?? 'sentinel', prefs?.sensitivity ?? 'medium',
        prefs?.transport ?? 'vehicle_ok',
        // 呼び名（walkerLabel）はここでは使わない（M-7）。あれは「110番通報のときに
        // 見守り手が口頭で伝える」ためだけに預かっているもので、セッション文書へ
        // 複製すると歩く人の画面と履歴に、他人が自分に付けた名前が予告なく現れる。
        pair.walkerDisplayName || null,
        // 見守り手は同時に複数の見守りを持てる（entitlement 次第）。器（sessionStore）が
        // 1件しか focus できないだけで、ほかのセッションはサーバー上でも
        // activeWatches でも生きたまま。乗り替えの可否は呼び出し側が確認済み。
        { pairId: pair.id, replaceExisting: true },
      );
      haptics.success();
      Alert.alert(
        'おねがいしました',
        `${watcherFacingName(pair, '相手')}さんに「見守りをはじめませんか」とおしらせしました。\n相手が「はじめる」をおすと、ここに見守りが出ます。`,
      );
    } catch (e: any) {
      haptics.error();
      Alert.alert(
        'おねがいできませんでした',
        e?.userFacing ? e.message : '通信を確認して、もう一度お試しください。',
      );
    }
  };

  // ペアの行をタップしたとき。いきなり依頼を飛ばさず、何が起きるかを先に言う
  // （相手の端末が鳴る操作なので、誤タップで起きてよいことではない）。
  const confirmPairRequest = (pair: Pair) => {
    haptics.tap();
    const who = watcherFacingName(pair, '相手');

    // 休眠中（資格が切れている）ペア。関係は残すが、見守り手側の操作は止める
    // （§2.5.3 の「ペアを消さず休眠」の実体。歩く人が自分から歩き始める経路は
    // 資格を見ないので、歩く人側に不利益は出ない）。
    if (!groupActive) {
      Alert.alert(
        'つながりは 休眠中です',
        canShowPaywall
          ? 'グループ機能のお支払いが切れているあいだは、つながりからの見守りをおねがいできません。\nつながり自体は残っているので、再開すればすぐ元どおりです。\nリンクを送る1回きりの見守りは、これまでどおり無料でつかえます。'
          : 'グループ機能は じゅんび中です。リンクを送る見守りは、これまでどおりつかえます。',
        canShowPaywall
          ? [
              { text: 'とじる', style: 'cancel' },
              { text: 'グループ機能を見る', onPress: () => navigation.navigate('Paywall') },
            ]
          : undefined,
      );
      return;
    }

    // すでにこのペアへ未応答の依頼が出ているなら、二重に送らない（M-3/M-5）。
    // サーバー側でも通知は抑止しているが、依頼文書を増やさないほうが素直。
    if (items.some((i) => i.pairId === pair.id && i.status === 'waiting')) {
      Alert.alert(
        'もう おねがいしています',
        `${who}さんからの お返事を待っています。返事がないうちは、続けておしらせを送りません。`,
      );
      return;
    }

    // 緊急対応中に器を差し替えない（H-4）。SOS 画面が見ている状態が、別の依頼を
    // 出しただけで消えるのは最悪の失敗。
    if (isEmergencySwitchBlocked()) {
      Alert.alert(
        'いまは 緊急の対応中です',
        'ほかの見守りをはじめる前に、いまの緊急への対応を終わらせてください。',
      );
      return;
    }

    if (!ensureUnderWatchLimit()) return;

    if (pair.staleSince) {
      Alert.alert(
        `${who}さんと連絡が取れません`,
        '端末が変わったのかもしれません。もう一度招待して、つなぎ直してください。',
        [
          { text: 'とじる', style: 'cancel' },
          { text: 'つながりを見る', onPress: () => navigation.navigate('Pairs') },
        ],
      );
      return;
    }
    Alert.alert(
      `${who}さんに 見守りをおねがいしますか？`,
      `${who}さんの端末に「見守りをはじめませんか」とおしらせが届きます。\n${who}さんが「はじめる」をおすまで、いまの場所はつたわりません。`,
      [
        { text: 'やめる', style: 'cancel' },
        { text: 'おねがいする', onPress: () => { requestPairWatch(pair); } },
      ],
    );
  };

  // 同時に見守れる人数の上限を満たしているか。満たしていれば true（進んでよい）。
  // 無料は1人、グループ（月額）は複数（§2.5.3）。rules では強制できないので、
  // ここと watchSessions の事後検出の2層で守る。
  const ensureUnderWatchLimit = (): boolean => {
    if (joined.length < watchLimit) return true;
    if (groupActive) {
      Alert.alert(
        `いまは${watchLimit}人まで見守れます`,
        'どれかの見守りが終わってから、つぎの見守りをはじめてください。',
      );
      return false;
    }
    Alert.alert(
      'いまは1人まで見守れます',
      canShowPaywall
        ? 'いまの見守りが終わってから、つぎの見守りをはじめてください。\nグループ機能をつかうと、同時に複数の人を見守れます。'
        : 'いまの見守りが終わってから、つぎの見守りをはじめてください。',
      canShowPaywall
        ? [
            { text: 'とじる', style: 'cancel' },
            { text: 'グループ機能を見る', onPress: () => navigation.navigate('Paywall') },
          ]
        : undefined,
    );
    return false;
  };

  const addTarget = () => {
    haptics.tap();
    // 上限は「相手が参加している見守り」で数える。参加待ちのリンクを数えると、
    // 誰も歩いていないのに30分間なにも始められなくなる（M-5）
    if (!ensureUnderWatchLimit()) return;
    // 参加待ちのリンクがあるときの案内は、ペアの有無より先に出す。
    // 「作ったのに渡し忘れたリンク」を放置させないほうが、選択肢を1枚増やすより効く（M-5）
    if (waiting) {
      Alert.alert(
        '参加待ちのリンクがあります',
        'まだ相手が参加していない見守りがあります。そのリンクをもう一度送りますか？',
        [
          { text: 'そのリンクを見る', onPress: () => openTarget(waiting) },
          { text: '新しく作る', onPress: () => startNewWatch() },
          { text: 'やめる', style: 'cancel' },
        ],
      );
      return;
    }
    startNewWatch();
  };

  const startNewWatch = () => {
    // グループ機能をつかっている人には「つながりから」の道を先に見せる。
    // 毎回リンクを配らなくてよくなることが、この機能の中身そのものだから。
    if (groupActive || idlePairs.length > 0) {
      Alert.alert(
        'だれを見守りますか？',
        'つながっている相手には、リンクを送らずに見守りをおねがいできます。',
        [
          { text: 'あたらしい相手とつながる', onPress: () => navigation.navigate('Pairs') },
          { text: 'リンクで1回だけ見守る', onPress: () => navigation.navigate('WatcherSetup') },
          { text: 'やめる', style: 'cancel' },
        ],
      );
      return;
    }
    if (canShowPaywall && !groupActive) {
      Alert.alert(
        'どうやって はじめますか？',
        'リンクを送る見守りは無料です。グループ機能をつかうと、いちどつながった相手にはリンクなしでおねがいできます。',
        [
          { text: 'リンクで見守る（無料）', onPress: () => navigation.navigate('WatcherSetup') },
          { text: 'グループ機能を見る', onPress: () => navigation.navigate('Paywall') },
          { text: 'やめる', style: 'cancel' },
        ],
      );
      return;
    }
    navigation.navigate('WatcherSetup');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Icon name="watch" size={28} />
          <Text style={styles.brand}>みまも</Text>
          <View style={{ flex: 1 }} />
        </View>

        {/* 圏外表示（M-1）。古いリストを現在の状態として見せない */}
        <WatcherConnectionNotice />

        {/* 緊急バナー。色・アイコン・文言の3点セットで出す（C-6）。
            見出しは status で出し分ける。異常検知や応答なしを「緊急要請」と
            言い切ると過大表示になる（H-2 と同じ理由） */}
        {emergency && (
          <Pressable
            style={styles.sosBanner}
            onPress={() => openTarget(emergency)}
            accessibilityRole="button"
            accessibilityLabel={`${emergencyHeadline(emergency.status)}。${banner?.text ?? ''}。ひらいて確認する`}
          >
            <View style={styles.sosIcon}>
              <Icon name={emergency.status === 'sos' ? 'sos' : 'warning'} size={26} tint={color.white} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.sosTitle}>{emergencyHeadline(emergency.status)}</Text>
              <Text style={styles.sosSub}>{banner?.text}</Text>
            </View>
            <Text style={styles.sosChevron}>›</Text>
          </Pressable>
        )}

        {/* 到着（H-5）。危険なものほど上、という順序は崩さないので緊急バナーの下に置く。
            緊急と到着が同時に出ることは実運用ではまず無い */}
        {arrival && (
          <View style={styles.arrivalBanner}>
            <Icon name="home" size={18} />
            {/* 「無事に」は観測していない評価語なので入れない（D-9 / ちずタブと同文） */}
            <Text style={styles.arrivalText}>
              {arrival.name ?? '歩く人'}が到着しました（{relativeTime(now - arrival.at)}）
            </Text>
          </View>
        )}

        <View style={styles.listHeader}>
          <View style={styles.titleBlock}>
            <Text style={styles.listTitle} accessibilityRole="header">いまの見守り</Text>
            <Text style={styles.listSubtitle}>ひとりずつ、ようすを確認。</Text>
          </View>
          <Pressable
            onPress={addTarget}
            style={({ pressed }) => [styles.addBtn, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="見守る人をふやす"
          >
            <Text style={styles.addText}>＋ 追加</Text>
          </Pressable>
        </View>

        {loading && items.length === 0 ? (
          <View style={styles.emptyCard}>
            <ActivityIndicator color={color.action} />
            <Text style={styles.emptyText}>見守りを読み込んでいます…</Text>
          </View>
        ) : items.length === 0 && idlePairs.length === 0 ? (
          <View style={styles.emptyCard}>
            <View style={styles.emptyIcon}><Icon name="watch" size={32} /></View>
            <Text style={styles.emptyTitle}>帰り道を、いっしょに。</Text>
            <Text style={styles.emptyText}>
              いま見守っている人はいません。{'\n'}リンクを渡して、見守りをはじめましょう。
            </Text>
            <Pressable
              onPress={addTarget}
              style={({ pressed }) => [styles.startButton, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <Text style={styles.startText}>見守りをはじめる</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {items.map((item, index) => (
              <WatchTargetRow
                key={item.id}
                item={item}
                now={now}
                // 住所は先頭の行だけ引く。平時に全行ぶんジオコーディングしない。
                // なお「平時にも引くこと自体」は v3 で新しい挙動で、方針をオーナーへ確認中
                // （品質・セキュリティ部 L-6。WatcherMapScreen の同じ注意書きを参照）
                resolveAddress={index === 0}
                onPress={() => openTarget(item)}
              />
            ))}
            {/* いま見守っていないペア（§3.1 最終行）。ライブの行より必ず下に置く
                — 危険なものほど上、という順序を関係の常設化で崩さない */}
            {idlePairs.map((pair) => (
              <PairTargetRow
                key={pair.id}
                pair={pair}
                now={now}
                dormant={!groupActive}
                onPress={() => confirmPairRequest(pair)}
              />
            ))}
          </>
        )}

        {/* 人の状態を先に読み、必要なら地図へ。場所のない初期状態では巨大な空枠を出さない。 */}
        {items.length > 0 && (
          <>
            <Text style={styles.sectionTitle} accessibilityRole="header">地図で見る</Text>
            {/* 集約バナー。システムが観測した事実だけを言う（D-9） */}
            {banner && (
              <View style={[styles.summary, summaryTone(color, banner.tone)]}>
                <Icon
                  name={banner.tone === 'danger' ? 'warning' : banner.tone === 'caution' ? 'signal' : 'star'}
                  size={14}
                  tint={banner.tone === 'danger' ? color.white : undefined}
                />
                <Text
                  style={[styles.summaryText, banner.tone === 'danger' && { color: color.white }]}
                >
                  {banner.text}
                </Text>
              </View>
            )}
            <Pressable
              style={styles.mapCard}
              onPress={() => navigation.navigate('WatcherTabs', { screen: 'MapTab' })}
              accessibilityRole="button"
              accessibilityLabel="ちずをひらく"
            >
              {located.length > 0 ? (
                <MapView
                  style={StyleSheet.absoluteFill}
                  pointerEvents="none"
                  scrollEnabled={false}
                  zoomEnabled={false}
                  rotateEnabled={false}
                  pitchEnabled={false}
                  initialRegion={{
                    latitude: located[0].location!.latitude,
                    longitude: located[0].location!.longitude,
                    latitudeDelta: 0.02,
                    longitudeDelta: 0.02,
                  }}
                >
                  {located.map((i) => (
                    <Marker key={i.id} coordinate={i.location!} title={displayName(i)}>
                      <View><Icon name="walk" size={26} /></View>
                    </Marker>
                  ))}
                </MapView>
              ) : (
                <View style={styles.mapEmpty}>
                  {loading ? <ActivityIndicator color={color.action} /> : <Icon name="pin" size={28} opacity={0.5} />}
                  <Text style={styles.mapEmptyText}>
                    {loading ? '読み込んでいます…' : 'いま地図に出せる場所はありません'}
                  </Text>
                </View>
              )}

            </Pressable>
          </>
        )}

        <View style={styles.tipCard}>
          <View style={styles.tipHead}>
            <Icon name="info" size={16} />
            <Text style={styles.tipTitle}>みまもからのおしらせ</Text>
          </View>
          <Text style={styles.tipText}>{tip}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function emergencyHeadline(status: string): string {
  if (status === 'sos') return '緊急要請が届いています';
  if (status === 'alert') return '応答がありません';
  return '異変を検知しました';
}

function summaryTone(c: ThemeColor, tone: 'danger' | 'caution' | 'all_safe' | 'idle') {
  if (tone === 'danger') return { backgroundColor: c.danger, borderColor: c.danger };
  if (tone === 'caution') return { backgroundColor: c.cautionFill, borderColor: c.caution };
  return { backgroundColor: c.white, borderColor: dim(c.safe, 0.5) };
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.night[0] },
  content: { padding: 20, gap: 16, paddingBottom: 32 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  brand: { fontSize: 22, fontWeight: '800', color: c.action },

  sosBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    minHeight: 72, padding: 14, borderRadius: radius.card,
    backgroundColor: dim(c.danger, 0.08), borderWidth: 2, borderColor: c.danger,
  },
  sosIcon: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.danger,
  },
  sosTitle: { fontSize: 17, fontWeight: '800', color: c.dangerText },
  sosSub: { fontSize: 14, color: c.text, marginTop: 2, lineHeight: 20 },
  sosChevron: { fontSize: 26, color: c.danger, fontWeight: '700' },

  arrivalBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    minHeight: 48, padding: 12, borderRadius: 14,
    backgroundColor: c.white, borderWidth: 1.5, borderColor: c.safe,
  },
  arrivalText: { flex: 1, fontSize: 14, fontWeight: '700', color: c.text, lineHeight: 20 },

  mapCard: {
    minHeight: 176, borderRadius: radius.card, overflow: 'hidden',
    backgroundColor: c.raised, borderWidth: 1, borderColor: c.glassStroke,
  },
  mapEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  mapEmptyText: { fontSize: 14, color: c.textSub, textAlign: 'center', paddingHorizontal: 16 },
  summary: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 12, borderRadius: radius.md, borderWidth: 1,
  },
  summaryText: { flex: 1, fontSize: 17, fontWeight: '700', color: c.text },

  listHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginVertical: 8 },
  titleBlock: { gap: 6 },
  listTitle: { fontSize: 28, fontWeight: '800', color: c.text },
  listSubtitle: { fontSize: 15, color: c.textSub },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: c.text, marginTop: 8 },
  addBtn: { minHeight: 56, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: dim(c.action, 0.06) },
  addText: { fontSize: 17, fontWeight: '700', color: c.action },
  pressed: { opacity: 0.7 },

  emptyCard: {
    alignItems: 'center', gap: 16, padding: 24, borderRadius: radius.card,
    backgroundColor: c.cardNavy, borderWidth: 1, borderColor: c.glassStroke,
  },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: dim(c.action, 0.06) },
  emptyTitle: { fontSize: 22, fontWeight: '700', color: c.text, textAlign: 'center' },
  emptyText: { fontSize: 15, color: c.textSub, textAlign: 'center', lineHeight: 24 },
  startButton: { alignSelf: 'stretch', minHeight: 56, padding: 14, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, backgroundColor: c.action },
  startText: { fontSize: 17, fontWeight: '700', color: c.actionInk, textAlign: 'center' },

  tipCard: {
    gap: 8, paddingVertical: 20, borderTopWidth: 1, borderColor: c.glassStroke,
  },
  tipHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tipTitle: { fontSize: 14, fontWeight: '800', color: c.action },
  tipText: { fontSize: 13, color: c.text, lineHeight: 20 },
});
