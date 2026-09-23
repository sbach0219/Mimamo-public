/**
 * firestore.rules の回帰テスト。
 *
 * 実行:  npm test   （Firestoreエミュレータを自動起動。JDK 21以上が必要）
 *
 * 主目的は 2026-07-31 の自己診断で検出した「待機セッションの列挙」の再発防止だが、
 * それ以外の既存の防御（役割別の更新許可リスト、メッセージ/経路の内容検証）も
 * 一緒に固定して、ルール変更時にうっかり緩めてしまう事故を防ぐ。
 *
 * ルールは request.time との一致を要求する箇所があるため、
 * メッセージ・経路の timestamp はテストでも serverTimestamp() を使うこと。
 */
const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, getDocs, limit, serverTimestamp, deleteField,
} = require('firebase/firestore');

const WATCHER = 'uid-watcher';
const WALKER = 'uid-walker';
const ATTACKER = 'uid-attacker';

const [emuHost, emuPort] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
// 既定は本番用ルール。RULES_PATH を差し替えると、
// 「このテストが本当に脆弱版を落とせるか」の検証（ミューテーションテスト）ができる。
const RULES_PATH = process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules');

let testEnv;
let watcherDb;
let walkerDb;
let attackerDb;
let anonDb;

const hourFromNow = () => new Date(Date.now() + 3600_000);

/** 見守り側が作成した直後（待機中）のセッション。実アプリ同様 walkerUid は未設定。 */
const waitingSession = (overrides = {}) => ({
  status: 'waiting',
  estimatedMinutes: 20,
  mode: 'hold',
  transport: 'vehicle_ok',
  watcherUid: WATCHER,
  watcherFcmToken: 'WATCHER_TOKEN',
  createdAt: new Date(),
  expiresAt: hourFromNow(),
  ...overrides,
});

/** 歩行中（両者参加済み）のセッション。 */
const activeSession = (overrides = {}) => waitingSession({
  status: 'active',
  walkerUid: WALKER,
  walkerFcmToken: 'WALKER_TOKEN',
  startedAt: new Date(),
  ...overrides,
});

async function seed(docs) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [p, data] of Object.entries(docs)) {
      await setDoc(doc(db, p), data);
    }
  });
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'mimamo-rules-test',
    firestore: {
      host: emuHost,
      port: Number(emuPort),
      rules: fs.readFileSync(RULES_PATH, 'utf8'),
    },
  });
  watcherDb = testEnv.authenticatedContext(WATCHER).firestore();
  walkerDb = testEnv.authenticatedContext(WALKER).firestore();
  attackerDb = testEnv.authenticatedContext(ATTACKER).firestore();
  anonDb = testEnv.unauthenticatedContext().firestore();
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

// ───────────────────────────────────────────────────────────────
// 2026-07-31 に検出・修正した本丸。
// rules_version='2' では read = get + list なので、read で isJoinable を許すと
// 認証済みなら誰でも待機セッションを列挙でき、そこから乗っ取り・偽SOSに繋がった。
describe('待機セッションの列挙（Broken Access Control）', () => {
  beforeEach(() => seed({
    'sessions/s-waiting': waitingSession(),
    'sessions/s-waiting-empty': waitingSession({ walkerUid: '', watcherUid: 'uid-other' }),
    'sessions/s-active': activeSession({ watcherUid: 'uid-other', walkerUid: 'uid-other2' }),
  }));

  test("第三者は where('status','==','waiting') で待機セッションを列挙できない", async () => {
    await assertFails(getDocs(query(
      collection(attackerDb, 'sessions'), where('status', '==', 'waiting'), limit(50))));
  });

  test("第三者は where('walkerUid','==','') で待機セッションを列挙できない", async () => {
    await assertFails(getDocs(query(
      collection(attackerDb, 'sessions'), where('walkerUid', '==', ''), limit(50))));
  });

  test('第三者はセッションコレクション全体を列挙できない', async () => {
    await assertFails(getDocs(query(collection(attackerDb, 'sessions'), limit(50))));
  });

  test('第三者は他人の watcherUid を指定しても列挙できない', async () => {
    await assertFails(getDocs(query(
      collection(attackerDb, 'sessions'), where('watcherUid', '==', WATCHER), limit(50))));
  });

  test('第三者は歩行中セッションを単体 get できない', async () => {
    await assertFails(getDoc(doc(attackerDb, 'sessions/s-active')));
  });

  test('未認証ユーザーは待機セッションを get できない', async () => {
    await assertFails(getDoc(doc(anonDb, 'sessions/s-waiting')));
  });

  test('自分が当事者のセッションは list できる（履歴画面）', async () => {
    await assertSucceeds(getDocs(query(
      collection(watcherDb, 'sessions'), where('watcherUid', '==', WATCHER), limit(50))));
    await seed({ 'sessions/s-mine': activeSession() });
    await assertSucceeds(getDocs(query(
      collection(walkerDb, 'sessions'), where('walkerUid', '==', WALKER), limit(50))));
  });

  test('招待リンク（sessionId）を知っていれば待機セッションを単体 get できる', async () => {
    await assertSucceeds(getDoc(doc(walkerDb, 'sessions/s-waiting')));
  });
});

// ───────────────────────────────────────────────────────────────
describe('セッションへの参加（join）', () => {
  beforeEach(() => seed({ 'sessions/s-waiting': waitingSession() }));

  test('リンクを知る人は待機セッションに参加できる', async () => {
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/s-waiting'), {
      walkerUid: WALKER, status: 'active', startedAt: serverTimestamp(),
      walkerFcmToken: 'WALKER_TOKEN',
    }));
  });

  test('参加のついでに見守り側の watcherFcmToken を差し替えられない', async () => {
    await assertFails(updateDoc(doc(attackerDb, 'sessions/s-waiting'), {
      walkerUid: ATTACKER, status: 'active', startedAt: serverTimestamp(),
      watcherFcmToken: 'ATTACKER_CONTROLLED_TOKEN',
    }));
  });

  test('参加のついでに位置情報を捏造できない', async () => {
    await assertFails(updateDoc(doc(attackerDb, 'sessions/s-waiting'), {
      walkerUid: ATTACKER, status: 'active', latitude: 0, longitude: 0,
    }));
  });

  test('他人を walkerUid に指定して参加させられない', async () => {
    await assertFails(updateDoc(doc(attackerDb, 'sessions/s-waiting'), {
      walkerUid: 'someone-else', status: 'active', startedAt: serverTimestamp(),
    }));
  });

  test('すでに歩く人が決まったセッションには割り込めない', async () => {
    await seed({ 'sessions/s-active': activeSession() });
    await assertFails(updateDoc(doc(attackerDb, 'sessions/s-active'), {
      walkerUid: ATTACKER, status: 'active', startedAt: serverTimestamp(),
    }));
  });

  test('期限切れの待機セッションには参加できない', async () => {
    await seed({ 'sessions/s-expired': waitingSession({ expiresAt: new Date(Date.now() - 1000) }) });
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s-expired'), {
      walkerUid: WALKER, status: 'active', startedAt: serverTimestamp(),
    }));
  });

  test('終了済みセッションには参加できない', async () => {
    await seed({ 'sessions/s-ended': waitingSession({ status: 'ended' }) });
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s-ended'), {
      walkerUid: WALKER, status: 'active', startedAt: serverTimestamp(),
    }));
  });

  test('第三者は参加せずに status だけ書き換えられない（偽SOS）', async () => {
    await assertFails(updateDoc(doc(attackerDb, 'sessions/s-waiting'), { status: 'sos' }));
    await seed({ 'sessions/s-active': activeSession() });
    await assertFails(updateDoc(doc(attackerDb, 'sessions/s-active'), { status: 'sos' }));
  });
});

