import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Linking, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SkyScreen } from '../theme/Background';
import { GlassCard } from '../components/GlassCard';
import { Icon, type IconName } from '../components/Icon';
import { colors } from '../theme/colors';
import { loadWatchPreferences, clearStoredPhone } from '../lib/watchPreferences';
import { APP_VERSION, CONTACT, PRIVACY_URL, TERMS_URL } from '../lib/appLinks';
import type { ScreenProps } from '../navigation/types';

// アプリ情報（プライバシーポリシー・利用規約・バージョン・連絡先）。
// ストア審査でも「アプリ内からポリシーへ到達できること」が好印象になる。
// 値そのものは lib/appLinks で見守り側の設定タブと共有する。

export default function SettingsScreen(_props: ScreenProps<'Settings'>) {
  // 端末に覚えている緊急連絡先。保存しているなら、消す手段を必ず用意する
  const [storedPhone, setStoredPhone] = useState<string | null>(null);
  useEffect(() => {
    loadWatchPreferences().then((p) => setStoredPhone(p?.walkerPhone ?? null));
  }, []);

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

  return (
    <SkyScreen>
      <SafeAreaView style={{ flex: 1 }} edges={['bottom']}>
        <View style={styles.content}>
          <Text style={styles.appMark}>✦</Text>
          <Text style={styles.appName}>みまも</Text>
          <Text style={styles.version}>バージョン {APP_VERSION}</Text>

          <GlassCard style={styles.card}>
            <Row
              icon="lock"
              label="プライバシーポリシー"
              hint="位置情報・センサーの扱いについて"
              onPress={() => Linking.openURL(PRIVACY_URL)}
            />
            <View style={styles.divider} />
            <Row
              icon="document"
              label="利用規約"
              hint="ご利用にあたっての約束ごと"
              onPress={() => Linking.openURL(TERMS_URL)}
            />
            <View style={styles.divider} />
            <Row
              icon="mail"
              label="お問い合わせ・データ削除の依頼"
              hint={CONTACT}
              onPress={() => Linking.openURL(`mailto:${CONTACT}`)}
            />
          </GlassCard>

          {storedPhone && (
            <GlassCard style={styles.card}>
              <Row
                icon="phone"
                label="保存した緊急連絡先を削除"
                hint={`この端末に ${storedPhone} を覚えています`}
                onPress={removePhone}
              />
            </GlassCard>
          )}

          <Text style={styles.note}>
            みまもは、個人を特定する情報を集めません。{'\n'}
            位置情報の共有は「見守り中」だけです。
          </Text>
        </View>
      </SafeAreaView>
    </SkyScreen>
  );
}

function Row({ icon, label, hint, onPress }: { icon: IconName; label: string; hint: string; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress} accessibilityRole="link" accessibilityLabel={label}>
      <Icon name={icon} size={20} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowHint}>{hint}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, alignItems: 'center', paddingTop: 36, paddingHorizontal: 24, gap: 6 },
  appMark: { fontSize: 44, color: colors.yellow },
  appName: { fontSize: 26, fontWeight: '800', color: colors.white, letterSpacing: 6 },
  version: { fontSize: 13, color: 'rgba(255,255,255,0.55)', marginBottom: 20 },
  card: { width: '100%', padding: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  rowLabel: { fontSize: 15, fontWeight: '600', color: colors.white },
  rowHint: { fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: 2 },
  chevron: { fontSize: 24, color: 'rgba(255,255,255,0.4)' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.25)', marginHorizontal: 14 },
  note: { marginTop: 18, fontSize: 12, color: 'rgba(255,255,255,0.5)', textAlign: 'center', lineHeight: 19 },
});
