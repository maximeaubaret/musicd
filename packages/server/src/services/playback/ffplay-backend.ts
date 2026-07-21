import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { once } from "events";

import { isCredentialKey } from "@musicd/shared";

import type { PlaybackBackend, PlaybackSource } from "./backend";
import { PlaybackError } from "./backend";
import { logger } from "../../logger";

/**
 * Convert an ffplay process exit code into a playback error.
 * A zero exit code is the only natural completion signal.
 */
export function getFFPlayExitError(
  exitCode: number | null,
): PlaybackError | null {
  if (exitCode === 0) {
    return null;
  }
  return new PlaybackError(
    exitCode === null
      ? "ffplay exited without an exit code"
      : `ffplay exited with code ${exitCode}`,
  );
}

function requiresPrivateTransport(source: PlaybackSource): boolean {
  if (source.headers && Object.keys(source.headers).length > 0) {
    return true;
  }

  const url = new URL(source.url);
  return [...url.searchParams.keys()].some(isCredentialKey);
}

interface FFPlayBackendDependencies {
  spawnProcess: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  fetchStream: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  waitForStartup: (milliseconds: number) => Promise<void>;
}

/**
 * Build ffplay arguments without placing protected stream credentials in argv.
 */
export function getFFPlayArguments(
  source: PlaybackSource,
  debug: boolean,
): string[] {
  return [
    "-nodisp",
    "-autoexit",
    "-loglevel",
    debug ? "info" : "quiet",
    requiresPrivateTransport(source) ? "pipe:0" : source.url,
  ];
}

/**
 * FFPlay backend implementation
 * Uses ffplay (from ffmpeg) for audio playback
 */
export class FFPlayBackend implements PlaybackBackend {
  private process: ChildProcess | null = null;
  private audioDevice: string;
  private debug: boolean;
  private startTime: number = 0;
  private pausedAt: number = 0;
  private isPaused_: boolean = false;
  private manuallyStopped: boolean = false;
  private streamAbortController: AbortController | null = null;
  private spawnProcess: FFPlayBackendDependencies["spawnProcess"];
  private fetchStream: FFPlayBackendDependencies["fetchStream"];
  private waitForStartup: FFPlayBackendDependencies["waitForStartup"];
  private onCompleteCallback?: (position: number) => void | Promise<void>;
  private onErrorCallback?: (
    error: Error,
    position: number,
  ) => void | Promise<void>;

