import { PlayerError } from "@musicd/shared";

import type { PlaybackStatus, QueueItem, QueueMode } from "@musicd/shared";
import type { PlaybackBackend, PlaybackSource } from "./playback/backend";

export type PlaybackSourceResolver = (
  item: QueueItem,
) => Promise<PlaybackSource>;

interface PlaybackReporter {
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
}

interface PlaybackSession {
  itemId: string;
  sessionId: string;
  reporter: PlaybackReporter;
  startPromise: Promise<void>;
}

export class PlayerService {
  private currentItem: QueueItem | null = null;
  private queue: QueueItem[] = [];
  private queuePosition: number = -1; // -1 means no queue, 0+ is current position
  private playbackSourceResolvers: Map<string, PlaybackSourceResolver> =
    new Map();
  private playbackSession: PlaybackSession | null = null;
  private playbackSessionSequence: number = 0;
  private playbackGeneration: number = 0;
  private progressInterval: NodeJS.Timeout | null = null;
  private playbackReporter: PlaybackReporter | null = null;
  private stateSaveEnabled: boolean = false;
  private queueMode: QueueMode = { loop: false, random: false };
  private stateSaveCallback: (() => void) | null = null;

  constructor(private backend: PlaybackBackend) {
    // Register for completion events
    this.backend.onComplete(async (position) => {
      const completedGeneration = this.playbackGeneration;
      const closeSessionPromise = this.closePlaybackSession(position);
      this.cleanupPlaybackState();
      await closeSessionPromise;

      if (this.playbackGeneration !== completedGeneration) {
        return;
      }

      // Auto-advance to next track based on queue mode
      if (this.hasNext() || this.queueMode.loop || this.queueMode.random) {
        try {
          await this.playNext();
        } catch (error) {
          console.error("Failed to auto-play next song:", error);
        }
      }
    });

    // Register for error events
    this.backend.onError(async (error, position) => {
      console.error("Playback error:", error);
      const closeSessionPromise = this.closePlaybackSession(position);
      this.cleanupPlaybackState();
      await closeSessionPromise;
    });
  }

  /**
   * Register a playback source resolver for a source type
   * Each source (jellyfin, youtube, etc.) needs its own resolver
   */
  registerPlaybackSourceResolver(
    source: string,
    resolver: PlaybackSourceResolver,
  ): void {
    this.playbackSourceResolvers.set(source, resolver);
  }