// ───────────────────────────────────────────────────────────────
describe('参加者による更新（役割ごとの許可リスト）', () => {
  beforeEach(() => seed({ 'sessions/s': activeSession() }));

  test('歩く人は相手（見守り）の watcherFcmToken を書き換えられない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { watcherFcmToken: 'STOLEN' }));
  });

  test('見守りは相手（歩く人）の walkerFcmToken を書き換えられない', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s'), { walkerFcmToken: 'STOLEN' }));
  });

  test('自分の役割の FCM トークンは更新できる', async () => {
    await assertSucceeds(updateDoc(doc(watcherDb, 'sessions/s'), { watcherFcmToken: 'NEW_W' }));
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/s'), { walkerFcmToken: 'NEW_K' }));
  });

  test('当事者の UID はすり替えられない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { watcherUid: WALKER }));
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s'), { walkerUid: WATCHER }));
  });

  test('見守り側は位置・電池・SOSを捏造できない（歩く人の端末のみ）', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s'), { latitude: 0, longitude: 0 }));
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s'), { batteryLevel: 0.01 }));
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s'), {
      status: 'sos', sosAt: serverTimestamp(),
    }));
  });

  test('見守り側は歩行中セッションの status を変更できない（取消は waiting のときだけ）', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s'), { status: 'cancelled' }));
    await seed({ 'sessions/s-waiting': waitingSession() });
    await assertSucceeds(updateDoc(doc(watcherDb, 'sessions/s-waiting'), {
      status: 'cancelled', endedAt: serverTimestamp(),
    }));
  });

  test('モデル外のフィールドは追加できない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { isAdmin: true }));
    // Cloud Functions 専用フィールドもクライアントからは書けない
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { autoEnded: true }));
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { heartbeatLostAt: serverTimestamp() }));
  });

  test('作成時のみのフィールド（mode / createdAt / homeLatitude / transport）は改変できない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { mode: 'sentinel' }));
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { createdAt: new Date(0) }));
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { homeLatitude: 0 }));
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { transport: 'walk_only' }));
  });

  test('セッションは誰も削除できない', async () => {
    await assertFails(deleteDoc(doc(watcherDb, 'sessions/s')));
    await assertFails(deleteDoc(doc(walkerDb, 'sessions/s')));
  });
});

// ───────────────────────────────────────────────────────────────
describe('セッション作成', () => {
  test('見守りは自分の UID でセッションを作成できる', async () => {
    await assertSucceeds(setDoc(doc(watcherDb, 'sessions/new1'), waitingSession()));
  });

  test('他人の UID を watcherUid にして作成できない', async () => {
    await assertFails(setDoc(doc(attackerDb, 'sessions/new2'), waitingSession()));
  });

  test('歩く人をあらかじめ埋め込んだセッションは作成できない', async () => {
    await assertFails(setDoc(doc(watcherDb, 'sessions/new3'),
      waitingSession({ walkerUid: WALKER })));
  });

  test('waiting 以外の状態で作成できない', async () => {
    await assertFails(setDoc(doc(watcherDb, 'sessions/new4'),
      waitingSession({ status: 'active' })));
  });

  test('期限切れ・不正な所要時間では作成できない', async () => {
    await assertFails(setDoc(doc(watcherDb, 'sessions/new5'),
      waitingSession({ expiresAt: new Date(Date.now() - 1000) })));
    await assertFails(setDoc(doc(watcherDb, 'sessions/new6'),
      waitingSession({ estimatedMinutes: 0 })));
  });
});

// ───────────────────────────────────────────────────────────────
// 実アプリ（src/store/sessionStore.ts）が実際に投げる書き込みをなぞる。
// ここが落ちたら、ルールの締めすぎで本番機能が壊れるということ。
describe('正規フローの回帰', () => {
  test('見守り作成 → 参加 → 歩行 → 到着', async () => {
    await assertSucceeds(setDoc(doc(watcherDb, 'sessions/flow'), waitingSession()));

    await assertSucceeds(getDoc(doc(walkerDb, 'sessions/flow')));
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/flow'), {
      walkerUid: WALKER, status: 'active',
      startedAt: serverTimestamp(), walkerFcmToken: 'WALKER_TOKEN',
    }));

    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/flow'), {
      latitude: 35.68, longitude: 139.76,
      locationUpdatedAt: serverTimestamp(), lastHeartbeat: serverTimestamp(),
    }));
    await assertSucceeds(addDoc(collection(walkerDb, 'sessions/flow/route'), {
      lat: 35.68, lng: 139.76, timestamp: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/flow'), {
      batteryLevel: 0.42, batteryState: 'unplugged',
    }));
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/flow'), {
      status: 'arrived', endedAt: serverTimestamp(),
    }));
  });

  test('SOS発信・キャンセル・時間延長（sosSilent / sosCancelledAt / timeExtendedAt）', async () => {
    await seed({ 'sessions/sos': activeSession() });
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/sos'), {
      status: 'sos', sosAt: serverTimestamp(), sosSilent: true,
    }));
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/sos'), {
      status: 'active', sosCancelledAt: serverTimestamp(), sosSilent: false, safetyCheck: null,
    }));
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/sos'), {
      estimatedMinutes: 30, expiresAt: hourFromNow(), timeExtendedAt: serverTimestamp(),
    }));
  });

  test('センチネル：異常検知 → 安否確認 → 応答 → 解除', async () => {
    await seed({ 'sessions/sen': activeSession({ mode: 'sentinel' }) });
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/sen'), {
      status: 'anomaly', anomaly: { type: 'fall', detectedAt: serverTimestamp() }, safetyCheck: null,
    }));
    await assertSucceeds(updateDoc(doc(watcherDb, 'sessions/sen'), {
      safetyCheck: { requestedAt: serverTimestamp(), response: null },
    }));
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/sen'), {
      'safetyCheck.response': 'ok', 'safetyCheck.respondedAt': serverTimestamp(), status: 'active',
    }));
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/sen'), {
      status: 'active', anomalyResolvedAt: serverTimestamp(), safetyCheck: null,
    }));
  });
});

// ───────────────────────────────────────────────────────────────
describe('サブコレクション（messages / route）', () => {
  beforeEach(() => seed({
    'sessions/s': activeSession(),
    'sessions/s/messages/m1': { text: 'ひみつ', sender: 'walker', timestamp: new Date() },
    'sessions/s/route/r1': { lat: 1, lng: 2, timestamp: new Date() },
  }));

  test('第三者はメッセージを読めない・送れない', async () => {
    await assertFails(getDocs(collection(attackerDb, 'sessions/s/messages')));
    await assertFails(getDoc(doc(attackerDb, 'sessions/s/messages/m1')));
    await assertFails(addDoc(collection(attackerDb, 'sessions/s/messages'), {
      text: 'なりすまし', sender: 'watcher', timestamp: serverTimestamp(),
    }));
  });

  test('第三者は経路を読めない・書けない', async () => {
    await assertFails(getDocs(collection(attackerDb, 'sessions/s/route')));
    await assertFails(addDoc(collection(attackerDb, 'sessions/s/route'), {
      lat: 0, lng: 0, timestamp: serverTimestamp(),
    }));
  });

  test('参加者はメッセージを送れる', async () => {
    await assertSucceeds(addDoc(collection(walkerDb, 'sessions/s/messages'), {
      text: 'いま公園', sender: 'walker', timestamp: serverTimestamp(),
    }));
    await assertSucceeds(addDoc(collection(watcherDb, 'sessions/s/messages'), {
      text: '気をつけてね', sender: 'watcher', timestamp: serverTimestamp(),
    }));
  });

  test('相手になりすました sender では送れない', async () => {
    await assertFails(addDoc(collection(walkerDb, 'sessions/s/messages'), {
      text: 'なりすまし', sender: 'watcher', timestamp: serverTimestamp(),
    }));
  });

  test('300文字を超えるメッセージ・余計なフィールドは送れない', async () => {
    await assertFails(addDoc(collection(walkerDb, 'sessions/s/messages'), {
      text: 'あ'.repeat(301), sender: 'walker', timestamp: serverTimestamp(),
    }));
    await assertFails(addDoc(collection(walkerDb, 'sessions/s/messages'), {
      text: 'ok', sender: 'walker', timestamp: serverTimestamp(), acknowledged: true,
    }));
  });

  test('既読は受信者だけが付けられる', async () => {
    await assertSucceeds(updateDoc(doc(watcherDb, 'sessions/s/messages/m1'), { acknowledged: true }));
    // m1 は walker 発。送信者自身は既読を付けられない
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s/messages/m1'), { acknowledged: true }));
  });

  test('経路は歩く人だけが、進行中のセッションにのみ書ける', async () => {
    await assertSucceeds(addDoc(collection(walkerDb, 'sessions/s/route'), {
      lat: 35.6, lng: 139.7, timestamp: serverTimestamp(),
    }));
    await assertFails(addDoc(collection(watcherDb, 'sessions/s/route'), {
      lat: 35.6, lng: 139.7, timestamp: serverTimestamp(),
    }));
    await assertFails(addDoc(collection(walkerDb, 'sessions/s/route'), {
      lat: 999, lng: 139.7, timestamp: serverTimestamp(),
    }));
    await seed({ 'sessions/s-ended': activeSession({ status: 'ended' }) });
    await assertFails(addDoc(collection(walkerDb, 'sessions/s-ended/route'), {
      lat: 35.6, lng: 139.7, timestamp: serverTimestamp(),
    }));
  });
});

