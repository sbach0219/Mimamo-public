# Contributing

みまもへの改善提案ありがとうございます。

## 開発環境

- Node.js 22（アプリ・通常テスト）
- Node.js 20（Cloud Functions）
- Java 21以上（Firestoreルールテスト）
- Expo SDK 56対応のXcode / Android Studio

セットアップはREADMEに従い、自分のFirebaseプロジェクトのクライアント設定を使用してください。
本番プロジェクトへのdeploy、EAS build/submit、OTA updateは行わないでください。

## 変更前後の確認

```bash
npm ci
npm ci --prefix functions
npm ci --prefix firestore-tests
npm run typecheck
npm test -- --ci --runInBand
npm test --prefix functions
npm run test:rules
```

位置共有、通知、バックグラウンド動作に関する変更は、自動テストだけで完了とはしません。
確認できていない端末・OS・通知状態をPull Requestへ明記してください。

## データと秘密情報

- 実在する利用者のデータ、位置、電話番号、UID、トークン、招待リンクを追加しないでください。
- Firebase Admin SDK鍵、App Store Connect鍵、RevenueCat Secret keyなどをコミットしないでください。
- サンプルには架空の値を使ってください。
- セキュリティ上の問題は公開Issueではなく、SECURITY.mdの窓口へ報告してください。
