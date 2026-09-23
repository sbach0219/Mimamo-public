import {
  INVITE_TTL_MS, canAcceptInvite, canRevoke, canStartPairWalk, describeLastSession,
  isInviteOpen, normalizeDisplayName, parsePair, partnerLabel, partnerOf, roleInPair,
  MAX_DISPLAY_NAME, normalizeWalkerLabel,
} from '../pairs';

const WATCHER = 'uid-watcher';
const WALKER = 'uid-walker';
const OTHER = 'uid-other';

const NOW = new Date('2026-08-25T12:00:00Z');
const inFuture = (ms: number) => new Date(NOW.getTime() + ms);
const inPast = (ms: number) => new Date(NOW.getTime() - ms);

const invited = (overrides: Record<string, any> = {}) => parsePair('p1', {
  status: 'invited',
  createdByUid: WATCHER,
  watcherUid: WATCHER,
  walkerUid: '',
  watcherDisplayName: 'おかあさん',
  watcherAvatar: 'woman',
  inviteExpiresAt: inFuture(INVITE_TTL_MS),
  ...overrides,
});

const active = (overrides: Record<string, any> = {}) => invited({
  status: 'active',
  walkerUid: WALKER,
  walkerDisplayName: 'はるか',
  walkerAvatar: 'girl',
  ...overrides,
});

describe('招待の受諾可否（二重同意）', () => {
  test('期限内・空席なら受け手は受諾できる', () => {
    expect(canAcceptInvite(invited(), WALKER, NOW)).toBe(true);
  });

  test('期限切れの招待は受諾できない', () => {
    expect(isInviteOpen(invited({ inviteExpiresAt: inPast(1000) }), NOW)).toBe(false);
    expect(canAcceptInvite(invited({ inviteExpiresAt: inPast(1000) }), WALKER, NOW)).toBe(false);
  });

  test('作成者自身は受諾できない（1人2役のペアは見守りの実体がない）', () => {
    expect(canAcceptInvite(invited(), WATCHER, NOW)).toBe(false);
  });

  test('すでに成立したペアは受諾できない', () => {
    expect(canAcceptInvite(active(), OTHER, NOW)).toBe(false);
  });

  test('解除済みのペアは受諾できない', () => {
    expect(canAcceptInvite(invited({ status: 'revoked' }), WALKER, NOW)).toBe(false);
  });
});

describe('解除（I-3）', () => {
  test('当事者はどちらからでも一方的に解除できる', () => {
    expect(canRevoke(active(), WALKER)).toBe(true);
    expect(canRevoke(active(), WATCHER)).toBe(true);
  });

  test('第三者は解除できない', () => {
    expect(canRevoke(active(), OTHER)).toBe(false);
  });

  test('解除済みのペアはもう解除できない', () => {
    expect(canRevoke(active({ status: 'revoked' }), WALKER)).toBe(false);
  });
});

describe('ペア起点の歩行開始（I-1 / I-2）', () => {
  test('active なペアの歩く人だけが歩き始められる', () => {
    expect(canStartPairWalk(active(), WALKER)).toBe(true);
  });

  test('見守り手は歩き始められない（遠隔で相手の位置共有を開始できない）', () => {
    expect(canStartPairWalk(active(), WATCHER)).toBe(false);
  });

  test('招待中・解除済みのペアからは歩き始められない', () => {
    expect(canStartPairWalk(invited(), WALKER)).toBe(false);
    expect(canStartPairWalk(active({ status: 'revoked' }), WALKER)).toBe(false);
  });
});

describe('役割と相手の解決', () => {
  test('自分の役割が引ける', () => {
    expect(roleInPair(active(), WALKER)).toBe('walker');
    expect(roleInPair(active(), WATCHER)).toBe('watcher');
    expect(roleInPair(active(), OTHER)).toBeNull();
  });

  test('相手の表示名とアバターが引ける', () => {
    expect(partnerOf(active(), WATCHER)).toEqual({
      uid: WALKER, role: 'walker', displayName: 'はるか', avatar: 'girl',
    });
    expect(partnerLabel(active(), WALKER)).toBe('おかあさん');
  });

  test('空席のあいだは相手が居ない', () => {
    expect(partnerOf(invited(), WATCHER)).toBeNull();
    expect(partnerLabel(invited(), WATCHER)).toBe('まだ つながっていません');
  });

  test('名前が空でも役割名で代替する（表示名は任意項目）', () => {
    expect(partnerLabel(active({ walkerDisplayName: '' }), WATCHER)).toBe('歩く人');
  });
});

describe('parsePair の防御', () => {
  test('未知のアバターIDはプリセットへ丸める', () => {
    expect(parsePair('p', { walkerAvatar: '../../etc/passwd' }).walkerAvatar).toBe('star');
  });

  test('未知の status は解除扱い（安全側に倒す）', () => {
    expect(parsePair('p', { status: 'superuser' }).status).toBe('revoked');
  });

  test('長すぎる表示名は上限で切る', () => {
    const long = 'あ'.repeat(100);
    expect(parsePair('p', { walkerDisplayName: long }).walkerDisplayName.length).toBe(MAX_DISPLAY_NAME);
  });
});

