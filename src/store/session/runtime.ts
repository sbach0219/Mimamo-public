import { RouteThinner } from '../../lib/routeThinning';

// Shared only within one store. Background location keeps its own RouteThinner.
export function createSessionRuntime() {
  return { routeThinner: new RouteThinner(), sosDeliveryRequestId: 0 };
}

export type SessionRuntime = ReturnType<typeof createSessionRuntime>;
