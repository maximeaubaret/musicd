import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";

import { YouTubeService } from "./youtube";
import { logger } from "../logger";

const originalConsoleLog = console.log;

afterEach(() => {
  logger.disable();
  console.log = originalConsoleLog;
});

describe("YouTubeService", () => {
  test("creates a queue item from validated yt-dlp metadata", async () => {
    const service = new YouTubeService({
      spawnProcess: (_command, _args, options) =>
        spawn(
          process.execPath,
          [
            "-e",
            `console.log(JSON.stringify({
              id: "video-123",
              title: "A Song",
              uploader: "An Artist",
              duration: 123,
              webpage_url: "https://www.youtube.com/watch?v=video-123"
            }))`,
          ],
          options,
        ),
      timeoutMs: 1_000,
    });

    await expect(
      service.createQueueItem(
        "https://www.youtube.com/watch?v=video-123&token=secret",
      ),
    ).resolves.toEqual({
      id: "video-123",
      name: "A Song",
      artist: "An Artist",
      album: undefined,
      duration: 123,
      source: "youtube",
      youtubeUrl: "https://www.youtube.com/watch?v=video-123",
      videoId: "video-123",
      uploader: "An Artist",
    });
  });

  test("reports malformed metadata JSON as a typed YouTube error", async () => {
    const service = new YouTubeService({
      spawnProcess: (_command, _args, options) =>
        spawn(process.execPath, ["-e", `console.log("not-json")`], options),
      timeoutMs: 1_000,
    });

    await expect(
      service.getVideoInfo("https://www.youtube.com/watch?v=video-123"),
    ).rejects.toMatchObject({
      name: "YouTubeError",
      code: "INVALID_METADATA",
      operation: "metadata",
      message: "yt-dlp returned malformed metadata JSON",
      cause: expect.any(SyntaxError),
    });
  });

  test("reports missing required metadata fields before creating an item", async () => {
    const service = new YouTubeService({
      spawnProcess: (_command, _args, options) =>
        spawn(
          process.execPath,
          ["-e", `console.log(JSON.stringify({ id: "video-123" }))`],
          options,
        ),
      timeoutMs: 1_000,
    });

    await expect(
      service.createQueueItem(
        "https://www.youtube.com/watch?v=video-123&token=secret",
      ),
    ).rejects.toMatchObject({
      name: "YouTubeError",
      code: "INVALID_METADATA",
      operation: "metadata",
      message: "yt-dlp returned invalid metadata: title: Required",
    });
  });

  test("retains sanitized context for a non-zero yt-dlp exit", async () => {
    const service = new YouTubeService({
      spawnProcess: (_command, _args, options) =>
        spawn(
          process.execPath,
          [
            "-e",
            `console.error("failed for https://media.example/audio?token=secret&sig=private"); process.exit(7)`,
          ],
          options,
        ),
      timeoutMs: 1_000,
    });

    await expect(
      service.getVideoInfo("https://www.youtube.com/watch?v=video-123"),
    ).rejects.toMatchObject({
      name: "YouTubeError",
      code: "PROCESS_EXIT",
      operation: "metadata",
      exitCode: 7,
      signal: null,
      stderr: "failed for https://media.example/audio?[redacted]",
      message:
        "yt-dlp failed with exit code 7: failed for https://media.example/audio?[redacted]",
    });
  });

  test("reports a missing yt-dlp executable with typed context", async () => {
    const service = new YouTubeService({
      executable: "musicd-test-yt-dlp-does-not-exist",
      timeoutMs: 1_000,
    });

    await expect(
      service.getStreamUrl("https://www.youtube.com/watch?v=video-123"),
    ).rejects.toMatchObject({
      name: "YouTubeError",
      code: "EXECUTABLE_NOT_FOUND",
      operation: "stream-url",
      executable: "musicd-test-yt-dlp-does-not-exist",
      message: "yt-dlp executable was not found",
      cause: expect.objectContaining({ code: "ENOENT" }),
    });
  });

  test("rejects malformed stream URL output without echoing it", async () => {
    const service = new YouTubeService({
      spawnProcess: (_command, _args, options) =>
        spawn(
          process.execPath,
          ["-e", `console.log("not-a-url?token=secret")`],
          options,
        ),
      timeoutMs: 1_000,
    });

    await expect(
      service.getStreamUrl("https://www.youtube.com/watch?v=video-123"),
    ).rejects.toMatchObject({
      name: "YouTubeError",
      code: "INVALID_STREAM_URL",
      operation: "stream-url",
      message: "yt-dlp returned an invalid stream URL",
      cause: expect.any(Error),
    });
  });

  test("wraps process spawn failures with typed and sanitized context", async () => {
    const processError = Object.assign(
      new Error("denied https://media.example/audio?token=secret"),
      { code: "EACCES" },
    );
    const service = new YouTubeService({
      spawnProcess: () => {
        throw processError;
      },
      timeoutMs: 1_000,
    });

    await expect(
      service.getVideoInfo("https://www.youtube.com/watch?v=video-123"),
    ).rejects.toMatchObject({
      name: "YouTubeError",
      code: "PROCESS_ERROR",
      operation: "metadata",
      processCode: "EACCES",
      message:
        "Failed to start yt-dlp: denied https://media.example/audio?[redacted]",
      cause: processError,
    });
  });

  test("times out only after the yt-dlp child has terminated", async () => {
    let child: ChildProcess | undefined;
    const service = new YouTubeService({
      spawnProcess: (_command, _args, options) => {
        child = spawn(
          process.execPath,
          ["-e", `setInterval(() => {}, 1_000)`],
          options,
        );
        return child;
      },
      timeoutMs: 50,
    });

    await expect(
      service.getVideoInfo("https://www.youtube.com/watch?v=video-123"),
    ).rejects.toMatchObject({
      name: "YouTubeError",
      code: "TIMEOUT",
      operation: "metadata",
      timeoutMs: 50,
      message: "yt-dlp timed out after 50ms",
    });
    expect(child?.signalCode).toBe("SIGTERM");
  });

  test("escalates termination when the yt-dlp child ignores SIGTERM", async () => {
    let child: ChildProcess | undefined;
    const service = new YouTubeService({
      spawnProcess: (_command, _args, options) => {
        child = spawn(
          process.execPath,
          [
            "-e",
            `process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)`,
          ],
          options,
        );
        return child;
      },
      timeoutMs: 50,
      terminationGraceMs: 50,
    });

    await expect(
      service.getVideoInfo("https://www.youtube.com/watch?v=video-123"),
    ).rejects.toMatchObject({
      name: "YouTubeError",
      code: "TIMEOUT",
      operation: "metadata",
      signal: "SIGKILL",
    });
    expect(child?.signalCode).toBe("SIGKILL");
  });

  test("redacts YouTube query data from diagnostic logs", async () => {
    const lines: string[] = [];
    console.log = mock((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    logger.enable();
    const service = new YouTubeService({
      spawnProcess: (_command, _args, options) =>
        spawn(
          process.execPath,
          [
            "-e",
            `console.log(JSON.stringify({ id: "video-123", title: "A Song" }))`,
          ],
          options,
        ),
      timeoutMs: 1_000,
    });

    await service.getVideoInfo(
      "https://www.youtube.com/watch?v=video-123&token=secret",
    );

    expect(lines.join("\n")).toContain(
      "YouTube: fetching video info for https://www.youtube.com/watch?[redacted]",
    );
    expect(lines.join("\n")).not.toContain("token=secret");
  });
});
