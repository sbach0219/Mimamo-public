import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Share, Alert, Linking, Animated, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import { SkyScreen } from '../theme/Background';
import { ArrivalOverlay } from '../components/ArrivalOverlay';
import { GlassCard } from '../components/GlassCard';
import { ConnectionPill, type PillState } from '../components/ConnectionPill';
import { Icon, type IconName } from '../components/Icon';
import { dim, type ThemeColor } from '../theme/tokens';
import { useTheme, useThemedStyles, withTheme } from '../theme/ThemeContext';
import { haptics } from '../lib/haptics';
import { useIsOnline } from '../lib/network';
import { useSession } from '../store/sessionStore';
import { inviteMessage } from '../lib/inviteLink';
import * as Clipboard from 'expo-clipboard';
import { SosActionPack } from '../components/SosActionPack';
import { useWalkerAddress } from '../lib/useWalkerAddress';
import { PhoneRegisterCard } from '../components/PhoneRegisterCard';
import { EndWatchButton } from '../components/EndWatchButton';
import { SENSITIVITY_LABEL } from '../lib/sentinel';
import { ensureNotificationPermission } from '../lib/notifications';
import type { ScreenProps } from '../navigation/types';

const WAITING_TIMEOUT = 30 * 60; // 秒
const CONNECTED_NOTICE_MS = 2600; // 「つながりました ✓」を出しておく時間

