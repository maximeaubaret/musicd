import type { PlaybackBackend } from "./backend";

/**
 * Mock backend for testing
 * Provides instant, synchronous playback simulation
 */
export class MockBackend implements PlaybackBackend {
  private _isPlaying = false;
  private _isPaused = false;
  private _position = 0;
  private terminalEventEmitted = false;
  private onCompleteCallback?: (position: number) => void | Promise<void>;
  private onErrorCallback?: (
    error: Error,
    position: number,
  ) => void | Promise<void>;

  /**
   * Start playing (synchronous, no delays)
   */
  async play(_url: string): Promise<void> {
    this._isPlaying = true;
    this._isPaused = false;
    this._position = 0;
    this.terminalEventEmitted = false;
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
    this.terminalEventEmitted = true;
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
  onComplete(callback: (position: number) => void | Promise<void>): void {
    this.onCompleteCallback = callback;
  }

  /**
   * Register error callback
   */
  onError(
    callback: (error: Error, position: number) => void | Promise<void>,
  ): void {
    this.onErrorCallback = callback;
  }

  /**
   * Test helper: Simulate track completion
   */
  async simulateComplete(): Promise<void> {
    if (!this.claimTerminalEvent()) {
      return;
    }
    if (this.onCompleteCallback) {
      await this.onCompleteCallback(this._position);
    }
  }

  /**
   * Test helper: Simulate playback error
   */
  async simulateError(error: Error): Promise<void> {
    if (!this.claimTerminalEvent()) {
      return;
    }
    if (this.onErrorCallback) {
      await this.onErrorCallback(error, this._position);
    }
  }

  /**
   * Test helper: Set playback position
   */
  setPosition(seconds: number): void {
    this._position = seconds;
  }

  private claimTerminalEvent(): boolean {
    if (this.terminalEventEmitted) {
      return false;
    }
    this.terminalEventEmitted = true;
    this._isPlaying = false;
    this._isPaused = false;
    return true;
  }
}
