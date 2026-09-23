import { doc, updateDoc, serverTimestamp } from '@react-native-firebase/firestore';
import { db } from '../../lib/firebase';
import { monitorServerDelivery } from '../../lib/serverDelivery';
import type { SessionContext, SessionState } from './types';

export function createSafetyActions({ set, get, runtime }: SessionContext): Pick<SessionState,
  'triggerSOS' | 'cancelSOS' | 'acknowledgeSOS' | 'reportAnomaly' | 'resolveAnomaly' | 'requestSafetyCheck' | 'respondSafetyCheck'
> {
  return {
    // silent=true は「音なしSOS」。本人端末でアラームを鳴らさず、
    // 見守り側にも「声を出せない状況かもしれない」ことを伝える。
    triggerSOS: (silent = false) => {
      const { sessionId } = get();
      if (!sessionId) {
        set({ sosDeliveryStatus: 'failed' });
        return;
      }
      const requestId = ++runtime.sosDeliveryRequestId;
      const write = updateDoc(doc(db, 'sessions', sessionId), {
        status: 'sos', sosAt: serverTimestamp(), sosSilent: silent, sosAcknowledgedAt: null,
      });
      monitorServerDelivery(write, {
        onSending: () => set({ sosSilent: silent, sosDeliveryStatus: 'sending' }),
        onUnconfirmed: () => {
          if (requestId === runtime.sosDeliveryRequestId) set({ sosDeliveryStatus: 'unconfirmed' });
        },
        onDelivered: () => {
          if (requestId === runtime.sosDeliveryRequestId) set({ sosDeliveryStatus: 'delivered' });
        },
        onFailed: () => {
          if (requestId === runtime.sosDeliveryRequestId) set({ sosDeliveryStatus: 'failed' });
        },
      });
    },

    // 本人がSOSをとりけす（issue #2）。誤操作や「もう大丈夫」のときに
    // 自分で解除できることで、SOSを押すこと自体のハードルを下げる。
    // 見守り側へは Cloud Functions がとりけし通知を送る。
    cancelSOS: () => {
      const { sessionId, status } = get();
      if (!sessionId || status !== 'sos') return;
      updateDoc(doc(db, 'sessions', sessionId), {
        status: 'active',
        sosCancelledAt: serverTimestamp(),
        sosSilent: false,
        safetyCheck: null,
      }).catch(() => { });
      runtime.sosDeliveryRequestId += 1;
      set({ sosSilent: false, sosAcknowledgedAt: null, sosDeliveryStatus: 'idle' });
    },

    acknowledgeSOS: () => {
      const { sessionId, myRole, status, sosAcknowledgedAt } = get();
      if (!sessionId || myRole !== 'watcher' || status !== 'sos' || sosAcknowledgedAt) return;
      updateDoc(doc(db, 'sessions', sessionId), { sosAcknowledgedAt: serverTimestamp() }).catch(() => { });
    },

    // センチネル：本人確認が無応答だった → 見守りへエスカレーション。
    // 前回の安否確認（safetyCheck）が残っていると、見守り側で今回の異常が
    // 最初から「✅応答あり」に見えてしまうため、必ずクリアして始める。
    reportAnomaly: (type) => {
      const { sessionId } = get();
      if (!sessionId) return;
      updateDoc(doc(db, 'sessions', sessionId), {
        status: 'anomaly',
        anomaly: { type, detectedAt: serverTimestamp() },
        safetyCheck: null,
      }).catch(() => { });
    },

    // センチネル：本人が「大丈夫」を選び異常を解除
    resolveAnomaly: () => {
      const { sessionId } = get();
      if (!sessionId) return;
      updateDoc(doc(db, 'sessions', sessionId), {
        status: 'active',
        anomalyResolvedAt: serverTimestamp(),
        safetyCheck: null,
      }).catch(() => { });
    },

    // 見守り側：安否確認を歩く人へ送る
    requestSafetyCheck: () => {
      const { sessionId } = get();
      if (!sessionId) return;
      updateDoc(doc(db, 'sessions', sessionId), {
        safetyCheck: { requestedAt: serverTimestamp(), response: null },
      }).catch(() => { });
    },

    // 歩く人：安否確認に応答する。SOS応答時は silent（音なし）も指定できる
    respondSafetyCheck: (response, silent = false) => {
      const { sessionId } = get();
      if (!sessionId) return;
      const update: Record<string, any> = {
        'safetyCheck.response': response,
        'safetyCheck.respondedAt': serverTimestamp(),
        status: response === 'sos' ? 'sos' : 'active',
      };
      if (response === 'sos') update.sosSilent = silent;
      updateDoc(doc(db, 'sessions', sessionId), update).catch(() => { });
      if (response === 'sos') set({ sosSilent: silent });
    },
  };
}
