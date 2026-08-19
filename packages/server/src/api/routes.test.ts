import { describe, expect, test } from "bun:test";

import { APP_VERSION, JellyfinError, PlayerError } from "@musicd/shared";

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
  browse: failIfCalled,
  browseFavorites: failIfCalled,
  getAlbumTracks: failIfCalled,
  getArtistAlbums: failIfCalled,
  getArtistTracks: failIfCalled,
  getArtwork: failIfCalled,
  getItem: failIfCalled,
  getPlaylistTracks: failIfCalled,
  search: failIfCalled,
  setFavorite: failIfCalled,
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
  getVolume: failIfCalled,
  isPlaying: failIfCalled,
  pause: failIfCalled,
  play: failIfCalled,
  playFromQueue: failIfCalled,
  playNext: failIfCalled,
  playPrevious: failIfCalled,
  removeFromQueue: failIfCalled,
  resume: failIfCalled,
  seek: failIfCalled,
  setVolume: failIfCalled,
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
  playlistTracks?: Record<string, JellyfinItem[]>;
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
      getPlaylistTracks: async (id) => library.playlistTracks?.[id] ?? [],
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
      ["POST", "/api/seek"],
      ["GET", "/api/volume"],
      ["POST", "/api/volume"],
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
      ["GET", "/api/artist/id/albums"],
      ["GET", "/api/playlist/id"],
      ["GET", "/api/favorites/songs"],
      ["POST", "/api/favorites/id"],
      ["DELETE", "/api/favorites/id"],
      ["GET", "/api/artwork/id"],
      ["GET", "/api/library/albums"],
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

  test("api_key query parameter authenticates in place of the Bearer header", async () => {
    const app = createTestApp({
      ...playerService,
      getQueue: () => [],
      getQueuePosition: () => -1,
    });

    const authorized = await app.request("/api/queue?api_key=secret");
    expect(authorized.status).toBe(200);

    const wrongKey = await app.request("/api/queue?api_key=wrong");
    expect(wrongKey.status).toBe(401);
    expect(await wrongKey.json()).toEqual({
      success: false,
      error: "Invalid authentication credentials.",
    });
  });

  test("a configured daemon rejects setup for a different Jellyfin server", async () => {
    const app = createApp({
      jellyfinService,
      youtubeService,
      playerService,
      startTime: 0,
      jellyfinServerUrl: "https://current-jellyfin.example",
    });

    const response = await app.request("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverUrl: "https://other-jellyfin.example",
        username: "listener",
        password: "jellyfin-password",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error:
        "This daemon is configured for a different Jellyfin server. Remove its setup state and restart it in setup mode to change servers.",
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

  test("audio items and music containers preserve track metadata and order", async () => {
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
    const playlist: JellyfinItem = {
      Id: "playlist",
      Name: "Playlist",
      Type: "Playlist",
    };
    const albumTrack = createAudioItem("album-track", "Album Track");
    const artistTrack = createAudioItem("artist-track", "Artist Track");
    const playlistTrack = createAudioItem("playlist-track", "Playlist Track");
    const app = createQueueTestApp({
      items: {
        [audio.Id]: audio,
        [album.Id]: album,
        [artist.Id]: artist,
        [playlist.Id]: playlist,
      },
      albumTracks: { [album.Id]: [albumTrack] },
      artistTracks: { [artist.Id]: [artistTrack] },
      playlistTracks: { [playlist.Id]: [playlistTrack] },
    });

    const response = await addToQueue(app, {
      itemIds: [audio.Id, album.Id, artist.Id, playlist.Id],
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
        expect.objectContaining({
          id: "playlist-track",
          jellyfinItem: playlistTrack,
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

describe("GET /api/artwork/:id", () => {
  function createArtworkApp(getArtwork: ApiJellyfinService["getArtwork"]) {
    return createApp({
      jellyfinService: { ...jellyfinService, getArtwork },
      youtubeService,
      playerService,
      clock,
      startTime: 1_000,
      daemonPassword: "secret",
      ytDlpAvailable: false,
    });
  }

  test("streams upstream artwork with content type and cache headers", async () => {
    const requestedWidths: number[] = [];
    const app = createArtworkApp((itemId, maxWidth) => {
      expect(itemId).toBe("abc123");
      requestedWidths.push(maxWidth ?? -1);
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "image/jpeg" },
        }),
      );
    });

    const response = await app.request("/api/artwork/abc123?api_key=secret");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(requestedWidths).toEqual([256]);
  });

  test("passes an explicit maxWidth through to the service", async () => {
    const requestedWidths: number[] = [];
    const app = createArtworkApp((_itemId, maxWidth) => {
      requestedWidths.push(maxWidth ?? -1);
      return Promise.resolve(new Response(new Uint8Array([1])));
    });

    const response = await app.request(
      "/api/artwork/abc123?api_key=secret&maxWidth=512",
    );

    expect(response.status).toBe(200);
    expect(requestedWidths).toEqual([512]);
  });

  test("rejects malformed ids and out-of-range widths", async () => {
    const app = createArtworkApp(failIfCalled);

    const badId = await app.request("/api/artwork/..%2Fescape?api_key=secret");
    expect(badId.status).toBe(400);

    for (const width of ["0", "4096", "abc", "-1"]) {
      const response = await app.request(
        `/api/artwork/abc123?api_key=secret&maxWidth=${width}`,
      );
      expect(response.status).toBe(400);
    }
  });

  test("maps missing artwork to a JSON 404", async () => {
    const app = createArtworkApp(() => {
      return Promise.reject(
        new JellyfinError("Artwork not available for item abc123", 404),
      );
    });

    const response = await app.request("/api/artwork/abc123?api_key=secret");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: "Artwork not available for item abc123",
    });
  });
});

describe("GET /api/library/:kind", () => {
  function createBrowseApp(browse: ApiJellyfinService["browse"]) {
    return createApp({
      jellyfinService: { ...jellyfinService, browse },
      youtubeService,
      playerService,
      clock,
      startTime: 1_000,
      daemonPassword: "secret",
      ytDlpAvailable: false,
    });
  }

  test("returns a mapped page with pagination metadata", async () => {
    const calls: Array<[string, number, number]> = [];
    const app = createBrowseApp((kind, startIndex, limit) => {
      calls.push([kind, startIndex ?? -1, limit ?? -1]);
      return Promise.resolve({
        items: [createAudioItem("song-1", "First Song")],
        total: 1234,
      });
    });

    const response = await app.request(
      "/api/library/songs?startIndex=200&limit=50",
      { headers: { Authorization: "Bearer secret" } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      kind: "songs",
      startIndex: 200,
      limit: 50,
      total: 1234,
      count: 1,
      items: [
        {
          id: "song-1",
          name: "First Song",
          type: "Audio",
          artist: "Test Artist",
          album: "Test Album",
          duration: 180,
        },
      ],
    });
    expect(calls).toEqual([["songs", 200, 50]]);
  });

  test("accepts playlists as a library kind", async () => {
    const app = createBrowseApp((kind) => {
      expect(kind).toBe("playlists");
      return Promise.resolve({
        items: [{ Id: "playlist-1", Name: "Road Trip", Type: "Playlist" }],
        total: 1,
      });
    });

    const response = await app.request("/api/library/playlists", {
      headers: { Authorization: "Bearer secret" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "playlists",
      count: 1,
      items: [{ id: "playlist-1", name: "Road Trip", type: "Playlist" }],
    });
  });

  test("defaults to startIndex 0 and limit 100", async () => {
    const calls: Array<[number, number]> = [];
    const app = createBrowseApp((_kind, startIndex, limit) => {
      calls.push([startIndex ?? -1, limit ?? -1]);
      return Promise.resolve({ items: [], total: 0 });
    });

    const response = await app.request("/api/library/albums", {
      headers: { Authorization: "Bearer secret" },
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([[0, 100]]);
  });

  test("rejects unknown kinds and malformed pagination", async () => {
    const app = createBrowseApp(failIfCalled);

    const badKind = await app.request("/api/library/podcasts", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(badKind.status).toBe(400);

    for (const query of [
      "startIndex=-1",
      "startIndex=abc",
      "limit=0",
      "limit=201",
    ]) {
      const response = await app.request(`/api/library/albums?${query}`, {
        headers: { Authorization: "Bearer secret" },
      });
      expect(response.status).toBe(400);
    }
  });
});

describe("playlist and favorite API", () => {
  function createMusicLibraryApp(
    overrides: Partial<ApiJellyfinService>,
  ): ReturnType<typeof createApp> {
    return createApp({
      jellyfinService: { ...jellyfinService, ...overrides },
      youtubeService,
      playerService,
      clock,
      startTime: 1_000,
      daemonPassword: "secret",
      ytDlpAvailable: false,
    });
  }

  test("returns playlist metadata and ordered tracks", async () => {
    const first = createAudioItem("track-1", "First");
    const second = createAudioItem("track-2", "Second");
    const app = createMusicLibraryApp({
      getItem: async () => ({
        Id: "playlist-1",
        Name: "Road Trip",
        Type: "Playlist",
      }),
      getPlaylistTracks: async () => [first, second],
    });

    const response = await app.request("/api/playlist/playlist-1", {
      headers: { Authorization: "Bearer secret" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      playlist: { id: "playlist-1", name: "Road Trip", type: "Playlist" },
      tracks: [
        { id: "track-1", name: "First" },
        { id: "track-2", name: "Second" },
      ],
      count: 2,
    });
  });

  test("browses favorite songs with pagination", async () => {
    const calls: Array<[string, number, number]> = [];
    const app = createMusicLibraryApp({
      browseFavorites: async (kind, startIndex, limit) => {
        calls.push([kind, startIndex ?? -1, limit ?? -1]);
        return { items: [createAudioItem("track-1", "Favorite")], total: 8 };
      },
    });

    const response = await app.request(
      "/api/favorites/songs?startIndex=2&limit=3",
      { headers: { Authorization: "Bearer secret" } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "songs",
      startIndex: 2,
      limit: 3,
      total: 8,
      items: [{ id: "track-1", name: "Favorite" }],
    });
    expect(calls).toEqual([["songs", 2, 3]]);
  });

  test("marks and unmarks favorites", async () => {
    const calls: Array<[string, boolean]> = [];
    const app = createMusicLibraryApp({
      setFavorite: async (itemId, favorite) => {
        calls.push([itemId, favorite]);
      },
    });
    const headers = { Authorization: "Bearer secret" };

    const mark = await app.request("/api/favorites/track-1", {
      method: "POST",
      headers,
    });
    const unmark = await app.request("/api/favorites/track-1", {
      method: "DELETE",
      headers,
    });

    expect(await mark.json()).toEqual({
      success: true,
      itemId: "track-1",
      favorite: true,
    });
    expect(await unmark.json()).toEqual({
      success: true,
      itemId: "track-1",
      favorite: false,
    });
    expect(calls).toEqual([
      ["track-1", true],
      ["track-1", false],
    ]);
  });
});

describe("POST /api/seek", () => {
  function createSeekApp(seek: ApiPlayerService["seek"]) {
    return createTestApp({ ...playerService, seek });
  }

  test("passes the position through to the player", async () => {
    const positions: number[] = [];
    const app = createSeekApp(async (position) => {
      positions.push(position);
    });

    const response = await app.request("/api/seek", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ position: 42.5 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      message: "Seeked to 42.5s",
      position: 42.5,
    });
    expect(positions).toEqual([42.5]);
  });

  test("rejects missing, negative, and non-numeric positions", async () => {
    const app = createSeekApp(failIfCalled);

    for (const body of ["{}", '{"position":-1}', '{"position":"abc"}', ""]) {
      const response = await app.request("/api/seek", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body,
      });
      expect(response.status).toBe(400);
    }
  });

  test("maps player errors to a 400", async () => {
    const app = createSeekApp(async () => {
      throw new PlayerError("Nothing is playing");
    });

    const response = await app.request("/api/seek", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ position: 5 }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Nothing is playing",
    });
  });
});

describe("/api/volume", () => {
  test("reads and updates native playback volume", async () => {
    let volume = 72;
    const app = createTestApp({
      ...playerService,
      getVolume: () => volume,
      setVolume: (nextVolume) => {
        volume = nextVolume;
        return volume;
      },
    });

    const getResponse = await app.request("/api/volume", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual({ success: true, volume: 72 });

    const setResponse = await app.request("/api/volume", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ volume: 35.5 }),
    });
    expect(setResponse.status).toBe(200);
    expect(await setResponse.json()).toEqual({
      success: true,
      volume: 35.5,
    });
  });

  test("rejects invalid volume values", async () => {
    const app = createTestApp();

    for (const body of [
      "{}",
      '{"volume":-1}',
      '{"volume":101}',
      '{"volume":"50"}',
      "",
    ]) {
      const response = await app.request("/api/volume", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body,
      });
      expect(response.status).toBe(400);
    }
  });

  test("reports unsupported backends without changing state", async () => {
    const unavailable = () => {
      throw new PlayerError(
        "Volume control is unavailable for the configured audio backend",
      );
    };
    const app = createTestApp({
      ...playerService,
      getVolume: unavailable,
      setVolume: unavailable,
    });

    const getResponse = await app.request("/api/volume", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(getResponse.status).toBe(400);

    const setResponse = await app.request("/api/volume", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ volume: 50 }),
    });
    expect(setResponse.status).toBe(400);
  });
});

