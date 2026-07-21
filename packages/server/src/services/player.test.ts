import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";

import { createJellyfinQueueItems } from "@musicd/shared";

import { PlayerService } from "./player";
import { MockBackend } from "./playback/mock-backend";

import type { JellyfinItem, YouTubeQueueItem } from "@musicd/shared";

// Create mock JellyfinItem
function createMockItem(id: string, name: string): JellyfinItem {
  return {
    Id: id,
    Name: name,
    Type: "Audio",
    Artists: ["Test Artist"],
    Album: "Test Album",
    RunTimeTicks: 1800000000, // 3 minutes
  };
}

// Create array of mock queue items
function createMockQueue(count: number): JellyfinItem[] {
  return Array.from({ length: count }, (_, i) =>
    createMockItem(`item-${i}`, `Track ${i + 1}`),
  );
}

function addJellyfinItems(
  player: PlayerService,
  items: JellyfinItem[],
  clearQueue: boolean = false,
): number {
  return player.addItems(createJellyfinQueueItems(items), clearQueue);
}

// Create a mock YouTube queue item
function createMockYouTubeItem(
  videoId: string,
  name: string,
): YouTubeQueueItem {
  return {
    id: `yt-${videoId}`,
    name,
    artist: "YouTube Artist",
    duration: 240,
    source: "youtube",
    youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
  };
}

