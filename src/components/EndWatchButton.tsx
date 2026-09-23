import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { ConfirmDialog } from './ConfirmDialog';
import { dim, type ThemeColor } from '../theme/tokens';
import { useThemedStyles } from '../theme/ThemeContext';
import { haptics } from '../lib/haptics';
import { useSession } from '../store/sessionStore';
import { useIsOnline } from '../lib/network';
import { WALKER_WRITABLE_STATUSES } from '../lib/sessionStatus';

// 見守る人からのセッション終了（F-10 / watcher-exit ADR E3）。
//
// 「画面を離れる」（E1）とは別の操作である。E1 は見守りを1ミリも弱めないが、
// これは歩く人の安全網そのものを外す破壊的操作なので、必ず確認を挟み、
// 相手に伝わることを文言で言い切る。確認は OS の Alert ではなく ConfirmDialog
// （2択の大ボタン・既定は安全側の「やめる」）で出す（確定仕様 §4-A）。
//
// 参加待ち（waiting）はここでは扱わない。あちらは歩く人がまだ存在せず、
// 失うものが参加リンクだけなので、E2（30分の自動キャンセルと「やめる」）の担当。

// 書き込みが見守り側に届いたと確認できるまでの上限（歩行画面の終了と同値）。
const END_SESSION_TIMEOUT_MS = 8_000;

export function EndWatchButton({
  onEnded,
  onEndingChange,
}: {
  onEnded: () => void;
  // 「この終了は自分の操作である」ことを親に知らせる。onSnapshot はローカル書き込みで
  // 即座に発火するので、これが無いと親の終端 effect が先回りして OS Alert と
  // 画面遷移を済ませてしまい、送達確認（8秒）が事実上働かなくなる。
  onEndingChange?: (ending: boolean) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const status = useSession((s) => s.status);
  const endSession = useSession((s) => s.endSession);
  const online = useIsOnline();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 終了できるのは進行中の見守りだけ（rules の isLiveSession と同じ集合）。
  // ただし確認ダイアログを出している最中は消さない — 自分の書き込みがローカルに
  // 反映された時点で status は 'ended' に変わるため、ここで畳むと送達確認ごと消える。
  const live = (WALKER_WRITABLE_STATUSES as readonly string[]).includes(status);
  if (!live && !asking && !busy) return null;

  const confirm = async () => {
    setError(null);
    // 圏外では Firestore の書き込みがサーバー ack まで解決しない。相手に伝わらない
    // まま画面だけ閉じると、歩く人は見守られていないのに見守られていると思う。
    if (!online) {
      setError('いまは インターネットに つながっていません。つながってから おわってください。');
      return;
    }
    setBusy(true);
    onEndingChange?.(true);
    const delivered = await Promise.race([
      endSession('ended'),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), END_SESSION_TIMEOUT_MS)),
    ]);
    setBusy(false);
    if (!delivered) {
      // 未達。終端の扱いを親に返して、遅れて着弾したときは通常の終了表示に任せる
      onEndingChange?.(false);
      setError('まだ終われていません。通信を確認して、もう一度おしてください。');
      return;
    }
    haptics.success();
    setAsking(false);
    onEnded();
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        style={styles.btn}
        onPress={() => { haptics.tap(); setError(null); setAsking(true); }}
        accessibilityRole="button"
        accessibilityLabel="見守りを終わる。歩く人にも伝わり、位置の共有がとまります"
      >
        <Text style={styles.btnText}>見守りを終わる（相手に伝わります）</Text>
      </Pressable>

      <ConfirmDialog
        visible={asking}
        icon="moon"
        title="見守りを 終わりますか？"
        body={bodyFor(status)}
        cancelLabel="やめる"
        confirmLabel="見守りを終わる"
        errorText={error}
        onCancel={() => { setAsking(false); setError(null); }}
        onConfirm={confirm}
        busy={busy}
      />
    </View>
  );
}

// 危険度は禁止ではなく文言で表す（決定C）。SOS・異変のさなかでも出口は塞がない。
function bodyFor(status: string): string {
  if (status === 'sos') {
    return 'いまSOSが発信されています。終わると、この人を見ている人はいなくなります。\n歩く人にも「見守りが終わった」と伝わり、位置の共有もとまります。';
  }
  if (status === 'alert' || status === 'anomaly') {
    return 'いま応答がない／異変を検知している状態です。終わると、この人を見ている人はいなくなります。\n歩く人にも「見守りが終わった」と伝わり、位置の共有もとまります。';
  }
  return '歩く人に「見守りが終わった」と伝わり、位置の共有がとまります。\nもう一度見守るときは、あらためてリンクかおねがいから始めてください。';
}

const makeStyles = (c: ThemeColor) => StyleSheet.create({
  // SOS・安否確認のような主要アクションより視覚的優先度を下げる（決定I）。
  // 塗りつぶさず、枠だけの控えめなボタンにする。
  wrap: { marginHorizontal: 16, alignItems: 'center' },
  btn: {
    minHeight: 48, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 20, borderRadius: 999,
    backgroundColor: c.raised, borderWidth: 1, borderColor: dim(c.danger, 0.45),
  },
  btnText: { fontSize: 15, fontWeight: '700', color: c.dangerText },
});
