import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, AppState, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import { SkyScreen } from '../theme/Background';
import { ArrivalOverlay } from '../components/ArrivalOverlay';
import { SessionEndedOverlay } from '../components/SessionEndedOverlay';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CheckOverlay } from '../components/CheckOverlay';
import { SlideToArrive } from '../components/SlideToArrive';
import { HeroSOSButton } from '../components/HeroSOSButton';
import { WalkToolbar } from '../components/WalkToolbar';
import { SOSDeliveryNotice } from '../components/SOSDeliveryNotice';
import { LeaveWalkLink } from '../components/LeaveWalkLink';
import { WatchStatusLine } from '../components/WatchStatusLine';
import { watchTone } from '../lib/watchStatus';
import { Icon } from '../components/Icon';
import { color, dim, font, radius, space } from '../theme/tokens';
import { haptics } from '../lib/haptics';
import { useIsOnline } from '../lib/network';
import { confirmSOS, confirmCancelSOS, showEmergencySheet } from '../lib/emergency';
import { useSession } from '../store/sessionStore';
import { canStartWalk } from '../lib/walkGate';
import { useWalkLifecycle } from '../hooks/useWalkLifecycle';
import { useSOSAlarm } from '../hooks/useSOSAlarm';
import { useBatteryReport } from '../hooks/useBatteryReport';
import { usePlaceLabelReport } from '../hooks/usePlaceLabelReport';
import { useSentinel } from '../hooks/useSentinel';
import { setActiveWalkResting, resetStallState, stopBackgroundWalk, acknowledgeAreaDetection } from '../tasks/locationTask';
import { notify } from '../lib/notifications';
import { REST_AUTO_RESUME_MINUTES, REST_AUTO_RESUME_MS } from '../lib/sentinel';
import type { ScreenProps } from '../navigation/types';

// keep-awake で画面が消えないため、無操作が続いたら暗い待機表示に切り替えて
// OLED の電池消費を抑える（タップで復帰。検知・位置共有は継続）。
const DIM_AFTER_MS = 45_000;
// 離脱確認を開いたまま放置できる上限。超えたら「つづける」に倒す（MainScreen と同値）
const LEAVE_DIALOG_TIMEOUT_MS = 60_000;
// 「おわる」を押してから見守り側に届いたと確認できるまでの上限
const END_SESSION_TIMEOUT_MS = 8_000;