// ───────────────────────────────────────────────────────────────
// 2026-08 アーキテクチャ点検で塞いだ穴（B-1 / A-5）。
// 終端後も位置を書けると、見守りを終えたはずの相手に現在地が purge（7日）まで
// 届き続ける。バックグラウンドの位置タスクは status を見ずに書くため、
// ここが最後の防波堤になる。
describe('終端したセッションへの書き込み（B-1）', () => {
  beforeEach(() => seed({
    'sessions/s-live': activeSession(),
    'sessions/s-ended': activeSession({ status: 'ended' }),
    'sessions/s-arrived': activeSession({ status: 'arrived' }),
    'sessions/s-cancelled': activeSession({ status: 'cancelled' }),
  }));

  test('歩く人は進行中セッションには位置を書ける', async () => {
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/s-live'), {
      latitude: 35.6, longitude: 139.7, locationUpdatedAt: serverTimestamp(),
    }));
  });

  test('歩く人は終了・到着・キャンセル済みセッションに位置を書けない', async () => {
    for (const id of ['s-ended', 's-arrived', 's-cancelled']) {
      await assertFails(updateDoc(doc(walkerDb, `sessions/${id}`), {
        latitude: 35.6, longitude: 139.7, locationUpdatedAt: serverTimestamp(),
      }));
    }
  });

  test('歩く人は終端済みセッションにハートビート・電池も書けない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s-ended'), { lastHeartbeat: serverTimestamp() }));
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s-ended'), { batteryLevel: 0.5 }));
  });

  test('進行中から終端させる遷移そのものは通る（到着・終了の連絡）', async () => {
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/s-live'), {
      status: 'arrived', endedAt: serverTimestamp(),
    }));
  });

  test('緊急（sos / anomaly）は生存扱いなので書き込みを止めない', async () => {
    await seed({ 'sessions/s-sos': activeSession({ status: 'sos' }) });
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/s-sos'), {
      latitude: 35.6, longitude: 139.7,
    }));
  });

  test('終端後でも期限内なら SOS だけは通す（安全弁）', async () => {
    // 到着を押した直後・自動終了の直後に何かあったとき、助けを呼ぶ手段まで
    // 閉じてしまうのが最悪の失敗であるため、SOS への遷移だけは開けてある。
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/s-arrived'), {
      status: 'sos', sosAt: serverTimestamp(), sosSilent: false,
      latitude: 35.6, longitude: 139.7,
    }));
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/s-ended'), {
      status: 'sos', sosAt: serverTimestamp(), sosSilent: true,
    }));
  });

  test('安全弁は SOS 以外の状態・フィールドには使えない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s-arrived'), {
      status: 'active', sosAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s-arrived'), {
      status: 'sos', sosAt: serverTimestamp(), estimatedMinutes: 999,
    }));
  });

  test('期限切れセッションには SOS も書けない', async () => {
    await seed({
      'sessions/s-expired-ended': activeSession({
        status: 'ended', expiresAt: new Date(Date.now() - 60_000),
      }),
    });
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s-expired-ended'), {
      status: 'sos', sosAt: serverTimestamp(),
    }));
  });

  test('見守り側は安全弁を使って SOS を捏造できない', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s-arrived'), {
      status: 'sos', sosAt: serverTimestamp(),
    }));
  });

  test('終端済みセッションでも歩く人は経路を書けない（既存防御の再確認）', async () => {
    await assertFails(addDoc(collection(walkerDb, 'sessions/s-ended/route'), {
      lat: 35.6, lng: 139.7, timestamp: serverTimestamp(),
    }));
  });
});

describe('見守る人が自分のセッションに歩く人として参加する（A-5）', () => {
  beforeEach(() => seed({ 'sessions/s-mine': waitingSession() }));

  test('見守る人自身は自分の待機セッションに参加できない', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s-mine'), {
      walkerUid: WATCHER, status: 'active', startedAt: serverTimestamp(),
    }));
  });

  test('別人の参加は従来どおり通る', async () => {
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/s-mine'), {
      walkerUid: WALKER, status: 'active', startedAt: serverTimestamp(),
      walkerFcmToken: 'WALKER_TOKEN',
    }));
  });
});

// ───────────────────────────────────────────────────────────────
// 緊急連絡先（walkerPhone / D-1 承認・F-9）。
// 見守る人が任意で登録し、SOS 時の「本人に電話する」に使う。
describe('緊急連絡先 walkerPhone', () => {
  beforeEach(() => seed({ 'sessions/s': activeSession() }));

  test('見守る人は電話番号を登録できる', async () => {
    await assertSucceeds(updateDoc(doc(watcherDb, 'sessions/s'), { walkerPhone: '09012345678' }));
  });

  test('文字列以外・20文字超・電話番号以外の文字は登録できない', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s'), { walkerPhone: 9012345678 }));
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s'), { walkerPhone: '0'.repeat(21) }));
    // 電話番号の器に別の情報を持ち込ませない（住所・URL・メモなど）
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s'), { walkerPhone: 'https://evil' }));
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s'), { walkerPhone: '東京都港区' }));
  });

  test('国番号つき・ハイフンつきは登録できる', async () => {
    await assertSucceeds(updateDoc(doc(watcherDb, 'sessions/s'), { walkerPhone: '+81-90-1234-5678' }));
  });

  test('歩く人・第三者は電話番号を書き換えられない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { walkerPhone: '09000000000' }));
    await assertFails(updateDoc(doc(attackerDb, 'sessions/s'), { walkerPhone: '09000000000' }));
  });

  test('電話番号を含むセッション文書は参加者だけが読める（第三者は取得自体できない）', async () => {
    await assertSucceeds(getDoc(doc(walkerDb, 'sessions/s')));
    await assertFails(getDoc(doc(attackerDb, 'sessions/s')));
  });
});

// ───────────────────────────────────────────────────────────────
// 相手の呼び名（walkerName / v3 Phase 1 §2.3）。
// 見守る人が任意で入力し、ホームのリスト・SOS画面の見出しに使う。
// セッション文書の中に置くので、終端から7日の purge にそのまま乗る。
describe('呼び名 walkerName', () => {
  beforeEach(() => seed({ 'sessions/s': activeSession() }));

  test('見守る人は呼び名を登録・変更できる', async () => {
    await assertSucceeds(updateDoc(doc(watcherDb, 'sessions/s'), { walkerName: 'はるちゃん' }));
    await assertSucceeds(updateDoc(doc(watcherDb, 'sessions/s'), { walkerName: '' }));
  });

  test('文字列以外・30文字超は登録できない', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s'), { walkerName: 123 }));
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s'), { walkerName: 'あ'.repeat(31) }));
  });

  test('歩く人・第三者は呼び名を書き換えられない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { walkerName: 'のっとり' }));
    await assertFails(updateDoc(doc(attackerDb, 'sessions/s'), { walkerName: 'のっとり' }));
  });

  test('作成時にも呼び名を入れられるが、30文字を超えるものは作成ごと拒否される', async () => {
    await assertSucceeds(setDoc(doc(watcherDb, 'sessions/new-ok'), {
      ...waitingSession(), createdAt: serverTimestamp(), walkerName: 'おじいちゃん',
    }));
    await assertFails(setDoc(doc(watcherDb, 'sessions/new-ng'), {
      ...waitingSession(), createdAt: serverTimestamp(), walkerName: 'あ'.repeat(31),
    }));
  });
});

// ───────────────────────────────────────────────────────────────
// SOS の確認印。見守る人がSOS画面を実際に開いた時刻だけを、歩く人へ返す。
describe('SOS確認印 sosAcknowledgedAt', () => {
  beforeEach(() => seed({ 'sessions/s-sos': activeSession({ status: 'sos' }) }));

  test('見守る人はSOS中にserverTimestampで確認印を付けられる', async () => {
    await assertSucceeds(updateDoc(doc(watcherDb, 'sessions/s-sos'), {
      sosAcknowledgedAt: serverTimestamp(),
    }));
  });

  test('歩く人・第三者は確認印を付けられない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s-sos'), { sosAcknowledgedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(attackerDb, 'sessions/s-sos'), { sosAcknowledgedAt: serverTimestamp() }));
  });

  test('見守る人もSOS以外の状態には確認印を付けられない', async () => {
    await seed({ 'sessions/s-active': activeSession() });
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s-active'), { sosAcknowledgedAt: serverTimestamp() }));
  });
});

