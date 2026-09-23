const { RETENTION_MS, FUNCTION_REGION, RETENTION_DAYS } = require('./config');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { pairMemberName } = require('./pairs');
const { notifyPairMember } = require('./notifications');
// ─────────────────────────────────────────────────────────────
// 恒久ペア（ADR P3 Stage 1）
//
// 不変条件（ADR §7）のうち、ここが直接支えるもの:
//   I-2 位置共有の開始は常に歩く人の端末上の明示操作でのみ始まる
//       → サーバーからセッションを作る経路は作らない。見守り手にできるのは通知まで
//   I-5 関係の死は隠さない
//       → 相手が長期不達になったら、もう片側へ知らせ、ペア文書にも印を残す

// 相手が「連絡が取れない」とみなすまでの日数。日次スケジュールで判定する。
const PAIR_STALE_DAYS = 14;

const PAIR_STALE_MS = PAIR_STALE_DAYS * 24 * 60 * 60 * 1000;

// 解除・期限切れのペアを完全削除するまでの日数。セッションと同じ7日に揃える
// （ペア設定にも保持期限を作る、という ADR 決定2 の要求）。
const PAIR_RETENTION_MS = RETENTION_MS;

// コレクションを最後まで走査する（L-2）。limit だけで打ち切ると、件数が上限を超えた
// 時点で後ろのドキュメントが永久に処理されない——「静かに効かなくなる」種類の失敗で、
// ログにも出ないので気づけない。ドキュメントID順のカーソルで最後まで回す。
const SCAN_PAGE = 300;

// 3万件。これを超える規模になったら分割実行へ切り替える
const SCAN_MAX_PAGES = 100;

