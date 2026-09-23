import { useEffect, useState } from 'react';

// 「◯分前」「異常はありません（heartbeat の鮮度）」のように、時間が経つだけで
// 表示が変わるものを更新するための時計。既定は10秒（分表示に十分で、
// 秒ごとの再描画で電池を使わない粒度）。
export function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
