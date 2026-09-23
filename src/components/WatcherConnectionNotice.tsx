import React from 'react';
import { useIsOnline } from '../lib/network';
import { ConnectionPill } from './ConnectionPill';

// 見守りタブ4画面の圏外表示（M-1）。
//
// ConnectionPill は詳細（WatcherMonitor）・設定・歩行画面にはあったが、
// タブ側には無かった。タブは「見守り対象リスト」を現在の状態として見せる画面なので、
// 圏外で購読が止まっているあいだも古いリストがそのまま現在として読まれてしまう。
//
// つながっているあいだは何も出さない。常設すると「つながっています」が4画面の
// 最上部を占め続けるだけで、注意を向けるべきときの手がかりにならなくなる。
export function WatcherConnectionNotice() {
  const online = useIsOnline();
  if (online) return null;
  return <ConnectionPill state="offline" />;
}