// ═══════════════════════════════════════════════════════════════
// 恒久ペア P3 Stage 1（ADR: docs/adr-p3-permanent-pairs.md）。
//
// 守るべき不変条件（ADR §7）のうち、rules が担う分:
//   I-1 位置共有はセッション中のみ。ペアがあってもセッション外で位置が読める経路を作らない
//   I-2 位置共有の開始は歩く人の明示操作のみ（見守り手起点のペアセッション作成は不可）
//   I-3 歩く人はいつでも一方的に解除できる
//   I-5 関係の死は隠さない（staleSince はサーバー専用フィールド）
// ═══════════════════════════════════════════════════════════════

const hoursFromNow = (h) => new Date(Date.now() + h * 3600_000);

/** 見守り手が作った直後の招待（歩く人の席が空いている）。 */
const invitedPair = (overrides = {}) => ({
  status: 'invited',
  createdByUid: WATCHER,
  watcherUid: WATCHER,
  walkerUid: '',
  watcherDisplayName: 'おかあさん',
  watcherAvatar: 'woman',
  walkerDisplayName: '',
  walkerAvatar: 'star',
  createdAt: new Date(),
  inviteExpiresAt: hoursFromNow(24),
  ...overrides,
});

/** 二重同意が済んだペア。 */
const activePair = (overrides = {}) => invitedPair({
  status: 'active',
  walkerUid: WALKER,
  walkerDisplayName: 'はるか',
  walkerAvatar: 'girl',
  acceptedAt: new Date(),
  ...overrides,
});

/** 恒久ペア起点の歩行セッション（歩く人が自分で作る。waiting を経ない）。 */
const pairSession = (overrides = {}) => ({
  status: 'active',
  pairId: 'pair-active',
  watcherUid: WATCHER,
  walkerUid: WALKER,
  estimatedMinutes: 20,
  mode: 'sentinel',
  transport: 'vehicle_ok',
  createdAt: new Date(),
  startedAt: new Date(),
  expiresAt: hourFromNow(),
  ...overrides,
});

// ───────────────────────────────────────────────────────────────
describe('users/{uid}: FCMトークンは誰からも読めない（E-2）', () => {
  beforeEach(() => seed({
    'users/uid-watcher': {
      displayName: 'おかあさん', avatar: 'woman',
      fcmToken: 'WATCHER_DEVICE_TOKEN', lastSeenAt: new Date(),
    },
    'users/uid-walker': {
      displayName: 'はるか', avatar: 'girl',
      fcmToken: 'WALKER_DEVICE_TOKEN', lastSeenAt: new Date(),
    },
    'pairs/pair-active': activePair(),
  }));

  test('本人は自分の users 文書を読める', async () => {
    await assertSucceeds(getDoc(doc(watcherDb, 'users/uid-watcher')));
  });

  test('ペアの相手であっても他人の users 文書は読めない（トークンが載っているため）', async () => {
    await assertFails(getDoc(doc(walkerDb, 'users/uid-watcher')));
    await assertFails(getDoc(doc(watcherDb, 'users/uid-walker')));
  });

  test('第三者・未認証も読めない', async () => {
    await assertFails(getDoc(doc(attackerDb, 'users/uid-walker')));
    await assertFails(getDoc(doc(anonDb, 'users/uid-walker')));
  });

  test('users コレクションは誰も列挙できない（uid 総当たりの封じ）', async () => {
    await assertFails(getDocs(query(collection(watcherDb, 'users'), limit(50))));
    await assertFails(getDocs(query(collection(attackerDb, 'users'), limit(50))));
  });

  test('他人の users 文書には書けない', async () => {
    await assertFails(updateDoc(doc(attackerDb, 'users/uid-walker'), { fcmToken: 'STOLEN' }));
    await assertFails(setDoc(doc(attackerDb, 'users/uid-walker'), { displayName: 'なりすまし' }));
  });
});

