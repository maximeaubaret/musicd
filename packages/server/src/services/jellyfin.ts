import { z } from "zod";

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

import type { PlaybackSource } from "./playback/backend";

type AuthSaver = (result: AuthenticationResult, username: string) => void;

const AuthenticationResultSchema = z.object({
  User: z.object({
    Id: z.string().min(1),
    Name: z.string().min(1),
  }),
  AccessToken: z.string().min(1),
  ServerId: z.string().min(1),
});

const OptionalStringSchema = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);

const JellyfinMediaSourceSchema = z.object({
  Id: OptionalStringSchema,
  Path: OptionalStringSchema,
  Protocol: z.string().min(1),
  Container: OptionalStringSchema,
});

const OptionalFiniteNumberSchema = z
  .number()
  .finite()
  .nullish()
  .transform((value) => value ?? undefined);
const OptionalArtistsSchema = z
  .array(z.string())
  .nullish()
  .transform((value) => value ?? undefined);
const OptionalMediaSourcesSchema = z
  .array(JellyfinMediaSourceSchema)
  .nullish()
  .transform((value) => value ?? undefined);

const JellyfinItemSchema = z.object({
  Id: z.string().min(1),
  Name: z.string().min(1),
  Type: z.string().min(1),
  Artists: OptionalArtistsSchema,
  Album: OptionalStringSchema,
  AlbumArtist: OptionalStringSchema,
  RunTimeTicks: OptionalFiniteNumberSchema,
  ProductionYear: OptionalFiniteNumberSchema,
  IndexNumber: OptionalFiniteNumberSchema,
  MediaSources: OptionalMediaSourcesSchema,
});

const JellyfinSearchHintSchema = JellyfinItemSchema.pick({
  Id: true,
  Name: true,
  Type: true,
  Artists: true,
  Album: true,
  AlbumArtist: true,
  RunTimeTicks: true,
  ProductionYear: true,
});

const JellyfinSearchResponseSchema = z.object({
  SearchHints: z
    .array(JellyfinSearchHintSchema)
    .nullish()
    .transform((value) => value ?? []),
});

const JellyfinItemsResponseSchema = z.object({
  Items: z
    .array(JellyfinItemSchema)
    .nullish()
    .transform((value) => value ?? []),
});

const JellyfinItemsPageSchema = z.object({
  Items: z
    .array(JellyfinItemSchema)
    .nullish()
    .transform((value) => value ?? []),
  TotalRecordCount: OptionalFiniteNumberSchema,
});

export type BrowseKind = "albums" | "artists" | "playlists" | "songs";

export type FavoriteKind = "albums" | "artists" | "songs";

export interface BrowsePage {
  items: JellyfinItem[];
  total: number;
}

class JellyfinResponseError extends JellyfinError {}

async function parseJellyfinResponse<Schema extends z.ZodTypeAny>(
  response: Response,
  schema: Schema,
  operation: string,
): Promise<z.output<Schema>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new JellyfinResponseError(
      `Invalid Jellyfin response while ${operation}: response body is not valid JSON`,
    );
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    const invalidFields = [
      ...new Set(
        result.error.issues.map((issue) => issue.path.join(".") || "response"),
      ),
    ].join(", ");
    throw new JellyfinResponseError(
      `Invalid Jellyfin response while ${operation}: invalid fields: ${invalidFields}`,
    );
  }

  return result.data;
}

export class JellyfinService {
  private config: JellyfinConfig;
  private accessToken: string | null = null;
  private userId: string | null = null;
  private deviceId: string =
    "music-daemon-" + Math.random().toString(36).substring(7);

