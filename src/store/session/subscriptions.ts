import { collection, doc, updateDoc, addDoc, onSnapshot, query, orderBy, serverTimestamp } from '@react-native-firebase/firestore';
import { db } from '../../lib/firebase';
import { haptics } from '../../lib/haptics';
import { notify } from '../../lib/notifications';
import { removeActiveWatch } from '../../lib/activeWatch';
import { parseSessionStatus, parseSessionEndedBy } from '../../lib/sessionStatus';
import { parseLocationMode } from '../../lib/locationMode';
import { parseAnomalyType, type AnomalyType } from '../../lib/sentinel';
import type { SessionContext, Coord, ChatMessage, SessionState } from './types';
import { tsToDate, parseTransport, parseSensitivity, parseWalkerName } from './model';

// type はリモート(FCM)側（functions/index.js）と同じ値を使う。通知タップ時のルーティング
// （src/lib/notificationRouting.ts）がリモート・ローカルどちらの経路でも同じ規約で読めるようにするため。
function scheduleAlertNotification(status: string, sessionId: string, anomalyType?: AnomalyType | null, sosSilent = false) {
  if (status === 'sos') {
    if (sosSilent) {
      notify('🆘 SOS発信！（音なし）', 'サイレントSOSです。声を出せない状況かもしれません。電話の前にチャットでの連絡も検討してください。', 'alert', { type: 'sos', sessionId });
    } else {
      notify('🆘 SOS発信！', '歩く人からSOSが発信されました。今すぐ連絡してください。', 'alert', { type: 'sos', sessionId });
    }
  } else if (status === 'anomaly') {
    if (anomalyType === 'move') {
      notify('🚨 移動の異常を検知', '歩く人が乗り物の速さで移動しています。すぐに確認してください。', 'alert', { type: 'anomaly', sessionId });
    } else if (anomalyType === 'area') {
      // 「危険」とは言わない。検知できるのは「道路や建物の無い場所に居続けている」ことだけ（設計 §7.2）
      notify('⚠️ 人気のない場所に入ったようです', '歩く人が道のない場所に入り、応答がありません。安否を確認してください。', 'alert', { type: 'anomaly', sessionId });
    } else if (anomalyType === 'fall') {
      notify('⚠️ 転倒の可能性', '歩く人が転んだかもしれません。安否を確認してください。', 'alert', { type: 'anomaly', sessionId });
    } else {
      notify('⚠️ 異常を検知しました', '歩く人の動きが止まっています。安否を確認してください。', 'alert', { type: 'anomaly', sessionId });
    }
  } else {
    notify('⚠️ 緊急アラート', '歩く人から30秒以上応答がありません。すぐに確認してください。', 'alert', { type: 'alert', sessionId });
  }
}
export function createSubscriptionsActions({ set, get, runtime }: SessionContext): Pick<SessionState,
  'listenToSession' | 'stopListening' | 'acknowledgeMessage' | 'sendMessage' | 'setChatViewActive'
