import { afterEach, describe, expect, mock, test } from "bun:test";

import { logger } from "./logger";

const originalConsoleLog = console.log;

afterEach(() => {
  logger.disable();
  console.log = originalConsoleLog;
});

describe("server diagnostic logging", () => {
  test("keeps HTTP context without credential values", () => {
    const lines: string[] = [];
    console.log = mock((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    logger.enable();
    const url =
      "https://jellyfin.example/Audio/item/universal?api_key=jellyfin-token-DO-NOT-LOG&AccessToken=second-token-DO-NOT-LOG&password=query-password-DO-NOT-LOG&signature=signed-query-DO-NOT-LOG&quality=high";

    logger.http("request", { method: "GET", url });
    logger.http("response", {
      method: "GET",
      url,
      status: 200,
      duration: 37,
    });
    logger.debug(
      'Authorization: Bearer daemon-password-DO-NOT-LOG; X-MediaBrowser-Token: header-token-DO-NOT-LOG; Authorization: MediaBrowser Token="media-token-DO-NOT-LOG"',
    );

    const output = lines.join("\n");
    expect(output).toContain(
      "GET https://jellyfin.example/Audio/item/universal?",
    );
    expect(output).toContain("quality=high");
    expect(output).toContain("200 (37ms)");
    expect(output).not.toContain("jellyfin-token-DO-NOT-LOG");
    expect(output).not.toContain("second-token-DO-NOT-LOG");
    expect(output).not.toContain("query-password-DO-NOT-LOG");
    expect(output).not.toContain("signed-query-DO-NOT-LOG");
    expect(output).not.toContain("daemon-password-DO-NOT-LOG");
    expect(output).not.toContain("header-token-DO-NOT-LOG");
    expect(output).not.toContain("media-token-DO-NOT-LOG");
  });
});
