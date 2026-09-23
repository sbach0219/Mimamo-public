// Public entry point. Screens keep importing this file; implementations live in session/.
import { createSessionStore } from './session/createSessionStore';

export type {
  Role, Coord, ConnectionStatus, WatchMode, WatchRestoreResult,
  ChatMessage, HistoryItem, StartOptions, CreateSessionOptions, PairWalkOptions,
} from './session/types';
export { WALKER_NAME_MAX, normalizeWalkerName, userError } from './session/model';

export const { useSession, ensureSignedIn } = createSessionStore();
