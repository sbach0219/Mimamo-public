import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { doc, getDoc } from '@react-native-firebase/firestore';
import { SkyScreen } from '../theme/Background';
import { SkyButton } from '../components/SkyButton';
import { Icon } from '../components/Icon';
import { colors } from '../theme/colors';
import { color } from '../theme/tokens';
import { db } from '../lib/firebase';
import { haptics } from '../lib/haptics';
import { useIsOnline } from '../lib/network';
import { avatarEmoji, parseAvatarId } from '../lib/avatars';
import { useSession } from '../store/sessionStore';
import { usePairs } from '../store/pairStore';
import type { ScreenProps } from '../navigation/types';

// ペア起点の「見守り依頼」を受ける画面（2026-08-26 決定①）。
//
// この画面が立っている間、位置は1点も流れていない。依頼はまだ walkerUid が空の
// 待機セッションで、rules も歩く人の位置書き込みを拒む。「はじめる」を押して
// はじめてセッションが動き出す——承諾＝歩く人の端末操作が開始条件、という
// 不変条件（ADR I-2）が、この画面の存在理由そのもの。
//
// 文言はひらがな中心。この画面を見るのは P-A（子ども）と P-B（高齢の歩く人）で、
// 判断は「はじめる」「ことわる」の2つだけに絞る。
export default function WatchRequestScreen({ navigation, route }: ScreenProps<'WatchRequest'>) {
  const { sessionId } = route.params;
  const online = useIsOnline();
  const joinSession = useSession((s) => s.joinSession);
  const isJoining = useSession((s) => s.isJoining);
  const pairs = usePairs((s) => s.pairs);

  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<{ pairId: string | null; estimatedMinutes: number } | null>(null);
  const [gone, setGone] = useState<string | null>(null);

  // セッションの取得は sessionId だけに依存させる（L-4）。ペアの購読は
  // スナップショットのたびに新しい配列を返すので、依存に混ぜると画面に居るあいだ
  // getDoc を撃ち続け、loading / gone が再判定されて表示がちらつく。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'sessions', sessionId));
        if (cancelled) return;
        const data = snap.exists() ? snap.data() ?? {} : null;
        if (!data) { setGone('このおさそいは 見つかりませんでした'); return; }
        if (data.status !== 'waiting') {
          setGone('このおさそいは もう おわっています');
          return;
        }
        setSession({
          pairId: typeof data.pairId === 'string' ? data.pairId : null,
          estimatedMinutes: typeof data.estimatedMinutes === 'number' ? data.estimatedMinutes : 20,
        });
      } catch {
        if (!cancelled) setGone('よみこめませんでした。つうしんを かくにんしてください');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  // 見守り手の呼び名・アイコンはペア文書の複製から取る。users は本人しか読めない
  // （E-2）ので、ここで相手の users を引く経路は存在しない。ペアの購読が遅れて
  // 届いても、この派生だけが更新されて表示が差し替わる。
  const pair = session?.pairId ? pairs.find((p) => p.id === session.pairId) : undefined;
  const request = session
    ? {
        watcherName: pair?.watcherDisplayName || '見守る人',
        watcherAvatar: parseAvatarId(pair?.watcherAvatar),
        estimatedMinutes: session.estimatedMinutes,
      }
    : null;

  const accept = async (replaceExisting = false) => {
    try {
      await joinSession(sessionId, { replaceExisting });
      haptics.success();
      const s = useSession.getState();
      navigation.replace(s.mode === 'sentinel' ? 'MainSentinel' : 'Main', {
        estimatedMinutes: s.estimatedMinutes,
      });
    } catch (e: any) {
      haptics.error();
      Alert.alert(
        'はじめられませんでした',
        e?.userFacing ? e.message : 'つうしんを かくにんして、もういちど おためしください。',
      );
    }
  };

  const onStart = () => {
    haptics.tap();
    // C-2: 生きたセッションを抱えたまま乗り替えると、前のものが幽霊になる
    if (useSession.getState().hasLiveSession()) {
      Alert.alert(
        'いまの みまもりを おわりますか？',
        'すすめると、いま すすんでいる みまもりは 見られなくなります。',
        [
          { text: 'やめる', style: 'cancel' },
          { text: 'すすめる', style: 'destructive', onPress: () => { accept(true); } },
        ],
      );
      return;
    }
    accept(false);
  };

  // 「ことわる」は依頼を消さない。見守り手の側では待機セッションとして残り、
  // 期限が来れば自然に切れる。断ったことをこちらから相手へ通知しないのは、
  // 「いま歩かない」を毎回説明させないため（歩く人が主役という設計の帰結）。
  const onDecline = () => {
    haptics.tap();
    navigation.goBack();
  };

  return (
    <SkyScreen>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        {loading ? (
          <ActivityIndicator color={colors.white} />
        ) : gone ? (
          <View style={styles.center}>
            <Icon name="info" size={40} opacity={0.7} />
            <Text style={styles.goneText}>{gone}</Text>
            <SkyButton title="とじる" variant="secondary" onPress={() => navigation.goBack()} />
          </View>
        ) : request ? (
          <View style={styles.center}>
            <Text style={styles.avatar}>{avatarEmoji(request.watcherAvatar)}</Text>
            <Text style={styles.title}>
              {request.watcherName}さんが{'\n'}みまもりたいと いっています
            </Text>
            <Text style={styles.body}>
              「はじめる」を おすと、{request.estimatedMinutes}分の みまもりが はじまります。{'\n'}
              いまの ばしょが つたわるのは、はじめてから おわるまでの あいだだけです。
            </Text>
            <Text style={styles.note}>
              おさなくても なにも おこりません。ばしょは まだ つたわっていません。
            </Text>

            <SkyButton
              title="はじめる"
              icon={<Icon name="walk" size={20} />}
              variant="primary"
              loading={isJoining}
              disabled={!online}
              onPress={onStart}
            />
            <Pressable
              style={styles.declineBtn}
              onPress={onDecline}
              accessibilityRole="button"
              accessibilityLabel="ことわる"
            >
              <Text style={styles.declineText}>ことわる</Text>
            </Pressable>
          </View>
        ) : null}
      </SafeAreaView>
    </SkyScreen>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  center: { gap: 16, alignItems: 'stretch' },
  avatar: { fontSize: 64, textAlign: 'center' },
  title: { color: colors.white, fontSize: 24, fontWeight: '800', textAlign: 'center', lineHeight: 36 },
  body: { color: color.textSub, fontSize: 16, lineHeight: 28, textAlign: 'center' },
  note: { color: color.textFaint, fontSize: 14, lineHeight: 24, textAlign: 'center' },
  goneText: { color: colors.white, fontSize: 18, lineHeight: 30, textAlign: 'center' },
  declineBtn: { minHeight: 52, justifyContent: 'center', alignItems: 'center' },
  declineText: { color: color.textSub, fontSize: 17, fontWeight: '700' },
});
