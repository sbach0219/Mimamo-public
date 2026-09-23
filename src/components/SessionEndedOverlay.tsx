import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { SkyButton } from './SkyButton';
import { Icon } from './Icon';
import { dim, type ThemeColor } from '../theme/tokens';
import { useThemedStyles } from '../theme/ThemeContext';
import type { SessionEndedReason } from '../lib/sessionStatus';

// 見守りが相手側・サーバー側で終わったことを歩く人に伝える。
// これが無いと、位置共有だけ止まって画面は「見守り中」のまま＝
// 「見られているつもりで誰も見ていない」という、いちばん避けたい失敗になる。
//
// 'watcher' は見守る人が自分の操作で終えた場合（F-10 / E3）。時間切れの自動終了と
// 混ぜずに言い分ける——歩く人が「なぜ終わったのか」を取り違えると、もう一度
// おねがいすべきかの判断ができない。
// 写像そのものは lib/sessionStatus.ts にある（画面を持ち込まずにテストするため）。
// 呼び出し側の import 元を変えずに済むよう、ここから素通しで再輸出する。
export { endedReasonFor, type SessionEndedReason } from '../lib/sessionStatus';

export function SessionEndedOverlay({ reason, onDone }: {
  reason: SessionEndedReason;
  onDone: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(enter, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 6 }).start();
  }, [enter]);

  return (
    <View style={styles.overlayDim}>
      <Animated.View
        style={[
          styles.card,
          { opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] },
        ]}
      >
        <Icon name="moon" size={72} />
        <Text style={styles.title}>見守りが おわりました</Text>
        <Text style={styles.sub}>
          {reason === 'cancelled'
            ? 'この見守りは キャンセルされたよ。'
            : reason === 'watcher'
              ? '見守る人が 見守りを おえました。'
              : reason === 'pair_revoked'
                ? 'つながりが 解除されたので おわりました。'
                : '時間切れで おわったよ。'}
          {'\n'}いまは 位置を おくっていません。
        </Text>
        <SkyButton title="ホームにもどる" variant="primary" style={{ width: 220 }} onPress={onDone} />
      </Animated.View>
    </View>
  );
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  overlayDim: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: c.overlayScrim, alignItems: 'center', justifyContent: 'center',
  },
  card: {
    alignItems: 'center', gap: 14, paddingVertical: 36, paddingHorizontal: 28, marginHorizontal: 36,
    borderRadius: 28, backgroundColor: c.cardNavy, borderWidth: 1.5, borderColor: dim(c.info, 0.4),
  },
  title: { fontSize: 28, fontWeight: '800', color: c.text, textAlign: 'center' },
  sub: { fontSize: 15, lineHeight: 23, color: c.textSub, textAlign: 'center' },
});