> {
  // 再レンダーを起こさない内部状態（マネージャ相当）
  let sessionUnsub: (() => void) | null = null;

  let messagesUnsub: (() => void) | null = null;

  let routeUnsub: (() => void) | null = null;

  let pendingOwnMessageIds = new Set<string>();

  let hasInitialMessages = false;

  let hasInitialStatus = false;

  let isChatViewActive = false;
  return {
    listenToSession: () => {
      const { sessionId } = get();
      if (!sessionId) return;
      get().stopListening();
      const sref = doc(db, 'sessions', sessionId);

      sessionUnsub = onSnapshot(sref, (snap) => {
        const data = snap?.data();
        if (!data) return;
        const newStatus = parseSessionStatus(data.status);
        const oldStatus = get().status;
        const role = get().myRole;

        const anomalyType = parseAnomalyType(data.anomaly?.type);
        const sosSilent = data.sosSilent === true;
        if (hasInitialStatus && role === 'watcher' &&
          (newStatus === 'alert' || newStatus === 'sos' || newStatus === 'anomaly') && oldStatus !== newStatus) {
          scheduleAlertNotification(newStatus, sessionId, anomalyType, sosSilent);
        }

        const patch: Partial<SessionState> = { status: newStatus };
        if (newStatus !== 'sos') {
          runtime.sosDeliveryRequestId += 1;
          patch.sosDeliveryStatus = 'idle';
        }
        const createdAt = tsToDate(data.createdAt);
        if (createdAt) patch.sessionCreatedAt = createdAt;
        if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
          patch.walkerLocation = { latitude: data.latitude, longitude: data.longitude };
        }
        if (typeof data.homeLatitude === 'number' && typeof data.homeLongitude === 'number') {
          patch.homeLocation = { latitude: data.homeLatitude, longitude: data.homeLongitude };
        }
        if (typeof data.batteryLevel === 'number') patch.walkerBatteryLevel = data.batteryLevel;
        if (typeof data.batteryState === 'string') patch.walkerBatteryState = data.batteryState;
        const startedAt = tsToDate(data.startedAt);
        if (startedAt) patch.walkStartedAt = startedAt;
        const expires = tsToDate(data.expiresAt);
        if (expires) patch.expiresAt = expires;
        if (typeof data.estimatedMinutes === 'number') patch.estimatedMinutes = data.estimatedMinutes;
        if (data.mode === 'sentinel' || data.mode === 'hold') patch.mode = data.mode;
        if (data.sentinelSensitivity != null) patch.sentinelSensitivity = parseSensitivity(data.sentinelSensitivity);
        if (data.transport != null) patch.transport = parseTransport(data.transport);
        patch.anomalyType = newStatus === 'anomaly' ? anomalyType : null;
        patch.sosSilent = newStatus === 'sos' && sosSilent;
        patch.sosAt = newStatus === 'sos' ? tsToDate(data.sosAt) : null;
        patch.sosAcknowledgedAt = newStatus === 'sos' ? tsToDate(data.sosAcknowledgedAt) : null;
        patch.walkerPhone = typeof data.walkerPhone === 'string' && data.walkerPhone.length > 0
          ? data.walkerPhone
          : null;
        patch.walkerName = parseWalkerName(data.walkerName);
        patch.locationMode = parseLocationMode(data.locationMode);
        patch.endedBy = parseSessionEndedBy(data.endedBy);
        const sc = data.safetyCheck;
        patch.safetyCheckRequestedAt = sc?.requestedAt ? tsToDate(sc.requestedAt) : null;
        patch.safetyCheckResponse = sc?.response === 'ok' || sc?.response === 'sos' ? sc.response : null;
        const heartbeat = tsToDate(data.lastHeartbeat);
        if (heartbeat) patch.lastHeartbeatDate = heartbeat;

        hasInitialStatus = true;

        // 終端は3つ（ended / arrived / cancelled）。cancelled を漏らすと、見守り側の
        // 離脱ガードが解けず、歩く人側の終端表示（SessionEndedOverlay の cancelled）
        // にも到達しないまま購読だけが残る。
        if (newStatus === 'ended' || newStatus === 'arrived' || newStatus === 'cancelled') {
          patch.isSessionExpired = true;
          if (newStatus !== 'arrived') patch.walkerLocation = null;
        }
        set(patch);
        get().startConnectionMonitoring(); // ハートビート評価を有効化
        // 購読の解放は画面側の終端表示より後でよいので、ended / cancelled で止める
        if (newStatus === 'ended' || newStatus === 'cancelled') get().stopListening();
        // 見守りセッションの永続化を解除。歩く人が endSession('arrived') で無事到着した
        // 場合も status は文字どおり 'ended' にはならず 'arrived' になる（endSession の実装参照）ため、
        // ended だけでなく arrived もここで「セッション終了」として扱う（isSessionExpired と同じ扱い）。
        if (role === 'watcher' && (newStatus === 'ended' || newStatus === 'arrived' || newStatus === 'cancelled')) {
          // 複数見守り（v3 §2.3）では、終わったセッションだけを永続化から外す。
          // 全消しにすると、並行して見守っている別のセッションへ次回起動で復帰できなくなる。
          removeActiveWatch(sessionId).catch(() => { });
        }
      });

      messagesUnsub = onSnapshot(
        query(collection(db, 'sessions', sessionId, 'messages'), orderBy('timestamp')),
        { includeMetadataChanges: true },
        (snap) => {
          if (!snap) return;
          const role = get().myRole;
          const newMessages: ChatMessage[] = snap.docs.map((d) => ({
            id: d.id,
            text: (d.data().text as string) ?? '',
            sender: (d.data().sender as string) ?? '',
            acknowledged: Boolean(d.data().acknowledged),
            pending: d.metadata.hasPendingWrites,
          }));

          if (hasInitialMessages) {
            const oldIds = new Set(get().messages.map((m) => m.id));
            const added = newMessages.filter((m) => !oldIds.has(m.id));
            for (const m of added) {
              if (m.sender !== role && !isChatViewActive) {
                const who = m.sender === 'walker' ? '歩く人' : '見守り';
                notify(`${who}からメッセージ 💬`, m.text, 'default', { type: 'message', sessionId });
              }
            }
          } else {
            hasInitialMessages = true;
          }

          // 自分のメッセージがサーバーに届いた瞬間 → 軽い振動
          const delivered = [...pendingOwnMessageIds].filter((id) =>
            newMessages.some((m) => m.id === id && !m.pending)
          );
          if (delivered.length > 0) haptics.success();
          pendingOwnMessageIds = new Set(
            newMessages.filter((m) => m.pending && m.sender === role).map((m) => m.id)
          );

          set({ messages: newMessages });
        }
      );

      routeUnsub = onSnapshot(
        query(collection(db, 'sessions', sessionId, 'route'), orderBy('timestamp')),
        (snap) => {
          if (!snap) return;
          const coords: Coord[] = snap.docs
            .map((d) => d.data())
            .filter((d) => typeof d.lat === 'number' && typeof d.lng === 'number')
            .map((d) => ({ latitude: d.lat, longitude: d.lng }));
          set({ routeCoordinates: coords });
        }
      );
    },

    stopListening: () => {
      sessionUnsub?.(); messagesUnsub?.(); routeUnsub?.();
      sessionUnsub = messagesUnsub = routeUnsub = null;
      hasInitialMessages = false;
      hasInitialStatus = false;
      pendingOwnMessageIds = new Set();
    },

    acknowledgeMessage: (id) => {
      const { sessionId } = get();
      if (!sessionId) return;
      updateDoc(doc(db, 'sessions', sessionId, 'messages', id), { acknowledged: true }).catch(() => { });
    },

    sendMessage: (text) => {
      const { sessionId, myRole } = get();
      if (!sessionId || !myRole) return;
      addDoc(collection(db, 'sessions', sessionId, 'messages'), {
        text,
        timestamp: serverTimestamp(),
        sender: myRole,
      }).catch(() => { });
    },

    setChatViewActive: (active) => { isChatViewActive = active; },
  };
}
