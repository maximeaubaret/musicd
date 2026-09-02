import { afterEach, describe, expect, mock, test } from "bun:test";

import { JellyfinError, SEARCH_TYPES } from "@musicd/shared";

import { JellyfinService, searchSlots } from "./jellyfin";

const originalFetch = globalThis.fetch;

type FetchImplementation = (
  ...args: Parameters<typeof originalFetch>
) => Promise<Response>;

function installFetchMock(fetchImplementation: FetchImplementation): void {
  globalThis.fetch = Object.assign(fetchImplementation, {
    preconnect: originalFetch.preconnect,
  });
}

function createAuthenticatedService(token: string = "jellyfin-token") {
  return new JellyfinService({ serverUrl: "https://jellyfin.example" }, () => ({
    accessToken: token,
    userId: "user-1",
    serverId: "server-1",
    username: "listener",
    createdAt: 0,
  }));
}

function mockJsonResponse(body: unknown, init?: ResponseInit): void {
  const fetchMock = mock(async () => Response.json(body, init));
  installFetchMock(fetchMock);
}

interface SearchMockOptions {
  MusicArtist?: unknown[];
  MusicAlbum?: unknown[];
  Audio?: unknown[];
  /** Items the batched id lookup answers with; defaults to the Audio hints. */
  enrichment?: unknown[];
  /** Make the id lookup fail, to prove a search survives it. */
  enrichmentStatus?: number;
}

interface SearchMockCalls {
  /** includeItemTypes of each /Search/Hints request, in the order issued. */
  hints: string[];
  /** Item ids each batched lookup asked to resolve. */
  enriched: string[][];
}

/**
 * Route the two kinds of request a search makes by URL rather than by call
 * order, so a test asserts on what was asked for instead of on how the
 * concurrent fetches happened to interleave. Any other URL is an error.
 */
function mockSearch(options: SearchMockOptions): { calls: SearchMockCalls } {
  const calls: SearchMockCalls = { hints: [], enriched: [] };

  installFetchMock(async (input) => {
    const url = new URL(String(input));

    if (url.pathname === "/Search/Hints") {
      const type = url.searchParams.get("includeItemTypes") ?? "";
      calls.hints.push(type);
      const hints = options[type as keyof SearchMockOptions] ?? [];
      const limit = Number(url.searchParams.get("limit"));
      return Response.json({
        SearchHints: (hints as unknown[]).slice(0, limit),
      });
    }

    if (url.pathname.endsWith("/Items")) {
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      calls.enriched.push(ids);
      if (options.enrichmentStatus !== undefined) {
        return new Response("", { status: options.enrichmentStatus });
      }
      return Response.json({
        Items: options.enrichment ?? options.Audio ?? [],
      });
    }

    throw new Error(`Unexpected Jellyfin request: ${url.pathname}`);
  });

  return { calls };
}

function mockResponse(response: Response): void {
  const fetchMock = mock(async () => response);
  installFetchMock(fetchMock);
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }

  throw new Error("Expected operation to reject with an Error");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("JellyfinService item responses", () => {
  test("accepts partial item metadata and normalizes nullable optional fields", async () => {
    mockJsonResponse({
      Id: "track-1",
      Name: "Track",
      Type: "Audio",
      Artists: null,
      Album: null,
      RunTimeTicks: null,
      MediaSources: [
        {
          Id: null,
          Path: null,
          Protocol: "File",
          Container: null,
        },
      ],
    });
    const service = createAuthenticatedService();

    const item = await service.getItem("track-1");

    expect(item).toMatchObject({
      Id: "track-1",
      Name: "Track",
      Type: "Audio",
    });
    expect(item.Artists).toBeUndefined();
    expect(item.Album).toBeUndefined();
    expect(item.RunTimeTicks).toBeUndefined();
    expect(item.MediaSources).toEqual([{ Protocol: "File" }]);
  });

  test("rejects item metadata without required domain fields", async () => {
    mockJsonResponse({ Id: "track-1", Type: "Audio" });
    const service = createAuthenticatedService();

    const result = service.getItem("track-1");

    await expect(result).rejects.toBeInstanceOf(JellyfinError);
    await expect(result).rejects.toMatchObject({
      message: expect.stringContaining("fetching item metadata"),
    });
  });

  test("rejects empty required item fields", async () => {
    mockJsonResponse({ Id: "track-1", Name: "", Type: "Audio" });
    const service = createAuthenticatedService();

    const error = await captureError(() => service.getItem("track-1"));

    expect(error).toBeInstanceOf(JellyfinError);
    expect(error.message).toContain("fetching item metadata");
    expect(error.message).toContain("Name");
  });
});

