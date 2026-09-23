const { defineSecret } = require('firebase-functions/params');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { timingSafeEqual } = require('node:crypto');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { FUNCTION_REGION, GROUP_ENTITLEMENT_ID } = require('./config');
// ─────────────────────────────────────────────────────────────
// 課金資格（D-11: 月額サブスク / v3移行設計書 §2.5.3）
//
// entitlements の書き手はここだけ。rules の users 許可リストに entitlements は
// 入っていないので、クライアントは自分の分でも書けない。
//
// 原則（§2.5.1）: **安全機能はこの資格を一切参照しない。** SOS・異常検知・通知の
// 到達性が課金状態で変わる設計にはしない。ここが管理するのは「同時に見守れる人数」と
// 「恒久ペアを作れるか」だけ。
//
// 失効時はペアを消さず休眠させる（§2.5.3）。データを人質に取らない。

// RevenueCat の Authorization ヘッダに設定する共有シークレット。
// Functions v2 では、Secret Manager の値は関数定義側で secrets に宣言しない限り
// 実行時の process.env に入らない。宣言を忘れると全リクエストが「未設定」として
// 503 になり、購入イベントが永久に失われる（RevenueCat は再送を諦める）。
const rcWebhookSecret = defineSecret('REVENUECAT_WEBHOOK_SECRET');

// RevenueCat REST API の Secret key。復元用 callable（restoreEntitlement）が
// 「その匿名 uid が本当にその購読の所有者か」をサーバー側で確かめるために使う。
// webhook 単独に依存すると、再インストールで uid が変わった課金者を救えない。
const rcRestApiKey = defineSecret('REVENUECAT_REST_API_KEY');

// 資格が「ある」とみなすイベント。RevenueCat のイベント種別はここに列挙したものだけを
// 見て、知らない種別では現在の状態を動かさない（未知のイベントで資格を落とすと、
// 支払っている人がある日いきなり使えなくなる）。
const GRANTING_EVENTS = new Set([
  'INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'NON_RENEWING_PURCHASE',
]);

const REVOKING_EVENTS = new Set(['EXPIRATION', 'REFUND', 'SUBSCRIPTION_PAUSED']);

// CANCELLATION は「自動更新を止めた」であって「もう使えない」ではない。
// 期限までは使えるので、ここで資格を落とさない（落とすのは EXPIRATION）。
//
// TRANSFER はどちらの集合にも入れない。「購読が別のストアアカウントへ移った」であって
// 失効ではなく、app_user_id だけを見て一律 active:false にすると、移転先（＝機種変更後の
// 本人）に資格を渡さないまま移転元を落とすことになる。移転は下の handleTransfer が
// transferred_from / transferred_to を明示的に処理する。

function entitlementActive(event) {
  const type = event?.type;
  if (GRANTING_EVENTS.has(type)) {
    // 期限切れのイベントが遅れて届くことがある。期限が過去なら「なし」に倒す
    const expiresAtMs = typeof event.expiration_at_ms === 'number' ? event.expiration_at_ms : null;
    if (expiresAtMs != null && expiresAtMs <= Date.now()) return false;
    return true;
  }
  if (REVOKING_EVENTS.has(type)) return false;
  return null; // 知らない種別。現在の状態を動かさない
}

exports.entitlementActive = entitlementActive;

function asUidList(value) {
  if (typeof value === 'string' && value.length > 0) return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.length > 0);
  return [];
}

exports.asUidList = asUidList;

// 同じイベントを二度適用しない／古いイベントで新しい状態を巻き戻さない（M-7）。
// 再送と順序逆転は現実に起きる。「期限が未来の RENEWAL が REFUND の後に届いて資格が
// 復活する」は、遅延した1通で有料機能が無期限に開く事故になる。
function shouldApplyEvent(existing, eventId, eventAtMs) {
  const group = existing?.entitlements?.group;
  if (!group) return true;
  if (eventId && group.lastEventId === eventId) return false;
  if (typeof group.lastEventAtMs === 'number' && typeof eventAtMs === 'number') {
    return eventAtMs >= group.lastEventAtMs;
  }
  return true;
}

exports.shouldApplyEvent = shouldApplyEvent;

async function writeEntitlement(uid, { active, expiresAtMs, eventId, eventAtMs, source = 'revenuecat' }) {
  const db = getFirestore();
  const ref = db.collection('users').doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!shouldApplyEvent(snap.exists ? snap.data() : null, eventId, eventAtMs)) return;
    tx.set(ref, {
      entitlements: {
        group: {
          active,
          expiresAt: expiresAtMs != null ? Timestamp.fromMillis(expiresAtMs) : null,
          source,
          updatedAt: FieldValue.serverTimestamp(),
          lastEventId: eventId ?? null,
          lastEventAtMs: eventAtMs ?? null,
        },
      },
    }, { merge: true });
  });
}

