import { describe, expect, test } from "bun:test";

import { APP_VERSION } from "@musicd/shared";

import { createApp } from "../app";

import type {
  ApiClock,
  ApiJellyfinService,
  ApiPlayerService,
  ApiYouTubeService,
} from "./routes";

function failIfCalled(): never {
  throw new Error("Unexpected fake service call");
}

const jellyfinService: ApiJellyfinService = {
  authenticate: failIfCalled,
  getAlbumTracks: failIfCalled,
  getArtistTracks: failIfCalled,
  getItem: failIfCalled,
  search: failIfCalled,
};

const youtubeService: ApiYouTubeService = {
  createQueueItem: failIfCalled,
};

const playerService = {
  addItems: failIfCalled,
  addJellyfinItems: failIfCalled,
  clearQueue: failIfCalled,
  getQueue: failIfCalled,
  getQueueMode: failIfCalled,
  getQueuePosition: failIfCalled,
  getStatus: failIfCalled,
  isPlaying: failIfCalled,
  pause: failIfCalled,
  play: failIfCalled,
  playFromQueue: failIfCalled,
  playNext: failIfCalled,
  playPrevious: failIfCalled,
  removeFromQueue: failIfCalled,
  resume: failIfCalled,
  shuffleQueue: failIfCalled,
  stop: failIfCalled,
  toggleLoop: failIfCalled,
  toggleRandom: failIfCalled,
};

const clock: ApiClock = {
  now: () => 125_000,
};

function createTestApp(player: ApiPlayerService = playerService) {
  return createApp({
    jellyfinService,
    youtubeService,
    playerService: player,
    clock,
    startTime: 1_000,
    daemonPassword: "secret",
    ytDlpAvailable: false,
  });
}

describe("API authentication", () => {
  test("health remains public when the API is mounted under /api", async () => {
    const app = createTestApp();

    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      status: "healthy",
      uptime: 124,
      version: APP_VERSION,
    });
  });

  test("every non-health endpoint requires authentication", async () => {
    const app = createTestApp();
    const endpoints = [
      ["GET", "/"],
      ["POST", "/api/auth"],
      ["POST", "/api/play"],
      ["POST", "/api/pause"],
      ["POST", "/api/resume"],
      ["POST", "/api/stop"],
      ["GET", "/api/status"],
      ["POST", "/api/queue/add"],
      ["GET", "/api/queue"],
      ["POST", "/api/queue/clear"],
      ["POST", "/api/queue/next"],
      ["POST", "/api/queue/previous"],
      ["POST", "/api/queue/remove/0"],
      ["POST", "/api/queue/play/0"],
      ["POST", "/api/queue/loop"],
      ["POST", "/api/queue/random"],
      ["POST", "/api/queue/shuffle"],
      ["GET", "/api/queue/mode"],
      ["GET", "/api/search?q=test"],
      ["GET", "/api/album/id"],
      ["GET", "/api/artist/id"],
    ] as const;

    for (const [method, path] of endpoints) {
      const response = await app.request(path, { method });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        success: false,
        error: "Authentication required. Missing Authorization header.",
      });
    }
  });

  test("authenticated requests use the injected services", async () => {
    const app = createTestApp({
      ...playerService,
      getQueue: () => [],
      getQueuePosition: () => -1,
    });

    const response = await app.request("/api/queue", {
      headers: { Authorization: "Bearer secret" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      queue: [],
      position: -1,
      count: 0,
    });
  });
});

describe("POST /api/play validation", () => {
  test("an absent itemId selects smart play", async () => {
    let playCalls = 0;
    const app = createTestApp({
      ...playerService,
      play: async () => {
        playCalls += 1;
      },
      getStatus: async () => ({
        state: "playing",
        currentItem: null,
        position: 0,
        duration: 0,
        queue: [],
        queuePosition: -1,
        queueMode: { loop: false, random: false },
      }),
    });

    const response = await app.request("/api/play", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      message: "Playback started",
      state: "playing",
      currentItem: null,
    });
    expect(playCalls).toBe(1);
  });

  test("explicitly invalid itemId values return a structured response", async () => {
    const app = createTestApp();

    for (const itemId of ["", null, 42]) {
      const response = await app.request("/api/play", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ itemId }),
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        success: false,
        error: "Invalid request",
        details: expect.any(Array),
      });
    }
  });

  test("malformed JSON returns a structured response", async () => {
    const app = createTestApp();

    const response = await app.request("/api/play", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: "{",
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: "Invalid request",
      details: expect.any(Array),
    });
  });
});

describe("API integer input validation", () => {
  test("queue indices reject incomplete and negative integer strings", async () => {
    const app = createTestApp();

    for (const route of ["remove", "play"]) {
      for (const index of ["1junk", "1.5", "-1", "9007199254740992"]) {
        const response = await app.request(`/api/queue/${route}/${index}`, {
          method: "POST",
          headers: { Authorization: "Bearer secret" },
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          success: false,
          error: "Invalid index parameter",
        });
      }
    }
  });

  test("complete non-negative queue indices reach the queue boundary", async () => {
    let removedIndex: number | undefined;
    const app = createTestApp({
      ...playerService,
      removeFromQueue: (index) => {
        removedIndex = index;
      },
      getQueue: () => [],
      getQueuePosition: () => -1,
    });

    const response = await app.request("/api/queue/remove/0", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
    });

    expect(response.status).toBe(200);
    expect(removedIndex).toBe(0);
  });

  test("search limits reject malformed, empty, and out-of-range values", async () => {
    const app = createTestApp();

    for (const limit of ["1junk", "1.5", "", "0", "101"]) {
      const response = await app.request(
        `/api/search?q=test&limit=${encodeURIComponent(limit)}`,
        { headers: { Authorization: "Bearer secret" } },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: "Limit must be between 1 and 100",
      });
    }
  });

  test("search limit bounds are accepted", async () => {
    const acceptedLimits: number[] = [];
    const app = createApp({
      jellyfinService: {
        ...jellyfinService,
        search: async (_query, limit) => {
          if (limit === undefined) {
            throw new Error("Expected the API to provide a search limit");
          }
          acceptedLimits.push(limit);
          return [];
        },
      },
      youtubeService,
      playerService,
      clock,
      startTime: 1_000,
      daemonPassword: "secret",
      ytDlpAvailable: false,
    });

    for (const limit of [1, 100]) {
      const response = await app.request(`/api/search?q=test&limit=${limit}`, {
        headers: { Authorization: "Bearer secret" },
      });

      expect(response.status).toBe(200);
    }
    expect(acceptedLimits).toEqual([1, 100]);
  });
});
