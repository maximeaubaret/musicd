import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import { PlayerService } from "./player";
import { MockBackend } from "./playback/mock-backend";
import type { JellyfinItem } from "@musicd/shared";

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

    // Set up mock stream URL getter
    streamUrlGetterMock = mock(async (itemId: string) => {
      return `http://test.local/stream/${itemId}`;
    });
    player.setStreamUrlGetter(streamUrlGetterMock);

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
      player.addToQueue(items);

      await player.play();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(0);
      expect(streamUrlGetterMock).toHaveBeenCalledWith("item-0");
    });

    test("starts at index 0 when stopped with queue at position 0", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);
      player.restoreQueueState({ queue: player.getQueue(), position: 0 });

      await player.play();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(0);
    });

    test("loops to first track when stopped at last item", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);
      player.restoreQueueState({ queue: player.getQueue(), position: 2 });

      await player.play();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(2);
    });

    test("loops to first track when position beyond queue length", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);
      player.restoreQueueState({ queue: player.getQueue(), position: 5 });

      await player.play();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(0);
      expect(streamUrlGetterMock).toHaveBeenCalledWith("item-0");
    });

    test("resumes when paused", async () => {
      const items = createMockQueue(1);
      player.addToQueue(items);

      await player.playFromQueue(0);

      player.pause();
      expect((await player.getStatus()).state).toBe("paused");

      await player.play();
      expect((await player.getStatus()).state).toBe("playing");
    });

    test("does nothing when already playing", async () => {
      const items = createMockQueue(2);
      player.addToQueue(items);

      await player.playFromQueue(0);

      const callCountBefore = streamUrlGetterMock.mock.calls.length;

      await player.play();

      expect(streamUrlGetterMock.mock.calls.length).toBe(callCountBefore);
      expect(player.getQueuePosition()).toBe(0);
    });

    test("throws error when queue is empty", async () => {
      await expect(player.play()).rejects.toThrow("queue is empty");
    });

    test("plays from current position when stopped mid-queue", async () => {
      const items = createMockQueue(5);
      player.addToQueue(items);
      player.restoreQueueState({ queue: player.getQueue(), position: 2 });

      await player.play();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(2);
      expect(streamUrlGetterMock).toHaveBeenCalledWith("item-2");
    });
  });

  describe("playNext()", () => {
    test("stops when playing last track", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);

      await player.playFromQueue(2);

      expect(player.isPlaying()).toBe(true);

      await player.playNext();

      expect(player.isPlaying()).toBe(false);
      expect(player.getQueuePosition()).toBe(2);
    });

    test("starts playing next track when stopped", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);
      player.restoreQueueState({ queue: player.getQueue(), position: 0 });

      await player.playNext();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(1);
      expect(streamUrlGetterMock).toHaveBeenCalledWith("item-1");
    });

    test("advances to next track when playing", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);

      await player.playFromQueue(0);

      await player.playNext();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(1);
    });

    test("handles single-item queue", async () => {
      const items = createMockQueue(1);
      player.addToQueue(items);

      await player.playFromQueue(0);

      await player.playNext();

      expect(player.isPlaying()).toBe(false);
      expect(player.getQueuePosition()).toBe(0);
    });

    test("does nothing when stopped at last position", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);
      player.restoreQueueState({ queue: player.getQueue(), position: 2 });

      await player.playNext();

      expect(player.isPlaying()).toBe(false);
      expect(player.getQueuePosition()).toBe(2);
    });
  });

  describe("playPrevious()", () => {
    test("restarts current track when at first position while playing", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);

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
      player.addToQueue(items);
      player.restoreQueueState({ queue: player.getQueue(), position: 0 });

      await player.playPrevious();

      expect(player.isPlaying()).toBe(false);
      expect(player.getQueuePosition()).toBe(0);
    });

    test("starts playing previous track when stopped", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);
      player.restoreQueueState({ queue: player.getQueue(), position: 2 });

      await player.playPrevious();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(1);
      expect(streamUrlGetterMock).toHaveBeenCalledWith("item-1");
    });

    test("goes to previous track when playing", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);

      await player.playFromQueue(2);

      await player.playPrevious();

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(1);
    });
  });

  describe("pause()", () => {
    test("pauses when playing", async () => {
      const items = createMockQueue(1);
      player.addToQueue(items);

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
      player.addToQueue(items);

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
      player.addToQueue(items);

      await player.playFromQueue(0);

      player.pause();
      expect((await player.getStatus()).state).toBe("paused");

      player.resume();
      expect((await player.getStatus()).state).toBe("playing");
    });

    test("does nothing when playing", async () => {
      const items = createMockQueue(1);
      player.addToQueue(items);

      await player.playFromQueue(0);

      player.resume();
      expect((await player.getStatus()).state).toBe("playing");
    });

    test("does nothing when stopped", () => {
      player.resume();
      expect(player.isPlaying()).toBe(false);
    });
  });

  describe("stop()", () => {
    test("stops playback", async () => {
      const items = createMockQueue(1);
      player.addToQueue(items);

      await player.playFromQueue(0);

      expect(player.isPlaying()).toBe(true);

      await player.stop();

      expect(player.isPlaying()).toBe(false);
    });

    test("preserves queue position", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);

      await player.playFromQueue(1);

      await player.stop();

      expect(player.getQueuePosition()).toBe(1);
    });

    test("does nothing when already stopped", async () => {
      await player.stop();
      expect(player.isPlaying()).toBe(false);
    });
  });

  describe("Queue management", () => {
    test("stops playback when queue cleared while playing", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);

      await player.playFromQueue(0);

      expect(player.isPlaying()).toBe(true);

      player.clearQueue();

      // Give clearQueue time to trigger stop

      expect(player.getQueue().length).toBe(0);
      expect(player.getQueuePosition()).toBe(-1);
    });

    test("continues playback when items added to queue", async () => {
      const items = createMockQueue(2);
      player.addToQueue(items);

      await player.playFromQueue(0);

      const moreItems = createMockQueue(2).map((item, i) =>
        createMockItem(`new-${i}`, `New Track ${i + 1}`),
      );
      player.addToQueue(moreItems);

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(0);
      expect(player.getQueue().length).toBe(4);
    });

    test("stops when current track removed", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);

      await player.playFromQueue(1);

      expect(player.isPlaying()).toBe(true);

      player.removeFromQueue(1);

      // Give removeFromQueue time to trigger stop

      expect(player.getQueue().length).toBe(2);
    });

    test("adjusts position when track before current removed", async () => {
      const items = createMockQueue(5);
      player.addToQueue(items);

      await player.playFromQueue(3);

      player.removeFromQueue(1);

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(2);
      expect(player.getQueue().length).toBe(4);
    });

    test("maintains position when track after current removed", async () => {
      const items = createMockQueue(5);
      player.addToQueue(items);

      await player.playFromQueue(2);

      player.removeFromQueue(4);

      expect(player.isPlaying()).toBe(true);
      expect(player.getQueuePosition()).toBe(2);
      expect(player.getQueue().length).toBe(4);
    });
  });

  describe("Auto-advance", () => {
    // NOTE: These tests use MockBackend to simulate track completion.
    // The real FFPlayBackend detects completion via process exit events.
    test("stops when last track finishes naturally", async () => {
      const items = createMockQueue(2);
      player.addToQueue(items);

      await player.playFromQueue(1);

      expect(player.isPlaying()).toBe(true);

      // Simulate track ending
      backend.simulateComplete();

      expect(player.isPlaying()).toBe(false);
    });

    test("advances to next track when mid-queue track finishes", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);

      await player.playFromQueue(0);

      expect(player.getQueuePosition()).toBe(0);

      // Simulate track ending - should auto-advance
      backend.simulateComplete();

      // Should have advanced to next track
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(player.getQueuePosition()).toBe(1);
      expect(player.isPlaying()).toBe(true);
    });

    test("does not advance when manually stopped", async () => {
      const items = createMockQueue(3);
      player.addToQueue(items);

      await player.playFromQueue(0);

      const positionBefore = player.getQueuePosition();

      await player.stop();

      expect(player.isPlaying()).toBe(false);
      expect(player.getQueuePosition()).toBe(positionBefore);
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
      player.addToQueue(items);
      player.restoreQueueState({ queue: player.getQueue(), position: 10 });

      await player.play();

      expect(player.getQueuePosition()).toBe(0);
    });

    test("handles rapid pause/resume sequences", async () => {
      const items = createMockQueue(1);
      player.addToQueue(items);

      await player.playFromQueue(0);

      player.pause();
      player.resume();
      player.pause();
      player.resume();

      expect((await player.getStatus()).state).toBe("playing");
    });
  });
});