function WatcherMonitorScreen({ navigation }: ScreenProps<'WatcherMonitor'>) {
  const { color } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const online = useIsOnline();
  const s = useSession();
  const [now, setNow] = useState(Date.now());
  const [arrived, setArrived] = useState(false);
  // 参加成立（waiting→active）の直後だけ出す「つながりました」表示。
  // タイマーで false に戻す方式にすると、表示中に status が変わったときに
  // 後片付けが走らず緑の表示が固着する（SOS が来ているのに「つながりました」の
  // ままになる）。時刻を持って描画時に判定する方式にして、状態を1つにする。
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const prevStatusRef = useRef(s.status);
  const cardEnter = useRef(new Animated.Value(1)).current;
  const endedHandledRef = useRef(false);
  const mapRef = useRef<MapView>(null);

  // v3 §2.2: 見守りの「ホーム」は役割選択（RoleSelect）ではなくタブになった。
  // popToTop で戻すと役割選択まで抜けてしまうので、見守りホームへ戻す。
  // 離脱ガード（beforeRemove）はこの遷移にもかかる（通知未許可の警告は維持）。
  const goHome = () => navigation.navigate('WatcherTabs');

  // プッシュが端末に届いたかではなく、見守る人がSOS画面を実際に開いたことを
  // 歩く人へ返す。書き込みは rules で watcher・SOS中・serverTimestamp に限定する。
  useEffect(() => {
    if (s.status === 'sos' && !s.sosAcknowledgedAt) s.acknowledgeSOS();
  }, [s.status, s.sosAcknowledgedAt]);

  // 歩行者が移動したときだけ地図を追従させる（毎秒の再描画で中心に戻さない）
  const walkerLat = s.walkerLocation?.latitude;
  const walkerLng = s.walkerLocation?.longitude;
  useEffect(() => {
    if (walkerLat != null && walkerLng != null) {
      mapRef.current?.animateToRegion(regionFor({ latitude: walkerLat, longitude: walkerLng }), 500);
    }
  }, [walkerLat, walkerLng]);

  useEffect(() => {
    s.listenToSession();
    s.startConnectionMonitoring();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(tick);
      s.stopConnectionMonitoring();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // E1: 画面を離れる（watcher-exit ADR P1）。
  // 離脱してもセッション・activeWatch・Firestore購読は意図的にそのまま維持する。
  // 見守り宛ての通知はすべて Functions→FCM 経由なので、画面を離れても見守りは劣化しない（決定H）。
  // activeWatch をクリアしないのは「見守り中なのに次回起動で復帰できない」逆向きの静かな失敗を防ぐため。
  // 唯一の例外は通知拒否端末: 離れると本当に気づけなくなるため、その場合だけ3択で警告する（決定I: E1は摩擦ゼロ）。
  const leavingRef = useRef(false);
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      // 終了・到着後の自動遷移や、警告を経た離脱はそのまま通す
      if (leavingRef.current || endedHandledRef.current || s.isSessionExpired) return;
      e.preventDefault();
      (async () => {
        const granted = await ensureNotificationPermission();
        if (granted) {
          leavingRef.current = true;
          navigation.dispatch(e.data.action);
          return;
        }
        Alert.alert(
          '通知が許可されていません',
          'この画面をはなれると、SOSや異変の知らせに気づけないことがあります。',
          [
            { text: '設定をひらく', onPress: () => Linking.openSettings() },
            { text: 'このまま見守る', style: 'cancel' },
            {
              text: 'それでも離れる',
              style: 'destructive',
              onPress: () => {
                leavingRef.current = true;
                navigation.dispatch(e.data.action);
              },
            },
          ]
        );
      })();
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, s.isSessionExpired]);

  // 参加待ちタイムアウト
  useEffect(() => {
    if (s.status !== 'waiting' || !s.sessionCreatedAt) return;
    const elapsed = (now - s.sessionCreatedAt.getTime()) / 1000;
    if (elapsed >= WAITING_TIMEOUT && !endedHandledRef.current) {
      endedHandledRef.current = true;
      s.endSession('cancelled').then((cancelled) => {
        if (!cancelled) {
          endedHandledRef.current = false;
          Alert.alert('キャンセルできませんでした', '通信を確認してから、もう一度操作してください。');
          return;
        }
        Alert.alert('セッションがタイムアウトしました', '相手が30分以内に参加しなかったため、自動キャンセルされました。', [
          { text: 'OK', onPress: goHome },
        ]);
      });
    }
  }, [now, s.status, s.sessionCreatedAt]);

  // セッション終了/到着
  useEffect(() => {
    if (!s.isSessionExpired || endedHandledRef.current) return;
    endedHandledRef.current = true;
    if (s.status === 'arrived') {
      // 見守り体験でいちばんうれしい瞬間なので、OSダイアログではなく昼テーマの
      // カードで受け止める（歩行側 ArrivalOverlay と同じ部品）
      haptics.success();
      setArrived(true);
    } else {
      Alert.alert('見守り終了', 'セッションが終了しました。', [
        { text: 'OK', onPress: goHome },
      ]);
    }
  }, [s.isSessionExpired, s.status]);

  // 相手が参加した瞬間は、無音で文字が入れ替わるだけだと「本当に見えているのか」が
  // 伝わらない。触覚とわずかな動き、数秒の明示表示で成立を実感させる。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = s.status;
    if (prev === 'waiting' && s.status === 'active') {
      haptics.success();
      setConnectedAt(Date.now());
      cardEnter.setValue(0);
      Animated.timing(cardEnter, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    } else if (s.status !== 'active') {
      // 表示中に SOS・異常などへ変わったら、その場で通常の状態表示へ戻す
      setConnectedAt(null);
    }
  }, [s.status, cardEnter]);

  // now は1秒ごとに更新されるので、この判定だけで表示は自然に消える
  const justConnected =
    s.status === 'active' && connectedAt != null && now - connectedAt < CONNECTED_NOTICE_MS;

  // 緊急時だけ住所を引く（平時に常時ジオコーディングしない）
  const emergency = s.status === 'sos' || s.status === 'alert' || s.status === 'anomaly';
  const walkerAddress = useWalkerAddress(s.walkerLocation, emergency);
  const address = walkerAddress.text;
  // 110 に伝えるあいだ、住所を手で書き写させない
  const [addressCopied, setAddressCopied] = useState(false);
  const copyAddress = async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    haptics.success();
    setAddressCopied(true);
    setTimeout(() => setAddressCopied(false), 2500);
  };

  const info = justConnected
    ? { icon: 'star' as IconName, text: 'つながりました ✓', color: color.safe, textColor: color.safe, danger: false }
    : statusInfo(color, s.status, s.connectionStatus, s.anomalyType, s.sosSilent);
  const anomalyText =
    s.anomalyType === 'move' ? '歩く人が乗り物の速さで移動しています。'
    : s.anomalyType === 'area' ? '歩く人が道のない場所に入り、応答がありません。'
    : s.anomalyType === 'fall' ? '歩く人が転んだかもしれません。'
    : '歩く人の動きが止まっています。';
  const pill: PillState = !online ? 'offline'
    : s.status === 'active' && s.connectionStatus === 'unstable' ? 'unstable' : 'online';

  const share = async () => {
    if (s.sessionId) await Share.share({ message: inviteMessage(s.sessionId, s.estimatedMinutes) });
  };

  const remainingWaiting = s.sessionCreatedAt
    ? Math.max(0, Math.floor(WAITING_TIMEOUT - (now - s.sessionCreatedAt.getTime()) / 1000))
    : WAITING_TIMEOUT;

  return (
    <SkyScreen>
      <SafeAreaView style={{ flex: 1 }} edges={['bottom']}>
        <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 90, paddingTop: 4 }}>
          <ConnectionPill state={pill} />

          {/* ステータスカード */}
          <Animated.View
            style={[
              styles.statusCard,
              { backgroundColor: dim(info.color, 0.10), borderColor: dim(info.color, 0.5) },
              { opacity: cardEnter, transform: [{ scale: cardEnter.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }] },
            ]}
          >
            {/* 緊急時はカード内にピンクを隣接させない規約のため、バッジ地を白に落とす */}
            <View style={[styles.modeBadge, info.danger && { backgroundColor: color.cardNavy, borderColor: dim(color.danger, 0.3) }]}>
              <Text style={styles.modeBadgeText}>
                {s.mode === 'sentinel'
                  ? `🛡️ AIおまかせ見守り・感度 ${SENSITIVITY_LABEL[s.sentinelSensitivity]}`
                  : '👆 おまもりボタン'}
              </Text>
            </View>
            <Icon name={info.icon} size={64} />
            <Text style={[styles.statusText, { color: info.textColor }]}>{info.text}</Text>
            {['active', 'alert', 'sos', 'anomaly'].includes(s.status) && s.lastHeartbeatDate && (
              <View style={styles.iconRow}>
                <Icon name="signal" size={14} />
                {/* 途絶しているあいだは色でも分かるようにする。歩く人側の
                    「みまもりが とまっているよ」と対になる情報（A-8） */}
                <Text style={[styles.contact, s.connectionStatus === 'unstable' && styles.contactStale]}>
                  さいごの通信：{lastContact(s.lastHeartbeatDate, now)}
                  {s.connectionStatus === 'unstable' ? '（とだえています）' : ''}
                </Text>
              </View>
            )}
            {/* 住所は「アクション」ではなく「情報」。110 に伝えるためのものなので
                大きく出し、長押しでコピーできるようにする（§4-D） */}
            {emergency && (
              <Pressable
                style={styles.addressBox}
                onPress={address ? copyAddress : undefined}
                disabled={!address}
                accessibilityRole={address ? 'button' : undefined}
                accessibilityLabel={address ? `いまの場所は ${address}。押すとコピーします` : '住所を取得できていません'}
              >
                <View style={styles.iconRow}>
                  <Icon name="pin" size={16} />
                  <Text style={styles.addressLabel}>いまの場所</Text>
                </View>
                <Text style={styles.addressText} selectable>
                  {address ?? addressFallback(walkerAddress.reason)}
                </Text>
                {address && (
                  <Text style={styles.addressHint}>
                    {addressCopied ? 'コピーしました ✓' : 'タップでコピー'}
                  </Text>
                )}
              </Pressable>
            )}
            {s.walkerBatteryLevel != null && (
              <View style={styles.iconRow}>
                <Icon name="battery" size={14} />
                <Text style={[styles.battery, s.walkerBatteryLevel <= 0.2 && { color: color.caution, fontWeight: '700' }]}>
                  相手のバッテリー {Math.round(s.walkerBatteryLevel * 100)}%
                </Text>
              </View>
            )}
          </Animated.View>

          {/* 位置が届いていない歩行（H-2）。heartbeat は届き続けるので、これが無いと
              「いまの場所を さがしています…」のまま正常に見えてしまう。
              色だけに意味を載せない（アイコン＋文言＋caution 枠の3点セット） */}
          {s.locationMode === 'none' && s.status !== 'waiting' && !s.isSessionExpired && (
            <View style={styles.noLocationCard}>
              <View style={styles.iconRow}>
                <Icon name="pin" size={16} />
                <Text style={styles.noLocationHeading}>位置が届いていません</Text>
              </View>
              <Text style={styles.noLocationText}>
                歩く人の端末で位置情報が許可されていないため、いまの場所は分かりません。
                連絡を取って、位置情報を許可してもらってください。
              </Text>
            </View>
          )}

          {/* SOS 行動パッケージ。初期視野は2アクション＋「ほかにできること」 */}
          {s.status === 'sos' && (
            <SosActionPack
              silent={s.sosSilent}
              phone={s.walkerPhone}
              address={address}
              onChat={() => navigation.navigate('Chat')}
              onShare={() => {
                const lines = ['見守り中の人からSOSが出ています。'];
                if (address) lines.push(`いまの場所: ${address}`);
                Share.share({ message: lines.join('\n') });
              }}
            />
          )}

          {/* 平時の緊急連絡先の登録（任意・1回だけ案内する） */}
          {s.status === 'active' && <PhoneRegisterCard />}

          {/* サイレントSOS：見守り側の初動ガイド。声を出せない状況の可能性が
              あるため、いきなり電話せずチャットを勧める */}
          {s.status === 'sos' && s.sosSilent && (
            <View style={styles.silentSosCard}>
              <View style={styles.iconRow}>
                <Icon name="warning" size={16} />
                <Text style={styles.silentSosHeading}>音なしのSOSです</Text>
              </View>
              <Text style={styles.silentSosText}>
                声を出せない・電話に出られない状況かもしれません。
                まずチャットで「大丈夫？」と送るのが安全な場合があります。
              </Text>
            </View>
          )}

          {/* 異常検知（センチネル）：安否確認アクション */}
          {s.status === 'anomaly' && (
            <View style={styles.anomalyCard}>
              {s.safetyCheckResponse === 'ok' ? (
                <Text style={styles.anomalyResolved}>✅ 本人から「大丈夫」と応答がありました</Text>
              ) : s.safetyCheckRequestedAt ? (
                <View style={styles.iconRow}>
                  <Icon name="bell" size={16} />
                  <Text style={styles.anomalyWaiting}>安否確認を送信しました。応答を待っています…</Text>
                </View>
              ) : (
                <>
                  <Text style={styles.anomalyText}>
                    {anomalyText}{'\n'}安否を確認しましょう。
                  </Text>
                  <Pressable
                    style={styles.safetyBtn}
                    onPress={() => { haptics.heavy(); s.requestSafetyCheck(); }}
                    accessibilityRole="button"
                    accessibilityLabel="歩く人に安否確認を送る"
                  >
                    <View style={styles.iconRow}>
                      {/* cautionFill のベタ地なので ink 単色化する（線の #C2185B は地に対し 2.82:1） */}
                      <Icon name="bell" size={16} tint={color.text} />
                      <Text style={styles.safetyBtnText}>安否確認を送る</Text>
                    </View>
                  </Pressable>
                </>
              )}
            </View>
          )}

          {/* 経過時間 */}
          {s.status === 'active' && s.walkStartedAt && (
            <ProgressCard started={s.walkStartedAt} total={s.estimatedMinutes} now={now} />
          )}

          {/* 参加待ち */}
          {s.status === 'waiting' && (
            <View style={{ alignItems: 'center', gap: 14, paddingHorizontal: 24 }}>
              <Text style={styles.waitingText}>
                残り {fmtTime(remainingWaiting)} で{'\n'}自動的にキャンセルされます
              </Text>
              <Pressable style={styles.reshare} onPress={share}>
                <Text style={styles.reshareText}>📤 リンクをもう一度シェア</Text>
              </Pressable>
              {/* E1: 相手の参加を待つあいだ、画面に張り付いていなくてもよい（ユーザー要望 2026-07-30） */}
              <Pressable
                style={styles.reshare}
                onPress={goHome}
                accessibilityRole="button"
                accessibilityLabel="ホームにもどる。見守りセッションはつづきます"
              >
                <Text style={styles.reshareText}>ホームにもどる（見守りはつづきます）</Text>
              </Pressable>
            </View>
          )}

          {/* 地図 */}
          {s.status !== 'ended' && s.status !== 'waiting' && s.walkerLocation && (
            <View style={styles.mapWrap}>
              <MapView
                ref={mapRef}
                style={{ flex: 1 }}
                initialRegion={regionFor(s.walkerLocation)}
              >
                {s.routeCoordinates.length >= 2 && (
                  <Polyline coordinates={s.routeCoordinates} strokeColor={dim(color.action, 0.85)} strokeWidth={4} />
                )}
                {s.homeLocation && (
                  <Marker coordinate={s.homeLocation} title="自宅"><View><Icon name="home" size={28} /></View></Marker>
                )}
                <Marker coordinate={s.walkerLocation} title={s.status === 'arrived' ? '到着地' : '歩いている人'}>
                  <View><Icon name={s.status === 'arrived' ? 'home' : 'walk'} size={28} /></View>
                </Marker>
              </MapView>
            </View>
          )}

          {/* 位置が届くまでの数十秒、地図が「無い」と壊れて見える。同じ寸法の
              プレースホルダを置いてレイアウトのずれも防ぐ */}
          {s.status !== 'ended' && s.status !== 'waiting' && !s.walkerLocation && (
            <GlassCard style={styles.mapPlaceholder} radius={16} elevated>
              <ActivityIndicator color={color.action} />
              <Text style={styles.mapPlaceholderText}>いまの場所を さがしています…</Text>
            </GlassCard>
          )}

          {/* 最近のメッセージ */}
          {s.messages.length > 0 && (
            <View style={styles.msgBox}>
              <Text style={styles.msgHeader}>最近のメッセージ</Text>
              {s.messages.slice(-2).map((m) => (
                <Text key={m.id} style={styles.msg}>{m.text}</Text>
              ))}
            </View>
          )}

          {/* 見守る人からの終了（F-10 / E3）。主要アクションより下に置く。
              終了は endSession が器も購読も片づけるので、離脱ガードは通さずに戻す */}
          <EndWatchButton
            onEndingChange={(ending) => { endedHandledRef.current = ending; }}
            onEnded={() => { endedHandledRef.current = true; goHome(); }}
          />
        </ScrollView>

        {/* チャットボタン。SOS と同形状の円を作らないため、ピンクではなく info の白地ボタンにする */}
        {s.status !== 'waiting' && (
          <Pressable
            style={styles.chatFab}
            onPress={() => navigation.navigate('Chat')}
            accessibilityRole="button"
            accessibilityLabel="歩く人とチャットする"
          >
            <Icon name="chat" size={24} />
          </Pressable>
        )}

        {arrived && (
          <ArrivalOverlay
            title="無事に到着しました"
            sub="大切な人が、家に着きました"
            note="見守りを終了します"
            doneLabel="おつかれさまでした"
            doneVariant="success"
            onDone={goHome}
          />
        )}
      </SafeAreaView>
    </SkyScreen>
  );
}