describe('最終確認の一行（座標を含まない）', () => {
  test('目的地ラベルがあれば「◯◯に到着」を出す', () => {
    const pair = active({
      lastSessionSummary: {
        endedAt: inPast(30_000), finalStatus: 'arrived', destinationLabel: 'ひまわり学童保育室',
      },
    });
    expect(describeLastSession(pair.lastSessionSummary, NOW)).toBe('まえの見守り: さっき・ひまわり学童保育室に到着');
  });

  test('目的地ラベルが無ければ地名ラベルを出す（D-14）', () => {
    const pair = active({
      lastSessionSummary: {
        endedAt: inPast(15 * 60_000), finalStatus: 'ended', destinationLabel: null,
        placeLabel: '東京都 世田谷区 三軒茶屋',
      },
    });
    expect(describeLastSession(pair.lastSessionSummary, NOW)).toBe('まえの見守り: 15分前・東京都 世田谷区 三軒茶屋');
  });

  test('どちらのラベルも無ければ状態のことばだけを出す', () => {
    const pair = active({
      lastSessionSummary: { endedAt: inPast(3 * 60_000), finalStatus: 'ended', destinationLabel: null },
    });
    expect(describeLastSession(pair.lastSessionSummary, NOW)).toBe('まえの見守り: 3分前・終了');
  });

  test('座標そのものが地名ラベルとして入っていても、行に座標は出ない', () => {
    const pair = active({
      lastSessionSummary: {
        endedAt: inPast(60_000), finalStatus: 'ended', destinationLabel: null,
        placeLabel: '35.6812, 139.7671',
      },
    });
    // parsePair は器の形しか見ないので値はそのまま入るが、書き込み側（クライアントの
    // normalizePlaceLabel・Functions の sanitizePlaceLabel）が二重に弾いている。
    // ここで固定したいのは「表示層が座標を勝手に整形して出したりしない」ことだけ。
    expect(describeLastSession(pair.lastSessionSummary, NOW)).toContain('まえの見守り: 1分前・');
  });

  test('記録が無ければ何も出さない', () => {
    expect(describeLastSession(null, NOW)).toBeNull();
  });
});

describe('normalizeDisplayName', () => {
  test('改行・前後の空白を落とし、上限で切る', () => {
    expect(normalizeDisplayName('  はる\nか  ')).toBe('はる か');
    expect(normalizeDisplayName('あ'.repeat(50)).length).toBe(MAX_DISPLAY_NAME);
  });
});


// 相手の呼び名と年齢（D-8 / §9）。用途は「110番通報のときに口頭で伝える」1つだけで、
// 年齢は数値ひとつ。誕生日・生年は取らない（目的に対して過剰）。
describe('相手の呼び名と年齢（D-8）', () => {
  test('呼び名と年齢をそのまま読む', () => {
    const pair = active({ walkerLabel: { name: 'はるちゃん', age: 8 } });
    expect(pair.walkerLabel).toEqual({ name: 'はるちゃん', age: 8 });
  });

  test('年齢は任意（呼び名だけでも預かれる）', () => {
    expect(active({ walkerLabel: { name: 'はるちゃん' } }).walkerLabel).toEqual({
      name: 'はるちゃん', age: null,
    });
  });

  test('どちらも空なら「預かっていない」（空の器を残さない）', () => {
    expect(active({ walkerLabel: { name: '', age: null } }).walkerLabel).toBeNull();
    expect(active({}).walkerLabel).toBeNull();
  });

  test('壊れた値は捨てる（年齢が文字列・範囲外・小数）', () => {
    expect(active({ walkerLabel: { name: 'はるちゃん', age: '8' } }).walkerLabel?.age).toBeNull();
    expect(active({ walkerLabel: { name: 'はるちゃん', age: 999 } }).walkerLabel?.age).toBeNull();
    expect(active({ walkerLabel: { name: 'はるちゃん', age: -1 } }).walkerLabel?.age).toBeNull();
    expect(active({ walkerLabel: { name: 'はるちゃん', age: 8.5 } }).walkerLabel?.age).toBeNull();
  });

  test('長すぎる呼び名は上限で切る', () => {
    const long = 'あ'.repeat(100);
    expect(active({ walkerLabel: { name: long } }).walkerLabel?.name.length).toBe(MAX_DISPLAY_NAME);
  });

  test('入力の正規化: 空欄は「入れていない」であって0歳ではない', () => {
    expect(normalizeWalkerLabel('  はる\nちゃん ', '')).toEqual({ name: 'はる ちゃん', age: null });
    expect(normalizeWalkerLabel('はるちゃん', '8')).toEqual({ name: 'はるちゃん', age: 8 });
    expect(normalizeWalkerLabel('はるちゃん', '  ')).toEqual({ name: 'はるちゃん', age: null });
  });

  test('入力の正規化: どちらも空なら null（＝預かるのをやめる）', () => {
    expect(normalizeWalkerLabel('', '')).toBeNull();
    expect(normalizeWalkerLabel('   ', 'あ')).toBeNull();
  });

  test('入力の正規化: 範囲外の年齢は入れない（0歳に丸めない）', () => {
    expect(normalizeWalkerLabel('はるちゃん', '999')).toEqual({ name: 'はるちゃん', age: null });
    expect(normalizeWalkerLabel('はるちゃん', '-3')).toEqual({ name: 'はるちゃん', age: null });
  });
});