// AIセンチネルモードの歩行画面。
// 歩く人は基本「無操作」。位置共有は裏で継続し、停滞＋転倒を自動検知する。
// SOS・緊急通報・チャット・到着・時間延長も利用できる。
export default function MainSentinelScreen({ route, navigation }: ScreenProps<'MainSentinel'>) {
  // 画面が消えると転倒検知（前面の加速度）が止まるため、歩行中は点灯を維持する
  // （ホールドモードの MainScreen と同じ方針）
  useKeepAwake();
  const online = useIsOnline();
  const session = useSession();
  // 自分の意思で画面を出るとき（到着・終了・未参加ガード・位置が使えないとき）は
  // 離脱ガードを通さない。useWalkLifecycle より先に定義しておくこと（H-2 で
  // 位置共有が成立しなかったときの出口としてフックへ渡すため）。
  const leaveConfirmedRef = useRef(false);
  const exitScreen = useCallback(() => {
    leaveConfirmedRef.current = true;
    navigation.popToTop();
  }, [navigation]);
  // 位置共有が成立しなかったときは、画面を出るだけでなくセッションも畳む（M-C）。
  // active のまま残ると、見守り側には「位置が届かない歩行中」が期限まで表示される。
  const abandonAndExit = useCallback(() => {
    useSession.getState().abandonSession().catch(() => {});
    exitScreen();
  }, [exitScreen]);
  const { showArrival, setShowArrival, endedReason, foregroundOnly, walkStart } = useWalkLifecycle(abandonAndExit);
  // 目安時間は「+N分」の延長がリアルタイムに反映されるようストアの値を表示する
  // （route.params は開始時点の値のままなので延長しても増えない。issue #8）
  const estimatedMinutes = session.estimatedMinutes || route.params.estimatedMinutes;
  // SOS発信中（音ありモード）は端末からサイレン＋バイブ
  const { alarmSounding, muteAlarm } = useSOSAlarm(session.status === 'sos' && !session.sosSilent);
  // 電池残量を60秒ごとに見守り側へ送る（§8。センチネル歩行では従来これが無く、
  // 見守り側の SOS 画面に残量が出なかった）
  useBatteryReport();
  // いまいる場所の地名だけをセッション文書へ置いていく（D-14）。
  // 終端時に Functions がペアの「最終確認」へ転記する。座標は転記されない。
  usePlaceLabelReport(session.walkerLocation, session.status !== 'waiting');

  // 「休憩中」一時停止。ON の間はセンチネルの検知を止める。
  // 戻し忘れが危険なので REST_AUTO_RESUME_MINUTES 分で自動再開する。
  const [resting, setResting] = useState(false);
  // 画面を閉じる＝見守り終了、の確認（F-2）
  const [leaveAsking, setLeaveAsking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const leaveAskedAtRef = useRef<number | null>(null);
  // 終了処理の世代。キャンセル後に遅れて返ってきた結果で画面を動かさないため
  const leaveGenerationRef = useRef(0);
  // 本人確認・安否確認が出ているあいだは離脱の相談をしない（下の effect で同期）
  const emergencyOverlayRef = useRef(false);

  // ----- 画面を閉じる＝見守り終了（F-2 / オーナー決定 D-5）-----
  // センチネルは無操作の見守りなので、画面を出たことに本人が気づきにくい。
  // 黙って抜けると位置共有が止まり、見守り側には通信途絶として届く。
  const askLeave = useCallback(() => {
    // いま答えるべきは「だいじょうぶ？」であって、見守りを終えるかどうかではない
    if (emergencyOverlayRef.current) return;
    leaveAskedAtRef.current = Date.now();
    setLeaveError(null);
    setLeaveAsking(true);
  }, []);

  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (leaveConfirmedRef.current) return;
      e.preventDefault();
      askLeave();
    });
    return unsub;
  }, [navigation, askLeave]);

  const cancelLeave = useCallback(() => {
    leaveGenerationRef.current += 1; // 進行中の終了処理の結果を無効にする
    leaveAskedAtRef.current = null;
    setLeaveError(null);
    setLeaveAsking(false);
  }, []);

  // 上限の60秒はタイマーだけでは守れない（背面に回ると JS タイマーごと止まる
  // 端末がある）。復帰時に経過を見て、超えていれば「つづける」に倒す。
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active' || !leaveAsking) return;
      const asked = leaveAskedAtRef.current;
      if (asked && Date.now() - asked >= LEAVE_DIALOG_TIMEOUT_MS) cancelLeave();
    });
    return () => sub.remove();
  }, [leaveAsking, cancelLeave]);

  const confirmLeave = useCallback(async () => {
    if (!online) {
      setLeaveError('いまは インターネットに つながっていません。つながってから おわってね。');
      return;
    }
    const generation = leaveGenerationRef.current;
    setLeaveError(null);
    setLeaving(true);
    // 圏外では書き込みがサーバー ack まで解決しないため、制限時間で打ち切る
    const delivered = await Promise.race([
      useSession.getState().endSession('ended'),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), END_SESSION_TIMEOUT_MS)),
    ]);
    if (generation !== leaveGenerationRef.current) return; // 遅れて届いた結果は捨てる
    setLeaving(false);
    if (!delivered) {
      setLeaveError('まだ おわれていません。つうしんを かくにんして、もういちど おしてね。');
      return;
    }
    setLeaveAsking(false);
    leaveConfirmedRef.current = true;
    stopBackgroundWalk();
    navigation.popToTop();
  }, [navigation, online]);

  // 異常検知エンジン（位置停滞／転倒／移動異常 → 本人確認 → 見守りへ）
  const { localCheck, remaining, resolveLocalCheck, localCheckReason } = useSentinel(
    resting, session.sentinelSensitivity, session.transport,
  );

  // セッション未参加でここに来た場合は歩行画面に留まらない（SOS・エスカレーションが
  // 無音で失敗する状態になるため）。通常フローは Start 画面で塞いでいるので、これは
  // 通知タップ・状態復元など将来の経路追加に対する保険。
  useEffect(() => {
    const g = useSession.getState();
    if (canStartWalk(g.sessionId, g.myRole, g.status)) return;
    console.warn('MainSentinel: セッション未参加のため歩行画面に入れません');
    // 復帰経路（restoreWalkSession）が張った購読が残るので、ここで必ず解放する
    useSession.getState().stopListening();
    leaveConfirmedRef.current = true;
    navigation.popToTop();
  }, []);

  // 休憩の自動再開
  useEffect(() => {
    if (!resting) return;
    const t = setTimeout(() => {
      setResting(false);
      setActiveWalkResting(false);
      notify('見守りを再開しました 🌙', `休憩から${REST_AUTO_RESUME_MINUTES}分たったので、自動で見守りに戻りました。`, 'default', { type: 'rest_resumed', sessionId: session.sessionId ?? undefined });
    }, REST_AUTO_RESUME_MS);
    return () => clearTimeout(t);
  }, [resting]);

  // 見守りからの安否確認が来ていて、まだ応答していない状態か
  const safetyPending = session.safetyCheckRequestedAt != null && session.safetyCheckResponse == null;
  // 見守りに通知済み（エスカレーション後）か
  const escalated = session.status === 'anomaly';
  const sosActive = session.status === 'sos';
  const overlayActive = localCheck || escalated || safetyPending || showArrival || endedReason != null;
  // 離脱ガードは登録が先なので、緊急表示の有無は ref 経由で伝える
  useEffect(() => {
    emergencyOverlayRef.current = localCheck || escalated || safetyPending;
  }, [localCheck, escalated, safetyPending]);

  // 省電力ディム。休憩中・確認中・到着時は常に明るくする
  const [dimmed, setDimmed] = useState(false);
  useEffect(() => {
    if (resting || overlayActive) {
      setDimmed(false);
      return;
    }
    if (dimmed) return;
    const t = setTimeout(() => setDimmed(true), DIM_AFTER_MS);
    return () => clearTimeout(t);
  }, [resting, overlayActive, dimmed]);

  // 経過時間（分）。30秒ごとに更新
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const elapsedMin = session.walkStartedAt
    ? Math.max(0, Math.floor((now - session.walkStartedAt.getTime()) / 60_000))
    : null;

  const toggleResting = () => {
    const next = !resting;
    haptics.tap();
    setResting(next);
    setActiveWalkResting(next); // バックグラウンド検知にも反映
  };

  const onArrived = async () => {
    if (!online) {
      Alert.alert('まだ送れていません', 'インターネットに接続してから、もう一度「着きました」を操作してください。');
      return false;
    }
    haptics.success();
    const delivered = await session.endSession('arrived');
    if (!delivered) {
      Alert.alert('まだ送れていません', '見守りの人への到着連絡に失敗しました。通信を確認して、もう一度操作してください。');
      return false;
    }
    setShowArrival(true);
    return true;
  };

  // エスカレーション後／安否確認に対する本人の応答
  const onPostSafe = () => {
    haptics.success();
    if (safetyPending) session.respondSafetyCheck('ok');
    else session.resolveAnomaly();
    // 立ち止まったまま応答した場合に bg 停滞タイマーが再エスカレートしないようリセット
    resetStallState().catch(() => {});
    // 人気のない場所に居たままの応答なら、その滞在が終わるまで再発火させない
    if (session.anomalyType === 'area') acknowledgeAreaDetection().catch(() => {});
  };
  // オーバーレイからのSOSも音あり／音なしを選べるようにダイアログを通す
  const onPostSOS = () => {
    confirmSOS((silent) => {
      if (safetyPending) session.respondSafetyCheck('sos', silent);
      else session.triggerSOS(silent);
    });
  };

  return (
    <SkyScreen>
      <SafeAreaView style={styles.screen}>
      <WalkToolbar onCall={showEmergencySheet} onChat={() => navigation.navigate('Chat')} />
        <ScrollView
          contentContainerStyle={styles.safe}
          keyboardShouldPersistTaps="handled"
        >
          <SOSDeliveryNotice
            status={session.sosDeliveryStatus}
            silent={session.sosSilent}
            watcherAcknowledged={session.sosAcknowledgedAt != null}
          />
          {/* 「みまもられているか」を常時1行で返す（歩行2画面で同じ部品・同じ文言） */}
          <WatchStatusLine
            fullWidth
            tone={watchTone({
              online,
              walkStart,
              lastHeartbeatOkAt: session.lastHeartbeatOkAt,
              now,
              sessionLive: !session.isSessionExpired,
            })}
            hint={foregroundOnly ? 'この画面を ひらいている あいだだけ みまもれるよ' : undefined}
            meta={`目安 ${estimatedMinutes}分${elapsedMin != null ? ` · あるいて ${elapsedMin}分` : ''}`}
          />

          <View style={styles.centerBlock}>
            <Text style={styles.heading}>いつもの みち</Text>
            <Text style={styles.sub}>
              {resting
                ? `やすんでいるよ（${REST_AUTO_RESUME_MINUTES}分で じどうで もどるよ）`
                : 'こまったら ボタンを おしてね'}
            </Text>
          </View>

          {/* 操作する円だけを主役にし、発信中のハローは既存SOS部品に任せる。 */}
          <View style={styles.hero}>
            <HeroSOSButton
              active={sosActive}
              onTrigger={() => confirmSOS(session.triggerSOS)}
              onCancel={() => confirmCancelSOS(session.cancelSOS)}
              alarmSounding={alarmSounding}
              onMuteAlarm={muteAlarm}
            />
          </View>

          <SlideToArrive onArrived={onArrived} />

          <View style={styles.chipRow}>
            <Pressable
              style={[styles.chip, resting && styles.chipActive]}
              onPress={toggleResting}
              accessibilityRole="button"
              accessibilityLabel={resting ? '見守りを再開する' : '休憩中にして検知を一時停止する'}
            >
              <Icon name={resting ? 'walk' : 'moon'} size={18} />
              <Text style={styles.chipText}>{resting ? 'もどる' : 'やすむ'}</Text>
            </Pressable>
            {[5, 10].map((m) => (
              <Pressable key={m} style={styles.chip} onPress={() => { haptics.tap(); session.extendTime(m); }}>
                <Text style={styles.chipText}>+{m}分</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.leaveRow}>
            <LeaveWalkLink onTrigger={askLeave} />
          </View>
        </ScrollView>
      </SafeAreaView>

      {/* 省電力ディム（タップで復帰。検知・共有・SOSは生きている） */}
      {dimmed && (
        <Pressable
          style={styles.dimOverlay}
          onPress={() => setDimmed(false)}
          accessibilityRole="button"
          accessibilityLabel="画面を明るくする。見守りは続いています"
        >
          <View style={styles.dimMoon}><Icon name="moon" size={96} /></View>
          <Text style={styles.dimText}>見守りは つづいています</Text>
          <Text style={styles.dimHint}>タップで 画面が あかるくなるよ</Text>
        </Pressable>
      )}

      {/* ① 本人確認（見守りへ通知する前のワンクッション） */}
      {localCheck && !escalated && !safetyPending && (
        <CheckOverlay
          tone="caution"
          icon={localCheckReason === 'fall' ? 'fall' : localCheckReason === 'area' ? 'pin' : 'moon'}
          title="だいじょうぶ？"
          sub={
            localCheckReason === 'fall' ? 'ころんだ／ぶつかったみたいだよ'
            : localCheckReason === 'area' ? 'みちの ない ところに はいったみたいだよ'
            : 'うごきが とまっているみたいだよ'
          }
          remaining={remaining}
          safeLabel={localCheckReason === 'area' ? 'だいじょうぶ！ここに ようが あるよ' : 'だいじょうぶ！'}
          onSafe={resolveLocalCheck}
          secondaryLabel="📞 こまっている（緊急通報）"
          onSecondary={showEmergencySheet}
        />
      )}

      {/* ② エスカレーション後／見守りからの安否確認への応答 */}
      {(escalated || safetyPending) && (
        <CheckOverlay
          tone={safetyPending ? 'caution' : 'critical'}
          icon={
            safetyPending ? 'bell'
            : session.anomalyType === 'move' ? 'vehicle'
            : session.anomalyType === 'area' ? 'pin'
            : 'warning'
          }
          title={safetyPending ? '見守りから連絡' : '見守りに知らせました'}
          sub={
            safetyPending ? '「だいじょうぶ？」と聞かれています'
            : session.anomalyType === 'move' ? 'のりものの はやさで うごいていたよ。だいじょうぶ？'
            : session.anomalyType === 'area' ? 'みちの ない ところに いるみたい。だいじょうぶ？'
            : '心配しています。だいじょうぶ？'
          }
          safeLabel="だいじょうぶ！"
          onSafe={onPostSafe}
          secondaryLabel="🆘 たすけて（SOS）"
          onSecondary={onPostSOS}
        />
      )}

      {/* 画面を閉じる＝見守り終了。放置されたら60秒で「つづける」に倒す */}
      <ConfirmDialog
        visible={leaveAsking}
        icon="moon"
        title="みまもりを おわりますか？"
        body={'とじると みまもりが おわって、見守る人に つたわります。\nあるいているあいだは この画面のままにしてね。'}
        cancelLabel="つづける"
        confirmLabel="おわる"
        errorText={leaveError}
        onCancel={cancelLeave}
        onConfirm={confirmLeave}
        autoCancelMs={LEAVE_DIALOG_TIMEOUT_MS}
        busy={leaving}
      />

      {showArrival && <ArrivalOverlay onDone={exitScreen} variant="full" />}

      {/* 相手側・サーバー側でセッションが終わった場合（放置GC・キャンセル） */}
      {!showArrival && endedReason && (
        <SessionEndedOverlay reason={endedReason} onDone={exitScreen} />
      )}
    </SkyScreen>
  );
}

// SOSの実寸240ptは変えず、装飾用の余白だけを減らす。
const HERO_BOX = 256;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  safe: {
    flexGrow: 1, alignItems: 'center', justifyContent: 'center',
    gap: space.md, paddingHorizontal: 24, paddingVertical: space.md,
  },
  centerBlock: { alignItems: 'center', gap: space.xs },
  heading: { fontSize: 32, fontWeight: '800', color: color.text, textAlign: 'center' },
  sub: { fontSize: 22, color: color.text, textAlign: 'center' },
  hero: { width: HERO_BOX, height: HERO_BOX, alignItems: 'center', justifyContent: 'center' },
  leaveRow: { alignSelf: 'center' },
  chipRow: { flexDirection: 'row', gap: 12, flexWrap: 'wrap', justifyContent: 'center' },
  // フォント設定を大きくしても文字が切れないよう最低寸法＋余白で組む（F-1）
  chip: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs,
    minWidth: 84, minHeight: 44, paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.lg,
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.raisedStroke,
  },
  chipActive: { backgroundColor: dim(color.action, 0.3), borderColor: dim(color.action, 0.7) },
  chipText: { color: color.text, fontSize: font.body, fontWeight: '600' },
  dimOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.93)', alignItems: 'center', justifyContent: 'center', gap: space.sm,
  },
  dimMoon: { opacity: 0.8 },
  // ディム中は地が真っ黒に近いので、textSub(.7) まで上げると眩しい。.55 は 6.3:1 で AA 済み
  dimText: { fontSize: font.body, fontWeight: '600', color: 'rgba(255,255,255,0.55)' },
  dimHint: { fontSize: font.caption, color: color.textFaint },
});
