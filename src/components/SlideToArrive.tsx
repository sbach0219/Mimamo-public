import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, PanResponder, useWindowDimensions } from 'react-native';
import { color, dim, font } from '../theme/tokens';
import { haptics } from '../lib/haptics';
import { Icon } from './Icon';
import { ConfirmDialog } from './ConfirmDialog';
import { HoldButton } from './HoldButton';

// 到着報告のスライドボタン（issue #1）。
// ワンタップの「ついたよ！」は誤タップでセッションが終了してしまうため、
// つまみを右端までスライドしたときだけ確定する方式にする。
// トラックは端末幅から導く。文字サイズを上げるとラベルが 260 に収まらない
const MAX_TRACK_WIDTH = 320;
const TRACK_MARGIN = 48;
const TRACK_HEIGHT = 58;
const THUMB_SIZE = 50;
const PADDING = 4;
// ここまで引っ張れば確定（指を離した位置がこの割合以上）
const CONFIRM_RATIO = 0.85;
// 長押しの代替経路（F-4b）。1.5秒は震えによる瞬断があっても再試行が苦にならない長さ
const HOLD_MS = 1500;

export function SlideToArrive({ onArrived }: { onArrived: () => Promise<boolean> | boolean }) {
  // スクリーンリーダー使用時はドラッグ自体が届かないため、読み上げの「操作」から
  // 到着を知らせられるようにする（F-4a）。到着は終端遷移なので、スライド以外の
  // 経路は必ず確認ダイアログを通す（スライドはジェスチャ自体が確認を兼ねる）。
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  // スライドは手指の条件によっては最後まで引けない。2回すべったら長押しの
  // 代替経路を出す（常時2経路を並べると、どちらが正規か分からなくなる）。
  const [failedTries, setFailedTries] = useState(0);
  const { width } = useWindowDimensions();
  const trackWidth = Math.min(MAX_TRACK_WIDTH, width - TRACK_MARGIN);
  const maxX = trackWidth - THUMB_SIZE - PADDING * 2;
  // PanResponder は useRef で 1 回だけ生成されるので、閉包で maxX を捕まえると
  // 回転や端末幅の変化に追従しない。判定式そのもの（85%・dx>8）は変えていない
  const maxXRef = useRef(maxX);
  maxXRef.current = maxX;
  const x = useRef(new Animated.Value(0)).current;
  const shake = useRef(new Animated.Value(0)).current;
  const confirmedRef = useRef(false);
  // 確定ラインを跨いだ瞬間に一度だけ鳴らすためのフラグ
  const inConfirmZoneRef = useRef(false);

  // 送信に失敗して戻すときは、静かに戻すと「操作をなかったことにされた」感が残る
  const shakeBack = () => {
    haptics.error();
    Animated.sequence([
      Animated.timing(shake, { toValue: 4, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -4, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 3, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const pan = useRef(
    PanResponder.create({
      // capture フェーズで確保して、親（ScrollView 等）に横ドラッグを奪わせない
      onStartShouldSetPanResponderCapture: () => !confirmedRef.current,
      onMoveShouldSetPanResponderCapture: (_e, g) => !confirmedRef.current && Math.abs(g.dx) > 4,
      onStartShouldSetPanResponder: () => !confirmedRef.current,
      onMoveShouldSetPanResponder: (_e, g) => !confirmedRef.current && Math.abs(g.dx) > 4,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        inConfirmZoneRef.current = false;
        haptics.tap();
      },
      onPanResponderMove: (_e, g) => {
        x.setValue(Math.max(0, Math.min(maxXRef.current, g.dx)));
        // 「ここで離せば確定」を指に伝える
        const inZone = g.dx >= maxXRef.current * CONFIRM_RATIO;
        if (inZone && !inConfirmZoneRef.current) haptics.tap();
        inConfirmZoneRef.current = inZone;
      },
      onPanResponderRelease: (_e, g) => {
        const reached = g.dx >= maxXRef.current * CONFIRM_RATIO;
        if (reached) {
          confirmedRef.current = true;
          Animated.timing(x, { toValue: maxXRef.current, duration: 120, useNativeDriver: false }).start(async () => {
            const delivered = await onArrived();
            if (!delivered) {
              confirmedRef.current = false;
              shakeBack();
              Animated.spring(x, { toValue: 0, useNativeDriver: false, bounciness: 6 }).start();
            }
          });
        } else {
          // 少しでも引こうとした形跡があるときだけ数える（軽い接触は無視）
          if (g.dx > 8) setFailedTries((n) => Math.min(n + 1, 2));
          Animated.spring(x, { toValue: 0, useNativeDriver: false, bounciness: 6 }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(x, { toValue: 0, useNativeDriver: false, bounciness: 6 }).start();
      },
    })
  ).current;

  // つまみが進むほどラベルをフェードアウトして「進んでいる」感を出す
  const labelOpacity = x.interpolate({
    inputRange: [0, maxX * 0.7],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  // つまみの軌跡を緑で塗る
  const fillWidth = x.interpolate({
    inputRange: [0, maxX],
    outputRange: [THUMB_SIZE + PADDING * 2, trackWidth],
    extrapolate: 'clamp',
  });

  const confirmArrived = async () => {
    setSending(true);
    const delivered = await onArrived();
    setSending(false);
    if (delivered) {
      confirmedRef.current = true;
      Animated.timing(x, { toValue: maxXRef.current, duration: 120, useNativeDriver: false }).start();
    }
    setConfirming(false);
  };

  return (
    <View style={styles.container}>
      <Animated.View
        style={[styles.track, { width: trackWidth, transform: [{ translateX: shake }] }]}
        accessibilityRole="adjustable"
        accessibilityLabel="ついたら右へスライドして到着を知らせる"
        accessibilityHint="スライドできないときは、操作から「ついたことを知らせる」を選んでください"
        accessibilityActions={[{ name: 'activate', label: 'ついたことを知らせる' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'activate' && !confirmedRef.current) setConfirming(true);
        }}
      >
        <Animated.View style={[styles.fill, { width: fillWidth }]} />
        <Animated.View style={[styles.labelRow, { opacity: labelOpacity }]}>
          <Icon name="home" size={18} />
          <Text
            style={styles.label}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.75}
            maxFontSizeMultiplier={1.3}
          >
            ついたら スライド ➜
          </Text>
        </Animated.View>
        <Animated.View
          style={[styles.thumb, { transform: [{ translateX: x }] }]}
          {...pan.panHandlers}
        >
          <Icon name="home" size={26} tint={color.safeInk} />
        </Animated.View>
      </Animated.View>

      {failedTries >= 2 && !confirmedRef.current && (
        <View style={[styles.fallback, { maxWidth: trackWidth }]}>
          <Text style={styles.fallbackHint}>うまく すべらない？</Text>
          <HoldButton
            label="おしたままで つたえる"
            holdingLabel="そのまま おしててね…"
            durationMs={HOLD_MS}
            tone="safe"
            onComplete={() => setConfirming(true)}
            accessibilityLabel="おしたままにして 到着をつたえる"
            accessibilityHint="1.5秒 長押しすると、ついたかどうかの確認が出ます"
          />
        </View>
      )}

      <ConfirmDialog
        visible={confirming}
        icon="home"
        title="おうちに ついた？"
        body={'「ついた！」を おすと みまもりが おわって、\n見守る人に しらせが とどきます。'}
        cancelLabel="まだ"
        confirmLabel="ついた！"
        onCancel={() => setConfirming(false)}
        onConfirm={confirmArrived}
        busy={sending}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    // 枠は意味を持たないので白ガラスに。フィルとつまみの safe 緑だけが意味色
    backgroundColor: color.glass,
    borderWidth: 1.5,
    borderColor: color.raisedStroke,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: TRACK_HEIGHT / 2,
    backgroundColor: dim(color.safe, 0.45),
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 6,
    // つまみの実幅ぶんだけ右に寄せて、文字が下に隠れないようにする
    marginLeft: THUMB_SIZE + PADDING * 2,
    paddingRight: 12,
    flexShrink: 1,
  },
  label: {
    fontSize: 16,
    fontWeight: '700',
    color: color.text,
    flexShrink: 1,
  },
  thumb: {
    position: 'absolute',
    left: PADDING,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: dim(color.safe, 0.95),
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: color.textSub,
  },
  container: { alignItems: 'center', gap: 8 },
  fallback: { alignItems: 'center', gap: 4 },
  fallbackHint: { fontSize: font.caption, color: color.textSub },
});
