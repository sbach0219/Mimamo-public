import { Alert, Linking } from 'react-native';
import type { WalkStartResult } from '../tasks/locationTask';

// 位置共有の開始結果をユーザーに伝える（両モードの歩行画面で共通）。
//
// 方針: 「使用中のみ許可」でも見守りは成立する（歩行画面は点灯し続けるため、
// 画面を開いたまま歩けば位置共有も検知も動く）。したがってここでブロックはせず、
// 「アプリを閉じると止まる」という制限だけを正直に伝えて続行させる。
// 位置情報そのものが不許可のときと、現在地がまったく取れないときは見守りが
// 成立しないので、歩行画面に留まらせない（H-2）。文言は歩く人向けなので
// ひらがな主体にする。
export function noticeWalkStart(result: WalkStartResult, onBlocked?: () => void): void {
  if (result === 'background') return;

  if (result === 'foreground-only') {
    Alert.alert(
      'アプリを開いている間だけ見守ります',
      '位置情報が「使用中のみ許可」になっています。\nこの画面を開いたままなら見守れますが、アプリを閉じると位置の共有が止まり、見守る人には「通信が途絶えた」と表示されます。\n\nずっと見守るには「常に許可」に変えてください。',
      [
        { text: 'このまま使う', style: 'cancel' },
        { text: '設定をひらく', onPress: () => { Linking.openSettings().catch(() => {}); } },
      ],
    );
    return;
  }

  // ここから下は見守りが成立しない結果。どちらのボタンでも歩行画面から出す
  // （残しておくと「見守られているつもり」で歩き続けることになる）。
  const leave = () => onBlocked?.();

  if (result === 'denied') {
    Alert.alert(
      'いばしょを おくれません',
      'みまもりには 「いばしょ」の きょかが いります。\nせっていで きょかしてから、もういちど はじめてね。',
      [
        { text: 'とじる', style: 'cancel', onPress: leave },
        { text: 'せっていを ひらく', onPress: () => { Linking.openSettings().catch(() => {}); leave(); } },
      ],
    );
    return;
  }

  Alert.alert(
    'いまの ばしょが わかりません',
    'いばしょを とれなかったので、みまもりを はじめられません。\nでんぱの よい ところで、もういちど はじめてね。',
    [{ text: 'とじる', onPress: leave }],
  );
}
