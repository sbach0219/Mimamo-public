import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Icon } from '../components/Icon';
import { dim, radius, type ThemeColor } from '../theme/tokens';
import { useThemedStyles } from '../theme/ThemeContext';
import { haptics } from '../lib/haptics';
import { useIsOnline } from '../lib/network';
import { GROUP_CONCURRENT_WATCH_LIMIT } from '../lib/activeWatch';
import {
  FALLBACK_PRICES, fetchPlans, purchasePlan, restorePurchases, type Plan,
} from '../lib/purchases';
import { useEntitlement } from '../store/entitlementStore';

// グループ機能の購入画面（D-11: 月額サブスク / v3移行設計書 §2.5）。
//
// 売っているものを正確に書く: 「常設のつながり」と「同時に見守れる人数」だけ。
// SOS・異常検知・通知・チャット・履歴・電池残量は無料のままで、この画面を
// 見なかった人にも同じように届く（§2.5.1）。買わせるために安全を人質にしない、
// という原則を、画面の文言そのものでも守る。
//
// APIキーが未設定のとき、この画面はそもそも開かれない（entitlementStore の
// canShowPaywall が false を返し、呼び出し側が導線を出さない）。それでも直接
// 開かれた場合に備えて、ここでも「まだ準備中」を出して行き止まりにしない。
export default function PaywallScreen() {
  const navigation = useNavigation();
  const styles = useThemedStyles(makeStyles);
  const online = useIsOnline();
  const canShowPaywall = useEntitlement((s) => s.canShowPaywall());
  const markPurchased = useEntitlement((s) => s.markPurchased);

  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!canShowPaywall) { setPlans([]); return; }
    let cancelled = false;
    fetchPlans().then((p) => { if (!cancelled) setPlans(p); });
    return () => { cancelled = true; };
  }, [canShowPaywall]);

  const monthly = plans?.find((p) => p.period === 'monthly');
  const annual = plans?.find((p) => p.period === 'annual');
  const trialDays = monthly?.trialDays ?? annual?.trialDays ?? FALLBACK_PRICES.trialDays;

  const buy = async (plan: Plan) => {
    haptics.tap();
    setBusy(true);
    const result = await purchasePlan(plan);
    setBusy(false);
    if (result.ok) {
      // webhook が users を書くまでの数秒を楽観的に埋める。サーバーが「あり」を
      // 返した時点でこのフラグは役目を終える（entitlementStore）
      if (result.active) markPurchased();
      haptics.success();
      navigation.goBack();
      return;
    }
    if (result.cancelled) return; // 自分でやめたのはエラーではない。黙って戻る
    haptics.error();
    Alert.alert('お手続きできませんでした', '通信を確認して、もう一度お試しください。');
  };

  const restore = async () => {
    haptics.tap();
    setBusy(true);
    const result = await restorePurchases();
    setBusy(false);
    if (result.ok && result.active) {
      markPurchased();
      haptics.success();
      Alert.alert('もどしました', 'グループ機能がつかえます。');
      navigation.goBack();
      return;
    }
    Alert.alert(
      'もどせるお支払いがありませんでした',
      'このストアアカウントに、みまものグループ機能のお支払いは見つかりませんでした。',
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Icon name="watch" size={40} />
          <Text style={styles.title}>グループ機能</Text>
          <Text style={styles.lead}>
            いちど つながれば、毎回リンクを送らなくても見守りをはじめられます。{'\n'}
            同時に {GROUP_CONCURRENT_WATCH_LIMIT} 人まで見守れます。
          </Text>
        </View>

        <View style={styles.card}>
          <Benefit styles={styles} text="つながりが のこる（毎回のQR・リンクが要らない）" />
          <Benefit styles={styles} text={`同時に ${GROUP_CONCURRENT_WATCH_LIMIT} 人まで 見守れる`} />
          <Benefit styles={styles} text="まえの見守りの じこくと ばしょ を7日間 見られる" />
        </View>

        {/* 買わない人が損をしないことを、いちばん大きな字で書く。
            安全機能を課金の壁の内側に置かないという原則（§2.5.1）は、
            実装だけでなくこの画面の説明責任でもある */}
        <View style={styles.freeCard}>
          <Icon name="info" size={16} />
          <Text style={styles.freeText}>
            SOS・異常のおしらせ・チャット・到着連絡・履歴・電池残量は、
            これまでどおり無料でつかえます。お支払いの有無で、安全のしくみは変わりません。
          </Text>
        </View>

        {plans === null ? (
          <ActivityIndicator style={{ marginVertical: 24 }} />
        ) : plans.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.prepText}>
              グループ機能は じゅんび中です。{'\n'}
              つかえるようになったら、この画面でお知らせします。
            </Text>
          </View>
        ) : (
          <>
            {monthly && (
              <PlanButton
                styles={styles}
                title="月額プラン"
                price={monthly.priceString}
                unit="／月"
                note={trialDays ? `さいしょの ${trialDays}日間は むりょう` : undefined}
                primary
                disabled={!online || busy}
                onPress={() => buy(monthly)}
              />
            )}
            {annual && (
              <PlanButton
                styles={styles}
                title="年額プラン"
                price={annual.priceString}
                unit="／年"
                note="1年ぶんまとめて（月額より おとく）"
                disabled={!online || busy}
                onPress={() => buy(annual)}
              />
            )}
          </>
        )}

        <Pressable
          style={styles.textBtn}
          onPress={restore}
          disabled={busy || !online}
          accessibilityRole="button"
          accessibilityLabel="購入をもどす"
        >
          <Text style={styles.textBtnLabel}>購入をもどす（機種変更・再インストールのとき）</Text>
        </Pressable>

        <Text style={styles.legal}>
          お支払いはストアのアカウントに請求されます。自動更新は、いつでもストアの設定から
          とめられます。とめても、いま進行中の見守りは最後までつづきます。つながりも消えません
          （あたらしい見守りと、2人目からの同時見守りだけが止まります）。{'\n'}
          機種を変えても「購入をもどす」でお支払いはもどりますが、つながりは戻りません。
          そのときは、もう一度招待してつなぎ直してください。
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Benefit({ styles, text }: { styles: any; text: string }) {
  return (
    <View style={styles.benefitRow}>
      <Icon name="star" size={16} />
      <Text style={styles.benefitText}>{text}</Text>
    </View>
  );
}