describe('users/{uid}: 本人による編集の検証', () => {
  test('本人は作成・更新できる', async () => {
    await assertSucceeds(setDoc(doc(watcherDb, 'users/uid-watcher'), {
      displayName: 'おかあさん', avatar: 'woman', fcmToken: 'T', lastSeenAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(watcherDb, 'users/uid-watcher'), { displayName: 'かあさん' }));
  });

  test('表示名は30文字まで・文字列のみ', async () => {
    await assertFails(setDoc(doc(watcherDb, 'users/uid-watcher'), { displayName: 'あ'.repeat(31) }));
    await assertFails(setDoc(doc(watcherDb, 'users/uid-watcher'), { displayName: 12345 }));
  });

  test('アバターはプリセットIDのみ', async () => {
    await assertSucceeds(setDoc(doc(watcherDb, 'users/uid-watcher'), { avatar: 'cat' }));
    await assertFails(setDoc(doc(watcherDb, 'users/uid-watcher'), { avatar: 'https://evil/img.png' }));
  });

  test('lastSeenAt はサーバー時刻しか書けない（死活可視化 I-5 の根拠を偽装させない）', async () => {
    await assertFails(setDoc(doc(watcherDb, 'users/uid-watcher'), { lastSeenAt: hoursFromNow(240) }));
    await assertSucceeds(setDoc(doc(watcherDb, 'users/uid-watcher'), { lastSeenAt: serverTimestamp() }));
  });

  test('lastSeenAt を触らない更新は、既存の古い値のままでも通る', async () => {
    await seed({ 'users/uid-watcher': { displayName: 'x', lastSeenAt: new Date(Date.now() - 86_400_000) } });
    await assertSucceeds(updateDoc(doc(watcherDb, 'users/uid-watcher'), { displayName: 'y' }));
  });

  test('モデル外のフィールド（課金資格を含む）は書けない', async () => {
    await assertFails(setDoc(doc(watcherDb, 'users/uid-watcher'), { isAdmin: true }));
    // entitlements は Cloud Functions（購入検証）専用。自分の分でも書けない
    await assertFails(setDoc(doc(watcherDb, 'users/uid-watcher'), {
      entitlements: { group: { active: true } },
    }));
  });
});

/** 課金資格（月額サブスク D-11）を持つ見守り手の users 文書。書き手は Functions のみ。 */
const entitledUser = (overrides = {}) => ({
  displayName: 'おかあさん',
  avatar: 'woman',
  fcmToken: 'WATCHER_DEVICE_TOKEN',
  lastSeenAt: new Date(),
  entitlements: { group: { active: true, expiresAt: hoursFromNow(24 * 30), source: 'revenuecat' } },
  ...overrides,
});

// ───────────────────────────────────────────────────────────────
describe('pairs: 招待の作成（現行方向のみ）', () => {
  // 恒久ペアは有料機能（v3 §2.5）。作成テストは資格ありを前提にする。
  beforeEach(() => seed({ 'users/uid-watcher': entitledUser() }));

  test('見守り手は自分の席で招待を作れる', async () => {
    await assertSucceeds(setDoc(doc(watcherDb, 'pairs/new-1'), invitedPair()));
  });

  test('他人を見守り手にした招待は作れない', async () => {
    await assertFails(setDoc(doc(attackerDb, 'pairs/new-2'), invitedPair()));
  });

  test('歩く人をあらかじめ埋め込んだ招待は作れない（二重同意を飛ばせない）', async () => {
    await assertFails(setDoc(doc(watcherDb, 'pairs/new-3'), invitedPair({ walkerUid: WALKER })));
  });

  test('逆方向の招待（歩く人が作り見守り手の席が空く）はまだ作れない（Stage 3）', async () => {
    await assertFails(setDoc(doc(walkerDb, 'pairs/new-4'), {
      status: 'invited', createdByUid: WALKER, walkerUid: WALKER, watcherUid: '',
      createdAt: new Date(), inviteExpiresAt: hoursFromNow(1),
    }));
  });

  test('最初から active な（同意なしの）ペアは作れない', async () => {
    await assertFails(setDoc(doc(watcherDb, 'pairs/new-5'), invitedPair({ status: 'active' })));
  });

  test('期限切れ・24時間を超える招待は作れない', async () => {
    await assertFails(setDoc(doc(watcherDb, 'pairs/new-6'), invitedPair({ inviteExpiresAt: new Date(Date.now() - 1000) })));
    await assertFails(setDoc(doc(watcherDb, 'pairs/new-7'), invitedPair({ inviteExpiresAt: hoursFromNow(72) })));
  });

  test('サーバー専用フィールドを混ぜた招待は作れない', async () => {
    await assertFails(setDoc(doc(watcherDb, 'pairs/new-8'), invitedPair({
      lastSessionSummary: { endedAt: new Date(), finalStatus: 'arrived', destinationLabel: 'x' },
    })));
    await assertFails(setDoc(doc(watcherDb, 'pairs/new-9'), invitedPair({ staleSince: new Date() })));
  });
});

// ───────────────────────────────────────────────────────────────
// 課金ゲート（v3移行設計書 §2.5.3 / D-11 月額サブスク）。
// 売るのは「同時人数と常設リストという利便」だけで、安全機能は課金壁の内側に置かない。
// 資格が切れたときにペアを人質に取らない（休眠）ことも、ここで固定する。
describe('pairs: 相手の呼び名と年齢（D-8）', () => {
  beforeEach(() => seed({
    'users/uid-watcher': entitledUser(),
    'pairs/p': activePair(),
    'pairs/p-invited': invitedPair(),
  }));

  test('見守る人は呼び名と年齢を預けられる', async () => {
    await assertSucceeds(updateDoc(doc(watcherDb, 'pairs/p'), {
      walkerLabel: { name: 'はるちゃん', age: 8 },
    }));
  });

  test('年齢は任意（呼び名だけでも預けられる）', async () => {
    await assertSucceeds(updateDoc(doc(watcherDb, 'pairs/p'), {
      walkerLabel: { name: 'はるちゃん', age: null },
    }));
  });

  test('歩く人は自分の呼び名・年齢を書けない（入力者と用途を一致させる）', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'pairs/p'), {
      walkerLabel: { name: 'はるか', age: 8 },
    }));
  });

  test('第三者は書けない', async () => {
    await assertFails(updateDoc(doc(attackerDb, 'pairs/p'), {
      walkerLabel: { name: 'x', age: 1 },
    }));
  });

  test('決めた形以外は書けない（別の情報の置き場にさせない）', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'pairs/p'), {
      walkerLabel: { name: 'はるちゃん', age: 8, note: '学校は◯◯小' },
    }));
    await assertFails(updateDoc(doc(watcherDb, 'pairs/p'), {
      walkerLabel: { name: 'あ'.repeat(31), age: 8 },
    }));
    await assertFails(updateDoc(doc(watcherDb, 'pairs/p'), {
      walkerLabel: { name: 'はるちゃん', age: 999 },
    }));
    await assertFails(updateDoc(doc(watcherDb, 'pairs/p'), {
      walkerLabel: { name: 'はるちゃん', age: '8' },
    }));
    await assertFails(updateDoc(doc(watcherDb, 'pairs/p'), {
      walkerLabel: { name: 'はるちゃん', age: -1 },
    }));
  });

  test('呼び名の更新にまぎれて席や状態を動かせない', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'pairs/p'), {
      walkerLabel: { name: 'はるちゃん', age: 8 },
      walkerUid: ATTACKER,
    }));
    await assertFails(updateDoc(doc(watcherDb, 'pairs/p'), {
      walkerLabel: { name: 'はるちゃん', age: 8 },
      status: 'invited',
    }));
  });

  test('成立していないペア（招待中）には預けられない', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'pairs/p-invited'), {
      walkerLabel: { name: 'はるちゃん', age: 8 },
    }));
  });

  test('解除済みのペアには預けられない（関係が終わっていれば預かりも終わる）', async () => {
    await seed({ 'pairs/p-revoked': activePair({ status: 'revoked', revokedByUid: WATCHER, revokedAt: new Date() }) });
    await assertFails(updateDoc(doc(watcherDb, 'pairs/p-revoked'), {
      walkerLabel: { name: 'はるちゃん', age: 8 },
    }));
  });

  test('招待の作成時には呼び名を入れられない（招待リンクを持つ第三者に読まれるため）', async () => {
    // pairId を知っている人は isOpenInvite 経由で招待を get できる。まだ承諾して
    // いない相手の呼び名・年齢がそこから読めてしまうので、預けられるのは成立後だけ。
    await assertFails(setDoc(doc(watcherDb, 'pairs/label-new'), invitedPair({
      walkerLabel: { name: 'はるちゃん', age: 8 },
    })));
  });
});

// ───────────────────────────────────────────────────────────────
describe('pairs: entitlement ゲート（有料機能）', () => {
  test('users 文書が無ければペアは作れない', async () => {
    await assertFails(setDoc(doc(watcherDb, 'pairs/ent-1'), invitedPair()));
  });

  test('資格を持たない見守り手はペアを作れない', async () => {
    await seed({ 'users/uid-watcher': entitledUser({ entitlements: {} }) });
    await assertFails(setDoc(doc(watcherDb, 'pairs/ent-2'), invitedPair()));
  });

  test('資格が失効している（active:false）ならペアを作れない', async () => {
    await seed({
      'users/uid-watcher': entitledUser({
        entitlements: { group: { active: false, expiresAt: new Date(Date.now() - 1000), source: 'revenuecat' } },
      }),
    });
    await assertFails(setDoc(doc(watcherDb, 'pairs/ent-3'), invitedPair()));
  });

  test('資格があればペアを作れる', async () => {
    await seed({ 'users/uid-watcher': entitledUser() });
    await assertSucceeds(setDoc(doc(watcherDb, 'pairs/ent-4'), invitedPair()));
  });

  test('active:true のままでも期限が過ぎていればペアを作れない（失効webhookの取りこぼしを塞ぐ）', async () => {
    await seed({
      'users/uid-watcher': entitledUser({
        entitlements: { group: { active: true, expiresAt: new Date(Date.now() - 1000), source: 'revenuecat' } },
      }),
    });
    await assertFails(setDoc(doc(watcherDb, 'pairs/ent-5'), invitedPair()));
  });

  test('期限なし（買い切り・手動付与）の資格は通る', async () => {
    await seed({
      'users/uid-watcher': entitledUser({
        entitlements: { group: { active: true, expiresAt: null, source: 'manual' } },
      }),
    });
    await assertSucceeds(setDoc(doc(watcherDb, 'pairs/ent-6'), invitedPair()));
  });

  test('資格が無くても、既にあるペアの受諾・解除・表示名更新は通る（休眠。データを人質に取らない）', async () => {
    await seed({
      'users/uid-watcher': entitledUser({ entitlements: {} }),
      'pairs/p-dormant': invitedPair(),
      'pairs/p-active': activePair(),
    });
    await assertSucceeds(updateDoc(doc(walkerDb, 'pairs/p-dormant'), {
      walkerUid: WALKER, status: 'active', acceptedAt: serverTimestamp(),
      walkerDisplayName: 'はるか', walkerAvatar: 'girl',
    }));
    await assertSucceeds(updateDoc(doc(watcherDb, 'pairs/p-active'), { watcherDisplayName: 'ははおや' }));
    await assertSucceeds(updateDoc(doc(walkerDb, 'pairs/p-active'), {
      status: 'revoked', revokedByUid: WALKER, revokedAt: serverTimestamp(),
    }));
  });
});

