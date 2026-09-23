import 'react-native-gesture-handler';
import React, { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  NavigationContainer, DarkTheme, useNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { getMessaging, onNotificationOpenedApp, getInitialNotification } from '@react-native-firebase/messaging';

import { useSession } from './src/store/sessionStore';
import { useProfile } from './src/store/profileStore';
import { usePairs } from './src/store/pairStore';
import { useEntitlement } from './src/store/entitlementStore';
import { configurePurchases } from './src/lib/purchases';
import { ensureNotificationPermission } from './src/lib/notifications';
import { getFcmToken, setupForegroundMessages, setupTokenRefresh } from './src/lib/messaging';
import { getActiveWatches, clearActiveWatch } from './src/lib/activeWatch';
import { getActiveWalkSessionId, stopBackgroundWalk } from './src/tasks/locationTask';
import { routeNotificationTap, type NotificationRouteRequest } from './src/lib/notificationRouting';
import { haptics } from './src/lib/haptics';
import { lightColor, palette } from './src/theme/tokens';
import type { RootStackParamList } from './src/navigation/types';

import OnboardingScreen, { ONBOARDING_DONE_KEY } from './src/screens/OnboardingScreen';
import RoleSelectScreen from './src/screens/RoleSelectScreen';
import WatcherTabs from './src/navigation/WatcherTabs';
import WatcherSetupScreen from './src/screens/WatcherSetupScreen';
import WatcherMonitorScreen from './src/screens/WatcherMonitorScreen';
import WatcherSosScreen from './src/screens/WatcherSosScreen';
import StartScreen from './src/screens/StartScreen';
import MainScreen from './src/screens/MainScreen';
import MainSentinelScreen from './src/screens/MainSentinelScreen';
import ChatScreen from './src/screens/ChatScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import PairsScreen from './src/screens/PairsScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import WatchRequestScreen from './src/screens/WatchRequestScreen';
import PaywallScreen from './src/screens/PaywallScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

// 見守り側（昼テーマ）の画面ヘッダー。ヘッダーは濃ローズ地＋白文字、
// 画面下地は白にして紺のちらつきを防ぐ（歩行側は既定の紺のまま）。
const watcherHeader = {
  headerStyle: { backgroundColor: lightColor.action },
  headerTintColor: lightColor.inkOnAccent,
  contentStyle: { backgroundColor: lightColor.white },
} as const;

// thousandsky://session/<id> から参加IDを、thousandsky://pair/<id> から招待IDを取り出す。
// 都度セッション（/session）と恒久ペアの招待（/pair）は恒久的に並存する経路なので、
// hostname で明確に分ける（ADR P3 決定2）。
function parseDeepLink(url: string | null): { kind: 'session' | 'pair'; id: string } | null {
  if (!url) return null;
  try {
    const { hostname, path } = Linking.parse(url);
    if (hostname !== 'session' && hostname !== 'pair') return null;
    const id = (path ?? '').split('/').filter(Boolean).pop();
    return id ? { kind: hostname, id } : null;
  } catch {
    return null;
  }
}

export default function App() {
  const initAuth = useSession((s) => s.initAuth);
  const setPendingJoinId = useSession((s) => s.setPendingJoinId);
  const setFcmToken = useSession((s) => s.setFcmToken);
  const restoreWatchSession = useSession((s) => s.restoreWatchSession);
  const restoreWalkSession = useSession((s) => s.restoreWalkSession);
  const setPendingInvitePairId = usePairs((s) => s.setPendingInvitePairId);
  // 匿名 uid が確定してからでないと users / pairs には触れない
  const uid = useSession((s) => s.uid);
  const fcmToken = useSession((s) => s.fcmToken);
  const pendingJoinId = useSession((s) => s.pendingJoinId);
  // 初回起動ならオンボーディングから。見守りセッションが生きていれば見守り画面から
  // 復帰する（設計書 Phase3 決定。null=判定中はスプラッシュのまま）。
  const [initialRoute, setInitialRoute] = useState<keyof RootStackParamList | null>(null);
  // 歩行復帰時に歩行画面へ渡す目安時間（歩行画面は params 必須のため）
  const [walkRestoreMinutes, setWalkRestoreMinutes] = useState<number | null>(null);
  // 見守り復帰時、そのセッションが緊急中だったか（true なら SOS 画面をタブの上に積む）
  const [watchRestoreSos, setWatchRestoreSos] = useState(false);
  // 復帰処理（歩行・見守り）が終わったか。届いた参加リンクの処理はこれを待つ
  // — cold start では Linking の解決のほうが先に来るため、待たずに join すると
  // 「まだ器に載っていないだけの進行中セッション」を素通りで奪う（H-A）。
  const [restoreDone, setRestoreDone] = useState(false);

  const navRef = useNavigationContainerRef<RootStackParamList>();
  // NavigationContainer が ready になる前（cold start 起動直後）に通知タップの
  // 遷移要求が来ることがあるため、ready になるまでここへ退避しておく。
  const pendingRouteRef = useRef<NotificationRouteRequest | null>(null);
  const navReadyRef = useRef(false);
  // ナビゲータ準備前にペア招待リンクが届いた場合の退避
  const pendingPairNavRef = useRef(false);
  // 同上。cold start で参加リンクを開くと、参加が成立したときにまだ
  // NavigationContainer が ready でないことがある（H-3）
  const pendingStartNavRef = useRef(false);

  const handleNotificationRoute = (request: NotificationRouteRequest) => {
    // ペア由来の通知（つながった・解除された・連絡が取れない）はセッションを持たない
    if (!request.sessionId && !request.pairId) return;
    if (navReadyRef.current && navRef.current) {
      routeNotificationTap(navRef.current, request).catch((e) => console.warn('notification routing failed', e));
    } else {
      pendingRouteRef.current = request;
    }
  };

  useEffect(() => {
    initAuth();
    ensureNotificationPermission();

    // FCMトークン取得＋前面メッセージの表示＋トークンローテーションの反映
    // （トークンは他人の端末へ通知を送れる資格情報なので、ログには出さない）
    getFcmToken().then((token) => {
      if (token) setFcmToken(token);
    });
    const unsubMessages = setupForegroundMessages();
    const unsubToken = setupTokenRefresh(setFcmToken);

    // リモート通知タップ（設計書 Phase3 §5-7）: background→タップ／kill→タップ起動の両方を扱う
    const messaging = getMessaging();
    const unsubOpenedApp = onNotificationOpenedApp(messaging, (msg) => {
      handleNotificationRoute({
        type: msg.data?.type as string | undefined,
        sessionId: msg.data?.sessionId as string | undefined,
        pairId: msg.data?.pairId as string | undefined,
      });
    });
    getInitialNotification(messaging).then((msg) => {
      if (msg) {
        handleNotificationRoute({
          type: msg.data?.type as string | undefined,
          sessionId: msg.data?.sessionId as string | undefined,
          pairId: msg.data?.pairId as string | undefined,
        });
      }
    });

    // ローカル通知タップ（前面リスナー起点・bgタスク起点のどちらも同じ規約で処理する）
    const respSub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { type?: string; sessionId?: string; pairId?: string } | undefined;
      handleNotificationRoute({ type: data?.type, sessionId: data?.sessionId, pairId: data?.pairId });
    });
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      const data = response.notification.request.content.data as { type?: string; sessionId?: string; pairId?: string } | undefined;
      handleNotificationRoute({ type: data?.type, sessionId: data?.sessionId, pairId: data?.pairId });
    });

    // 届いたリンクの振り分け。ペア招待は自動で受諾せず、画面で本人の操作を挟む
    // （つながる同意の明示性。位置共有そのものは開始しないので急ぐ必要もない）。
    const handleUrl = (url: string | null) => {
      const link = parseDeepLink(url);
      if (!link) return;
      if (link.kind === 'session') setPendingJoinId(link.id);
      else {
        setPendingInvitePairId(link.id);
        if (navReadyRef.current && navRef.current) navRef.current.navigate('Pairs');
        else pendingPairNavRef.current = true;
      }
    };
    Linking.getInitialURL().then(handleUrl);
    const linkSub = Linking.addEventListener('url', ({ url }) => handleUrl(url));

    // 初期ルートの決定：オンボーディング未完了→Onboarding、
    // 見守りセッションが生きていれば復帰、それ以外はRoleSelect。
    const decideInitialRoute = async () => {
      let onboarded: boolean;
      try {
        onboarded = (await AsyncStorage.getItem(ONBOARDING_DONE_KEY)) === '1';
      } catch {
        onboarded = true; // 元の挙動を踏襲（読み取り失敗時はオンボード済み扱い）
      }
      if (!onboarded) {
        setInitialRoute('Onboarding');
        return;
      }
      // 歩行復帰を先に見る。自分が歩いている最中に kill された端末では、位置タスクは
      // OS 側で生き続けるのに JS 側から SOS・到着連絡へ手が届かない状態になっており、
      // 見守り画面への復帰より優先度が高い（両方の役割を持つ端末で歩行復帰に
      // 到達できなくなるのを防ぐ）。
      const walkSessionId = await getActiveWalkSessionId().catch(() => null);
      if (walkSessionId) {
        const restored = await restoreWalkSession(walkSessionId).catch(() => false);
        if (restored) {
          setWalkRestoreMinutes(useSession.getState().estimatedMinutes);
          setInitialRoute(useSession.getState().mode === 'sentinel' ? 'MainSentinel' : 'Main');
          return;
        }
        // セッションはもう生きていない。置き去りの位置タスクを止める
        await stopBackgroundWalk().catch(() => {});
      }

      // 見守りの復帰先は v3 から「タブのホーム」（design-v3-watcher-redesign §2.3）。
      // 複数の見守りを持てるので、生きているものが1つでもあればホームへ戻す
      // （どれを開いているかはホームのリストで選び直せる）。緊急中のものがあれば、
      // その1件を器に載せて SOS 画面をタブの上に積む。
      const watches = await getActiveWatches().catch(() => []);
      let restoredAny = false;
      // 「読めなかった（圏外・認証未復元）」ものが1件でもあれば永続化は消さない。
      // 消すと次回起動でも復帰できず、進行中の見守りを恒久的に見失う（M-7）
      let sawUnreadable = false;
      for (const id of watches) {
        const result = await restoreWatchSession(id).catch(
          () => ({ ok: false, reason: 'unreadable' }) as const,
        );
        if (!result.ok) {
          if (result.reason === 'unreadable') sawUnreadable = true;
          continue;
        }
        restoredAny = true;
        // status は復帰の戻り値をそのまま見る（購読の到着を待つと前の値を読む。H-1）
        if (result.status === 'sos') {
          setWatchRestoreSos(true);
          break; // 緊急が最優先。これ以上ほかのセッションで器を上書きしない
        }
      }
      if (restoredAny) {
        setInitialRoute('WatcherTabs');
        return;
      }
      // 全件が「読めたうえで死んでいた」ときだけ永続化をクリアして通常起動へ
      if (watches.length > 0 && !sawUnreadable) await clearActiveWatch().catch(() => {});
      setInitialRoute('RoleSelect');
    };
    decideInitialRoute().finally(() => setRestoreDone(true));

    return () => {
      linkSub.remove();
      unsubMessages();
      unsubToken();
      unsubOpenedApp();
      respSub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initAuth, setPendingJoinId, setFcmToken, restoreWatchSession, restoreWalkSession]);

  // 届いた参加リンクの処理（H-3）。以前は RoleSelect の effect が担っていたが、
  // 見守りタブを開いている端末では RoleSelect が復帰スタックの下に敷かれたまま
  // 描かれないため、ブロックの説明文が誰にも見えず「何も起きない」ように見えていた。
  // 画面に依存しないここへ移し、ブロック時は必ず Alert で可視化する。
  useEffect(() => {
    if (!pendingJoinId) return;
    // 復帰が済むまでは何も判断できない。ここで抜けても pendingJoinId は残るので、
    // restoreDone が立った再実行で拾われる。
    if (!restoreDone) return;
    const store = useSession.getState();
    // ブロックするのは「自分がいま歩いている」ときだけ。見守り側の focus は
    // 器（sessionStore）が1件しか開けないという都合にすぎず、歩き始めの妨げに
    // してはいけない（1台2役が実質できなくなる）。見守りセッションはサーバー上でも
    // activeWatches でも生き続けるので、乗り替えても失われない。
    if (store.hasLiveSession() && store.myRole === 'walker') {
      store.setPendingJoinId(null);
      Alert.alert(
        'いま歩いているところです',
        'いまの見守りが終わってから、届いたリンクをもう一度ひらいてください。',
      );
      return;
    }
    // replaceExisting は「上のブロック判定を復帰後の実データで通した」前提の値。
    // restoreDone のゲート無しに渡すと assertNoLiveSession まで同時に外れる。
    store.joinSession(pendingJoinId, { replaceExisting: true })
      .then(() => {
        haptics.success(); // つながった手応えを触覚でも返す
        if (navReadyRef.current && navRef.current) navRef.current.navigate('Start');
        else pendingStartNavRef.current = true;
      })
      .catch(() => {
        // joinSession が組み立てた文言だけを出す（rules 拒否の生の英語は出さない）
        Alert.alert(
          'リンクをひらけませんでした',
          useSession.getState().joinError
            ?? 'つながりませんでした。通信を確認して、もう一度リンクを開いてください',
        );
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJoinId, restoreDone]);

  // 恒久ペアの土台（ADR P3 決定1・決定2）。uid が確定してから張る。
  useEffect(() => {
    if (!uid) return;
    const profile = useProfile.getState();
    // lastSeenAt は「関係の死を見える化する」（I-5）ための脈。起動のたびに打つ。
    // これが止まったペアを watchPairs（日次）が見つけ、もう片側へ知らせる。
    profile.load().then(() => profile.touchLastSeen());
    const pairs = usePairs.getState();
    pairs.subscribeMyPairs();
    // 課金資格（D-11）。RevenueCat の app user ID を匿名 uid に揃えると、
    // webhook が users/{uid} を引ける（§2.5.4）。キー未設定なら configurePurchases は
    // 何もせず、entitlement は無料枠のまま＝購入導線が出ないだけで他は全部動く。
    const entitlement = useEntitlement.getState();
    entitlement.subscribe();
    configurePurchases(uid);
    return () => {
      pairs.unsubscribeMyPairs();
      entitlement.unsubscribe();
    };
  }, [uid]);

  // FCM トークンの住所を users/{uid} へ移す（architecture-review E-2）。
  // セッションが無いときにも相手へ通知できることが恒久ペアの前提であり、
  // この文書はクライアントから read できないので従来より漏れにくい。
  // 移行期はセッション文書側にも従来どおり書き続ける（functions が users 優先で読む）。
  useEffect(() => {
    if (!uid || !fcmToken) return;
    useProfile.getState().registerFcmToken(fcmToken);
  }, [uid, fcmToken]);

  if (initialRoute === null) return null; // 判定中はスプラッシュのまま

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer
        ref={navRef}
        theme={DarkTheme}
        // 自動復帰(見守りタブ起動)のときも RoleSelect を下に敷いたスタックで起動する。
        // 理由は watcher-exit ADR E1（戻る先が無い密室を作らない）。
        // 届いた参加リンクの処理は画面から外して上の effect が持つので、
        // こちらはもう「リンクの受け皿」を兼ねていない（H-3）。
        // 緊急中のセッションがあるときは、その上に SOS 画面を積む。
        initialState={
          initialRoute === 'WatcherTabs'
            ? watchRestoreSos
              ? { index: 2, routes: [{ name: 'RoleSelect' }, { name: 'WatcherTabs' }, { name: 'WatcherSos' }] }
              : { index: 1, routes: [{ name: 'RoleSelect' }, { name: 'WatcherTabs' }] }
            : (initialRoute === 'Main' || initialRoute === 'MainSentinel') && walkRestoreMinutes != null
              // 歩行復帰も同じく2枚スタックで起動する（歩行画面は params 必須）
              ? {
                  index: 1,
                  routes: [
                    { name: 'RoleSelect' as const },
                    { name: initialRoute, params: { estimatedMinutes: walkRestoreMinutes } },
                  ],
                }
              : undefined
        }
        onReady={() => {
          navReadyRef.current = true;
          if (pendingPairNavRef.current) {
            pendingPairNavRef.current = false;
            navRef.current?.navigate('Pairs');
          }
          if (pendingStartNavRef.current) {
            pendingStartNavRef.current = false;
            navRef.current?.navigate('Start');
          }
          if (pendingRouteRef.current) {
            const pending = pendingRouteRef.current;
            pendingRouteRef.current = null;
            if (navRef.current) {
              routeNotificationTap(navRef.current, pending).catch((e) => console.warn('notification routing failed', e));
            }
          }
        }}
      >
        <Stack.Navigator
          initialRouteName={initialRoute}
          screenOptions={{
            headerStyle: { backgroundColor: palette.navyChrome },
            headerTintColor: palette.white,
            headerTitleStyle: { fontWeight: '700' },
            contentStyle: { backgroundColor: palette.navyChrome },
            // iOS の戻るボタンは前の画面の title を流用するため、title が無い画面から
            // 戻ると内部のルート名（RoleSelect など）がそのまま出てしまう。
            // 全画面で日本語に固定する
            headerBackTitle: 'もどる',
          }}
        >
          {/* headerShown:false でも title は付けておく。次の画面の戻るラベルに使われる */}
          <Stack.Screen name="Onboarding" component={OnboardingScreen} options={{ headerShown: false, title: 'はじめに' }} />
          <Stack.Screen name="RoleSelect" component={RoleSelectScreen} options={{ headerShown: false, title: 'ホーム' }} />
          {/* 見守り側のタブ（v3 §2.2）。ヘッダーは各タブが自前で持つ */}
          <Stack.Screen name="WatcherTabs" component={WatcherTabs} options={{ headerShown: false, title: 'ホーム' }} />
          <Stack.Screen name="WatcherSetup" component={WatcherSetupScreen} options={{ title: '見守り設定', ...watcherHeader }} />
          {/* 戻る導線は watcher-exit ADR P1(E1)で復活: 画面を離れてもセッション・activeWatch・購読は無傷で、
              通知はFCM経由で届き続ける。離脱時の通知権限警告は WatcherMonitorScreen の beforeRemove が担う */}
          <Stack.Screen name="WatcherMonitor" component={WatcherMonitorScreen} options={{ title: '見守り中', ...watcherHeader }} />
          {/* SOS はタブバーを持たない全画面（C-7: 緊急時は画面が1つずつ指示する） */}
          <Stack.Screen name="WatcherSos" component={WatcherSosScreen} options={{ headerShown: false, title: 'SOS' }} />
          <Stack.Screen name="Start" component={StartScreen} options={{ title: '' }} />
          {/* Main / MainSentinel は戻る導線を持たないが、title 未設定だと
              そこから開いたチャットの戻るラベルがルート名になる */}
          {/* 見守り中の画面では iOS のスワイプバックを無効化する。
              到着スライダーの横ドラッグと競合するうえ、誤って戻るとセッションが壊れるため。 */}
          <Stack.Screen name="Main" component={MainScreen} options={{ headerShown: false, gestureEnabled: false, title: '見守り中' }} />
          <Stack.Screen name="MainSentinel" component={MainSentinelScreen} options={{ headerShown: false, gestureEnabled: false, title: '見守り中' }} />
          <Stack.Screen name="Chat" component={ChatScreen} options={{ title: 'チャット' }} />
          <Stack.Screen name="History" component={HistoryScreen} options={{ title: '履歴' }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'このアプリについて' }} />
          <Stack.Screen name="Pairs" component={PairsScreen} options={{ title: 'つながり' }} />
          <Stack.Screen name="Profile" component={ProfileScreen} options={{ title: 'よびなとアイコン' }} />
          {/* 見守り依頼の承諾は「1画面1判断」。ヘッダーの戻るを出さず、
              画面の中の「ことわる」だけを出口にする（誤タップでの開始を作らない） */}
          <Stack.Screen name="WatchRequest" component={WatchRequestScreen} options={{ headerShown: false, title: 'みまもりの おさそい' }} />
          <Stack.Screen name="Paywall" component={PaywallScreen} options={{ title: 'グループ機能', ...watcherHeader }} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
