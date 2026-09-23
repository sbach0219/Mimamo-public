const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { notifyPairMember } = require('./notifications');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { LIVE_STATUSES } = require('./config');
function pairMemberName(pair, role) {
  const name = role === 'walker' ? pair.walkerDisplayName : pair.watcherDisplayName;
  return typeof name === 'string' && name.length > 0 ? name : role === 'walker' ? '歩く人' : '見守る人';
}

// ペアの成立と解除。
// 解除は相手へ必ず知らせる（オーナー決定 O-2）。「見ているつもりで誰も見ていない」を
// 作らないという原則に忠実であることを、静かに離れられる自由より優先した決定。
exports.onPairChange = onDocumentUpdated('pairs/{pairId}', async (event) => {
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (!before || !after) return;
  const pairId = event.params.pairId;
  if (before.status === after.status) return;

  if (before.status === 'invited' && after.status === 'active') {
    const walkerName = pairMemberName(after, 'walker');
    const watcherName = pairMemberName(after, 'watcher');
    await notifyPairMember(
      after.watcherUid, pairId,
      '🤝 つながりました',
      `${walkerName}さんとつながりました。次からはリンクなしで見守りをはじめられます。`,
      'pair_active',
    );
    // 歩く人にも必ず伝える。「だれに見守られているか」が本人に見えていることは、
    // 監視化させないための最低条件（I-2 / I-3 の可視化）。
    await notifyPairMember(
      after.walkerUid, pairId,
      '🤝 つながりました',
      `${watcherName}さんとつながりました。位置がつたわるのは、あなたが「あるく」をおしたあいだだけです。`,
      'pair_active',
    );
    return;
  }

  if (after.status === 'revoked' && before.status !== 'revoked') {
    // 解除したその場で、預かっていた相手の情報を消す（v3移行設計書 §2.4 / D-8）。
    // ペア文書そのものは7日後に watchPairs が消すが、呼び名・年齢・最終確認は
    // 「関係が終わったら即時」でなければ約束にならない——解除は、相手の情報を
    // 手放すという意思表示そのものだから。rules の解除分岐（changedOnly）では
    // これらのフィールドに触れないので、消すのはサーバーの仕事になる。
    try {
      await event.data.after.ref.update({
        walkerLabel: FieldValue.delete(),
        lastSessionSummary: FieldValue.delete(),
      });
    } catch (e) {
      console.error('revoke cleanup failed', pairId, e);
    }

    // 進行中の見守りも終わらせる（M-4・オーナー裁定）。
    // I-3「歩く人はいつでも一方的に解除できる（監視化の防波堤）」は、解除したのに
    // 位置が期限まで流れ続けるなら防波堤として機能していない。逆に見守り手が
    // 解除した場合も、見ないと決めた相手の位置を受け取り続けるのは筋が通らない。
    // どちらが解除しても、そのペア起点のライブセッションはここで終端させる。
    // 終端は 'ended'（キャンセルではなく「終わった」）として履歴に残す——
    // 見守りが在ったこと自体を無かったことにしない。
    let stopped = 0;
    try {
      const live = await getFirestore().collection('sessions')
        .where('pairId', '==', pairId)
        .where('status', 'in', LIVE_STATUSES)
        .limit(20)
        .get();
      for (const docSnap of live.docs) {
        try {
          await docSnap.ref.update({
            status: 'ended',
            // 歩く人の画面は endedBy で終了理由を言い分ける。無印だと
            // 「時間切れで おわったよ」という事実に反する説明になる（M-B）。
            endedBy: 'pair_revoked',
            endedAt: FieldValue.serverTimestamp(),
            terminalAt: FieldValue.serverTimestamp(),
          });
          stopped += 1;
        } catch (e) {
          console.error('revoke session termination failed', docSnap.id, e);
        }
      }
    } catch (e) {
      console.error('revoke live session lookup failed', pairId, e);
    }
    if (stopped > 0) console.log(`terminated ${stopped} live session(s) on pair revoke`, pairId);

    const actor = after.revokedByUid;
    const targets = [after.walkerUid, after.watcherUid].filter((uid) => uid && uid !== actor);
    const actorName = actor === after.walkerUid ? pairMemberName(after, 'walker') : pairMemberName(after, 'watcher');
    for (const uid of targets) {
      await notifyPairMember(
        uid, pairId,
        '🔓 つながりが解除されました',
        stopped > 0
          ? `${actorName}さんとのつながりが解除されました。進行中だった見守りも終わりました。もう見守りをはじめることはできません。`
          : `${actorName}さんとのつながりが解除されました。もう見守りをはじめることはできません。`,
        'pair_revoked',
      );
    }
  }
});

exports.pairMemberName = pairMemberName;
