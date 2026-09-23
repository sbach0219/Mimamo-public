import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Share, Linking, Platform, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker } from 'react-native-maps';
import * as Clipboard from 'expo-clipboard';
import { Icon } from '../components/Icon';
import { SosActionPack } from '../components/SosActionPack';
import { EndWatchButton } from '../components/EndWatchButton';
import { dim, radius, type ThemeColor } from '../theme/tokens';
import { useTheme, useThemedStyles, withTheme } from '../theme/ThemeContext';
import { haptics } from '../lib/haptics';
import { useSession } from '../store/sessionStore';
import { useWalkerAddress } from '../lib/useWalkerAddress';
import { usePairs } from '../store/pairStore';
import { useNow } from '../hooks/useNow';
import { DEFAULT_WALKER_LABEL } from '../lib/aggregateWatchStatus';
import type { ScreenProps } from '../navigation/types';

// SOS受信画面（design-v3-watcher-redesign §5）。
// 器だけを作り、判断のロジックは既存の SosActionPack・useWalkerAddress を流用する。
// P-C（見守る側が高齢者）に合わせて「1画面1判断」を守る:
// 第1段の行動ボタンは2つまで、それ以外は「ほかにできること」の中。
function WatcherSosScreen({ navigation }: ScreenProps<'WatcherSos'>) {
  const { color } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const s = useSession();
  const now = useNow(30_000);

  // 画面を開いた事実を歩く人へ返す（C-3）。責務は WatcherMonitor からここへ移すが、
  // 移行期は両方が並ぶので冪等な呼び出しのままにしておく。
  useEffect(() => {
    if (s.status === 'sos' && !s.sosAcknowledgedAt) s.acknowledgeSOS();
  }, [s.status, s.sosAcknowledgedAt]);

  const walkerAddress = useWalkerAddress(s.walkerLocation, true);
  const address = walkerAddress.text;
  const [copied, setCopied] = useState(false);
  const copyAddress = async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    haptics.success();
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  // 呼び名と年齢は、恒久ペアがあればそちら（D-8 の walkerLabel）を優先する。
  // 年齢の用途は「110番通報のときに口頭で伝える」1つだけなので、この画面にだけ出す。
  const pair = usePairs((st) => st.pairs.find((p) => p.id === s.pairId) ?? null);
  const name = pair?.walkerLabel?.name || s.walkerName || DEFAULT_WALKER_LABEL;
  const age = pair?.walkerLabel?.age ?? null;
  const safetyPending = s.safetyCheckRequestedAt != null && s.safetyCheckResponse == null;
  const safetyOk = s.safetyCheckResponse === 'ok';
  // SOS が解除された（本人が「だいじょうぶ」と答えた等）状態。画面を緊急のまま
  // 残すと「まだ助けが要るのか」が判断できず、110通報の判断を誤らせる（M-2）
  const resolved = s.status !== 'sos';

  // 終端（ended / arrived / cancelled）は WatcherMonitor と同じ扱いでホームへ戻す。
  // 開いたままだと、共有が止まった時点の古い座標へ「ナビ案内」できてしまう。
  const endedHandledRef = useRef(false);
  const goHome = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('WatcherTabs'));
  useEffect(() => {
    if (!s.isSessionExpired || endedHandledRef.current) return;
    endedHandledRef.current = true;
    Alert.alert(
      s.status === 'arrived' ? '到着しました' : '見守り終了',
      s.status === 'arrived' ? '歩く人が到着し、見守りは終わりました。' : 'この見守りは終了しました。',
      [{ text: 'OK', onPress: goHome }],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.isSessionExpired, s.status]);

  // 現在地へのナビは端末の地図アプリに任せる（アプリ内ナビは作らない）
  const navigate = () => {
    const c = s.walkerLocation;
    if (!c) return;
    const url = Platform.OS === 'ios'
      ? `https://maps.apple.com/?daddr=${c.latitude},${c.longitude}`
      : `geo:${c.latitude},${c.longitude}?q=${c.latitude},${c.longitude}`;
    Linking.openURL(url).catch(() => {
      Alert.alert('地図をひらけませんでした', 'お使いの端末で地図アプリを開けませんでした。');
    });
  };

  return (
    <View style={styles.root}>
      {/* 赤ベタはテーマ非依存で固定（C-6）。SOS の器そのものなので全幅で出す。
          解除後は緑に切り替えて「もう緊急ではない」ことを画面で言い切る（M-2） */}
      <SafeAreaView style={[styles.head, resolved && styles.headResolved]} edges={['top']}>
        <View style={styles.headIcon}>
          <Icon name={resolved ? 'star' : 'sos'} size={40} tint={color.white} />
        </View>
        <Text style={styles.headTitle}>
          {resolved ? 'SOSは解除されました' : 'SOSが届いています'}
        </Text>
        <Text style={styles.headSub}>
          {resolved
            ? safetyOk
              ? `${name}から「だいじょうぶ」と応答がありました`
              : `${name}がSOSを取り消しました`
            : s.sosSilent
              ? `${name}から音なしのSOSが届いています`
              : `${name}が助けを求めています`}
        </Text>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.content}>
        {/* 相手の情報。年齢は預かっているときだけ出す（未取得なら行ごと非表示。
            灰色のプレースホルダは出さない＝確定仕様の踏襲） */}
        <View style={styles.profile}>
          <View style={styles.avatar}><Icon name="walk" size={26} /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{age != null ? `${name}（${age}さい）` : name}</Text>
            <Text style={styles.meta}>
              {detectedLabel(s.sosAt, now)}
              {s.walkerBatteryLevel != null ? `（電池残量 ${Math.round(s.walkerBatteryLevel * 100)}%）` : ''}
            </Text>
          </View>
        </View>

        {s.sosSilent && (
          <View style={styles.silentCard}>
            <View style={styles.iconRow}>
              <Icon name="mute" size={16} />
              <Text style={styles.silentTitle}>音なしのSOSです</Text>
            </View>
            <Text style={styles.silentText}>
              声を出せない・電話に出られない状況かもしれません。
              まずチャットで「だいじょうぶ？」と送るのが安全な場合があります。
            </Text>
          </View>
        )}

        <Text style={styles.sectionTitle}>SOS送信時の現在地</Text>
        {s.walkerLocation ? (
          <View style={styles.mapWrap}>
            <MapView
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
              initialRegion={{
                latitude: s.walkerLocation.latitude,
                longitude: s.walkerLocation.longitude,
                latitudeDelta: 0.004,
                longitudeDelta: 0.004,
              }}
            >
              <Marker coordinate={s.walkerLocation}>
                <View><Icon name="pin" size={30} /></View>
              </Marker>
            </MapView>
          </View>
        ) : (
          <View style={[styles.mapWrap, styles.mapEmpty]}>
            {/* 位置の許可が無い歩行では「まだ」が嘘になる（M-F）。いちばん急いでいる
                画面で待たせると、110番に伝える住所を待ち続けることになる */}
            <Text style={styles.mapEmptyText}>
              {s.locationMode === 'none'
                ? '位置の許可がないため、場所はこれからも届きません。電話で場所を聞いてください'
                : 'いまの場所は まだ届いていません'}
            </Text>
          </View>
        )}

        {/* 住所は110番へ伝えるための情報。手で書き写させない（確定仕様 §4-D） */}
        <Pressable
          style={styles.addressBox}
          onPress={address ? copyAddress : undefined}
          disabled={!address}
          accessibilityRole={address ? 'button' : undefined}
          accessibilityLabel={address ? `いまの場所は ${address}。押すとコピーします` : '住所を取得できていません'}
        >
          <Text style={styles.addressText} selectable>
            {address ?? (s.locationMode === 'none'
              ? '位置の許可がないため、住所は出せません。電話で場所を聞いてください'
              : addressFallback(walkerAddress.reason))}
          </Text>
          {address && <Text style={styles.addressHint}>{copied ? 'コピーしました ✓' : 'タップでコピー'}</Text>}
        </Pressable>

        {/* 解除後は110通報を含む行動ガイドを出さない。緊急が続いているように
            見せ続けることが、次の本物のSOSへの反応を鈍らせる（M-2） */}
        {resolved ? (
          <View style={styles.resolvedCard}>
            <Text style={styles.resolvedText}>
              いまは緊急の状態ではありません。ようすを見る場合は、見守りの画面から続けられます。
            </Text>
            <Pressable
              style={styles.navBtn}
              onPress={() => navigation.navigate('WatcherMonitor')}
              accessibilityRole="button"
              accessibilityLabel="見守りの画面へ進む"
            >
              <Text style={styles.navBtnText}>見守りの画面へ</Text>
            </Pressable>
          </View>
        ) : (
        <>
        <Text style={styles.sectionTitle}>行動ガイド（落ち着いて確認しましょう）</Text>
        <SosActionPack
          silent={s.sosSilent}
          phone={s.walkerPhone}
          address={address}
          onChat={() => navigation.navigate('Chat')}
          onShare={() => {
            const lines = [`${name}からSOSが出ています。`];
            if (address) lines.push(`いまの場所: ${address}`);
            Share.share({ message: lines.join('\n') });
          }}
          // D-7: 見守り側に SOS の解除権限は無い。できるのは本人へ確認を送ることまで
          onSafetyCheck={safetyPending || safetyOk ? undefined : () => s.requestSafetyCheck()}
        />

        {safetyOk && (
          <Text style={styles.safetyOk}>✅ 本人から「だいじょうぶ」と応答がありました</Text>
        )}
        {safetyPending && (
          <View style={styles.iconRow}>
            <Icon name="bell" size={16} />
            <Text style={styles.safetyWaiting}>
              「だいじょうぶ？」を送りました。応答を待っています…
            </Text>
          </View>
        )}

        <Pressable
          style={[styles.navBtn, !s.walkerLocation && styles.navBtnOff]}
          onPress={navigate}
          disabled={!s.walkerLocation}
          accessibilityRole="button"
          accessibilityLabel="現在地への行き方を地図アプリでひらく"
        >
          <Text style={[styles.navBtnText, !s.walkerLocation && { color: color.textSub }]}>現在地へナビ案内</Text>
        </Pressable>
        </>
        )}

        {/* 見守る人からの終了（F-10 / E3）。SOS 中でも出口は塞がない——禁止は
            「いちばん怖い状態で密室を再生産する」ことに等しい（決定C）。
            危険度は確認ダイアログの文言で表す */}
        <EndWatchButton
          onEndingChange={(ending) => { endedHandledRef.current = ending; }}
          onEnded={() => { endedHandledRef.current = true; goHome(); }}
        />

        <Pressable
          style={styles.backBtn}
          onPress={goHome}
          accessibilityRole="button"
          accessibilityLabel={resolved ? 'ホームにもどる' : 'ホームにもどる。SOSは解除されません'}
        >
          <Text style={styles.backText}>
            {resolved ? 'ホームにもどる' : 'ホームにもどる（SOSはつづきます）'}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

export default withTheme('light', WatcherSosScreen);

// 検知時刻。sosAt がまだ届いていない/欠けているときに「たった今」と断定しない（L-3）。
// 経過時間は 110 番へ伝える材料なので、分からないことは分からないと出す。
function detectedLabel(sosAt: Date | null, now: number): string {
  if (!sosAt) return '要請検知: 時刻が確認できていません';
  const minutes = Math.floor((now - sosAt.getTime()) / 60_000);
  if (minutes < 1) return '要請検知: 1分以内';
  return `要請検知: ${minutes}分前`;
}

// 住所が出せないときに座標は見せない（読み上げても通信指令には伝わらないため）
function addressFallback(reason: 'ok' | 'pending' | 'unavailable' | 'no-permission'): string {
  if (reason === 'no-permission') return 'この端末では住所を出せません。上の地図の場所を伝えてください';
  if (reason === 'pending') return '住所をさがしています…';
  return '住所を取得できませんでした。上の地図の場所を伝えてください';
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.night[0] },
  head: {
    alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 22,
    backgroundColor: c.criticalScrim,
  },
  headResolved: { backgroundColor: c.safe },
  headIcon: {
    width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 2, borderColor: c.white,
  },
  headTitle: { fontSize: 26, fontWeight: '900', color: c.white, textAlign: 'center' },
  headSub: { fontSize: 15, fontWeight: '600', color: c.white, textAlign: 'center', lineHeight: 22 },

  content: { padding: 16, gap: 12, paddingBottom: 36 },
  profile: {
    flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    padding: 14, borderRadius: radius.card,
    backgroundColor: dim(c.danger, 0.06), borderWidth: 1.5, borderColor: dim(c.danger, 0.5),
  },
  avatar: {
    width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.white, borderWidth: 2, borderColor: c.danger,
  },
  name: { fontSize: 20, fontWeight: '900', color: c.text },
  meta: { fontSize: 14, fontWeight: '700', color: c.dangerText, marginTop: 2, lineHeight: 20 },

  iconRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  silentCard: {
    gap: 6, padding: 14, borderRadius: 16,
    backgroundColor: dim(c.danger, 0.10), borderWidth: 1.5, borderColor: dim(c.danger, 0.5),
  },
  silentTitle: { fontSize: 15, fontWeight: '800', color: c.dangerText },
  silentText: { fontSize: 14, fontWeight: '600', color: c.text, lineHeight: 21 },

  sectionTitle: { fontSize: 16, fontWeight: '800', color: c.text, marginTop: 4 },
  mapWrap: { height: 200, borderRadius: 16, overflow: 'hidden', backgroundColor: c.raised },
  mapEmpty: { alignItems: 'center', justifyContent: 'center' },
  mapEmptyText: { fontSize: 14, color: c.textSub },
  addressBox: {
    gap: 4, padding: 14, borderRadius: 14,
    backgroundColor: c.cardNavy, borderWidth: 1, borderColor: c.glassStroke,
  },
  addressText: { fontSize: 17, fontWeight: '700', color: c.text, lineHeight: 25 },
  addressHint: { fontSize: 12, color: c.textSub },

  resolvedCard: {
    gap: 12, padding: 16, borderRadius: radius.card,
    backgroundColor: dim(c.safe, 0.10), borderWidth: 1.5, borderColor: dim(c.safe, 0.5),
  },
  resolvedText: { fontSize: 15, fontWeight: '600', color: c.text, lineHeight: 22 },
  safetyOk: { fontSize: 15, fontWeight: '700', color: c.safe, textAlign: 'center' },
  safetyWaiting: { flex: 1, fontSize: 14, fontWeight: '600', color: c.caution, lineHeight: 20 },

  navBtn: {
    minHeight: 56, alignItems: 'center', justifyContent: 'center',
    borderRadius: 999, backgroundColor: c.action, marginTop: 4,
  },
  navBtnOff: { backgroundColor: c.raised },
  navBtnText: { fontSize: 17, fontWeight: '800', color: c.actionInk },
  backBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 15, fontWeight: '700', color: c.textSub },
});