async function scanAll(query) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
    let q = query.orderBy('__name__').limit(SCAN_PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    out.push(...snap.docs);
    if (snap.size < SCAN_PAGE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return out;
}

exports.scanAll = scanAll;

// ペアの死活監視と後片付け（日次）。
// ① 相手が長期不達になったペアを可視化する（I-5）
// ② 解除・期限切れのペアを保持期間の経過後に完全削除する
exports.watchPairs = onSchedule(
  { schedule: 'every day 04:30', region: FUNCTION_REGION, timeZone: 'Asia/Tokyo' },
  async () => {
    const db = getFirestore();
    const now = Date.now();

    // 同じ uid を何度も読まないための一時キャッシュ（1回の実行内のみ）
    const userCache = new Map();
    const loadUser = async (uid) => {
      if (!uid) return null;
      if (userCache.has(uid)) return userCache.get(uid);
      let data = null;
      try {
        const snap = await db.collection('users').doc(uid).get();
        data = snap.exists ? snap.data() : null;
      } catch (e) {
        console.error('user load failed', uid, e);
        // 読めなかっただけの uid を「死んだ」と判定しない。次回に回す
        data = undefined;
      }
      userCache.set(uid, data);
      return data;
    };

    // ① 死活可視化。users 文書そのものが無い（＝一度もこのバージョンを起動していない）
    //    場合は判定しない。誤って「連絡が取れません」を出す方が、遅れるより有害。
    // ドキュメントID順にページングする。limit だけだと、ペアが上限を超えた時点で
    // 後ろのペアが**永久に**死活判定されず、I-5「関係の死は隠さない」が静かに効かなくなる。
    try {
      for (const docSnap of await scanAll(db.collection('pairs').where('status', '==', 'active'))) {
        try {
          const pair = docSnap.data();
          const sides = [
            { uid: pair.walkerUid, role: 'walker', partnerUid: pair.watcherUid },
            { uid: pair.watcherUid, role: 'watcher', partnerUid: pair.walkerUid },
          ];
          let staleSide = null;
          let undetermined = false;
          for (const side of sides) {
            const user = await loadUser(side.uid);
            if (user === undefined || user == null) { undetermined = true; continue; }
            const lastSeen = user.lastSeenAt?.toMillis?.() ?? null;
            if (lastSeen == null) { undetermined = true; continue; }
            if (now - lastSeen >= PAIR_STALE_MS) staleSide = side;
          }
          if (staleSide) {
            if (!pair.staleSince) {
              const name = pairMemberName(pair, staleSide.role);
              await notifyPairMember(
                staleSide.partnerUid, docSnap.id,
                '⚠️ 連絡が取れなくなっています',
                `${name}さんの端末としばらく連絡が取れていません。端末が変わったのかもしれません。もう一度招待してください。`,
                'pair_stale', 'alert',
              );
              await docSnap.ref.update({ staleSince: Timestamp.fromMillis(now) });
            }
          } else if (!undetermined && pair.staleSince) {
            await docSnap.ref.update({ staleSince: FieldValue.delete() });
          }
        } catch (e) {
          console.error('pair liveness check failed', docSnap.id, e);
        }
      }
    } catch (e) {
      console.error('active pair query failed', e);
    }

    // ② 解除済みペアの完全削除（保持期間の経過後）
    let removed = 0;
    try {
      const due = await db.collection('pairs')
        .where('status', '==', 'revoked')
        .where('revokedAt', '<=', Timestamp.fromMillis(now - PAIR_RETENTION_MS))
        .orderBy('revokedAt')
        .limit(300)
        .get();
      for (const docSnap of due.docs) {
        try {
          await docSnap.ref.delete();
          removed += 1;
        } catch (e) {
          console.error('revoked pair delete failed', docSnap.id, e);
        }
      }
    } catch (e) {
      // 複合インデックス（status, revokedAt）の構築中などは失敗し得る。次回の実行で回復する
      console.error('revoked pair purge failed', e);
    }

    // ③ 受け取られなかった招待の後片付け。期限が切れてから保持期間を過ぎたものを消す。
    try {
      const staleInvites = await db.collection('pairs')
        .where('status', '==', 'invited')
        .where('inviteExpiresAt', '<=', Timestamp.fromMillis(now - PAIR_RETENTION_MS))
        .orderBy('inviteExpiresAt')
        .limit(300)
        .get();
      for (const docSnap of staleInvites.docs) {
        try {
          await docSnap.ref.delete();
          removed += 1;
        } catch (e) {
          console.error('stale invite delete failed', docSnap.id, e);
        }
      }
    } catch (e) {
      console.error('stale invite purge failed', e);
    }

    // ④ 「最終確認」の7日 null 化（D-14 / v3移行設計書 §2.4）。
    // ペア文書そのもの（連絡先）は解除まで残るが、足あと（いつ・どこで見守りが
    // 終わったか）は7日で消す。セッションの7日削除と同じ期限に揃えることが約束の中身で、
    // 「連絡先は残るが、足あとは7日で消える」を実際にそうする箇所がここ。
    let cleared = 0;
    try {
      const stale = await db.collection('pairs')
        .where('lastSessionSummary.endedAt', '<=', Timestamp.fromMillis(now - PAIR_RETENTION_MS))
        .orderBy('lastSessionSummary.endedAt')
        .limit(300)
        .get();
      for (const docSnap of stale.docs) {
        try {
          await docSnap.ref.update({ lastSessionSummary: null });
          cleared += 1;
        } catch (e) {
          console.error('lastSessionSummary clear failed', docSnap.id, e);
        }
      }
    } catch (e) {
      // 単一フィールドの索引で足りるが、未構築なら次回の実行で回復する
      console.error('lastSessionSummary purge failed', e);
    }

    // ⑤ 期限切れ資格の掃除（H-2）。失効は本来 EXPIRATION webhook で起きるが、
    // それは単一経路で、webhook が落ちていた間の1通を取りこぼすと資格が無期限に
    // 残り続ける。期限そのものを毎日突き合わせて、落ちた分をここで倒す。
    // （rules 側でも expiresAt を見ているので、これは表示と整合のための掃除）
    let expired = 0;
    try {
      const due = await db.collection('users')
        .where('entitlements.group.active', '==', true)
        .where('entitlements.group.expiresAt', '<=', Timestamp.fromMillis(now))
        .limit(300)
        .get();
      for (const docSnap of due.docs) {
        try {
          await docSnap.ref.update({
            'entitlements.group.active': false,
            'entitlements.group.updatedAt': FieldValue.serverTimestamp(),
          });
          expired += 1;
        } catch (e) {
          console.error('entitlement expiry sweep failed', docSnap.id, e);
        }
      }
    } catch (e) {
      console.error('entitlement expiry query failed', e);
    }

    if (removed > 0) console.log(`removed ${removed} pair document(s)`);
    if (cleared > 0) console.log(`cleared lastSessionSummary on ${cleared} pair(s) older than ${RETENTION_DAYS} days`);
    if (expired > 0) console.log(`expired group entitlement on ${expired} user(s)`);
  }
);
