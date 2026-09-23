import { Alert, Linking } from 'react-native';
import { haptics } from './haptics';

// SOS・緊急通報まわりの共通ヘルパー。
// ホールドモード / センチネルモードの両方の歩行画面から使う。

export function emergencyCall(num: string) {
  Alert.alert(`${num} に発信しますか？`, '本当に通報しますか？\n発信すると電話アプリに切り替わります。', [
    { text: 'キャンセル', style: 'cancel' },
    { text: '発信する', style: 'destructive', onPress: () => Linking.openURL(`tel:${num}`) },
  ]);
}

export function showEmergencySheet() {
  Alert.alert('緊急通報', '緊急時のみ使用してください。\n誤通報は犯罪になることがあります。', [
    { text: '110（警察）に発信', style: 'destructive', onPress: () => emergencyCall('110') },
    { text: '119（消防・救急）に発信', style: 'destructive', onPress: () => emergencyCall('119') },
    { text: 'キャンセル', style: 'cancel' },
  ]);
}

// SOSの送信確認。音あり／音なしを選んで送る。
// 🔊 アラームつき: この端末からサイレンが鳴る。周囲への周知と、
//    誤発信に本人がすぐ気づける効果（鳴り続けていれば本物の裏付けにもなる）。
// 🔇 音なし: 尾行されているかもしれない等、音を出すと危ない状況用。
// send には (silent: boolean) => void を渡す（sessionStore の triggerSOS が合う）。
export function confirmSOS(send: (silent: boolean) => void) {
  haptics.heavy();
  Alert.alert(
    'SOSを送信しますか？',
    '送信後、見守り側に届いたことを確認します。\n\n🔊 アラームつき：この電話から大きな音が鳴り、まわりの人にも気づいてもらえます\n🔇 音なし：音を出すとあぶない状況のときに\n\nまちがえて送っても、あとから とりけせます。',
    [
      { text: 'キャンセル', style: 'cancel' },
      { text: '🔇 音なしで送信', onPress: () => send(true) },
      { text: '🔊 アラームつきで送信', style: 'destructive', onPress: () => send(false) },
    ],
  );
}

// SOSのとりけし（issue #2）。cancelSOS は sessionStore の cancelSOS を渡す。
export function confirmCancelSOS(cancelSOS: () => void) {
  haptics.tap();
  Alert.alert('SOSをとりけしますか？', '見守りの人に「とりけした」ことが伝わります。', [
    { text: 'もどる', style: 'cancel' },
    { text: 'とりけす', onPress: cancelSOS },
  ]);
}
