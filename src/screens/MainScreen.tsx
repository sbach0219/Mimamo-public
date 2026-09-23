import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, AppState, Alert, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import * as Notifications from 'expo-notifications';
import { useKeepAwake } from 'expo-keep-awake';
import { SkyScreen } from '../theme/Background';
import { ArrivalOverlay } from '../components/ArrivalOverlay';
import { SessionEndedOverlay, endedReasonFor, type SessionEndedReason } from '../components/SessionEndedOverlay';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CheckOverlay } from '../components/CheckOverlay';
import { SlideToArrive } from '../components/SlideToArrive';
import { SOSButton } from '../components/SOSButton';
import { SOSDeliveryNotice } from '../components/SOSDeliveryNotice';
import { LeaveWalkLink } from '../components/LeaveWalkLink';
import { WatchStatusLine } from '../components/WatchStatusLine';
import { WalkToolbar } from '../components/WalkToolbar';
import { watchTone } from '../lib/watchStatus';
import { Icon } from '../components/Icon';
import { colors } from '../theme/colors';
import { color, dim, font, radius, space } from '../theme/tokens';
import { haptics } from '../lib/haptics';
import { useIsOnline } from '../lib/network';
import { confirmSOS, confirmCancelSOS, showEmergencySheet } from '../lib/emergency';
import { noticeWalkStart } from '../lib/walkStartNotice';
import { useSOSAlarm } from '../hooks/useSOSAlarm';
import { useBatteryReport } from '../hooks/useBatteryReport';
import { usePlaceLabelReport } from '../hooks/usePlaceLabelReport';
import { useSession } from '../store/sessionStore';
import { canStartWalk } from '../lib/walkGate';
import { setForegroundNoticeSuppressed } from '../lib/notifications';
import { startBackgroundWalk, stopBackgroundWalk, updateActiveWalkHome, type WalkStartResult } from '../tasks/locationTask';
import type { ScreenProps } from '../navigation/types';

const ALERT_THRESHOLD = 30; // 指を離してアラートまでの秒数
// 離脱確認を開いたまま放置できる上限。超えたら「つづける」に倒して見守りを再開する
// （センチネルの本人確認と同じ 60 秒の設計語彙）
const LEAVE_DIALOG_TIMEOUT_MS = 60_000;
// 「おわる」を押してから見守り側に届いたと確認できるまでの上限
const END_SESSION_TIMEOUT_MS = 8_000;

