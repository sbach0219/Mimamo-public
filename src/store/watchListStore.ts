import { create } from 'zustand';
import { collection, onSnapshot, query, where, orderBy, limit } from '@react-native-firebase/firestore';
import { db } from '../lib/firebase';
import { parseSessionStatus, isLiveSessionStatus, type SessionStatus } from '../lib/sessionStatus';
import { parseLocationMode, type LocationMode } from '../lib/locationMode';
import { saveActiveWatch, removeActiveWatch } from '../lib/activeWatch';
import type { AnomalyType } from '../lib/sentinel';
import type { Coord } from './sessionStore';

// 見守り側の「見守り対象リスト」購読層（design-v3-watcher-redesign §2.3 / T2）。
//
// sessionStore は「いま開いている1セッション」を持つ器で、歩く人側の全画面が
// その形に依存している。リスト購読をそこへ混ぜると歩く側のコードパスに触れることに
// なるため、購読を別の store に分ける（歩く側スナップショット不変が受け入れ条件）。
//
// クエリは where('watcherUid','==',uid) + createdAt 降順の1本にして、ライブ判定は
// クライアントで行う。status の in 句まで入れるとインデックスがもう1本増えるが、
// 「新しい50件」を取れていればライブは実運用で落ちないため、そこまではしない。
// createdAt の複合インデックス（watcherUid asc, createdAt desc）は
// firestore.indexes.json に定義してある — **デプロイが必要**。
const LIST_LIMIT = 50;

export type WatchListItem = {
  id: string;
  status: SessionStatus;
  // 恒久ペア起点の見守りなら、そのペアID。ホームは「ライブがあるペア」を
  // これで判定して、同じ相手をセッションの行とペアの行で二重に出さない。
  pairId: string | null;
  name: string | null;
  lastHeartbeatAt: number | null;
  // 歩く人の端末で位置共有がどの強さで動いているか（H-2）。null は未報告＝判定不能。
  locationMode: LocationMode | null;
  anomalyType: AnomalyType | null;
  sosSilent: boolean;
  location: Coord | null;
  batteryLevel: number | null;
  walkStartedAt: Date | null;
  sosAt: Date | null;
  createdAt: Date | null;
  estimatedMinutes: number;
};

// 直近の到着（ちずタブの緑バナー用）。到着は終端状態なのでライブ一覧からは
// 外れるが、同じスナップショットに載っているので、そこから拾って一定時間だけ出す。
export type WatchArrival = { id: string; name: string | null; at: number };

// 到着バナーを出しておく時間。長く残すと「もう終わった見守り」が現在の状態に見える。
export const ARRIVAL_NOTICE_MS = 10 * 60_000;

interface WatchListState {
  items: WatchListItem[];
  arrivals: WatchArrival[];
  // 最初のスナップショットが届くまで true。0件表示と「まだ読めていない」を区別する
  loading: boolean;
  startWatchList: (uid: string) => void;
  stopWatchList: () => void;
}

let unsub: (() => void) | null = null;
let subscribedUid: string | null = null;
// 永続化（activeWatches）へ書いた内容の記憶。スナップショットは位置が届くたびに
// 発火するので、毎回 AsyncStorage を読み書きしないよう「状態が変わった1回だけ」に絞る。
const persistedLive = new Set<string>();
const persistedTerminal = new Set<string>();

const tsToDate = (v: any): Date | null => (v && typeof v.toDate === 'function' ? v.toDate() : null);
const parseAnomaly = (v: any): AnomalyType | null =>
  v === 'fall' || v === 'stall' || v === 'move' || v === 'area' ? v : null;