describe("JellyfinService authentication responses", () => {
  test("accepts a valid authentication result", async () => {
    mockJsonResponse({
      User: { Id: "user-1", Name: "Listener", ExtraField: true },
      AccessToken: "access-token",
      ServerId: "server-1",
      SessionInfo: null,
    });
    const service = new JellyfinService(
      { serverUrl: "https://jellyfin.example" },
      () => null,
      () => undefined,
    );

    const result = await service.authenticate("listener", "password");

    expect(result).toEqual({
      User: { Id: "user-1", Name: "Listener" },
      AccessToken: "access-token",
      ServerId: "server-1",
    });
    expect(service.isAuthenticated()).toBe(true);
  });

  test("rejects malformed authentication without exposing credentials", async () => {
    const accessToken = "access-token-DO-NOT-EXPOSE";
    const password = "password-DO-NOT-EXPOSE";
    mockJsonResponse({
      User: { Name: "listener" },
      AccessToken: accessToken,
      ServerId: "server-1",
      Password: password,
    });
    const service = new JellyfinService(
      { serverUrl: "https://jellyfin.example" },
      () => null,
      () => undefined,
    );

    const error = await captureError(() =>
      service.authenticate("listener", password),
    );

    expect(error).toBeInstanceOf(JellyfinError);
    expect(error.message).toContain("authenticating");
    expect(error.message).not.toContain(accessToken);
    expect(error.message).not.toContain(password);
  });
});

describe("JellyfinService search responses", () => {
  test("rejects malformed search hints", async () => {
    mockJsonResponse({
      SearchHints: [{ Id: "track-1", Type: "Audio" }],
    });
    const service = createAuthenticatedService();

    const error = await captureError(() => service.search("track"));

    expect(error).toBeInstanceOf(JellyfinError);
    expect(error.message).toContain("searching for items");
    expect(error.message).toContain("SearchHints.0.Name");
  });

  test("search fans out per type rather than per matched artist", async () => {
    // mockSearch throws on any request it does not recognise, so this proves
    // the fan-out is bounded by the number of types searched: matched artists
    // never trigger a follow-up fetch of their own.
    const { calls } = mockSearch({
      MusicArtist: [{ Id: "artist-1", Name: "Artist", Type: "MusicArtist" }],
    });
    const service = createAuthenticatedService();

    const results = await service.search("artist");

    expect(results.map((item) => item.Id)).toEqual(["artist-1"]);
    expect(calls.hints).toEqual(["MusicArtist", "MusicAlbum", "Audio"]);
    // Artists are the destination, so a lone artist hit needs no lookup.
    expect(calls.enriched).toEqual([]);
  });

  test("albums carry the id of the artist their label names", async () => {
    mockSearch({
      MusicAlbum: [{ Id: "album-1", Name: "Homework", Type: "MusicAlbum" }],
      enrichment: [
        {
          Id: "album-1",
          Name: "Homework",
          Type: "MusicAlbum",
          AlbumArtists: [{ Id: "artist-1", Name: "Daft Punk" }],
        },
      ],
    });
    const service = createAuthenticatedService();

    const [album] = await service.search("homework");

    expect(album?.ArtistId).toBe("artist-1");
  });

  test("each type keeps its own slots when songs would fill the budget", async () => {
    const { calls } = mockSearch({
      MusicArtist: [{ Id: "artist-1", Name: "Grouplove", Type: "MusicArtist" }],
      MusicAlbum: Array.from({ length: 20 }, (_, index) => ({
        Id: `album-${index}`,
        Name: `Love ${index}`,
        Type: "MusicAlbum",
      })),
      Audio: Array.from({ length: 100 }, (_, index) => ({
        Id: `track-${index}`,
        Name: `Love ${index}`,
        Type: "Audio",
      })),
    });
    const service = createAuthenticatedService();

    const results = await service.search("love", 30);
    const byType = (type: string) =>
      results.filter((item) => item.Type === type).length;

    expect(byType("MusicArtist")).toBe(1);
    expect(byType("MusicAlbum")).toBe(6);
    // The four artist slots nothing matched are spent on tracks, not lost.
    expect(byType("Audio")).toBe(23);
    expect(results.length).toBe(30);
    // Grouped in SEARCH_TYPES order, so a client can section them as they come.
    expect(results[0]?.Type).toBe("MusicArtist");
    expect(results.at(-1)?.Type).toBe("Audio");
    expect(calls.hints).toEqual(["MusicArtist", "MusicAlbum", "Audio"]);
  });

  test("a scoped search spends the whole budget on that type", async () => {
    const { calls } = mockSearch({
      MusicAlbum: Array.from({ length: 40 }, (_, index) => ({
        Id: `album-${index}`,
        Name: `Love ${index}`,
        Type: "MusicAlbum",
      })),
    });
    const service = createAuthenticatedService();

    const results = await service.search("love", 30, ["albums"]);

    expect(results.length).toBe(30);
    expect(calls.hints).toEqual(["MusicAlbum"]);
  });

  test("tracks carry the ids of the album and artist their labels name", async () => {
    mockSearch({
      Audio: [
        {
          Id: "track-1",
          Name: "Daftendirekt",
          Type: "Audio",
          Artists: ["Daft Punk"],
          Album: "Homework",
          AlbumId: "album-1",
        },
      ],
      enrichment: [
        {
          Id: "track-1",
          Name: "Daftendirekt",
          Type: "Audio",
          Artists: ["Daft Punk"],
          Album: "Homework",
          AlbumId: "album-1",
          ArtistItems: [{ Id: "artist-1", Name: "Daft Punk" }],
        },
      ],
    });
    const service = createAuthenticatedService();

    const [track] = await service.search("daftendirekt");

    expect(track?.AlbumId).toBe("album-1");
    expect(track?.ArtistId).toBe("artist-1");
  });

  test("a failed id lookup costs the ids, not the search", async () => {
    mockSearch({
      Audio: [
        {
          Id: "track-1",
          Name: "Daftendirekt",
          Type: "Audio",
          Album: "Homework",
          AlbumId: "album-1",
        },
      ],
      enrichmentStatus: 500,
    });
    const service = createAuthenticatedService();

    const [track] = await service.search("daftendirekt");

    expect(track?.Id).toBe("track-1");
    expect(track?.AlbumId).toBe("album-1");
    expect(track?.ArtistId).toBeUndefined();
  });
});

