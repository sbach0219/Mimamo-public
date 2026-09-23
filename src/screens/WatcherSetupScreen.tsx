import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Share, Alert, Linking, Animated, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { SkyScreen } from '../theme/Background';
import { SkyButton } from '../components/SkyButton';
import { GlassCard } from '../components/GlassCard';
import { ConnectionPill } from '../components/ConnectionPill';
import { Icon, type IconName } from '../components/Icon';
import { dim, radius, type ThemeColor } from '../theme/tokens';
import { useTheme, useThemedStyles, withTheme } from '../theme/ThemeContext';
import { haptics } from '../lib/haptics';
import { useIsOnline } from '../lib/network';
import { ensureNotificationPermission } from '../lib/notifications';
import { addFavorite } from '../lib/favorites';
import { inviteMessage, inviteUrl } from '../lib/inviteLink';
import {
  loadWatchPreferences, saveWatchPreferences, describeWatchPreferences, type WatchPreferences,
} from '../lib/watchPreferences';
import { useSession, normalizeWalkerName, WALKER_NAME_MAX, type Coord, type WatchMode } from '../store/sessionStore';
import type { SentinelSensitivity, TransportMode } from '../lib/sentinel';
import { HomeLocationPicker } from '../components/HomeLocationPicker';
import type { ScreenProps } from '../navigation/types';

const PRESETS = [10, 15, 20, 30];

const SENSITIVITY_OPTIONS: { value: SentinelSensitivity; label: string; hint: string }[] = [
  { value: 'low', label: '低', hint: 'ゆっくり休みながら歩く方に' },
  { value: 'medium', label: '中', hint: 'ふつうの散歩・帰り道に' },
  { value: 'high', label: '高', hint: '心配なとき・見逃したくないときに' },
];

// 第1問は「きょうは どんな道ですか？」を聞く（2026-08 オーナー決定:
// 製品定義=「短期間型の位置共有 × AI異変検知」。ふだんの道は AI がそっと見守り、
// 不安な道のときだけ画面に手を置く、という2段構えを選択肢そのものが語る）。
// モード名の比較検討をさせない方針（F-7）は維持し、第3の導線（自分で選ぶ）も残す。
type Persona = 'usual' | 'uneasy' | 'other';
const PERSONA_OPTIONS: { value: Persona; emoji: string; label: string; desc: string; mode: WatchMode | null }[] = [
  {
    value: 'usual',
    emoji: '🌤️',
    label: 'いつもの道',
    desc: 'ボタン操作はいりません。AIがそっと見守り、いつもと違うと感じたら、まず本人に確認します。',
    mode: 'sentinel',
  },
  {
    value: 'uneasy',
    emoji: '🌙',
    label: 'ちょっと不安な道',
    desc: '画面を押しながら歩きます。指がはなれて返事がなければ、すぐお知らせ。',
    mode: 'hold',
  },
  { value: 'other', emoji: '🚶', label: 'そのほか', desc: '見守り方を自分で選びます。', mode: null },
];

const TRANSPORT_OPTIONS: { value: TransportMode; label: string; desc: string }[] = [
  { value: 'vehicle_ok', label: 'バス・電車・車も使う', desc: '乗り物での移動を異常としません' },
  { value: 'walk', label: '歩きだけ', desc: '乗り物の速さで動いたら、すぐお知らせします。道のない場所に入り続けたときもお知らせします' },
];

// 選択したカードの中身だけを開く。驚かせないよう 150ms でそっと出す
function Collapsible({ open, children }: { open: boolean; children: React.ReactNode }) {
  const anim = useRef(new Animated.Value(open ? 1 : 0)).current;
  // 閉じるときも 150ms かけて消す。開くときだけアニメーションして閉じるときは
  // 瞬時に消える、という非対称は「操作を取り消された」ように見える
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
    Animated.timing(anim, { toValue: open ? 1 : 0, duration: 150, useNativeDriver: true })
      .start(({ finished }) => { if (finished && !open) setMounted(false); });
  }, [open, anim]);
  if (!mounted) return null;
  // alignItems:'center' の親（ScrollView の content）に置かれると、幅指定が無い
  // このラッパーが内容幅まで縮み、中の行が1文字ずつ折り返す。必ず幅いっぱいに広げる
  return <Animated.View style={{ opacity: anim, alignSelf: 'stretch', width: '100%' }}>{children}</Animated.View>;
}

