import type { ZodError, ZodType } from "zod";

import { isCredentialKey } from "@musicd/shared";

import {
  ActionResponseSchema,
  AlbumResponseSchema,
  ArtistResponseSchema,
  AuthResponseSchema,
  DaemonErrorResponseSchema,
  PlaybackActionResponseSchema,
  PlaybackStatusSchema,
  PlayQueueResponseSchema,
  PlayResponseSchema,
  QueueAddResponseSchema,
  QueueModeResponseSchema,
  QueueModeStatusResponseSchema,
  QueueResponseSchema,
  QueueShuffleResponseSchema,
  QueueUpdateResponseSchema,
  SearchResponseSchema,
} from "./response-contracts";

import type {
  ActionResponse,
  AuthResponse,
  PlayResponse,
  PlaybackActionResponse,
  QueueAddResponse,
  QueueResponse,
  QueueUpdateResponse,
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
  QueueUpdateResponse,
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
  /** Allow sending credentials over HTTP to a non-loopback host */
  allowInsecureHttp?: boolean;
}

/** Error raised when credentials would be sent without transport security. */
export class InsecureDaemonConnectionError extends Error {
  constructor() {
    super(
      "Refusing to send credentials over insecure HTTP. Use HTTPS or explicitly allow insecure HTTP for a trusted network.",
    );
    this.name = "InsecureDaemonConnectionError";
  }
}

/** Base error for failures reported by the daemon client. */
export class DaemonClientError extends Error {
  constructor(
    message: string,
    public endpoint: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "DaemonClientError";
  }
}

/** Error raised when a daemon response does not match its endpoint contract. */
export class DaemonResponseError extends DaemonClientError {
  constructor(message: string, endpoint: string, statusCode: number) {
    super(message, endpoint, statusCode);
    this.name = "DaemonResponseError";
  }
}

/** Error returned by a daemon after a valid request reaches the API. */
export class DaemonRequestError extends DaemonClientError {
  constructor(message: string, endpoint: string, statusCode: number) {
    super(message, endpoint, statusCode);
    this.name = "DaemonRequestError";
  }
}

