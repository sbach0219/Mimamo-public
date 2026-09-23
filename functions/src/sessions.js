const { onDocumentUpdated, onDocumentCreated } = require('firebase-functions/v2/firestore');
const { notifySession, isQuietHourJst, tokenForUid, send, forgetInvalidToken } = require('./notifications');
const { TERMINAL_STATUSES } = require('./config');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { sanitizeDestinationLabel, sanitizePlaceLabel } = require('./labels');
const { pairMemberName } = require('./pairs');
// セッション更新時の通知（ステータス変化＋センチネルの安否確認フロー）
exports.onSessionStatusChange = onDocumentUpdated('sessions/{sessionId}', async (event) => {
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (!before || !after) return;

  const watcherToken = after.watcherFcmToken;
  const walkerToken = after.walkerFcmToken;
  const notifyWatcher = (title, body, type, channel) =>
    notifySession(event.data.after.ref, 'watcherFcmToken', watcherToken, title, body, type, channel, after.watcherUid);
  const notifyWalker = (title, body, type, channel) =>
    notifySession(event.data.after.ref, 'walkerFcmToken', walkerToken, title, body, type, channel, after.walkerUid);

  // 終端状態になったらサーバー時刻で terminalAt を刻む（保持期間の起点）。
  // クライアントも endedAt を書くが、あちらは rules の許可リスト経由でクライアントが
  // 書くフィールドであり、終端遷移の経路によっては書かれないこともある。保持期間の判定は
  // サーバーが自分で書いたこのフィールドだけを信頼する（rules 変更は不要 = Admin SDK 書き込み）。
  // すでに terminalAt があれば書かない。この update による再トリガーでは after.terminalAt が
  // 埋まっているため、ここで再帰的に書き続けることはない。
  if (TERMINAL_STATUSES.includes(after.status) && !after.terminalAt) {
    try {
      await event.data.after.ref.update({ terminalAt: FieldValue.serverTimestamp() });
    } catch (e) {
      // 失敗しても purge 側が未設定分をバックフィルするので致命的ではない
      console.error('terminalAt stamp failed', event.params.sessionId, e);
    }
  }

  // 恒久ペアの「最終確認」（ADR P3 決定2 / architecture-review E-5 / D-14）。
  // ペア文書に残すのは、終了時刻・最終status・ユーザーが入力した目的地ラベル・
  // 歩く人の端末が置いていった地名ラベルだけ。**座標・電池・経路は決して残さない**
  // — セッションの7日削除（ポリシー §6）と「位置共有はセッション中のみ」（I-1）を、
  // 関係が続いても崩さないため。地名化はここではしない（サーバーから外部の
  // ジオコーディングAPIへ座標を送ると、位置が第三者へ出る経路が1本増える）。
  // ここがやるのは転記だけ。
  // 成立しなかった依頼（歩く人が現れないまま 30分で自動キャンセルされた waiting）は
  // 転記しない。実際に歩いた前回の記録が「さっき・キャンセル」で上書きされる（M-E）。
  const unstartedRequest =
    after.status === 'cancelled' && before.status === 'waiting' && !after.walkerUid;
  if (
    after.pairId &&
    TERMINAL_STATUSES.includes(after.status) &&
    !TERMINAL_STATUSES.includes(before.status) &&
    !unstartedRequest
  ) {
    try {
      // 解除済みのペアには書き戻さない（M-1）。歩行中に「監視化の防波堤」として
      // 解除した相手のところへ、到着した瞬間に「まえの見守り: さっき・◯◯」が
      // 復活しては、onPairChange の即時削除が意味を失う。
      const pairRef = getFirestore().collection('pairs').doc(after.pairId);
      const pairSnap = await pairRef.get();
      // ここで return しないこと。以降の「到着しました」「見守り終了」の通知まで
      // 巻き添えで止まる。書かないだけにして、通知は必ず続ける。
      if (pairSnap.exists && pairSnap.data()?.status === 'active') {
        await pairRef.update({
          lastSessionSummary: {
            endedAt: FieldValue.serverTimestamp(),
            finalStatus: after.status,
            destinationLabel: sanitizeDestinationLabel(after.destinationLabel),
            placeLabel: sanitizePlaceLabel(after.placeLabel),
          },
        });
      }
    } catch (e) {
      // ペアが解除・削除済みなら更新先が無い。通知本体は続行する
      console.error('lastSessionSummary update failed', after.pairId, e);
    }
  }

  // 1) ステータス変化 → 見守る人へ
  if (before.status !== after.status) {
    switch (after.status) {
      case 'sos':
        // sosSilent = 音なしSOS。声を出せない状況（尾行など）の可能性があるため、
        // 見守りへ「電話よりまずチャット」を促す
        if (after.sosSilent === true) {
          await notifyWatcher('🆘 SOS発信！（音なし）', 'サイレントSOSが発信されました。声を出せない状況かもしれません。電話の前にチャットでの連絡も検討してください。', 'sos', 'alert');
        } else {
          await notifyWatcher('🆘 SOS発信！', '歩く人からSOSが発信されました。今すぐ連絡してください。', 'sos', 'alert');
        }
        break;
      case 'alert':
        await notifyWatcher('⚠️ 緊急アラート', '歩く人から30秒以上応答がありません。すぐに確認してください。', 'alert', 'alert');
        break;
      case 'anomaly':
        if (after.anomaly?.type === 'move') {
          await notifyWatcher('🚨 移動の異常を検知', '徒歩のはずの歩く人が乗り物の速さで移動しています。すぐに確認してください。', 'anomaly', 'alert');
        } else if (after.anomaly?.type === 'area') {
          // 検知できるのは「道路や建物の無い場所に居続けている」ことだけ。「危険」とは言わない（v3 設計 §7.2）
          await notifyWatcher('⚠️ 人気のない場所に入ったようです', '歩く人が道のない場所に入り、応答がありません。安否を確認してください。', 'anomaly', 'alert');
        } else if (after.anomaly?.type === 'fall') {
          await notifyWatcher('⚠️ 転倒の可能性', '歩く人が転んだかもしれません。安否を確認してください。', 'anomaly', 'alert');
        } else {
          await notifyWatcher('⚠️ 異常を検知しました', '歩く人の動きが止まっています。安否を確認してください。', 'anomaly', 'alert');
        }
        break;
      case 'active':
        // 参加成立（waiting → active）→ 見守りへ「歩きはじめたよ」（N16）。
        // watcher-exit ADR の E1 は「参加を待つあいだ画面に張り付かなくてよい」を
        // 「見守り宛ての知らせはすべて FCM で届く」ことを根拠に許可している。
        // ここが無いと、画面を離れた見守りは歩行開始を知る手段がなく、次に届くのが
        // いきなり alert/sos になり得る（E1 の前提が崩れる）。
        if (before.status === 'waiting') {
          await notifyWatcher('🚶 歩きはじめました', '見守りがはじまりました。', 'walk_started');
        }
        // 異常からの復帰（本人が「だいじょうぶ」で解除）→ 見守りへ安心通知
        if (before.status === 'anomaly') {
          await notifyWatcher('✅ だいじょうぶそうです', '本人が異常を解除しました。', 'anomaly_resolved');
        }
        // SOSのとりけし（本人が解除）→ 見守りへ通知。誤報や「もう大丈夫」を
        // 本人が自分で引っ込められるようにして、SOSを押すハードルを下げる
        if (before.status === 'sos') {
          await notifyWatcher('✅ SOSがとりけされました', '本人がSOSをとりけしました。念のため連絡して確認すると安心です。', 'sos_cancel');
        }
        break;
      case 'arrived':
        await notifyWatcher('🏠 ついたね！', '大切な人が無事に到着しました。お疲れ様でした！', 'arrived');
        break;
      case 'cancelled':
        // 30分の自動キャンセル（H-4）。ホームの行が黙って消えるだけだと、
        // 見守る人は「渡したリンクが届いたのか」を知る手立てがない。
        if (after.autoCancelled === true) {
          await notifyWatcher(
            '⌛ 見守りのおねがいが とりけされました',
            '30分たっても相手が参加しなかったため、おねがいを自動でとりけしました。もう一度おねがいするときは、リンクを送りなおしてください。',
            'watch_auto_cancelled',
          );
        }
        break;
      case 'ended':
        // 見守る人がセッションを終了した（F-10 / watcher-exit ADR 決定F・決定G）。
        // 歩く人の安全網が消える操作なので、気づかれない通知には意味がない＝alert。
        // 「誰も見ていない」は必ず書く（静かに失敗しないための一次情報）。
        if (after.endedBy === 'watcher') {
          await notifyWalker(
            '👋 見守りが終了しました',
            '見守る人が 見守りを おえました。いまは だれも見ていない状態です。ひつようなら、もういちど 見守りを おねがいしてください。',
            'watch_ended', 'alert',
          );
        } else if (after.autoEnded === true && isQuietHourJst(Date.now())) {
          // 放置GC は expiresAt の6時間後に走るので、20分の見守りが深夜に鳴りうる
          // （L-3）。急ぎでも安全にも関わらない知らせなので、夜間は出さずに捨てる。
          // 見守りが終わったこと自体は、次にアプリを開いたときの画面で分かる。
        } else if (after.autoEnded === true) {
          // 放置GC。急かす種類の知らせではないので default チャンネル
          await notifyWalker(
            '⏰ 見守りの時間が終了しました',
            '見守りの時間が おわりました。いまは いばしょを おくっていません。',
            'watch_auto_ended',
          );
        }
        break;
      default:
        break;
    }
  }

  // 2) 歩く人が時間をのばした → 見守る人へ知らせる（issue #8）。
  //    見守り画面を開いていなくても「予定が変わった」ことに気づけるようにする
  if (
    typeof before.estimatedMinutes === 'number' &&
    typeof after.estimatedMinutes === 'number' &&
    after.estimatedMinutes > before.estimatedMinutes
  ) {
    const added = after.estimatedMinutes - before.estimatedMinutes;
    await notifyWatcher('⏱ 時間をのばしました', `歩く人が予定時間を${added}分のばしました（合計${after.estimatedMinutes}分）。`, 'extended');
  }

  // 3) 安否確認の要求（見守る人 → 歩く人）
  const beforeReq = before.safetyCheck?.requestedAt?.toMillis?.() ?? null;
  const afterReq = after.safetyCheck?.requestedAt?.toMillis?.() ?? null;
  if (afterReq && afterReq !== beforeReq) {
    await notifyWalker('🛎️ 見守りから安否確認', '「だいじょうぶ？」と聞かれています。アプリをひらいて応答してください。', 'safety_check', 'alert');
  }

  // 4) 安否確認への「大丈夫」応答（歩く人 → 見守る人）。SOS応答は status='sos' 側で通知。
  const beforeResp = before.safetyCheck?.response ?? null;
  const afterResp = after.safetyCheck?.response ?? null;
  if (afterResp === 'ok' && afterResp !== beforeResp) {
    await notifyWatcher('✅ 応答がありました', '本人から「大丈夫」と応答がありました。', 'safety_ok');
  }
});

