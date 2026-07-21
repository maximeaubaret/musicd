import { describe, expect, test } from "bun:test";

import { APP_VERSION } from "@musicd/shared";

import { createApp } from "../app";
import { MockBackend } from "../services/playback/mock-backend";
import { PlayerService } from "../services/player";

import type { JellyfinItem } from "@musicd/shared";
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
  setQueueMode: failIfCalled,
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

function createAudioItem(id: string, name: string): JellyfinItem {
  return {
    Id: id,
    Name: name,
    Type: "Audio",
    Artists: ["Test Artist"],
    Album: "Test Album",
    RunTimeTicks: 1_800_000_000,
  };
}

interface QueueTestLibrary {
  items: Record<string, JellyfinItem>;
  albumTracks?: Record<string, JellyfinItem[]>;
  artistTracks?: Record<string, JellyfinItem[]>;
}

interface QueueAddTestRequest {
  itemIds: string[];
  clearQueue?: boolean;
  playNow?: boolean;
}

function createQueueTestApp(library: QueueTestLibrary) {
  const backend = new MockBackend();
  const player = new PlayerService(backend);
  player.registerPlaybackSourceResolver("jellyfin", async (item) => ({
    url: `http://test.local/stream/${item.id}`,
  }));

  const app = createApp({
    jellyfinService: {
      ...jellyfinService,
      getItem: async (id) => {
        const item = library.items[id];
        if (!item) {
          throw new Error(`Missing test item: ${id}`);
        }
        return item;
      },
      getAlbumTracks: async (id) => library.albumTracks?.[id] ?? [],
      getArtistTracks: async (id) => library.artistTracks?.[id] ?? [],
    },
    youtubeService,
    playerService: player,
    startTime: 0,
  });

  return app;
}

