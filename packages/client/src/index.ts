import type {
  AuthResponse,
  PlayResponse,
  QueueAddResponse,
  QueueResponse,
  PlayQueueResponse,
  SearchResponse,
  AlbumResponse,
  ArtistResponse,
  QueueOptions,
  PlaybackStatus,
} from "./types.js";

export type {
  AuthResponse,
  PlayResponse,
  QueueAddResponse,
  QueueResponse,
  PlayQueueResponse,
  SearchResponse,
  AlbumResponse,
  ArtistResponse,
  QueueOptions,
  PlaybackStatus,
};

/**
 * HTTP client for Jellyfin Music Daemon API
 */
export class MusicDaemonClient {
  constructor(private baseUrl: string) {}

  /**
   * Make HTTP request to daemon API
   */
  private async request<T>(
    endpoint: string,
    method: "GET" | "POST" = "GET",
    body?: any,
  ): Promise<T> {
    try {
      const response = await fetch(`${this.baseUrl}/api${endpoint}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });

      const data = (await response.json()) as any;

      if (!response.ok) {
        throw new Error(
          data.error || `Request failed with status ${response.status}`,
        );
      }

      return data as T;
    } catch (error) {
      if (error instanceof Error && error.message.includes("fetch failed")) {
        throw new Error(
          `Cannot connect to daemon at ${this.baseUrl}. Is it running? Start it with: bun run dev`,
        );
      }
      throw error;
    }
  }

  /**
   * Authenticate with Jellyfin server
   */
  async authenticate(
    username: string,
    password: string,
  ): Promise<AuthResponse> {
    return this.request("/auth", "POST", { username, password });
  }

  /**
   * Search for music items
   */
  async search(query: string, limit = 20): Promise<SearchResponse> {
    return this.request(
      `/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
  }

  /**
   * Play a Jellyfin item
   */
  async play(itemId: string): Promise<PlayResponse> {
    return this.request("/play", "POST", { itemId });
  }

  /**
   * Pause playback
   */
  async pause(): Promise<void> {
    await this.request("/pause", "POST");
  }

  /**
   * Resume playback
   */
  async resume(): Promise<void> {
    await this.request("/resume", "POST");
  }

  /**
   * Stop playback
   */
  async stop(): Promise<void> {
    await this.request("/stop", "POST");
  }

  /**
   * Get playback status
   */
  async status(): Promise<PlaybackStatus> {
    return this.request("/status");
  }

  /**
   * Add items to queue
   */
  async addToQueue(
    itemIds: string[],
    options?: QueueOptions,
  ): Promise<QueueAddResponse> {
    return this.request("/queue/add", "POST", {
      itemIds,
      clearQueue: options?.clearQueue,
      playNow: options?.playNow,
    });
  }

  /**
   * Get current queue
   */
  async getQueue(): Promise<QueueResponse> {
    return this.request("/queue");
  }

  /**
   * Clear the queue
   */
  async clearQueue(): Promise<void> {
    await this.request("/queue/clear", "POST");
  }

  /**
   * Play next track
   */
  async playNext(): Promise<void> {
    await this.request("/queue/next", "POST");
  }

  /**
   * Play previous track
   */
  async playPrevious(): Promise<void> {
    await this.request("/queue/previous", "POST");
  }

  /**
   * Play track from queue at specific index
   */
  async playFromQueue(index: number): Promise<PlayQueueResponse> {
    return this.request(`/queue/play/${index}`, "POST");
  }

  /**
   * Remove track from queue at specific index
   */
  async removeFromQueue(index: number): Promise<QueueResponse> {
    return this.request(`/queue/remove/${index}`, "POST");
  }

  /**
   * Get album details with tracks
   */
  async getAlbum(albumId: string): Promise<AlbumResponse> {
    return this.request(`/album/${albumId}`);
  }

  /**
   * Get artist details with tracks
   */
  async getArtist(artistId: string): Promise<ArtistResponse> {
    return this.request(`/artist/${artistId}`);
  }
}