describe("GET /api/artist/:id/albums", () => {
  function createArtistAlbumsApp(
    overrides: Partial<ApiJellyfinService>,
  ): ReturnType<typeof createApp> {
    return createApp({
      jellyfinService: { ...jellyfinService, ...overrides },
      youtubeService,
      playerService,
      clock,
      startTime: 1_000,
      daemonPassword: "secret",
      ytDlpAvailable: false,
    });
  }

  const artist: JellyfinItem = {
    Id: "artist-1",
    Name: "Test Artist",
    Type: "MusicArtist",
  };

  test("returns the artist's albums without falling through to /artist/:id", async () => {
    const app = createArtistAlbumsApp({
      getItem: async () => artist,
      getArtistAlbums: async (id) => {
        expect(id).toBe("artist-1");
        return [
          {
            Id: "album-1",
            Name: "First Album",
            Type: "MusicAlbum",
            AlbumArtist: "Test Artist",
            ProductionYear: 1999,
          },
        ];
      },
      // Reaching the track route instead would call this and fail the test.
      getArtistTracks: failIfCalled,
    });

    const response = await app.request("/api/artist/artist-1/albums", {
      headers: { Authorization: "Bearer secret" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      artist: { id: "artist-1", name: "Test Artist", type: "MusicArtist" },
      albums: [
        {
          id: "album-1",
          name: "First Album",
          type: "MusicAlbum",
          artist: "Test Artist",
          year: 1999,
        },
      ],
      count: 1,
    });
  });

  test("rejects ids that are not artists", async () => {
    const app = createArtistAlbumsApp({
      getItem: async () => ({
        Id: "album-1",
        Name: "An Album",
        Type: "MusicAlbum",
      }),
      getArtistAlbums: async () => [],
    });

    const response = await app.request("/api/artist/album-1/albums", {
      headers: { Authorization: "Bearer secret" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Item is not an artist",
    });
  });

  test("maps Jellyfin failures to their status code", async () => {
    const app = createArtistAlbumsApp({
      getItem: async () => artist,
      getArtistAlbums: async () => {
        throw new JellyfinError("Artist not found", 404);
      },
    });

    const response = await app.request("/api/artist/artist-1/albums", {
      headers: { Authorization: "Bearer secret" },
    });

    expect(response.status).toBe(404);
  });
});
