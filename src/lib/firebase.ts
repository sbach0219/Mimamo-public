// React Native Firebase v24（モジュラーAPI）の入口。
// ネイティブの GoogleService-Info.plist / google-services.json から
// 自動初期化されるため、ここでは各サービスのハンドルを公開するだけ。
import { getApp } from '@react-native-firebase/app';
import { getAuth } from '@react-native-firebase/auth';
import { getFirestore } from '@react-native-firebase/firestore';

export const app = getApp();
export const auth = getAuth(app);
export const db = getFirestore(app);