// ───────────────────────────────────────────────────────────────
// ペア起点の見守り開始（2026-08-26 決定①）。
// 「見守り手が依頼 → 歩く人が承諾」。依頼を作った時点では walkerUid が空なので、
// 位置は1点も流れない。承諾（＝歩く人の端末操作）が開始条件という不変条件（I-2）を
// 構造で守れているかをここで固定する。
describe('ペア起点の見守り依頼と承諾（決定① / I-2）', () => {
  const pairRequest = (overrides = {}) => waitingSession({ pairId: 'pair-active', ...overrides });

  beforeEach(() => seed({
    'users/uid-watcher': entitledUser(),
    'pairs/pair-active': activePair(),
    'pairs/pair-invited': invitedPair(),
    'pairs/pair-revoked': activePair({ status: 'revoked', revokedByUid: WATCHER, revokedAt: new Date() }),
  }));

  test('ペアの見守り手は見守り依頼を作れる', async () => {
    await assertSucceeds(setDoc(doc(watcherDb, 'sessions/req-1'), pairRequest()));
  });

  test('依頼の時点では歩く人の席は空で、位置は入っていない', async () => {
    await setDoc(doc(watcherDb, 'sessions/req-2'), pairRequest());
    const snap = await getDoc(doc(watcherDb, 'sessions/req-2'));
    expect(snap.data().walkerUid ?? '').toBe('');
    expect(snap.data().latitude).toBeUndefined();
  });

  test('ペアの当事者でない人は、そのペアIDで依頼を作れない', async () => {
    await assertFails(setDoc(doc(attackerDb, 'sessions/req-3'), pairRequest({ watcherUid: ATTACKER })));
  });

  test('見守り手を騙って依頼を作れない', async () => {
    await assertFails(setDoc(doc(attackerDb, 'sessions/req-4'), pairRequest()));
  });

  test('成立前（invited）・解除済み（revoked）のペアでは依頼を作れない', async () => {
    await assertFails(setDoc(doc(watcherDb, 'sessions/req-5'), pairRequest({ pairId: 'pair-invited' })));
    await assertFails(setDoc(doc(watcherDb, 'sessions/req-6'), pairRequest({ pairId: 'pair-revoked' })));
  });

  test('依頼に許可リスト外のフィールドを混ぜられない（ペアへ任意テキストを流し込ませない）', async () => {
    await assertFails(setDoc(doc(watcherDb, 'sessions/req-x1'), pairRequest({
      destinationLabel: 'あ'.repeat(500),
    })));
    await assertFails(setDoc(doc(watcherDb, 'sessions/req-x2'), pairRequest({
      placeLabel: '見守り手が仕込んだ任意のテキスト',
    })));
    await assertFails(setDoc(doc(watcherDb, 'sessions/req-x3'), pairRequest({ latitude: 35.6 })));
  });

  test('存在しないペアIDでは依頼を作れない', async () => {
    await assertFails(setDoc(doc(watcherDb, 'sessions/req-7'), pairRequest({ pairId: 'pair-nope' })));
  });

  test('ペアの歩く人は依頼を承諾できる（承諾＝端末操作で初めて動き出す）', async () => {
    await seed({ 'sessions/req-8': pairRequest() });
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/req-8'), {
      walkerUid: WALKER, walkerFcmToken: 'WALKER_TOKEN', status: 'active', startedAt: serverTimestamp(),
    }));
  });

  test('ペア外の第三者は、依頼IDを知っていても承諾できない（依頼はリンクを配らない）', async () => {
    await seed({ 'sessions/req-9': pairRequest() });
    await assertFails(updateDoc(doc(attackerDb, 'sessions/req-9'), {
      walkerUid: ATTACKER, walkerFcmToken: 'X', status: 'active', startedAt: serverTimestamp(),
    }));
  });

  test('解除後のペアの依頼は承諾できない（関係が終わっていれば見守りも始まらない）', async () => {
    await seed({ 'sessions/req-10': pairRequest({ pairId: 'pair-revoked' }) });
    await assertFails(updateDoc(doc(walkerDb, 'sessions/req-10'), {
      walkerUid: WALKER, walkerFcmToken: 'WALKER_TOKEN', status: 'active', startedAt: serverTimestamp(),
    }));
  });

  test('承諾前の依頼には、歩く人でも位置を書けない（承諾が開始条件）', async () => {
    await seed({ 'sessions/req-11': pairRequest() });
    await assertFails(updateDoc(doc(walkerDb, 'sessions/req-11'), {
      latitude: 35.6, longitude: 139.7, locationUpdatedAt: serverTimestamp(),
    }));
  });

  test('歩く人は地名ラベルを書ける（D-14。終端時に Functions がペアへ転記する）', async () => {
    await seed({ 'sessions/req-place': activeSession({ pairId: 'pair-active' }) });
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/req-place'), { placeLabel: '東京都 世田谷区 三軒茶屋' }));
  });

  test('長すぎる地名ラベル・文字列でない地名ラベルは書けない', async () => {
    await seed({ 'sessions/req-place2': activeSession({ pairId: 'pair-active' }) });
    await assertFails(updateDoc(doc(walkerDb, 'sessions/req-place2'), { placeLabel: 'あ'.repeat(61) }));
    await assertFails(updateDoc(doc(walkerDb, 'sessions/req-place2'), { placeLabel: 35.6812 }));
  });

  test('見守り手は地名ラベルを書けない（歩く人の場所を見守り手が名付けない）', async () => {
    await seed({ 'sessions/req-place3': activeSession({ pairId: 'pair-active' }) });
    await assertFails(updateDoc(doc(watcherDb, 'sessions/req-place3'), { placeLabel: 'どこか' }));
  });

  test('従来のリンク招待（pairId なし）の参加は無変更で通る（加算性の確認）', async () => {
    await seed({ 'sessions/req-12': waitingSession() });
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/req-12'), {
      walkerUid: WALKER, walkerFcmToken: 'WALKER_TOKEN', status: 'active', startedAt: serverTimestamp(),
    }));
  });
});

// ───────────────────────────────────────────────────────────────
describe('pairs: 読み取りの範囲', () => {
  beforeEach(() => seed({
    'pairs/pair-invited': invitedPair(),
    'pairs/pair-active': activePair(),
    'pairs/pair-others': activePair({ watcherUid: 'uid-x', walkerUid: 'uid-y' }),
    'pairs/pair-expired': invitedPair({ inviteExpiresAt: new Date(Date.now() - 1000) }),
  }));

  test('当事者は自分のペアを読める', async () => {
    await assertSucceeds(getDoc(doc(watcherDb, 'pairs/pair-active')));
    await assertSucceeds(getDoc(doc(walkerDb, 'pairs/pair-active')));
  });

  test('招待トークン（pairId）を知っていれば、期限内の招待を読める', async () => {
    await assertSucceeds(getDoc(doc(walkerDb, 'pairs/pair-invited')));
  });

  test('期限切れの招待は、トークンを知っていても読めない', async () => {
    // 使い回しのクライアントはローカルキャッシュを持つため、getDoc が rules を
    // 経由せずに解決してしまうことがある。期限の判定はサーバーでしか下せないので、
    // この1件だけは新しいクライアントから読む。
    const freshWalkerDb = testEnv.authenticatedContext(WALKER).firestore();
    await assertFails(getDoc(doc(freshWalkerDb, 'pairs/pair-expired')));
  });

  test('他人のペアは読めない', async () => {
    await assertFails(getDoc(doc(attackerDb, 'pairs/pair-others')));
    await assertFails(getDoc(doc(walkerDb, 'pairs/pair-others')));
  });

  test('他人のペアは列挙できない（招待の列挙で見守り手の情報を漏らさない）', async () => {
    await assertFails(getDocs(query(collection(attackerDb, 'pairs'), limit(50))));
    await assertFails(getDocs(query(
      collection(attackerDb, 'pairs'), where('status', '==', 'invited'), limit(50))));
    await assertFails(getDocs(query(
      collection(attackerDb, 'pairs'), where('walkerUid', '==', ''), limit(50))));
    await assertFails(getDocs(query(
      collection(attackerDb, 'pairs'), where('watcherUid', '==', WATCHER), limit(50))));
  });

  test('自分が当事者のペアは列挙できる（つながり一覧）', async () => {
    await assertSucceeds(getDocs(query(
      collection(watcherDb, 'pairs'), where('watcherUid', '==', WATCHER), limit(50))));
    await assertSucceeds(getDocs(query(
      collection(walkerDb, 'pairs'), where('walkerUid', '==', WALKER), limit(50))));
  });
});

