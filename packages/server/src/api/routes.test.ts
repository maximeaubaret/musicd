import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { APP_VERSION } from "@musicd/shared";

import { createApiRoutes } from "./routes";

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
  stop: failIfCalled,
};

const clock: ApiClock = {
  now: () => 125_000,
};

function createTestApp(player: ApiPlayerService = playerService): Hono {
  const app = new Hono();
  app.route(
    "/api",
    createApiRoutes(
      jellyfinService,
      youtubeService,
      player,
      1_000,
      "secret",
      false,
      clock,
    ),
  );
  return app;
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
});
