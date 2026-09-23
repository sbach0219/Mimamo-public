import React from 'react';
import { HoldButton } from './HoldButton';

// 歩行画面から見守りを終える導線（iOS には戻る操作が無いため、画面内に置く）。
// 「わざと押さないと押せない」ことが要件なので、長押し800ms＋進行表示にしたうえで、
// 満了しても即終了はせず必ず確認ダイアログ（§4-A の2択大ボタン）を通す。
const HOLD_MS = 800;

export function LeaveWalkLink({ onTrigger }: { onTrigger: () => void }) {
  return (
    <HoldButton
      label="おわる"
      holdingLabel="そのまま おしててね…"
      durationMs={HOLD_MS}
      onComplete={onTrigger}
      accessibilityLabel="みまもりを おわる"
      accessibilityHint="長押しすると、おわるかどうかの確認が出ます"
    />
  );
}
