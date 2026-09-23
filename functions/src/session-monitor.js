const { onSchedule } = require('firebase-functions/v2/scheduler');
const { FUNCTION_REGION } = require('./config');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { notifySession } = require('./notifications');
// セッションの定期監視（5分ごと）。
// ① ハートビート途絶: 歩く人の端末が沈黙（アプリ強制終了・電池切れ・圏外など）したら
//    見守り側へプッシュで知らせる。画面を見ていなくても気づけるようにする（安全アプリで
//    最も怖い「静かな失敗」への対策）。回復したら回復通知も送る。
// ② 予定時間超過（未到着）: 見積り時間を過ぎても到着していなければ見守り側へ知らせる。
//    時間切れ系の通知はすべてこの onSchedule に集約する（設計書 決定C）。
// ③ 放置セッションの自動終了: 期限(expiresAt)を6時間以上過ぎても終了されていない
//    セッションを ended にする（「ついたよ」の押し忘れ等で位置共有が残り続けるのを防ぐ）。
// これ以上ハートビートが無ければ「途絶」
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

// 期限からこれだけ過ぎたら自動終了
const AUTO_END_AFTER_MS = 6 * 60 * 60 * 1000;

// 参加待ちの自動キャンセル（H-4）。見守り画面には「残り X で自動的にキャンセル
// されます」と出ているが、その実行はこれまで WatcherMonitorScreen を開いている
// あいだだけ走っていた。v3 で見守り手はホームタブに留まるのが常態なので、
// 画面に書いた約束をサーバー側で果たす。値は WatcherMonitorScreen の
// WAITING_TIMEOUT（30分）と一致させること。
const WAITING_TIMEOUT_MS = 30 * 60 * 1000;

// 参加されないまま30分が過ぎた依頼か。createdAt が無い（サーバー時刻がまだ
// 解決していない）ものは判断できないので、消してよいとは言わない。
// ペア起点の依頼（pairId 付き）も同じ扱い。「ことわられた依頼が見守り手側に
// 『参加を待っています』のまま残る」（M-6）はこれで一緒に解ける。
function isWaitingExpired(session, nowMs) {
  if (!session || session.status !== 'waiting') return false;
  const createdAtMs = session.createdAt?.toMillis?.() ?? null;
  if (createdAtMs == null || Number.isNaN(createdAtMs)) return false;
  return nowMs - createdAtMs >= WAITING_TIMEOUT_MS;
}

exports.isWaitingExpired = isWaitingExpired;

exports.WAITING_TIMEOUT_MS = WAITING_TIMEOUT_MS;

// 予定時間を過ぎてもまだ到着していないか（N15 overdue の判定）。
// estimatedMinutes は延長のたびに増えるので、直近に通知した見積り分数より
// 増えていれば再武装する＝延長後にまた超過したときだけもう一度知らせる。
function isOverdue(session, nowMs) {
  if (!['active', 'alert', 'anomaly'].includes(session.status)) return false;
  if (!session.walkerUid) return false;
  const startedAtMs = session.startedAt?.toMillis?.() ?? null;
  const estimatedMinutes = typeof session.estimatedMinutes === 'number' ? session.estimatedMinutes : null;
  if (startedAtMs == null || estimatedMinutes == null) return false;
  const notifiedForMinutes = typeof session.overdueNotifiedForMinutes === 'number' ? session.overdueNotifiedForMinutes : 0;
  if (notifiedForMinutes >= estimatedMinutes) return false;
  return nowMs >= startedAtMs + estimatedMinutes * 60 * 1000;
}

// 純関数として切り出し、テストしやすくするためにエクスポートする（Cloud Function トリガーではないので deploy 対象にはならない）。
exports.isOverdue = isOverdue;