function describeValidationFailure(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "response";
      return `${path}: invalid value`;
    })
    .join(", ");
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "localhost." ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function serializeLogBody(body: unknown): string {
  return JSON.stringify(body, (key, value) => {
    return isCredentialKey(key) ? "***" : value;
  });
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
    responseSchema: ZodType<T>,
    method: "GET" | "POST" = "GET",
    body?: unknown,
    containsCredentials: boolean = false,
  ): Promise<T> {
    const url = `${this.baseUrl}/api${endpoint}`;
    const requestTarget = `${method} /api${endpoint}`;

    try {
      const daemonUrl = new URL(this.baseUrl);
      if (
        (this.password || containsCredentials) &&
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
        this.logger?.debug(`  Body: ${serializeLogBody(body)}`);
      }
      this.logger?.debug(`  Auth: ${this.password ? "Bearer ***" : "none"}`);

      const startTime = performance.now();
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      const duration = (performance.now() - startTime).toFixed(0);

      // Log the response
      this.logger?.debug(`  Response: ${response.status} (${duration}ms)`);

      let data: unknown;
      try {
        data = (await response.json()) as unknown;
      } catch {
        const responseKind = response.ok ? "success" : "error";
        throw new DaemonResponseError(
          `Invalid daemon ${responseKind} response for ${requestTarget}: response: invalid JSON`,
          requestTarget,
          response.status,
        );
      }

      if (!response.ok) {
        const errorResult = DaemonErrorResponseSchema.safeParse(data);
        if (!errorResult.success) {
          throw new DaemonResponseError(
            `Invalid daemon error response for ${requestTarget}: ${describeValidationFailure(errorResult.error)}`,
            requestTarget,
            response.status,
          );
        }
        const errorMessage = errorResult.data.error;

        // Special handling for 401 errors
        if (response.status === 401) {
          throw new DaemonRequestError(
            `Authentication failed: ${errorMessage}. Check DAEMON_PASSWORD in your config or environment.`,
            requestTarget,
            response.status,
          );
        }

        throw new DaemonRequestError(
          errorMessage,
          requestTarget,
          response.status,
        );
      }

      const result = responseSchema.safeParse(data);
      if (!result.success) {
        throw new DaemonResponseError(
          `Invalid daemon success response for ${requestTarget}: ${describeValidationFailure(result.error)}`,
          requestTarget,
          response.status,
        );
      }
      return result.data;
    } catch (error) {
      if (error instanceof Error && error.message.includes("fetch failed")) {
        this.logger?.debug(`  Error: Connection failed`);
        throw new Error(
          `Cannot connect to daemon at ${this.baseUrl}. Is it running? Start it with: musicd-server`,
        );
      }
      this.logger?.debug(
        `  Error: ${error instanceof Error ? error.name : "UnknownError"}`,
      );
      throw error;
    }
  }

  /**
   * Authenticate with Jellyfin server
   */
  async authenticate(
    username: string,
    password: string,
    serverUrl?: string,
  ): Promise<AuthResponse> {
    return this.request(
      "/auth",
      AuthResponseSchema,
      "POST",
      serverUrl ? { serverUrl, username, password } : { username, password },
      true,
    );
  }

  /**
   * Search for music items
   */
  async search(query: string, limit = 20): Promise<SearchResponse> {
    return this.request(
      `/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      SearchResponseSchema,
    );
  }

  /**
   * Play a Jellyfin item
   */
  async play(itemId: string): Promise<PlayResponse> {
    return this.request("/play", PlayResponseSchema, "POST", { itemId });
  }

  /**
   * Pause playback
   */
  async pause(): Promise<ActionResponse> {
    return this.request("/pause", ActionResponseSchema, "POST");
  }

  /**
   * Resume playback
   */
  async resume(): Promise<ActionResponse> {
    return this.request("/resume", ActionResponseSchema, "POST");
  }

  /**
   * Stop playback
   */
  async stop(): Promise<ActionResponse> {
    return this.request("/stop", ActionResponseSchema, "POST");
  }

  /**
   * Get playback status
   */
  async status(): Promise<PlaybackStatus> {
    return this.request("/status", PlaybackStatusSchema);
  }

  /**
   * Add items to queue
   */
  async addToQueue(
    itemIds: string[],
    options?: QueueOptions,
  ): Promise<QueueAddResponse> {
    return this.request("/queue/add", QueueAddResponseSchema, "POST", {
      itemIds,
      clearQueue: options?.clearQueue,
      playNow: options?.playNow,
    });
  }

  /**
   * Get current queue
   */
  async getQueue(): Promise<QueueResponse> {
    return this.request("/queue", QueueResponseSchema);
  }

  /**
   * Clear the queue
   */
  async clearQueue(): Promise<ActionResponse> {
    return this.request("/queue/clear", ActionResponseSchema, "POST");
  }

  /**
   * Play next track
   */
  async playNext(): Promise<PlaybackActionResponse> {
    return this.request("/queue/next", PlaybackActionResponseSchema, "POST");
  }

  /**
   * Play previous track
   */
  async playPrevious(): Promise<PlaybackActionResponse> {
    return this.request(
      "/queue/previous",
      PlaybackActionResponseSchema,
      "POST",
    );
  }

  /**
   * Play track from queue at specific index
   */
  async playFromQueue(index: number): Promise<PlayQueueResponse> {
    return this.request(
      `/queue/play/${index}`,
      PlayQueueResponseSchema,
      "POST",
    );
  }

  /**
   * Remove track from queue at specific index
   */
  async removeFromQueue(index: number): Promise<QueueUpdateResponse> {
    return this.request(
      `/queue/remove/${index}`,
      QueueUpdateResponseSchema,
      "POST",
    );
  }

  /**
   * Toggle loop mode
   */
  async toggleLoop(): Promise<QueueModeResponse> {
    return this.request("/queue/loop", QueueModeResponseSchema, "POST");
  }

  /**
   * Toggle random mode
   */
  async toggleRandom(): Promise<QueueModeResponse> {
    return this.request("/queue/random", QueueModeResponseSchema, "POST");
  }

  /**
   * Explicitly set one or more queue mode settings
   */
  async setQueueMode(mode: Partial<QueueMode>): Promise<QueueModeResponse> {
    try {
      return await this.request(
        "/queue/mode",
        QueueModeResponseSchema,
        "POST",
        mode,
      );
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
    return this.request("/queue/shuffle", QueueShuffleResponseSchema, "POST");
  }

  /**
   * Get current queue mode settings
   */
  async getQueueMode(): Promise<QueueModeStatusResponse> {
    return this.request("/queue/mode", QueueModeStatusResponseSchema);
  }

  /**
   * Get album details with tracks
   */
  async getAlbum(albumId: string): Promise<AlbumResponse> {
    return this.request(`/album/${albumId}`, AlbumResponseSchema);
  }

  /**
   * Get artist details with tracks
   */
  async getArtist(artistId: string): Promise<ArtistResponse> {
    return this.request(`/artist/${artistId}`, ArtistResponseSchema);
  }
}
