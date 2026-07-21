import { afterEach, describe, expect, mock, test } from "bun:test";

import { JellyfinError } from "@musicd/shared";

import { JellyfinService } from "./jellyfin";

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

function mockJsonResponses(bodies: unknown[]): void {
  let index = 0;
  const fetchMock = mock(async () => {
    if (index >= bodies.length) {
      throw new Error("Unexpected Jellyfin request");
    }
    const body = bodies[index];
    index += 1;
    return Response.json(body);
  });
  installFetchMock(fetchMock);
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

  test("rejects malformed artist items fetched while searching", async () => {
    mockJsonResponses([
      {
        SearchHints: [{ Id: "artist-1", Name: "Artist", Type: "MusicArtist" }],
      },
      { Items: [{ Id: "album-1", Type: "MusicAlbum" }] },
    ]);
    const service = createAuthenticatedService();

    const error = await captureError(() => service.search("artist"));

    expect(error).toBeInstanceOf(JellyfinError);
    expect(error.message).toContain("fetching artist items for search");
    expect(error.message).toContain("Items.0.Name");
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
