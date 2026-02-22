import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import type { PlaybackBackend } from "./backend";
import { PlaybackError } from "./backend";
import { logger } from "../../logger";

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
  private onCompleteCallback?: () => void;
  private onErrorCallback?: (error: Error) => void;

  constructor(audioDevice: string = "default", debug: boolean = false) {
    this.audioDevice = audioDevice;
    this.debug = debug;
  }

  async play(url: string): Promise<void> {
    // Stop any existing playback
    if (this.isPlaying()) {
      await this.stop();
    }

    try {
      // Spawn ffplay process
      const args = [
        "-nodisp", // No video display
        "-autoexit", // Exit when playback finishes
        "-loglevel",
        this.debug ? "info" : "quiet", // Show output in debug mode
        url,
      ];

      // Configure spawn options
      const spawnOptions: SpawnOptions = {
        stdio: this.debug ? ["ignore", "pipe", "pipe"] : "ignore",
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

      this.process = spawn("ffplay", args, spawnOptions);
      this.startTime = Date.now();
      this.pausedAt = 0;
      this.isPaused_ = false;
      this.manuallyStopped = false;

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
      childProcess.on("error", (error) => {
        logger.error("[ffplay] process error:", error);
        this.cleanup();
        if (this.onErrorCallback) {
          this.onErrorCallback(error);
        }
      });

      childProcess.on("exit", (code) => {
        logger.debug(`[ffplay] exited with code ${code}`);

        // Only call onComplete if process exited naturally (not stopped manually)
        if (!this.manuallyStopped && this.onCompleteCallback) {
          this.onCompleteCallback();
        }

        this.cleanup();
      });

      // Wait a bit to ensure ffplay has started
      // This detects immediate startup failures (bad URL, missing codec, etc.)
      await new Promise((resolve) => setTimeout(resolve, 500));

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
    if (!this.isPlaying()) {
      return 0;
    }
    return this.isPaused_
      ? this.pausedAt
      : (Date.now() - this.startTime) / 1000;
  }

  onComplete(callback: () => void): void {
    this.onCompleteCallback = callback;
  }

  onError(callback: (error: Error) => void): void {
    this.onErrorCallback = callback;
  }

  private cleanup(): void {
    this.process = null;
    this.startTime = 0;
    this.pausedAt = 0;
    this.isPaused_ = false;
    this.manuallyStopped = false;
  }
}