export default function MainScreen({ route, navigation }: ScreenProps<'Main'>) {
  useKeepAwake(); // 歩行中は画面を消さない

  const online = useIsOnline();
  const session = useSession();
  // 目安時間は「+N分」の延長がリアルタイムに反映されるようストアの値を表示する
  // （route.params は開始時点の値のままなので延長しても増えない。issue #8）
  const estimatedMinutes = session.estimatedMinutes || route.params.estimatedMinutes;
  // SOS発信中（音ありモード）は端末からサイレン＋バイブ
  const { alarmSounding, muteAlarm } = useSOSAlarm(session.status === 'sos' && !session.sosSilent);
  // 電池残量を60秒ごとに見守り側へ送る（§8）
  useBatteryReport();
  // いまいる場所の地名だけをセッション文書へ置いていく（D-14）。
  // 終端時に Functions がペアの「最終確認」へ転記する。座標は転記されない。
  usePlaceLabelReport(session.walkerLocation, session.status !== 'waiting');

  const [isPressing, setPressing] = useState(false);
  const [secondsOff, setSecondsOff] = useState(0);
  const [showAlert, setShowAlert] = useState(false);
  const [showArrival, setShowArrival] = useState(false);
  // 相手側・サーバー側で終わったセッション（ended / cancelled）の表示
  const [endedReason, setEndedReason] = useState<SessionEndedReason | null>(null);
  // 「使用中のみ許可」で動いている（アプリを閉じると止まる）ことの可視化
  const [foregroundOnly, setForegroundOnly] = useState(false);
  // 見守り状態の一目表示に使う（権限の降格・開始失敗もここで拾う）
  const [walkStart, setWalkStart] = useState<WalkStartResult | null>(null);
  // 状態表示の鮮度用。ホールド中はカウントダウンが止まって再描画されないため、
  // 30秒ごとに時刻を進める（heartbeat の間隔と同じ粒度で十分）
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  // 見守りからの安否確認が来ていて、まだ応答していない状態か（センチネル側と同じ判定）
  const safetyPending = session.safetyCheckRequestedAt != null && session.safetyCheckResponse == null;
  const sosActive = session.status === 'sos';
  // SOS 中の「だいじょうぶ」は救難信号の取り消しそのものなので、
  // SOSボタンからの取り消しと同じ確認を必ず通す（M-3）
  const answerSafetyCheckDuringSos = () =>
    confirmCancelSOS(() => {
      haptics.success();
      session.respondSafetyCheck('ok');
    });
  // 画面を閉じる＝見守り終了、の確認（F-2）
  const [leaveAsking, setLeaveAsking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const startDateRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notifIdRef = useRef<string | null>(null);
  const isPressingRef = useRef(false);
  // 自分の意思で画面を出るとき（到着・終了・未参加ガード）は離脱ガードを通さない
  const leaveConfirmedRef = useRef(false);
  const leaveAskedAtRef = useRef<number | null>(null);
  // 終了処理の世代。キャンセル後に遅れて返ってきた結果で画面を動かさないため
  const leaveGenerationRef = useRef(0);

  // ----- 安全タイマー -----
  const cancelSafetyNotification = useCallback(async () => {
    if (notifIdRef.current) {
      await Notifications.cancelScheduledNotificationAsync(notifIdRef.current).catch(() => {});
      notifIdRef.current = null;
    }
  }, []);

  const scheduleSafetyNotification = useCallback(async () => {
    await cancelSafetyNotification();
    notifIdRef.current = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'だいじょうぶ？🌙',
        body: 'ボタンから ゆびが はなれているよ。アプリをひらいて かくにんしてね。',
        sound: 'default',
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: ALERT_THRESHOLD },
    });
  }, [cancelSafetyNotification]);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    startDateRef.current = null;
    cancelSafetyNotification();
  }, [cancelSafetyNotification]);

  const triggerAlert = useCallback(() => {
    setShowAlert(true);
    haptics.error();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    startDateRef.current = null;
    session.updateStatus('alert');
  }, [session]);

  const startTimer = useCallback(() => {
    startDateRef.current = Date.now();
    setSecondsOff(0);
    scheduleSafetyNotification();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      if (!startDateRef.current) return;
      const s = Math.floor((Date.now() - startDateRef.current) / 1000);
      setSecondsOff(s);
      if (s >= ALERT_THRESHOLD) triggerAlert();
    }, 1000);
  }, [scheduleSafetyNotification, triggerAlert]);

  // ----- 指の上げ下げ -----
  const onPressIn = () => {
    isPressingRef.current = true;
    setPressing(true);
    haptics.tap();
    stopTimer();
    setSecondsOff(0);
  };
  const onPressOut = () => {
    isPressingRef.current = false;
    setPressing(false);
    haptics.warning();
    startTimer();
  };

  // ----- マウント時の初期化 -----
  useEffect(() => {
    // セッション未参加でここに来た場合は歩行を始めない（SOS・到着連絡が無音で
    // 失敗する状態になるため）。通常フローは Start 画面で塞いでいるので、これは
    // 通知タップ・状態復元など将来の経路追加に対する保険。
    const gate = useSession.getState();
    if (!canStartWalk(gate.sessionId, gate.myRole, gate.status)) {
      console.warn('Main: セッション未参加のため歩行画面に入れません');
      // 復帰経路（restoreWalkSession）が張った購読が残るので、ここで必ず解放する
      useSession.getState().stopListening();
      leaveConfirmedRef.current = true;
      navigation.popToTop();
      return;
    }
    session.listenToSession();
    startTimer();

    // バックグラウンドでも位置・ハートビートを送り続ける（到着判定もタスク側で実施）。
    // transport（徒歩宣言）を渡すことで、ホールドモードでも移動異常（連れ去り）検知が bg で動く
    const sessionId = useSession.getState().sessionId;
    if (sessionId) {
      startBackgroundWalk(
        sessionId, useSession.getState().homeLocation, 'hold', 'medium', useSession.getState().transport,
      ).then((result) => {
        setForegroundOnly(result === 'foreground-only');
        setWalkStart(result);
        // 結果をセッション文書にも残す（H-2）。見守り側はこれを見て
        // 「位置が届いていません」を出す。画面を出る前に必ず書いておく。
        useSession.getState().reportLocationMode(result);
        // 位置が使えないまま歩行画面に留まらない。見守りが成立していないのに
        // 「見守り中」の画面が出ていることが、この機能でいちばん危ない失敗になる。
        // 位置が使えないときは画面から出すだけでなくセッションも畳む（M-C）。
        // active のまま放置すると、見守り側には「位置が届かない歩行中」が
        // 期限まで残り、歩く人の器にも死んだセッションが居座る。
        const blocked = result === 'denied' || result === 'failed';
        noticeWalkStart(result, blocked ? abandonAndExit : undefined);
      });
    }

    // ハートビート（30秒ごと。前面で立ち止まっていても接続を保つ）
    const heartbeat = setInterval(() => session.updateHeartbeat(), 30_000);
    session.updateHeartbeat();

    // 電池残量は useBatteryReport（共通フック）が60秒ごとに送る

    // フォアグラウンド復帰時に経過秒を再計算（バックグラウンドでタイマーが止まる対策）
    const appStateSub = AppState.addEventListener('change', (st) => {
      if (st !== 'active' || isPressingRef.current || !startDateRef.current) return;
      const elapsed = Math.floor((Date.now() - startDateRef.current) / 1000);
      setSecondsOff(elapsed);
      if (elapsed >= ALERT_THRESHOLD) triggerAlert();
    });

    return () => {
      stopTimer();
      clearInterval(heartbeat);
      appStateSub.remove();
      stopBackgroundWalk();
      // 画面を離れるときはFirestoreリスナーも解放（リーク防止）
      const s = useSession.getState();
      s.stopConnectionMonitoring();
      s.stopListening();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- 画面を閉じる＝見守り終了（F-2 / オーナー決定 D-5）-----
  // Android の戻るボタンなどで黙って画面を出ると、位置共有もデッドマン判定も
  // 止まったまま見守り側には「正常」に見える。必ず確認して正規終端させる。
  // 自分から抜ける（到着・終了オーバーレイ・未参加ガード）ときはガードを通さない
  const exitScreen = useCallback(() => {
    leaveConfirmedRef.current = true;
    navigation.popToTop();
  }, [navigation]);

  // 位置共有が成立しなかったときの出口（H-2 / M-C）。画面を出るだけでは
  // セッションが active のまま残るので、キャンセルとして畳んでから出る。
  const abandonAndExit = useCallback(() => {
    useSession.getState().abandonSession().catch(() => {});
    exitScreen();
  }, [exitScreen]);

  // ダイアログを見ているあいだは指を離していても異変ではないので、前面の
  // カウントダウンは止める。ただし30秒後の予約通知は消さない（そのまま背面に
  // 回った端末では、この通知だけが唯一の合図になるため。QA指摘 H-1 による
  // §4-A からの改訂）。前面で鳴らないよう表示だけ抑制する。
  const askLeave = useCallback(() => {
    // 緊急オーバーレイが出ているあいだは離脱の相談をしない。いま答えるべきは
    // 「だいじょうぶ？」であって、見守りを終えるかどうかではない
    if (showAlert) return;
    leaveAskedAtRef.current = Date.now();
    setForegroundNoticeSuppressed(true);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    startDateRef.current = null;
    setSecondsOff(0);
    setLeaveError(null);
    setLeaveAsking(true);
  }, [showAlert]);

  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (leaveConfirmedRef.current) return;
      e.preventDefault();
      askLeave();
    });
    return unsub;
  }, [navigation, askLeave]);

  // 上限の60秒はタイマーだけでは守れない（ダイアログを開いたまま背面に回ると
  // JS タイマーごと止まる端末がある）。復帰時に経過を見て、超えていれば
  // その場で「つづける」に倒す。
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active' || !leaveAsking) return;
      const asked = leaveAskedAtRef.current;
      if (asked && Date.now() - asked >= LEAVE_DIALOG_TIMEOUT_MS) cancelLeave();
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaveAsking]);

  const cancelLeave = useCallback(() => {
    leaveGenerationRef.current += 1; // 進行中の終了処理の結果を無効にする
    leaveAskedAtRef.current = null;
    setForegroundNoticeSuppressed(false);
    setLeaveAsking(false);
    setLeaveError(null);
    // 閉じたら30秒フルから再開する（半端な残り秒で再開しない）。
    // ただし到着・終了・アラートの表示中は、そこから先の画面に任せる
    if (!isPressingRef.current && !showArrival && !endedReason && !showAlert) startTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTimer, showArrival, endedReason, showAlert]);

  const confirmLeave = useCallback(async () => {
    if (!online) {
      setLeaveError('いまは インターネットに つながっていません。つながってから おわってね。');
      return;
    }
    const generation = leaveGenerationRef.current;
    setLeaveError(null);
    setLeaving(true);
    // 圏外では Firestore の書き込みがサーバー ack まで解決しないので、
    // 待ちっぱなしにせず制限時間で打ち切る
    const delivered = await Promise.race([
      session.endSession('ended'),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), END_SESSION_TIMEOUT_MS)),
    ]);
    // 遅れて届いた結果で画面を動かさない（すでに閉じた・別の操作に移ったあと）
    if (generation !== leaveGenerationRef.current) return;
    setLeaving(false);
    if (!delivered) {
      // 見守り側に「終わった」と伝わらないまま画面だけ閉じると、相手には
      // 通信途絶（N11）として届く。伝わるまでは閉じない。
      setLeaveError('まだ おわれていません。つうしんを かくにんして、もういちど おしてね。');
      return;
    }
    leaveConfirmedRef.current = true;
    setForegroundNoticeSuppressed(false);
    setLeaveAsking(false);
    stopTimer();
    stopBackgroundWalk();
    navigation.popToTop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, session, online]);

  // 自宅位置はリスナーで遅れて届くことがあるので、変化したらタスクへ反映
  useEffect(() => {
    updateActiveWalkHome(session.homeLocation);
  }, [session.homeLocation]);

  // バックグラウンドタスクが到着を検知して status を 'arrived' にしたら、
  // 前面でもお祝いオーバーレイを出す
  useEffect(() => {
    if (session.status === 'arrived' && !showArrival) {
      haptics.success();
      setShowArrival(true);
      stopTimer();
      stopBackgroundWalk();
    }
    // 相手側・サーバー側（放置GC）でセッションが終わった場合。位置共有とデッドマン
    // 判定を止めたうえで、歩く人にも終わったことを伝える（黙って止めると
    // 「見守られているつもり」のまま歩き続けることになる）。
    // 同じ処理が useWalkLifecycle.ts にもある（センチネル側）。F-1 の統合までは
    // 二重管理なので、どちらかを直したらもう一方も直すこと。
    if (session.status === 'ended' || session.status === 'cancelled') {
      // 見守る人が自分で終えた場合（F-10）だけ、時間切れと言い分ける
      setEndedReason((prev) => prev ?? endedReasonFor(session.status, session.endedBy));
      stopTimer();
      stopBackgroundWalk();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.status]);

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
    stopTimer();
    stopBackgroundWalk();
    setShowArrival(true);
    return true;
  };

  const ringColor = secondsOff < 15 ? colors.yellow : secondsOff < 25 ? colors.orange : colors.red;
  const remaining = Math.max(0, ALERT_THRESHOLD - secondsOff);

  return (
    <SkyScreen pressed={isPressing} starOpacity={isPressing ? 0.3 : 1}>
      <SafeAreaView style={styles.screen}>
        <WalkToolbar
          onCall={showEmergencySheet}
          onChat={() => navigation.navigate('Chat')}
          sos={(
            <SOSButton
              active={sosActive}
              onTrigger={() => confirmSOS(session.triggerSOS)}
              onCancel={() => confirmCancelSOS(session.cancelSOS)}
              alarmSounding={alarmSounding}
              onMuteAlarm={muteAlarm}
            />
          )}
        />
        <ScrollView
          contentContainerStyle={styles.safe}
          scrollEnabled={!isPressing}
          canCancelContentTouches={false}
        >
          <SOSDeliveryNotice
            status={session.sosDeliveryStatus}
            silent={session.sosSilent}
            watcherAcknowledged={session.sosAcknowledgedAt != null}
          />
          {/* 「みまもられているか」を常時1行で返す。位置は送れているのにデッドマン
              判定は止まっている、といった食い違いは本人にも見えないままになるため */}
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
            meta={`目安 ${estimatedMinutes}分`}
          />
          {/* SOS発信中に届いた安否確認は、全画面オーバーレイではなくこの行で受ける。
              全画面で覆うと、いちばん大きい「だいじょうぶ！」の1タップで救難信号が
              消えるうえ、サイレンのミュートと SOS ボタンに手が届かなくなる（M-3）。
              応答は SOS の取り消しと同じ確認ダイアログを通す。 */}
          {safetyPending && sosActive && (
            <Pressable
              style={styles.safetyAsk}
              onPress={answerSafetyCheckDuringSos}
              accessibilityRole="button"
              accessibilityLabel="見守りから「だいじょうぶ？」と聞かれています。だいじょうぶと返す"
            >
              <Icon name="bell" size={18} />
              <View style={{ flex: 1 }}>
                <Text style={styles.safetyAskTitle}>見守りから「だいじょうぶ？」</Text>
                <Text style={styles.safetyAskSub}>ここを押すと「だいじょうぶ」と返せます（SOSは取り消されます）</Text>
              </View>
            </Pressable>
          )}
          {/* 安否確認のカードが出ているあいだは、その行を見出しの代わりにする */}
          {!(safetyPending && sosActive) && (
            <View style={styles.headingBlock}>
              <Text style={styles.heading}>おまもりボタン</Text>
              <Text style={styles.status}>{isPressing ? 'そのまま おさえて あるいてね' : 'ゆびが はなれているよ'}</Text>
            </View>
          )}

          <Pressable
            onPressIn={onPressIn} onPressOut={onPressOut} style={styles.touchWrap}
            accessibilityRole="button"
            accessibilityLabel="おまもりボタン。歩いているあいだはおさえていてね"
          >
            <CountdownRing progress={Math.min(1, secondsOff / ALERT_THRESHOLD)} color={ringColor} active={!isPressing} />
            {/* 押下中だけ描く装飾リング。非押下は CountdownRing が 25 秒以降 danger の
                赤になり、rosePale と輝度比 1.03:1 で隣り合うと赤の警告が濁る */}
            {isPressing && (
              <Svg width={TOUCH_BOX} height={TOUCH_BOX} style={StyleSheet.absoluteFill} pointerEvents="none">
                <Circle cx={TOUCH_BOX / 2} cy={TOUCH_BOX / 2} r={134} fill="none"
                  stroke={color.starAccent} strokeOpacity={0.6} strokeWidth={2.5} />
                <Circle cx={TOUCH_BOX / 2} cy={TOUCH_BOX / 2} r={148} fill="none"
                  stroke={color.starAccent} strokeOpacity={0.35} strokeWidth={1.5} />
              </Svg>
            )}
            <View style={[styles.innerCircle, isPressing && styles.innerCirclePressed]}>
              <Icon name={isPressing ? 'star' : 'hold'} size={56} />
              {isPressing ? (
                <>
                  <Text style={styles.innerTitle} maxFontSizeMultiplier={1.3}>おさえてるよ</Text>
                  <Text style={styles.innerSub} maxFontSizeMultiplier={1.3}>そのまま あるいてね</Text>
                </>
              ) : (
                <>
                  <Text style={styles.innerTitle} maxFontSizeMultiplier={1.3}>{'ここを\nおさえてね'}</Text>
                  <Text style={[styles.countdown, { color: ringColor }]} maxFontSizeMultiplier={1.3}>
                    あと {remaining} びょう
                  </Text>
                </>
              )}
            </View>
          </Pressable>

          <SlideToArrive onArrived={onArrived} />

          <View style={styles.leaveRow}>
            <LeaveWalkLink onTrigger={askLeave} />
          </View>

          <View style={styles.extendRow}>
            {[5, 10].map((m) => (
              <Pressable key={m} style={styles.extendBtn} onPress={() => { haptics.tap(); session.extendTime(m); }}>
                <Text style={styles.extendText}>+{m}分</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>

      {/* 見守りからの安否確認（v3 §5.1）。これまで MainSentinelScreen にしか無く、
          ホールド型で歩いているあいだは「だいじょうぶ？」に応答する手段が無かった。
          見守り側の SOS 画面は、この応答で本人が SOS を解除できることを前提にする。
          ホールドの離脱アラート（critical）が出ているときは、そちらを優先する */}
      {safetyPending && !sosActive && !showAlert && !showArrival && !endedReason && (
        <CheckOverlay
          tone="caution"
          icon="bell"
          title="見守りから連絡"
          sub="「だいじょうぶ？」と聞かれています"
          safeLabel="だいじょうぶ！"
          onSafe={() => { haptics.success(); session.respondSafetyCheck('ok'); }}
          secondaryLabel="🆘 たすけて（SOS）"
          onSecondary={() => confirmSOS((silent) => session.respondSafetyCheck('sos', silent))}
        />
      )}

      {showAlert && (
        <CheckOverlay
          tone="critical"
          icon="warning"
          title="だいじょうぶ？"
          sub="ボタンから ゆびが はなれていたよ"
          onSafe={() => {
            haptics.success();
            setShowAlert(false);
            setSecondsOff(0);
            session.updateStatus('active');
            startTimer();
          }}
          secondaryLabel="📞 こまっている（緊急通報）"
          onSecondary={() => { setShowAlert(false); showEmergencySheet(); }}
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

      {!showArrival && endedReason && (
        <SessionEndedOverlay reason={endedReason} onDone={exitScreen} />
      )}
    </SkyScreen>
  );
}

function CountdownRing({ progress, color, active }: { progress: number; color: string; active: boolean }) {
  const size = 280;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
      <Circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.12)" strokeWidth={stroke} fill="none" />
      {active && (
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - progress)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </Svg>
  );
}

// CountdownRing 280 の外側に装飾リングを置くぶんの余白
const TOUCH_BOX = 300;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  safe: {
    flexGrow: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 24, paddingVertical: 16, gap: space.md,
  },
  headingBlock: { alignItems: 'center', gap: 8 },
  heading: { fontSize: 32, fontWeight: '800', color: color.text, textAlign: 'center' },
  safetyAsk: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    marginHorizontal: 16, minHeight: 56, paddingVertical: space.sm, paddingHorizontal: 14,
    borderRadius: radius.md,
    backgroundColor: dim(color.caution, 0.16), borderWidth: 1.5, borderColor: color.caution,
  },
  safetyAskTitle: { fontSize: font.body, fontWeight: '800', color: color.text },
  safetyAskSub: { fontSize: font.caption, color: color.textSub, marginTop: 2, lineHeight: 17 },
  status: { fontSize: 22, color: color.text, textAlign: 'center' },
  touchWrap: { width: TOUCH_BOX, height: TOUCH_BOX, alignItems: 'center', justifyContent: 'center' },
  innerCircle: {
    width: 240, height: 240, borderRadius: 120, alignItems: 'center', justifyContent: 'center',
    gap: space.xs, paddingHorizontal: 20,
    backgroundColor: color.glass, borderWidth: 2, borderColor: color.raisedStroke,
  },
  innerCirclePressed: { backgroundColor: dim(color.action, 0.35), borderColor: dim(color.action, 0.8) },
  innerTitle: { fontSize: font.lead, fontWeight: '600', color: color.text, textAlign: 'center' },
  innerSub: { fontSize: font.body, color: color.textSub, textAlign: 'center' },
  countdown: { fontSize: font.sub, fontWeight: '700', textAlign: 'center' },
  leaveRow: { alignSelf: 'center' },
  extendRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12 },
  // フォント設定を大きくしても文字が切れないよう最低寸法＋余白で組む（F-1）
  extendBtn: {
    minWidth: 84, minHeight: 44, paddingHorizontal: 12, paddingVertical: 8,
    alignItems: 'center', justifyContent: 'center', borderRadius: radius.lg,
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.raisedStroke,
  },
  extendText: { color: color.text, fontSize: font.body, fontWeight: '600' },
});
