import type {
  PlaybackStatus,
  JellyfinItem,
  QueueItem,
  JellyfinQueueItem,
} from "@musicd/shared";
import { PlayerError } from "@musicd/shared";
import type { PlaybackBackend } from "./playback/backend";

export type StreamUrlResolver = (item: QueueItem) => Promise<string>;

export class PlayerService {
  private currentItem: QueueItem | null = null;
  private queue: QueueItem[] = [];
  private queuePosition: number = -1; // -1 means no queue, 0+ is current position
  private streamUrlResolvers: Map<string, StreamUrlResolver> = new Map();
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

  constructor(private backend: PlaybackBackend) {
    // Register for completion events
    this.backend.onComplete(async () => {
      this.cleanup();

      // Auto-advance to next track if available
      if (this.hasNext()) {
        try {
          await this.playNext();
        } catch (error) {
          console.error("Failed to auto-play next song:", error);
        }
      }
    });

    // Register for error events
    this.backend.onError((error) => {
      console.error("Playback error:", error);
      this.cleanup();
    });
  }

  /**
   * Register a stream URL resolver for a source type
   * Each source (jellyfin, youtube, etc.) needs its own resolver
   */
  registerStreamUrlResolver(source: string, resolver: StreamUrlResolver): void {
    this.streamUrlResolvers.set(source, resolver);
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
   * Play a URL (internal method)
   */
  private async playInternal(url: string, item: QueueItem): Promise<void> {
    // Stop any existing playback
    if (this.backend.isPlaying()) {
      await this.stop();
    }

    try {
      // Set current item BEFORE playing (for position reporting)
      this.currentItem = item;

      // Play through backend (no ffplay details here!)
      await this.backend.play(url);

      // Report playback start to Jellyfin (only for Jellyfin items)
      if (this.playbackReporter && item.source === "jellyfin") {
        try {
          this.playSessionId = `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
          await this.playbackReporter.reportStart(item.id, this.playSessionId);

          // Set up progress reporting every 10 seconds
          this.progressInterval = setInterval(async () => {
            if (
              this.currentItem &&
              this.currentItem.source === "jellyfin" &&
              this.playSessionId
            ) {
              const position = this.backend.getPosition();
              const ticks = Math.floor(position * 10000000);
              try {
                await this.playbackReporter!.reportProgress(
                  this.currentItem.id,
                  this.playSessionId,
                  ticks,
                  this.backend.isPaused(),
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
   * Smart play command - context-aware play based on current state
   * - If paused: resumes playback
   * - If already playing: does nothing
   * - If stopped with queue: plays from current queue position
   * - If stopped at invalid position: plays from beginning
   */
  async play(): Promise<void> {
    // If paused, resume
    if (this.backend.isPaused() && this.backend.isPlaying()) {
      this.resume();
      return;
    }

    // If already playing (not paused), do nothing
    if (this.backend.isPlaying()) {
      return;
    }

    // If stopped, start from queue position
    if (this.queue.length === 0) {
      throw new PlayerError("Cannot play: queue is empty");
    }

    // Handle edge cases
    if (this.queuePosition === -1) {
      // No position set, start from beginning
      await this.playFromQueue(0);
    } else if (this.queuePosition >= this.queue.length) {
      // Position beyond queue end, loop to start
      await this.playFromQueue(0);
    } else {
      // Play from current position
      await this.playFromQueue(this.queuePosition);
    }
  }

  /**
   * Add pre-built queue items (source-agnostic)
   */
  addItems(items: QueueItem[], clearQueue: boolean = false): void {
    if (clearQueue) {
      this.queue = [];
      this.queuePosition = -1;
    }

    this.queue.push(...items);
    this.triggerStateSave();
  }

  /**
   * Add Jellyfin items to the queue (convenience method)
   */
  addJellyfinItems(items: JellyfinItem[], clearQueue: boolean = false): void {
    const queueItems: JellyfinQueueItem[] = items.map((item) => ({
      id: item.Id,
      name: item.Name,
      artist: item.Artists?.[0],
      album: item.Album,
      duration: item.RunTimeTicks ? item.RunTimeTicks / 10000000 : 0,
      source: "jellyfin" as const,
      jellyfinItem: item,
    }));

    this.addItems(queueItems, clearQueue);
  }

  /**
   * Play from queue at specific position
   */
  async playFromQueue(position: number): Promise<void> {
    if (position < 0 || position >= this.queue.length) {
      throw new PlayerError("Invalid queue position");
    }

    const item = this.queue[position];
    const resolver = this.streamUrlResolvers.get(item.source);
    if (!resolver) {
      throw new PlayerError(
        `No stream URL resolver registered for source: ${item.source}`,
      );
    }

    this.queuePosition = position;
    this.triggerStateSave();

    const streamUrl = await resolver(item);
    await this.playInternal(streamUrl, item);
  }

  /**
   * Play next song in queue
   * - If at end of queue: stops playback
   * - Otherwise: advances to next track and plays
   */
  async playNext(): Promise<void> {
    // If at end of queue, stop
    if (this.queuePosition >= this.queue.length - 1) {
      if (this.backend.isPlaying()) {
        await this.stop();
      }
      return;
    }

    // Otherwise advance and play
    await this.playFromQueue(this.queuePosition + 1);
  }

  /**
   * Play previous song in queue
   * - If at first track while playing: restarts current track
   * - If at position 0 and stopped: does nothing
   * - Otherwise: goes to previous track
   */
  async playPrevious(): Promise<void> {
    // If at first track and playing, restart current
    if (this.queuePosition === 0 && this.backend.isPlaying()) {
      await this.playFromQueue(0);
      return;
    }

    // If at position 0 and stopped, can't go back
    if (this.queuePosition <= 0) {
      return;
    }

    // Otherwise go to previous track
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
    if (this.backend.isPlaying() || this.backend.isPaused()) {
      this.stop().catch((error) => {
        console.error("Failed to stop playback:", error);
      });
    }
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
    if (index === this.queuePosition && this.backend.isPlaying()) {
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
   * No-op if already paused or not playing
   */
  pause(): void {
    this.backend.pause();
  }

  /**
   * Resume playback
   * - If paused: resumes the paused track
   * - If stopped with a restored queue: starts playback from the saved position
   * - Otherwise: no-op
   */
  async resume(): Promise<void> {
    // If paused, resume via backend
    if (this.backend.isPaused() && this.backend.isPlaying()) {
      this.backend.resume();
      return;
    }

    // If not playing but we have a restored queue, start from saved position
    if (
      !this.backend.isPlaying() &&
      this.queue.length > 0 &&
      this.queuePosition >= 0
    ) {
      await this.play();
      return;
    }

    // Otherwise no-op (nothing to resume, no queue to play from)
  }

  /**
   * Stop playback
   * Preserves queue position for potential resume
   */
  async stop(): Promise<void> {
    if (!this.backend.isPlaying()) {
      return;
    }

    // Report playback stopped before cleanup (only for Jellyfin items)
    if (
      this.playbackReporter &&
      this.currentItem &&
      this.currentItem.source === "jellyfin" &&
      this.playSessionId
    ) {
      try {
        const position = this.backend.getPosition();
        const ticks = Math.floor(position * 10000000);
        await this.playbackReporter.reportStop(
          this.currentItem.id,
          this.playSessionId,
          ticks,
        );
      } catch (error) {
        console.error("Failed to report playback stopped:", error);
      }
    }

    await this.backend.stop();
    this.cleanup();
  }

  /**
   * Get current playback status
   */
  async getStatus(): Promise<PlaybackStatus> {
    if (!this.backend.isPlaying()) {
      return {
        state: "stopped",
        currentItem: null,
        position: 0,
        duration: 0,
        queue: this.queue,
        queuePosition: this.queuePosition,
      };
    }

    const position = this.backend.getPosition();
    const duration = this.currentItem?.duration ?? 0;

    return {
      state: this.backend.isPaused() ? "paused" : "playing",
      currentItem: this.currentItem
        ? {
            id: this.currentItem.id,
            name: this.currentItem.name,
            artist: this.currentItem.artist,
            album: this.currentItem.album,
            source: this.currentItem.source,
          }
        : null,
      position: Math.min(position, duration),
      duration,
      queue: this.queue,
      queuePosition: this.queuePosition,
    };
  }

  /**
   * Check if playback is active
   */
  isPlaying(): boolean {
    return this.backend.isPlaying();
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

    // Report playback stopped if we have an active session (only for Jellyfin items)
    // This handles the case where the process exits naturally
    if (
      this.playbackReporter &&
      this.currentItem &&
      this.currentItem.source === "jellyfin" &&
      this.playSessionId
    ) {
      const position = this.backend.getPosition();
      const ticks = Math.floor(position * 10000000);

      // Fire and forget - don't wait for the report
      this.playbackReporter
        .reportStop(this.currentItem.id, this.playSessionId, ticks)
        .catch((error) => {
          console.error("Failed to report playback stopped in cleanup:", error);
        });
    }

    this.currentItem = null;
    this.playSessionId = null;
  }
}