export default withTheme('light', WatcherMonitorScreen);

function ProgressCard({ started, total, now }: { started: Date; total: number; now: number }) {
  const { color } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const elapsedMin = Math.floor((now - started.getTime()) / 60000);
  const t = Math.max(1, total);
  const ratio = Math.min(1, elapsedMin / t);
  const overtime = elapsedMin > t;
  return (
    <GlassCard style={styles.progressCard} radius={16}>
      <View style={styles.progressRow}>
        <Text style={styles.progressLabel}>⏱ 経過 {elapsedMin}分</Text>
        <Text style={styles.progressLabel}>予定 {t}分</Text>
      </View>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${ratio * 100}%`, backgroundColor: overtime ? color.cautionFill : color.action }]} />
      </View>
      {overtime && <Text style={styles.overtime}>予定時間を すぎています</Text>}
    </GlassCard>
  );
}

// color はカードの地・枠に、textColor は文言に使う。danger の地は淡いピンク寄りの
// 赤になるため、文言だけ一段濃い dangerText にして本文 AA（5.58:1）を確保する。
type StatusInfo = { icon: IconName; text: string; color: string; textColor: string; danger: boolean };

function statusInfo(
  c: ThemeColor,
  status: string,
  conn: string,
  anomalyType?: 'stall' | 'fall' | 'move' | 'area' | null,
  sosSilent = false,
): StatusInfo {
  const danger = (icon: IconName, text: string): StatusInfo =>
    ({ icon, text, color: c.danger, textColor: c.dangerText, danger: true });
  const tone = (icon: IconName, text: string, color: string): StatusInfo =>
    ({ icon, text, color, textColor: color, danger: false });

  if (status === 'sos') {
    if (sosSilent) return danger('sos', 'サイレントSOSが発信されました！\n音を出せない状況かもしれません');
    return danger('sos', 'SOSが発信されました！\nすぐに連絡を取ってください');
  }
  if (status === 'alert') return danger('no-response', '応答がありません！\n確認してください');
  if (status === 'anomaly') {
    if (anomalyType === 'move') return danger('vehicle', '移動の異常を検知しました\n乗り物の速さで移動中です');
    if (anomalyType === 'fall') return tone('fall', '転倒の可能性があります\n安否を確認してください', c.caution);
    if (anomalyType === 'area') return tone('pin', '人気のない場所に入ったようです\n安否を確認してください', c.caution);
    return tone('warning', '異常を検知しました\n安否を確認してください', c.caution);
  }
  if (status === 'waiting') return tone('link', '相手の参加を\n待っています…', c.info);
  if (conn === 'unstable' && status !== 'arrived' && status !== 'ended')
    return tone('signal', '接続が不安定です\n通信できていません', c.caution);
  if (status === 'arrived') return tone('home', '無事に到着しました', c.safe);
  return tone('star', '安全に帰宅中', c.text);
}

// 住所が出せないときは座標を見せない。読み上げても通信指令には伝わらないため、
// 「地図を見て伝える」へ倒すのが唯一の正解になる。
function addressFallback(reason: 'ok' | 'pending' | 'unavailable' | 'no-permission'): string {
  if (reason === 'no-permission') {
    return 'この端末では住所を出せません。下の地図の場所を伝えてください';
  }
  if (reason === 'pending') return '住所をさがしています…';
  return '住所を取得できませんでした。下の地図の場所を伝えてください';
}

function lastContact(date: Date, now: number): string {
  const sec = Math.floor((now - date.getTime()) / 1000);
  if (sec < 10) return 'たった今';
  if (sec < 60) return `${sec}秒まえ`;
  return `${Math.floor(sec / 60)}分まえ`;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function regionFor(c: { latitude: number; longitude: number }): Region {
  return { latitude: c.latitude, longitude: c.longitude, latitudeDelta: 0.005, longitudeDelta: 0.005 };
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  statusCard: { alignItems: 'center', gap: 10, paddingVertical: 18, paddingHorizontal: 16, marginHorizontal: 16, borderRadius: 20, borderWidth: 1.5 },
  modeBadge: {
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999,
    backgroundColor: c.raised, borderWidth: 1, borderColor: c.glassStroke,
  },
  modeBadgeText: { fontSize: 12, fontWeight: '700', color: c.textSub },
  iconRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusText: { fontSize: 20, fontWeight: '600', textAlign: 'center' },
  // 「さいごの通信」「バッテリー」は見守りの生命線。補足ではなく本文として扱う（F-9）
  contact: { fontSize: 15, fontWeight: '600', color: c.textSub },
  contactStale: { color: c.caution, fontWeight: '700' },
  battery: { fontSize: 15, fontWeight: '600', color: c.textSub },
  addressBox: {
    alignSelf: 'stretch', gap: 4, padding: 12, borderRadius: 14,
    backgroundColor: c.cardNavy, borderWidth: 1, borderColor: c.glassStroke,
  },
  addressLabel: { fontSize: 13, fontWeight: '700', color: c.textSub },
  addressText: { fontSize: 17, fontWeight: '700', color: c.text, lineHeight: 25 },
  addressHint: { fontSize: 12, color: c.textSub },
  progressCard: { marginHorizontal: 16, padding: 14, gap: 8 },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between' },
  progressLabel: { fontSize: 13, fontWeight: '600', color: c.textSub },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: c.raised, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  overtime: { fontSize: 12, fontWeight: '600', color: c.caution },
  // danger は「色＋警告アイコン＋文言」の3点セットで出す（提案 §2-1）
  silentSosCard: {
    marginHorizontal: 16, padding: 14, borderRadius: 16, gap: 6,
    backgroundColor: dim(c.danger, 0.10), borderWidth: 1.5, borderColor: dim(c.danger, 0.5),
  },
  silentSosHeading: { fontSize: 15, fontWeight: '800', color: c.dangerText },
  silentSosText: { fontSize: 14, fontWeight: '600', color: c.text, lineHeight: 21 },
  anomalyCard: {
    marginHorizontal: 16, padding: 16, borderRadius: 16, gap: 12, alignItems: 'center',
    backgroundColor: dim(c.cautionFill, 0.18), borderWidth: 1.5, borderColor: c.caution,
  },
  anomalyText: { fontSize: 15, fontWeight: '600', color: c.text, textAlign: 'center', lineHeight: 22 },
  safetyBtn: {
    paddingHorizontal: 24, paddingVertical: 14, borderRadius: 999, backgroundColor: c.cautionFill,
  },
  safetyBtnText: { color: c.text, fontWeight: '800', fontSize: 16 },
  anomalyWaiting: { fontSize: 14, fontWeight: '600', color: c.caution, textAlign: 'center' },
  anomalyResolved: { fontSize: 15, fontWeight: '700', color: c.safe, textAlign: 'center' },
  noLocationCard: {
    marginHorizontal: 16, padding: 14, borderRadius: 16, gap: 6,
    backgroundColor: dim(c.cautionFill, 0.18), borderWidth: 1.5, borderColor: c.caution,
  },
  noLocationHeading: { fontSize: 15, fontWeight: '800', color: c.text },
  noLocationText: { fontSize: 14, fontWeight: '600', color: c.text, lineHeight: 21 },
  waitingText: { fontSize: 13, color: c.textSub, textAlign: 'center' },
  reshare: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 999, backgroundColor: c.raised, borderWidth: 1, borderColor: c.raisedStroke },
  reshareText: { color: c.text, fontWeight: '600' },
  mapWrap: { height: 280, marginHorizontal: 16, borderRadius: 16, overflow: 'hidden' },
  mapPlaceholder: { height: 280, marginHorizontal: 16, alignItems: 'center', justifyContent: 'center', gap: 10 },
  mapPlaceholderText: { fontSize: 14, color: c.textSub },
  msgBox: { marginHorizontal: 16, padding: 12, borderRadius: 12, backgroundColor: c.glass, gap: 8 },
  msgHeader: { fontSize: 12, color: c.textSub },
  msg: { color: c.text, padding: 10, backgroundColor: c.raised, borderRadius: 10 },
  chatFab: {
    position: 'absolute', right: 20, bottom: 24, width: 60, height: 60, borderRadius: 30,
    backgroundColor: c.cardNavy, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: c.info,
    shadowColor: c.black, shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
});
