import React from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SkyScreen } from '../theme/Background';
import { SkyButton } from '../components/SkyButton';
import { Icon } from '../components/Icon';
import { colors } from '../theme/colors';
import { color } from '../theme/tokens';
import { useSession } from '../store/sessionStore';
import { usePairs } from '../store/pairStore';
import type { ScreenProps } from '../navigation/types';

export default function RoleSelectScreen({ navigation }: ScreenProps<'RoleSelect'>) {
  const isJoining = useSession((s) => s.isJoining);
  const sessionId = useSession((s) => s.sessionId);
  const myRole = useSession((s) => s.myRole);
  const isSessionExpired = useSession((s) => s.isSessionExpired);
  const pendingInvitePairId = usePairs((s) => s.pendingInvitePairId);
  // E1（watcher-exit ADR P1）: 見守り画面を離れてもセッションは生きている。
  // 同一起動中に戻れる導線として復帰カードを出す（kill→再起動の自動復帰は Phase 3 実装済み）
  const hasActiveWatch = sessionId != null && myRole === 'watcher' && !isSessionExpired;

  // 届いた参加リンク（pendingJoinId）の処理はこの画面から App.tsx へ移した（H-3）。
  // この画面は復帰スタックの下に敷かれることがあり、そこで拾ってしまうと
  // ブロックの説明が誰にも見えないまま何も起きないように見えていた。
  // 進行状況（isJoining）とエラーは store 経由で受けるので、表示だけを残す。

  return (
    <SkyScreen>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          {/* ✦ は Thousand SKY の四芒星モチーフ。白×ピンクのアプリアイコンから
              最初に遷移してくる画面なので、ブランド記号側で色の橋を架ける */}
          <Text style={styles.title}>
            <Text style={styles.titleStar}>✦</Text> みまも <Text style={styles.titleStar}>✦</Text>
          </Text>
          {/* ストアのサブタイトル（docs/store-listing.md）と同一文。
              ストア→初回起動で同じ一文に出会う連続性をとる */}
          <Text style={styles.subtitle}>大切な人の帰り道を、そっと見守る</Text>
        </View>
        <View style={styles.moon}><Icon name="moon" size={96} /></View>
        <Text style={styles.question}>あなたは どちら？</Text>

        {hasActiveWatch && (
          <Pressable
            style={styles.resumeCard}
            onPress={() => navigation.navigate('WatcherTabs')}
            accessibilityRole="button"
            accessibilityLabel="見守り中のセッションにもどる"
          >
            <Icon name="watch" size={20} />
            <Text style={styles.resumeText}>見守り中のセッションにもどる</Text>
          </Pressable>
        )}

        <View style={styles.buttons}>
          {/* 白地×濃ローズ＝昼の世界（見守り側）の入口。押した先の見守りタブが
              白×ピンクなので、入口の色がそのまま行き先の予告になる。
              白地に白線アイコンは消えるので tint は必須。
              v3: 行き先は設定画面ではなく見守りホーム（タブ）。見守りを増やすのは
              ホームの「＋ 追加する」から。
              replace ではなく navigate なのは、この画面が届いた参加リンク
              （pendingJoinId）を処理する唯一の場所だから。replace で外すと、
              見守りタブを開いているあいだに届いた「歩く人」リンクが誰にも
              拾われなくなる。歩く側へは設定タブの「自分が歩く」からも入れる */}
          <SkyButton
            title="見守る"
            icon={<Icon name="watch" size={24} tint={color.dayGateInk} />}
            subtitle="大切な人の帰宅を見守る"
            variant="dayGate"
            height={70}
            onPress={() => navigation.navigate('WatcherTabs')}
          />
          <SkyButton
            title="歩く"
            icon={<Icon name="walk" size={24} />}
            subtitle="自分の安全を共有する"
            variant="primary"
            height={70}
            onPress={() => navigation.navigate('Start')}
          />
        </View>

        {isJoining && (
          <View style={styles.joining}>
            <ActivityIndicator color={colors.white} />
            <Text style={styles.joiningText}>セッションに参加中...</Text>
          </View>
        )}
        {/* 参加の失敗は App.tsx の共通ハンドラが Alert で出す（H-3）。ここにも
            出すと同じ文が二重になるので、進行中の表示だけを残す（L-4） */}

        {/* 恒久ペア（ADR P3 Stage 1）。v3 のタブIA移行までは、ここが入口。
            「だれとつながっているか」を役割選択と同じ階層に置くのは、
            見守られている側にも関係が常に見えている必要があるため（I-2 / I-3 の可視化） */}
        <Pressable
          style={styles.pairsCard}
          onPress={() => navigation.navigate('Pairs')}
          accessibilityRole="button"
          accessibilityLabel="つながり。招待・解除と、ペアからの見守り開始"
        >
          <Icon name="link" size={20} />
          <Text style={styles.pairsText}>つながり</Text>
          {pendingInvitePairId != null && <View style={styles.pairsDot} />}
        </Pressable>

        <View style={styles.footerRow}>
          <Pressable style={styles.history} onPress={() => navigation.navigate('History')}>
            <Icon name="clock" size={16} />
            <Text style={styles.historyText}>履歴</Text>
          </Pressable>
          <Pressable
            style={styles.history}
            onPress={() => navigation.navigate('Settings')}
            accessibilityRole="button"
            accessibilityLabel="このアプリについて（プライバシーポリシー・お問い合わせ）"
          >
            <Icon name="info" size={16} />
            <Text style={styles.historyText}>このアプリについて</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </SkyScreen>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 24 },
  header: { alignItems: 'center', gap: 8 },
  title: { fontSize: 32, fontWeight: '700', color: colors.white },
  titleStar: { color: color.brand },
  subtitle: { fontSize: 14, color: color.textSub },
  moon: {
    shadowColor: colors.yellow, shadowOpacity: 0.4, shadowRadius: 24, shadowOffset: { width: 0, height: 0 },
  },
  question: { fontSize: 16, color: color.textSub },
  buttons: { width: '100%', gap: 14 },
  joining: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  joiningText: { color: colors.white },
  footerRow: { flexDirection: 'row', gap: 10 },
  resumeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: 'rgba(255,214,10,0.6)',
    backgroundColor: 'rgba(255,214,10,0.12)',
  },
  resumeText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  pairsCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    minHeight: 44, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  pairsText: { color: color.textSub, fontSize: 15, fontWeight: '600' },
  pairsDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: color.action },
  history: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 18, paddingVertical: 10,
    backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 20,
  },
  historyText: { color: color.textSub, fontSize: 15, fontWeight: '500' },
});
