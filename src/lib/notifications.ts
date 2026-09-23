import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// フォアグラウンドでもバナー＋音を出す（Swift版 NotificationDelegate 相当）。
// iOS でこのハンドラが効くには patches/@react-native-firebase+messaging+24.1.1.patch が要る。
// expo-notifications は +load の時点で UNUserNotificationCenter.delegate を取り、その後
// RNFirebase が didFinishLaunching で自分に差し替える（元デリゲートは退避して委譲する）。
// RNFirebase の willPresentNotification は expo へ委譲したあと、firebase.json の
// messaging_ios_foreground_presentation_options（未設定なら「何も表示しない」）で
// completionHandler を同期的に呼ぶ。iOS は最初の1回だけを採用するので expo の非同期判定は
// 必ず負け、FCM 由来かどうかに関わらず前面の通知が1枚も出なくなる。パッチは FCM 以外の
// 通知（＝ここで出すローカル通知）の表示可否を元デリゲートに委ねるようにしている。
// 前面にいるあいだだけ、ローカル通知のバナー/音を止めたい場面がある。
// 例: 離脱確認ダイアログを開いている最中の「だいじょうぶ？」（予約通知は
// 背面に回ったときのために生かしておきたいが、目の前にダイアログが出ている
// あいだに鳴らす意味はない）。予約そのものは消さないので、背面ではそのまま鳴る。
let foregroundNoticeSuppressed = false;
export function setForegroundNoticeSuppressed(suppressed: boolean): void {
  foregroundNoticeSuppressed = suppressed;
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: !foregroundNoticeSuppressed,
    shouldShowList: true,
    shouldPlaySound: !foregroundNoticeSuppressed,
    shouldSetBadge: false,
  }),
});

export async function ensureNotificationPermission(): Promise<boolean> {
  const settings = await Notifications.getPermissionsAsync();
  let granted =
    settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  if (!granted) {
    const req = await Notifications.requestPermissionsAsync();
    granted =
      req.granted || req.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  }
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: '通知',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
    });
    await Notifications.setNotificationChannelAsync('alert', {
      name: '緊急アラート',
      importance: Notifications.AndroidImportance.MAX,
      sound: 'default',
      vibrationPattern: [0, 400, 200, 400],
    });
  }
  return granted;
}

// ローカル通知にも data.type / data.sessionId を付与する（設計書 決定D のペイロード規約）。
// リモート(FCM)・ローカルどちらの経路で表示された通知でも、タップ時のルーティングが
// 同じ規約（src/lib/notificationRouting.ts）で読めるようにするため。
export type NotifyData = { type?: string; sessionId?: string };

export async function notify(
  title: string,
  body: string,
  channel: 'default' | 'alert' = 'default',
  data?: NotifyData,
) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title, body, sound: 'default',
      ...(data ? { data } : {}),
      ...(Platform.OS === 'android' ? { channelId: channel } : {}),
    },
    trigger: null, // 即時
  });
}
