const { getMessaging } = require('firebase-admin/messaging');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

// data.type / data.sessionId はクライアントの前面二重表示抑止・通知タップ復帰導線（設計書 決定A-3/D）で使う。
// data.pairId は恒久ペア（ADR P3）由来の通知でのみ付く。セッションが存在しない
// 事象（つながった・解除された・相手と連絡が取れない）の遷移先を示す。
async function send(token, title, body, { channel = 'default', type, sessionId, pairId } = {}) {
  if (!token) return 'missing';
  const data = { channel };
  if (type) data.type = type;
  if (sessionId) data.sessionId = sessionId;
  if (pairId) data.pairId = pairId;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await getMessaging().send({
        token,
        notification: { title, body },
        data,
        android: {
          priority: 'high',
          notification: { channelId: channel === 'alert' ? 'alert' : 'default', sound: 'default' },
        },
        apns: {
          payload: { aps: { sound: 'default', 'interruption-level': channel === 'alert' ? 'time-sensitive' : 'active' } },
        },
      });
      return 'sent';
    } catch (e) {
      if (INVALID_TOKEN_CODES.has(e?.code)) return 'invalid';
      if (attempt === 2) console.error('FCM送信失敗', e);
      else await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  return 'failed';
}

// FCM トークンの住所（architecture-review E-2 / ADR P3 決定2）。
// 恒久ペアでは「セッションが無いときに相手へ通知する」が本質機能になるため、
// トークンの正は users/{uid}.fcmToken へ移した。この文書はクライアントから
// read できない（firestore.rules）ので、セッション参加者がお互いのトークンを
// 読めていた従来より安全側になる。
// 移行期はセッション文書のトークンも併記されるので、users を優先しつつ
// 見つからなければ従来フィールドへ落とす。
async function tokenForUid(uid) {
  if (!uid) return null;
  try {
    const snap = await getFirestore().collection('users').doc(uid).get();
    const token = snap.exists ? snap.data()?.fcmToken : null;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch (e) {
    console.error('users token lookup failed', uid, e);
    return null;
  }
}

// 無効になったトークンは「それが載っていた場所」から消す。users のトークンが
// 死んでいるのにセッション文書側を消しても、次回また同じ死んだトークンを引く。
async function forgetInvalidToken(uid, usedUsersToken, sessionRef, tokenField) {
  if (usedUsersToken && uid) {
    await getFirestore().collection('users').doc(uid)
      .update({ fcmToken: FieldValue.delete() }).catch(() => {});
    return;
  }
  if (sessionRef && tokenField) {
    await sessionRef.update({ [tokenField]: FieldValue.delete() }).catch(() => {});
  }
}

// セッションに紐づく相手への通知。uid から users のトークンを引き、
// 無ければセッション文書の従来フィールド（fallbackToken）を使う。
async function notifySession(sessionRef, tokenField, fallbackToken, title, body, type, channel = 'default', uid = null) {
  const usersToken = await tokenForUid(uid);
  const token = usersToken ?? fallbackToken;
  const result = await send(token, title, body, { channel, type, sessionId: sessionRef.id });
  if (result === 'invalid') {
    await forgetInvalidToken(uid, usersToken != null && token === usersToken, sessionRef, tokenField);
  }
  return result;
}

// セッションを持たない相手への通知（恒久ペア由来）。宛先は users のトークンだけ。
async function notifyPairMember(uid, pairId, title, body, type, channel = 'default') {
  const token = await tokenForUid(uid);
  const result = await send(token, title, body, { channel, type, pairId });
  if (result === 'invalid') await forgetInvalidToken(uid, true, null, null);
  return result;
}

// 静かにしておく時間帯（JST 22:00〜06:59）。急ぎでも安全にも関わらない知らせは
// ここでは出さない。サーバーの実行タイムゾーンに依らないよう、UTC から +9 で作る。
function isQuietHourJst(nowMs) {
  const jstHour = new Date(nowMs + 9 * 60 * 60 * 1000).getUTCHours();
  return jstHour >= 22 || jstHour < 7;
}

exports.isQuietHourJst = isQuietHourJst;

exports.notifySession = notifySession;
exports.tokenForUid = tokenForUid;
exports.send = send;
exports.forgetInvalidToken = forgetInvalidToken;
exports.notifyPairMember = notifyPairMember;
