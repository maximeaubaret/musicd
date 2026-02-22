/**
 * Abstraction for audio playback backends
 * Separates audio player implementation (ffplay, mpv, vlc, etc.) from business logic
 */
export interface PlaybackBackend {
  /**
   * Start playing a URL
   * @param url Stream URL to play
   * @throws PlaybackError if startup fails
   */
  play(url: string): Promise<void>;

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
   * Register callback for when track completes naturally
   * Not called when stopped manually
   */
  onComplete(callback: () => void): void;

  /**
   * Register callback for playback errors
   */
  onError(callback: (error: Error) => void): void;
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
