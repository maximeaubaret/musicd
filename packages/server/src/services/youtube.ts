import { spawn } from "child_process";
import { z } from "zod";

import type { ChildProcess, SpawnOptions } from "child_process";

import { YouTubeError, isYouTubeUrl } from "@musicd/shared";

import { logger } from "../logger";

import type { YouTubeOperation, YouTubeQueueItem } from "@musicd/shared";

const YtDlpMetadataSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  uploader: z.string().min(1).nullish(),
  channel: z.string().min(1).nullish(),
  duration: z.number().finite().nonnegative().nullish(),
  original_url: z.string().url().nullish(),
  webpage_url: z.string().url().nullish(),
});

const StreamUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  });

function redactUrlQueryData(value: string): string {
  return value.replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[redacted]");
}

function getErrorCode(error: Error): string | undefined {
  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

interface YouTubeServiceDependencies {
  spawnProcess: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  timeoutMs: number;
  terminationGraceMs: number;
  executable: string;
}

interface ProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export class YouTubeService {
  private readonly spawnProcess: YouTubeServiceDependencies["spawnProcess"];
  private readonly timeoutMs: number;
  private readonly terminationGraceMs: number;
  private readonly executable: string;

  constructor(dependencies: Partial<YouTubeServiceDependencies> = {}) {
    this.spawnProcess = dependencies.spawnProcess ?? spawn;
    this.timeoutMs = dependencies.timeoutMs ?? 30_000;
    this.terminationGraceMs = dependencies.terminationGraceMs ?? 1_000;
    this.executable = dependencies.executable ?? "yt-dlp";
  }

  /**
   * Check if yt-dlp is installed and accessible
   */
  async checkAvailability(): Promise<boolean> {
    try {
      await this.runYtDlp(["--version"], "availability");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate that a string is a YouTube URL
   */
  static isYouTubeUrl(input: string): boolean {
    return isYouTubeUrl(input);
  }

  /**
   * Extract video ID from a YouTube URL
   */
  static extractVideoId(url: string): string | null {
    try {
      const parsed = new URL(url);

      // youtu.be/VIDEO_ID
      if (parsed.hostname === "youtu.be") {
        const id = parsed.pathname.slice(1);
        return id || null;
      }

      // youtube.com/watch?v=VIDEO_ID
      const vParam = parsed.searchParams.get("v");
      if (vParam) {
        return vParam;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get metadata for a YouTube video using yt-dlp --dump-json
   */
  async getVideoInfo(url: string): Promise<{
    id: string;
    title: string;
    artist: string | undefined;
    duration: number;
    youtubeUrl: string;
  }> {
    logger.debug(`YouTube: fetching video info for ${redactUrlQueryData(url)}`);

    const output = await this.runYtDlp(
      ["--dump-json", "--no-download", "--no-playlist", url],
      "metadata",
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      const cause =
        error instanceof Error ? error : new SyntaxError("Invalid JSON");
      throw new YouTubeError("yt-dlp returned malformed metadata JSON", {
        code: "INVALID_METADATA",
        operation: "metadata",
        cause,
      });
    }

    const result = YtDlpMetadataSchema.safeParse(parsed);
    if (!result.success) {
      const details = result.error.issues
        .map(
          (issue) => `${issue.path.join(".") || "metadata"}: ${issue.message}`,
        )
        .join("; ");
      throw new YouTubeError(`yt-dlp returned invalid metadata: ${details}`, {
        code: "INVALID_METADATA",
        operation: "metadata",
        cause: result.error,
      });
    }

    const json = result.data;

    return {
      id: json.id,
      title: json.title,
      artist: json.uploader ?? json.channel ?? undefined,
      duration: json.duration ?? 0,
      youtubeUrl: json.webpage_url || json.original_url || url,
    };
  }

  /**
   * Get the best audio stream URL for a YouTube video
   */
  async getStreamUrl(url: string): Promise<string> {
    logger.debug(
      `YouTube: extracting stream URL for ${redactUrlQueryData(url)}`,
    );

    const streamUrl = await this.runYtDlp(
      ["-f", "bestaudio", "--get-url", "--no-download", "--no-playlist", url],
      "stream-url",
    );

    const result = StreamUrlSchema.safeParse(streamUrl);
    if (!result.success) {
      throw new YouTubeError("yt-dlp returned an invalid stream URL", {
        code: "INVALID_STREAM_URL",
        operation: "stream-url",
        cause: result.error,
      });
    }

    return result.data;
  }

  /**
   * Create a QueueItem from a YouTube URL
   */
  async createQueueItem(url: string): Promise<YouTubeQueueItem> {
    const info = await this.getVideoInfo(url);

    return {
      id: info.id,
      name: info.title,
      artist: info.artist,
      album: undefined,
      duration: info.duration,
      source: "youtube",
      youtubeUrl: info.youtubeUrl,
      videoId: info.id,
      uploader: info.artist,
    };
  }

  /**
   * Run yt-dlp with the given arguments
   * Handles timeouts, ENOENT, and error parsing
   */
  private async runYtDlp(
    args: string[],
    operation: YouTubeOperation,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = this.spawnProcess(this.executable, args, {
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(this.createProcessError(toError(error), operation));
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      let terminating = false;
      let timedOut = false;
      let sigkillSent = false;
      let processExit: ProcessExit | undefined;
      let processError: YouTubeError | undefined;
      let escalationTimer: ReturnType<typeof setTimeout> | undefined;
      let terminationTimer: ReturnType<typeof setTimeout> | undefined;

      const clearTimers = (): void => {
        clearTimeout(timeoutTimer);
        if (escalationTimer) {
          clearTimeout(escalationTimer);
        }
        if (terminationTimer) {
          clearTimeout(terminationTimer);
        }
      };

      const rejectOnce = (error: YouTubeError): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        reject(error);
      };

      const createTimeoutError = (exit: ProcessExit): YouTubeError =>
        new YouTubeError(`yt-dlp timed out after ${this.timeoutMs}ms`, {
          code: "TIMEOUT",
          operation,
          timeoutMs: this.timeoutMs,
          exitCode: exit.exitCode,
          signal: exit.signal,
        });

      const terminate = (): void => {
        if (terminating) {
          return;
        }
        terminating = true;
        const terminationCause = this.signalProcessTree(proc, "SIGTERM");
        escalationTimer = setTimeout(() => {
          sigkillSent = true;
          const escalationCause = this.signalProcessTree(proc, "SIGKILL");
          if (processExit) {
            rejectOnce(createTimeoutError(processExit));
            return;
          }
          terminationTimer = setTimeout(() => {
            if (proc.exitCode !== null || proc.signalCode !== null) {
              rejectOnce(
                createTimeoutError({
                  exitCode: proc.exitCode,
                  signal: proc.signalCode,
                }),
              );
              return;
            }
            rejectOnce(
              new YouTubeError("yt-dlp did not terminate after SIGKILL", {
                code: "TERMINATION_FAILED",
                operation,
                timeoutMs: this.timeoutMs,
                cause: escalationCause ?? terminationCause,
              }),
            );
          }, this.terminationGraceMs);
        }, this.terminationGraceMs);
      };

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, this.timeoutMs);

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("exit", (code, signal) => {
        processExit = { exitCode: code, signal };
        if (!timedOut || !sigkillSent || settled) {
          return;
        }
        // SIGKILL has reached the process group, and "exit" confirms the child ended.
        rejectOnce(createTimeoutError(processExit));
      });

      proc.on("close", (code, signal) => {
        if (settled) {
          return;
        }
        if (timedOut) {
          processExit ??= { exitCode: code, signal };
          if (sigkillSent) {
            rejectOnce(createTimeoutError(processExit));
          }
          return;
        }
        settled = true;
        clearTimers();
        if (processError) {
          reject(processError);
          return;
        }
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          const safeStderr = redactUrlQueryData(stderr.trim());
          const status =
            code === null
              ? `signal ${signal ?? "unknown"}`
              : `exit code ${code}`;
          reject(
            new YouTubeError(
              `yt-dlp failed with ${status}: ${safeStderr || "Unknown error"}`,
              {
                code: "PROCESS_EXIT",
                operation,
                exitCode: code,
                signal,
                stderr: safeStderr,
              },
            ),
          );
        }
      });

      proc.on("error", (error) => {
        if (settled) {
          return;
        }
        processError = this.createProcessError(error, operation);
        clearTimeout(timeoutTimer);
        if (proc.pid === undefined) {
          rejectOnce(processError);
          return;
        }
        terminate();
      });
    });
  }

  private signalProcessTree(
    childProcess: ChildProcess,
    signal: NodeJS.Signals,
  ): Error | undefined {
    try {
      if (process.platform !== "win32" && childProcess.pid !== undefined) {
        process.kill(-childProcess.pid, signal);
      } else {
        childProcess.kill(signal);
      }
      return undefined;
    } catch (error) {
      const cause = toError(error);
      return getErrorCode(cause) === "ESRCH" ? undefined : cause;
    }
  }

  private createProcessError(
    error: Error,
    operation: YouTubeOperation,
  ): YouTubeError {
    const processCode = getErrorCode(error);
    if (processCode === "ENOENT") {
      return new YouTubeError("yt-dlp executable was not found", {
        code: "EXECUTABLE_NOT_FOUND",
        operation,
        executable: this.executable,
        processCode,
        cause: error,
      });
    }

    return new YouTubeError(
      `Failed to start yt-dlp: ${redactUrlQueryData(error.message)}`,
      {
        code: "PROCESS_ERROR",
        operation,
        executable: this.executable,
        processCode,
        cause: error,
      },
    );
  }
}
