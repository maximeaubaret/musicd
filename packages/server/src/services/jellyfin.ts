import type {
  JellyfinConfig,
  JellyfinItem,
  AuthenticationResult,
  StoredAuth,
} from "@musicd/shared";
import {
  JellyfinError,
  loadAuth,
  saveAuth,
  getAuthFilePath,
} from "@musicd/shared";
import { logger } from "../logger";

export class JellyfinService {
  private config: JellyfinConfig;
  private accessToken: string | null = null;
  private userId: string | null = null;
  private deviceId: string =
    "music-daemon-" + Math.random().toString(36).substring(7);

  constructor(config: JellyfinConfig) {
    this.config = config;

    // Try to load stored authentication
    const storedAuth = loadAuth();
    if (storedAuth) {
      this.accessToken = storedAuth.accessToken;
      this.userId = storedAuth.userId;
    }
  }

  /**
   * Authenticate with Jellyfin server using username/password
   * This is typically only called during initial setup
   */
  async authenticate(
    username: string,
    password: string,
  ): Promise<AuthenticationResult> {
    try {
      const response = await this.loggedFetch(
        `${this.config.serverUrl}/Users/AuthenticateByName`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Emby-Authorization": this.getAuthHeader(),
          },
          body: JSON.stringify({
            Username: username,
            Pw: password,
          }),
        },
      );

      if (response.status === 401) {
        throw new JellyfinError("Invalid username or password", 401);
      }

      if (!response.ok) {
        throw new JellyfinError(
          `Authentication failed: ${response.statusText}`,
          response.status,
        );
      }

      const result = (await response.json()) as AuthenticationResult;

      // Store the token
      this.accessToken = result.AccessToken;
      this.userId = result.User.Id;

      // Save to disk for future use
      const authPath = getAuthFilePath();
      logger.info(`Saving auth to ${authPath}`);
      saveAuth(result, username);
      logger.info(`Auth saved successfully for user: ${username}`);

