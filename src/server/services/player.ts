import { spawn, type ChildProcess } from 'child_process';
import { unlink } from 'fs/promises';
import type { PlaybackStatus, PlayOptions, JellyfinItem } from '../../shared/types.js';
import { PlayerError } from '../../shared/types.js';

export class PlayerService {
  private process: ChildProcess | null = null;
  private currentItem: JellyfinItem | null = null;
  private audioDevice: string;
  private startTime: number = 0;

  constructor(audioDevice: string = 'default') {
    this.audioDevice = audioDevice;
  }

  /**
   * Play a URL with ffplay
   */
  async play(url: string, item: JellyfinItem, options?: PlayOptions): Promise<void> {
    // Stop any existing playback
    if (this.isPlaying()) {
      await this.stop();
    }

    const device = options?.audioDevice || this.audioDevice;

    try {
      // Spawn ffplay process
      const args = [
        '-nodisp',        // No video display
        '-autoexit',      // Exit when playback finishes
        '-loglevel', 'quiet',  // Suppress output
        url,
      ];

      this.process = spawn('ffplay', args);
      this.currentItem = item;
      this.startTime = Date.now();

      // Handle process events
      this.process.on('error', (error) => {
        console.error('ffplay process error:', error);
        this.cleanup();
      });

      this.process.on('exit', (code) => {
        console.log(`ffplay exited with code ${code}`);
        this.cleanup();
      });

      // Wait a bit to ensure ffplay has started
      await new Promise((resolve) => setTimeout(resolve, 500));

      if (!this.process || this.process.exitCode !== null) {
        throw new PlayerError('Failed to start ffplay process');
      }
    } catch (error) {
      this.cleanup();
      throw new PlayerError(`Failed to play: ${error}`);
    }
  }

  /**
   * Stop playback
   */
  async stop(): Promise<void> {
    if (!this.process) {
      throw new PlayerError('No playback in progress');
    }

    try {
      this.process.kill('SIGTERM');
      
      // Wait for process to exit
      await new Promise((resolve) => {
        if (this.process) {
          this.process.on('exit', resolve);
          // Timeout after 2 seconds
          setTimeout(() => {
            if (this.process) {
              this.process.kill('SIGKILL');
            }
            resolve(null);
          }, 2000);
        } else {
          resolve(null);
        }
      });
    } finally {
      this.cleanup();
    }
  }

  /**
   * Get current playback status
   */
  async getStatus(): Promise<PlaybackStatus> {
    if (!this.isPlaying()) {
      return {
        state: 'stopped',
        currentItem: null,
        position: 0,
        duration: 0,
      };
    }

    // Calculate approximate position based on elapsed time
    const elapsed = (Date.now() - this.startTime) / 1000; // seconds
    const duration = this.currentItem?.RunTimeTicks
      ? this.currentItem.RunTimeTicks / 10000000 // Convert ticks to seconds
      : 0;

    return {
      state: 'playing',
      currentItem: this.currentItem
        ? {
            id: this.currentItem.Id,
            name: this.currentItem.Name,
            artist: this.currentItem.Artists?.[0],
            album: this.currentItem.Album,
          }
        : null,
      position: Math.min(elapsed, duration),
      duration,
    };
  }

  /**
   * Check if playback is active
   */
  isPlaying(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    this.process = null;
    this.currentItem = null;
    this.startTime = 0;
  }
}
