# firestore.rules 回帰テスト

`../firestore.rules` を Firestore エミュレータ上で検証する。攻撃入力が deny され、
アプリの正規フローが allow されることを両方 assert する。

## 実行

```bash
npm run test:rules      # リポジトリルートから
# または
cd firestore-tests && npm install && npm test
```

エミュレータは `firebase emulators:exec` が自動で起動・停止する。**JDK 21 以上が必要**
（firebase-tools が Java 21 未満を拒否する）。入っていなければ:

```bash
brew install openjdk@21
```

## なぜこのテストがあるか

2026-07-31 の自己診断で「待機セッションを誰でも列挙できる」と報告されたが、実際には
現行ルールの `isJoinable` にある `expiresAt > request.time` が list を不能にしていて塞がっていた。

ただしこれは副作用的・暗黙的な防御である。Firestore の list はクエリ制約からルールの充足を
証明できる場合のみ許可されるため、`request.time` との不等式が**たまたま**すべての list を
拒否していたにすぎない。期限チェックを別の場所に移すといった一見無害な改修で穴が開く。

そこで `read` を `get` / `list` に分離して意図を明示し、このテストで固定した。
経緯は `docs/security-review-2026-07-31.md` を参照。

## カバーしている範囲

- **列挙**: 4種のクエリ（status指定・walkerUid指定・全件・他人のwatcherUid指定）が第三者から拒否されること
- **参加(join)**: 期限切れ・終了済み・参加済みセッションへの割り込み、参加に便乗した
  相手のFCMトークン／位置情報の書き換えが拒否されること
- **更新**: 役割別の許可リスト（歩く人＝位置・電池・SOS、見守り＝安否確認・自分のトークン・待機中の取消）
- **作成**: 他人のUID、walker埋め込み、期限切れ、不正な所要時間の拒否
- **サブコレクション**: メッセージの sender 偽装・300文字上限・余計なフィールド、既読は受信者のみ、
  経路は歩く人のみ・進行中のみ・座標範囲内
- **正規フロー**: 実アプリ（`src/store/sessionStore.ts`）が投げる書き込みそのもの。
  SOS発信/キャンセル/時間延長（`sosSilent` / `sosCancelledAt` / `timeExtendedAt`）を含む

## 別のルールファイルに対して実行する

`RULES_PATH` で差し替えられる。旧ルールに当てて列挙テストが落ちることの確認などに使う。

```bash
firebase emulators:exec --only firestore --project mimamo-rules-test \
  "cd firestore-tests && RULES_PATH=/path/to/other.rules ./node_modules/.bin/jest --runInBand"
```

## 注意

- ルール変更時は必ずこのテストを通してからデプロイすること。
- デプロイ前に `git fetch && git status` でリモートとの乖離を確認すること
  （古いローカルコピーからのデプロイで本番を退行させた事故がある）。
- Cloud Functions は Admin SDK で動くためセキュリティルールの適用外。