  constructor(
    audioDevice: string = "default",
    debug: boolean = false,
    dependencies: Partial<FFPlayBackendDependencies> = {},
  ) {
    this.audioDevice = audioDevice;
    this.debug = debug;
    this.spawnProcess =
      dependencies.spawnProcess ??
      ((command, args, options) => spawn(command, args, options));
    this.fetchStream = dependencies.fetchStream ?? fetch;
    this.waitForStartup =
      dependencies.waitForStartup ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async play(source: PlaybackSource): Promise<void> {
    // Stop any existing playback
    if (this.isPlaying()) {
      await this.stop();
    }

    try {
      const usePrivateTransport = requiresPrivateTransport(source);
      let responseBody: ReadableStream<Uint8Array> | null = null;

      if (usePrivateTransport) {
        const abortController = new AbortController();
        this.streamAbortController = abortController;
        const response = await this.fetchStream(source.url, {
          headers: source.headers,
          redirect: "error",
          signal: abortController.signal,
        });
        if (!response.ok) {
          throw new PlaybackError(
            `Stream request failed with status ${response.status}`,
          );
        }
        if (!response.body) {
          throw new PlaybackError("Stream response did not include a body");
        }
        responseBody = response.body;
      }

      // Spawn ffplay process
      const args = getFFPlayArguments(source, this.debug);

      // Configure spawn options
      const spawnOptions: SpawnOptions = {
        stdio: [
          usePrivateTransport ? "pipe" : "ignore",
          this.debug ? "pipe" : "ignore",
          this.debug ? "pipe" : "ignore",
        ],
      };

      // Set SDL audio driver via environment variable if not default
      // ffplay uses SDL for audio output, which is controlled via environment variables
      if (this.audioDevice !== "default") {
        spawnOptions.env = {
          ...process.env,
          SDL_AUDIODRIVER: this.audioDevice, // e.g., "pulseaudio", "alsa", "pipewire"
        };
      }

      if (this.debug) {
        logger.debug(
          `[ffplay] Starting playback with command: ffplay ${args.join(" ")}`,
        );
        if (this.audioDevice !== "default") {
          logger.debug(`[ffplay] Using SDL audio driver: ${this.audioDevice}`);
        }
      }

      this.process = this.spawnProcess("ffplay", args, spawnOptions);
      this.startTime = Date.now();
      this.pausedAt = 0;
      this.isPaused_ = false;
      this.manuallyStopped = false;

      if (responseBody) {
        const childProcess = this.process;
        const abortController = this.streamAbortController;
        if (!childProcess.stdin || !abortController) {
          throw new PlaybackError("Unable to open ffplay input pipe");
        }
        void this.pipeStreamToFFPlay(
          responseBody,
          childProcess,
          abortController.signal,
        ).catch((error) => {
          if (abortController.signal.aborted || this.manuallyStopped) {
            return;
          }
          logger.error("[ffplay] protected stream pipe failed:", error);
          childProcess.kill("SIGTERM");
        });
      }

      // Capture stdout/stderr when in debug mode
      if (this.debug) {
        const stdout = this.process.stdout;
        const stderr = this.process.stderr;

        if (stdout) {
          logger.debug(`[ffplay] stdout listener attached`);
          stdout.on("data", (data: Buffer) => {
            logger.debug(`[ffplay stdout] ${data.toString().trim()}`);
          });
        } else {
          logger.debug(`[ffplay] WARNING: stdout is null`);
        }

        if (stderr) {
          logger.debug(`[ffplay] stderr listener attached`);
          stderr.on("data", (data: Buffer) => {
            logger.debug(`[ffplay stderr] ${data.toString().trim()}`);
          });
        } else {
          logger.debug(`[ffplay] WARNING: stderr is null`);
        }
      }

      // Handle process events
      const childProcess = this.process;
      let terminalEventEmitted = false;
      const claimTerminalEvent = (): boolean => {
        if (terminalEventEmitted) {
          return false;
        }
        terminalEventEmitted = true;
        return true;
      };
      childProcess.on("error", (error) => {
        if (!claimTerminalEvent()) {
          return;
        }
        logger.error("[ffplay] process error:", error);
        const position = this.getPosition();
        this.cleanup();
        const errorCallback = this.onErrorCallback;
        if (errorCallback) {
          void this.invokeTerminalCallback(
            () => errorCallback(error, position),
            "error",
          );
        }
      });

      childProcess.on("exit", (code) => {
        if (!claimTerminalEvent()) {
          return;
        }
        logger.debug(`[ffplay] exited with code ${code}`);
        const position = this.getPosition();
        const exitError = getFFPlayExitError(code);

        if (!this.manuallyStopped) {
          const errorCallback = this.onErrorCallback;
          const completeCallback = this.onCompleteCallback;
          if (exitError && errorCallback) {
            void this.invokeTerminalCallback(
              () => errorCallback(exitError, position),
              "error",
            );
          } else if (!exitError && completeCallback) {
            void this.invokeTerminalCallback(
              () => completeCallback(position),
              "completion",
            );
          }
        }

        this.cleanup();
      });

      // Wait a bit to ensure ffplay has started
      // This detects immediate startup failures (bad URL, missing codec, etc.)
      await this.waitForStartup(500);

      if (!this.process || this.process.exitCode !== null) {
        throw new PlaybackError("Failed to start ffplay process");
      }
    } catch (error) {
      this.cleanup();
      if (error instanceof PlaybackError) {
        throw error;
      }
      throw new PlaybackError(`Failed to play: ${error}`);
    }
  }

  pause(): void {
    // No-op if already paused or not playing
    if (!this.isPlaying() || this.isPaused_) {
      return;
    }

    // Calculate current position
    const elapsed = (Date.now() - this.startTime) / 1000;
    this.pausedAt = elapsed;
    this.isPaused_ = true;

    // Send SIGSTOP to pause the process
    this.process!.kill("SIGSTOP");
  }

  resume(): void {
    // No-op if not paused or not playing
    if (!this.isPlaying() || !this.isPaused_) {
      return;
    }

    this.isPaused_ = false;
    // Adjust start time to account for pause duration
    this.startTime = Date.now() - this.pausedAt * 1000;

    // Send SIGCONT to resume the process
    this.process!.kill("SIGCONT");
  }

  async stop(): Promise<void> {
    if (!this.isPlaying()) {
      return;
    }

    const processToStop = this.process!;
    this.manuallyStopped = true;
    this.streamAbortController?.abort();

    try {
      // Remove all listeners to prevent exit handler from running
      processToStop.removeAllListeners();

      // If paused, resume first so we can terminate cleanly
      if (this.isPaused_) {
        processToStop.kill("SIGCONT");
      }

      processToStop.kill("SIGTERM");

      // Wait for process to exit
      await new Promise((resolve) => {
        processToStop.on("exit", resolve);
        // Timeout after 2 seconds
        setTimeout(() => {
          if (processToStop && processToStop.exitCode === null) {
            processToStop.kill("SIGKILL");
          }
          resolve(null);
        }, 2000);
      });
    } finally {
      this.cleanup();
    }
  }

  isPlaying(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  isPaused(): boolean {
    return this.isPaused_;
  }

  getPosition(): number {
    if (!this.process) {
      return 0;
    }
    return this.isPaused_
      ? this.pausedAt
      : (Date.now() - this.startTime) / 1000;
  }

  onComplete(callback: (position: number) => void | Promise<void>): void {
    this.onCompleteCallback = callback;
  }

  onError(
    callback: (error: Error, position: number) => void | Promise<void>,
  ): void {
    this.onErrorCallback = callback;
  }

  private async invokeTerminalCallback(
    callback: () => void | Promise<void>,
    eventName: "completion" | "error",
  ): Promise<void> {
    try {
      await callback();
    } catch (error) {
      logger.error(`[ffplay] ${eventName} callback failed:`, error);
    }
  }

  private async pipeStreamToFFPlay(
    body: ReadableStream<Uint8Array>,
    childProcess: ChildProcess,
    signal: AbortSignal,
  ): Promise<void> {
    const stdin = childProcess.stdin;
    if (!stdin) {
      throw new PlaybackError("Unable to open ffplay input pipe");
    }

    const reader = body.getReader();
    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        if (!stdin.write(chunk.value)) {
          await once(stdin, "drain");
        }
      }
    } finally {
      reader.releaseLock();
      if (!stdin.destroyed) {
        stdin.end();
      }
    }
  }

  private cleanup(): void {
    this.streamAbortController?.abort();
    this.streamAbortController = null;
    this.process = null;
    this.startTime = 0;
    this.pausedAt = 0;
    this.isPaused_ = false;
    this.manuallyStopped = false;
  }
}
