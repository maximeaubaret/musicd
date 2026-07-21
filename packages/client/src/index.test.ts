import { afterEach, describe, expect, mock, test } from "bun:test";

import { MusicDaemonClient } from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