// 購読の移転（機種変更・ストアアカウントの移動）。移転元から外し、移転先へ渡す。
async function handleTransfer(event) {
  const eventId = typeof event.id === 'string' ? event.id : null;
  const eventAtMs = typeof event.event_timestamp_ms === 'number' ? event.event_timestamp_ms : null;
  const expiresAtMs = typeof event.expiration_at_ms === 'number' ? event.expiration_at_ms : null;
  const from = asUidList(event.transferred_from);
  const to = asUidList(event.transferred_to);
  for (const uid of from) {
    await writeEntitlement(uid, { active: false, expiresAtMs: null, eventId: eventId && `${eventId}:from`, eventAtMs });
  }
  for (const uid of to) {
    const active = expiresAtMs == null || expiresAtMs > Date.now();
    await writeEntitlement(uid, { active, expiresAtMs, eventId: eventId && `${eventId}:to`, eventAtMs });
  }
  return from.length + to.length;
}

// 共有シークレットの比較は定数時間で行う（M-7）。長さが違う時点で不一致なので、
// 長さの比較だけは先に済ませる（timingSafeEqual は長さが違うと例外を投げる）。
function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// RevenueCat の webhook 受け口。
// app_user_id は Firebase の匿名 uid（クライアントの configurePurchases が揃えている）。
exports.revenuecatWebhook = onRequest(
  { region: FUNCTION_REGION, secrets: [rcWebhookSecret] },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).send('method not allowed'); return; }
    const expected = rcWebhookSecret.value();
    if (!expected) {
      console.error('REVENUECAT_WEBHOOK_SECRET is not set; refusing all webhook calls');
      res.status(503).send('not configured');
      return;
    }
    if (!secretMatches(req.get('authorization'), expected)) {
      res.status(401).send('unauthorized');
      return;
    }

    const event = req.body?.event;
    if (!event || typeof event !== 'object') { res.status(400).send('missing event'); return; }

    if (event.type === 'TRANSFER') {
      try {
        const moved = await handleTransfer(event);
        res.status(200).send(moved > 0 ? 'ok' : 'ignored');
      } catch (e) {
        console.error('entitlement transfer failed', e);
        res.status(500).send('write failed');
      }
      return;
    }

    const uid = event.app_user_id;
    if (!uid || typeof uid !== 'string') { res.status(400).send('missing app_user_id'); return; }

    const active = entitlementActive(event);
    if (active == null) {
      // 知らないイベントは 200 で受け取っておく。4xx を返すと RevenueCat が
      // 延々と再送し、そのたびに同じ判断ができないまま関数が回る
      res.status(200).send('ignored');
      return;
    }

    try {
      await writeEntitlement(uid, {
        active,
        expiresAtMs: typeof event.expiration_at_ms === 'number' ? event.expiration_at_ms : null,
        eventId: typeof event.id === 'string' ? event.id : null,
        eventAtMs: typeof event.event_timestamp_ms === 'number' ? event.event_timestamp_ms : null,
      });
      res.status(200).send('ok');
    } catch (e) {
      console.error('entitlement write failed', uid, e);
      // 5xx を返すと RevenueCat が再送してくれる。書けなかったまま握りつぶさない
      res.status(500).send('write failed');
    }
  },
);

// 購入の復元（§2.5.4）。webhook 単独に依存すると、再インストールで匿名 uid が
// 変わった課金者を救えない——資格は旧 uid の文書に残り、新 uid には誰も書かない。
// クライアントが復元したあとここを呼ぶと、RevenueCat に直接 subscriber を照会して
// 資格を新しい uid へ書き直す。
//
// なりすまし対策: 照会する app_user_id は**呼び出し元の認証済み uid そのもの**に固定し、
// 引数で受け取らない。これで「他人の uid を騙って資格を書く／落とす」経路が構造的に無くなる
// （RevenueCat の app_user_id はクライアントが指定できる値なので、ここを引数にすると
// 標的の uid を指定して REFUND を発生させる攻撃が成り立ってしまう）。
exports.restoreEntitlement = onCall(
  { region: FUNCTION_REGION, secrets: [rcRestApiKey] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'sign-in required');
    const apiKey = rcRestApiKey.value();
    if (!apiKey) {
      // キー未設定＝オーナーのストア設定がまだ。無料枠として静かに返す（§2.5 の
      // フォールバック方針。ここで例外を投げるとアプリ側が復元失敗として扱う）
      return { active: false, configured: false };
    }

    let subscriber;
    try {
      const resp = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(uid)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!resp.ok) throw new Error(`revenuecat responded ${resp.status}`);
      subscriber = (await resp.json())?.subscriber;
    } catch (e) {
      console.error('revenuecat subscriber lookup failed', uid, e);
      throw new HttpsError('unavailable', 'could not reach the store');
    }

    const entitlement = subscriber?.entitlements?.[GROUP_ENTITLEMENT_ID];
    const expiresAtMs = entitlement?.expires_date ? Date.parse(entitlement.expires_date) : null;
    const active = entitlement != null && (expiresAtMs == null || expiresAtMs > Date.now());

    // 資格が無いときに false を書き込まない。webhook が先に書いた正しい状態を、
    // 照会の失敗や反映待ちで打ち消してしまうため（復元は「戻す」操作であって
    // 「取り上げる」操作ではない）。
    if (!active) return { active: false, configured: true };

    await writeEntitlement(uid, {
      active: true,
      expiresAtMs,
      eventId: `restore:${uid}:${expiresAtMs ?? 'lifetime'}`,
      eventAtMs: Date.now(),
      source: 'revenuecat-restore',
    });
    return { active: true, configured: true };
  },
);
