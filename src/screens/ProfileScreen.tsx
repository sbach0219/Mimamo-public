import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SkyScreen } from '../theme/Background';
import { SkyButton } from '../components/SkyButton';
import { colors } from '../theme/colors';
import { color } from '../theme/tokens';
import { haptics } from '../lib/haptics';
import { AVATAR_PRESETS } from '../lib/avatars';
import { MAX_DISPLAY_NAME, normalizeDisplayName } from '../lib/pairs';
import { useProfile } from '../store/profileStore';
import { usePairs } from '../store/pairStore';
import type { ScreenProps } from '../navigation/types';

// なまえとアイコン（ADR P3 決定1・users/{uid}）。
// どちらも任意入力で、相手ペアにのみ見える。氏名・メール・電話番号は取得しない
// （プライバシーポリシー §2 の「登録項目を一切取得しない」約束の範囲を出ない）。
export default function ProfileScreen({ navigation }: ScreenProps<'Profile'>) {
  const profile = useProfile((s) => s.profile);
  const save = useProfile((s) => s.save);
  const syncProfileToPairs = usePairs((s) => s.syncProfileToPairs);

  const [name, setName] = useState(profile.displayName);
  const [avatar, setAvatar] = useState(profile.avatar);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(profile.displayName);
    setAvatar(profile.avatar);
  }, [profile.displayName, profile.avatar]);

  const onSave = async () => {
    setSaving(true);
    try {
      await save({ displayName: normalizeDisplayName(name), avatar });
      // 相手が見ている複製も直す。失敗しても自分のプロフィールは保存済みなので、
      // ここは静かに諦めてよい（次回の保存で追いつく）
      await syncProfileToPairs().catch(() => {});
      haptics.success();
      navigation.goBack();
    } catch {
      haptics.error();
      Alert.alert('保存できませんでした', '通信を確認して、もう一度お試しください。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SkyScreen>
      <SafeAreaView style={{ flex: 1 }} edges={['bottom']}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.lead}>
            つながっている相手の画面に出る、あなたの呼び名とアイコンです。{'\n'}
            どちらも入れなくてもかまいません。
          </Text>

          <View style={styles.block}>
            <Text style={styles.heading}>よびな</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="例: おかあさん"
              placeholderTextColor={color.textFaint}
              maxLength={MAX_DISPLAY_NAME}
              accessibilityLabel="よびな"
            />
            <Text style={styles.hint}>{MAX_DISPLAY_NAME}文字まで。本名でなくてかまいません。</Text>
          </View>

          <View style={styles.block}>
            <Text style={styles.heading}>アイコン</Text>
            <View style={styles.avatarGrid}>
              {AVATAR_PRESETS.map((a) => {
                const on = avatar === a.id;
                return (
                  <Pressable
                    key={a.id}
                    style={[styles.avatarCell, on && styles.avatarCellActive]}
                    onPress={() => { haptics.tap(); setAvatar(a.id); }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={`アイコン ${a.id}`}
                  >
                    <Text style={styles.avatarEmoji}>{a.emoji}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <SkyButton title="保存する" variant="primary" loading={saving} onPress={onSave} />
        </ScrollView>
      </SafeAreaView>
    </SkyScreen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 40, gap: 22 },
  lead: { color: color.textSub, fontSize: 14, lineHeight: 21 },
  block: { gap: 8 },
  heading: { color: colors.white, fontSize: 17, fontWeight: '700' },
  input: {
    minHeight: 52, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: color.glass, borderWidth: 1, borderColor: color.glassStroke,
    color: colors.white, fontSize: 17,
  },
  hint: { color: color.textSub, fontSize: 12, lineHeight: 18 },
  avatarGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  avatarCell: {
    minWidth: 56, minHeight: 56, alignItems: 'center', justifyContent: 'center',
    borderRadius: 16, backgroundColor: color.glass, borderWidth: 2, borderColor: color.glassStroke,
    paddingHorizontal: 8, paddingVertical: 8,
  },
  avatarCellActive: { borderColor: color.action, backgroundColor: 'rgba(255,214,10,0.14)' },
  avatarEmoji: { fontSize: 30 },
});