describe("searchSlots", () => {
  test("caps artists and albums, and fetches songs at the full budget", () => {
    // Songs get the whole budget because the reserved types may under-deliver:
    // whatever they leave has to be fillable with tracks.
    expect(searchSlots(30, SEARCH_TYPES)).toEqual({
      artists: 5,
      albums: 6,
      songs: 30,
    });
  });

  test("caps the reserved types by share so a small budget still finds songs", () => {
    expect(searchSlots(5, SEARCH_TYPES)).toEqual({
      artists: 1,
      albums: 1,
      songs: 5,
    });
  });

  test("a budget too small to divide goes entirely to the best matches", () => {
    expect(searchSlots(1, SEARCH_TYPES)).toEqual({
      artists: 0,
      albums: 0,
      songs: 1,
    });
  });

  test("gives a single requested type the whole budget", () => {
    expect(searchSlots(30, ["albums"])).toEqual({
      artists: 0,
      albums: 30,
      songs: 0,
    });
  });

  test("never lets a reserved type take the whole budget", () => {
    for (const limit of [1, 2, 7, 20, 100]) {
      const slots = searchSlots(limit, SEARCH_TYPES);
      expect(slots.artists + slots.albums).toBeLessThan(limit);
    }
  });
});

describe("JellyfinService track-list responses", () => {
  test("accepts a partial track-list response", async () => {
    mockJsonResponse({ Items: null });
    const service = createAuthenticatedService();

    const tracks = await service.getAlbumTracks("album-1");

    expect(tracks).toEqual([]);
  });

  test("rejects malformed album tracks", async () => {
    mockJsonResponse({
      Items: [{ Id: "track-1", Name: "Track" }],
    });
    const service = createAuthenticatedService();

    const error = await captureError(() => service.getAlbumTracks("album-1"));

    expect(error).toBeInstanceOf(JellyfinError);
    expect(error.message).toContain("fetching album tracks");
    expect(error.message).toContain("Items.0.Type");
  });

  test("rejects malformed artist tracks", async () => {
    mockJsonResponse({
      Items: [{ Id: "track-1", Type: "Audio" }],
    });
    const service = createAuthenticatedService();

    const error = await captureError(() => service.getArtistTracks("artist-1"));

    expect(error).toBeInstanceOf(JellyfinError);
    expect(error.message).toContain("fetching artist tracks");
    expect(error.message).toContain("Items.0.Name");
  });
});

