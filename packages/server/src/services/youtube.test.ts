import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawn } from "child_process";
import { readFileSync } from "fs";

import type { ChildProcess } from "child_process";

import { logger } from "../logger";
import { YouTubeService } from "./youtube";

const originalConsoleLog = console.log;

interface ScriptServiceOptions {
  timeoutMs?: number;
  terminationGraceMs?: number;
  onSpawn?: (childProcess: ChildProcess) => void;
}

function createScriptService(
  script: string,
  options: ScriptServiceOptions = {},
): YouTubeService {
  return new YouTubeService({
    spawnProcess: (_command, _args, spawnOptions) => {
      const childProcess = spawn(
        process.execPath,
        ["-e", script],
        spawnOptions,
      );
      options.onSpawn?.(childProcess);
      return childProcess;
    },
    timeoutMs: options.timeoutMs ?? 1_000,
    terminationGraceMs: options.terminationGraceMs,
  });
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    if (process.platform === "linux") {
      const processStat = readFileSync(`/proc/${processId}/stat`, "utf8");
      const state = processStat.slice(processStat.lastIndexOf(")") + 2, -1)[0];
      if (state === "Z") {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(processId: number): Promise<boolean> {
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    if (!isProcessRunning(processId)) {
      return true;
    }
    await Bun.sleep(10);
  }
  return !isProcessRunning(processId);
}

afterEach(() => {
  logger.disable();
  console.log = originalConsoleLog;
});

describe("YouTubeService", () => {
  test("creates a queue item from validated yt-dlp metadata", async () => {
    const service = createScriptService(`console.log(JSON.stringify({
              id: "video-123",
              title: "A Song",
              uploader: "An Artist",
              duration: 123,
              webpage_url: "https://www.youtube.com/watch?v=video-123"
            }))`);

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
    const service = createScriptService(`console.log("not-json")`);

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
    const service = createScriptService(
      `console.log(JSON.stringify({ id: "video-123" }))`,
    );

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
    const service = createScriptService(
      `console.error("failed for HTTPS://media.example/audio?token=secret&sig=private"); process.exit(7)`,
    );

    await expect(
      service.getVideoInfo("https://www.youtube.com/watch?v=video-123"),
    ).rejects.toMatchObject({
      name: "YouTubeError",
      code: "PROCESS_EXIT",
      operation: "metadata",
      exitCode: 7,
      signal: null,
      stderr: "failed for HTTPS://media.example/audio?[redacted]",
      message:
        "yt-dlp failed with exit code 7: failed for HTTPS://media.example/audio?[redacted]",
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
    const service = createScriptService(
      `console.log("not-a-url?token=secret")`,
    );

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
    const service = createScriptService(`setInterval(() => {}, 1_000)`, {
      timeoutMs: 50,
      terminationGraceMs: 25,
      onSpawn: (childProcess) => {
        child = childProcess;
      },
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
    const service = createScriptService(
      `process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)`,
      {
        timeoutMs: 50,
        terminationGraceMs: 50,
        onSpawn: (childProcess) => {
          child = childProcess;
        },
      },
    );

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

  test("terminates descendants that outlive the yt-dlp parent", async () => {
    let descendantProcessId: number | undefined;
    const descendantScript = `process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 1_000)`;
    const service = createScriptService(
      `const { spawn } = await import("child_process");
       const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
         stdio: ["ignore", "inherit", "inherit"]
       });
       console.log(descendant.pid);
       setInterval(() => {}, 1_000);`,
      {
        timeoutMs: 100,
        terminationGraceMs: 50,
        onSpawn: (childProcess) => {
          childProcess.stdout?.once("data", (data: Buffer) => {
            descendantProcessId = Number(data.toString().trim());
          });
        },
      },
    );

    try {
      await expect(
        service.getVideoInfo("https://www.youtube.com/watch?v=video-123"),
      ).rejects.toMatchObject({
        name: "YouTubeError",
        code: "TIMEOUT",
        operation: "metadata",
      });
      expect(descendantProcessId).toBeNumber();
      if (descendantProcessId === undefined) {
        throw new Error("Descendant process did not report its process ID");
      }
      expect(await waitForProcessExit(descendantProcessId)).toBe(true);
    } finally {
      if (
        descendantProcessId !== undefined &&
        isProcessRunning(descendantProcessId)
      ) {
        process.kill(descendantProcessId, "SIGKILL");
      }
    }
  });

  test("redacts YouTube query data from diagnostic logs", async () => {
    const lines: string[] = [];
    console.log = mock((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    logger.enable();
    const service = createScriptService(
      `console.log(JSON.stringify({ id: "video-123", title: "A Song" }))`,
    );

    await service.getVideoInfo(
      "https://www.youtube.com/watch?v=video-123&token=secret",
    );

    expect(lines.join("\n")).toContain(
      "YouTube: fetching video info for https://www.youtube.com/watch?[redacted]",
    );
    expect(lines.join("\n")).not.toContain("token=secret");
  });
});
