# みまも（Mimamo）(React Native / Expo)

> 旧名: Thousand SKY。bundle ID `com.thousandsky.app`・EAS slug・URLスキーム `thousandsky://` は互換性のため旧名のまま。

帰り道をひとりで歩く人を、離れた場所から見守る安全アプリ。
Swift版を **TypeScript + React Native (Expo)** に移植し、**iOS / Android 両対応**にしたもの。

> [!WARNING]
> 開発中の安全補助アプリです。警察・消防・医療などの緊急通報サービスを代替するものではなく、
> 通知・位置共有・異常検知の確実な到達を保証しません。

## 技術スタック

- **Expo SDK 56** + Dev Client（ネイティブモジュールを使うため Expo Go ではなく開発ビルドが必要）
- **TypeScript**
- **@react-native-firebase**（Auth 匿名認証 / Firestore リアルタイム同期 / Messaging）
- **React Navigation**（native-stack）
- **Zustand**（状態管理：Swift版 `SessionManager` の移植先）
- **react-native-maps**（見守り側の地図・自宅ピン留め）
- **expo-location / expo-task-manager**（位置共有・ジオフェンス到着判定）
- **expo-notifications**（ローカル通知・緊急アラート）
- **expo-haptics / expo-battery / react-native-svg**

## ディレクトリ

```
App.tsx                     ナビゲーション・ディープリンク・起動処理
src/
  theme/        色・夜空背景・星
  components/   ボタン / カード / 接続ピル / 自宅ピッカー
  lib/          firebase / haptics / notifications / network / favorites
  store/        sessionStore.ts（画面から使う入口）、ペア・プロフィール等のストア
    session/    認証 / 開始・終了 / 復元 / 購読 / SOS / 位置報告を役割別に実装
  screens/      RoleSelect / WatcherSetup / WatcherMonitor / Start / Main / Chat / History
  navigation/   型定義
```

サーバー側は `functions/index.js` が公開関数の入口、`functions/src/` が通知・監視・
保持期間・ペア・課金の実装です。変更箇所の探し方と検証手順は
[モジュール構成](docs/module-map.md)を参照してください。

PRの自動チェックと手元での検証コマンドは
[自動チェック](docs/automated-checks.md)を参照してください。

## セットアップ（初回だけ）

### 1. Firebase 設定ファイルを置く

Firebase コンソールで **同じプロジェクト**に2つアプリを追加し、設定ファイルをこのフォルダ直下に置く：

- iOS アプリ（バンドルID `com.thousandsky.app`）→ `GoogleService-Info.plist`
- Android アプリ（パッケージ名 `com.thousandsky.app`）→ `google-services.json`

この2ファイルは公開スナップショットには含めません。Firebaseのクライアント設定は
サーバー秘密鍵ではありませんが、forkや検証環境が本番プロジェクトへ誤接続しないよう、
各自のFirebaseプロジェクトから取得してください。サービスアカウント鍵やFunctionsの
シークレットはリポジトリへ追加しないでください。

> 既存のFirebase iOSアプリを再利用したい場合は、`app.json` の
> `ios.bundleIdentifier` をそのアプリのバンドルIDに合わせれば、既存の
> `GoogleService-Info.plist` をそのまま置けます。

### 2. 依存関係

```bash
npm install
```

### 3. ネイティブプロジェクトを生成（prebuild）

```bash
npx expo prebuild
```

### 4. 実機 / シミュレータで起動

```bash
npx expo run:ios       # iOS（要 Xcode）
npx expo run:android   # Android（要 Android Studio / エミュレータ）
```

以降の日常的な開発は `npx expo start` で Metro を立ち上げ、
インストール済みの Dev Client アプリから読み込む。

## まだ移植していない機能（iOS専用のため）

- **Live Activities / ダイナミックアイランド**
- **Apple Watch アプリ**

これらは iOS ネイティブ機能なので、必要になったら
Expo の config plugin かネイティブモジュールとして個別に追加する。
（Swift版は `../Thousand SKY/` に残してある）

## Firestore のデータ構造（Swift版と互換）

```
sessions/{id}
  status, estimatedMinutes, watcherUid, walkerUid,
  createdAt, startedAt, expiresAt, endedAt,
  latitude, longitude, locationUpdatedAt, lastHeartbeat,
  homeLatitude, homeLongitude, batteryLevel, batteryState
  messages/{id}   text, sender, timestamp, acknowledged
  route/{id}      lat, lng, timestamp
```

## セキュリティと検証

- 脆弱性の報告方法は [SECURITY.md](SECURITY.md) を参照してください。
- Firestoreルールを変更した場合は `npm run test:rules` を実行してください。
- 自動テストは実機の通知配送、バックグラウンド位置共有、OS終了後の復帰を保証しません。
- 本番Firebaseへのdeploy、EAS build/submit、OTA updateは、このリポジトリの通常CIでは実行しません。

## 第三者データ

`assets/data/danger-area-jp.bin` はOpenStreetMapデータから生成しています。
帰属表示とライセンス条件は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。

## 公開用スナップショット

この開発リポジトリには内部設計資料や運用情報があるため、リポジトリ全体をそのまま公開しません。
公開候補だけを別ディレクトリへ出力するには、空の出力先を指定して次を実行します。

```bash
./scripts/create-public-snapshot.sh /tmp/mimamo-public
```

出力対象は [public-files.txt](public-files.txt) の許可リストで管理しています。スクリプトは
Firebase設定ファイルを除外し、`app.json` / `eas.json` から運用アカウント固有の識別子も除きます。

## ソースコードの利用条件

現時点では、このプロジェクト固有のソースコードにオープンソースライセンスを付与していません。
閲覧目的で公開しており、プロジェクト固有のコードについて新たな再配布・改変利用の許諾は付与しません。
GitHub上での閲覧・forkにはGitHubの利用規約が適用されます。
既に付与された許諾を取り消すものではありません。Expo由来部分、依存ライブラリと
OpenStreetMap由来データには、それぞれのライセンスが適用されます。
