import { describe, expect, test } from "bun:test";

import { restorePersistedQueueState } from "./queue-state";
import { MockBackend } from "./services/playback/mock-backend";
import { PlayerService } from "./services/player";

import type { QueueState } from "@musicd/shared";

describe("persisted queue restoration", () => {
  test("restores queue modes from an empty version-3 state", () => {
    const player = new PlayerService(new MockBackend());
    const savedState: QueueState = {
      queue: [],
      queuePosition: -1,
      queueMode: { loop: true, random: true },
      savedAt: 1,
      version: 3,
    };

    const restoredState = restorePersistedQueueState(player, () => savedState);

    expect(restoredState).toBe(savedState);
    expect(player.getQueue()).toEqual([]);
    expect(player.getQueueMode()).toEqual({ loop: true, random: true });
  });
});
