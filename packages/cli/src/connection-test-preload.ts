const expectedUrl = process.env.MUSICD_CLI_EXPECTED_URL;
const expectedAuthorization =
  process.env.MUSICD_CLI_EXPECTED_AUTHORIZATION ?? null;

if (!expectedUrl) {
  throw new Error("MUSICD_CLI_EXPECTED_URL is required");
}

const originalFetch = globalThis.fetch;
const mockFetch: typeof fetch = Object.assign(
  async function (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);

    if (request.url !== expectedUrl) {
      throw new Error(
        `Expected request URL ${expectedUrl}, got ${request.url}`,
      );
    }
    const authorization = request.headers.get("Authorization");
    if (authorization !== expectedAuthorization) {
      throw new Error(
        `Expected authorization ${expectedAuthorization}, got ${authorization}`,
      );
    }

    return Response.json({
      state: "stopped",
      currentItem: null,
      position: 0,
      duration: 0,
      queue: [],
      queuePosition: -1,
      queueMode: { loop: false, random: false },
    });
  },
  { preconnect: originalFetch.preconnect },
);

globalThis.fetch = mockFetch;
