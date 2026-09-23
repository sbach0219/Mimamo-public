import {
  getMessaging,
  getToken,
  requestPermission,
  AuthorizationStatus,
} from '@react-native-firebase/messaging';

// 端末固有のFCMトークンを取得する。ストアや通知表示には依存しない。
export async function getFcmToken(): Promise<string | null> {
  try {
    const messaging = getMessaging();
    const status = await requestPermission(messaging);
    const ok =
      status === AuthorizationStatus.AUTHORIZED || status === AuthorizationStatus.PROVISIONAL;
    if (!ok) return null;
    const token = await getToken(messaging);
    return token ?? null;
  } catch (e) {
    console.warn('FCM token 取得失敗', e);
    return null;
  }
}
