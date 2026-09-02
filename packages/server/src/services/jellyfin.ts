import { z } from "zod";

import type {
  JellyfinConfig,
  JellyfinItem,
  AuthenticationResult,
  SearchType,
  StoredAuth,
} from "@musicd/shared";
import {
  JellyfinError,
  SEARCH_TYPES,
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

// Jellyfin names the artist and album a track belongs to in two places: bare
// strings (Artists, AlbumArtist) and id/name pairs (ArtistItems, AlbumArtists).
// Only the pairs can be opened, so both are read and flattened into ArtistId.
const JellyfinNameIdPairsSchema = z
  .array(z.object({ Id: z.string().min(1), Name: OptionalStringSchema }))
  .nullish()
  .transform((value) => value ?? undefined);

const JellyfinItemSchema = z.object({
  Id: z.string().min(1),
  Name: z.string().min(1),
  Type: z.string().min(1),
  Artists: OptionalArtistsSchema,
  Album: OptionalStringSchema,
  AlbumId: OptionalStringSchema,
  AlbumArtist: OptionalStringSchema,
  AlbumArtists: JellyfinNameIdPairsSchema,
  ArtistItems: JellyfinNameIdPairsSchema,
  RunTimeTicks: OptionalFiniteNumberSchema,
  ProductionYear: OptionalFiniteNumberSchema,
  IndexNumber: OptionalFiniteNumberSchema,
  MediaSources: OptionalMediaSourcesSchema,
});

type JellyfinItemPayload = z.infer<typeof JellyfinItemSchema>;

// /Search/Hints answers with a narrower shape than /Items: it carries AlbumId
// but no ArtistItems, which is why audio hints are enriched before they are
// returned. See JellyfinService.search.
const JellyfinSearchHintSchema = JellyfinItemSchema.pick({
  Id: true,
  Name: true,
  Type: true,
  Artists: true,
  Album: true,
  AlbumId: true,
  AlbumArtist: true,
  RunTimeTicks: true,
  ProductionYear: true,
});

/**
 * The one place a Jellyfin payload becomes a JellyfinItem. Every caller used to
 * copy the fields it happened to need, so a field added here reached some
 * endpoints and silently vanished from the rest.
 */
function toJellyfinItem(
  item: JellyfinItemPayload | z.infer<typeof JellyfinSearchHintSchema>,
): JellyfinItem {
  const withPairs: Partial<JellyfinItemPayload> = item;
  return {
    Id: item.Id,
    Name: item.Name,
    Type: item.Type,
    Artists: item.Artists ?? [],
    Album: item.Album,
    AlbumId: item.AlbumId,
    AlbumArtist: item.AlbumArtist,
    // Mirrors how the API picks a display artist (Artists first, album artist
    // as the fallback) so the id and the label it sits behind never disagree.
    ArtistId: withPairs.ArtistItems?.[0]?.Id ?? withPairs.AlbumArtists?.[0]?.Id,
    RunTimeTicks: item.RunTimeTicks,
    ProductionYear: item.ProductionYear,
    IndexNumber: withPairs.IndexNumber,
    MediaSources: withPairs.MediaSources,
  };
}

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

const SEARCH_TYPE_ITEM_TYPES: Record<SearchType, string> = {
  artists: "MusicArtist",
  albums: "MusicAlbum",
  songs: "Audio",
};

// How many results the crowd-out-prone types may contribute before the rest of
// a search budget goes to tracks. Songs are deliberately absent: they are the
// fallthrough that spends whatever the other types leave.
const SEARCH_TYPE_CEILINGS: Partial<Record<SearchType, number>> = {
  artists: 5,
  albums: 8,
};

// The ceilings above are absolute, which on a small budget would leave nothing
// for tracks. Never let a reserved type take more than this share of one — and
// on a budget too small to divide, none of it: asking for one result means
// asking for the single best match, not for an artist.
const SEARCH_TYPE_MAX_SHARE = 0.2;

/**
 * How many results to fetch per type for one search.
 *
 * This is a fetch budget, not an allocation: the caller concatenates the
 * groups in SEARCH_TYPES order and truncates to `limit`. Songs are fetched at
 * the full budget so that slots the reserved types do not fill — a query
 * matching one artist and no albums — still come back as tracks instead of
 * going unspent.
 *
 * The ceilings only exist to stop one type crowding out another, so a query
 * scoped to a single type gets the whole budget.
 */
export function searchSlots(
  limit: number,
  types: readonly SearchType[],
): Record<SearchType, number> {
  const slots: Record<SearchType, number> = { artists: 0, albums: 0, songs: 0 };
  const requested = SEARCH_TYPES.filter((type) => types.includes(type));
  const share = Math.floor(limit * SEARCH_TYPE_MAX_SHARE);

  for (const type of requested) {
    const ceiling = SEARCH_TYPE_CEILINGS[type];
    slots[type] =
      ceiling === undefined || requested.length === 1
        ? limit
        : Math.min(ceiling, share);
  }

  return slots;
}

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
   * Search the library, giving each item type its own share of the result
   * budget.
   *
   * One /Search/Hints call across all three types returns them in a single
   * relevance order, and songs outnumber albums and artists by orders of
   * magnitude: "love" fills all 100 slots with tracks while 20 matching albums
   * and a matching artist never appear. So each type is searched separately and
   * the budget is spent in SEARCH_TYPES order, capped per type so a broad query
   * cannot bury the tracks either.
   *
   * The hits are then enriched in one batched /Items call, because
   * /Search/Hints carries AlbumId but not the artist id a client needs to open
   * the artist behind a track's or an album's label.
   */
  async search(
    query: string,
    limit: number = 50,
    types: readonly SearchType[] = SEARCH_TYPES,
  ): Promise<JellyfinItem[]> {
    if (!this.isAuthenticated()) {
      throw new JellyfinError(
        "Not authenticated. Please run setup first.",
        401,
      );
    }

    try {
      const slots = searchSlots(limit, types);
      const groups = await Promise.all(
        SEARCH_TYPES.filter((type) => slots[type] > 0).map(async (type) => ({
          type,
          hints: await this.fetchSearchHints(query, type, slots[type]),
        })),
      );

      const items: JellyfinItem[] = [];
      for (const group of groups) {
        items.push(...group.hints.map(toJellyfinItem));
      }

      return await this.withRelatedIds(items.slice(0, limit));
    } catch (error) {
      if (error instanceof JellyfinError) {
        throw error;
      }
      throw new JellyfinError(`Error searching items: ${error}`);
    }
  }

  private async fetchSearchHints(
    query: string,
    type: SearchType,
    limit: number,
  ): Promise<z.infer<typeof JellyfinSearchResponseSchema>["SearchHints"]> {
    const params = new URLSearchParams({
      searchTerm: query,
      userId: this.userId!,
      limit: limit.toString(),
      includeMedia: "true",
      includeItemTypes: SEARCH_TYPE_ITEM_TYPES[type],
    });

    const response = await this.loggedFetch(
      `${this.config.serverUrl}/Search/Hints?${params}`,
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
        `Failed to search: ${response.statusText}`,
        response.status,
      );
    }

    const result = await parseJellyfinResponse(
      response,
      JellyfinSearchResponseSchema,
      "searching for items",
    );

    return result.SearchHints.slice(0, limit);
  }

  /**
   * Fill in the album and artist ids /Search/Hints leaves out, in one batched
   * lookup. Artists need nothing resolved — they are the destination — so only
   * songs and albums are looked up.
   *
   * A failure here costs the ids, not the search: the results are still
   * playable and still open, they just cannot be navigated sideways from.
   */
  private async withRelatedIds(items: JellyfinItem[]): Promise<JellyfinItem[]> {
    const unresolved = items
      .filter((item) => item.Type !== "MusicArtist")
      .map((item) => item.Id);

    if (unresolved.length === 0) {
      return items;
    }

    let byId: Map<string, JellyfinItem>;
    try {
      const params = new URLSearchParams({
        ids: unresolved.join(","),
        userId: this.userId!,
      });

      const response = await this.loggedFetch(
        `${this.config.serverUrl}/Users/${this.userId}/Items?${params}`,
        { headers: this.getHeaders() },
      );

      if (!response.ok) {
        return items;
      }

      const result = await parseJellyfinResponse(
        response,
        JellyfinItemsResponseSchema,
        "resolving search result ids",
      );
      byId = new Map(
        result.Items.map((item) => [item.Id, toJellyfinItem(item)]),
      );
    } catch (error) {
      logger.warn(`Could not resolve search result ids: ${error}`);
      return items;
    }

    return items.map((item) => {
      const resolved = byId.get(item.Id);
      if (!resolved) {
        return item;
      }
      return {
        ...item,
        AlbumId: item.AlbumId ?? resolved.AlbumId,
        ArtistId: resolved.ArtistId,
      };
    });
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

      return items.map(toJellyfinItem);
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

      return items.map(toJellyfinItem);
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

      return result.Items.map(toJellyfinItem);
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

      return result.Items.filter((item) => item.Type === "Audio").map(
        toJellyfinItem,
      );
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
        items: result.Items.map(toJellyfinItem),
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
        items: result.Items.map(toJellyfinItem),
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
