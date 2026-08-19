import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  DaemonRequestError,
  DaemonResponseError,
  MusicDaemonClient,
} from "./index";

const originalFetch = globalThis.fetch;
const stoppedStatus = {
  state: "stopped",
  currentItem: null,
  position: 0,
  duration: 0,
  queue: [],
  queuePosition: -1,
  queueMode: { loop: false, random: false },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("MusicDaemonClient response validation", () => {
  test("rejects malformed successful status responses with a typed redacted error", async () => {
    const fetchMock = mock(async () =>
      Response.json({
        state: "buffering",
        accessToken: "daemon-token-DO-NOT-LOG",
      }),
    );
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const client = new MusicDaemonClient("http://127.0.0.1:8765");

    try {
      await client.status();
      throw new Error("Expected status validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonResponseError);
      expect(String(error)).toContain("GET /api/status");
      expect(String(error)).toContain("state");
      expect(String(error)).not.toContain("daemon-token-DO-NOT-LOG");
    }
  });

  test("rejects malformed daemon error responses with a typed redacted error", async () => {
    const fetchMock = mock(async () =>
      Response.json(
        {
          success: false,
          error: 42,
          password: "daemon-password-DO-NOT-LOG",
        },
        { status: 500 },
      ),
    );
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const client = new MusicDaemonClient("http://127.0.0.1:8765");

    try {
      await client.status();
      throw new Error("Expected error response validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonResponseError);
      expect(String(error)).toContain("daemon error response");
      expect(String(error)).toContain("GET /api/status");
      expect(String(error)).toContain("error");
      expect(String(error)).not.toContain("daemon-password-DO-NOT-LOG");
    }
  });

  test("uses the search endpoint contract for successful responses", async () => {
    const fetchMock = mock(async () =>
      Response.json({
        success: true,
        query: "miles",
        count: 1,
        results: [{ id: "track-1", name: "So What" }],
      }),
    );
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const client = new MusicDaemonClient("http://127.0.0.1:8765");

    await expect(client.search("miles")).rejects.toThrow(
      "results.0.type: invalid value",
    );
  });

  test("returns valid daemon failures as typed request errors", async () => {
    const fetchMock = mock(async () =>
      Response.json(
        { success: false, error: "Track was not found" },
        { status: 404 },
      ),
    );
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const client = new MusicDaemonClient("http://127.0.0.1:8765");

    try {
      await client.play("missing-track");
      throw new Error("Expected daemon request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonRequestError);
      expect(error).toMatchObject({
        endpoint: "POST /api/play",
        statusCode: 404,
        message: "Track was not found",
      });
    }
  });
});

describe("MusicDaemonClient transport security", () => {
  test("rejects remote HTTP setup credentials without the insecure override", async () => {
    let requestSent = false;
    const fetchMock = mock(async () => {
      requestSent = true;
      return Response.json({
        success: true,
        user: { id: "user-1", name: "listener" },
      });
    });
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const client = new MusicDaemonClient("http://music.example.com:8765");

    await expect(
      client.authenticate(
        "listener",
        "jellyfin-password",
        "https://jellyfin.example",
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(requestSent).toBe(false);
  });

  test("debug logs keep request context without authentication secrets", async () => {
    const messages: string[] = [];
    const fetchMock = mock(async () =>
      Response.json({
        success: true,
        user: { id: "user-1", name: "listener" },
      }),
    );
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const client = new MusicDaemonClient(
      "https://music.example.com",
      "daemon-password-DO-NOT-LOG",
      {
        logger: {
          debug: (...args: unknown[]) => {
            messages.push(args.map(String).join(" "));
          },
        },
      },
    );

    await client.authenticate("listener", "jellyfin-password-DO-NOT-LOG");

    const output = messages.join("\n");
    expect(output).toContain("POST https://music.example.com/api/auth");
    expect(output).toContain('"username":"listener"');
    expect(output).toMatch(/Response: 200 \(\d+ms\)/);
    expect(output).not.toContain("daemon-password-DO-NOT-LOG");
    expect(output).not.toContain("jellyfin-password-DO-NOT-LOG");
  });

  test("sends password-bearing remote requests over HTTPS", async () => {
    let request: Request | undefined;
    const fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        return Response.json(stoppedStatus);
      },
    );
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const client = new MusicDaemonClient(
      "https://music.example.com:443",
      "secret",
    );

    await client.status();

    expect(request?.url).toBe("https://music.example.com/api/status");
    expect(request?.headers.get("Authorization")).toBe("Bearer secret");
  });

  test("allows password-bearing HTTP for recognized loopback hosts", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = mock(async (input: string | URL | Request) => {
      requestedUrls.push(input.toString());
      return Response.json(stoppedStatus);
    });
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });

    for (const baseUrl of [
      "http://localhost:8765",
      "http://127.0.0.42:8765",
      "http://[::1]:8765",
    ]) {
      await new MusicDaemonClient(baseUrl, "secret").status();
    }

    expect(requestedUrls).toEqual([
      "http://localhost:8765/api/status",
      "http://127.0.0.42:8765/api/status",
      "http://[::1]:8765/api/status",
    ]);
  });

  test("rejects password-bearing remote HTTP before sending a request", async () => {
    let requestSent = false;
    const fetchMock = mock(async () => {
      requestSent = true;
      return Response.json(stoppedStatus);
    });
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const client = new MusicDaemonClient(
      "http://music.example.com:8765",
      "secret",
    );

    await expect(client.status()).rejects.toThrow(
      "Refusing to send credentials over insecure HTTP",
    );
    expect(requestSent).toBe(false);
  });

  test("allows explicitly trusted password-bearing remote HTTP", async () => {
    const requests: Request[] = [];
    const fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        requests.push(request);
        return Response.json(stoppedStatus);
      },
    );
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const client = new MusicDaemonClient("http://music.lan:8765", "secret", {
      allowInsecureHttp: true,
    });

    await client.status();

    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer secret");
  });
});

