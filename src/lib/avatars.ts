// プリセットアバター（ADR P3 決定2）。
//
// 写真アバター（Storage）は本 ADR のスコープ外（Stage 4 予約）。ここで扱うのは
// 「プリセットIDの文字列」だけで、画像はアプリに同梱の絵文字として描画する。
// ID を Firestore に持つのは、相手の端末でも同じ絵が出る必要があるため。
//
// ID は永久に不変。並び替えは自由だが、既存 ID の意味を変えてはいけない
// （相手のペア文書に複製済みの値が別人の顔に化ける）。

export const AVATAR_PRESETS = [
  { id: 'grandpa', emoji: '👴' },
  { id: 'grandma', emoji: '👵' },
  { id: 'boy', emoji: '👦' },
  { id: 'girl', emoji: '👧' },
  { id: 'man', emoji: '👨' },
  { id: 'woman', emoji: '👩' },
  { id: 'cat', emoji: '🐱' },
  { id: 'dog', emoji: '🐶' },
  { id: 'star', emoji: '⭐️' },
  { id: 'moon', emoji: '🌙' },
] as const;

export type AvatarId = (typeof AVATAR_PRESETS)[number]['id'];

export const DEFAULT_AVATAR_ID: AvatarId = 'star';

export function isAvatarId(value: unknown): value is AvatarId {
  return typeof value === 'string' && AVATAR_PRESETS.some((a) => a.id === value);
}

export function parseAvatarId(value: unknown): AvatarId {
  return isAvatarId(value) ? value : DEFAULT_AVATAR_ID;
}

export function avatarEmoji(value: unknown): string {
  const id = parseAvatarId(value);
  return AVATAR_PRESETS.find((a) => a.id === id)!.emoji;
}