export const useWatchList = create<WatchListState>((set) => ({
  items: [],
  arrivals: [],
  loading: true,

  startWatchList: (uid) => {
    if (unsub && subscribedUid === uid) return;
    unsub?.();
    subscribedUid = uid;
    set({ loading: true });

    const subscribe = (ordered: boolean) => onSnapshot(
      ordered
        ? query(
            collection(db, 'sessions'),
            where('watcherUid', '==', uid),
            orderBy('createdAt', 'desc'),
            limit(LIST_LIMIT),
          )
        : query(collection(db, 'sessions'), where('watcherUid', '==', uid), limit(LIST_LIMIT)),
      (snap) => {
        if (!snap) return;
        const items: WatchListItem[] = [];
        const arrivals: WatchArrival[] = [];
        for (const d of snap.docs) {
          const x = d.data() ?? {};
          const status = parseSessionStatus(x.status);
          if (!isLiveSessionStatus(status)) {
            // 終端したセッションは復帰先の候補から外す（次回起動でホームに直行させる）
            if (!persistedTerminal.has(d.id)) {
              persistedTerminal.add(d.id);
              persistedLive.delete(d.id);
              removeActiveWatch(d.id).catch(() => {});
            }
            const endedAt = tsToDate(x.endedAt);
            if (status === 'arrived' && endedAt && Date.now() - endedAt.getTime() < ARRIVAL_NOTICE_MS) {
              arrivals.push({
                id: d.id,
                name: typeof x.walkerName === 'string' && x.walkerName.length > 0 ? x.walkerName : null,
                at: endedAt.getTime(),
              });
            }
            continue;
          }
          if (!persistedLive.has(d.id)) {
            persistedLive.add(d.id);
            persistedTerminal.delete(d.id);
            saveActiveWatch(d.id).catch(() => {});
          }
          const heartbeat = tsToDate(x.lastHeartbeat);
          items.push({
            id: d.id,
            status,
            pairId: typeof x.pairId === 'string' && x.pairId.length > 0 ? x.pairId : null,
            name: typeof x.walkerName === 'string' && x.walkerName.length > 0 ? x.walkerName : null,
            lastHeartbeatAt: heartbeat ? heartbeat.getTime() : null,
            locationMode: parseLocationMode(x.locationMode),
            anomalyType: status === 'anomaly' ? parseAnomaly(x.anomaly?.type) : null,
            sosSilent: status === 'sos' && x.sosSilent === true,
            location: typeof x.latitude === 'number' && typeof x.longitude === 'number'
              ? { latitude: x.latitude, longitude: x.longitude }
              : null,
            batteryLevel: typeof x.batteryLevel === 'number' ? x.batteryLevel : null,
            walkStartedAt: tsToDate(x.startedAt),
            sosAt: tsToDate(x.sosAt),
            createdAt: tsToDate(x.createdAt),
            estimatedMinutes: typeof x.estimatedMinutes === 'number' ? x.estimatedMinutes : 0,
          });
        }
        // クエリ側でも新しい順に取っているが、フォールバック購読（後述）と
        // createdAt 欠落の保険としてクライアントでも並べ直す
        items.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
        arrivals.sort((a, b) => b.at - a.at);
        set({ items, arrivals, loading: false });
      },
      (error: any) => {
        // 複合インデックス未作成（failed-precondition）のときだけ、順序なしの購読へ落とす。
        // インデックスは firestore.indexes.json に入れてあるが、デプロイ前のビルドで
        // 一覧が丸ごと空になる（＝進行中のSOSが見えない）のがいちばん悪い失敗のため。
        if (ordered && error?.code === 'firestore/failed-precondition') {
          console.warn('watchList: createdAt インデックス未作成のため順序なしで購読します');
          unsub?.();
          unsub = subscribe(false);
          return;
        }
        // 圏外・権限エラーでもリストが空で固まらないよう、読み込み中表示だけは解く
        set({ loading: false });
      },
    );

    // 既定は createdAt 降順。orderBy 無しだとドキュメントID順（自動ID＝ランダム）の
    // 先頭50件になり、終端セッションが7日残る運用では進行中の見守りが
    // 一覧から落ちうる（H-4）。「新しい50件」なら実運用で落ちない。
    unsub = subscribe(true);
  },

  stopWatchList: () => {
    unsub?.();
    unsub = null;
    subscribedUid = null;
    persistedLive.clear();
    persistedTerminal.clear();
    set({ items: [], arrivals: [], loading: true });
  },
}));