function addToQueue(
  app: ReturnType<typeof createApp>,
  request: QueueAddTestRequest,
): Promise<Response> {
  return Promise.resolve(
    app.request("/api/queue/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
}

function getPlaybackStatus(
  app: ReturnType<typeof createApp>,
): Promise<Response> {
  return Promise.resolve(app.request("/api/status"));
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
      ["POST", "/api/queue/mode"],
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

describe("POST /api/queue/add playback behavior", () => {
  test("playNow false prepares an empty stopped queue without starting playback", async () => {
    const track = createAudioItem("new-track", "New Track");
    const app = createQueueTestApp({ items: { [track.Id]: track } });

    const response = await addToQueue(app, {
      itemIds: [track.Id],
      playNow: false,
    });
    const statusResponse = await getPlaybackStatus(app);

    expect(response.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      state: "stopped",
      currentItem: null,
      queue: [
        {
          id: "new-track",
          name: "New Track",
          artist: "Test Artist",
          album: "Test Album",
          duration: 180,
          source: "jellyfin",
          jellyfinItem: track,
        },
      ],
    });
  });

  test("playNow true starts the newly added selection in an existing stopped queue", async () => {
    const queuedTrack = createAudioItem("queued-track", "Queued Track");
    const newTrack = createAudioItem("new-track", "New Track");
    const app = createQueueTestApp({
      items: {
        [queuedTrack.Id]: queuedTrack,
        [newTrack.Id]: newTrack,
      },
    });

    await addToQueue(app, { itemIds: [queuedTrack.Id], playNow: false });
    const response = await addToQueue(app, {
      itemIds: [newTrack.Id],
      playNow: true,
    });
    const statusResponse = await getPlaybackStatus(app);

    expect(response.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      state: "playing",
      currentItem: { id: "new-track", name: "New Track" },
      queuePosition: 1,
      queue: [{ id: "queued-track" }, { id: "new-track" }],
    });
  });

  test("playNow false appends without replacing current playback", async () => {
    const currentTrack = createAudioItem("current-track", "Current Track");
    const queuedTrack = createAudioItem("queued-track", "Queued Track");
    const app = createQueueTestApp({
      items: {
        [currentTrack.Id]: currentTrack,
        [queuedTrack.Id]: queuedTrack,
      },
    });

    await addToQueue(app, { itemIds: [currentTrack.Id], playNow: true });
    const response = await addToQueue(app, {
      itemIds: [queuedTrack.Id],
      playNow: false,
    });
    const statusResponse = await getPlaybackStatus(app);

    expect(response.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      state: "playing",
      currentItem: { id: "current-track", name: "Current Track" },
      queuePosition: 0,
      queue: [{ id: "current-track" }, { id: "queued-track" }],
    });
  });

  test("playNow true replaces playback with the newly added selection", async () => {
    const currentTrack = createAudioItem("current-track", "Current Track");
    const newTrack = createAudioItem("new-track", "New Track");
    const app = createQueueTestApp({
      items: {
        [currentTrack.Id]: currentTrack,
        [newTrack.Id]: newTrack,
      },
    });

    await addToQueue(app, { itemIds: [currentTrack.Id], playNow: true });
    const response = await addToQueue(app, {
      itemIds: [newTrack.Id],
      playNow: true,
    });
    const statusResponse = await getPlaybackStatus(app);

    expect(response.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      state: "playing",
      currentItem: { id: "new-track", name: "New Track" },
      queuePosition: 1,
      queue: [{ id: "current-track" }, { id: "new-track" }],
    });
  });

  test("playNow true with clearQueue keeps immediate-play replacement behavior", async () => {
    const currentTrack = createAudioItem("current-track", "Current Track");
    const newTrack = createAudioItem("new-track", "New Track");
    const app = createQueueTestApp({
      items: {
        [currentTrack.Id]: currentTrack,
        [newTrack.Id]: newTrack,
      },
    });

    await addToQueue(app, { itemIds: [currentTrack.Id], playNow: true });
    const response = await addToQueue(app, {
      itemIds: [newTrack.Id],
      clearQueue: true,
      playNow: true,
    });
    const statusResponse = await getPlaybackStatus(app);

    expect(response.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      state: "playing",
      currentItem: { id: "new-track", name: "New Track" },
      queuePosition: 0,
      queue: [{ id: "new-track" }],
    });
  });

  test("audio items, albums, and artists preserve track metadata and order", async () => {
    const audio = {
      ...createAudioItem("audio", "Audio Track"),
      ProductionYear: 2024,
      IndexNumber: 7,
      MediaSources: [
        {
          Id: "media-audio",
          Path: "/music/audio.flac",
          Protocol: "File",
          Container: "flac",
        },
      ],
    };
    const album: JellyfinItem = {
      Id: "album",
      Name: "Album",
      Type: "MusicAlbum",
    };
    const artist: JellyfinItem = {
      Id: "artist",
      Name: "Artist",
      Type: "MusicArtist",
    };
    const albumTrack = createAudioItem("album-track", "Album Track");
    const artistTrack = createAudioItem("artist-track", "Artist Track");
    const app = createQueueTestApp({
      items: {
        [audio.Id]: audio,
        [album.Id]: album,
        [artist.Id]: artist,
      },
      albumTracks: { [album.Id]: [albumTrack] },
      artistTracks: { [artist.Id]: [artistTrack] },
    });

    const response = await addToQueue(app, {
      itemIds: [audio.Id, album.Id, artist.Id],
      playNow: false,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      queue: [
        expect.objectContaining({ id: "audio", jellyfinItem: audio }),
        expect.objectContaining({
          id: "album-track",
          jellyfinItem: albumTrack,
        }),
        expect.objectContaining({
          id: "artist-track",
          jellyfinItem: artistTrack,
        }),
      ],
    });
  });
});

describe("queue mode API", () => {
  test("explicitly sets loop and random and returns the resulting mode", async () => {
    const app = createQueueTestApp({ items: {} });

    const setResponse = await app.request("/api/queue/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loop: true, random: true }),
    });
    const getResponse = await app.request("/api/queue/mode");

    expect(setResponse.status).toBe(200);
    expect(await setResponse.json()).toEqual({
      success: true,
      message: "Queue mode updated",
      queueMode: { loop: true, random: true },
    });
    expect(await getResponse.json()).toEqual({
      success: true,
      queueMode: { loop: true, random: true },
    });
  });

  test("retains the existing loop and random toggle operations", async () => {
    const app = createQueueTestApp({ items: {} });

    const loopResponse = await app.request("/api/queue/loop", {
      method: "POST",
    });
    const randomResponse = await app.request("/api/queue/random", {
      method: "POST",
    });

    expect(await loopResponse.json()).toMatchObject({
      success: true,
      loop: true,
      queueMode: { loop: true, random: false },
    });
    expect(await randomResponse.json()).toMatchObject({
      success: true,
      random: true,
      queueMode: { loop: true, random: true },
    });
  });

  test("rejects malformed and incorrectly typed mode requests", async () => {
    const app = createQueueTestApp({ items: {} });

    for (const body of [JSON.stringify({ loop: "true" }), "{"]) {
      const response = await app.request("/api/queue/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        success: false,
        error: "Invalid request",
        details: expect.any(Array),
      });
    }
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