  /**
   * Set the playback reporter for Jellyfin play tracking
   * This enables play count tracking and scrobbling
   */
  setPlaybackReporter(reporter: PlaybackReporter): void {
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
  getQueueState(): {
    queue: QueueItem[];
    position: number;
    queueMode: QueueMode;
    volume: number;
  } {
    return {
      queue: [...this.queue],
      position: this.queuePosition,
      queueMode: { ...this.queueMode },
      volume: this.backend.getVolume?.() ?? 100,
    };
  }

  /**
   * Restore queue state (does NOT start playback)
   */
  restoreQueueState(state: {
    queue: QueueItem[];
    position: number;
    queueMode?: QueueMode;
    volume?: number;
  }): void {
    this.queue = [...state.queue];
    this.queuePosition = state.position;
    if (state.queueMode) {
      this.queueMode = { ...state.queueMode };
    }
    if (state.volume !== undefined && this.backend.setVolume) {
      this.backend.setVolume(state.volume);
    }
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
   * Play a resolved stream (internal method)
   */
  private async playInternal(
    source: PlaybackSource,
    item: QueueItem,
  ): Promise<void> {
    // Stop any existing playback
    if (this.backend.isPlaying()) {
      await this.stop();
    }

    let generation = this.playbackGeneration;
    try {
      // Set current item BEFORE playing (for position reporting)
      this.currentItem = item;
      generation = ++this.playbackGeneration;

      // Play through backend (no ffplay details here!)
      await this.backend.play(source);
      if (
        this.playbackGeneration !== generation ||
        this.currentItem !== item ||
        !this.backend.isPlaying()
      ) {
        return;
      }

      // Report playback start to Jellyfin (only for Jellyfin items)
      if (this.playbackReporter && item.source === "jellyfin") {
        const reporter = this.playbackReporter;
        const sessionId = `session-${Date.now()}-${++this.playbackSessionSequence}`;
        const startPromise = this.reportPlaybackStart(
          reporter,
          item.id,
          sessionId,
        );
        const session: PlaybackSession = {
          itemId: item.id,
          sessionId,
          reporter,
          startPromise,
        };
        this.playbackSession = session;

        try {
          await startPromise;

          // Set up progress reporting every 10 seconds
          if (this.playbackSession !== session) {
            return;
          }
          this.progressInterval = setInterval(async () => {
            if (this.playbackSession === session) {
              const position = this.backend.getPosition();
              const ticks = Math.floor(position * 10000000);
              try {
                await session.reporter.reportProgress(
                  session.itemId,
                  session.sessionId,
                  ticks,
                  this.backend.isPaused(),
                );
              } catch (error) {
                console.error("Failed to report playback progress:", error);
              }
            }
          }, 10000);
        } catch (error) {
          if (this.playbackSession === session) {
            this.playbackSession = null;
          }
          console.error("Failed to report playback start:", error);
        }
      }
    } catch (error) {
      if (this.playbackGeneration === generation && this.currentItem === item) {
        this.cleanupPlaybackState();
      }
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
   * @returns The queue position of the first newly added item
   */
  addItems(items: QueueItem[], clearQueue: boolean = false): number {
    if (clearQueue) {
      this.queue = [];
      this.queuePosition = -1;
    }

    const firstAddedPosition = this.queue.length;
    this.queue.push(...items);
    this.triggerStateSave();
    return firstAddedPosition;
  }

  /**
   * Play from queue at specific position
   */
  async playFromQueue(position: number): Promise<void> {
    if (position < 0 || position >= this.queue.length) {
      throw new PlayerError("Invalid queue position");
    }

    const item = this.queue[position];
    const resolver = this.playbackSourceResolvers.get(item.source);
    if (!resolver) {
      throw new PlayerError(
        `No playback source resolver registered for source: ${item.source}`,
      );
    }

    this.queuePosition = position;
    this.triggerStateSave();

    const source = await resolver(item);
    await this.playInternal(source, item);
  }

  /**
   * Seek within the currently playing track.
   * ffplay cannot reposition a live stream, so this restarts playback at the
   * requested offset; playInternal's manual stop keeps the swap from looking
   * like a natural completion, so the queue does not advance. Seeking while
   * paused resumes playback at the new position.
   */
  async seek(positionSeconds: number): Promise<void> {
    const item = this.currentItem;
    if (!item || !this.backend.isPlaying()) {
      throw new PlayerError("Nothing is playing");
    }

    // Backends with native seeking (mpv) reposition in place — no restart,
    // no audio gap, pause state preserved.
    if (this.backend.seek) {
      await this.backend.seek(Math.max(0, positionSeconds));
      return;
    }

    const resolver = this.playbackSourceResolvers.get(item.source);
    if (!resolver) {
      throw new PlayerError(
        `No playback source resolver registered for source: ${item.source}`,
      );
    }

    const source = await resolver(item);
    await this.playInternal(
      { ...source, startPosition: Math.max(0, positionSeconds) },
      item,
    );
  }

  /**
   * Read the backend's native per-stream volume.
   */
  getVolume(): number {
    if (!this.backend.getVolume) {
      throw new PlayerError(
        "Volume control is unavailable for the configured audio backend",
      );
    }
    return this.backend.getVolume();
  }

  /**
   * Set native per-stream volume and persist it with daemon state.
   */
  setVolume(volumePercent: number): number {
    if (
      !Number.isFinite(volumePercent) ||
      volumePercent < 0 ||
      volumePercent > 100
    ) {
      throw new PlayerError("Volume must be between 0 and 100");
    }
    if (!this.backend.setVolume || !this.backend.getVolume) {
      throw new PlayerError(
        "Volume control is unavailable for the configured audio backend",
      );
    }
    this.backend.setVolume(volumePercent);
    this.triggerStateSave();
    return this.backend.getVolume();
  }

  /**
   * Play next song in queue
   * Respects queue mode settings:
   * - random: picks a random track from the queue
   * - loop: wraps to beginning when reaching end
   * - If neither and at end of queue: stops playback
   */
  async playNext(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }

    // Random mode: pick a random track (different from current if possible)
    if (this.queueMode.random) {
      let nextPosition: number;
      if (this.queue.length === 1) {
        nextPosition = 0;
      } else if (
        this.queuePosition >= 0 &&
        this.queuePosition < this.queue.length
      ) {
        const randomPosition = Math.floor(
          Math.random() * (this.queue.length - 1),
        );
        nextPosition =
          randomPosition >= this.queuePosition
            ? randomPosition + 1
            : randomPosition;
      } else {
        nextPosition = Math.floor(Math.random() * this.queue.length);
      }
      await this.playFromQueue(nextPosition);
      return;
    }

    // Sequential mode: check if at end of queue
    if (this.queuePosition >= this.queue.length - 1) {
      // Loop mode: wrap to beginning
      if (this.queueMode.loop) {
        await this.playFromQueue(0);
        return;
      }
      // No loop: stop playback
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
   * Get current queue mode
   */
  getQueueMode(): QueueMode {
    return { ...this.queueMode };
  }

  /**
   * Set queue mode settings
   */
  setQueueMode(mode: Partial<QueueMode>): void {
    if (mode.loop !== undefined) {
      this.queueMode.loop = mode.loop;
    }
    if (mode.random !== undefined) {
      this.queueMode.random = mode.random;
    }
    this.triggerStateSave();
  }

  /**
   * Toggle loop mode on/off
   * @returns The new loop state
   */
  toggleLoop(): boolean {
    this.queueMode.loop = !this.queueMode.loop;
    this.triggerStateSave();
    return this.queueMode.loop;
  }

  /**
   * Toggle random mode on/off
   * @returns The new random state
   */
  toggleRandom(): boolean {
    this.queueMode.random = !this.queueMode.random;
    this.triggerStateSave();
    return this.queueMode.random;
  }

  /**
   * Shuffle the queue order randomly.
   * The current track stays in place if playing, but the rest are shuffled.
   */
  shuffleQueue(): void {
    if (this.queue.length <= 1) {
      return;
    }

    // If currently playing, keep the current track in place
    if (this.backend.isPlaying() && this.queuePosition >= 0) {
      const currentItem = this.queue[this.queuePosition];
      const otherItems = this.queue.filter((_, i) => i !== this.queuePosition);

      // Fisher-Yates shuffle for the other items
      for (let i = otherItems.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [otherItems[i], otherItems[j]] = [otherItems[j], otherItems[i]];
      }

      // Reconstruct the queue around the unchanged active position.
      this.queue = otherItems;
      this.queue.splice(this.queuePosition, 0, currentItem);
    } else {
      // Not playing: shuffle entire queue
      for (let i = this.queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
      }
      // Reset position to beginning
      this.queuePosition = this.queue.length > 0 ? 0 : -1;
    }

    this.triggerStateSave();
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

    const position = this.backend.getPosition();
    const closeSessionPromise = this.closePlaybackSession(position);
    await this.backend.stop();
    this.cleanupPlaybackState();
    await closeSessionPromise;
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
        queueMode: { ...this.queueMode },
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
      queueMode: { ...this.queueMode },
    };
  }

  /**
   * Check if playback is active
   */
  isPlaying(): boolean {
    return this.backend.isPlaying();
  }

  private clearProgressInterval(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }

  private async reportPlaybackStart(
    reporter: PlaybackReporter,
    itemId: string,
    sessionId: string,
  ): Promise<void> {
    // Let the caller install the session before reporting can trigger callbacks.
    await Promise.resolve();
    await reporter.reportStart(itemId, sessionId);
  }

  private async closePlaybackSession(position: number): Promise<void> {
    const session = this.playbackSession;
    this.playbackSession = null;
    this.clearProgressInterval();

    if (!session) {
      return;
    }

    try {
      await session.startPromise;
    } catch {
      return;
    }

    try {
      const ticks = Math.floor(position * 10000000);
      await session.reporter.reportStop(
        session.itemId,
        session.sessionId,
        ticks,
      );
    } catch (error) {
      console.error("Failed to report playback stopped:", error);
    }
  }

  /**
   * Clean up resources after the active session has been closed
   */
  private cleanupPlaybackState(): void {
    this.clearProgressInterval();
    this.currentItem = null;
  }
}
