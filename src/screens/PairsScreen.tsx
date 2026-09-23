import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Share, Alert, ActivityIndicator, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { SkyScreen } from '../theme/Background';
import { SkyButton } from '../components/SkyButton';
import { Icon } from '../components/Icon';
import { colors } from '../theme/colors';
import { color, dim, radius } from '../theme/tokens';
import { haptics } from '../lib/haptics';
import { useIsOnline } from '../lib/network';
import { ensureNotificationPermission } from '../lib/notifications';
import { avatarEmoji } from '../lib/avatars';
import { pairInviteMessage, pairInviteUrl } from '../lib/pairLink';
import {
  MAX_DESTINATION_LABEL, MAX_WALKER_LABEL_NAME, canRevoke, canStartPairWalk,
  describeLastSession, normalizeWalkerLabel, partnerLabel, roleInPair, type Pair,
} from '../lib/pairs';
import { useProfile } from '../store/profileStore';
import { usePairs } from '../store/pairStore';
import { useEntitlement } from '../store/entitlementStore';
import { useSession } from '../store/sessionStore';
import type { ScreenProps } from '../navigation/types';

const MINUTE_PRESETS = [10, 15, 20, 30];

// 恒久ペアの一覧と、招待・受諾・解除・ペアからの歩行開始（ADR P3 Stage 1）。
//
// Stage 1 の UI は最小限にとどめる。タブIA（ホーム/ちず/メッセージ/設定）への移行は
// Stage 2 で、この画面の中身がホームタブの「見守り対象リスト」に育つ。
export default function PairsScreen({ navigation }: ScreenProps<'Pairs'>) {
  const online = useIsOnline();
  const uid = useSession((s) => s.uid);
  const profile = useProfile((s) => s.profile);
  const pairs = usePairs((s) => s.pairs);
  const pairsLoaded = usePairs((s) => s.pairsLoaded);
  const pendingInvitePairId = usePairs((s) => s.pendingInvitePairId);
  const isAccepting = usePairs((s) => s.isAccepting);
  const pairError = usePairs((s) => s.pairError);
  const createInvite = usePairs((s) => s.createInvite);
  const acceptInvite = usePairs((s) => s.acceptInvite);
  const fetchInvite = usePairs((s) => s.fetchInvite);
  const setPendingInvitePairId = usePairs((s) => s.setPendingInvitePairId);
  const revokePair = usePairs((s) => s.revokePair);
  const setWalkerLabel = usePairs((s) => s.setWalkerLabel);
  const clearPairError = usePairs((s) => s.clearPairError);
  const groupActive = useEntitlement((s) => s.isGroupActive());
  const canShowPaywall = useEntitlement((s) => s.canShowPaywall());

  const [inviteId, setInviteId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // ペアから歩き始めるときの入力。開いているペアのIDを持つ
  const [walkPairId, setWalkPairId] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(20);
  const [destination, setDestination] = useState('');
  // 相手の呼び名・年齢の編集（D-8）。開いているペアのIDと入力中の値を持つ
  const [labelPairId, setLabelPairId] = useState<string | null>(null);
  const [labelName, setLabelName] = useState('');
  const [labelAge, setLabelAge] = useState('');

  // 届いた招待の中身を、ボタンを出す前に読む（承諾画面と同じ密度に揃える）
  const [invitePreview, setInvitePreview] = useState<Pair | 'loading' | 'gone' | null>(null);

  useEffect(() => { clearPairError(); }, [clearPairError]);

  useEffect(() => {
    if (!pendingInvitePairId) { setInvitePreview(null); return; }
    let cancelled = false;
    setInvitePreview('loading');
    fetchInvite(pendingInvitePairId)
      .then((pair) => { if (!cancelled) setInvitePreview(pair ?? 'gone'); })
      .catch(() => { if (!cancelled) setInvitePreview('gone'); });
    return () => { cancelled = true; };
  }, [pendingInvitePairId, fetchInvite]);

  // 届いた招待は自動で受諾せず、必ず本人の操作を挟む（つながる同意の明示性）。
  const acceptPending = async () => {
    if (!pendingInvitePairId) return;
    try {
      await acceptInvite(pendingInvitePairId);
      haptics.success();
    } catch {
      haptics.error();
    }
  };

  const onCreateInvite = async () => {
    // 恒久ペアは有料機能（§2.5）。rules 側にも同じゲートがあるので、ここを
    // すり抜けても作成は失敗する。クライアント側で止めるのは、失敗を見せる前に
    // 「なぜできないか」を言うため。
    if (!groupActive) {
      haptics.tap();
      Alert.alert(
        'つながりは グループ機能です',
        canShowPaywall
          ? 'いちどつながると、毎回リンクを送らなくても見守りをおねがいできます。\nリンクを送る1回きりの見守りは、これまでどおり無料でつかえます。'
          : 'グループ機能は じゅんび中です。リンクを送る見守りは、これまでどおりつかえます。',
        canShowPaywall
          ? [
              { text: 'とじる', style: 'cancel' },
              { text: 'グループ機能を見る', onPress: () => navigation.navigate('Paywall') },
            ]
          : undefined,
      );
      return;
    }
    setCreating(true);
    try {
      // 招待した相手からの「つながりました」を受け取れるようにしておく
      await ensureNotificationPermission();
      const id = await createInvite();
      setInviteId(id);
      haptics.success();
    } catch {
      haptics.error();
      // 資格の反映待ちなら、そう言う（L-3）。「通信を確認して」は原因を誤らせる
      // ——実際にはお支払いは通っていて、サーバーがまだ追いついていないだけ。
      if (useEntitlement.getState().isAwaitingServerEntitlement()) {
        Alert.alert(
          'お支払いの反映を待っています',
          'すこし待ってから、もう一度お試しください。何度も出るときは、設定の「購入をもどす」をおしてください。',
        );
      } else {
        Alert.alert('つくれませんでした', '通信を確認して、もう一度お試しください。');
      }
    } finally {
      setCreating(false);
    }
  };

  const onShareInvite = async () => {
    if (!inviteId) return;
    await Share.share({ message: pairInviteMessage(inviteId, profile.displayName) });
  };

  const onRevoke = (pair: Pair) => {
    const who = partnerLabel(pair, uid ?? '');
    const live = useSession.getState();
    const hasLiveWithPair = live.pairId === pair.id && live.hasLiveSession();
    Alert.alert(
      'つながりを解除しますか？',
      `${who}とのつながりを解除します。`
      + (hasLiveWithPair ? '\n\nいま進行中の見守りも、その場で終わります。' : '\n\n進行中の見守りがあれば、その場で終わります。')
      + '\n\n解除したことは相手にも知らせます。もう一度つながるには、あたらしい招待が必要です。',
      [
        { text: 'やめる', style: 'cancel' },
        {
          text: '解除する',
          style: 'destructive',
          onPress: () => {
            revokePair(pair.id)
              .then(() => haptics.success())
              .catch(() => Alert.alert('解除できませんでした', '通信を確認して、もう一度お試しください。'));
          },
        },
      ],
    );
  };

  const openLabelForm = (pair: Pair) => {
    haptics.tap();
    setLabelPairId(pair.id);
    setLabelName(pair.walkerLabel?.name ?? '');
    setLabelAge(pair.walkerLabel?.age != null ? String(pair.walkerLabel.age) : '');
  };

  const onSaveLabel = async (pair: Pair) => {
    try {
      await setWalkerLabel(pair.id, normalizeWalkerLabel(labelName, labelAge));
      haptics.success();
      setLabelPairId(null);
    } catch (e: any) {
      haptics.error();
      Alert.alert('ほぞんできませんでした', e?.userFacing ? e.message : '通信を確認して、もう一度お試しください。');
    }
  };

  const onStartWalk = async (pair: Pair) => {
    const session = useSession.getState();
    const start = (replaceExisting: boolean) =>
      session
        .startPairWalk(pair, {
          estimatedMinutes: minutes,
          destinationLabel: destination,
          replaceExisting,
        })
        .then(() => {
          haptics.success();
          setWalkPairId(null);
          setDestination('');
          // Start 画面を経由しない（L-5）。ペア起点のセッションは作成した時点で
          // 既に status:'active' で、見守り手には「歩きはじめました」が飛んでいる。
          // ここで Start（まだ「スタート」を押す前の画面）に着地させると、
          // 位置送信が始まらないまま見守り手に「移動中」と見え、5分後に
          // 「通信が途絶えています」が飛ぶ。歩行画面まで一気に送って、
          // 作成と歩き始めのズレを無くす。
          const s = useSession.getState();
          navigation.navigate(s.mode === 'sentinel' ? 'MainSentinel' : 'Main', {
            estimatedMinutes: s.estimatedMinutes,
          });
        })
        .catch((e: any) => {
          haptics.error();
          Alert.alert('はじめられませんでした', e?.userFacing ? e.message : '通信を確認して、もう一度お試しください。');
        });

    // C-2: 生きたセッションを抱えたまま乗り替えると、旧セッションが幽霊になる
    if (session.hasLiveSession()) {
      Alert.alert(
        'いまの見守りを終わりますか？',
        'すすめると、いま進行中の見守りは見られなくなります。',
        [
          { text: 'やめる', style: 'cancel' },
          { text: 'すすめる', style: 'destructive', onPress: () => { start(true); } },
        ],
      );
      return;
    }
    await start(false);
  };

  const activeCount = pairs.filter((p) => p.status === 'active').length;

  return (
    <SkyScreen>
      <SafeAreaView style={{ flex: 1 }} edges={['bottom']}>
        <ScrollView contentContainerStyle={styles.content}>
          {/* 自分のプロフィール。相手に何が見えているかを、常に本人にも見せる */}
          <Pressable
            style={styles.meRow}
            onPress={() => navigation.navigate('Profile')}
            accessibilityRole="button"
            accessibilityLabel="よびなとアイコンを変える"
          >
            <Text style={styles.meAvatar}>{avatarEmoji(profile.avatar)}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.meName}>{profile.displayName || 'よびなを えらぶ'}</Text>
              <Text style={styles.meHint}>つながっている相手に見える、あなたの名前とアイコン</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>

          {/* 届いた招待。**誰からの招待かを見せてから**「つながる」を出す。
              恒久ペアは見守り依頼より重い（成立すると相手はいつでも依頼を送れ、
              こちらの呼び名・年齢を預かれる関係が続く）のに、承諾画面のほうが
              相手の顔を先に見せていて非対称だった。 */}
          {pendingInvitePairId && (
            <View style={styles.inviteBanner}>
              <Text style={styles.inviteBannerTitle}>見守りのお誘いが届いています</Text>
              {invitePreview === 'loading' ? (
                <ActivityIndicator color={colors.white} />
              ) : invitePreview === 'gone' ? (
                <>
                  <Text style={styles.inviteBannerBody}>
                    このお誘いは 見つかりませんでした。{'\n'}
                    期限が切れているか、取り消されたのかもしれません。
                  </Text>
                  <Pressable
                    style={styles.textBtn}
                    onPress={() => setPendingInvitePairId(null)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.textBtnLabel}>とじる</Text>
                  </Pressable>
                </>
              ) : invitePreview ? (
                <>
                  <View style={styles.inviteWho}>
                    <Text style={styles.cardAvatar}>{avatarEmoji(invitePreview.watcherAvatar)}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardName}>
                        {invitePreview.watcherDisplayName || '名前のない人'}
                      </Text>
                      <Text style={styles.cardRole}>この人が あなたを 見守ります</Text>
                    </View>
                  </View>
                  <Text style={styles.inviteBannerBody}>
                    知らない相手なら、つながらないでください。{'\n'}
                    つながると、次からはリンクなしで見守りをはじめられます。{'\n'}
                    位置がつたわるのは、あなたが「あるく」をおしたあいだだけです。
                  </Text>
                  {invitePreview.inviteExpiresAt && (
                    <Text style={styles.qrHint}>
                      このお誘いは {formatDeadline(invitePreview.inviteExpiresAt)} まで有効です。
                    </Text>
                  )}
                  <SkyButton
                    title="つながる"
                    variant="primary"
                    loading={isAccepting}
                    disabled={!online}
                    onPress={acceptPending}
                  />
                  <Pressable
                    style={styles.textBtn}
                    onPress={() => setPendingInvitePairId(null)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.textBtnLabel}>いまは つながらない</Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          )}
          {pairError && <Text style={styles.error}>{pairError}</Text>}

          <View style={styles.listHeader}>
            <Text style={styles.listTitle}>つながり</Text>
            <Pressable
              style={styles.addBtn}
              onPress={onCreateInvite}
              disabled={!online || creating}
              accessibilityRole="button"
              accessibilityLabel="あたらしい相手を招待する"
            >
              <Text style={styles.addBtnText}>＋ 追加する</Text>
            </Pressable>
          </View>

          {creating && <ActivityIndicator color={colors.white} />}

          {/* 作ったばかりの招待（QR とリンク） */}
          {inviteId && (
            <View style={styles.qrCard}>
              <Text style={styles.qrTitle}>相手のカメラで よみとってもらう</Text>
              <View style={styles.qrBox}>
                <QRCode value={pairInviteUrl(inviteId)} size={168} backgroundColor="#FFFFFF" color={color.qrFg} />
              </View>
              <Text style={styles.qrHint}>この招待は24時間で使えなくなります。1人だけがつながれます。</Text>
              <SkyButton
                title="はなれた相手にはリンクを送る"
                icon={<Icon name="share" size={18} tint={color.safeInk} />}
                variant="success"
                onPress={onShareInvite}
              />
              <Pressable style={styles.textBtn} onPress={() => setInviteId(null)} accessibilityRole="button">
                <Text style={styles.textBtnLabel}>とじる</Text>
              </Pressable>
            </View>
          )}

          {!pairsLoaded && <ActivityIndicator color={colors.white} />}
          {pairsLoaded && pairs.length === 0 && !inviteId && (
            <Text style={styles.empty}>
              まだ つながりがありません。{'\n'}
              「＋ 追加する」で相手を招待するか、届いたリンクをひらいてください。
            </Text>
          )}

          {pairs.map((pair) => {
            const myRole = roleInPair(pair, uid ?? '');
            const partner = partnerLabel(pair, uid ?? '');
            const lastLine = describeLastSession(pair.lastSessionSummary);
            const isMine = pair.createdByUid === uid;
            const showWalkForm = walkPairId === pair.id;
            return (
              <View key={pair.id} style={[styles.card, pair.status === 'revoked' && styles.cardMuted]}>
                <View style={styles.cardTop}>
                  <Text style={styles.cardAvatar}>
                    {avatarEmoji(myRole === 'watcher' ? pair.walkerAvatar : pair.watcherAvatar)}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardName}>{partner}</Text>
                    <Text style={styles.cardRole}>
                      {myRole === 'watcher' ? 'あなたが 見守ります' : 'あなたを 見守ります'}
                    </Text>
                  </View>
                  <StatusBadge pair={pair} />
                </View>

                {/* 相手が長期不達（I-5）。黙って放置せず、必ず画面に出す */}
                {pair.staleSince && pair.status === 'active' && (
                  <Text style={styles.stale}>
                    ⚠️ しばらく連絡が取れていません。端末が変わったのかもしれません。{'\n'}
                    もう一度招待してつなぎ直してください。
                  </Text>
                )}

                {lastLine && <Text style={styles.lastLine}>{lastLine}</Text>}

                {pair.status === 'invited' && isMine && (
                  <Text style={styles.cardHint}>相手が招待をひらくと、ここにつながりが出ます。</Text>
                )}

                {/* 相手の呼び名と年齢は見守る人だけが預かる（D-8 / §9）。
                    用途は「110番通報のときに口頭で伝える」1つだけなので、
                    そのことを入力欄のそばに書いておく（何に使うか分からない
                    個人情報を求めない） */}
                {myRole === 'watcher' && pair.status === 'active' && labelPairId !== pair.id && (
                  <Pressable
                    style={styles.labelRow}
                    onPress={() => openLabelForm(pair)}
                    accessibilityRole="button"
                    accessibilityLabel="この人のよびなと年齢をあずかる"
                  >
                    <Icon name="info" size={16} />
                    <Text style={styles.labelRowText}>
                      {pair.walkerLabel
                        ? `よびな: ${pair.walkerLabel.name || '（なし）'}${pair.walkerLabel.age != null ? ` ・ ${pair.walkerLabel.age}さい` : ''}`
                        : 'よびなと年齢をあずかる（任意）'}
                    </Text>
                    <Text style={styles.chevron}>›</Text>
                  </Pressable>
                )}

                {labelPairId === pair.id && (
                  <View style={styles.walkForm}>
                    <Text style={styles.formLabel}>よびな（任意）</Text>
                    <TextInput
                      style={styles.input}
                      value={labelName}
                      onChangeText={setLabelName}
                      placeholder="例: はるちゃん"
                      placeholderTextColor={color.textFaint}
                      maxLength={MAX_WALKER_LABEL_NAME}
                      accessibilityLabel="相手のよびな"
                    />
                    <Text style={styles.formLabel}>年齢（任意）</Text>
                    <TextInput
                      style={styles.input}
                      value={labelAge}
                      onChangeText={setLabelAge}
                      placeholder="例: 8"
                      placeholderTextColor={color.textFaint}
                      keyboardType="number-pad"
                      maxLength={3}
                      accessibilityLabel="相手の年齢"
                    />
                    <Text style={styles.formHint}>
                      110番通報のときに、あなたが口頭で伝えるためだけに使います。{'\n'}
                      つながりを解除すると、すぐに消えます。
                    </Text>
                    <SkyButton title="ほぞんする" variant="primary" disabled={!online} onPress={() => onSaveLabel(pair)} />
                    <Pressable style={styles.textBtn} onPress={() => setLabelPairId(null)} accessibilityRole="button">
                      <Text style={styles.textBtnLabel}>やめる</Text>
                    </Pressable>
                  </View>
                )}

                {/* 歩き始められるのは、このペアの「歩く人」だけ（I-2） */}
                {canStartPairWalk(pair, uid ?? '') && !showWalkForm && (
                  <SkyButton
                    title="この人に見守ってもらう"
                    icon={<Icon name="walk" size={18} />}
                    variant="primary"
                    disabled={!online}
                    onPress={() => { haptics.tap(); setWalkPairId(pair.id); }}
                  />
                )}

                {showWalkForm && (
                  <View style={styles.walkForm}>
                    <Text style={styles.formLabel}>帰るまでの めやすの時間</Text>
                    <View style={styles.presetRow}>
                      {MINUTE_PRESETS.map((m) => (
                        <Pressable
                          key={m}
                          style={[styles.presetBtn, minutes === m && styles.presetBtnActive]}
                          onPress={() => { haptics.tap(); setMinutes(m); }}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: minutes === m }}
                        >
                          <Text style={[styles.presetText, minutes === m && styles.presetTextActive]}>{m}分</Text>
                        </Pressable>
                      ))}
                    </View>
                    <Text style={styles.formLabel}>いくさき（任意）</Text>
                    <TextInput
                      style={styles.input}
                      value={destination}
                      onChangeText={setDestination}
                      placeholder="例: ひまわり学童保育室"
                      placeholderTextColor={color.textFaint}
                      maxLength={MAX_DESTINATION_LABEL}
                      accessibilityLabel="いくさきの名前"
                    />
                    <Text style={styles.formHint}>
                      入力した名前だけが記録に残ります。住所や地図の場所は残りません。
                    </Text>
                    <SkyButton
                      title="あるきはじめる"
                      variant="primary"
                      disabled={!online}
                      onPress={() => onStartWalk(pair)}
                    />
                    <Pressable style={styles.textBtn} onPress={() => setWalkPairId(null)} accessibilityRole="button">
                      <Text style={styles.textBtnLabel}>やめる</Text>
                    </Pressable>
                  </View>
                )}

                {/* 解除はどちらの側からも always 一歩で届く場所に置く（I-3） */}
                {(canRevoke(pair, uid ?? '') || (pair.status === 'invited' && isMine)) && (
                  <Pressable
                    style={styles.revokeBtn}
                    onPress={() => onRevoke(pair)}
                    accessibilityRole="button"
                    accessibilityLabel={pair.status === 'invited' ? '招待をとりけす' : 'つながりを解除する'}
                  >
                    <Icon name="warning" size={16} />
                    <Text style={styles.revokeText}>
                      {pair.status === 'invited' ? '招待をとりけす' : 'つながりを解除する'}
                    </Text>
                  </Pressable>
                )}
              </View>
            );
          })}

          <Text style={styles.footNote}>
            つながっていても、いまの場所がつたわるのは「あるきはじめる」をおしたあいだだけです。{'\n'}
            見守る人が、あなたの位置共有をはじめることはできません。
          </Text>
          {activeCount > 0 && (
            <Text style={styles.footNote}>いま {activeCount} 件のつながりがあります。</Text>
          )}
        </ScrollView>
      </SafeAreaView>
    </SkyScreen>
  );
}

