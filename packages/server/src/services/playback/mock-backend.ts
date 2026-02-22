import { PlaybackBackend } from "./backend";

/**
 * Mock backend for testing
 * Provides instant, synchronous playback simulation
 */
export class MockBackend implements PlaybackBackend {
  private _isPlaying = false;
  private _isPaused = false;
  private _position = 0;
  private onCompleteCallback?: () => void;
  private onErrorCallback?: (error: Error) => void;

  /**
   * Start playing (synchronous, no delays)
   */
  async play(_url: string): Promise<void> {
    this._isPlaying = true;
    this._isPaused = false;
    this._position = 0;
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (this._isPlaying && !this._isPaused) {
      this._isPaused = true;
    }
  }

  /**
   * Resume playback
   */
  resume(): void {
    if (this._isPaused) {
      this._isPaused = false;
    }
  }

  /**
   * Stop playback
   */
  async stop(): Promise<void> {
    this._isPlaying = false;
    this._isPaused = false;
    this._position = 0;
  }

  /**
   * Check if playing
   */
  isPlaying(): boolean {
    return this._isPlaying;
  }

  /**
   * Check if paused
   */
  isPaused(): boolean {
    return this._isPaused;
  }

  /**
   * Get current position
   */
  getPosition(): number {
    return this._position;
  }

  /**
   * Register completion callback
   */
  onComplete(callback: () => void): void {
    this.onCompleteCallback = callback;
  }

  /**
   * Register error callback
   */
  onError(callback: (error: Error) => void): void {
    this.onErrorCallback = callback;
  }

  /**
   * Test helper: Simulate track completion
   */
  simulateComplete(): void {
    this._isPlaying = false;
    this._isPaused = false;
    if (this.onCompleteCallback) {
      this.onCompleteCallback();
    }
  }

  /**
   * Test helper: Simulate playback error
   */
  simulateError(error: Error): void {
    this._isPlaying = false;
    this._isPaused = false;
    if (this.onErrorCallback) {
      this.onErrorCallback(error);
    }
  }

  /**
   * Test helper: Set playback position
   */
  setPosition(seconds: number): void {
    this._position = seconds;
  }
}