function WatcherSetupScreen({ navigation }: ScreenProps<'WatcherSetup'>) {
  const { color } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const online = useIsOnline();
  const createSession = useSession((s) => s.createSession);
  const saveWalkerPhone = useSession((s) => s.saveWalkerPhone);
  const [minutes, setMinutes] = useState(10);
  // 相手の呼び名（任意）。ホーム・ちず・SOS画面の見出しになる
  const [walkerName, setWalkerName] = useState('');
  const [persona, setPersona] = useState<Persona | null>(null);
  // 既定はセンチネル（ふだんの道）。ホールドは「不安な道」の明示選択で入る
  const [mode, setMode] = useState<WatchMode>('sentinel');
  const [sensitivity, setSensitivity] = useState<SentinelSensitivity>('medium');
  const [transport, setTransport] = useState<TransportMode>('vehicle_ok');
  const [home, setHome] = useState<Coord | null>(null);
  const [isCreating, setCreating] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [prefs, setPrefs] = useState<WatchPreferences | null>(null);
  // 見守り側が通知を拒否していると SOS 等の全プッシュに気づけない（製品価値ほぼ喪失）。
  // 開始はブロックしないが、リンク作成時に一度だけ警告する（設計書 決定E）。
  const [notificationsGranted, setNotificationsGranted] = useState<boolean | null>(null);

  useEffect(() => { ensureNotificationPermission().then(setNotificationsGranted); }, []);
  useEffect(() => {
    loadWatchPreferences().then((p) => {
      setPrefs(p);
      // 前回と同じ相手を見守ることが多いので、呼び名は初期値として入れておく
      if (p?.walkerName) setWalkerName(p.walkerName);
    });
  }, []);

  // C-2: 生きたセッションを抱えたまま新しい見守りを作ると、store の状態が黙って
  // 乗り替わり、旧セッションは activeWatch を上書きされて幽霊化する。
  // 前提そのものの解消（複数セッション購読）は v3 Phase 1 の store 改修に委ね、
  // ここでは「黙って乗り替えない」ことだけを保証する。
  const guardLiveSession = (run: (replaceExisting: boolean) => void) => {
    if (!useSession.getState().hasLiveSession()) {
      run(false);
      return;
    }
    // v3 では見守りは複数持てて、画面（器）が1件しか開けないだけ。進行中の見守りは
    // サーバー上でも activeWatches でも生き続け、ホームのリストにも残る。
    // 「見られなくなります」は事実に反する（M-2）ので、起きることだけを言う。
    Alert.alert(
      '表示を切り替えます',
      'あたらしい見守りの画面に切り替わります。いまの見守りは そのまま つづきます（ホームのリストから いつでも ひらけます）。',
      [
        { text: 'やめる', style: 'cancel' },
        { text: 'すすめる', onPress: () => run(true) },
      ],
    );
  };

  const create = async (override?: Partial<WatchPreferences>, replaceExisting = false) => {
    const p = {
      minutes: override?.minutes ?? minutes,
      mode: override?.mode ?? mode,
      sensitivity: override?.sensitivity ?? sensitivity,
      transport: override?.transport ?? transport,
      // 前回の緊急連絡先は、まえと同じ設定でなくても引き継ぐ（毎回入れ直させない）
      walkerPhone: override?.walkerPhone ?? prefs?.walkerPhone,
      walkerName: normalizeWalkerName(override?.walkerName ?? walkerName) ?? undefined,
    };
    setCreating(true);
    try {
      const id = await createSession(p.minutes, home, p.mode, p.sensitivity, p.transport, p.walkerName ?? null, { replaceExisting });
      const link = inviteUrl(id);
      if (__DEV__) console.log('[Mimamo] share link =', link);
      setShareLink(link);
      setSessionId(id);
      setMinutes(p.minutes);
      setMode(p.mode);
      setSensitivity(p.sensitivity);
      setTransport(p.transport);
      // 相手の呼び名は端末内の履歴ラベルには入れない。消す手段のある置き場を
      // watchPreferences の1箇所に絞る（M-4）
      await addFavorite(id, `${p.minutes}分の見守り`);
      // 次回のために覚えておく（R-4）。電話番号も引き継ぎ対象
      await saveWatchPreferences({
        minutes: p.minutes, mode: p.mode, sensitivity: p.sensitivity, transport: p.transport,
        hasHome: home != null, walkerPhone: p.walkerPhone, walkerName: p.walkerName,
      });
      // 前回の緊急連絡先があれば、この見守りにも引き継ぐ（失敗しても見守りは成立する）
      if (p.walkerPhone) saveWalkerPhone(p.walkerPhone).catch(() => {});
      haptics.success();
    } catch {
      haptics.error();
      Alert.alert('エラー', 'リンクの作成に失敗しました。\n通信状況を確認して、もう一度お試しください。');
    } finally {
      setCreating(false);
    }
  };

  const guardNotifications = (run: () => void) => {
    if (notificationsGranted === false) {
      Alert.alert(
        '通知が許可されていません',
        'このままだと、SOSや緊急アラートに気づけないおそれがあります。設定アプリで通知を許可することをおすすめします。',
        [
          { text: '通知設定を開く', onPress: () => Linking.openSettings() },
          { text: 'このまま続ける', onPress: run },
        ]
      );
      return;
    }
    run();
  };

  const handleCreatePress = () =>
    guardNotifications(() => guardLiveSession((replace) => { create(undefined, replace); }));
  const handleReusePress = () => {
    if (!prefs) return;
    haptics.tap();
    guardNotifications(() => guardLiveSession((replace) => { create(prefs, replace); }));
  };

  const share = async () => {
    if (sessionId) await Share.share({ message: inviteMessage(sessionId, minutes) });
  };

  const choosePersona = (p: Persona) => {
    haptics.tap();
    setPersona(p);
    const preset = PERSONA_OPTIONS.find((o) => o.value === p);
    if (preset?.mode) setMode(preset.mode);
  };

  return (
    <SkyScreen>
      <SafeAreaView style={{ flex: 1 }} edges={['bottom']}>
        <ScrollView contentContainerStyle={styles.content}>
          <ConnectionPill state={online ? 'online' : 'offline'} />

          {!shareLink && (
            <>
              <Icon name="watch" size={56} />
              <Text style={styles.title}>見守り設定</Text>

              {/* 第0階層: 前回と同じ設定でそのまま作る（毎日つかう人の最短経路） */}
              {prefs && (
                <Pressable
                  style={styles.reuseCard}
                  onPress={handleReusePress}
                  disabled={!online || isCreating}
                  accessibilityRole="button"
                  accessibilityLabel={`まえと同じ設定でつくる。${describeWatchPreferences(prefs)}`}
                >
                  <Icon name="clock" size={24} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.reuseTitle}>まえと同じ設定でつくる</Text>
                    <Text style={styles.reuseDesc}>
                      {describeWatchPreferences({ ...prefs, hasHome: prefs.hasHome })}
                      {prefs.walkerPhone ? '・電話番号あり' : ''}
                    </Text>
                  </View>
                  <Text style={styles.reuseArrow}>›</Text>
                </Pressable>
              )}

              {/* 第1問: モードではなく「道」を聞く（2段構えコンセプト） */}
              <View style={styles.block}>
                <Text style={styles.heading}>きょうは どんな道ですか？</Text>
                {PERSONA_OPTIONS.map((o) => {
                  const active = persona === o.value;
                  return (
                    <Pressable
                      key={o.value}
                      style={[styles.personaCard, active && styles.personaCardActive]}
                      onPress={() => choosePersona(o.value)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`${o.label}。${o.desc}`}
                    >
                      <View style={styles.personaRow}>
                        <Text style={styles.personaEmoji}>{o.emoji}</Text>
                        <Text style={[styles.personaLabel, active && styles.personaLabelActive]}>{o.label}</Text>
                        <View style={[styles.radio, active && styles.radioActive]}>
                          {active && <Text style={styles.radioDot}>✓</Text>}
                        </View>
                      </View>
                      <Text style={styles.personaDesc}>{o.desc}</Text>

                      {/* 選んだカードの中だけを開く。おまもりボタンのときは
                          移動手段（連れ去り検知の武装）を第1階層に残す（§4-C） */}
                      {/* そのほかの方: まず見守り方を選ぶ（順序が逆だと、何の設定を
                          しているのか分からないまま移動手段を聞かれることになる） */}
                      <Collapsible open={active && o.value === 'other'}>
                        <View style={styles.inCard}>
                          <Text style={styles.inCardHeading}>見守り方</Text>
                          <View style={styles.segment}>
                            {(['hold', 'sentinel'] as WatchMode[]).map((m) => (
                              <Pressable
                                key={m}
                                style={[styles.segmentBtn, mode === m && styles.segmentBtnActive]}
                                onPress={() => { haptics.tap(); setMode(m); }}
                                accessibilityRole="radio"
                                accessibilityState={{ selected: mode === m }}
                              >
                                <Text style={[styles.segmentText, mode === m && styles.segmentTextActive]}>
                                  {m === 'hold' ? 'おまもりボタン' : 'AIおまかせ'}
                                </Text>
                              </Pressable>
                            ))}
                          </View>
                        </View>
                      </Collapsible>

                      <Collapsible open={active && (o.mode === 'hold' || (o.value === 'other' && mode === 'hold'))}>
                        <View style={styles.inCard}>
                          <Text style={styles.inCardHeading}>おでかけの ようす</Text>
                          {TRANSPORT_OPTIONS.map((t) => {
                            const on = transport === t.value;
                            return (
                              <Pressable
                                key={t.value}
                                style={[styles.optionRow, on && styles.optionRowActive]}
                                onPress={() => { haptics.tap(); setTransport(t.value); }}
                                accessibilityRole="radio"
                                accessibilityState={{ selected: on }}
                                accessibilityLabel={`${t.label}。${t.desc}`}
                              >
                                <View style={styles.optionIcon}>
                                  <Icon name={on ? 'checkbox-on' : 'checkbox-off'} size={22} />
                                </View>
                                <View style={styles.optionTextCol}>
                                  <Text style={styles.optionLabel}>{t.label}</Text>
                                  <Text style={styles.optionDesc}>{t.desc}</Text>
                                </View>
                              </Pressable>
                            );
                          })}
                        </View>
                      </Collapsible>

                    </Pressable>
                  );
                })}
              </View>

              {/* 呼び名（任意）。ホーム・ちず・SOS画面の見出しになるので、
                  「歩く人」ではなく「おじいちゃん」と呼べるようにする。
                  未入力でも見守りは成立するので必須にしない */}
              <GlassCard style={styles.card} elevated>
                <Text style={styles.label}>だれを見守りますか？（任意）</Text>
                <TextInput
                  style={styles.nameInput}
                  value={walkerName}
                  onChangeText={setWalkerName}
                  placeholder="おじいちゃん / はるちゃん など"
                  placeholderTextColor={color.textFaint}
                  maxLength={WALKER_NAME_MAX}
                  returnKeyType="done"
                  accessibilityLabel="見守る相手の呼び名。任意です"
                />
                {/* 実際の保存先を正直に書く。サーバー側は7日で消えるが、次回のために
                    この端末にも覚える（消す手段は設定タブにある）。M-4 */}
                <Text style={styles.nameHint}>
                  この見守りの中だけで使う呼び名です。見守りが終わってから7日で消えます。{'\n'}
                  次回のために、この端末にも覚えます（設定タブから消せます）。歩く人にも見えます。
                </Text>
              </GlassCard>

              {/* 時間 */}
              <GlassCard style={styles.card} elevated>
                <Text style={styles.label}>帰宅までの目安時間</Text>
                <View style={styles.presetRow}>
                  {PRESETS.map((m) => (
                    <Pressable
                      key={m}
                      style={[styles.presetBtn, minutes === m && styles.presetBtnActive]}
                      onPress={() => setMinutes(m)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: minutes === m }}
                    >
                      <Text style={[styles.presetText, minutes === m && styles.presetTextActive]}>{m}分</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.stepper}>
                  <Pressable
                    style={styles.stepPress}
                    hitSlop={8}
                    onPress={() => setMinutes((v) => Math.max(1, v - 1))}
                    accessibilityRole="button"
                    accessibilityLabel="目安時間を1分減らす"
                  >
                    <Text style={styles.stepBtn}>－</Text>
                  </Pressable>
                  <Text style={styles.stepValue} maxFontSizeMultiplier={1.3}>{minutes} 分</Text>
                  <Pressable
                    style={styles.stepPress}
                    hitSlop={8}
                    onPress={() => setMinutes((v) => Math.min(120, v + 1))}
                    accessibilityRole="button"
                    accessibilityLabel="目安時間を1分増やす"
                  >
                    <Text style={styles.stepBtn}>＋</Text>
                  </Pressable>
                </View>
              </GlassCard>

              {/* 自宅ピンは畳むが、便益のラベルは畳まない（到着連絡の自動化はここが入口） */}
              <Pressable
                style={[styles.homeBtn, home && styles.homeBtnSet]}
                onPress={() => setShowPicker(true)}
                accessibilityRole="button"
              >
                <Text style={styles.homeBtnText}>
                  {home
                    ? '🏠 自宅を設定済み ✓ タップで変更'
                    : '🏠 家に着いたら自動でおしらせ（設定すると便利）'}
                </Text>
              </Pressable>

              {/* くわしい設定: 感度など、決めなくても始められるもの */}
              <Pressable
                style={styles.detailsToggle}
                onPress={() => setShowDetails((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ expanded: showDetails }}
              >
                <Text style={styles.detailsToggleText}>
                  {showDetails ? 'くわしい設定をとじる' : 'くわしい設定'}
                </Text>
              </Pressable>
              <Collapsible open={showDetails}>
                <View style={styles.detailsBlock}>
                  {mode === 'sentinel' && (
                    <>
                      <Text style={styles.inCardHeading}>検知の感度</Text>
                      <View style={styles.sensRow}>
                        {SENSITIVITY_OPTIONS.map((o) => (
                          <Pressable
                            key={o.value}
                            style={[styles.sensBtn, sensitivity === o.value && styles.sensBtnActive]}
                            onPress={() => { haptics.tap(); setSensitivity(o.value); }}
                            accessibilityRole="radio"
                            accessibilityState={{ selected: sensitivity === o.value }}
                            accessibilityLabel={`感度 ${o.label}。${o.hint}`}
                          >
                            <Text style={[styles.sensText, sensitivity === o.value && styles.sensTextActive]}>
                              {o.label}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                      <Text style={styles.optionDesc}>
                        {SENSITIVITY_OPTIONS.find((o) => o.value === sensitivity)?.hint}
                      </Text>
                    </>
                  )}
                  <Text style={styles.inCardHeading}>おでかけの ようす</Text>
                  {TRANSPORT_OPTIONS.map((t) => {
                    const on = transport === t.value;
                    return (
                      <Pressable
                        key={t.value}
                        style={[styles.optionRow, on && styles.optionRowActive]}
                        onPress={() => { haptics.tap(); setTransport(t.value); }}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={`${t.label}。${t.desc}`}
                      >
                        <View style={styles.optionIcon}>
                          <Icon name={on ? 'checkbox-on' : 'checkbox-off'} size={22} />
                        </View>
                        <View style={styles.optionTextCol}>
                          <Text style={styles.optionLabel}>{t.label}</Text>
                          <Text style={styles.optionDesc}>{t.desc}</Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              </Collapsible>

              <SkyButton
                title="リンクを作成"
                variant="watcher"
                style={{ width: 240 }}
                loading={isCreating}
                disabled={!online}
                onPress={handleCreatePress}
              />
              {!online && <Text style={styles.offlineNote}>インターネットに接続すると作成できます</Text>}
            </>
          )}

          {shareLink && (
            <View style={styles.steps}>
              {/* 何で見守ることになったのかを1行で確認できるようにする（§4-C） */}
              <View style={styles.summary}>
                <Icon name="watch" size={18} />
                <Text style={styles.summaryText}>
                  {describeWatchPreferences({ minutes, mode, transport, hasHome: home != null })}
                </Text>
              </View>

              <StepRow num="1" text="歩く人と つながる" styles={styles} />

              {/* 同席していれば：歩く人のカメラをかざすだけ（いちばん簡単） */}
              <View style={styles.qrCard}>
                <View style={styles.qrBox}>
                  <QRCode value={shareLink} size={168} backgroundColor="#FFFFFF" color={color.qrFg} />
                </View>
                <View style={styles.qrHintRow}>
                  <Icon name="qr-scan" size={16} />
                  <Text style={styles.qrHint}>
                    歩く人のスマホの<Text style={styles.qrHintStrong}>カメラをかざすだけ</Text>でつながります
                  </Text>
                </View>
              </View>

              {/* 離れていれば：リンクを送る */}
              <SkyButton
                title="はなれた相手にはリンクを送る"
                icon={<Icon name="share" size={18} tint={color.safeInk} />}
                variant="success"
                onPress={share}
              />

              <StepRow num="2" text="見守りをはじめる" styles={styles} />
              <SkyButton title="見守りを開始 →" variant="watcher" onPress={() => navigation.navigate('WatcherMonitor')} />
            </View>
          )}
        </ScrollView>
      </SafeAreaView>

      <HomeLocationPicker
        visible={showPicker}
        onCancel={() => setShowPicker(false)}
        onSelect={(c) => { setHome(c); setShowPicker(false); }}
      />
    </SkyScreen>
  );
}

export default withTheme('light', WatcherSetupScreen);

type Styles = ReturnType<typeof makeStyles>;

function StepRow({ num, text, styles }: { num: string; text: string; styles: Styles }) {
  return (
    <View style={styles.stepRow}>
      <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>{num}</Text></View>
      <Text style={styles.stepRowText}>{text}</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  content: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 12, paddingBottom: 40, gap: 18 },
  title: { fontSize: 26, fontWeight: '700', color: c.text },
  block: { width: '100%', gap: 10 },
  heading: { fontSize: 18, fontWeight: '700', color: c.text },

  // 第0階層: 再利用カード
  reuseCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, width: '100%',
    minHeight: 64, paddingVertical: 12, paddingHorizontal: 16, borderRadius: radius.card,
    backgroundColor: dim(c.action, 0.10), borderWidth: 1.5, borderColor: c.action,
  },
  reuseTitle: { fontSize: 16, fontWeight: '800', color: c.text },
  reuseDesc: { fontSize: 13, color: c.textSub, marginTop: 2 },
  reuseArrow: { fontSize: 26, color: c.action, fontWeight: '700' },

  // 第1問: ペルソナカード
  personaCard: {
    width: '100%', padding: 14, borderRadius: 16, gap: 6,
    backgroundColor: c.glass, borderWidth: 2, borderColor: c.glassStroke,
  },
  personaCardActive: { backgroundColor: dim(c.action, 0.12), borderColor: c.action },
  personaRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  personaEmoji: { fontSize: 26 },
  personaLabel: { flex: 1, fontSize: 17, fontWeight: '700', color: c.text },
  personaLabelActive: { color: c.action },
  personaDesc: { fontSize: 13, lineHeight: 19, color: c.textSub },
  radio: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: c.raisedStroke,
    alignItems: 'center', justifyContent: 'center',
  },
  radioActive: { borderColor: c.action, backgroundColor: c.action },
  radioDot: { color: c.actionInk, fontSize: 14, fontWeight: '900' },

  // カード内の展開部
  inCard: { marginTop: 10, gap: 8, alignSelf: 'stretch' },
  inCardHeading: { fontSize: 14, fontWeight: '700', color: c.textSub },
  // 2択は縦積み。各行はカード幅いっぱいを使い、ラベルは折り返さない
  optionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'stretch',
    minHeight: 52, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12,
    backgroundColor: c.cardNavy, borderWidth: 1, borderColor: c.glassStroke,
  },
  optionIcon: { flexShrink: 0 },
  optionTextCol: { flex: 1, flexShrink: 1, minWidth: 0 },
  optionRowActive: { borderColor: c.info, backgroundColor: dim(c.info, 0.08) },
  optionLabel: { fontSize: 15, fontWeight: '700', color: c.text, flexShrink: 1 },
  optionDesc: { fontSize: 12, lineHeight: 17, color: c.textSub, marginTop: 1 },
  segment: { flexDirection: 'row', gap: 8 },
  segmentBtn: {
    flex: 1, minHeight: 44, paddingVertical: 8, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.cardNavy, borderWidth: 1, borderColor: c.glassStroke,
  },
  segmentBtnActive: { backgroundColor: c.action, borderColor: c.action },
  segmentText: { fontSize: 15, fontWeight: '700', color: c.text },
  segmentTextActive: { color: c.actionInk },

  // 時間
  card: { width: '100%', padding: 18, alignItems: 'center', gap: 14 },
  label: { fontSize: 17, fontWeight: '600', color: c.textSub },
  nameInput: {
    width: '100%', minHeight: 52, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14,
    fontSize: 17, color: c.text,
    backgroundColor: c.cardNavy, borderWidth: 1, borderColor: c.glassStroke,
  },
  nameHint: { fontSize: 12, color: c.textSub, lineHeight: 18, alignSelf: 'stretch' },
  presetRow: { flexDirection: 'row', gap: 8, width: '100%' },
  presetBtn: {
    flex: 1, minHeight: 44, paddingVertical: 8, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', backgroundColor: c.raised,
  },
  presetBtnActive: { backgroundColor: c.action },
  presetText: { color: c.text, fontSize: 15, fontWeight: '600' },
  presetTextActive: { color: c.actionInk },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  // 的は 44pt 以上。文字を大きくしても ± と数字が 1 行に並ぶ幅で組む
  stepPress: { padding: 8, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  stepBtn: { fontSize: 32, color: c.textSub, textAlign: 'center' },
  stepValue: { fontSize: 32, fontWeight: '700', color: c.text, flexShrink: 1, textAlign: 'center' },

  homeBtn: {
    width: '100%', minHeight: 52, justifyContent: 'center',
    paddingHorizontal: 18, paddingVertical: 12, borderRadius: 22,
    backgroundColor: c.raised, borderWidth: 1, borderColor: c.raisedStroke,
  },
  homeBtnSet: { backgroundColor: dim(c.safe, 0.22), borderColor: c.safe },
  homeBtnText: { color: c.text, fontSize: 15, fontWeight: '600', textAlign: 'center' },

  detailsToggle: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  detailsToggleText: { fontSize: 15, fontWeight: '700', color: c.info },
  detailsBlock: { width: '100%', alignSelf: 'stretch', gap: 8, paddingTop: 4 },
  sensRow: { flexDirection: 'row', gap: 8 },
  sensBtn: {
    flex: 1, minHeight: 44, paddingVertical: 8, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.raised, borderWidth: 1, borderColor: c.glassStroke,
  },
  sensBtnActive: { backgroundColor: c.action, borderColor: c.action },
  sensText: { color: c.text, fontSize: 15, fontWeight: '700' },
  sensTextActive: { color: c.actionInk },

  // 作成後
  steps: { width: '100%', gap: 14 },
  summary: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 14, borderRadius: 14,
    backgroundColor: c.glass, borderWidth: 1, borderColor: c.glassStroke,
  },
  summaryText: { flex: 1, fontSize: 14, fontWeight: '600', color: c.text },
  qrCard: { alignItems: 'center', gap: 10 },
  // QR の地は読み取り信頼性のため白固定。入れ物なので枠は持たせず影で立たせる
  qrBox: {
    padding: 14, borderRadius: radius.card, backgroundColor: '#FFFFFF',
    shadowColor: c.black, shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  qrHintRow: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  qrHint: { flex: 1, fontSize: 13, color: c.textSub, lineHeight: 19 },
  qrHintStrong: { fontWeight: '800', color: c.action },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: c.action, alignItems: 'center', justifyContent: 'center' },
  stepBadgeText: { color: c.actionInk, fontWeight: '800' },
  stepRowText: { color: c.text, fontSize: 15, fontWeight: '600' },
  offlineNote: { color: c.caution, fontSize: 13 },
});