// 招待の期限。「あと何時間」より、いつまでかを言い切るほうが誤解が少ない。
function formatDeadline(at: Date): string {
  const h = at.getHours();
  const m = at.getMinutes();
  return `${at.getMonth() + 1}月${at.getDate()}日 ${h}時${m.toString().padStart(2, '0')}分`;
}

// 状態バッジ。色だけに意味を載せない（文言と併記する）。
function StatusBadge({ pair }: { pair: Pair }) {
  const map = {
    invited: { label: '招待中', tone: color.caution },
    active: { label: 'つながっています', tone: color.safe },
    revoked: { label: '解除ずみ', tone: color.textFaint },
  } as const;
  const { label, tone } = map[pair.status];
  return (
    <View style={[styles.badge, { borderColor: tone, backgroundColor: dim(colors.white, 0.06) }]}>
      <Text style={[styles.badgeText, { color: tone }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40, gap: 16 },

  meRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    minHeight: 64, paddingHorizontal: 16, paddingVertical: 12, borderRadius: radius.card,
    backgroundColor: color.glass, borderWidth: 1, borderColor: color.glassStroke,
  },
  meAvatar: { fontSize: 32 },
  meName: { color: colors.white, fontSize: 17, fontWeight: '700' },
  meHint: { color: color.textSub, fontSize: 12, lineHeight: 18, marginTop: 2 },
  chevron: { color: color.textSub, fontSize: 26, fontWeight: '700' },

  inviteBanner: {
    gap: 10, padding: 16, borderRadius: radius.card,
    backgroundColor: 'rgba(255,214,10,0.12)', borderWidth: 1.5, borderColor: color.action,
  },
  inviteBannerTitle: { color: colors.white, fontSize: 17, fontWeight: '800' },
  inviteWho: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  inviteBannerBody: { color: color.textSub, fontSize: 13, lineHeight: 20 },
  error: { color: color.dangerText, fontSize: 13, lineHeight: 20 },

  listHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  listTitle: { flex: 1, color: colors.white, fontSize: 20, fontWeight: '700' },
  addBtn: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 999,
    backgroundColor: dim(colors.white, 0.12), borderWidth: 1, borderColor: color.glassStroke,
  },
  addBtnText: { color: color.action, fontSize: 15, fontWeight: '700' },

  qrCard: {
    alignItems: 'center', gap: 12, padding: 16, borderRadius: radius.card,
    backgroundColor: color.glass, borderWidth: 1, borderColor: color.glassStroke,
  },
  qrTitle: { color: colors.white, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  // QR の地は読み取り信頼性のため白固定
  qrBox: { padding: 14, borderRadius: radius.card, backgroundColor: '#FFFFFF' },
  qrHint: { color: color.textSub, fontSize: 12, lineHeight: 18, textAlign: 'center' },

  empty: { color: color.textSub, fontSize: 14, lineHeight: 22, textAlign: 'center', paddingVertical: 12 },

  card: {
    gap: 10, padding: 16, borderRadius: radius.card,
    backgroundColor: color.glass, borderWidth: 1, borderColor: color.glassStroke,
  },
  cardMuted: { opacity: 0.55 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  cardAvatar: { fontSize: 34 },
  cardName: { color: colors.white, fontSize: 18, fontWeight: '800' },
  cardRole: { color: color.textSub, fontSize: 12, marginTop: 2 },
  cardHint: { color: color.textSub, fontSize: 13, lineHeight: 20 },
  lastLine: { color: color.textSub, fontSize: 13, lineHeight: 20 },
  labelRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    minHeight: 44, paddingHorizontal: 12, borderRadius: 12,
    backgroundColor: dim(colors.white, 0.06), borderWidth: 1, borderColor: color.glassStroke,
  },
  labelRowText: { flex: 1, color: color.textSub, fontSize: 13, lineHeight: 19 },
  stale: { color: color.caution, fontSize: 13, lineHeight: 20 },

  badge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1.5 },
  badgeText: { fontSize: 12, fontWeight: '800' },

  walkForm: { gap: 10 },
  formLabel: { color: colors.white, fontSize: 15, fontWeight: '700' },
  formHint: { color: color.textSub, fontSize: 12, lineHeight: 18 },
  presetRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  presetBtn: {
    flexGrow: 1, minWidth: 64, minHeight: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: 12, backgroundColor: color.raised,
  },
  presetBtnActive: { backgroundColor: color.action },
  presetText: { color: colors.white, fontSize: 15, fontWeight: '700' },
  presetTextActive: { color: color.actionInk },
  input: {
    minHeight: 48, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: dim(colors.white, 0.08), borderWidth: 1, borderColor: color.glassStroke,
    color: colors.white, fontSize: 16,
  },

  revokeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    minHeight: 44, paddingHorizontal: 14, borderRadius: 12,
    borderWidth: 1, borderColor: dim(colors.white, 0.25),
  },
  revokeText: { color: color.dangerText, fontSize: 14, fontWeight: '700' },

  textBtn: { minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  textBtnLabel: { color: color.textSub, fontSize: 15, fontWeight: '600' },

  footNote: { color: color.textSub, fontSize: 12, lineHeight: 19 },
});
