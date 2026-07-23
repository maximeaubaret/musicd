import { spawn, type ChildProcess, type SpawnOptions } from "child_process";

import type { PlaybackBackend, PlaybackSource } from "./backend";
import { PlaybackError } from "./backend";
import { logger } from "../../logger";

const DEFAULT_DECODE_STARTUP_TIMEOUT_MS = 5000;

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

interface FFPlayBackendDependencies {
  spawnProcess: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  waitForStartup: (milliseconds: number) => Promise<void>;
  decodeStartupTimeoutMs: number;
}

/**
 * Parse the latest media clock reported by ffplay's status output.
 */
export function getFFPlayMediaPosition(output: string): number | null {
  const statusPattern = /(-?\d+(?:\.\d+)?)\s+(?:A-V|M-A|M-V):/g;
  let latestPosition: number | null = null;
  let match: RegExpExecArray | null;

  while ((match = statusPattern.exec(output)) !== null) {
    const parsedPosition = Number(match[1]);
    if (Number.isFinite(parsedPosition)) {
      latestPosition = Math.max(0, parsedPosition);
    }
  }

  return latestPosition;
}

/**
 * Build ffplay arguments for a directly accessible, seekable stream.
 *
 * ffplay's HTTP headers option is necessarily visible in the child process
 * argv. Debug logging redacts credential values before emitting the command.
 */
