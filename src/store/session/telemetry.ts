import { collection, doc, updateDoc, addDoc, serverTimestamp } from '@react-native-firebase/firestore';
import { db } from '../../lib/firebase';
import { locationModeFor } from '../../lib/locationMode';
import { normalizePlaceLabel } from '../../lib/placeLabel';
import type { SessionContext, ConnectionStatus, SessionState } from './types';
import { UNSTABLE_THRESHOLD } from './model';

export function createTelemetryActions({ set, get, runtime }: SessionContext): Pick<SessionState,
  'updateLocation' | 'updateBattery' | 'reportPlaceLabel' | 'updateHeartbeat' | 'reportLocationMode' | 'startConnectionMonitoring' | 'stopConnectionMonitoring'
> {
  let connTimer: ReturnType<typeof setInterval> | null = null;

  let lastPlaceLabel: { sessionId: string | null; text: string | null } = { sessionId: null, text: null };
  return {
    updateLocation: (coord) => {
      const { sessionId, myRole } = get();
      if (!sessionId || myRole !== 'walker') return;
      const ref = doc(db, 'sessions', sessionId);
      updateDoc(ref, {
        latitude: coord.latitude,
        longitude: coord.longitude,
        locationUpdatedAt: serverTimestamp(),
        lastHeartbeat: serverTimestamp(),
      }).catch(() => { });
      // 軌跡は間引いて書く（B-4）。親ドキュメントの座標は毎回更新しているので、
      // 「いまどこ」の鮮度は落ちない。
      if (runtime.routeThinner.accept({ ...coord, at: Date.now() })) {
        addDoc(collection(db, 'sessions', sessionId, 'route'), {
          lat: coord.latitude,
          lng: coord.longitude,
          timestamp: serverTimestamp(),
        }).catch(() => { });
      }
    },

    updateBattery: (level, state) => {
      const { sessionId, myRole } = get();
      if (!sessionId || myRole !== 'walker') return;
      updateDoc(doc(db, 'sessions', sessionId), { batteryLevel: level, batteryState: state }).catch(() => { });
    },

    reportPlaceLabel: (label) => {
      const { sessionId, myRole } = get();
      if (!sessionId || myRole !== 'walker') return;
      const text = normalizePlaceLabel(label);
      if (!text) return;
      // 同じ地名を書き直さない。位置は毎ティック動くが地名は町名単位でしか変わらず、
      // 書き込み回数をそのまま倍にする理由がない。
      if (lastPlaceLabel.sessionId === sessionId && lastPlaceLabel.text === text) return;
      lastPlaceLabel = { sessionId, text };
      updateDoc(doc(db, 'sessions', sessionId), { placeLabel: text }).catch(() => {
        lastPlaceLabel = { sessionId: null, text: null }; // 失敗したら次のサンプルで書き直す
      });
    },

    updateHeartbeat: () => {
      const { sessionId, myRole } = get();
      if (!sessionId || myRole !== 'walker') return;
      // 成功した時刻を残す。歩く人の画面の「みまもられているか」がこれを見る
      updateDoc(doc(db, 'sessions', sessionId), { lastHeartbeat: serverTimestamp() })
        .then(() => set({ lastHeartbeatOkAt: Date.now() }))
        .catch(() => { });
    },

    // 位置共有が拒否・失敗のまま歩行が続くと、見守り側には「移動中・異常なし」に
    // 見え続ける（H-2）。結果を1語だけ文書に残して、その食い違いを消す。
    reportLocationMode: (result) => {
      const { sessionId, myRole } = get();
      if (!sessionId || myRole !== 'walker') return;
      const locationMode = locationModeFor(result);
      if (get().locationMode === locationMode) return;
      // ローカルを先に進めると、書き込みが rules 拒否や圏外で落ちたときに同値判定で
      // 早期 return するようになり、二度と再送されない（L-1）。書けたときだけ進める。
      updateDoc(doc(db, 'sessions', sessionId), { locationMode })
        .then(() => set({ locationMode }))
        .catch(() => { });
    },

    startConnectionMonitoring: () => {
      if (connTimer) return;
      connTimer = setInterval(() => {
        const last = get().lastHeartbeatDate;
        if (!last) return;
        const elapsed = (Date.now() - last.getTime()) / 1000;
        const next: ConnectionStatus = elapsed >= UNSTABLE_THRESHOLD ? 'unstable' : 'good';
        if (next !== get().connectionStatus) set({ connectionStatus: next });
      }, 1000);
    },

    stopConnectionMonitoring: () => {
      if (connTimer) clearInterval(connTimer);
      connTimer = null;
    },
  };
}
