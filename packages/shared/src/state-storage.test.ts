import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  saveQueueState,
  loadQueueState,
  clearQueueState,
  hasQueueState,
  getQueueFilePath,
} from "./state-storage";
import type { JellyfinQueueItem, YouTubeQueueItem } from "./types";

// Use a temp directory to avoid interfering with real state
let testDir: string;
let originalXdgDataHome: string | undefined;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `musicd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = testDir;
});

afterEach(() => {
  if (originalXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalXdgDataHome;
  }
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

function createJellyfinQueueItem(id: string, name: string): JellyfinQueueItem {
  return {
    id,
    name,
    artist: "Test Artist",
    album: "Test Album",
    duration: 180,
    source: "jellyfin",
    jellyfinItem: {
      Id: id,
      Name: name,
      Type: "Audio",
      Artists: ["Test Artist"],
      Album: "Test Album",
      RunTimeTicks: 1800000000,
    },
  };
}

function createYouTubeQueueItem(
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

describe("state-storage", () => {
  describe("v2 save and load", () => {
    test("saves and loads Jellyfin queue items", () => {
      const items = [
        createJellyfinQueueItem("jf-1", "Track 1"),
        createJellyfinQueueItem("jf-2", "Track 2"),
      ];
      saveQueueState(items, 1);

      const loaded = loadQueueState();
      expect(loaded).not.toBeNull();
      expect(loaded!.queue).toHaveLength(2);
      expect(loaded!.queuePosition).toBe(1);
      expect(loaded!.version).toBe(2);
      expect(loaded!.queue[0].source).toBe("jellyfin");
      expect(loaded!.queue[1].source).toBe("jellyfin");
    });

    test("saves and loads YouTube queue items", () => {
      const items = [createYouTubeQueueItem("abc123", "YT Song")];
      saveQueueState(items, 0);

      const loaded = loadQueueState();
      expect(loaded).not.toBeNull();
      expect(loaded!.queue).toHaveLength(1);
      expect(loaded!.queue[0].source).toBe("youtube");
      expect((loaded!.queue[0] as YouTubeQueueItem).youtubeUrl).toBe(
        "https://www.youtube.com/watch?v=abc123",
      );
      expect((loaded!.queue[0] as YouTubeQueueItem).videoId).toBe("abc123");
    });

    test("saves and loads mixed queue", () => {
      const items = [
        createJellyfinQueueItem("jf-1", "Jellyfin Track"),
        createYouTubeQueueItem("yt-1", "YouTube Track"),
        createJellyfinQueueItem("jf-2", "Another Jellyfin"),
      ];
      saveQueueState(items, 1);

      const loaded = loadQueueState();
      expect(loaded).not.toBeNull();
      expect(loaded!.queue).toHaveLength(3);
      expect(loaded!.queue[0].source).toBe("jellyfin");
      expect(loaded!.queue[1].source).toBe("youtube");
      expect(loaded!.queue[2].source).toBe("jellyfin");
    });
  });

  describe("v1 to v2 migration", () => {
    test("migrates v1 items by adding source: jellyfin", () => {
      // Write a v1 state file (no source field on items)
      const v1State = {
        queue: [
          {
            id: "jf-1",
            name: "Old Track 1",
            artist: "Artist",
            album: "Album",
            duration: 200,
            jellyfinItem: {
              Id: "jf-1",
              Name: "Old Track 1",
              Type: "Audio",
              Artists: ["Artist"],
              Album: "Album",
              RunTimeTicks: 2000000000,
            },
          },
          {
            id: "jf-2",
            name: "Old Track 2",
            artist: "Artist 2",
            duration: 300,
            jellyfinItem: {
              Id: "jf-2",
              Name: "Old Track 2",
              Type: "Audio",
              Artists: ["Artist 2"],
              RunTimeTicks: 3000000000,
            },
          },
        ],
        queuePosition: 0,
        savedAt: Date.now(),
        version: 1,
      };

      const queuePath = getQueueFilePath();
      mkdirSync(join(testDir, "musicd"), { recursive: true });
      writeFileSync(queuePath, JSON.stringify(v1State, null, 2), "utf-8");

      const loaded = loadQueueState();
      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(2);
      expect(loaded!.queue).toHaveLength(2);

      // All items should now have source: "jellyfin"
      expect(loaded!.queue[0].source).toBe("jellyfin");
      expect(loaded!.queue[1].source).toBe("jellyfin");

      // Original data should be preserved
      expect(loaded!.queue[0].name).toBe("Old Track 1");
      expect(loaded!.queue[1].name).toBe("Old Track 2");
      expect(loaded!.queuePosition).toBe(0);
    });

    test("migration re-saves file as v2", () => {
      const v1State = {
        queue: [
          {
            id: "jf-1",
            name: "Track 1",
            artist: "Artist",
            duration: 180,
            jellyfinItem: {
              Id: "jf-1",
              Name: "Track 1",
              Type: "Audio",
            },
          },
        ],
        queuePosition: 0,
        savedAt: Date.now(),
        version: 1,
      };

      const queuePath = getQueueFilePath();
      mkdirSync(join(testDir, "musicd"), { recursive: true });
      writeFileSync(queuePath, JSON.stringify(v1State, null, 2), "utf-8");

      // First load triggers migration
      loadQueueState();

      // Second load should read the re-saved v2 file directly (no migration needed)
      const reloaded = loadQueueState();
      expect(reloaded).not.toBeNull();
      expect(reloaded!.version).toBe(2);
      expect(reloaded!.queue[0].source).toBe("jellyfin");
    });
  });

  describe("edge cases", () => {
    test("returns null when no state file exists", () => {
      expect(loadQueueState()).toBeNull();
    });

    test("returns null for invalid JSON", () => {
      const queuePath = getQueueFilePath();
      mkdirSync(join(testDir, "musicd"), { recursive: true });
      writeFileSync(queuePath, "not valid json", "utf-8");

      expect(loadQueueState()).toBeNull();
    });

    test("returns null for missing queue array", () => {
      const queuePath = getQueueFilePath();
      mkdirSync(join(testDir, "musicd"), { recursive: true });
      writeFileSync(
        queuePath,
        JSON.stringify({ queuePosition: 0, version: 2 }),
        "utf-8",
      );

      expect(loadQueueState()).toBeNull();
    });

    test("returns null for future version", () => {
      const queuePath = getQueueFilePath();
      mkdirSync(join(testDir, "musicd"), { recursive: true });
      writeFileSync(
        queuePath,
        JSON.stringify({
          queue: [],
          queuePosition: 0,
          savedAt: Date.now(),
          version: 99,
        }),
        "utf-8",
      );

      expect(loadQueueState()).toBeNull();
    });

    test("hasQueueState returns false when no file", () => {
      expect(hasQueueState()).toBe(false);
    });

    test("hasQueueState returns true after save", () => {
      saveQueueState([], 0);
      expect(hasQueueState()).toBe(true);
    });

    test("clearQueueState removes the file", () => {
      saveQueueState([], 0);
      expect(hasQueueState()).toBe(true);

      clearQueueState();
      expect(hasQueueState()).toBe(false);
    });

    test("clearQueueState is no-op when no file", () => {
      expect(hasQueueState()).toBe(false);
      clearQueueState(); // should not throw
      expect(hasQueueState()).toBe(false);
    });

    test("saves empty queue", () => {
      saveQueueState([], -1);

      const loaded = loadQueueState();
      expect(loaded).not.toBeNull();
      expect(loaded!.queue).toHaveLength(0);
      expect(loaded!.queuePosition).toBe(-1);
    });
  });
});
