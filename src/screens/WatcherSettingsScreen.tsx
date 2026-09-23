import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Linking, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Icon, type IconName } from '../components/Icon';
import { radius, type ThemeColor } from '../theme/tokens';
import { useThemedStyles } from '../theme/ThemeContext';
import { loadWatchPreferences, clearStoredPhone, clearStoredName } from '../lib/watchPreferences';
import { WatcherConnectionNotice } from '../components/WatcherConnectionNotice';
import { APP_VERSION, CONTACT, PRIVACY_URL, TERMS_URL } from '../lib/appLinks';
import { restorePurchases } from '../lib/purchases';
import { useEntitlement } from '../store/entitlementStore';
import type { RootStackParamList } from '../navigation/types';

// 設定タブ（見守り側・昼テーマ）。
// 中身は夜テーマの「このアプリについて」（SettingsScreen）と同じ項目に、
// 見守り側からの出口（履歴・自分が歩く）を足したもの。夜テーマの画面をそのまま
// タブに載せると、白いタブバーの下に紺の画面が続いて壊れて見えるため、
// テーマに沿った器を用意して中身の定義（URL・連絡先）だけ lib/appLinks で共有する。
export default function WatcherSettingsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const styles = useThemedStyles(makeStyles);
  const canShowPaywall = useEntitlement((s) => s.canShowPaywall());
  const groupActive = useEntitlement((s) => s.isGroupActive());
  const markPurchased = useEntitlement((s) => s.markPurchased);
  const [storedPhone, setStoredPhone] = useState<string | null>(null);
  const [storedName, setStoredName] = useState<string | null>(null);

  useEffect(() => {
    loadWatchPreferences().then((p) => {
      setStoredPhone(p?.walkerPhone ?? null);
      setStoredName(p?.walkerName ?? null);
    });
  }, []);

  // 購入の復元（§2.5.4）。匿名認証のままでも、購入はストアアカウントに紐づくので
  // 機種変更・再インストール後に資格だけは戻せる。戻らないのは つながりと履歴で、
  // そこは「もう一度招待してつなぎ直す」が正（そう言い切る文言にする）。
  const onRestore = async () => {
    const result = await restorePurchases();
    if (result.ok && result.active) {
      markPurchased();
      Alert.alert('もどしました', 'グループ機能がつかえます。つながりは戻らないので、必要ならもう一度招待してください。');
      return;
    }
    Alert.alert(
      'もどせるお支払いがありませんでした',
      'このストアアカウントに、みまものグループ機能のお支払いは見つかりませんでした。',
    );
  };

  const removePhone = () => {
    Alert.alert(
      '緊急連絡先を削除しますか？',
      'この端末に覚えている電話番号を消します。進行中の見守りに登録済みの番号は、その見守りが終わってから7日で自動的に消えます。',
      [
        { text: 'やめる', style: 'cancel' },
        {
          text: '削除する',
          style: 'destructive',
          onPress: async () => { await clearStoredPhone(); setStoredPhone(null); },
        },
      ]
    );
  };

  const removeName = () => {
    Alert.alert(
      '覚えている呼び名を削除しますか？',
      'この端末に覚えている相手の呼び名を消します。進行中の見守りに登録済みの呼び名は、その見守りが終わってから7日で自動的に消えます。',
      [
        { text: 'やめる', style: 'cancel' },
        {
          text: '削除する',
          style: 'destructive',
          onPress: async () => { await clearStoredName(); setStoredName(null); },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* 圏外表示（M-1） */}
        <WatcherConnectionNotice />
        <Text style={styles.title}>設定</Text>

        <View style={styles.card}>
          <Row
            icon="clock"
            label="見守りの履歴"
            hint="これまでの見守りを見る"
            onPress={() => navigation.navigate('History')}
            styles={styles}
          />
          <View style={styles.divider} />
          {/* 1台で2役（見守る人が自分でも歩く）は既存の前提。入口を残す */}
          <Row
            icon="walk"
            label="自分が歩く"
            hint="見守られる側としてはじめる"
            onPress={() => navigation.navigate('Start')}
            styles={styles}
          />
        </View>

        {/* つながり（恒久ペア）とグループ機能。購入の復元は §2.5.4 の必須要件で、
            匿名認証のままでもストアアカウント経由で資格が戻ることを担保する導線 */}
        <View style={styles.card}>
          <Row
            icon="watch"
            label="つながり"
            hint="いつもの相手を登録して、リンクなしで見守る"
            onPress={() => navigation.navigate('Pairs')}
            styles={styles}
          />
          {canShowPaywall && (
            <>
              <View style={styles.divider} />
              <Row
                icon="star"
                label={groupActive ? 'グループ機能（ごりようちゅう）' : 'グループ機能について'}
                hint={groupActive ? '同時に複数の人を見守れます' : '同時に複数の人を見守る（月額）'}
                onPress={() => navigation.navigate('Paywall')}
                styles={styles}
              />
              <View style={styles.divider} />
              <Row
                icon="info"
                label="購入をもどす"
                hint="機種変更・再インストールのあとに"
                onPress={onRestore}
                styles={styles}
              />
            </>
          )}
        </View>

        <View style={styles.card}>
          <Row
            icon="lock"
            label="プライバシーポリシー"
            hint="位置情報・センサーの扱いについて"
            onPress={() => Linking.openURL(PRIVACY_URL)}
            styles={styles}
          />
          <View style={styles.divider} />
          <Row
            icon="document"
            label="利用規約"
            hint="ご利用にあたっての約束ごと"
            onPress={() => Linking.openURL(TERMS_URL)}
            styles={styles}
          />
          <View style={styles.divider} />
          <Row
            icon="mail"
            label="お問い合わせ・データ削除の依頼"
            hint={CONTACT}
            onPress={() => Linking.openURL(`mailto:${CONTACT}`)}
            styles={styles}
          />
        </View>

        {(storedPhone || storedName) && (
          <View style={styles.card}>
            {storedPhone && (
              <Row
                icon="phone"
                label="保存した緊急連絡先を削除"
                hint={`この端末に ${storedPhone} を覚えています`}
                onPress={removePhone}
                styles={styles}
              />
            )}
            {storedPhone && storedName && <View style={styles.divider} />}
            {/* 相手の呼び名も「他人に関する情報」。端末に覚える以上、
                電話番号と同じ削除手段を用意する（M-4） */}
            {storedName && (
              <Row
                icon="watch"
                label="覚えている呼び名を削除"
                hint={`この端末に「${storedName}」を覚えています`}
                onPress={removeName}
                styles={styles}
              />
            )}
          </View>
        )}

        <Text style={styles.note}>
          みまもは、個人を特定する情報を集めません。{'\n'}
          位置情報の共有は「見守り中」だけです。
        </Text>
        <Text style={styles.version}>バージョン {APP_VERSION}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function Row({ icon, label, hint, onPress, styles }: {
  icon: IconName; label: string; hint: string; onPress: () => void; styles: Styles;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}。${hint}`}>
      <Icon name={icon} size={20} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowHint}>{hint}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.night[0] },
  content: { padding: 16, gap: 14, paddingBottom: 32 },
  title: { fontSize: 22, fontWeight: '800', color: c.text },
  card: {
    borderRadius: radius.card, backgroundColor: c.cardNavy,
    borderWidth: 1.5, borderColor: c.glassStroke, paddingVertical: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingVertical: 12, paddingHorizontal: 14 },
  rowLabel: { fontSize: 16, fontWeight: '700', color: c.text },
  rowHint: { fontSize: 12, color: c.textSub, marginTop: 2, lineHeight: 18 },
  chevron: { fontSize: 24, color: c.textFaint },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.glassStroke, marginHorizontal: 14 },
  note: { fontSize: 12, color: c.textSub, textAlign: 'center', lineHeight: 19, marginTop: 8 },
  version: { fontSize: 12, color: c.textFaint, textAlign: 'center' },
});
