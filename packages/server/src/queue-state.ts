import type { QueueState } from "@musicd/shared";
import type { PlayerService } from "./services/player";

export interface QueueStateRestorer {
  restoreQueueState: PlayerService["restoreQueueState"];
}

/**
 * Load and restore persisted queue state, including modes for an empty queue.
 */
export function restorePersistedQueueState(
  playerService: QueueStateRestorer,
  loadState: () => QueueState | null,
): QueueState | null {
  const savedState = loadState();
  if (!savedState) {
    return null;
  }

  playerService.restoreQueueState({
    queue: savedState.queue,
    position: savedState.queuePosition,
    queueMode: savedState.queueMode,
  });
  return savedState;
}
