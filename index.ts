import 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';
import { getMessaging, setBackgroundMessageHandler } from '@react-native-firebase/messaging';

// バックグラウンド位置タスクを起動時に登録（ヘッドレス起動でも有効にするため）
import './src/tasks/locationTask';

// バックグラウンドでプッシュを受けたときのハンドラ。
// notification ペイロードはOSが自動表示するので、ここでは受領のみ。
setBackgroundMessageHandler(getMessaging(), async () => {});

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
