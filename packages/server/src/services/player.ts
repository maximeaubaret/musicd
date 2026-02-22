import { spawn, type ChildProcess } from "child_process";
import type { PlaybackStatus, JellyfinItem, QueueItem } from "@musicd/shared";
import { PlayerError } from "@musicd/shared";

export class PlayerService {
  private process: ChildProcess | null = null;
  private currentItem: JellyfinItem | null = null;
  private audioDevice: string;
  private startTime: number = 0;
  private pausedAt: number = 0; // Time when paused (in seconds)
  private isPaused: boolean = false;
  private queue: QueueItem[] = [];
  private queuePosition: number = -1; // -1 means no queue, 0+ is current position
  private streamUrlGetter: ((itemId: string) => Promise<string>) | null = null;
  private playSessionId: string | null = null;
  private progressInterval: NodeJS.Timeout | null = null;
  private playbackReporter: {
    reportStart: (itemId: string, sessionId: string) => Promise<void>;
    reportProgress: (
      itemId: string,
      sessionId: string,
      ticks: number,
      paused: boolean,
    ) => Promise<void>;
    reportStop: (
      itemId: string,
      sessionId: string,
      ticks: number,
    ) => Promise<void>;
  } | null = null;
  private stateSaveEnabled: boolean = false;
  private stateSaveCallback: (() => void) | null = null;

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
   * Set the playback reporter for Jellyfin play tracking
   * This enables play count tracking and scrobbling
   */
  setPlaybackReporter(reporter: {
    reportStart: (itemId: string, sessionId: string) => Promise<void>;
    reportProgress: (
      itemId: string,
      sessionId: string,
      ticks: number,
      paused: boolean,
    ) => Promise<void>;
    reportStop: (
      itemId: string,
      sessionId: string,
      ticks: number,
    ) => Promise<void>;
  }): void {
    this.playbackReporter = reporter;
  }

  /**
   * Enable queue state persistence
   * @param callback Function to call when state should be saved
   */
  enableStatePersistence(callback: () => void): void {
    this.stateSaveEnabled = true;
    this.stateSaveCallback = callback;
  }

  /**
   * Get current queue state for persistence
   */
  getQueueState(): { queue: QueueItem[]; position: number } {
    return {
      queue: [...this.queue],
      position: this.queuePosition,
    };
  }

  /**
   * Restore queue state (does NOT start playback)
   */
  restoreQueueState(state: { queue: QueueItem[]; position: number }): void {
    this.queue = [...state.queue];
    this.queuePosition = state.position;
  }

  /**
   * Trigger state save if enabled
   */
  private triggerStateSave(): void {
    if (this.stateSaveEnabled && this.stateSaveCallback) {
      this.stateSaveCallback();
    }
  }

  /**
   * Play a URL with ffplay
   */
  async play(url: string, item: JellyfinItem): Promise<void> {
    // Stop any existing playback (this removes all listeners)
    if (this.isPlaying()) {
      await this.stop();
    }

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

      // Report playback start to Jellyfin
      if (this.playbackReporter) {
        try {
          this.playSessionId = `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
          await this.playbackReporter.reportStart(item.Id, this.playSessionId);

          // Set up progress reporting every 10 seconds
          this.progressInterval = setInterval(async () => {
            if (this.currentItem && this.playSessionId) {
              const elapsed = this.isPaused
                ? this.pausedAt
                : (Date.now() - this.startTime) / 1000;
              const ticks = Math.floor(elapsed * 10000000);
              try {
                await this.playbackReporter!.reportProgress(
                  this.currentItem.Id,
                  this.playSessionId,
                  ticks,
                  this.isPaused,
                );
              } catch (error) {
                console.error("Failed to report playback progress:", error);
              }
            }
          }, 10000);
        } catch (error) {
          console.error("Failed to report playback start:", error);
        }
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
    this.triggerStateSave();
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
    this.triggerStateSave();
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
    this.triggerStateSave();
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
   * Remove an item from the queue by index
   */
  removeFromQueue(index: number): void {
    if (index < 0 || index >= this.queue.length) {
      throw new PlayerError("Invalid queue index");
    }

    // If removing the currently playing track, stop playback
    if (index === this.queuePosition && this.isPlaying()) {
      this.stop().catch((error) => {
        console.error("Failed to stop playback:", error);
      });
    }

    // Remove the item
    this.queue.splice(index, 1);

    // Adjust queue position if necessary
    if (this.queuePosition >= index && this.queuePosition > 0) {
      this.queuePosition--;
    }

    // If queue is now empty, reset position
    if (this.queue.length === 0) {
      this.queuePosition = -1;
    }

    this.triggerStateSave();
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (!this.process || this.process.exitCode !== null) {
      throw new PlayerError("No playback in progress");
    }

    if (this.isPaused) {
      throw new PlayerError("Playback is already paused");
    }

    // Calculate current position
    const elapsed = (Date.now() - this.startTime) / 1000;
    this.pausedAt = elapsed;
    this.isPaused = true;

    // Send SIGSTOP to pause the process
    this.process.kill("SIGSTOP");
  }

  /**
   * Resume playback
   */
  resume(): void {
    if (!this.process || this.process.exitCode !== null) {
      throw new PlayerError("No playback in progress");
    }

    if (!this.isPaused) {
      throw new PlayerError("Playback is not paused");
    }

    this.isPaused = false;
    // Adjust start time to account for pause duration
    this.startTime = Date.now() - this.pausedAt * 1000;

    // Send SIGCONT to resume the process
    this.process.kill("SIGCONT");
  }

  /**
   * Stop playback
   */
  async stop(): Promise<void> {
    if (!this.process) {
      throw new PlayerError("No playback in progress");
    }

    const processToStop = this.process;

    // Report playback stopped before cleanup
    if (this.playbackReporter && this.currentItem && this.playSessionId) {
      try {
        const elapsed = this.isPaused
          ? this.pausedAt
          : (Date.now() - this.startTime) / 1000;
        const ticks = Math.floor(elapsed * 10000000);
        await this.playbackReporter.reportStop(
          this.currentItem.Id,
          this.playSessionId,
          ticks,
        );
      } catch (error) {
        console.error("Failed to report playback stopped:", error);
      }
    }

    try {
      // Remove all listeners to prevent exit handler from running
      processToStop.removeAllListeners();

      // If paused, resume first so we can terminate cleanly
      if (this.isPaused) {
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
    const elapsed = this.isPaused
      ? this.pausedAt
      : (Date.now() - this.startTime) / 1000; // seconds
    const duration = this.currentItem?.RunTimeTicks
      ? this.currentItem.RunTimeTicks / 10000000 // Convert ticks to seconds
      : 0;

    return {
      state: this.isPaused ? "paused" : "playing",
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
    // Clear progress reporting interval
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }

    // Report playback stopped if we have an active session
    // This handles the case where the process exits naturally
    if (this.playbackReporter && this.currentItem && this.playSessionId) {
      const elapsed = this.isPaused
        ? this.pausedAt
        : (Date.now() - this.startTime) / 1000;
      const ticks = Math.floor(elapsed * 10000000);

      // Fire and forget - don't wait for the report
      this.playbackReporter
        .reportStop(this.currentItem.Id, this.playSessionId, ticks)
        .catch((error) => {
          console.error("Failed to report playback stopped in cleanup:", error);
        });
    }

    this.process = null;
    this.currentItem = null;
    this.playSessionId = null;
    this.startTime = 0;
    this.pausedAt = 0;
    this.isPaused = false;
  }
}
