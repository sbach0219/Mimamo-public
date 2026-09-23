# 実機なしで行う自動チェック

`.github/workflows/ci.yml` は全ブランチ向けのPR、mainへのpush、手動実行を対象にする。
アプリ、Functions、Firestoreルールの3ジョブを独立して実行する。
同じPRに更新が来た場合は古い実行を中止する。

| ジョブ | 環境 | 確認内容 |
| --- | --- | --- |
| App typecheck and tests | Node 22 | TypeScript、純ロジック、セッションストア、通知タップの遷移 |
| Functions tests | Node 20（設定された実行環境と同じ） | 通知関連の判定、保持期間、削除順序、課金資格など |
| Firestore rules tests | Node 22、Java 21、Firebase CLI 15.18.0 | 正規操作の許可、第三者や不正な書き込みの拒否 |

依存関係は各ディレクトリのlockfileを使って `npm ci` で導入する。
アプリ側のpostinstallはRNFirebaseのパッチ適用に必要なので省略しない。
Firebase認証・ストアの鍵・EASの設定は不要。配信・デプロイ処理は含まない。
GitHub上の実行には、このファイル群がリモートに反映される必要がある。
マージ必須チェックへの指定はリポジトリ側の設定であり、ワークフローの追加だけでは有効にならない。

## 手元での実行

プロジェクトルートで実行する。

```sh
npm run typecheck
npm test -- --ci --runInBand
npm test --prefix functions
npm run test:rules
```

初回はルート、`functions`、`firestore-tests` でそれぞれ `npm ci` が必要。
ルールテストにはJava 21以上とFirebase CLIが必要。
エミュレータの起動にはローカルポートの使用権限が必要で、初回はエミュレータのダウンロードも発生する。
詳細は [Firestoreテストの説明](../firestore-tests/README.md) を参照。

## 通知の遷移で確認すること

`src/lib/__tests__/notificationRouting.test.ts` は実際の遷移関数を呼び、ストアとナビゲータを模擬する。

- ペア通知はつながり画面、見守り依頼は承諾画面へ進み、自動参加しない。
- 起動済みのアプリでは現在のセッション状態を使う。古いSOS通知でSOS画面を再表示しない。
- 復元が必要なときは完了を待ち、復元結果の状態・モード・所要時間を使う。
- メッセージからチャットへ進む際、復元した役割に合う戻り先を用意する。
- 復元失敗で関係のないセッションを表示せず、終了通知には通常画面への戻り先を用意する。

これは通知の配送やReact Navigationの実描画、`App.tsx` の起動時キューを検証するテストではない。
位置共有が実機で停止すること、OSによる背景制限、ホールドのジェスチャ、文字拡大も別途確認する。

## 参照

- [Expo v56の対応環境](https://docs.expo.dev/versions/v56.0.0/)
- [GitHub setup-node](https://github.com/actions/setup-node)
- [GitHub checkout](https://github.com/actions/checkout)
- [GitHub setup-java](https://github.com/actions/setup-java)
- [Firestoreエミュレータ](https://firebase.google.com/docs/emulator-suite/connect_firestore)
