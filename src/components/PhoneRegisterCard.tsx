import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable } from 'react-native';
import { SkyButton } from './SkyButton';
import { Icon } from './Icon';
import type { ThemeColor } from '../theme/tokens';
import { useTheme, useThemedStyles } from '../theme/ThemeContext';
import { useSession } from '../store/sessionStore';
import { isPhonePromptDismissed, dismissPhonePrompt } from '../lib/watchPreferences';
import { haptics } from '../lib/haptics';

// 緊急連絡先（歩く人の電話番号）の任意登録。平時に一度だけ案内する（§4-D）。
// SOS のときに探させないための平時の仕込みであり、登録しなくても見守りは成立する。
// 保存に失敗した場合（rules 未反映など）は、電話の行が出ないだけに劣化させる。
export function PhoneRegisterCard() {
  const { color } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const walkerPhone = useSession((s) => s.walkerPhone);
  const saveWalkerPhone = useSession((s) => s.saveWalkerPhone);
  // 一度「あとで」を選んだら、次のセッションでも出さない（毎回聞かない）
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => { isPhonePromptDismissed().then(setDismissed); }, []);

  if (walkerPhone || dismissed !== false) return null;

  const save = async () => {
    setSaving(true);
    const ok = await saveWalkerPhone(value);
    setSaving(false);
    if (ok) {
      haptics.success();
      setOpen(false);
      return;
    }
    setFailed(true);
  };

  if (!open) {
    return (
      <View style={styles.card}>
        <View style={styles.row}>
          <Icon name="phone" size={20} />
          <Text style={styles.title}>緊急連絡先を登録しますか？</Text>
        </View>
        <Text style={styles.body}>
          歩く人の電話番号を登録しておくと、SOSのときにこの画面からすぐ電話できます。
          登録は任意で、あとから登録することもできます。
        </Text>
        <View style={styles.actions}>
          <SkyButton title="登録する" variant="watcher" onPress={() => setOpen(true)} style={{ flex: 1 }} />
          <Pressable
            style={styles.skip}
            onPress={() => { setDismissed(true); dismissPhonePrompt(); }}
            accessibilityRole="button"
            accessibilityLabel="緊急連絡先を登録しない"
          >
            <Text style={styles.skipText}>あとで</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Icon name="phone" size={20} />
        <Text style={styles.title}>歩く人の電話番号</Text>
      </View>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={(t) => { setValue(t); setFailed(false); }}
        keyboardType="phone-pad"
        placeholder="09012345678"
        placeholderTextColor={color.textFaint}
        maxLength={20}
        accessibilityLabel="歩く人の電話番号を入力"
      />
      <Text style={styles.note}>
        番号はこの見守りのあいだだけ保存され、見守りが終わって7日で消えます。
      </Text>
      {failed && (
        <Text style={styles.failed}>
          いまは保存できませんでした。通信を確認して、もう一度お試しください。
        </Text>
      )}
      <View style={styles.actions}>
        <SkyButton title="保存する" variant="watcher" loading={saving} onPress={save} style={{ flex: 1 }} />
        <Pressable style={styles.skip} onPress={() => setOpen(false)} accessibilityRole="button">
          <Text style={styles.skipText}>やめる</Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  card: {
    marginHorizontal: 16, padding: 16, borderRadius: 16, gap: 10,
    backgroundColor: c.glass, borderWidth: 1, borderColor: c.glassStroke,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '700', color: c.text },
  body: { fontSize: 14, lineHeight: 21, color: c.textSub },
  note: { fontSize: 12, lineHeight: 18, color: c.textSub },
  failed: { fontSize: 13, fontWeight: '600', color: c.dangerText },
  input: {
    minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12,
    fontSize: 17, color: c.text,
    backgroundColor: c.cardNavy, borderWidth: 1, borderColor: c.glassStroke,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  skip: { minHeight: 44, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  skipText: { fontSize: 15, fontWeight: '600', color: c.textSub },
});
