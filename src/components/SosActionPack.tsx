import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Linking, Share, Alert } from 'react-native';
import { Icon, type IconName } from './Icon';
import type { ThemeColor } from '../theme/tokens';
import { useTheme, useThemedStyles } from '../theme/ThemeContext';
import { haptics } from '../lib/haptics';

// SOS を受け取った見守り手が「次に何をすればよいか」を迷わないための行動パッケージ。
// 確定仕様（persona-ux-final-proposal §0-Q3 / §4-D）:
// - 初期視野の行動は2つまで。残りは「ほかにできること」で展開する
// - サイレントSOS のときは「本人に電話」を第1段に置かない（音が鳴って本人を危険にさらす）
// - 1行1アクション・minHeight 56・動詞先頭・赤ベタは「110に通報する」だけ
// - 電話番号が未登録なら電話行は行ごと出さない（灰色の無効行を置かない）
export type SosAction = {
  key: string;
  label: string;
  note?: string;
  icon: IconName;
  tone: 'danger' | 'plain';
  onPress: () => void;
};

export function SosActionPack({
  silent,
  phone,
  address,
  onChat,
  onShare,
  onSafetyCheck,
}: {
  silent: boolean;
  phone: string | null;
  address: string | null;
  onChat: () => void;
  onShare: () => void;
  // 「誤検知・解決した」の代替（D-7 / §5.1）。SOS の解除は本人にしかできないので、
  // 見守り側からできるのは「だいじょうぶ？」と聞くことまで。第1段の2枠は
  // 電話・110 で埋まっているため、渡されたときは必ず展開側に置く。
  onSafetyCheck?: () => void;
}) {
  const { color } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [expanded, setExpanded] = useState(false);

  const call = (number: string) => {
    haptics.heavy();
    Linking.openURL(`tel:${number}`).catch(() => {
      Alert.alert('電話をかけられませんでした', 'お使いの端末から発信できませんでした。番号を手で入力してください。');
    });
  };

  const callWalker: SosAction | null = phone
    ? {
        key: 'call-walker',
        label: '本人に電話する',
        note: silent ? '音が鳴ります' : undefined,
        icon: 'phone',
        tone: 'plain',
        onPress: () => call(phone),
      }
    : null;
  const call110: SosAction = {
    key: 'call-110',
    label: '110に通報する',
    note: address ? '場所は下の住所を伝えてください' : undefined,
    icon: 'sos',
    tone: 'danger',
    onPress: () => call('110'),
  };
  const chat: SosAction = {
    key: 'chat',
    label: silent ? 'チャットで「だいじょうぶ？」と聞く' : 'チャットで聞く',
    icon: 'chat',
    tone: 'plain',
    onPress: onChat,
  };
  const tellFamily: SosAction = {
    key: 'share',
    label: '家族に知らせる',
    icon: 'share',
    tone: 'plain',
    onPress: onShare,
  };

  const safetyCheck: SosAction | null = onSafetyCheck
    ? {
        key: 'safety-check',
        label: '本人に「だいじょうぶ？」を送る',
        note: '本人が「だいじょうぶ」と答えるとSOSが解除されます',
        icon: 'bell',
        tone: 'plain',
        onPress: () => { haptics.heavy(); onSafetyCheck(); },
      }
    : null;

  // 状態別の順序（§0-Q3 のマトリクス）
  const first: SosAction[] = silent
    ? [chat, call110]
    : callWalker
      ? [callWalker, call110]
      : [call110, chat];
  const rest: SosAction[] = (silent
    ? [callWalker, tellFamily, safetyCheck]
    : callWalker
      ? [tellFamily, chat, safetyCheck]
      : [tellFamily, safetyCheck]
  ).filter((a): a is SosAction => a != null);

  return (
    <View style={styles.wrap}>
      {first.map((a) => <ActionRow key={a.key} action={a} styles={styles} color={color} />)}

      {rest.length > 0 && (
        <>
          {expanded && rest.map((a) => <ActionRow key={a.key} action={a} styles={styles} color={color} />)}
          <Pressable
            style={styles.moreBtn}
            onPress={() => setExpanded((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
          >
            <Text style={styles.moreText}>{expanded ? 'とじる' : 'ほかにできること'}</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

function ActionRow({ action, styles, color }: {
  action: SosAction;
  styles: ReturnType<typeof makeStyles>;
  color: ThemeColor;
}) {
  const danger = action.tone === 'danger';
  return (
    <Pressable
      style={[styles.row, danger && styles.rowDanger]}
      onPress={action.onPress}
      accessibilityRole="button"
      accessibilityLabel={action.note ? `${action.label}。${action.note}` : action.label}
    >
      <Icon name={action.icon} size={22} tint={danger ? color.white : undefined} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, danger && styles.rowLabelDanger]}>{action.label}</Text>
        {action.note ? (
          <Text style={[styles.rowNote, danger && styles.rowNoteDanger]}>{action.note}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  wrap: { marginHorizontal: 16, gap: 10 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    minHeight: 56, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 16,
    backgroundColor: c.cardNavy, borderWidth: 1.5, borderColor: c.glassStroke,
  },
  // 赤ベタは110通報だけ。色に頼らずアイコンと文言も添える（危険色の3点セット）
  rowDanger: { backgroundColor: c.danger, borderColor: c.danger },
  rowLabel: { fontSize: 17, fontWeight: '700', color: c.text },
  rowLabelDanger: { color: c.white },
  rowNote: { fontSize: 13, color: c.textSub, marginTop: 2 },
  rowNoteDanger: { color: c.white, opacity: 0.9 },
  moreBtn: {
    minHeight: 44, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 10, borderRadius: 999, backgroundColor: c.raised, borderWidth: 1, borderColor: c.raisedStroke,
  },
  moreText: { fontSize: 15, fontWeight: '700', color: c.text },
});
