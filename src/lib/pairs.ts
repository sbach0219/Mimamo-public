// 恒久ペア（ADR P3 決定2）の型と純ロジック。
//
// ペアは「方向つき（walker → watcher）の2者関係」であり、役割はペア内で固定する。
// 「お互いに見守り合う」は2本のペアで表現する（対称ペアという概念は作らない）。
//
// 不変条件（ADR §7）のうち、このファイルが直接支えるもの:
//   I-1 位置共有はセッション中のみ。ペアは「位置を見る権利」ではなく
//       「招待手続きなしで見守りを始められる関係」でしかない。
//       → ペア文書には座標を一切置かない。lastSessionSummary も時刻とラベルのみ。
//   I-3 歩く人はいつでも一方的に解除できる → canRevoke は当事者の両方に true を返す。
import { parseAvatarId, type AvatarId } from './avatars';
import { parseSessionStatus, type SessionStatus } from './sessionStatus';

export type PairStatus = 'invited' | 'active' | 'revoked';
export type PairRole = 'walker' | 'watcher';

// 招待トークン（＝pairId）の有効期限。現行の見守りリンク（isJoinable）と同型で
// 「状態＋期限＋1回限り」に揃える。逆方向招待（Stage 3）はさらに短命にする予定。
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

// 表示名の上限。firestore.rules の users / pairs の検証と同じ値にすること。
export const MAX_DISPLAY_NAME = 30;

// 目的地ラベルの上限。ユーザーが入力した文字列であり、住所・座標は入れない（I-1 / E-5）。
export const MAX_DESTINATION_LABEL = 30;

// ペア文書に残す「前回の見守り」。座標・経路・電池は含めない（D-14）。
// placeLabel は歩く人の端末が自分で地名に直した1語で、Functions が転記する。
// 7日で null 化される（v3移行設計書 §2.4）。
export const MAX_PLACE_LABEL = 60;
export type LastSessionSummary = {
  endedAt: Date | null;
  finalStatus: SessionStatus;
  destinationLabel: string | null;
  placeLabel: string | null;
};

// 見守る人が預かる「相手の呼び名と年齢」（D-8 / §9）。
// walkerDisplayName（歩く人が自分でつける名前）とは別物。こちらは**他人に関する情報を
// 恒久保存する**新カテゴリで、用途は「110番通報のときに見守り手が口頭で伝える」1つだけ。
// だから年齢は数値ひとつ（誕生日・生年は取らない。目的に対して過剰）。毎年ずれるのは
// 許容する——緊急通報の用途では概数で足りる。
export const MAX_WALKER_LABEL_NAME = 30;
export const MAX_WALKER_AGE = 120;
export type WalkerLabel = {
  name: string;
  age: number | null;
};

export type Pair = {
  id: string;
  walkerUid: string; // '' = 空席（invited のあいだだけ）
  watcherUid: string;
  createdByUid: string;
  status: PairStatus;
  createdAt: Date | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  revokedByUid: string | null;
  inviteExpiresAt: Date | null;
  walkerDisplayName: string;
  walkerAvatar: AvatarId;
  watcherDisplayName: string;
  watcherAvatar: AvatarId;
  lastSessionSummary: LastSessionSummary | null;
  // 見守る人が預かる相手の呼び名・年齢（D-8）。ペア解除で Functions が即時削除する。
  walkerLabel: WalkerLabel | null;
  // 相手が長期不達になったことを functions が刻む（I-5「関係の死は隠さない」）
  staleSince: Date | null;
};

export type PairPartner = {
  uid: string;
  role: PairRole;
  displayName: string;
  avatar: AvatarId;
};

const tsToDate = (v: any): Date | null => (v && typeof v.toDate === 'function' ? v.toDate() : v instanceof Date ? v : null);

function parseStatus(value: unknown): PairStatus {
  return value === 'invited' || value === 'active' || value === 'revoked' ? value : 'revoked';
}

function parseName(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_DISPLAY_NAME) : '';
}

export function parsePair(id: string, data: Record<string, any> | undefined): Pair {
  const d = data ?? {};
  const summary = d.lastSessionSummary;
  return {
    id,
    walkerUid: typeof d.walkerUid === 'string' ? d.walkerUid : '',
    watcherUid: typeof d.watcherUid === 'string' ? d.watcherUid : '',
    createdByUid: typeof d.createdByUid === 'string' ? d.createdByUid : '',
    status: parseStatus(d.status),
    createdAt: tsToDate(d.createdAt),
    acceptedAt: tsToDate(d.acceptedAt),
    revokedAt: tsToDate(d.revokedAt),
    revokedByUid: typeof d.revokedByUid === 'string' ? d.revokedByUid : null,
    inviteExpiresAt: tsToDate(d.inviteExpiresAt),
    walkerDisplayName: parseName(d.walkerDisplayName),
    walkerAvatar: parseAvatarId(d.walkerAvatar),
    watcherDisplayName: parseName(d.watcherDisplayName),
    watcherAvatar: parseAvatarId(d.watcherAvatar),
    lastSessionSummary: summary
      ? {
          endedAt: tsToDate(summary.endedAt),
          finalStatus: parseSessionStatus(summary.finalStatus, 'ended'),
          destinationLabel:
            typeof summary.destinationLabel === 'string' && summary.destinationLabel.length > 0
              ? summary.destinationLabel.slice(0, MAX_DESTINATION_LABEL)
              : null,
          placeLabel:
            typeof summary.placeLabel === 'string' && summary.placeLabel.length > 0
              ? summary.placeLabel.slice(0, MAX_PLACE_LABEL)
              : null,
        }
      : null,
    walkerLabel: parseWalkerLabel(d.walkerLabel),
    staleSince: tsToDate(d.staleSince),
  };
}

