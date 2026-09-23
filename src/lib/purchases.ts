import { Platform } from 'react-native';
import { getApp } from '@react-native-firebase/app';
import { getFunctions, httpsCallable } from '@react-native-firebase/functions';
import Purchases, {
  LOG_LEVEL, type PurchasesPackage, type CustomerInfo, type PurchasesOffering,
} from 'react-native-purchases';

// 課金（D-11: 月額サブスク）の入口。RevenueCat の SDK をここ1枚に閉じ込める。
//
// 最重要の設計方針: **APIキーが未設定の環境ではペイウォールを出さず、無料枠だけで
// 動く。** キーとストア商品の設定はオーナー作業であり、それが済むまでの間、
// 開発ビルド・Expo Go・CI で「購入できない購入画面」を見せたり、SDK の初期化失敗で
// 見守りそのものが止まったりしてはいけない。安全機能は課金と無関係に動き続ける、
// という §2.5.1 の原則を実装のフェイルモードでも守る。
//
// キーは EXPO_PUBLIC_ 環境変数から取る（Expo がビルド時にインライン展開する）。
// RevenueCat の公開SDKキーはクライアントに埋め込まれる前提のもので、秘密鍵ではない。
// webhook の署名検証用シークレットは Cloud Functions 側にだけ置く。

// Functions のデプロイ先。functions/index.js の FUNCTION_REGION と揃えること。
const FUNCTIONS_REGION = 'asia-northeast1';

const IOS_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY ?? '';
const ANDROID_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY ?? '';

// RevenueCat 側の entitlement 識別子。users/{uid}.entitlements.group と対になる。
export const GROUP_ENTITLEMENT_ID = 'group';

// 価格はハードコードしない（ストアの地域・為替・キャンペーンで変わる。表示価格と
// 実際の請求額がずれるのは審査上も事故）。offering が読めないときだけ、
// D-11b の仮決め値を「およその金額」として出すためのフォールバック。
export const FALLBACK_PRICES = {
  monthly: '¥480',
  annual: '¥4,800',
  trialDays: 7,
} as const;

function apiKey(): string {
  return Platform.OS === 'ios' ? IOS_KEY : ANDROID_KEY;
}

// キーが無い＝オーナーのストア設定がまだ。購入導線そのものを出さない。
export function isPurchasesConfigured(): boolean {
  return apiKey().length > 0;
}

let configuredUid: string | null = null;

// アプリ起動時、および匿名 uid が変わったとき。app user ID を Firebase の匿名 uid に
// 揃えることで、webhook が users/{uid} を引ける（§2.5.4）。
//
// uid 追従が要るのは、匿名 uid が不変ではないため。再インストール・認証の張り直しで
// 変わり得るのに、一度 configure したきりだと app_user_id が旧 uid のまま固定され、
// その端末の購入が二度と本人の文書へ届かなくなる。すでに configure 済みなら
// logIn で付け替える（configure を二度呼ぶのは SDK の想定外）。
export async function configurePurchases(uid: string): Promise<void> {
  if (!isPurchasesConfigured() || !uid || configuredUid === uid) return;
  try {
    if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.WARN);
    if (configuredUid == null) {
      await Purchases.configure({ apiKey: apiKey(), appUserID: uid });
    } else {
      await Purchases.logIn(uid);
    }
    configuredUid = uid;
  } catch (e) {
    // 初期化に失敗しても見守りは動き続けなければならない。無料枠として扱う。
    if (__DEV__) console.warn('RevenueCat configure failed; running as free tier', e);
  }
}

export type Plan = {
  pkg: PurchasesPackage;
  // ストアが返した現地通貨の表示文字列。自前で組み立てない
  priceString: string;
  period: 'monthly' | 'annual' | 'other';
  trialDays: number | null;
};