describe("JellyfinService playlists and favorites", () => {
  test("gets playlist tracks in order and ignores non-audio entries", async () => {
    let requestedUrl = "";
    const fetchMock = mock(async (input: string | URL | Request) => {
      requestedUrl = input.toString();
      return Response.json({
        Items: [
          { Id: "track-1", Name: "First", Type: "Audio" },
          { Id: "video-1", Name: "Video", Type: "Video" },
          { Id: "track-2", Name: "Second", Type: "Audio" },
        ],
        TotalRecordCount: 3,
      });
    });
    installFetchMock(fetchMock);
    const service = createAuthenticatedService();

    const tracks = await service.getPlaylistTracks("playlist-1");

    expect(tracks.map((track) => track.Id)).toEqual(["track-1", "track-2"]);
    expect(requestedUrl).toBe(
      "https://jellyfin.example/Playlists/playlist-1/Items?userId=user-1",
    );
  });

  test("browses favorites with the Jellyfin favorite filter", async () => {
    let requestedUrl = "";
    const fetchMock = mock(async (input: string | URL | Request) => {
      requestedUrl = input.toString();
      return Response.json({ Items: [], TotalRecordCount: 12 });
    });
    installFetchMock(fetchMock);
    const service = createAuthenticatedService();

    const page = await service.browseFavorites("albums", 5, 10);
    const url = new URL(requestedUrl);

    expect(page).toEqual({ items: [], total: 12 });
    expect(url.pathname).toBe("/Users/user-1/Items");
    expect(url.searchParams.get("filters")).toBe("IsFavorite");
    expect(url.searchParams.get("includeItemTypes")).toBe("MusicAlbum");
    expect(url.searchParams.get("startIndex")).toBe("5");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  test("marks and unmarks favorites using the authenticated user", async () => {
    const requests: Request[] = [];
    const fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        requests.push(request);
        return new Response(null, { status: 200 });
      },
    );
    installFetchMock(fetchMock);
    const service = createAuthenticatedService();

    await service.setFavorite("track-1", true);
    await service.setFavorite("track-1", false);

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["POST", "https://jellyfin.example/Users/user-1/FavoriteItems/track-1"],
      ["DELETE", "https://jellyfin.example/Users/user-1/FavoriteItems/track-1"],
    ]);
  });
});

describe("JellyfinService playback source", () => {
  test("rejects malformed item metadata before creating a source", async () => {
    mockJsonResponse({ Id: "track-1", Type: "Audio" });
    const service = createAuthenticatedService();

    const error = await captureError(() =>
      service.getPlaybackSource("track-1"),
    );

    expect(error).toBeInstanceOf(JellyfinError);
    expect(error.message).toContain("fetching item metadata");
  });

  test("keeps the access token out of the stream URL", async () => {
    const token = "jellyfin-token-DO-NOT-EXPOSE";
    const fetchMock = mock(async () =>
      Response.json({
        Id: "track-1",
        Name: "Track",
        Type: "Audio",
      }),
    );
    installFetchMock(fetchMock);
    const service = new JellyfinService(
      { serverUrl: "https://jellyfin.example" },
      () => ({
        accessToken: token,
        userId: "user-1",
        serverId: "server-1",
        username: "listener",
        createdAt: 0,
      }),
    );

    const source = await service.getPlaybackSource("track-1");

    expect(source.url).toContain(
      "https://jellyfin.example/Audio/track-1/universal?",
    );
    expect(source.url).not.toContain(token);
    expect(source.url).not.toContain("api_key");
    expect(new URL(source.url).searchParams.get("TranscodingProtocol")).toBe(
      "http",
    );
    expect(source.headers).toEqual({ "X-MediaBrowser-Token": token });
  });
});

describe("JellyfinService HTTP response compatibility", () => {
  test("preserves invalid-token handling", async () => {
    mockResponse(new Response(null, { status: 401 }));
    const service = createAuthenticatedService();

    const error = await captureError(() => service.getItem("track-1"));

    expect(error).toBeInstanceOf(JellyfinError);
    expect(error.message).toBe(
      "Authentication token is invalid or expired. Please run setup again.",
    );
    expect(error).toMatchObject({ statusCode: 401 });
  });

  test("preserves playback reporting error status and context", async () => {
    mockResponse(
      new Response(null, { status: 503, statusText: "Service Unavailable" }),
    );
    const service = createAuthenticatedService();

    const error = await captureError(() =>
      service.reportPlaybackProgress("track-1", "session-1", 10, false),
    );

    expect(error).toBeInstanceOf(JellyfinError);
    expect(error.message).toBe(
      "Failed to report playback progress: Service Unavailable",
    );
    expect(error).toMatchObject({ statusCode: 503 });
  });

  test("accepts an empty successful playback reporting response", async () => {
    mockResponse(new Response(null, { status: 204 }));
    const service = createAuthenticatedService();

    await expect(
      service.reportPlaybackStopped("track-1", "session-1", 10),
    ).resolves.toBeUndefined();
  });
});