  constructor(
    config: JellyfinConfig,
    authLoader: () => StoredAuth | null = loadAuth,
    private readonly authSaver: AuthSaver | null = saveAuth,
  ) {
    this.config = config;

    // Try to load stored authentication
    const storedAuth = authLoader();
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

      const result = await parseJellyfinResponse(
        response,
        AuthenticationResultSchema,
        "authenticating",
      );

      // Store the token
      this.accessToken = result.AccessToken;
      this.userId = result.User.Id;

      // Save to disk for future use
      if (this.authSaver) {
        const authPath = getAuthFilePath();
        logger.info(`Saving auth to ${authPath}`);
        this.authSaver(result, username);
        logger.info(`Auth saved successfully for user: ${username}`);
      }

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

      return await parseJellyfinResponse(
        response,
        JellyfinItemSchema,
        "fetching item metadata",
      );
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

      const result = await parseJellyfinResponse(
        response,
        JellyfinSearchResponseSchema,
        "searching for items",
      );
      const searchHints = result.SearchHints;

      // Map SearchHint results to JellyfinItem format. This is deliberately a
      // single Jellyfin round-trip: expanding matched artists into their
      // albums here used to add one request per artist on every query, and
      // clients that want an artist's discography can drill down explicitly.
      const items: JellyfinItem[] = searchHints.map((hint) => ({
        Id: hint.Id,
        Name: hint.Name,
        Type: hint.Type,
        Artists: hint.Artists || [],
        Album: hint.Album,
        AlbumArtist: hint.AlbumArtist,
        RunTimeTicks: hint.RunTimeTicks,
        ProductionYear: hint.ProductionYear,
      }));

      return items.slice(0, limit);
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Error searching items: ${error}`);
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

      const result = await parseJellyfinResponse(
        response,
        JellyfinItemsResponseSchema,
        "fetching album tracks",
      );
      const items = result.Items;

      return items.map((item) => ({
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

      const result = await parseJellyfinResponse(
        response,
        JellyfinItemsResponseSchema,
        "fetching artist tracks",
      );
      const items = result.Items;

      return items.map((item) => ({
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
   * Get an artist's albums, ordered as a discography (oldest first).
   * Uses albumArtistIds so compilations the artist merely appears on do not
   * crowd out their own releases.
   */
  async getArtistAlbums(artistId: string): Promise<JellyfinItem[]> {
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    try {
      const params = new URLSearchParams({
        albumArtistIds: artistId,
        includeItemTypes: "MusicAlbum",
        recursive: "true",
        sortBy: "ProductionYear,SortName",
        sortOrder: "Ascending",
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
          `Failed to get artist albums: ${response.statusText}`,
          response.status,
        );
      }

      const result = await parseJellyfinResponse(
        response,
        JellyfinItemsResponseSchema,
        "fetching artist albums",
      );

      return result.Items.map((item) => ({
        Id: item.Id,
        Name: item.Name,
        Type: item.Type,
        Artists: item.Artists || [],
        Album: item.Album,
        AlbumArtist: item.AlbumArtist,
        RunTimeTicks: item.RunTimeTicks,
        ProductionYear: item.ProductionYear,
      }));
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Error fetching artist albums: ${error}`);
    }
  }

  /**
   * Get the ordered audio tracks from a Jellyfin playlist.
   */
  async getPlaylistTracks(playlistId: string): Promise<JellyfinItem[]> {
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    try {
      const params = new URLSearchParams({ userId: this.userId! });
      const response = await this.loggedFetch(
        `${this.config.serverUrl}/Playlists/${playlistId}/Items?${params}`,
        { headers: this.getHeaders() },
      );

      if (response.status === 401) {
        throw new JellyfinError(
          "Authentication token is invalid or expired. Please run setup again.",
          401,
        );
      }

      if (response.status === 404) {
        throw new JellyfinError(`Playlist not found: ${playlistId}`, 404);
      }

      if (!response.ok) {
        throw new JellyfinError(
          `Failed to get playlist tracks: ${response.statusText}`,
          response.status,
        );
      }

      const result = await parseJellyfinResponse(
        response,
        JellyfinItemsPageSchema,
        "fetching playlist tracks",
      );

      return result.Items.filter((item) => item.Type === "Audio");
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Error fetching playlist tracks: ${error}`);
    }
  }

  /**
   * Get the authenticated playback source for an item
   */
  async getPlaybackSource(itemId: string): Promise<PlaybackSource> {
    // Ensure we're authenticated
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    // Verify item exists first
    await this.getItem(itemId);

    const accessToken = this.accessToken;
    if (!accessToken) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    const streamUrl = new URL(
      `/Audio/${itemId}/universal`,
      this.config.serverUrl,
    );
    streamUrl.search = new URLSearchParams({
      UserId: this.userId ?? "",
      DeviceId: this.deviceId,
      MaxStreamingBitrate: "140000000",
      Container: "opus,mp3,aac,m4a,m4b,flac,wav,ogg",
      TranscodingContainer: "aac",
      TranscodingProtocol: "http",
      AudioCodec: "aac",
    }).toString();

    return {
      url: streamUrl.toString(),
      headers: { "X-MediaBrowser-Token": accessToken },
    };
  }

  /**
   * Browse the library alphabetically, one page at a time.
   * Albums and songs go through the user Items endpoint; artists use
   * Jellyfin's dedicated AlbumArtists endpoint so only artists with albums
   * in the music library appear.
   */
  async browse(
    kind: BrowseKind,
    startIndex: number = 0,
    limit: number = 100,
  ): Promise<BrowsePage> {
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    try {
      const params = new URLSearchParams({
        userId: this.userId!,
        // Albums group by artist first so one artist's discography sits
        // together; artists, playlists, and songs stay alphabetical.
        sortBy: kind === "albums" ? "AlbumArtist,SortName" : "SortName",
        sortOrder: "Ascending",
        startIndex: startIndex.toString(),
        limit: limit.toString(),
        recursive: "true",
      });

      let url: string;
      if (kind === "artists") {
        url = `${this.config.serverUrl}/Artists/AlbumArtists?${params}`;
      } else {
        const itemType =
          kind === "albums"
            ? "MusicAlbum"
            : kind === "playlists"
              ? "Playlist"
              : "Audio";
        params.set("includeItemTypes", itemType);
        url = `${this.config.serverUrl}/Users/${this.userId}/Items?${params}`;
      }

      const response = await this.loggedFetch(url, {
        headers: this.getHeaders(),
      });

      if (response.status === 401) {
        throw new JellyfinError(
          "Authentication token is invalid or expired. Please run setup again.",
          401,
        );
      }

      if (!response.ok) {
        throw new JellyfinError(
          `Failed to browse ${kind}: ${response.statusText}`,
          response.status,
        );
      }

      const result = await parseJellyfinResponse(
        response,
        JellyfinItemsPageSchema,
        `browsing ${kind}`,
      );

      return {
        items: result.Items,
        total: result.TotalRecordCount ?? result.Items.length,
      };
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Error browsing ${kind}: ${error}`);
    }
  }

  /**
   * Browse the authenticated user's favorite music items.
   */
  async browseFavorites(
    kind: FavoriteKind,
    startIndex: number = 0,
    limit: number = 100,
  ): Promise<BrowsePage> {
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    try {
      const itemType =
        kind === "albums"
          ? "MusicAlbum"
          : kind === "artists"
            ? "MusicArtist"
            : "Audio";
      const params = new URLSearchParams({
        userId: this.userId!,
        includeItemTypes: itemType,
        filters: "IsFavorite",
        recursive: "true",
        sortBy: kind === "albums" ? "AlbumArtist,SortName" : "SortName",
        sortOrder: "Ascending",
        startIndex: startIndex.toString(),
        limit: limit.toString(),
      });

      const response = await this.loggedFetch(
        `${this.config.serverUrl}/Users/${this.userId}/Items?${params}`,
        { headers: this.getHeaders() },
      );

      if (response.status === 401) {
        throw new JellyfinError(
          "Authentication token is invalid or expired. Please run setup again.",
          401,
        );
      }

      if (!response.ok) {
        throw new JellyfinError(
          `Failed to browse favorite ${kind}: ${response.statusText}`,
          response.status,
        );
      }

      const result = await parseJellyfinResponse(
        response,
        JellyfinItemsPageSchema,
        `browsing favorite ${kind}`,
      );

      return {
        items: result.Items,
        total: result.TotalRecordCount ?? result.Items.length,
      };
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Error browsing favorite ${kind}: ${error}`);
    }
  }

  /**
   * Mark or unmark an item as a favorite for the authenticated user.
   */
  async setFavorite(itemId: string, favorite: boolean): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    try {
      const response = await this.loggedFetch(
        `${this.config.serverUrl}/Users/${this.userId}/FavoriteItems/${itemId}`,
        {
          method: favorite ? "POST" : "DELETE",
          headers: this.getHeaders(),
        },
      );

      if (response.status === 401) {
        throw new JellyfinError(
          "Authentication token is invalid or expired. Please run setup again.",
          401,
        );
      }

      if (response.status === 404) {
        throw new JellyfinError(`Item not found: ${itemId}`, 404);
      }

      if (!response.ok) {
        throw new JellyfinError(
          `Failed to ${favorite ? "mark" : "unmark"} favorite: ${response.statusText}`,
          response.status,
        );
      }
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(
        `Error ${favorite ? "marking" : "unmarking"} favorite: ${error}`,
      );
    }
  }

  /**
   * Fetch an item's primary artwork from Jellyfin.
   * Jellyfin resolves audio items to their album's primary image, so a track
   * ID is enough. Returns the upstream Response so callers can stream the
   * image body without buffering it.
   */
  async getArtwork(itemId: string, maxWidth: number = 256): Promise<Response> {
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    const artworkUrl = new URL(
      `/Items/${itemId}/Images/Primary`,
      this.config.serverUrl,
    );
    artworkUrl.search = new URLSearchParams({
      maxWidth: String(maxWidth),
      quality: "90",
    }).toString();

    const response = await this.loggedFetch(artworkUrl.toString(), {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new JellyfinError(
        `Artwork not available for item ${itemId}`,
        response.status === 404 ? 404 : 502,
      );
    }

    return response;
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
