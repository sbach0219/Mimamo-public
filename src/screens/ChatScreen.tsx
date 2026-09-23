import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, Pressable, FlatList, KeyboardAvoidingView, Platform,
  Animated, type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SkyScreen } from '../theme/Background';
import { ConnectionPill } from '../components/ConnectionPill';
import { Icon } from '../components/Icon';
import { dim, radius, type ThemeColor, type ThemeMode } from '../theme/tokens';
import { ThemeProvider, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { haptics } from '../lib/haptics';
import { useIsOnline } from '../lib/network';
import { useSession, type ChatMessage } from '../store/sessionStore';
import type { ScreenProps } from '../navigation/types';

const WALKER_PRESETS = ['今コンビニに寄ってます🏪', '変な人がいます⚠️', 'もうすぐ着きます🏠', '少し遠回りしています🚶'];
const WATCHER_PRESETS = ['気をつけてね🌟', '早く帰ってきて🏠', '返信してね📞', '今どこ？📍'];

// チャットは両者が使う画面なので、テーマは役割で決める
// （見守り＝昼の白×ピンク / 歩行＝夜のダーク。docs/design-pink-proposal B案）。
export default function ChatScreen(props: ScreenProps<'Chat'>) {
  const myRole = useSession((s) => s.myRole);
  return (
    <ThemeProvider mode={myRole === 'watcher' ? 'light' : 'dark'}>
      <ChatBody {...props} />
    </ThemeProvider>
  );
}

function ChatBody({ navigation }: ScreenProps<'Chat'>) {
  const { mode, color } = useTheme();
  const light = mode === 'light';
  const styles = useThemedStyles(makeStyles);
  const online = useIsOnline();
  const messages = useSession((s) => s.messages);
  const myRole = useSession((s) => s.myRole);
  const sendMessage = useSession((s) => s.sendMessage);
  const acknowledgeMessage = useSession((s) => s.acknowledgeMessage);
  const setChatViewActive = useSession((s) => s.setChatViewActive);
  const [input, setInput] = useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const presets = myRole === 'walker' ? WALKER_PRESETS : WATCHER_PRESETS;

  // 見守り側の画面は白基調なので、ヘッダーも昼の色に合わせる。
  // useEffect だと初回フレームが Navigator 既定の紺で描かれて一瞬ちらつくため、
  // 描画前に走る useLayoutEffect で設定する。
  useLayoutEffect(() => {
    if (mode !== 'light') return;
    navigation.setOptions({
      headerStyle: { backgroundColor: color.action },
      headerTintColor: color.inkOnAccent,
      contentStyle: { backgroundColor: color.white },
    });
  }, [mode, color, navigation]);

  useEffect(() => {
    setChatViewActive(true);
    return () => setChatViewActive(false);
  }, [setChatViewActive]);

  useEffect(() => {
    if (messages.length > 0) listRef.current?.scrollToEnd({ animated: true });
  }, [messages.length]);

  // 相手が「みたよ！」を返した瞬間を指でも分かるようにする。
  // 初回描画時にすでに既読だったものでは鳴らさない。
  const ackedRef = useRef<Set<string>>(new Set());
  const ackInitializedRef = useRef(false);
  useEffect(() => {
    let newly = false;
    for (const m of messages) {
      if (m.sender !== myRole || !m.acknowledged || ackedRef.current.has(m.id)) continue;
      ackedRef.current.add(m.id);
      if (ackInitializedRef.current) newly = true;
    }
    ackInitializedRef.current = true;
    if (newly) haptics.tap();
  }, [messages, myRole]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t) return;
    haptics.tap();
    sendMessage(t);
  };

  const renderItem = ({ item }: { item: ChatMessage }) => {
    const mine = item.sender === myRole;
    if (mine) {
      return (
        <View style={[styles.row, { justifyContent: 'flex-end' }]}>
          <View style={{ alignItems: 'flex-end', maxWidth: '78%' }}>
            <View style={[styles.bubble, styles.bubbleMine]}>
              <Text style={styles.bubbleTextMine}>{item.text}</Text>
            </View>
            {item.acknowledged ? (
              <FadeInText style={styles.ackMine}>👋 みたよ！</FadeInText>
            ) : item.pending ? (
              <Text style={styles.sending}>おくっています…</Text>
            ) : (
              <Text style={styles.delivered}>とどいたよ ✓</Text>
            )}
          </View>
        </View>
      );
    }
    return (
      <View style={[styles.row, { justifyContent: 'flex-start' }]}>
        <View style={{ alignItems: 'flex-start', maxWidth: '78%' }}>
          <View style={[styles.bubble, styles.bubbleTheirs]}>
            <Text style={styles.bubbleTextTheirs}>{item.text}</Text>
          </View>
          {item.acknowledged ? (
            <Text style={{ fontSize: 18 }}>👋</Text>
          ) : (
            <Pressable style={styles.ackBtn} onPress={() => { haptics.tap(); acknowledgeMessage(item.id); }}>
              <Text style={styles.ackBtnText}>👋 みたよ！</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  };

  return (
    <SkyScreen>
      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={{ paddingVertical: 6 }}>
            <ConnectionPill state={online ? 'online' : 'offline'} />
          </View>
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            contentContainerStyle={
              messages.length === 0
                ? { flexGrow: 1, padding: 16, justifyContent: 'center' }
                : { padding: 16, gap: 12 }
            }
            ListEmptyComponent={
              <Text style={styles.empty}>
                まだ メッセージは ありません。{'\n'}下の ボタンから すぐ おくれるよ 💬
              </Text>
            }
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          />
          <View style={styles.composer}>
            <Text style={styles.presetHint}>タップで すぐ送れるよ</Text>
            <View style={styles.presetGrid}>
              {presets.map((p) => (
                <Pressable key={p} style={styles.preset} onPress={() => send(p)}>
                  <Text style={styles.presetText}>{p}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                placeholder="自由に入力…"
                placeholderTextColor={color.textFaint}
                value={input}
                onChangeText={setInput}
                selectionColor={color.action}
              />
              <Pressable
                style={[styles.sendBtn, { opacity: input.trim() ? 1 : 0.4 }]}
                hitSlop={6}
                disabled={!input.trim()}
                onPress={() => { send(input); setInput(''); }}
                accessibilityRole="button"
                accessibilityLabel="メッセージを送る"
              >
                <Icon name="send" size={20} tint={light ? color.actionInk : undefined} />
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SkyScreen>
  );
}

// 既読ラベルは「ついた瞬間」に意味があるので、そっと現れる
function FadeInText({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }).start();
  }, [fade]);
  return <Animated.Text style={[style, { opacity: fade }]}>{children}</Animated.Text>;
}

const makeStyles = (c: ThemeColor, mode: ThemeMode) => {
  const light = mode === 'light';
  return StyleSheet.create({
    row: { flexDirection: 'row', width: '100%' },
    bubble: { padding: 12, borderRadius: 14 },
    // 昼は透過ピンクの上に文字を置かない規約のため、自分の吹き出しはベタの濃ローズにする
    bubbleMine: { backgroundColor: light ? c.action : dim(c.action, 0.75) },
    bubbleTheirs: {
      backgroundColor: light ? c.glass : dim(c.text, 0.18),
      borderWidth: light ? 1 : 0,
      borderColor: c.glassStroke,
    },
    bubbleTextMine: { color: light ? c.actionInk : c.black, fontSize: 15 },
    bubbleTextTheirs: { color: c.text, fontSize: 15 },
    ackMine: { fontSize: 12, fontWeight: '600', color: c.action, marginTop: 3 },
    // 送達状態は見守り側の安心材料＝情報なので、装飾用の textFaint は使わない
    sending: { fontSize: 12, color: c.textSub, marginTop: 3 },
    delivered: { fontSize: 12, color: c.infoText, marginTop: 3 },
    ackBtn: {
      marginTop: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
      backgroundColor: c.raised, borderWidth: 1, borderColor: light ? c.raisedStroke : dim(c.text, 0.3),
    },
    ackBtnText: { color: c.text, fontSize: 12, fontWeight: '600' },
    composer: {
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: light ? c.glassStroke : dim(c.text, 0.3),
      padding: 14, gap: 10,
    },
    empty: { fontSize: 14, lineHeight: 22, color: c.textSub, textAlign: 'center' },
    presetHint: { fontSize: 12, color: c.textSub, textAlign: 'center' },
    presetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    preset: {
      width: '48%', minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
      backgroundColor: light ? c.glass : dim(c.text, 0.13), borderRadius: 14,
      borderWidth: 1, borderColor: light ? c.glassStroke : dim(c.text, 0.28),
    },
    presetText: { color: c.text, fontSize: 14, fontWeight: '500', textAlign: 'center' },
    inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    input: {
      flex: 1, padding: 10, borderRadius: 12, color: c.text,
      backgroundColor: light ? c.glass : dim(c.text, 0.18),
      borderWidth: light ? 1 : 0, borderColor: c.glassStroke,
    },
    // 44pt のタップ目安を確保する。昼はブランドピンクのベタ塗りになるため、
    // SOS ボタンとの形状距離をとって円ではなく角丸の正方形にする。
    sendBtn: {
      width: 44, height: 44, borderRadius: light ? radius.md : 22,
      backgroundColor: c.action, alignItems: 'center', justifyContent: 'center',
    },
  });
};