function PlanButton({
  styles, title, price, unit, note, primary, disabled, onPress,
}: {
  styles: any; title: string; price: string; unit: string;
  note?: string; primary?: boolean; disabled?: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.plan, primary && styles.planPrimary, disabled && styles.planOff]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${title} ${price}${unit}${note ? `。${note}` : ''}`}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.planTitle, primary && styles.planTitlePrimary]}>{title}</Text>
        {note && <Text style={[styles.planNote, primary && styles.planNotePrimary]}>{note}</Text>}
      </View>
      <Text style={[styles.planPrice, primary && styles.planTitlePrimary]}>{price}{unit}</Text>
    </Pressable>
  );
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.night[0] },
  content: { padding: 20, gap: 16, paddingBottom: 40 },

  hero: { alignItems: 'center', gap: 8, paddingTop: 8 },
  title: { fontSize: 26, fontWeight: '800', color: c.text },
  lead: { fontSize: 15, color: c.textSub, textAlign: 'center', lineHeight: 24 },

  card: {
    gap: 12, padding: 16, borderRadius: radius.card,
    backgroundColor: c.glass, borderWidth: 1, borderColor: c.glassStroke,
  },
  benefitRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  benefitText: { flex: 1, fontSize: 15, color: c.text, lineHeight: 23 },

  freeCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    padding: 14, borderRadius: radius.card,
    backgroundColor: dim(c.safe, 0.1), borderWidth: 1.5, borderColor: dim(c.safe, 0.5),
  },
  freeText: { flex: 1, fontSize: 14, color: c.text, lineHeight: 22, fontWeight: '600' },

  prepText: { fontSize: 15, color: c.textSub, lineHeight: 24, textAlign: 'center' },

  plan: {
    flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    minHeight: 68, paddingHorizontal: 18, paddingVertical: 14, borderRadius: 16,
    backgroundColor: c.raised, borderWidth: 1.5, borderColor: c.glassStroke,
  },
  planPrimary: { backgroundColor: c.action, borderColor: c.action },
  planOff: { opacity: 0.5 },
  planTitle: { fontSize: 17, fontWeight: '800', color: c.text },
  planTitlePrimary: { color: c.actionInk },
  planNote: { fontSize: 13, color: c.textSub, marginTop: 3, lineHeight: 19 },
  planNotePrimary: { color: c.actionInk, opacity: 0.85 },
  planPrice: { fontSize: 18, fontWeight: '800', color: c.text },

  textBtn: { minHeight: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12 },
  textBtnLabel: { fontSize: 14, fontWeight: '700', color: c.action, textAlign: 'center' },

  legal: { fontSize: 12, color: c.textSub, lineHeight: 20 },
});