describe("MusicDaemonClient queue modes", () => {
  test("explicitly sets and reads the resulting queue mode", async () => {
    const requests: Request[] = [];
    const fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        requests.push(request);

        if (request.method === "POST") {
          return Response.json({
            success: true,
            message: "Queue mode updated",
            queueMode: { loop: true, random: false },
          });
        }

        return Response.json({
          success: true,
          queueMode: { loop: true, random: false },
        });
      },
    );
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const client = new MusicDaemonClient("http://127.0.0.1:8765");

    const setResult = await client.setQueueMode({ loop: true, random: false });
    const getResult = await client.getQueueMode();

    expect(setResult.queueMode).toEqual({ loop: true, random: false });
    expect(getResult.queueMode).toEqual({ loop: true, random: false });
    expect(requests).toHaveLength(2);
    expect(requests[0].method).toBe("POST");
    expect(new URL(requests[0].url).pathname).toBe("/api/queue/mode");
    expect(await requests[0].json()).toEqual({ loop: true, random: false });
    expect(requests[1].method).toBe("GET");
  });
});

describe("MusicDaemonClient volume", () => {
  test("gets and sets native playback volume", async () => {
    const requests: Request[] = [];
    const fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        requests.push(request);
        const volume =
          request.method === "POST"
            ? ((await request.clone().json()) as { volume: number }).volume
            : 70;
        return Response.json({ success: true, volume });
      },
    );
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const client = new MusicDaemonClient("http://127.0.0.1:8765");

    expect(await client.getVolume()).toEqual({ success: true, volume: 70 });
    expect(await client.setVolume(45)).toEqual({
      success: true,
      volume: 45,
    });
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(
      requests.every(
        (request) => new URL(request.url).pathname === "/api/volume",
      ),
    ).toBe(true);
  });
});

describe("MusicDaemonClient playlists and favorites", () => {
  test("uses typed playlist and favorite endpoints", async () => {
    const requests: Request[] = [];
    const fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        requests.push(request);

        if (request.url.includes("/api/playlist/")) {
          return Response.json({
            success: true,
            playlist: { id: "playlist-1", name: "Road Trip", type: "Playlist" },
            tracks: [
              {
                id: "track-1",
                name: "First",
                type: "Audio",
                duration: 180,
              },
            ],
            count: 1,
          });
        }

        if (request.url.includes("/api/favorites/songs?")) {
          return Response.json({
            success: true,
            kind: "songs",
            startIndex: 0,
            limit: 20,
            total: 1,
            count: 1,
            items: [
              {
                id: "track-1",
                name: "First",
                type: "Audio",
                duration: 180,
              },
            ],
          });
        }

        return Response.json({
          success: true,
          itemId: "track-1",
          favorite: request.method === "POST",
        });
      },
    );
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const client = new MusicDaemonClient("http://127.0.0.1:8765");

    const playlist = await client.getPlaylist("playlist-1");
    const favorites = await client.getFavorites("songs", 0, 20);
    const marked = await client.favorite("track-1");
    const unmarked = await client.unfavorite("track-1");

    expect(playlist.tracks.map((track) => track.id)).toEqual(["track-1"]);
    expect(favorites.items.map((item) => item.id)).toEqual(["track-1"]);
    expect(marked.favorite).toBe(true);
    expect(unmarked.favorite).toBe(false);
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "POST",
      "DELETE",
    ]);
  });
});
