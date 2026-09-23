import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SkyScreen } from '../theme/Background';
import { SkyButton } from '../components/SkyButton';
import { GlassCard } from '../components/GlassCard';
import { ConnectionPill } from '../components/ConnectionPill';
import { Icon } from '../components/Icon';
import { Glow } from '../components/Glow';
import { colors, dim } from '../theme/colors';
import { color, font, space } from '../theme/tokens';
import { useIsOnline } from '../lib/network';
import { ensureNotificationPermission } from '../lib/notifications';
import { useSession } from '../store/sessionStore';
import { canStartWalk } from '../lib/walkGate';
import { SENSITIVITY_LABEL } from '../lib/sentinel';
import type { ScreenProps } from '../navigation/types';

// 歩く人のゲート画面。参加状態で2つの表示に分かれる（docs/solo-walk-design.md）。
// - 参加済み: 開始確認（モード・目安時間・スタート）
// - 未参加: 参加ガイド。スタートボタンは描画しない
export default function StartScreen({ navigation }: ScreenProps<'Start'>) {
  const online = useIsOnline();
  const sessionId = useSession((s) => s.sessionId);
  const myRole = useSession((s) => s.myRole);
  const status = useSession((s) => s.status);
  const estimatedMinutes = useSession((s) => s.estimatedMinutes);
  const mode = useSession((s) => s.mode);
  const sensitivity = useSession((s) => s.sentinelSensitivity);
  const walkerPhone = useSession((s) => s.walkerPhone);
  const isJoining = useSession((s) => s.isJoining);

  const joined = canStartWalk(sessionId, myRole, status);

  useEffect(() => {
    // 通知許可は「これから歩き始める人」にだけ尋ねる
    if (joined) ensureNotificationPermission();
  }, [joined]);

  if (!joined) {
    return (
      <SkyScreen>
        <SafeAreaView style={styles.safe}>
          <MoonMark />
          {/* この画面に来るのは「リンクをもらう前にひらいてしまった人」。
              否定形の見出しで迎えず、次の一歩を番号で示す */}
          <View style={styles.titleBlock}>
            <Text style={styles.title}>見守りと つながろう</Text>
          </View>
          <View style={styles.steps}>
            <StepRow num="1" text={'見守る人に リンクか\nQRコードを つくってもらう'} />
            <StepRow num="2" text={'とどいたリンクを ひらく\nまたは カメラで QRを うつす'} />
          </View>

          {isJoining && (
            <View style={styles.joining}>
              <ActivityIndicator color={colors.white} />
              <Text style={styles.joiningText}>セッションに参加中...</Text>
            </View>
          )}
          {/* 参加の失敗は App.tsx の共通ハンドラが Alert で出す（H-3）。ここにも
              出すと同じ文が二重になる（L-4） */}
          {!online && (
            <Text style={styles.hint}>
              インターネットにつながっていません。{'\n'}つながるには 通信が ひつようです。
            </Text>
          )}

          {/* RoleSelect の「見守る」と同じ役割ゲートなので、色も揃える */}
          <SkyButton
            title="見守る人になる"
            variant="dayGate"
            style={{ width: 240 }}
            onPress={() => navigation.navigate('WatcherSetup')}
          />
        </SafeAreaView>
      </SkyScreen>
    );
  }

  return (
    <SkyScreen>
      <SafeAreaView style={styles.safe}>
        <ConnectionPill state={online ? 'online' : 'offline'} />
        <MoonMark />
        <View style={styles.titleBlock}>
          <Text style={styles.title}>見守りを開始</Text>
          <Text style={styles.caption}>見守る人が設定した時間です</Text>
        </View>

        {/* 見守り方（モード・感度）を歩く人にも見せて、次の画面の心構えができるように */}
        <View style={styles.modePill}>
          <Text style={styles.modePillText}>
            {mode === 'sentinel'
              ? `🛡️ AIおまかせ見守り（感度 ${SENSITIVITY_LABEL[sensitivity]}）`
              : '👆 おまもりボタンで見守り'}
          </Text>
        </View>
        {/* 歩き始める前に知っていればよい情報なので、歩行中の画面ではなくここで伝える */}
        {walkerPhone && (
          <Text style={styles.phoneNote}>☎️ きんきゅうれんらくさきは とうろくずみ</Text>
        )}

        <View style={styles.timeBlock}>
          <Text style={styles.label}>帰宅までの目安時間</Text>
          <GlassCard style={styles.timeCard}>
            <Text style={styles.timeText}>{estimatedMinutes} 分</Text>
          </GlassCard>
          <Text style={styles.hint}>変更したい場合は見守る人に{'\n'}相談してください</Text>
        </View>

        <SkyButton
          title="スタート"
          variant="primary"
          style={{ width: 240 }}
          onPress={() => {
            // 「スタートが無反応」の再発時に、押下が JS まで届いていたのかを切り分ける
            // 1行。__DEV__ で囲まないのは、この症状が出るのが実機・シミュレータの
            // リリースビルドで、そこに出ないログでは切り分けの役に立たないため。
            // 続きは歩行画面側の「セッション未参加のため歩行画面に入れません」を見る。
            console.warn(`[start] press mode=${mode} session=${sessionId != null} role=${myRole} status=${status}`);
            if (mode === 'sentinel') navigation.navigate('MainSentinel', { estimatedMinutes });
            else navigation.navigate('Main', { estimatedMinutes });
          }}
        />
      </SafeAreaView>
    </SkyScreen>
  );
}

// 月の背後の光。iOS の shadow は Android で色がつかないので Svg で描く
function MoonMark() {
  return (
    <View style={styles.moonWrap}>
      <Glow size={96} color={color.action} opacity={0.25} />
      <Icon name="moon" size={96} />
    </View>
  );
}

// 見守り設定側の手順表示（WatcherSetupScreen の StepRow）と同じ形にそろえる
function StepRow({ num, text }: { num: string; text: string }) {
  return (
    <View style={styles.stepRow}>
      <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>{num}</Text></View>
      <Text style={styles.stepRowText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl, gap: space.lg },
  moonWrap: { alignItems: 'center', justifyContent: 'center' },
  titleBlock: { alignItems: 'center', gap: 6 },
  steps: { alignSelf: 'stretch', gap: 14 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: color.action, alignItems: 'center', justifyContent: 'center' },
  stepBadgeText: { color: color.actionInk, fontWeight: '800' },
  stepRowText: { flex: 1, color: colors.white, fontSize: 15, fontWeight: '600', lineHeight: 22 },
  title: { fontSize: 28, fontWeight: '700', color: colors.white, textAlign: 'center' },
  caption: { fontSize: font.body, color: color.textSub },
  phoneNote: { fontSize: font.caption, color: color.textSub, textAlign: 'center' },
  joining: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  joiningText: { color: colors.white },
  modePill: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999,
    backgroundColor: dim(colors.sky, 0.15), borderWidth: 1, borderColor: dim(colors.sky, 0.4),
  },
  modePillText: { fontSize: 14, fontWeight: '600', color: colors.skyDeep },
  timeBlock: { alignItems: 'center', gap: 12 },
  label: { fontSize: font.sub, fontWeight: '600', color: color.text },
  timeCard: { paddingHorizontal: 40, paddingVertical: 20, alignItems: 'center', minWidth: 180 },
  timeText: { fontSize: 52, fontWeight: '700', color: colors.white },
  hint: { fontSize: font.caption, color: color.textSub, textAlign: 'center' },
});
