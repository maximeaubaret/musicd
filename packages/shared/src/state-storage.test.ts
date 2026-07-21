import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
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

function writeQueueFile(contents: string): void {
  mkdirSync(join(testDir, "musicd"), { recursive: true });
  writeFileSync(getQueueFilePath(), contents, "utf-8");
}

function writePersistedState(state: unknown): void {
  writeQueueFile(JSON.stringify(state, null, 2));
}

function readPersistedState(): unknown {
  return JSON.parse(readFileSync(getQueueFilePath(), "utf-8"));
}

describe("state-storage", () => {
  describe("v3 save and load", () => {
    test("preserves queue items, position, loop mode, and random mode", () => {
      const items = [
        createJellyfinQueueItem("jf-1", "Track 1"),
        createJellyfinQueueItem("jf-2", "Track 2"),
      ];
      saveQueueState(items, 1, { loop: true, random: true });

      const loaded = loadQueueState();
      expect(loaded).not.toBeNull();
      expect(loaded!.queue).toEqual(items);
      expect(loaded!.queuePosition).toBe(1);
      expect(loaded!.queueMode).toEqual({ loop: true, random: true });
      expect(loaded!.version).toBe(3);
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

  describe("migration", () => {
    test("migrates v1 items to v3 with safe queue mode defaults", () => {
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

      writePersistedState(v1State);

      const loaded = loadQueueState();
      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(3);
      expect(loaded!.queue).toHaveLength(2);
      expect(loaded!.queueMode).toEqual({ loop: false, random: false });

      // All items should now have source: "jellyfin"
      expect(loaded!.queue[0].source).toBe("jellyfin");
      expect(loaded!.queue[1].source).toBe("jellyfin");

      // Original data should be preserved
      expect(loaded!.queue[0].name).toBe("Old Track 1");
      expect(loaded!.queue[1].name).toBe("Old Track 2");
      expect(loaded!.queuePosition).toBe(0);
    });

    test("re-saves migrated v1 state as v3", () => {
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

      writePersistedState(v1State);

      loadQueueState();

      expect(readPersistedState()).toMatchObject({
        version: 3,
        queueMode: { loop: false, random: false },
        queue: [{ source: "jellyfin" }],
      });
    });

    test("migrates and re-saves v2 state as v3 with safe queue mode defaults", () => {
      writePersistedState({
        queue: [createYouTubeQueueItem("abc123", "YT Song")],
        queuePosition: 0,
        savedAt: 123456,
        version: 2,
      });

      const loaded = loadQueueState();
      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(3);
      expect(loaded!.queueMode).toEqual({ loop: false, random: false });
      expect(loaded!.queue[0]).toEqual(
        createYouTubeQueueItem("abc123", "YT Song"),
      );

      expect(readPersistedState()).toMatchObject({
        version: 3,
        queueMode: { loop: false, random: false },
      });
    });
  });

  describe("edge cases", () => {
    test("returns null when no state file exists", () => {
      expect(loadQueueState()).toBeNull();
    });

    test("returns null for invalid JSON", () => {
      writeQueueFile("not valid json");

      expect(loadQueueState()).toBeNull();
    });

    test("returns null for missing queue array", () => {
      writePersistedState({ queuePosition: 0, version: 2 });

      expect(loadQueueState()).toBeNull();
    });

    test("returns null for malformed v3 fields", () => {
      const validState = {
        queue: [],
        queuePosition: -1,
        queueMode: { loop: false, random: false },
        savedAt: 123456,
        version: 3,
      };
      const malformedStates = [
        { ...validState, queuePosition: "-1" },
        { ...validState, queueMode: { loop: "false", random: false } },
        { ...validState, savedAt: "123456" },
        { ...validState, version: 0 },
      ];

      for (const malformedState of malformedStates) {
        writePersistedState(malformedState);
        expect(loadQueueState()).toBeNull();
      }
    });

    test("returns null for numeric fields that overflow JSON parsing", () => {
      writeQueueFile(
        '{"queue":[],"queuePosition":-1,"queueMode":{"loop":false,"random":false},"savedAt":1e400,"version":3}',
      );

      expect(loadQueueState()).toBeNull();
    });

    test("returns null for invalid queue items in supported versions", () => {
      const invalidStates = [
        {
          queue: [
            {
              id: "jf-1",
              name: "Broken Jellyfin item",
              duration: 180,
              jellyfinItem: { Id: "jf-1", Name: "Broken Jellyfin item" },
            },
          ],
          queuePosition: 0,
          savedAt: 123456,
          version: 1,
        },
        {
          queue: [
            {
              id: "yt-abc123",
              name: "Broken YouTube item",
              duration: 240,
              source: "youtube",
              youtubeUrl: 42,
              videoId: "abc123",
            },
          ],
          queuePosition: 0,
          savedAt: 123456,
          version: 2,
        },
        {
          queue: [
            {
              id: "jf-1",
              name: "Broken current item",
              duration: -1,
              source: "jellyfin",
              jellyfinItem: {
                Id: "jf-1",
                Name: "Broken current item",
                Type: "Audio",
              },
            },
          ],
          queuePosition: 0,
          queueMode: { loop: false, random: false },
          savedAt: 123456,
          version: 3,
        },
        {
          queue: [
            {
              id: "yt-abc123",
              name: "Wrong source URL",
              duration: 240,
              source: "youtube",
              youtubeUrl: "https://example.com/watch?v=abc123",
              videoId: "abc123",
            },
          ],
          queuePosition: 0,
          queueMode: { loop: false, random: false },
          savedAt: 123456,
          version: 3,
        },
      ];

      for (const invalidState of invalidStates) {
        writePersistedState(invalidState);
        expect(loadQueueState()).toBeNull();
      }
    });

    test("returns null for future version", () => {
      writePersistedState({
        queue: [],
        queuePosition: 0,
        savedAt: Date.now(),
        version: 99,
      });

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
