// 恒久ペアの招待リンク（ADR P3 決定2）。
//
// 見守りリンク（inviteLink.ts）と同じ理由で、Universal Links / App Links が
// 配布ビルドに乗るまではカスタムスキームを共有する。hostname を 'pair' にして
// 既存の 'session'（都度セッションへの参加）と経路を分ける — 両者は恒久的に並存する
// （ADR 決定2: 都度セッションは初回獲得動線・単発利用・ペア死亡時のフォールバック）。
import { INVITE_ORIGIN } from './inviteLink';

const USE_HTTPS_INVITE = false;

export function pairInviteUrl(pairId: string): string {
  return USE_HTTPS_INVITE
    ? `${INVITE_ORIGIN}/p/${pairId}`
    : `thousandsky://pair/${pairId}`;
}

// 招待メッセージ。URL は必ず単独行に置く（前後に文字があるとリンクとして
// 認識されないアプリがあり、「押しても何も起きない」の主要因になる）。
export function pairInviteMessage(pairId: string, watcherName: string): string {
  const who = watcherName ? `${watcherName}さん` : 'みまもの見守り手';
  return [
    `${who}から「みまも」の見守りのお誘いです。`,
    'ひらくとつながり、次からはリンクなしで見守りをはじめられます。',
    '（位置がつたわるのは、あなたが「あるく」をおしたあいだだけです）',
    '',
    pairInviteUrl(pairId),
  ].join('\n');
}