// 新しいメッセージが届いたら相手に通知
exports.onNewMessage = onDocumentCreated('sessions/{sessionId}/messages/{messageId}', async (event) => {
  const msg = event.data?.data();
  if (!msg) return;
  const sessionRef = event.data.ref.parent.parent;
  if (!sessionRef) return;
  const session = (await sessionRef.get()).data() || {};

  const recipientToken = msg.sender === 'walker' ? session.watcherFcmToken : session.walkerFcmToken;
  const who = msg.sender === 'walker' ? '歩く人' : '見守り';
  const tokenField = msg.sender === 'walker' ? 'watcherFcmToken' : 'walkerFcmToken';
  const recipientUid = msg.sender === 'walker' ? session.watcherUid : session.walkerUid;
  await notifySession(sessionRef, tokenField, recipientToken, `${who}からメッセージ 💬`, '新しいメッセージがあります。アプリを開いて確認してください。', 'message', 'default', recipientUid);
});

// 恒久ペア起点のセッションは歩く人が status:'active' で作成するため、
// waiting → active の遷移が起きない＝既存の N16（歩きはじめました）が発火しない。
// ここが無いと、見守り手は「歩き始めた」ことを知る手段がないまま、次に届くのが
// いきなり alert/sos になり得る（watcher-exit ADR E1 の前提が崩れる）。
exports.onSessionCreated = onDocumentCreated('sessions/{sessionId}', async (event) => {
  const session = event.data?.data();
  if (!session?.pairId) return; // 都度セッション（waiting 始まり）は従来経路が通知する
  if (!session.watcherUid) return;

  let pair = null;
  try {
    const pairSnap = await getFirestore().collection('pairs').doc(session.pairId).get();
    if (pairSnap.exists) pair = pairSnap.data();
  } catch (e) {
    console.error('pair lookup failed for session create', session.pairId, e);
  }

  // ペア起点の「見守り依頼」（2026-08-26 決定①）。見守り手が waiting のセッションを
  // 作り、歩く人へ「見守りを始めませんか」を届ける。ここで送れるのは**お願いまで**で、
  // セッションを active にする権限はサーバーにも見守り手にも無い（I-2）。
  // 承諾は歩く人の端末で joinSession が呼ばれたときにだけ起きる。
  if (session.status === 'waiting') {
    if (!pair || pair.status !== 'active' || !pair.walkerUid) return;

    // 通知のレート制限（M-5）。同じペアに未応答の依頼がもう出ているなら、二度目は
    // 送らない。依頼は見守り手が何件でも作れてしまうので、歩く人の端末が
    // 「みまもりたいと いっています」で埋まる圧力を作れる。歩く人の対処手段が
    // ペアの解除しかない以上、これは見守られる側が主役という設計への直接の穴になる。
    // 依頼そのものは作れてよい（期限で自然に切れる）。抑えるのは通知だけ。
    try {
      const pending = await getFirestore().collection('sessions')
        .where('pairId', '==', session.pairId)
        .where('status', '==', 'waiting')
        .limit(2)
        .get();
      const others = pending.docs.filter((d) => d.id !== event.params.sessionId);
      if (others.length > 0) {
        console.log('suppressed duplicate watch request notification', session.pairId);
        return;
      }
    } catch (e) {
      // 判定できなかったときは送る。届かないより多い方が安全側——ではあるが、
      // ここは「圧力を作らない」ことが目的なので、失敗はログに残して可視化する
      console.error('pending watch request lookup failed', session.pairId, e);
    }

    const watcherName = pairMemberName(pair, 'watcher');
    const minutes = typeof session.estimatedMinutes === 'number' ? session.estimatedMinutes : 20;
    const token = await tokenForUid(pair.walkerUid);
    const result = await send(
      token,
      `🤝 ${watcherName}さんが みまもりたいと いっています`,
      `ひらいて「はじめる」をおすと、${minutes}分の見守りがはじまります。おさなければ、ばしょはつたわりません。`,
      { channel: 'default', type: 'watch_request', sessionId: event.params.sessionId },
    );
    if (result === 'invalid') await forgetInvalidToken(pair.walkerUid, true, null, null);
    return;
  }

  const walkerName = pair ? pairMemberName(pair, 'walker') : '大切な人';

  const label = typeof session.destinationLabel === 'string' && session.destinationLabel.length > 0
    ? `「${session.destinationLabel}」へ向かいます。`
    : '見守りがはじまりました。';
  await notifySession(
    event.data.ref, 'watcherFcmToken', session.watcherFcmToken,
    `🚶 ${walkerName}さんが歩きはじめました`, label, 'walk_started', 'default', session.watcherUid,
  );
});
