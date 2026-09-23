const { TERMINAL_STATUSES, RETENTION_MS, FUNCTION_REGION, RETENTION_DAYS } = require('./config');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
// 保持期間を過ぎたセッションか（完全削除の判定）。
// 「消してよい」と確実に言い切れる場合だけ true を返す — 判断がつかないものは必ず false。
// - 終端状態（ended/arrived/cancelled）でなければ絶対に消さない（進行中の見守りを消すのは論外）。
// - terminalAt が無い／型が不正なら消さない（いつ終わったか分からないものを消さない）。
//   未設定の過去データは purge 側がその場で terminalAt をバックフィルし、そこから7日を数える。
function isPurgeable(session, nowMs) {
  if (!session || !TERMINAL_STATUSES.includes(session.status)) return false;
  const terminalAtMs = session.terminalAt?.toMillis?.() ?? null;
  if (terminalAtMs == null || Number.isNaN(terminalAtMs)) return false;
  return nowMs - terminalAtMs >= RETENTION_MS;
}

// テスト用に純関数を公開する（Cloud Function トリガーではないので deploy 対象にはならない）。
exports.isPurgeable = isPurgeable;

// セッション配下のサブコレクション（firestore.rules の match と一致させること）。
const SESSION_SUBCOLLECTIONS = ['messages', 'route'];

// セッション1件を「サブコレクション → 親ドキュメント」の順に完全削除する。
//
// db.recursiveDelete(documentRef) を親に直接使ってはいけない。@google-cloud/firestore の
// RecursiveDelete は、子孫の列挙ストリームが失敗したときでも onQueryEnd() で
// 「親ドキュメントの delete を発行してから」reject する実装になっている
// （recursive-delete.js: stream.on('error') → lastError 設定 → onQueryEnd() →
// writer.delete(this.ref) → flush 後に reject）。そのため一時的な UNAVAILABLE で
// 親だけが消え、messages / route（チャット本文とGPS経路＝最も機微なデータ）が
// 取り残される。purge は親ドキュメントを起点に走査するので、そうなった残骸は
// 二度と回収できず、ポリシーの「完全に削除されます」に反する。
//
// そこで先にサブコレクションを消し切り、成功を確認してから親を消す。途中で失敗したら
// 親は残すので、次回の実行で同じセッションがまた対象になり再試行される。
// なお recursiveDelete(collectionRef) 側は「親ドキュメントを消す」分岐に入らない
// （this.ref が DocumentReference のときだけ削除する）ため、この問題は起きない。
async function deleteSessionCompletely(db, sessionRef) {
  for (const name of SESSION_SUBCOLLECTIONS) {
    await db.recursiveDelete(sessionRef.collection(name));
  }
  await sessionRef.delete();
}

// 「サブコレクションを消し切ってから親」という順序自体が M1 の修正点なので、
// 回帰を防ぐためテストから注入可能にする（Cloud Function トリガーではない）。
exports.deleteSessionCompletely = deleteSessionCompletely;

exports.SESSION_SUBCOLLECTIONS = SESSION_SUBCOLLECTIONS;

// 保持期間ポリシーの実施（1日1回）。終端状態になってから RETENTION_DAYS 日を過ぎた
// セッションを、サブコレクション（messages / route）ごと Firestore から完全に削除する。
// 記録を永久に残さないためのもので、プライバシーポリシーの保管期間の記載と対になる。
// 5分毎の watchSessions ではなく専用の低頻度スケジュールにしているのは、
// 削除は急ぐ処理ではなく、頻繁に全終端セッションを走査するとコストが無駄なため。
// 1回の実行で削除する最大件数
const PURGE_BATCH_LIMIT = 300;

// 1回の実行で terminalAt を補う走査の最大件数
const BACKFILL_SCAN_LIMIT = 300;

// バックフィル走査のカーソル置き場。サーバー専用（クライアントは rules の
// match /sessions/{sessionId} 以外に到達できないため既定で拒否される）。
const PURGE_CURSOR_REF = ['maintenance', 'purgeBackfillCursor'];