// ───────────────────────────────────────────────────────────────
describe('pairs: 招待の受諾（二重同意）', () => {
  beforeEach(() => seed({ 'pairs/p': invitedPair() }));

  const accept = (db, uid, extra = {}) => updateDoc(doc(db, 'pairs/p'), {
    walkerUid: uid, status: 'active', acceptedAt: serverTimestamp(),
    walkerDisplayName: 'はるか', walkerAvatar: 'girl', ...extra,
  });

  test('招待を受けた別人は受諾できる', async () => {
    await assertSucceeds(accept(walkerDb, WALKER));
  });

  test('作成者自身は受諾できない（1人2役のペアは見守りの実体がない）', async () => {
    await assertFails(accept(watcherDb, WATCHER));
  });

  test('他人の uid を歩く人として書き込めない', async () => {
    await assertFails(accept(walkerDb, 'someone-else'));
  });

  test('すでに成立したペアには割り込めない', async () => {
    await seed({ 'pairs/p2': activePair() });
    await assertFails(updateDoc(doc(attackerDb, 'pairs/p2'), {
      walkerUid: ATTACKER, status: 'active', acceptedAt: serverTimestamp(),
    }));
  });

  test('期限切れの招待は受諾できない', async () => {
    await seed({ 'pairs/p-exp': invitedPair({ inviteExpiresAt: new Date(Date.now() - 1000) }) });
    await assertFails(updateDoc(doc(walkerDb, 'pairs/p-exp'), {
      walkerUid: WALKER, status: 'active', acceptedAt: serverTimestamp(),
    }));
  });

  test('解除済みのペアは受諾で復活させられない', async () => {
    await seed({ 'pairs/p-rev': activePair({ status: 'revoked', walkerUid: '', revokedByUid: WATCHER }) });
    await assertFails(updateDoc(doc(walkerDb, 'pairs/p-rev'), {
      walkerUid: WALKER, status: 'active', acceptedAt: serverTimestamp(),
    }));
  });

  test('受諾のついでに見守り手の席・表示名を書き換えられない', async () => {
    await assertFails(accept(walkerDb, WALKER, { watcherUid: WALKER }));
    await assertFails(accept(walkerDb, WALKER, { watcherDisplayName: 'にせもの' }));
  });

  test('受諾のついでにサーバー専用フィールドを書けない', async () => {
    await assertFails(accept(walkerDb, WALKER, { staleSince: null }));
    await assertFails(accept(walkerDb, WALKER, {
      lastSessionSummary: { endedAt: new Date(), finalStatus: 'arrived', destinationLabel: 'x' },
    }));
  });

  test('acceptedAt を省いて受諾できない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'pairs/p'), {
      walkerUid: WALKER, status: 'active', walkerDisplayName: 'はるか', walkerAvatar: 'girl',
    }));
  });

  test('acceptedAt はサーバー時刻でなければならない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'pairs/p'), {
      walkerUid: WALKER, status: 'active', acceptedAt: hoursFromNow(24),
    }));
  });
});

// ───────────────────────────────────────────────────────────────
describe('pairs: 解除（I-3）と解除後の遮断', () => {
  beforeEach(() => seed({
    'pairs/p': activePair(),
    'pairs/p-invited': invitedPair(),
  }));

  const revoke = (db, uid) => updateDoc(doc(db, 'pairs/p'), {
    status: 'revoked', revokedAt: serverTimestamp(), revokedByUid: uid,
  });

  test('revokedAt を省いて解除できない（省けると7日 purge のクエリに載らず永久に消えない）', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'pairs/p'), {
      status: 'revoked', revokedByUid: WALKER,
    }));
  });

  test('歩く人は一方的に解除できる（監視化の防波堤）', async () => {
    await assertSucceeds(revoke(walkerDb, WALKER));
  });

  test('見守り手も一方的に解除できる', async () => {
    await assertSucceeds(revoke(watcherDb, WATCHER));
  });

  test('第三者は解除できない', async () => {
    await assertFails(revoke(attackerDb, ATTACKER));
  });

  test('他人の名前で解除したことにできない（解除の通知先を偽装させない）', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'pairs/p'), {
      status: 'revoked', revokedAt: serverTimestamp(), revokedByUid: WATCHER,
    }));
  });

  test('招待中のものは、作った本人だけが取り消せる', async () => {
    await assertFails(updateDoc(doc(attackerDb, 'pairs/p-invited'), {
      status: 'revoked', revokedAt: serverTimestamp(), revokedByUid: ATTACKER,
    }));
    await assertSucceeds(updateDoc(doc(watcherDb, 'pairs/p-invited'), {
      status: 'revoked', revokedAt: serverTimestamp(), revokedByUid: WATCHER,
    }));
  });

  test('解除済みのペアは active に戻せない（復活不可）', async () => {
    await seed({ 'pairs/p-rev': activePair({ status: 'revoked', revokedByUid: WALKER }) });
    await assertFails(updateDoc(doc(watcherDb, 'pairs/p-rev'), { status: 'active' }));
    await assertFails(updateDoc(doc(walkerDb, 'pairs/p-rev'), { status: 'active' }));
  });

  test('解除済みのペアでは表示名も更新できない（関係そのものが終わっている）', async () => {
    await seed({ 'pairs/p-rev': activePair({ status: 'revoked', revokedByUid: WALKER }) });
    await assertFails(updateDoc(doc(walkerDb, 'pairs/p-rev'), { walkerDisplayName: 'べつのなまえ' }));
  });

  test('ペアは誰も削除できない（削除は Cloud Functions のみ）', async () => {
    await assertFails(deleteDoc(doc(watcherDb, 'pairs/p')));
    await assertFails(deleteDoc(doc(walkerDb, 'pairs/p')));
  });
});

// ───────────────────────────────────────────────────────────────
describe('pairs: 表示名・アバターの複製は自分の分だけ', () => {
  beforeEach(() => seed({ 'pairs/p': activePair() }));

  test('自分の表示名・アバターは更新できる', async () => {
    await assertSucceeds(updateDoc(doc(walkerDb, 'pairs/p'), {
      walkerDisplayName: 'はるちゃん', walkerAvatar: 'boy',
    }));
    await assertSucceeds(updateDoc(doc(watcherDb, 'pairs/p'), {
      watcherDisplayName: 'かあさん', watcherAvatar: 'grandma',
    }));
  });

  test('相手の表示名・アバターは書き換えられない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'pairs/p'), { watcherDisplayName: 'にせもの' }));
    await assertFails(updateDoc(doc(watcherDb, 'pairs/p'), { walkerAvatar: 'dog' }));
  });

  test('プリセット外のアバター・長すぎる名前は書けない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'pairs/p'), { walkerAvatar: 'evil' }));
    await assertFails(updateDoc(doc(walkerDb, 'pairs/p'), { walkerDisplayName: 'あ'.repeat(31) }));
  });

  test('サーバー専用フィールド（lastSessionSummary / staleSince）は当事者でも書けない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'pairs/p'), {
      lastSessionSummary: { endedAt: serverTimestamp(), finalStatus: 'arrived', destinationLabel: 'うそ' },
    }));
    await assertFails(updateDoc(doc(watcherDb, 'pairs/p'), { staleSince: null }));
  });
});

// ───────────────────────────────────────────────────────────────
// E-4: 恒久ペアを根拠にした歩行セッションの作成。
// I-2 の要（見守り手が遠隔で相手の位置共有を開始できないこと）はここで守られる。
describe('恒久ペア起点のセッション作成（E-4 / I-2）', () => {
  beforeEach(() => seed({
    'pairs/pair-active': activePair(),
    'pairs/pair-invited': invitedPair({ walkerUid: '' }),
    'pairs/pair-revoked': activePair({ status: 'revoked', revokedByUid: WATCHER }),
    'pairs/pair-others': activePair({ watcherUid: 'uid-x', walkerUid: 'uid-y' }),
  }));

  test('active なペアの歩く人はセッションを作れる', async () => {
    await assertSucceeds(setDoc(doc(walkerDb, 'sessions/ps1'), pairSession()));
  });

  test('見守り手は歩く人のセッションを作れない（遠隔で位置共有を開始できない）', async () => {
    await assertFails(setDoc(doc(watcherDb, 'sessions/ps2'), pairSession()));
    // 自分を walker に据え替えてもペアの walkerUid と一致しないので通らない
    await assertFails(setDoc(doc(watcherDb, 'sessions/ps3'), pairSession({ walkerUid: WATCHER })));
  });

  test('二重同意前（invited）のペアではセッションを作れない', async () => {
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps4'), pairSession({ pairId: 'pair-invited' })));
  });

  test('解除済み（revoked）のペアではセッションを作れない', async () => {
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps5'), pairSession({ pairId: 'pair-revoked' })));
  });

  test('他人のペアIDを騙ってセッションを作れない', async () => {
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps6'), pairSession({
      pairId: 'pair-others', watcherUid: 'uid-x',
    })));
    await assertFails(setDoc(doc(attackerDb, 'sessions/ps7'), pairSession({ walkerUid: ATTACKER })));
  });

  test('存在しないペアIDでは作れない', async () => {
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps8'), pairSession({ pairId: 'no-such-pair' })));
  });

  test('ペアと違う相手を見守り手に据えられない', async () => {
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps9'), pairSession({ watcherUid: ATTACKER })));
  });

  test('status は active のみ・期限切れ/不正な所要時間では作れない', async () => {
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps10'), pairSession({ status: 'waiting' })));
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps11'), pairSession({ status: 'sos' })));
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps12'), pairSession({ expiresAt: new Date(Date.now() - 1000) })));
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps13'), pairSession({ estimatedMinutes: 0 })));
  });

  test('目的地ラベルは30文字までの文字列のみ（座標・住所を持ち込ませない）', async () => {
    await assertSucceeds(setDoc(doc(walkerDb, 'sessions/ps14'), pairSession({ destinationLabel: 'ひまわり学童保育室' })));
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps15'), pairSession({ destinationLabel: 'あ'.repeat(31) })));
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps16'), pairSession({ destinationLabel: 35.68 })));
  });

  test('許可リスト外のフィールドを混ぜて作れない', async () => {
    // 見守り手のトークンを歩く人が仕込めると、見守り手宛ての通知を横取りできる
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps17'), pairSession({ watcherFcmToken: 'STOLEN' })));
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps18'), pairSession({ walkerPhone: '09012345678' })));
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps19'), pairSession({ sosAcknowledgedAt: serverTimestamp() })));
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps20'), pairSession({ autoEnded: true })));
    // 作成時に位置を持ち込ませない（歩き始めの書き込みは通常の update 経路で行う）
    await assertFails(setDoc(doc(walkerDb, 'sessions/ps21'), pairSession({ latitude: 35.6, longitude: 139.7 })));
  });

  test('従来の見守り手起点のセッション作成は無変更で通る（加算性の確認）', async () => {
    await assertSucceeds(setDoc(doc(watcherDb, 'sessions/legacy'), waitingSession()));
  });

  test('ペア起点セッションでも、位置が読めるのは当事者だけ（I-1）', async () => {
    await assertSucceeds(setDoc(doc(walkerDb, 'sessions/ps-read'), pairSession()));
    await assertSucceeds(getDoc(doc(watcherDb, 'sessions/ps-read')));
    await assertFails(getDoc(doc(attackerDb, 'sessions/ps-read')));
  });
});