export function getFFPlayArguments(
  source: PlaybackSource,
  debug: boolean,
): string[] {
  const args = [
    "-nodisp",
    "-autoexit",
    "-loglevel",
    debug ? "info" : "quiet",
    "-stats",
  ];

  // Seek at spawn: ffplay reports the absolute media clock afterwards, so
  // position tracking needs no adjustment.
  if (source.startPosition !== undefined && source.startPosition > 0) {
    args.push("-ss", String(source.startPosition));
  }

  if (source.headers) {
    const serializedHeaders = Object.entries(source.headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("");
    if (serializedHeaders.length > 0) {
      args.push("-headers", serializedHeaders);
    }
  }

  args.push(source.url);
  return args;
}

/**
 * FFPlay backend implementation
 * Uses ffplay (from ffmpeg) for audio playback
 */
export class FFPlayBackend implements PlaybackBackend {
  private process: ChildProcess | null = null;
  private audioDevice: string;
  private debug: boolean;
  private position: number = 0;
  private isPaused_: boolean = false;
  private manuallyStopped: boolean = false;
  private decodeStartupTimer: NodeJS.Timeout | null = null;
  private spawnProcess: FFPlayBackendDependencies["spawnProcess"];
  private waitForStartup: FFPlayBackendDependencies["waitForStartup"];
  private decodeStartupTimeoutMs: number;
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
    this.waitForStartup =
      dependencies.waitForStartup ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.decodeStartupTimeoutMs =
      dependencies.decodeStartupTimeoutMs ?? DEFAULT_DECODE_STARTUP_TIMEOUT_MS;
  }

  async play(source: PlaybackSource): Promise<void> {
    // Stop any existing playback
    if (this.isPlaying()) {
      await this.stop();
    }

    let childProcess: ChildProcess | null = null;
    try {
      // Spawn ffplay process
      const args = getFFPlayArguments(source, this.debug);

      // Configure spawn options
      const spawnOptions: SpawnOptions = {
        stdio: ["ignore", this.debug ? "pipe" : "ignore", "pipe"],
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
        const loggedArgs = args.map((arg, index) =>
          args[index - 1] === "-headers" ? "<redacted HTTP headers>" : arg,
        );
        logger.debug(
          `[ffplay] Starting playback with command: ffplay ${loggedArgs.join(" ")}`,
        );
        if (this.audioDevice !== "default") {
          logger.debug(`[ffplay] Using SDL audio driver: ${this.audioDevice}`);
        }
      }

      const activeProcess = this.spawnProcess("ffplay", args, spawnOptions);
      childProcess = activeProcess;
      this.process = activeProcess;
      this.position = source.startPosition ?? 0;
      this.isPaused_ = false;
      this.manuallyStopped = false;
      let processPosition = source.startPosition ?? 0;
      let decodedAudio = false;
      let statusBuffer = "";
      let startupTimedOut = false;
      let terminalError: PlaybackError | null = null;

      // Capture stdout/stderr when in debug mode
      if (this.debug) {
        const stdout = activeProcess.stdout;

        if (stdout) {
          logger.debug(`[ffplay] stdout listener attached`);
          stdout.on("data", (data: Buffer) => {
            logger.debug(`[ffplay stdout] ${data.toString().trim()}`);
          });
        } else {
          logger.debug(`[ffplay] WARNING: stdout is null`);
        }
      }

      const stderr = activeProcess.stderr;
      if (stderr) {
        if (this.debug) {
          logger.debug(`[ffplay] stderr listener attached`);
        }
        stderr.on("data", (data: Buffer) => {
          const output = data.toString();
          const statusOutput = statusBuffer + output;
          statusBuffer = statusOutput.slice(-128);
          const mediaPosition = getFFPlayMediaPosition(statusOutput);
          if (mediaPosition !== null && this.process === activeProcess) {
            processPosition = mediaPosition;
            this.position = mediaPosition;
            decodedAudio = true;
            this.clearDecodeStartupTimer();
          }
          if (this.debug) {
            logger.debug(`[ffplay stderr] ${output.trim()}`);
          }
        });
      } else {
        if (this.debug) {
          logger.debug(`[ffplay] WARNING: stderr is null`);
        }
      }

      // Handle process events
      let terminalEventEmitted = false;
      const claimTerminalEvent = (): boolean => {
        if (terminalEventEmitted) {
          return false;
        }
        terminalEventEmitted = true;
        return true;
      };
      activeProcess.on("error", (error) => {
        if (!claimTerminalEvent()) {
          return;
        }
        logger.error("[ffplay] process error:", error);
        const position = processPosition;
        const wasManuallyStopped = this.manuallyStopped;
        terminalError = new PlaybackError(
          `ffplay process error: ${error.message}`,
        );
        this.cleanup(activeProcess);
        const errorCallback = this.onErrorCallback;
        if (!wasManuallyStopped && errorCallback) {
          void this.invokeTerminalCallback(
            () => errorCallback(error, position),
            "error",
          );
        }
      });

      activeProcess.on("exit", (code) => {
        if (!claimTerminalEvent()) {
          return;
        }
        logger.debug(`[ffplay] exited with code ${code}`);
        const position = processPosition;
        const wasManuallyStopped = this.manuallyStopped;
        const exitError = startupTimedOut
          ? new PlaybackError(
              `ffplay did not decode audio within ${this.decodeStartupTimeoutMs}ms`,
            )
          : getFFPlayExitError(code);
        terminalError = exitError;
        this.cleanup(activeProcess);

        if (!wasManuallyStopped) {
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
      });

      this.decodeStartupTimer = setTimeout(() => {
        if (
          this.process !== activeProcess ||
          decodedAudio ||
          this.isPaused_ ||
          activeProcess.exitCode !== null
        ) {
          return;
        }
        startupTimedOut = true;
        logger.error(
          `[ffplay] no decoded audio after ${this.decodeStartupTimeoutMs}ms; terminating playback`,
        );
        activeProcess.kill("SIGTERM");
      }, this.decodeStartupTimeoutMs);
      this.decodeStartupTimer.unref();

      // Wait a bit to ensure ffplay has started
      // This detects immediate startup failures (bad URL, missing codec, etc.)
      await this.waitForStartup(500);

      if (terminalError) {
        throw terminalError;
      }
      if (terminalEventEmitted) {
        return;
      }
      if (this.process !== activeProcess || activeProcess.exitCode !== null) {
        throw new PlaybackError("Failed to start ffplay process");
      }
    } catch (error) {
      if (childProcess) {
        this.cleanup(childProcess);
      }
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

    // Send SIGCONT to resume the process
    this.process!.kill("SIGCONT");
  }

  async stop(): Promise<void> {
    if (!this.isPlaying()) {
      return;
    }

    const processToStop = this.process!;
    this.manuallyStopped = true;
    this.clearDecodeStartupTimer();

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
      this.cleanup(processToStop);
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
    return this.position;
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

  private clearDecodeStartupTimer(): void {
    if (this.decodeStartupTimer) {
      clearTimeout(this.decodeStartupTimer);
      this.decodeStartupTimer = null;
    }
  }

  private cleanup(processToClean: ChildProcess): void {
    if (this.process !== processToClean) {
      return;
    }
    this.clearDecodeStartupTimer();
    this.process = null;
    this.position = 0;
    this.isPaused_ = false;
    this.manuallyStopped = false;
  }
}