      return result;
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Network error during authentication: ${error}`);
    }
  }

  /**
   * Check if we have valid authentication
   */
  isAuthenticated(): boolean {
    return this.accessToken !== null && this.userId !== null;
  }

  /**
   * Verify connection to Jellyfin server
   */
  async verifyConnection(): Promise<boolean> {
    try {
      // Make sure we have a token
      if (!this.isAuthenticated()) {
        throw new JellyfinError(
          "Not authenticated. Please run setup first.",
          401,
        );
      }

      const response = await this.loggedFetch(
        `${this.config.serverUrl}/System/Info`,
        {
          headers: this.getHeaders(),
        },
      );

      if (response.status === 401) {
        // Token is invalid/expired
        throw new JellyfinError(
          "Authentication token is invalid or expired. Please run setup again.",
          401,
        );
      }

      if (!response.ok) {
        throw new JellyfinError(
          `Failed to connect to Jellyfin: ${response.statusText}`,
          response.status,
        );
      }

      return true;
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Network error connecting to Jellyfin: ${error}`);
    }
  }

  /**
   * Get item metadata from Jellyfin
   */
  async getItem(itemId: string): Promise<JellyfinItem> {
    // Ensure we're authenticated
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    try {
      const response = await this.loggedFetch(
        `${this.config.serverUrl}/Users/${this.userId}/Items/${itemId}`,
        {
          headers: this.getHeaders(),
        },
      );

      if (response.status === 404) {
        throw new JellyfinError(`Item not found: ${itemId}`, 404);
      }

      if (response.status === 401) {
        throw new JellyfinError(
          "Authentication token is invalid or expired. Please run setup again.",
          401,
        );
      }

      if (!response.ok) {
        throw new JellyfinError(
          `Failed to get item: ${response.statusText}`,
          response.status,
        );
      }

      const item = (await response.json()) as JellyfinItem;
      return item;
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Error fetching item: ${error}`);
    }
  }

  /**
   * Search for audio items in Jellyfin library
   * Uses hybrid approach:
   * 1. /Search/Hints for quick name-based matches
   * 2. If artist found, also fetches all albums by that artist
   */
  async search(query: string, limit: number = 50): Promise<JellyfinItem[]> {
    // Ensure we're authenticated
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    try {
      // Step 1: Get quick search hints
      const params = new URLSearchParams({
        searchTerm: query,
        userId: this.userId!,
        limit: limit.toString(),
        includeMedia: "true",
      });

      params.append("includeItemTypes", "Audio,MusicAlbum,MusicArtist");

      const response = await this.loggedFetch(
        `${this.config.serverUrl}/Search/Hints?${params}`,
        {
          headers: this.getHeaders(),
        },
      );

      if (response.status === 401) {
        throw new JellyfinError(
          "Authentication token is invalid or expired. Please run setup again.",
          401,
        );
      }

      if (!response.ok) {
        throw new JellyfinError(
          `Failed to search: ${response.statusText}`,
          response.status,
        );
      }

      const result = (await response.json()) as any;
      const searchHints = result.SearchHints || [];

      // Map SearchHint results to JellyfinItem format
      let items: JellyfinItem[] = searchHints.map((hint: any) => ({
        Id: hint.Id,
        Name: hint.Name,
        Type: hint.Type,
        Artists: hint.Artists || [],
        Album: hint.Album,
        AlbumArtist: hint.AlbumArtist,
        RunTimeTicks: hint.RunTimeTicks,
        ProductionYear: hint.ProductionYear,
      }));

      // Step 2: If we found any artists, also fetch their albums
      const artistIds = items
        .filter((item) => item.Type === "MusicArtist")
        .map((item) => item.Id);

      if (artistIds.length > 0) {
        // Fetch albums for each artist found
        const artistAlbumsPromises = artistIds.map((artistId) =>
          this.getItemsByArtist(artistId, "MusicAlbum"),
        );

        const artistAlbumsArrays = await Promise.all(artistAlbumsPromises);
        const artistAlbums = artistAlbumsArrays.flat();

        // Deduplicate: add albums that aren't already in the results
        const existingIds = new Set(items.map((item) => item.Id));
        const newAlbums = artistAlbums.filter(
          (album) => !existingIds.has(album.Id),
        );

        items = [...items, ...newAlbums];
      }

      // Limit final results
      return items.slice(0, limit);
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Error searching items: ${error}`);
    }
  }

  /**
   * Get items by artist ID
   */
  private async getItemsByArtist(
    artistId: string,
    itemType: string,
  ): Promise<JellyfinItem[]> {
    try {
      const params = new URLSearchParams({
        artistIds: artistId,
        includeItemTypes: itemType,
        recursive: "true",
        userId: this.userId!,
      });

      const response = await this.loggedFetch(
        `${this.config.serverUrl}/Users/${this.userId}/Items?${params}`,
        {
          headers: this.getHeaders(),
        },
      );

      if (!response.ok) {
        throw new JellyfinError(
          `Failed to get items by artist: ${response.statusText}`,
          response.status,
        );
      }

      const result = (await response.json()) as any;
      const items = result.Items || [];

      return items.map((item: any) => ({
        Id: item.Id,
        Name: item.Name,
        Type: item.Type,
        Artists: item.Artists || [],
        Album: item.Album,
        AlbumArtist: item.AlbumArtist,
        RunTimeTicks: item.RunTimeTicks,
      }));
    } catch (error) {
      // Don't fail the whole search if artist items fetch fails
      logger.error("Error fetching items by artist:", error);
      return [];
    }
  }

  /**
   * Get all tracks from an album
   */
  async getAlbumTracks(albumId: string): Promise<JellyfinItem[]> {
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    try {
      const params = new URLSearchParams({
        parentId: albumId,
        includeItemTypes: "Audio",
        sortBy: "ParentIndexNumber,IndexNumber,SortName",
        recursive: "false",
        userId: this.userId!,
      });

      const response = await this.loggedFetch(
        `${this.config.serverUrl}/Users/${this.userId}/Items?${params}`,
        {
          headers: this.getHeaders(),
        },
      );

      if (response.status === 401) {
        throw new JellyfinError(
          "Authentication token is invalid or expired. Please run setup again.",
          401,
        );
      }

      if (!response.ok) {
        throw new JellyfinError(
          `Failed to get album tracks: ${response.statusText}`,
          response.status,
        );
      }

      const result = (await response.json()) as any;
      const items = result.Items || [];

      return items.map((item: any) => ({
        Id: item.Id,
        Name: item.Name,
        Type: item.Type,
        Artists: item.Artists || [],
        Album: item.Album,
        AlbumArtist: item.AlbumArtist,
        RunTimeTicks: item.RunTimeTicks,
      }));
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Error fetching album tracks: ${error}`);
    }
  }

  /**
   * Get all tracks from an artist (all tracks from all their albums)
   */
  async getArtistTracks(artistId: string): Promise<JellyfinItem[]> {
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    try {
      const params = new URLSearchParams({
        artistIds: artistId,
        includeItemTypes: "Audio",
        recursive: "true",
        sortBy: "Album,ParentIndexNumber,IndexNumber,SortName",
        userId: this.userId!,
      });

      const response = await this.loggedFetch(
        `${this.config.serverUrl}/Users/${this.userId}/Items?${params}`,
        {
          headers: this.getHeaders(),
        },
      );

      if (response.status === 401) {
        throw new JellyfinError(
          "Authentication token is invalid or expired. Please run setup again.",
          401,
        );
      }

      if (!response.ok) {
        throw new JellyfinError(
          `Failed to get artist tracks: ${response.statusText}`,
          response.status,
        );
      }

      const result = (await response.json()) as any;
      const items = result.Items || [];

      return items.map((item: any) => ({
        Id: item.Id,
        Name: item.Name,
        Type: item.Type,
        Artists: item.Artists || [],
        Album: item.Album,
        AlbumArtist: item.AlbumArtist,
        RunTimeTicks: item.RunTimeTicks,
      }));
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Error fetching artist tracks: ${error}`);
    }
  }

  /**
   * Get direct stream URL for an item
   */
  async getStreamUrl(itemId: string): Promise<string> {
    // Ensure we're authenticated
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    // Verify item exists first
    await this.getItem(itemId);

    // Build stream URL with access token
    const streamUrl = `${this.config.serverUrl}/Audio/${itemId}/universal?UserId=${this.userId}&DeviceId=${this.deviceId}&MaxStreamingBitrate=140000000&Container=opus,mp3,aac,m4a,m4b,flac,wav,ogg&TranscodingContainer=aac&TranscodingProtocol=hls&AudioCodec=aac&api_key=${this.accessToken}`;

    return streamUrl;
  }

  /**
   * Report playback start to Jellyfin server
   * This enables play tracking and scrobbling
   */
  async reportPlaybackStart(
    itemId: string,
    playSessionId: string,
  ): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    try {
      const response = await this.loggedFetch(
        `${this.config.serverUrl}/Sessions/Playing`,
        {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify({
            ItemId: itemId,
            PlaySessionId: playSessionId,
            CanSeek: true,
            PlayMethod: "DirectStream",
            PositionTicks: 0,
            IsPaused: false,
          }),
        },
      );

      if (response.status === 401) {
        throw new JellyfinError(
          "Authentication token is invalid or expired. Please run setup again.",
          401,
        );
      }

      if (!response.ok && response.status !== 204) {
        throw new JellyfinError(
          `Failed to report playback start: ${response.statusText}`,
          response.status,
        );
      }
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Error reporting playback start: ${error}`);
    }
  }

  /**
   * Report playback progress to Jellyfin server
   * Should be called periodically during playback (every 10-30 seconds)
   */
  async reportPlaybackProgress(
    itemId: string,
    playSessionId: string,
    positionTicks: number,
    isPaused: boolean,
  ): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    try {
      const response = await this.loggedFetch(
        `${this.config.serverUrl}/Sessions/Playing/Progress`,
        {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify({
            ItemId: itemId,
            PlaySessionId: playSessionId,
            CanSeek: true,
            PlayMethod: "DirectStream",
            PositionTicks: positionTicks,
            IsPaused: isPaused,
          }),
        },
      );

      if (response.status === 401) {
        throw new JellyfinError(
          "Authentication token is invalid or expired. Please run setup again.",
          401,
        );
      }

      if (!response.ok && response.status !== 204) {
        throw new JellyfinError(
          `Failed to report playback progress: ${response.statusText}`,
          response.status,
        );
      }
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Error reporting playback progress: ${error}`);
    }
  }

  /**
   * Report playback stopped to Jellyfin server
   * Should be called when playback ends (naturally or by user action)
   */
  async reportPlaybackStopped(
    itemId: string,
    playSessionId: string,
    positionTicks: number,
  ): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    try {
      const response = await this.loggedFetch(
        `${this.config.serverUrl}/Sessions/Playing/Stopped`,
        {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify({
            ItemId: itemId,
            PlaySessionId: playSessionId,
            PositionTicks: positionTicks,
            Failed: false,
          }),
        },
      );

      if (response.status === 401) {
        throw new JellyfinError(
          "Authentication token is invalid or expired. Please run setup again.",
          401,
        );
      }

      if (!response.ok && response.status !== 204) {
        throw new JellyfinError(
          `Failed to report playback stopped: ${response.statusText}`,
          response.status,
        );
      }
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Error reporting playback stopped: ${error}`);
    }
  }

  /**
   * Get X-Emby-Authorization header for authentication requests
   */
  private getAuthHeader(): string {
    return `MediaBrowser Client="Music Daemon", Device="Server", DeviceId="${this.deviceId}", Version="0.1.0"`;
  }

  /**
   * Get common headers for Jellyfin API requests
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Emby-Authorization": this.getAuthHeader(),
    };

    if (this.accessToken) {
      headers["X-MediaBrowser-Token"] = this.accessToken;
    }

    return headers;
  }

  /**
   * Wrapper around fetch that logs HTTP requests/responses when logging is enabled
   */
  private async loggedFetch(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const method = init?.method || "GET";
    const startTime = performance.now();

    // Sanitize URL for logging (mask token if present)
    const logUrl = url.replace(/api_key=[^&]+/, "api_key=***");

    // Log request
    logger.http("request", { method, url: logUrl });

    try {
      const response = await fetch(url, init);
      const duration = Math.round(performance.now() - startTime);

      // Log response
      logger.http("response", {
        method,
        url: logUrl,
        status: response.status,
        duration,
      });

      return response;
    } catch (error) {
      const duration = Math.round(performance.now() - startTime);
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Log error
      logger.http("response", {
        method,
        url: logUrl,
        duration,
        error: errorMsg,
      });

      // Re-throw the error
      throw error;
    }
  }
}
