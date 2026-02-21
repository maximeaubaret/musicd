import { spawn, type ChildProcess } from "child_process";
import { unlink } from "fs/promises";
import type {
  PlaybackStatus,
  PlayOptions,
  JellyfinItem,
  QueueItem,
} from "../../shared/types.js";
import { PlayerError } from "../../shared/types.js";

export class PlayerService {
  private process: ChildProcess | null = null;
  private currentItem: JellyfinItem | null = null;
  private audioDevice: string;
  private startTime: number = 0;
  private queue: QueueItem[] = [];
  private queuePosition: number = -1; // -1 means no queue, 0+ is current position
  private streamUrlGetter: ((itemId: string) => Promise<string>) | null = null;

  constructor(audioDevice: string = "default") {
    this.audioDevice = audioDevice;
  }

  /**
   * Set the callback to get stream URLs
   * This is needed to auto-play next song in queue
   */
  setStreamUrlGetter(getter: (itemId: string) => Promise<string>): void {
    this.streamUrlGetter = getter;
  }

  /**
   * Play a URL with ffplay
   */
  async play(
    url: string,
    item: JellyfinItem,
    options?: PlayOptions,
  ): Promise<void> {
    // Stop any existing playback (this removes all listeners)
    if (this.isPlaying()) {
      await this.stop();
    }

    const device = options?.audioDevice || this.audioDevice;

    try {
      // Spawn ffplay process
      const args = [
        "-nodisp", // No video display
        "-autoexit", // Exit when playback finishes
        "-loglevel",
        "quiet", // Suppress output
        url,
      ];

      this.process = spawn("ffplay", args);
      this.currentItem = item;
      this.startTime = Date.now();

      // Handle process events
      this.process.on("error", (error) => {
        console.error("ffplay process error:", error);
        this.cleanup();
      });

      this.process.on("exit", async (code) => {
        console.log(`ffplay exited with code ${code}`);
        this.cleanup();

        // Auto-play next song in queue if available
        if (this.hasNext()) {
          try {
            await this.playNext();
          } catch (error) {
            console.error("Failed to auto-play next song:", error);
          }
        }
      });

      // Wait a bit to ensure ffplay has started
      await new Promise((resolve) => setTimeout(resolve, 500));

      if (!this.process || this.process.exitCode !== null) {
        throw new PlayerError("Failed to start ffplay process");
      }
    } catch (error) {
      this.cleanup();
      throw new PlayerError(`Failed to play: ${error}`);
    }
  }

  /**
   * Add items to the queue
   */
  addToQueue(items: JellyfinItem[], clearQueue: boolean = false): void {
    if (clearQueue) {
      this.queue = [];
      this.queuePosition = -1;
    }

    const queueItems: QueueItem[] = items.map((item) => ({
      id: item.Id,
      name: item.Name,
      artist: item.Artists?.[0],
      album: item.Album,
      duration: item.RunTimeTicks ? item.RunTimeTicks / 10000000 : 0,
      jellyfinItem: item,
    }));

    this.queue.push(...queueItems);
  }

  /**
   * Play from queue at specific position
   */
  async playFromQueue(position: number): Promise<void> {
    if (position < 0 || position >= this.queue.length) {
      throw new PlayerError("Invalid queue position");
    }

    if (!this.streamUrlGetter) {
      throw new PlayerError("Stream URL getter not configured");
    }

    this.queuePosition = position;
    const item = this.queue[position];

    const streamUrl = await this.streamUrlGetter(item.id);
    await this.play(streamUrl, item.jellyfinItem);
  }

  /**
   * Play next song in queue
   */
  async playNext(): Promise<void> {
    if (!this.hasNext()) {
      throw new PlayerError("No next song in queue");
    }

    await this.playFromQueue(this.queuePosition + 1);
  }

  /**
   * Play previous song in queue
   */
  async playPrevious(): Promise<void> {
    if (!this.hasPrevious()) {
      throw new PlayerError("No previous song in queue");
    }

    await this.playFromQueue(this.queuePosition - 1);
  }

  /**
   * Check if there's a next song in queue
   */
  hasNext(): boolean {
    return this.queue.length > 0 && this.queuePosition < this.queue.length - 1;
  }

  /**
   * Check if there's a previous song in queue
   */
  hasPrevious(): boolean {
    return this.queuePosition > 0;
  }

  /**
   * Clear the queue
   */
  clearQueue(): void {
    this.queue = [];
    this.queuePosition = -1;
  }

  /**
   * Get current queue
   */
  getQueue(): QueueItem[] {
    return [...this.queue];
  }

  /**
   * Get current queue position
   */
  getQueuePosition(): number {
    return this.queuePosition;
  }

  /**
   * Stop playback
   */
  async stop(): Promise<void> {
    if (!this.process) {
      throw new PlayerError("No playback in progress");
    }

    const processToStop = this.process;

    try {
      // Remove all listeners to prevent exit handler from running
      processToStop.removeAllListeners();

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

  /**
   * Get current playback status
   */
  async getStatus(): Promise<PlaybackStatus> {
    if (!this.isPlaying()) {
      return {
        state: "stopped",
        currentItem: null,
        position: 0,
        duration: 0,
        queue: this.queue,
        queuePosition: this.queuePosition,
      };
    }

    // Calculate approximate position based on elapsed time
    const elapsed = (Date.now() - this.startTime) / 1000; // seconds
    const duration = this.currentItem?.RunTimeTicks
      ? this.currentItem.RunTimeTicks / 10000000 // Convert ticks to seconds
      : 0;

    return {
      state: "playing",
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
      queue: this.queue,
      queuePosition: this.queuePosition,
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
