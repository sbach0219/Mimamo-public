# セッションとサーバーのモジュール構成

2026-09-11: `sessionStore.ts` と `functions/index.js` を役割別に分割。
画面から使う export、Firestore の構造、Cloud Functions の公開名・実行設定は維持する。

## アプリ側

画面・他のストアは従来どおり `src/store/sessionStore.ts` から `useSession`、
`ensureSignedIn`、型や名前の正規化関数を import する。
内部の action factory は入口を import せず、`set` / `get` で同じストアを操作する。

| 変更したいこと | `src/store/session/` 内のファイル |
| --- | --- |
| ストアの組み立て・起動時の初期値 | `createSessionStore.ts` |
| 状態・アクション・引数の型 | `types.ts` |
| 匿名認証の復元待ち、サインイン、トークンの登録 | `auth.ts` |
| 作成・参加・ペアから歩行開始・終了・中断 | `lifecycle.ts` |
| 見守り側・歩く側のセッション復元 | `restoration.ts` |
| Firestore 購読、チャット、前面のローカル通知 | `subscriptions.ts` |
| SOS、異常報告、安否確認 | `safety.ts` |
| 位置・経路・電池・地名・ハートビート、接続監視 | `telemetry.ts` |
| セッション情報の更新、電話番号、時間延長、履歴取得 | `details.ts` |
| 文書値の変換、リセット、参加ガード | `model.ts` |
| 複数の処理から使う経路間引きとSOS送信の世代番号 | `runtime.ts` |

購読解除関数とチャット通知用の状態は `subscriptions.ts`、接続監視タイマーと
地名の送信済みキャッシュは `telemetry.ts` が保持する。これらと `runtime` は
ストアを作るごとに生成する。バックグラウンドの位置タスクは従来どおり別の経路間引きを持つ。

`src/lib/fcmToken.ts` は権限確認とFCMトークン取得だけを担い、ストアに依存しない。
`messaging.ts` は前面通知・トークン変更の購読を担当し、互換性のため `getFcmToken` を再公開する。
セッション内部からトークンを取得するときは `fcmToken.ts` を使い、循環参照を作らない。

## サーバー側

`functions/index.js` は Firebase Admin の初期化と既存 export の公開だけを行う。
デプロイ名はこのファイルで決まるため、内部ファイル名を変えるときも公開名は変えない。

| 変更したいこと | `functions/src/` 内のファイル |
| --- | --- |
| リージョン、状態一覧、保持日数、課金資格ID | `config.js` |
| 地名・目的地の検証 | `labels.js` |
| FCM配送、再試行、無効トークンの削除、夜間判定 | `notifications.js` |
| セッション作成・更新・新着メッセージのトリガー | `sessions.js` |
| 5分ごとの通信途絶・予定超過・参加待ち・放置の監視 | `session-monitor.js` |
| 7日経過後のセッションと子データ削除、終端時刻の補完 | `retention.js` |
| ペア成立・解除、解除時の進行中セッション終了 | `pairs.js` |
| 日次のペア死活確認・期限切れ情報の後片付け | `pair-monitor.js` |
| RevenueCat webhook、資格の更新・移転・復元 | `entitlements.js` |

既存テストや外部の参照を壊さないよう、純関数と定数の従来の export も入口に残してある。
新しい内部ヘルパーを入口から公開する必要はない。

## 変更時の確認

プロジェクトルートで実行:

```sh
./node_modules/.bin/tsc --noEmit --incremental false
npm test -- --runInBand
npm test --prefix functions
```

`src/store/session/__tests__/sessionStore.test.ts` は、ストアを実際に組み立て、
Firebase・端末APIだけを模擬する。復元時の状態リセット、購読解除、遅延SOS応答、
終了失敗時の状態保持、認証復元待ちなど、モジュールをまたぐ動作を確認する。

自動テストでは実機の通知配送やバックグラウンド動作は確認できない。
配布前には、2台での招待→開始→SOS→相手の確認→到着と、アプリ再起動後の復元を確認する。
Firestoreルールを変更した場合は別途 `npm run test:rules` も実行する。
