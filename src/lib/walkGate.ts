import type { Role } from '../store/sessionStore';
import { isTerminalSessionStatus } from './sessionStatus';

// 歩行画面（Main / MainSentinel）に入れる条件。
// セッション未参加のまま歩行画面に入ると、SOS・エスカレーション・到着連絡が
// すべて無音の no-op になる（「見守られているつもり」で誰も見ていない状態）ため、
// 参加済みの walker であることを入場条件にする。
// docs/solo-walk-design.md（案A: セッション必須化）を参照。
//
// 終端済み（ended / arrived / cancelled）も入れない（M-D）。見守り終了の通知を
// 歩く人がタップすると、終わったセッションに対して位置送信とハートビートが
// 走り出し、rules に弾かれて止まるまでのあいだ位置を取り続けてしまう。
export function canStartWalk(
  sessionId: string | null,
  myRole: Role | null,
  status?: string | null,
): boolean {
  if (sessionId == null || myRole !== 'walker') return false;
  return !isTerminalSessionStatus(status);
}