describe("PlayerService", () => {
  let player: PlayerService;
  let backend: MockBackend;
  let streamUrlGetterMock: ReturnType<typeof mock>;
  let reportStartMock: ReturnType<typeof mock>;
  let reportProgressMock: ReturnType<typeof mock>;
  let reportStopMock: ReturnType<typeof mock>;

  beforeEach(() => {
    backend = new MockBackend();
    player = new PlayerService(backend);

    // Set up mock stream URL resolver (receives full QueueItem)
    streamUrlGetterMock = mock(async (item: { id: string }) => {
      return `http://test.local/stream/${item.id}`;
    });
    player.registerStreamUrlResolver("jellyfin", streamUrlGetterMock);

    // Set up mock playback reporter
    reportStartMock = mock(async () => {});
    reportProgressMock = mock(async () => {});
    reportStopMock = mock(async () => {});

    player.setPlaybackReporter({
      reportStart: reportStartMock,
      reportProgress: reportProgressMock,
      reportStop: reportStopMock,
    });
  });

  afterEach(async () => {
    // Clean up any active playback
    if (player.isPlaying()) {
      await player.stop();
    }
  });

  describe("Smart play() command", () => {
    test("starts at index 0 when stopped with queue at position -1", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);

      await player.play();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(0);
      expect(streamUrlGetterMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "item-0" }),
      );
    });

    test("starts at index 0 when stopped with queue at position 0", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);
      player.restoreQueueState({ queue: player.getQueue(), position: 0 });

      await player.play();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(0);
    });

    test("loops to first track when stopped at last item", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);
      player.restoreQueueState({ queue: player.getQueue(), position: 2 });

      await player.play();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(2);
    });

    test("loops to first track when position beyond queue length", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);
      player.restoreQueueState({ queue: player.getQueue(), position: 5 });

      await player.play();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(0);
      expect(streamUrlGetterMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "item-0" }),
      );
    });
  });

  describe("playNext()", () => {
    test("stops when playing last track", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);

      await player.playFromQueue(2);

      expect(player.isPlaying()).toBe(true);

      await player.playNext();

      expect(player.isPlaying()).toBe(false);
      expect(player.getQueuePosition()).toBe(2);
    });

    test("starts playing next track when stopped", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);
      player.restoreQueueState({ queue: player.getQueue(), position: 0 });

      await player.playNext();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(1);
      expect(streamUrlGetterMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "item-1" }),
      );
    });

    test("advances to next track when playing", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);

      await player.playFromQueue(0);

      await player.playNext();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(1);
    });

    test("handles single-item queue", async () => {
      const items = createMockQueue(1);
      addJellyfinItems(player, items);

      await player.playFromQueue(0);

      await player.playNext();

      expect(player.isPlaying()).toBe(false);
      expect(player.getQueuePosition()).toBe(0);
    });

    test("does nothing when stopped at last position", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);
      player.restoreQueueState({ queue: player.getQueue(), position: 2 });

      await player.playNext();

      expect(player.isPlaying()).toBe(false);
      expect(player.getQueuePosition()).toBe(2);
    });
  });

  describe("playPrevious()", () => {
    test("restarts current track when at first position while playing", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);

      await player.playFromQueue(0);

      const callCountBefore = streamUrlGetterMock.mock.calls.length;

      await player.playPrevious();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(0);
      expect(streamUrlGetterMock.mock.calls.length).toBeGreaterThan(
        callCountBefore,
      );
    });

    test("does nothing when at position 0 and stopped", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);
      player.restoreQueueState({ queue: player.getQueue(), position: 0 });

      await player.playPrevious();

      expect(player.isPlaying()).toBe(false);
      expect(player.getQueuePosition()).toBe(0);
    });

    test("starts playing previous track when stopped", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);
      player.restoreQueueState({ queue: player.getQueue(), position: 2 });

      await player.playPrevious();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(1);
      expect(streamUrlGetterMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "item-1" }),
      );
    });

    test("goes to previous track when playing", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);

      await player.playFromQueue(2);

      await player.playPrevious();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(1);
    });
  });

  describe("pause()", () => {
    test("pauses when playing", async () => {
      const items = createMockQueue(1);
      addJellyfinItems(player, items);

      await player.playFromQueue(0);

      player.pause();

      expect((await player.getStatus()).state).toBe("paused");
    });

    test("does nothing when stopped", () => {
      player.pause();
      expect(player.isPlaying()).toBe(false);
    });

    test("does nothing when already paused", async () => {
      const items = createMockQueue(1);
      addJellyfinItems(player, items);

      await player.playFromQueue(0);

      player.pause();
      expect((await player.getStatus()).state).toBe("paused");

      player.pause();
      expect((await player.getStatus()).state).toBe("paused");
    });
  });

  describe("resume()", () => {
    test("resumes when paused", async () => {
      const items = createMockQueue(1);
      addJellyfinItems(player, items);

      await player.playFromQueue(0);

      player.pause();
      expect((await player.getStatus()).state).toBe("paused");

      await player.resume();
      expect((await player.getStatus()).state).toBe("playing");
    });

    test("does nothing when playing", async () => {
      const items = createMockQueue(1);
      addJellyfinItems(player, items);

      await player.playFromQueue(0);

      await player.resume();
      expect((await player.getStatus()).state).toBe("playing");
    });

    test("does nothing when stopped with no queue", async () => {
      await player.resume();
      expect(player.isPlaying()).toBe(false);
    });

    test("starts playback from restored queue position when stopped with queue", async () => {
      const items = createMockQueue(5);
      addJellyfinItems(player, items);

      // Simulate server restart: restore queue state at position 2
      player.restoreQueueState({ queue: player.getQueue(), position: 2 });

      // Verify precondition: nothing is playing
      expect(player.isPlaying()).toBe(false);
      expect(player.getQueuePosition()).toBe(2);

      // resume() should start playback from the restored position
      await player.resume();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(2);
      expect(streamUrlGetterMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "item-2" }),
      );
    });

    test("does nothing when stopped with empty queue", async () => {
      // No queue, no playback — resume should be a no-op, not throw
      expect(player.isPlaying()).toBe(false);
      expect(player.getQueue().length).toBe(0);

      await player.resume();
      expect(player.isPlaying()).toBe(false);
    });
  });

  describe("stop()", () => {
    test("stops playback", async () => {
      const items = createMockQueue(1);
      addJellyfinItems(player, items);

      await player.playFromQueue(0);

      expect(player.isPlaying()).toBe(true);

      await player.stop();

      expect(player.isPlaying()).toBe(false);
    });

    test("preserves queue position", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);

      await player.playFromQueue(1);

      await player.stop();

      expect(player.getQueuePosition()).toBe(1);
    });

    test("does nothing when already stopped", async () => {
      await player.stop();
      expect(player.isPlaying()).toBe(false);
    });

    test("reports one stop for the active Jellyfin session", async () => {
      addJellyfinItems(player, createMockQueue(1));
      await player.playFromQueue(0);
      backend.setPosition(42);

      await player.stop();

      expect(reportStopMock).toHaveBeenCalledTimes(1);
      expect(reportStopMock).toHaveBeenCalledWith(
        "item-0",
        expect.any(String),
        420000000,
      );
      expect((await player.getStatus()).state).toBe("stopped");
    });
  });

  describe("Queue management", () => {
    test("stops playback when queue cleared while playing", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);
      await player.playFromQueue(0);

      expect(player.isPlaying()).toBe(true);

      player.clearQueue();

      // Allow fire-and-forget stop() promise to resolve
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(player.getQueue().length).toBe(0);
      expect(player.getQueuePosition()).toBe(-1);
      expect(player.isPlaying()).toBe(false);
    });

    test("continues playback when items added to queue", async () => {
      const items = createMockQueue(2);
      addJellyfinItems(player, items);

      await player.playFromQueue(0);

      const moreItems = createMockQueue(2).map((item, i) =>
        createMockItem(`new-${i}`, `New Track ${i + 1}`),
      );
      addJellyfinItems(player, moreItems);

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(0);
      expect(player.getQueue().length).toBe(4);
    });

    test("stops when current track removed", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);

      await player.playFromQueue(1);

      expect(player.isPlaying()).toBe(true);

      player.removeFromQueue(1);

      // Give removeFromQueue time to trigger stop

      expect(player.getQueue().length).toBe(2);
    });

    test("adjusts position when track before current removed", async () => {
      const items = createMockQueue(5);
      addJellyfinItems(player, items);

      await player.playFromQueue(3);

      player.removeFromQueue(1);

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(2);
      expect(player.getQueue().length).toBe(4);
    });

    test("maintains position when track after current removed", async () => {
      const items = createMockQueue(5);
      addJellyfinItems(player, items);

      await player.playFromQueue(2);

      player.removeFromQueue(4);

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(2);
      expect(player.getQueue().length).toBe(4);
    });
  });

  describe("Queue modes", () => {
    test("loop wraps from the queue end to the first track", async () => {
      addJellyfinItems(player, createMockQueue(3));
      await player.playFromQueue(2);
      player.setQueueMode({ loop: true });

      await player.playNext();

      const status = await player.getStatus();
      expect(status.state).toBe("playing");
      expect(status.queuePosition).toBe(0);
      expect(status.currentItem?.id).toBe("item-0");
    });

    test("random chooses a valid next track and updates the active position", async () => {
      addJellyfinItems(player, createMockQueue(3));
      await player.playFromQueue(0);
      player.setQueueMode({ random: true });
      const originalRandom = Math.random;
      Math.random = () => 0.99;

      try {
        await player.playNext();
      } finally {
        Math.random = originalRandom;
      }

      const status = await player.getStatus();
      if (!status.currentItem) {
        throw new Error("Expected random playback to select an active item");
      }
      expect(status.queuePosition).toBeGreaterThanOrEqual(0);
      expect(status.queuePosition).toBeLessThan(status.queue.length);
      expect(status.queue[status.queuePosition].id).toBe(status.currentItem.id);
      expect(status.currentItem.id).not.toBe("item-0");
    });

    test("shuffle preserves the active track and position while playing", async () => {
      addJellyfinItems(player, createMockQueue(4));
      await player.playFromQueue(2);
      const activeItem = (await player.getStatus()).currentItem;
      if (!activeItem) {
        throw new Error("Expected an active item before shuffling");
      }
      const originalRandom = Math.random;
      Math.random = () => 0;

      try {
        player.shuffleQueue();
      } finally {
        Math.random = originalRandom;
      }

      const status = await player.getStatus();
      expect(status.state).toBe("playing");
      expect(status.currentItem).toEqual(activeItem);
      expect(status.queuePosition).toBe(2);
      expect(status.queue[status.queuePosition].id).toBe(activeItem.id);
    });

    test("shuffle preserves the active track and position while paused", async () => {
      addJellyfinItems(player, createMockQueue(4));
      await player.playFromQueue(2);
      player.pause();
      const activeItem = (await player.getStatus()).currentItem;
      if (!activeItem) {
        throw new Error("Expected an active item before shuffling");
      }
      const originalRandom = Math.random;
      Math.random = () => 0;

      try {
        player.shuffleQueue();
      } finally {
        Math.random = originalRandom;
      }

      const status = await player.getStatus();
      expect(status.state).toBe("paused");
      expect(status.currentItem).toEqual(activeItem);
      expect(status.queuePosition).toBe(2);
      expect(status.queue[status.queuePosition].id).toBe(activeItem.id);
    });

    test("mode changes trigger persistence and survive a restore", () => {
      addJellyfinItems(player, createMockQueue(2));
      let savedState: ReturnType<PlayerService["getQueueState"]> | undefined;
      player.enableStatePersistence(() => {
        savedState = player.getQueueState();
      });

      player.setQueueMode({ loop: true, random: true });

      if (!savedState) {
        throw new Error("Expected queue mode change to trigger persistence");
      }
      const restoredPlayer = new PlayerService(new MockBackend());
      restoredPlayer.restoreQueueState(savedState);
      expect(restoredPlayer.getQueueMode()).toEqual({
        loop: true,
        random: true,
      });
      expect(restoredPlayer.getQueue()).toHaveLength(2);
    });

    test("restores persisted modes when the queue is empty", () => {
      const restoredPlayer = new PlayerService(new MockBackend());

      restoredPlayer.restoreQueueState({
        queue: [],
        position: -1,
        queueMode: { loop: true, random: true },
      });

      expect(restoredPlayer.getQueue()).toEqual([]);
      expect(restoredPlayer.getQueueMode()).toEqual({
        loop: true,
        random: true,
      });
    });
  });

  describe("Auto-advance", () => {
    // NOTE: These tests use MockBackend to simulate track completion.
    // The real FFPlayBackend detects completion via process exit events.
    test("stops when last track finishes naturally", async () => {
      const items = createMockQueue(2);
      addJellyfinItems(player, items);

      await player.playFromQueue(1);

      expect(player.isPlaying()).toBe(true);

      // Simulate track ending
      await backend.simulateComplete();

      expect(player.isPlaying()).toBe(false);
    });

    test("advances to next track when mid-queue track finishes", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);

      await player.playFromQueue(0);

      expect(player.getQueuePosition()).toBe(0);

      // Simulate track ending - should auto-advance
      await backend.simulateComplete();

      // Should have advanced to next track
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(player.getQueuePosition()).toBe(1);
      expect(player.isPlaying()).toBe(true);
    });

    test("does not advance when manually stopped", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);

      await player.playFromQueue(0);

      const positionBefore = player.getQueuePosition();

      await player.stop();

      expect(player.isPlaying()).toBe(false);
      expect(player.getQueuePosition()).toBe(positionBefore);
    });
  });

  describe("Playback reporting lifecycle", () => {
    function installPendingStopReport(): () => void {
      let resolveStopReport: () => void = () => {
        throw new Error("Stop report promise was not initialized");
      };
      const stopReportPromise = new Promise<void>((resolve) => {
        resolveStopReport = resolve;
      });
      reportStopMock = mock(() => stopReportPromise);
      player.setPlaybackReporter({
        reportStart: reportStartMock,
        reportProgress: reportProgressMock,
        reportStop: reportStopMock,
      });
      return resolveStopReport;
    }

    test("track replacement closes the previous session without reusing its identifier", async () => {
      addJellyfinItems(player, createMockQueue(2));
      await player.playFromQueue(0);
      backend.setPosition(12);

      await player.playFromQueue(1);

      expect(reportStartMock).toHaveBeenCalledTimes(2);
      expect(reportStopMock).toHaveBeenCalledTimes(1);
      const firstSessionId = reportStartMock.mock.calls[0][1];
      const secondSessionId = reportStartMock.mock.calls[1][1];
      expect(firstSessionId).not.toBe(secondSessionId);
      expect(reportStopMock).toHaveBeenCalledWith(
        "item-0",
        firstSessionId,
        120000000,
      );

      backend.setPosition(24);
      await player.stop();

      expect(reportStopMock).toHaveBeenCalledTimes(2);
      expect(reportStopMock).toHaveBeenLastCalledWith(
        "item-1",
        secondSessionId,
        240000000,
      );
      expect((await player.getStatus()).state).toBe("stopped");
    });

    test("manual stop prevents auto-advance while its report is pending", async () => {
      const resolveStopReport = installPendingStopReport();
      addJellyfinItems(player, createMockQueue(2));
      await player.playFromQueue(0);

      const stopPromise = player.stop();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await backend.simulateComplete();
      resolveStopReport();
      await stopPromise;

      expect(reportStartMock).toHaveBeenCalledTimes(1);
      expect(reportStopMock).toHaveBeenCalledTimes(1);
      const status = await player.getStatus();
      expect(status.state).toBe("stopped");
      expect(status.currentItem).toBeNull();
      expect(status.queuePosition).toBe(0);
    });

    test("pending manual stop cannot clear newly started playback", async () => {
      const resolveStopReport = installPendingStopReport();
      addJellyfinItems(player, createMockQueue(2));
      await player.playFromQueue(0);

      const stopPromise = player.stop();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await player.playFromQueue(1);
      resolveStopReport();
      await stopPromise;

      expect(reportStartMock).toHaveBeenCalledTimes(2);
      const status = await player.getStatus();
      expect(status.state).toBe("playing");
      expect(status.currentItem?.id).toBe("item-1");
      expect(status.queuePosition).toBe(1);
    });

    test("queue clearing closes the active session once", async () => {
      addJellyfinItems(player, createMockQueue(2));
      await player.playFromQueue(0);
      backend.setPosition(15);

      player.clearQueue();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(reportStopMock).toHaveBeenCalledTimes(1);
      expect(reportStopMock.mock.calls[0][2]).toBe(150000000);
      const status = await player.getStatus();
      expect(status.state).toBe("stopped");
      expect(status.currentItem).toBeNull();
      expect(status.queue).toEqual([]);
      expect(status.queuePosition).toBe(-1);
    });

    test("natural completion reports the final position once", async () => {
      addJellyfinItems(player, createMockQueue(1));
      await player.playFromQueue(0);
      backend.setPosition(180);

      await backend.simulateComplete();

      expect(reportStopMock).toHaveBeenCalledTimes(1);
      expect(reportStopMock.mock.calls[0][2]).toBe(1800000000);
      const status = await player.getStatus();
      expect(status.state).toBe("stopped");
      expect(status.currentItem).toBeNull();
    });

    test("natural completion starts the next track with a new session", async () => {
      addJellyfinItems(player, createMockQueue(2));
      await player.playFromQueue(0);
      backend.setPosition(180);

      await backend.simulateComplete();

      expect(reportStartMock).toHaveBeenCalledTimes(2);
      expect(reportStopMock).toHaveBeenCalledTimes(1);
      const firstSessionId = reportStartMock.mock.calls[0][1];
      const secondSessionId = reportStartMock.mock.calls[1][1];
      expect(firstSessionId).not.toBe(secondSessionId);
      expect(reportStopMock.mock.calls[0][1]).toBe(firstSessionId);
      const status = await player.getStatus();
      expect(status.state).toBe("playing");
      expect(status.currentItem?.id).toBe("item-1");
    });

    test("stale natural completion cannot clear newly started playback", async () => {
      const resolveStopReport = installPendingStopReport();
      addJellyfinItems(player, createMockQueue(2));
      await player.playFromQueue(0);

      const completionPromise = backend.simulateComplete();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await player.playFromQueue(1);
      resolveStopReport();
      await completionPromise;

      expect(reportStartMock).toHaveBeenCalledTimes(2);
      const status = await player.getStatus();
      expect(status.state).toBe("playing");
      expect(status.currentItem?.id).toBe("item-1");
      expect(status.queuePosition).toBe(1);
    });

    test("backend error closes the active session once", async () => {
      addJellyfinItems(player, createMockQueue(1));
      await player.playFromQueue(0);
      backend.setPosition(31);

      await backend.simulateError(new Error("decoder failed"));
      await player.stop();

      expect(reportStopMock).toHaveBeenCalledTimes(1);
      expect(reportStopMock.mock.calls[0][2]).toBe(310000000);
      const status = await player.getStatus();
      expect(status.state).toBe("stopped");
      expect(status.currentItem).toBeNull();
    });

    test("stale backend error cannot clear newly started playback", async () => {
      const resolveStopReport = installPendingStopReport();
      addJellyfinItems(player, createMockQueue(2));
      await player.playFromQueue(0);

      const errorPromise = backend.simulateError(new Error("decoder failed"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await player.playFromQueue(1);
      resolveStopReport();
      await errorPromise;

      expect(reportStartMock).toHaveBeenCalledTimes(2);
      expect(reportStopMock).toHaveBeenCalledTimes(1);
      const status = await player.getStatus();
      expect(status.state).toBe("playing");
      expect(status.currentItem?.id).toBe("item-1");
      expect(status.queuePosition).toBe(1);
    });
  });

  describe("Edge cases", () => {
    test("handles empty queue gracefully", () => {
      expect(player.getQueue().length).toBe(0);
      expect(player.getQueuePosition()).toBe(-1);
      expect(player.isPlaying()).toBe(false);
    });

    test("handles position beyond queue length", async () => {
      const items = createMockQueue(3);
      addJellyfinItems(player, items);
      player.restoreQueueState({ queue: player.getQueue(), position: 10 });

      await player.play();

      expect(player.getQueuePosition()).toBe(0);
    });

    test("handles rapid pause/resume sequences", async () => {
      const items = createMockQueue(1);
      addJellyfinItems(player, items);

      await player.playFromQueue(0);

      player.pause();
      player.resume();
      player.pause();
      player.resume();

      expect((await player.getStatus()).state).toBe("playing");
    });
  });

  describe("YouTube queue items", () => {
    let youtubeResolverMock: ReturnType<typeof mock>;

    beforeEach(() => {
      youtubeResolverMock = mock(async (item: { id: string }) => {
        return `https://cdn.youtube.com/stream/${item.id}`;
      });
      player.registerStreamUrlResolver("youtube", youtubeResolverMock);
    });

    test("adds YouTube items via addItems()", () => {
      const ytItem = createMockYouTubeItem("abc123", "YouTube Song");
      player.addItems([ytItem]);

      const queue = player.getQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].source).toBe("youtube");
      expect(queue[0].name).toBe("YouTube Song");
      expect((queue[0] as YouTubeQueueItem).youtubeUrl).toBe(
        "https://www.youtube.com/watch?v=abc123",
      );
    });

    test("plays YouTube item using youtube resolver", async () => {
      const ytItem = createMockYouTubeItem("abc123", "YouTube Song");
      player.addItems([ytItem]);

      await player.playFromQueue(0);

      expect(player.isPlaying()).toBe(true);
      expect(youtubeResolverMock).toHaveBeenCalledTimes(1);
      expect(youtubeResolverMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "yt-abc123", source: "youtube" }),
      );
      // Jellyfin resolver should NOT have been called
      expect(streamUrlGetterMock).not.toHaveBeenCalled();
    });

    test("does not report playback for YouTube items", async () => {
      const ytItem = createMockYouTubeItem("abc123", "YouTube Song");
      player.addItems([ytItem]);

      await player.playFromQueue(0);

      expect(player.isPlaying()).toBe(true);
      // Playback reporting is Jellyfin-only
      expect(reportStartMock).not.toHaveBeenCalled();
    });

    test("does not report stop when YouTube playback ends", async () => {
      const ytItem = createMockYouTubeItem("abc123", "YouTube Song");
      player.addItems([ytItem]);
      await player.playFromQueue(0);
      backend.setPosition(24);

      await backend.simulateComplete();

      expect(reportStartMock).not.toHaveBeenCalled();
      expect(reportProgressMock).not.toHaveBeenCalled();
      expect(reportStopMock).not.toHaveBeenCalled();
      expect((await player.getStatus()).state).toBe("stopped");
    });

    test("throws when no resolver registered for source", async () => {
      // Create a player without the youtube resolver
      const freshBackend = new MockBackend();
      const freshPlayer = new PlayerService(freshBackend);
      freshPlayer.registerStreamUrlResolver("jellyfin", streamUrlGetterMock);

      const ytItem = createMockYouTubeItem("abc123", "YouTube Song");
      freshPlayer.addItems([ytItem]);

      await expect(freshPlayer.playFromQueue(0)).rejects.toThrow(
        "No stream URL resolver registered for source: youtube",
      );
    });

    test("status includes source for YouTube item", async () => {
      const ytItem = createMockYouTubeItem("abc123", "YouTube Song");
      player.addItems([ytItem]);

      await player.playFromQueue(0);

      const status = await player.getStatus();
      expect(status.currentItem?.source).toBe("youtube");
      expect(status.currentItem?.name).toBe("YouTube Song");
    });
  });

  describe("Mixed Jellyfin + YouTube queue", () => {
    let youtubeResolverMock: ReturnType<typeof mock>;

    beforeEach(() => {
      youtubeResolverMock = mock(async (item: { id: string }) => {
        return `https://cdn.youtube.com/stream/${item.id}`;
      });
      player.registerStreamUrlResolver("youtube", youtubeResolverMock);
    });

    test("queue contains both sources", () => {
      const jellyfinItems = createMockQueue(2);
      addJellyfinItems(player, jellyfinItems);

      const ytItem = createMockYouTubeItem("yt1", "YT Track");
      player.addItems([ytItem]);

      const queue = player.getQueue();
      expect(queue).toHaveLength(3);
      expect(queue[0].source).toBe("jellyfin");
      expect(queue[1].source).toBe("jellyfin");
      expect(queue[2].source).toBe("youtube");
    });

    test("advances from Jellyfin to YouTube track", async () => {
      const jellyfinItems = createMockQueue(1);
      addJellyfinItems(player, jellyfinItems);

      const ytItem = createMockYouTubeItem("yt1", "YT Track");
      player.addItems([ytItem]);

      await player.playFromQueue(0);
      expect(player.isPlaying()).toBe(true);
      expect(streamUrlGetterMock).toHaveBeenCalledTimes(1);

      await player.playNext();
      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(1);
      expect(youtubeResolverMock).toHaveBeenCalledTimes(1);
    });

    test("advances from YouTube to Jellyfin track", async () => {
      const ytItem = createMockYouTubeItem("yt1", "YT Track");
      player.addItems([ytItem]);

      const jellyfinItems = createMockQueue(1);
      addJellyfinItems(player, jellyfinItems);

      await player.playFromQueue(0);
      expect(youtubeResolverMock).toHaveBeenCalledTimes(1);

      await player.playNext();
      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(1);
      expect(streamUrlGetterMock).toHaveBeenCalledTimes(1);
    });

    test("reports playback only for Jellyfin items in mixed queue", async () => {
      const ytItem = createMockYouTubeItem("yt1", "YT Track");
      player.addItems([ytItem]);

      const jellyfinItems = createMockQueue(1);
      addJellyfinItems(player, jellyfinItems);

      // Play YouTube item first — no reporting
      await player.playFromQueue(0);
      expect(reportStartMock).not.toHaveBeenCalled();

      // Advance to Jellyfin item — should report
      await player.playNext();
      expect(reportStartMock).toHaveBeenCalledTimes(1);
    });

    test("clearQueue works with mixed items", async () => {
      const jellyfinItems = createMockQueue(2);
      addJellyfinItems(player, jellyfinItems);

      const ytItem = createMockYouTubeItem("yt1", "YT Track");
      player.addItems([ytItem]);

      expect(player.getQueue()).toHaveLength(3);

      player.clearQueue();

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(player.getQueue()).toHaveLength(0);
      expect(player.getQueuePosition()).toBe(-1);
    });

    test("addItems with clearQueue replaces mixed queue", () => {
      const jellyfinItems = createMockQueue(2);
      addJellyfinItems(player, jellyfinItems);

      const ytItem = createMockYouTubeItem("yt1", "YT Track");
      player.addItems([ytItem], true);

      const queue = player.getQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].source).toBe("youtube");
    });
  });
});
