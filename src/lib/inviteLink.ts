// 招待リンクの組み立てと共有文言（F-12）。
//
// 公開仕様の URL は `https://thousandsky.com/s/{id}`（オーナー決定 D-2）。
// ただし https 形式でアプリを開くには Universal Links / App Links の設定が要り、
// これは native の再ビルド（F-11・ストア提出ビルド）を伴う。
// website 側のリダイレクトページと AASA / assetlinks.json が公開され、
// 対応ビルドが配布されるまでは、確実に開けるカスタムスキームを共有する。
// 切り替えは下の USE_HTTPS_INVITE を true にするだけでよい。
const USE_HTTPS_INVITE = false;

export const INVITE_ORIGIN = 'https://thousandsky.com';

export function inviteUrl(sessionId: string): string {
  return USE_HTTPS_INVITE
    ? `${INVITE_ORIGIN}/s/${sessionId}`
    : `thousandsky://session/${sessionId}`;
}

// 共有メッセージ。受け取る側は LINE やメールの本文としてこれを読む。
// URL は必ず単独行に置く（前後に文字があるとリンクとして認識されない
// アプリがあり、「押しても何も起きない」の主要因になる）。
export function inviteMessage(sessionId: string, minutes: number): string {
  return [
    `${minutes}分の見守りリンクです。`,
    'ひらくと「みまも」で見守りがはじまります。',
    '',
    inviteUrl(sessionId),
  ].join('\n');
}
