import { create } from 'zustand';
import type { SessionState, SessionContext } from './types';
import { createSessionAuth } from './auth';
import { createSessionRuntime } from './runtime';
import { createLifecycleActions } from './lifecycle';
import { createRestorationActions } from './restoration';
import { createSubscriptionsActions } from './subscriptions';
import { createSafetyActions } from './safety';
import { createTelemetryActions } from './telemetry';
import { createDetailsActions } from './details';

// Factories receive set/get, never import the singleton. Timers and listeners
// belong to this store instance, so they cannot leak into another instance.
export function createSessionStore() {
  let authentication!: ReturnType<typeof createSessionAuth>;
  const useSession = create<SessionState>((set, get, store) => {
    authentication = createSessionAuth(set, get, store.subscribe);
    const context: SessionContext = {
      set, get, runtime: createSessionRuntime(), ensureSignedIn: authentication.ensureSignedIn,
    };
    return {
      authReady: false,
      uid: null,
      fcmToken: null,
      sessionId: null,
      pendingJoinId: null,
      isJoining: false,
      joinError: null,
      status: 'active',
      pairId: null,
      messages: [],
      estimatedMinutes: 10,
      isSessionExpired: false,
      myRole: null,
      mode: 'hold',
      sentinelSensitivity: 'medium',
      transport: 'vehicle_ok',
      walkerLocation: null,
      homeLocation: null,
      routeCoordinates: [],
      connectionStatus: 'good',
      sessionCreatedAt: null,
      expiresAt: null,
      walkStartedAt: null,
      lastHeartbeatDate: null,
      walkerBatteryLevel: null,
      walkerBatteryState: null,
      anomalyType: null,
      sosSilent: false,
      sosAt: null,
      sosAcknowledgedAt: null,
      walkerPhone: null,
      walkerName: null,
      locationMode: null,
      endedBy: null,
      sosDeliveryStatus: 'idle',
      lastHeartbeatOkAt: null,
      safetyCheckRequestedAt: null,
      safetyCheckResponse: null,
      ...authentication.actions,
      ...createLifecycleActions(context),
      ...createRestorationActions(context),
      ...createSubscriptionsActions(context),
      ...createSafetyActions(context),
      ...createTelemetryActions(context),
      ...createDetailsActions(context),
    };
  });
  return { useSession, ensureSignedIn: authentication.ensureSignedIn };
}