function parseWalkerLabel(value: unknown): WalkerLabel | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const name = typeof v.name === 'string' ? v.name.slice(0, MAX_WALKER_LABEL_NAME) : '';
  const age = typeof v.age === 'number' && Number.isInteger(v.age) && v.age >= 0 && v.age <= MAX_WALKER_AGE
    ? v.age
    : null;
  // どちらも空なら「預かっていない」。空の器を残すと、削除したのに残っているように見える
  if (name.length === 0 && age == null) return null;
  return { name, age };
}

// 入力を rules と同じ形へ丸める。空欄は「入れていない」であって 0 歳ではない。
export function normalizeWalkerLabel(name: string, ageText: string): WalkerLabel | null {
  const trimmed = name.replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_WALKER_LABEL_NAME);
  const parsed = Number.parseInt(ageText.trim(), 10);
  const age = Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_WALKER_AGE ? parsed : null;
  if (trimmed.length === 0 && age == null) return null;
  return { name: trimmed, age };
}

export function roleInPair(pair: Pair, uid: string): PairRole | null {
  if (pair.walkerUid === uid && uid !== '') return 'walker';
  if (pair.watcherUid === uid && uid !== '') return 'watcher';
  return null;
}

export function isPairMember(pair: Pair, uid: string): boolean {
  return roleInPair(pair, uid) != null;
}

// 招待がまだ受諾できるか。「空席がある」「invited」「期限内」の3条件すべて。
export function isInviteOpen(pair: Pair, now: Date = new Date()): boolean {
  if (pair.status !== 'invited') return false;
  if (!pair.inviteExpiresAt || pair.inviteExpiresAt.getTime() <= now.getTime()) return false;
  return pair.walkerUid === '' || pair.watcherUid === '';
}

// 自分がこの招待を受諾できるか。作成者自身は受諾できない（A-5 と同型:
// 1人2役のペアは見守りの実体がない）。
export function canAcceptInvite(pair: Pair, uid: string, now: Date = new Date()): boolean {
  if (!isInviteOpen(pair, now)) return false;
  if (pair.createdByUid === uid) return false;
  return !isPairMember(pair, uid);
}

// 解除は当事者のどちらからでも一方的にできる（I-3）。
export function canRevoke(pair: Pair, uid: string): boolean {
  return pair.status === 'active' && isPairMember(pair, uid);
}

// 恒久ペアを根拠に歩き始められるのは、active なペアの「歩く人」だけ（I-2）。
// 見守り手が遠隔で相手の位置共有を開始する経路は構造的に作らない。
export function canStartPairWalk(pair: Pair, uid: string): boolean {
  return pair.status === 'active' && pair.walkerUid === uid && uid !== '';
}

export function partnerOf(pair: Pair, uid: string): PairPartner | null {
  const role = roleInPair(pair, uid);
  if (role === 'watcher') {
    if (!pair.walkerUid) return null;
    return { uid: pair.walkerUid, role: 'walker', displayName: pair.walkerDisplayName, avatar: pair.walkerAvatar };
  }
  if (role === 'walker') {
    if (!pair.watcherUid) return null;
    return { uid: pair.watcherUid, role: 'watcher', displayName: pair.watcherDisplayName, avatar: pair.watcherAvatar };
  }
  return null;
}

// 見守る人の画面で相手を指すときの名前。自分が付けた呼び名（D-8）を優先する
// ——「はるちゃん」と登録した相手がリストで本人の設定名で出ると、誰のことか一拍わからない。
export function watcherFacingName(pair: Pair, fallback = '見守る相手'): string {
  return pair.walkerLabel?.name || pair.walkerDisplayName || fallback;
}

export function partnerLabel(pair: Pair, uid: string): string {
  const partner = partnerOf(pair, uid);
  if (!partner) return 'まだ つながっていません';
  return partner.displayName || (partner.role === 'walker' ? '歩く人' : '見守る人');
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  waiting: '待機中',
  active: '見守り中',
  alert: '応答なし',
  anomaly: '異常を検知',
  sos: 'SOS',
  arrived: '到着',
  ended: '終了',
  cancelled: 'キャンセル',
};

function relativeTime(from: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - from.getTime()) / 60_000);
  if (minutes < 1) return 'さっき';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

// ホームのリスト行に出す「まえの見守り: 15分前・世田谷区 三軒茶屋」の一行（D-14）。
// 出せるのは時刻と地名だけで、座標由来のピンは決して置かない（§4）。
// 目的地ラベル（ユーザー入力）があればそちらを優先する — 本人が名付けた場所のほうが
// 「どこにいたか」として通じるうえ、地名より情報が粗い（安全側）。
export function describeLastSession(summary: LastSessionSummary | null, now: Date = new Date()): string | null {
  if (!summary?.endedAt) return null;
  const when = relativeTime(summary.endedAt, now);
  const where = summary.destinationLabel
    ? `${summary.destinationLabel}${summary.finalStatus === 'arrived' ? 'に到着' : ''}`
    : summary.placeLabel ?? STATUS_LABEL[summary.finalStatus];
  return `まえの見守り: ${when}・${where}`;
}

// 表示名の正規化。改行・前後の空白を落とし、上限で切る。
// 空文字は「名前を付けていない」という正当な状態（登録不要の約束を守るため必須にしない）。
export function normalizeDisplayName(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_DISPLAY_NAME);
}

export function normalizeDestinationLabel(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_DESTINATION_LABEL);
}