// ───────────────────────────────────────────────────────────────
// B-2: status の値検証。歩く人は状態機械の外へ出られない。
describe('セッション status の値検証（B-2）', () => {
  beforeEach(() => seed({ 'sessions/s': activeSession() }));

  test('歩く人は waiting へ巻き戻せない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { status: 'waiting' }));
  });

  test('歩く人は未知の status を書けない', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { status: 'pwned' }));
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { status: '' }));
  });

  test('正当な status への遷移は従来どおり通る', async () => {
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/s'), { status: 'alert' }));
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/s'), { status: 'active' }));
  });
});

// ───────────────────────────────────────────────────────────────
// 位置共有の強さ（locationMode / H-2）。
// 歩く人の端末だけが書ける1語で、見守り側の「位置が届いていません」の根拠になる。
// 見守り側から書けてしまうと、この警告そのものを消せる（＝静かな失敗を作れる）。
describe('位置共有の強さ locationMode（H-2）', () => {
  beforeEach(() => seed({ 'sessions/s': activeSession() }));

  test('歩く人は許可リストの値を書ける', async () => {
    for (const mode of ['background', 'foreground', 'none']) {
      await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/s'), { locationMode: mode }));
    }
  });

  test('未知の値・型ちがいは書けない（このフィールドを別の情報の置き場にしない）', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { locationMode: 'always' }));
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { locationMode: '' }));
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s'), { locationMode: 1 }));
  });

  test('見守る人は書けない（警告を消せてはいけない）', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s'), { locationMode: 'background' }));
  });

  test('第三者は書けない', async () => {
    await assertFails(updateDoc(doc(attackerDb, 'sessions/s'), { locationMode: 'background' }));
  });

  test('終端済みセッションには書けない（既存の終端ガードに乗る）', async () => {
    await seed({ 'sessions/s-ended': activeSession({ status: 'ended' }) });
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s-ended'), { locationMode: 'none' }));
  });
});

// ───────────────────────────────────────────────────────────────
// 見守る人からのセッション終了（F-10 / watcher-exit ADR E3 / H-6）。
// 「出口は常に存在させ、危険度は摩擦と文言で表す」という決定Cを rules 側で支えるが、
// 終わらせてよいのは自分が見守っている進行中のセッションだけ。
describe('見守る人からのセッション終了（F-10 / E3）', () => {
  beforeEach(() => seed({
    'sessions/s-active': activeSession(),
    'sessions/s-sos': activeSession({ status: 'sos' }),
    'sessions/s-waiting': waitingSession(),
    'sessions/s-arrived': activeSession({ status: 'arrived' }),
    'sessions/s-ended': activeSession({ status: 'ended' }),
    'sessions/s-alert': activeSession({ status: 'alert' }),
    'sessions/s-anomaly': activeSession({ status: 'anomaly' }),
  }));

  test('見守る人は進行中の見守りを終了できる', async () => {
    await assertSucceeds(updateDoc(doc(watcherDb, 'sessions/s-active'), {
      status: 'ended', endedAt: serverTimestamp(), endedBy: 'watcher',
    }));
  });

  test('SOS中でも終了できる（禁止は密室の再生産になる。決定C）', async () => {
    await assertSucceeds(updateDoc(doc(watcherDb, 'sessions/s-sos'), {
      status: 'ended', endedAt: serverTimestamp(), endedBy: 'watcher',
    }));
  });

  test('endedAt はサーバー時刻が必須（クライアント時計で終了時刻を作れない）', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s-active'), {
      status: 'ended', endedBy: 'watcher',
    }));
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s-active'), {
      status: 'ended', endedAt: new Date(0), endedBy: 'watcher',
    }));
  });

  test('第三者は終了できない', async () => {
    await assertFails(updateDoc(doc(attackerDb, 'sessions/s-active'), {
      status: 'ended', endedAt: serverTimestamp(), endedBy: 'watcher',
    }));
  });

  test('終端済み（到着・終了）からは終了できない', async () => {
    for (const id of ['s-arrived', 's-ended']) {
      await assertFails(updateDoc(doc(watcherDb, `sessions/${id}`), {
        status: 'ended', endedAt: serverTimestamp(), endedBy: 'watcher',
      }));
    }
  });

  test('参加待ちからは ended にできない（あちらは cancelled の担当）', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s-waiting'), {
      status: 'ended', endedAt: serverTimestamp(), endedBy: 'watcher',
    }));
    await assertSucceeds(updateDoc(doc(watcherDb, 'sessions/s-waiting'), {
      status: 'cancelled', endedAt: serverTimestamp(),
    }));
  });

  test('endedBy は終了遷移とセットでしか書けない（通知の文言分岐を騙せない）', async () => {
    // status を動かさずに endedBy だけ書く
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s-active'), { endedBy: 'watcher' }));
    // 歩く人が終わらせたことにする値も書けない
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s-active'), {
      status: 'ended', endedAt: serverTimestamp(), endedBy: 'walker',
    }));
  });

  test('endedBy 無しの見守り側終了は拒否（通知ゼロ＋嘘の理由表示になるため）', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s-active'), {
      status: 'ended', endedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s-sos'), {
      status: 'ended', endedAt: serverTimestamp(),
    }));
  });

  test('異変・応答なしからの終了も endedBy 付きなら通る', async () => {
    for (const id of ['s-alert', 's-anomaly']) {
      await assertSucceeds(updateDoc(doc(watcherDb, `sessions/${id}`), {
        status: 'ended', endedAt: serverTimestamp(), endedBy: 'watcher',
      }));
    }
  });

  test('endedBy は歩く人からも書けない（許可リストの外）', async () => {
    await assertFails(updateDoc(doc(walkerDb, 'sessions/s-active'), {
      status: 'ended', endedAt: serverTimestamp(), endedBy: 'watcher',
    }));
  });

  test('歩く人自身の終了は従来どおり通る（endedBy 無し）', async () => {
    await assertSucceeds(updateDoc(doc(walkerDb, 'sessions/s-active'), {
      status: 'ended', endedAt: serverTimestamp(),
    }));
  });

  test('endedBy の削除書き込みも通らない（終了理由を後から消せない）', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s-active'), {
      status: 'ended', endedAt: serverTimestamp(), endedBy: deleteField(),
    }));
  });

  test('終了に他のフィールドを相乗りさせられない', async () => {
    await assertFails(updateDoc(doc(watcherDb, 'sessions/s-active'), {
      status: 'ended', endedAt: serverTimestamp(), endedBy: 'watcher', autoEnded: true,
    }));
  });
});
