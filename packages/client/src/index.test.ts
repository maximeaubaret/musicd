import { afterEach, describe, expect, mock, test } from "bun:test";

import { MusicDaemonClient } from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("MusicDaemonClient transport security", () => {
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
        return Response.json({ state: "stopped" });
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
      return Response.json({ state: "stopped" });
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
      return Response.json({ state: "stopped" });
    });
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const client = new MusicDaemonClient(
      "http://music.example.com:8765",
      "secret",
    );

    await expect(client.status()).rejects.toThrow(
      "Refusing to send a daemon password over insecure HTTP",
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
        return Response.json({ state: "stopped" });
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
