import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SkyScreen } from '../theme/Background';
import { SkyButton } from '../components/SkyButton';
import { Icon, type IconName } from '../components/Icon';
import { colors } from '../theme/colors';
import { haptics } from '../lib/haptics';
import type { ScreenProps } from '../navigation/types';

export const ONBOARDING_DONE_KEY = 'onboardingDone';

// 初回起動時だけ表示する3枚の説明。仕組みと「なぜ権限が要るか」を先に伝えて、
// 権限ダイアログでの離脱とストア審査の印象を改善する。
const CARDS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'link',
    title: 'つないで',
    body: '見守る人がつくったQRコードやリンクで、\n歩く人とつながります。\nアカウント登録はいりません。',
  },
  {
    icon: 'walk',
    title: 'あるいて',
    body: '歩く人の現在地は、見守り中だけ共有されます。\n転倒などを検知するためにモーションセンサーも使いますが、\nデータは端末の中だけで処理されます。',
  },
  {
    icon: 'moon',
    title: 'みまもる',
    body: '異常があればまず本人に「だいじょうぶ？」と確認。\n応答がないときだけ、見守る人へお知らせします。\nもしもの時はSOS・緊急通報もワンタップです。',
  },
];

export default function OnboardingScreen({ navigation }: ScreenProps<'Onboarding'>) {
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState(0);
  const last = page === CARDS.length - 1;
  const card = CARDS[page];

  const finish = async () => {
    haptics.success();
    await AsyncStorage.setItem(ONBOARDING_DONE_KEY, '1').catch(() => {});
    navigation.replace('RoleSelect');
  };

  return (
    <SkyScreen>
      <SafeAreaView style={styles.safe}>
        <View style={styles.card}>
          <Icon name={card.icon} size={88} />
          <Text style={styles.title}>{card.title}</Text>
          <Text style={styles.body}>{card.body}</Text>
        </View>

        <View style={styles.dots}>
          {CARDS.map((_, i) => (
            <View key={i} style={[styles.dot, i === page && styles.dotActive]} />
          ))}
        </View>

        {last ? (
          <SkyButton title="はじめる 🌟" variant="primary" style={{ width: 240 }} onPress={finish} />
        ) : (
          <SkyButton
            title="つぎへ →"
            variant="watcher"
            style={{ width: 240 }}
            onPress={() => { haptics.tap(); setPage(page + 1); }}
          />
        )}
      </SafeAreaView>

      {/* SafeAreaView の外に置き、insets 基準で絶対配置する（内側だと上パディングと二重に効く） */}
      <Pressable
        style={[styles.skip, { top: insets.top + 8 }]}
        onPress={finish}
        accessibilityRole="button"
        accessibilityLabel="説明をスキップ"
      >
        <Text style={styles.skipText}>スキップ</Text>
      </Pressable>
    </SkyScreen>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 28, paddingHorizontal: 32 },
  skip: { position: 'absolute', right: 24, padding: 8 },
  skipText: { color: 'rgba(255,255,255,0.55)', fontSize: 14, fontWeight: '600' },
  card: { alignItems: 'center', gap: 16 },
  title: { fontSize: 30, fontWeight: '800', color: colors.white, letterSpacing: 4 },
  body: { fontSize: 15, color: 'rgba(255,255,255,0.85)', textAlign: 'center', lineHeight: 25 },
  dots: { flexDirection: 'row', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.3)' },
  dotActive: { backgroundColor: colors.yellow, width: 22 },
});
