import { afterEach, describe, expect, mock, test } from "bun:test";

import { JellyfinService } from "./jellyfin";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("JellyfinService playback source", () => {
  test("keeps the access token out of the stream URL", async () => {
    const token = "jellyfin-token-DO-NOT-EXPOSE";
    const fetchMock = mock(async () =>
      Response.json({
        Id: "track-1",
        Name: "Track",
        Type: "Audio",
      }),
    );
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
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
