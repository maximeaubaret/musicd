import type {
  ActionResponse,
  AuthResponse,
  PlayResponse,
  PlaybackActionResponse,
  QueueAddResponse,
  QueueResponse,
  PlayQueueResponse,
  SearchResponse,
  SearchResult,
  TrackInfo,
  AlbumResponse,
  ArtistResponse,
  QueueOptions,
  PlaybackStatus,
  QueueModeResponse,
  QueueModeStatusResponse,
  QueueMode,
} from "./types";

export type {
  ActionResponse,
  AuthResponse,
  PlayResponse,
  PlaybackActionResponse,
  QueueAddResponse,
  QueueResponse,
  PlayQueueResponse,
  SearchResponse,
  SearchResult,
  TrackInfo,
  AlbumResponse,
  ArtistResponse,
  QueueOptions,
  PlaybackStatus,
  QueueModeResponse,
  QueueModeStatusResponse,
  QueueMode,
};

/**
 * Logger interface for request logging
 */
export interface ClientLogger {
  debug: (...args: unknown[]) => void;
}

/**
 * Options for creating a MusicDaemonClient
 */
export interface ClientOptions {
  /** Optional logger for request debugging */
  logger?: ClientLogger;
  /** Allow sending a daemon password over HTTP to a non-loopback host */
  allowInsecureHttp?: boolean;
}

/** Error raised when a daemon password would be sent without transport security. */
export class InsecureDaemonConnectionError extends Error {
  constructor() {
    super(
      "Refusing to send a daemon password over insecure HTTP. Use HTTPS or explicitly allow insecure HTTP for a trusted network.",
    );
    this.name = "InsecureDaemonConnectionError";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "localhost." ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

/**
 * HTTP client for Jellyfin Music Daemon API
 */
export class MusicDaemonClient {
  private logger?: ClientLogger;
  private allowInsecureHttp: boolean;

  constructor(
    private baseUrl: string,
    private password?: string,
    options?: ClientOptions,
  ) {
    this.logger = options?.logger;
    this.allowInsecureHttp = options?.allowInsecureHttp ?? false;
  }

  /**
   * Set the logger for request debugging
   * Useful when the logger needs to be configured after client construction
   */
  setLogger(logger: ClientLogger): void {
    this.logger = logger;
  }

  /**
   * Make HTTP request to daemon API
   */
  private async request<T>(
    endpoint: string,
    method: "GET" | "POST" = "GET",
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}/api${endpoint}`;

    try {
      const daemonUrl = new URL(this.baseUrl);
      if (
        this.password &&
        daemonUrl.protocol === "http:" &&
        !isLoopbackHostname(daemonUrl.hostname) &&
        !this.allowInsecureHttp
      ) {
        throw new InsecureDaemonConnectionError();
      }

      const headers: Record<string, string> = {};

      // Add Content-Type for POST requests with body
      if (body) {
        headers["Content-Type"] = "application/json";
      }

      // Add Authorization header if password is configured
      if (this.password) {
        headers["Authorization"] = `Bearer ${this.password}`;
      }

      // Log the request
      this.logger?.debug(`${method} ${url}`);
      if (body) {
        this.logger?.debug(`  Body: ${JSON.stringify(body)}`);
      }
      this.logger?.debug(`  Auth: ${this.password ? "Bearer ***" : "none"}`);

      const startTime = performance.now();
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      const data = (await response.json()) as unknown;
      const duration = (performance.now() - startTime).toFixed(0);

      // Log the response
      this.logger?.debug(`  Response: ${response.status} (${duration}ms)`);

      if (!response.ok) {
        // Type guard for error responses
        const errorMessage =
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof data.error === "string"
            ? data.error
            : `Request failed with status ${response.status}`;

        // Special handling for 401 errors
        if (response.status === 401) {
          throw new Error(
            `Authentication failed: ${errorMessage === `Request failed with status ${response.status}` ? "Invalid or missing password" : errorMessage}. ` +
              `Check DAEMON_PASSWORD in your config or environment.`,
          );
        }

        throw new Error(errorMessage);
      }

      return data as T;
    } catch (error) {
      if (error instanceof Error && error.message.includes("fetch failed")) {
        this.logger?.debug(`  Error: Connection failed`);
        throw new Error(
          `Cannot connect to daemon at ${this.baseUrl}. Is it running? Start it with: musicd-server`,
        );
      }
      this.logger?.debug(`  Error: ${error}`);
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
  async pause(): Promise<ActionResponse> {
    return this.request("/pause", "POST");
  }

  /**
   * Resume playback
   */
  async resume(): Promise<ActionResponse> {
    return this.request("/resume", "POST");
  }

  /**
   * Stop playback
   */
  async stop(): Promise<ActionResponse> {
    return this.request("/stop", "POST");
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
  async clearQueue(): Promise<ActionResponse> {
    return this.request("/queue/clear", "POST");
  }

  /**
   * Play next track
   */
  async playNext(): Promise<PlaybackActionResponse> {
    return this.request("/queue/next", "POST");
  }

  /**
   * Play previous track
   */
  async playPrevious(): Promise<PlaybackActionResponse> {
    return this.request("/queue/previous", "POST");
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
   * Toggle loop mode
   */
  async toggleLoop(): Promise<QueueModeResponse> {
    return this.request("/queue/loop", "POST");
  }

  /**
   * Toggle random mode
   */
  async toggleRandom(): Promise<QueueModeResponse> {
    return this.request("/queue/random", "POST");
  }

  /**
   * Explicitly set one or more queue mode settings
   */
  async setQueueMode(mode: Partial<QueueMode>): Promise<QueueModeResponse> {
    try {
      return await this.request("/queue/mode", "POST", mode);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to set queue mode: ${String(error)}`);
    }
  }

  /**
   * Shuffle the queue order
   */
  async shuffleQueue(): Promise<QueueResponse> {
    return this.request("/queue/shuffle", "POST");
  }

  /**
   * Get current queue mode settings
   */
  async getQueueMode(): Promise<QueueModeStatusResponse> {
    return this.request("/queue/mode");
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