function periodOf(pkg: PurchasesPackage): Plan['period'] {
  const unit = pkg.product.subscriptionPeriod ?? '';
  if (unit === 'P1M') return 'monthly';
  if (unit === 'P1Y') return 'annual';
  return 'other';
}

function trialDaysOf(pkg: PurchasesPackage): number | null {
  const intro = pkg.product.introPrice;
  if (!intro || intro.price !== 0) return null;
  const cycles = intro.cycles || 1;
  switch (intro.periodUnit) {
    case 'DAY': return intro.periodNumberOfUnits * cycles;
    case 'WEEK': return intro.periodNumberOfUnits * 7 * cycles;
    case 'MONTH': return intro.periodNumberOfUnits * 30 * cycles;
    default: return null;
  }
}

export async function fetchPlans(): Promise<Plan[]> {
  if (!isPurchasesConfigured()) return [];
  try {
    const offerings = await Purchases.getOfferings();
    const current: PurchasesOffering | null = offerings.current;
    if (!current) return [];
    return current.availablePackages.map((pkg) => ({
      pkg,
      priceString: pkg.product.priceString,
      period: periodOf(pkg),
      trialDays: trialDaysOf(pkg),
    }));
  } catch (e) {
    if (__DEV__) console.warn('fetchPlans failed', e);
    return [];
  }
}

export type PurchaseResult = { ok: true; active: boolean } | { ok: false; cancelled: boolean };

export async function purchasePlan(plan: Plan): Promise<PurchaseResult> {
  if (!isPurchasesConfigured()) return { ok: false, cancelled: false };
  try {
    const { customerInfo } = await Purchases.purchasePackage(plan.pkg);
    const active = hasGroupEntitlement(customerInfo);
    // webhook が users を書くのを待たずに、こちらからも1回押しておく。
    // webhook が落ちていても購入直後だけは資格が通る（失敗しても購入自体は成立）。
    if (active) await syncEntitlementFromStore().catch(() => {});
    return { ok: true, active };
  } catch (e: any) {
    // ユーザーが自分でやめたのはエラーではない。文言を出し分けるためだけに区別する
    return { ok: false, cancelled: e?.userCancelled === true };
  }
}

// 復元は2段階。SDK の restore はストアと RevenueCat の間を繋ぐだけで、
// **こちらのサーバー状態（users/{uid}.entitlements）は書き換わらない**。
// 再インストールで匿名 uid が変わっていると、資格は旧 uid の文書に残ったままで、
// 新しい uid には誰も書かない——ペイウォールは「購入済み」なのに rules がペア作成を
// 拒み続ける、というサポート不能な状態になる。だから restore のあとに
// restoreEntitlement（callable）を呼んで、サーバー側にも書き直させる。
export async function restorePurchases(): Promise<PurchaseResult> {
  if (!isPurchasesConfigured()) return { ok: false, cancelled: false };
  let active: boolean;
  try {
    const customerInfo = await Purchases.restorePurchases();
    active = hasGroupEntitlement(customerInfo);
  } catch {
    return { ok: false, cancelled: false };
  }
  await syncEntitlementFromStore().catch(() => {});
  return { ok: true, active };
}

// サーバーに資格を書き直させる。照会する app_user_id は callable 側で
// 「呼び出し元の認証済み uid」に固定してあり、こちらから指定はできない
// （他人の uid を騙って資格を書く／落とす経路を構造的に作らないため）。
export async function syncEntitlementFromStore(): Promise<boolean> {
  try {
    const fn = httpsCallable<undefined, { active?: boolean }>(
      getFunctions(getApp(), FUNCTIONS_REGION),
      'restoreEntitlement',
    );
    const result = await fn();
    return result.data?.active === true;
  } catch (e) {
    if (__DEV__) console.warn('restoreEntitlement failed', e);
    return false;
  }
}

function hasGroupEntitlement(info: CustomerInfo): boolean {
  return info.entitlements.active[GROUP_ENTITLEMENT_ID] != null;
}