exports.watchSessions = onSchedule(
  { schedule: 'every 5 minutes', region: FUNCTION_REGION, timeZone: 'Asia/Tokyo' },
  async () => {
    const db = getFirestore();
    const now = Date.now();

    // ① ハートビート監視 ＋ ② 予定時間超過（期限内の生きているセッションだけが対象）
    try {
      const live = await db.collection('sessions')
        .where('expiresAt', '>', Timestamp.fromMillis(now))
        .get();
      for (const docSnap of live.docs) {
        // 1セッション分の処理を個別の try/catch で包む。1件の update 失敗が
        // 同じ tick の残り全セッションを止めてしまわないようにする（次回 tick で回復すれば十分）。
        try {
          const s = docSnap.data();

          if (['active', 'anomaly'].includes(s.status) && s.walkerUid) {
            const hb = s.lastHeartbeat?.toMillis?.() ?? s.startedAt?.toMillis?.() ?? null;
            if (hb != null) {
              const stale = now - hb >= HEARTBEAT_STALE_MS;
              if (stale && !s.heartbeatLostAt) {
                // 移動異常（連れ去りの可能性）の直後に端末が沈黙した場合は最も危険な複合シグナル
                if (s.status === 'anomaly' && s.anomaly?.type === 'move') {
                  await notifySession(
                    docSnap.ref, 'watcherFcmToken', s.watcherFcmToken,
                    '🚨 至急確認してください',
                    '移動の異常を検知したあと、歩く人の端末との通信が途絶えました。本人へ連絡し、つながらなければ警察（110）への相談を検討してください。',
                    'heartbeat_lost', 'alert', s.watcherUid
                  );
                } else {
                  await notifySession(
                    docSnap.ref, 'watcherFcmToken', s.watcherFcmToken,
                    '📵 通信が途絶えています',
                    '歩く人の端末から5分以上連絡がありません。電池切れや電波の問題かもしれません。連絡を取ってみてください。',
                    'heartbeat_lost', 'alert', s.watcherUid
                  );
                }
                await docSnap.ref.update({ heartbeatLostAt: Timestamp.fromMillis(now) });
              } else if (!stale && s.heartbeatLostAt) {
                await notifySession(docSnap.ref, 'watcherFcmToken', s.watcherFcmToken, '✅ 通信が回復しました', '歩く人の端末との通信が戻りました。', 'heartbeat_back', 'default', s.watcherUid);
                await docSnap.ref.update({ heartbeatLostAt: FieldValue.delete() });
              }
            }
          }

          // 予定超過は「異常」ではなく気にかけるきっかけなので default チャンネル（煽らない・急かさない）
          if (isOverdue(s, now)) {
            await notifySession(
              docSnap.ref, 'watcherFcmToken', s.watcherFcmToken,
              '⏰ 予定の時間をすぎています',
              'まだ到着していないようです。少し様子を見るか、メッセージを送ってみてください。',
              'overdue', 'default', s.watcherUid
            );
            await docSnap.ref.update({ overdueNotifiedForMinutes: s.estimatedMinutes });
          }
        } catch (e) {
          console.error('session watch failed', docSnap.id, e);
        }
      }
    } catch (e) {
      // ここに来るのはクエリ自体（live セッション一覧の取得）の失敗のみ。
      // 個々のセッション処理の失敗は上のループ内 try/catch で捕捉済み。
      console.error('live session query failed', e);
    }

    // ③' 参加待ちの自動キャンセル（H-4 / M-6）。リンクを渡し忘れた依頼と、
    //     歩く人が「ことわる」を押した依頼を、30分でサーバー側から畳む。
    try {
      const waiting = await db.collection('sessions')
        .where('status', '==', 'waiting')
        .where('createdAt', '<', Timestamp.fromMillis(now - WAITING_TIMEOUT_MS))
        .limit(100)
        .get();
      let cancelled = 0;
      for (const docSnap of waiting.docs) {
        // クエリで絞り込んだうえで、判定そのものは純関数に通す（テストと同じ経路）
        if (!isWaitingExpired(docSnap.data(), now)) continue;
        try {
          await docSnap.ref.update({
            status: 'cancelled',
            endedAt: FieldValue.serverTimestamp(),
            autoCancelled: true,
          });
          cancelled += 1;
        } catch (e) {
          // 1件の失敗で残りを止めない（次の tick で回復する）
          console.error('waiting session cancel failed', docSnap.id, e);
        }
      }
      if (cancelled > 0) console.log(`auto-cancelled ${cancelled} waiting session(s)`);
    } catch (e) {
      // 複合インデックス（status asc, createdAt asc）構築中などは失敗し得る
      console.error('waiting session GC failed', e);
    }

    // ③ 期限切れセッションの自動終了（サイレントなガベージコレクション）
    try {
      const staleSessions = await db.collection('sessions')
        .where('status', 'in', ['waiting', 'active', 'anomaly', 'alert', 'sos'])
        .where('expiresAt', '<', Timestamp.fromMillis(now - AUTO_END_AFTER_MS))
        .limit(100)
        .get();
      for (const docSnap of staleSessions.docs) {
        await docSnap.ref.update({
          status: 'ended',
          endedAt: FieldValue.serverTimestamp(),
          autoEnded: true,
        });
      }
      if (staleSessions.size > 0) console.log(`auto-ended ${staleSessions.size} stale session(s)`);
    } catch (e) {
      // 複合インデックス構築中などは失敗し得る。次回の実行で回復する
      console.error('stale session GC failed', e);
    }
  }
);
