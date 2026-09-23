# グループ機能（月額サブスク）のセットアップ — オーナー作業手順

作成: 2026-08-26 ／ 開発部
対象: v3 Phase 2（`feature/v3-phase2-pairs`）で入った課金基盤（D-11 / v3移行設計書 §2.5）

**この作業が終わるまで、アプリは無料枠だけで動く。** APIキーが未設定の環境では
ペイウォールも「グループ機能」の導線も出ず、リンクを送る1対1の見守り（無料）は
これまでどおり全部動く。設定を急ぐ必要はないが、**終わるまで恒久ペアは誰も作れない**
（rules が entitlement を要求するため）点だけ先に把握しておくこと。§5 に開発時の
回避手順を書いた。

---

## 1. App Store Connect / Google Play Console

サブスクリプション商品を2つ作る。価格は D-11b の仮決め（2026-08-25 承認）。

| 商品 | 価格 | 無料トライアル |
|---|---|---|
| 月額 | ¥480 / 月 | 7日 |
| 年額 | ¥4,800 / 年 | 7日 |

- 商品IDは RevenueCat 側で束ねるので自由に決めてよい（例: `mimamo_group_monthly` / `mimamo_group_annual`）。
- 審査提出時、**サブスクリプションの説明には「安全機能（SOS・異常検知・通知）は無料である」ことを書く**。
  人命に関わる機能を課金で制限していないことは、審査でも製品の主張としても中核（§2.5.1）。
- 年額は「月額の10ヶ月分」という位置づけ。ストア上の割引表示はストアの計算に任せる。

## 2. RevenueCat

1. プロジェクトを作り、App Store / Google Play のアプリを接続する。
2. **Entitlement の識別子を `group` にする**（コード側の `GROUP_ENTITLEMENT_ID` と一致させること。
   `src/lib/purchases.ts`）。
3. 上の2商品を1つの Offering（`current`）にまとめる。パッケージ種別は月額＝Monthly、年額＝Annual。
   コードは `subscriptionPeriod`（`P1M` / `P1Y`）でどちらかを判定するので、そこがずれると
   ペイウォールにプランが並ばない。
4. 公開SDKキー（iOS / Android）を控える。**これはクライアントに埋め込まれる前提の公開キーで、秘密鍵ではない。**

## 3. アプリ側の環境変数

EAS のビルド環境（`eas.json` の env、または EAS の環境変数）に入れる。

```
EXPO_PUBLIC_REVENUECAT_IOS_API_KEY=appl_xxxxxxxx
EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY=goog_xxxxxxxx
```

- `EXPO_PUBLIC_` 接頭辞は Expo がビルド時にインライン展開するための規約。
- **未設定なら購入導線は出ない**（`isPurchasesConfigured()` が false）。片方だけ設定した場合、
  設定したプラットフォームだけで導線が出る。
- `react-native-purchases` はネイティブモジュールなので、**この変更を反映するには新しいビルドが必要**
  （OTA では入らない）。Universal Links（D-2）の再ビルドと同じビルドに載せる。

## 4. Cloud Functions（webhook）

`revenuecatWebhook` が `users/{uid}.entitlements` の唯一の書き手。クライアントは rules で
書き込みを閉じてあるので、ここが設定されないと誰も資格を持てない。

1. 共有シークレットを決めて Firebase の環境変数に入れる。

   ```
   firebase functions:secrets:set REVENUECAT_WEBHOOK_SECRET
   firebase functions:secrets:set REVENUECAT_REST_API_KEY
   ```

   `REVENUECAT_REST_API_KEY` は RevenueCat の **Secret key**（公開SDKキーとは別物）。
   復元用の callable（`restoreEntitlement`）が「その匿名 uid が本当にその購読の
   所有者か」を確かめるのに使う。未設定でも復元は静かに失敗するだけでアプリは動くが、
   **再インストールで uid が変わった課金者を救えない**ので入れること。

2. RevenueCat の Webhooks 設定で、デプロイ後の関数URLを登録し、**Authorization ヘッダに同じ値**を入れる。
   関数は `asia-northeast1` にデプロイされる。
3. 未設定のままデプロイすると、webhook は 503 を返して**すべて拒否する**（設定されていなければ
   全部拒否、に倒してある。誰でも entitlement を書ける状態を一瞬でも作らないため）。

### 動作の要点（把握しておくと障害時に迷わない）

- `app_user_id` は Firebase の匿名 uid。アプリが起動時に `configurePurchases(uid)` で揃えている。
- `CANCELLATION`（自動更新の停止）では資格を落とさない。落とすのは `EXPIRATION`。
  「解約したその日から使えない」にしないため。
- 知らないイベント種別では現在の状態を動かさず 200 を返す。4xx を返すと RevenueCat が延々と再送する。
- 書き込みに失敗したときは 5xx を返す。RevenueCat が再送してくれるので、握りつぶさない。
- `TRANSFER`（購読が別のストアアカウントへ移った）は失効として扱わない。`transferred_from` の
  uid から資格を外し、`transferred_to` の uid へ渡す。一律 `active:false` にすると、
  機種変更後の本人が締め出される。
- 再送と順序逆転に備えて `lastEventId` / `lastEventAtMs` を持ち、処理済み・古いイベントは
  200 で無視する。これが無いと、遅れて届いた `RENEWAL` が `REFUND` の後に適用されて
  資格が復活する。
- 失効の経路は webhook 単独ではない。`watchPairs`（日次）が
  `active:true && expiresAt <= now` を拾って倒し、rules も `expiresAt` を見る。
  webhook の1通を取りこぼしても、翌日以降は自然に閉じる。

## 5. 設定が終わるまでの開発・検証

entitlement が無いとペアが1本も作れないため、実機検証では Firestore コンソールから
自分の uid の `users` 文書に手で書く。

```json
{
  "entitlements": {
    "group": { "active": true, "expiresAt": null, "source": "manual" }
  }
}
```

- uid はアプリの設定タブからは見えないので、Firestore の `sessions` で自分が作った
  セッションの `watcherUid` を見るのが早い。
- 検証が終わったら消すこと。手で書いた資格は webhook が上書きするまで残り続ける。

## 6. ストア申告（法務部の指摘）

`docs/store-listing.md` に反映済みだが、提出時にフォームで再申告が要る。

- Google Play「データ安全」: 名前（表示名）・その他の情報（呼び名・年齢）・金融情報（購入履歴）
- App Store「Appのプライバシー」: 名前・その他のデータ・購入。**識別子と位置情報の
  「ひも付けあり／なし」区分の見直しが要検討**（法務部から要確認の指摘あり）
