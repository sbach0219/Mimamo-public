# 招待リンクの Universal Links / App Links 化（F-11 / オーナー決定 D-2）

公開仕様の招待 URL: **`https://thousandsky.com/s/{sessionId}`**

現状（このブランチ）はアプリが `thousandsky://session/{id}` を共有している。
https 形式へ切り替えるには **native の再ビルド**が必要なため、切り替えはストア提出
ビルド（time-sensitive entitlement 復活と同じ回）で行う。本書はその準備状況と手順。

## 1. 準備できているもの（このブランチ）

| ファイル | 内容 | 状態 |
|---|---|---|
| `website/.well-known/apple-app-site-association` | iOS 用。`YOUR_APPLE_TEAM_ID.com.thousandsky.app` に `/s/*` を割り当て | 作成済み・**未デプロイ** |
| `website/.well-known/assetlinks.json` | Android 用。`com.thousandsky.app` | 作成済み・**署名フィンガープリント未記入** |
| `website/s/index.html` | AASA が効かない端末の受け皿。`/s/{id}` と `/s/?id={id}` の両方からアプリのスキームへ渡す | 作成済み・**未デプロイ** |
| `src/lib/inviteLink.ts` | URL 組み立ての一元化。`USE_HTTPS_INVITE` を true にすれば共有文言が https に変わる | 実装済み（false のまま） |

## 2. 残作業（順序どおりに）

1. **Android の署名フィンガープリントを入れる**（**オーナー作業**）
   `eas credentials` は対話専用で、`--non-interactive` に相当するフラグが無い
   （eas-cli 20.x で確認済み）。CI や自動化からは取得できないため、手動で実行すること。
   `eas credentials` → Android → 本番キーストアの SHA-256 を取得し、
   `assetlinks.json` の `PLACEHOLDER_REPLACE_WITH_RELEASE_SHA256` を置き換える。
   Google Play アプリ署名を使う場合は **Play Console 側の署名鍵**の SHA-256 を使うこと
   （アップロード鍵ではない。ここを間違えると App Links が検証に失敗する）。
2. **website を公開する**（オーナー作業）
   - `.well-known/` は **Content-Type: application/json**、リダイレクトなし・認証なしで
     `https://thousandsky.com/.well-known/apple-app-site-association` に 200 で応答すること
     （拡張子なしのファイル名のままにする）。
   - **ホスティング側に rewrite が必要**: `/s/{id}` → `/s/index.html`。
     静的ホスティングで rewrite を設定できない場合は、共有 URL を
     `https://thousandsky.com/s/?id={id}` 形式にする（`inviteLink.ts` の1行変更で済む）。
   - 現在 website は「みまも」の露出を一時クローズ中（`website/README.md`）。
     `/s/` ページは製品名・機能説明を持たない汎用の文面にしてあるため、この方針と両立する。
3. **app.json に associatedDomains / intentFilters を足す**（案。まだ適用していない）

```jsonc
// ios
"associatedDomains": ["applinks:thousandsky.com"],
// android
"intentFilters": [
  {
    "action": "VIEW",
    "autoVerify": true,
    "data": [{ "scheme": "https", "host": "thousandsky.com", "pathPrefix": "/s" }],
    "category": ["BROWSABLE", "DEFAULT"]
  }
]
```

   `associatedDomains` は Apple Developer 側の capability も要るため、
   **対話モードの `eas build` で capability sync を Yes** にすること（time-sensitive の復活と同じ流れ）。
4. **`src/lib/inviteLink.ts` の `USE_HTTPS_INVITE` を true にする**（アプリ側の切り替えはこれだけ）。
5. **App.tsx の `parseSessionId` を https 形式にも対応させる**。
   現在は `Linking.parse` の `hostname === 'session'` だけを見ているため、
   `https://thousandsky.com/s/{id}` では `hostname === 'thousandsky.com'` になり弾かれる。
   切り替えと同じコミットで対応すること（**この対応を忘れると、リンクを踏んでも参加できない**）。

## 2.5 デプロイ前チェックリスト（website を公開する前に必ず確認）

- [ ] `assetlinks.json` の `PLACEHOLDER_REPLACE_WITH_RELEASE_SHA256` を実際の SHA-256 に置換した
      （**プレースホルダのまま公開すると Android の App Links 検証が必ず失敗する**。
      検証は端末側にキャッシュされるため、直してから再インストールが要る）
- [ ] `apple-app-site-association` が拡張子なし・`application/json`・リダイレクトなしで 200 を返す
- [ ] `/s/{id}` が `/s/index.html` に rewrite される（できない場合は `?id=` 形式へ切替）
- [ ] `src/lib/inviteLink.ts` の `USE_HTTPS_INVITE` と `App.tsx` の `parseSessionId` を
      同じコミットで切り替えた

## 3. 検証（実機・両OS）

- アプリ未インストール → リンクを踏む → `/s/` ページが出る → ストアへの導線（LP はデザイン部）
- アプリ済み iOS → Safari を経由せずアプリが直接開く（`applinks` の検証は初回インストール時に走るため、
  AASA を公開してからアプリを入れ直して確認する）
- アプリ済み Android → 「常にこのアプリで開く」の選択が出ずに直接開く（autoVerify）
- LINE・メール・SMS の各アプリからのタップ（アプリ内ブラウザ経由の挙動が異なる）
