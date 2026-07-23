/**
 * Abstraction for audio playback backends
 * Separates audio player implementation (ffplay, mpv, vlc, etc.) from business logic
 */
export interface PlaybackSource {
  url: string;
  headers?: Record<string, string>;
  /**
   * Start playback this many seconds into the stream. Backends that cannot
   * reposition a live pipeline implement this at spawn time (ffplay -ss).
   */
  startPosition?: number;
}

export interface PlaybackBackend {
  /**
   * Start playing a stream source
   * @param source Stream location and optional request headers
   * @throws PlaybackError if startup fails
   */
  play(source: PlaybackSource): Promise<void>;

  /**
   * Pause playback
   * No-op if not playing or already paused
   */
  pause(): void;

  /**
   * Resume playback
   * No-op if not paused
   */
  resume(): void;

  /**
   * Stop playback
   * Should be idempotent (safe to call multiple times)
   */
  stop(): Promise<void>;

  /**
   * Check if currently playing
   */
  isPlaying(): boolean;

  /**
   * Check if currently paused
   */
  isPaused(): boolean;

  /**
   * Get current playback position in seconds
   */
  getPosition(): number;

  /**
   * Optional: seek in place to an absolute position (seconds) without
   * restarting the pipeline. Backends without this capability omit it and
   * callers fall back to restarting playback at the target offset.
   */
  seek?(positionSeconds: number): Promise<void>;

  /**
   * Optional native per-stream volume support, expressed as a percentage.
   * Backends retain the selected value while stopped and apply it to each
   * newly-created playback process.
   */
  getVolume?(): number;
  setVolume?(volumePercent: number): void;

  /**
   * Register callback for when track completes naturally
   * Not called when stopped manually
   * @param callback Receives the final playback position in seconds
   */
  onComplete(callback: (position: number) => void | Promise<void>): void;

  /**
   * Register callback for playback errors
   * @param callback Receives the error and last playback position in seconds
   */
  onError(
    callback: (error: Error, position: number) => void | Promise<void>,
  ): void;
}

/**
 * Error thrown by playback backends
 */
export class PlaybackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaybackError";
  }
}