exports.purgeExpiredSessions = onSchedule(
  { schedule: 'every day 04:00', region: FUNCTION_REGION, timeZone: 'Asia/Tokyo' },
  async () => {
    const db = getFirestore();
    const now = Date.now();
    let purged = 0;
    let backfilled = 0;

    // ① 削除フェーズ。保持期間を過ぎたものだけを terminalAt の昇順（古い順）で取る。
    //    orderBy を付けずに limit だけ掛けると暗黙のドキュメントID昇順になり、
    //    終端セッションが limit を超える規模では「IDの小さい同じ N 件」ばかりを
    //    見続けて、ID順で後ろのセッションが保持期間を大きく超えて残ってしまう。
    //    期限内のものはクエリ段階で除外されるので、バックフィル対象や未到来のものが
    //    削除の枠を食い潰すこともない。
    let due;
    try {
      due = await db.collection('sessions')
        .where('status', 'in', TERMINAL_STATUSES)
        .where('terminalAt', '<=', Timestamp.fromMillis(now - RETENTION_MS))
        .orderBy('terminalAt')
        .limit(PURGE_BATCH_LIMIT)
        .get();
    } catch (e) {
      // 複合インデックス（status, terminalAt）の構築中などは失敗し得る。次回の実行で回復する
      console.error('purge query failed', e);
      due = null;
    }

    for (const docSnap of due?.docs ?? []) {
      // 1件の失敗で残りを止めない（watchSessions と同じ方針）
      try {
        // クエリで絞り込み済みだが、破壊的操作なので純関数側でも必ず再確認する
        if (!isPurgeable(docSnap.data(), now)) continue;
        await deleteSessionCompletely(db, docSnap.ref);
        purged += 1;
      } catch (e) {
        console.error(
          'purge failed for session; subcollection data may remain and the parent was intentionally kept so the next run retries it',
          docSnap.id, e
        );
      }
    }

    // ② バックフィルフェーズ。terminalAt を持たない過去データを見つけて刻む。
    //    「フィールドが無い」は Firestore では直接クエリできず、①の orderBy('terminalAt')
    //    からも構造的に外れる（順序付けフィールドを持たない文書は結果に現れない）ため、
    //    ドキュメントID順のカーソルで終端セッション全体を巡回して拾う。
    //    新規セッションは onSessionStatusChange が terminalAt を刻むので、
    //    ここで拾うのは基本的にこの機能の導入以前に終端になった有限個のデータだけ。
    try {
      const cursorRef = db.collection(PURGE_CURSOR_REF[0]).doc(PURGE_CURSOR_REF[1]);
      const cursorSnap = await cursorRef.get();
      const lastId = cursorSnap.exists ? cursorSnap.data()?.lastSessionId : null;

      let scan = db.collection('sessions')
        .where('status', 'in', TERMINAL_STATUSES)
        .orderBy('__name__')
        .limit(BACKFILL_SCAN_LIMIT);
      if (lastId) scan = scan.startAfter(db.collection('sessions').doc(lastId));

      const scanned = await scan.get();
      for (const docSnap of scanned.docs) {
        try {
          if (docSnap.data().terminalAt) continue;
          // 終端時刻が不明な過去データ。ここで初めて観測した時刻を起点として刻み、
          // 次回以降の実行で通常どおり保持期間の経過を判定する（＝いきなり消さない）。
          await docSnap.ref.update({ terminalAt: FieldValue.serverTimestamp() });
          backfilled += 1;
        } catch (e) {
          console.error('terminalAt backfill failed for session', docSnap.id, e);
        }
      }

      // 最後まで見たら次回は先頭へ戻す（巡回）。途中なら続きから。
      const reachedEnd = scanned.size < BACKFILL_SCAN_LIMIT;
      await cursorRef.set({
        lastSessionId: reachedEnd ? null : scanned.docs[scanned.docs.length - 1].id,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error('terminalAt backfill scan failed', e);
    }

    if (backfilled > 0) console.log(`backfilled terminalAt on ${backfilled} session(s)`);
    if (purged > 0) console.log(`purged ${purged} session(s) older than ${RETENTION_DAYS} days`);
    if (due && due.size === PURGE_BATCH_LIMIT) {
      console.log(`purge hit the batch limit (${PURGE_BATCH_LIMIT}); the oldest remaining sessions are handled on the next run`);
    }
  }
);
