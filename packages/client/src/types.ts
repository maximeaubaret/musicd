import type {
  PlaybackState,
  PlaybackStatus,
  QueueItem,
  QueueMode,
  SearchType,
} from "@musicd/shared";

export interface AuthResponse {
  success: boolean;
  user: {
    id: string;
    name: string;
  };
}

export interface DirectPlayResponse {
  success: boolean;
  message: string;
  item: {
    id: string;
    name: string;
    artist?: string;
    album?: string;
    source?: "jellyfin" | "youtube";
  };
}

export interface SmartPlayResponse {
  success: boolean;
  message: string;
  state: PlaybackState;
  currentItem: PlaybackStatus["currentItem"];
}

export type PlayResponse = DirectPlayResponse | SmartPlayResponse;

export interface QueueAddResponse {
  success: boolean;
  message: string;
  tracksAdded: number;
  queue: QueueItem[];
}

export interface QueueResponse {
  success: boolean;
  queue: QueueItem[];
  position: number;
  count: number;
}

export interface QueueUpdateResponse {
  success: boolean;
  message: string;
  queue: QueueItem[];
  position: number;
}

export interface PlayQueueResponse {
  success: boolean;
  message: string;
  item: {
    name: string;
    artist?: string;
    album?: string;
  } | null;
  position: number;
  queueLength: number;
}

/**
 * The shape every item-returning daemon endpoint answers with, whatever the
 * item is: a song, an album, an artist or a playlist. `SearchResult` and
 * `TrackInfo` are the two names callers already knew it by.
 */
export interface LibraryItem {
  id: string;
  name: string;
  type: string;
  artist?: string;
  /** Id of `artist`, when Jellyfin knows one. Absent on artists themselves. */
  artistId?: string;
  album?: string;
  /** Id of `album`, when Jellyfin knows one. Absent on albums themselves. */
  albumId?: string;
  duration: number;
  year?: number;
  indexNumber?: number;
}

export type SearchResult = LibraryItem;

export interface SearchResponse {
  success: boolean;
  query: string;
  /** The types actually searched, in the order the results are grouped by. */
  types: SearchType[];
  count: number;
  results: SearchResult[];
}

export type LibraryKind = "albums" | "artists" | "playlists" | "songs";

export type FavoriteKind = "albums" | "artists" | "songs";

export interface LibraryResponse {
  success: boolean;
  kind: LibraryKind;
  startIndex: number;
  limit: number;
  total: number;
  count: number;
  items: SearchResult[];
}

export interface FavoritesResponse {
  success: boolean;
  kind: FavoriteKind;
  startIndex: number;
  limit: number;
  total: number;
  count: number;
  items: SearchResult[];
}

export type TrackInfo = LibraryItem;

export interface AlbumResponse {
  success: boolean;
  album: {
    id: string;
    name: string;
    artist?: string;
    artistId?: string;
    type: string;
  };
  tracks: TrackInfo[];
  count: number;
}

export interface ArtistResponse {
  success: boolean;
  artist: {
    id: string;
    name: string;
    type: string;
  };
  tracks: TrackInfo[];
  count: number;
}

export interface PlaylistResponse {
  success: boolean;
  playlist: {
    id: string;
    name: string;
    type: "Playlist";
  };
  tracks: TrackInfo[];
  count: number;
}

export interface FavoriteUpdateResponse {
  success: boolean;
  itemId: string;
  favorite: boolean;
}

export interface QueueOptions {
  clearQueue?: boolean;
  playNow?: boolean;
}

/** Response from POST /pause, /resume, /stop, /queue/clear */
export interface ActionResponse {
  success: boolean;
  message: string;
}

/** Response from POST /queue/next, /queue/previous */
export interface PlaybackActionResponse {
  success: boolean;
  message: string;
  state: PlaybackState;
  currentItem: {
    id: string;
    name: string;
    artist?: string;
    album?: string;
  } | null;
}

/** Response from POST /queue/loop, /queue/random */
export interface QueueModeResponse {
  success: boolean;
  message: string;
  loop?: boolean;
  random?: boolean;
  queueMode: QueueMode;
}

/** Response from GET /queue/mode */
export interface QueueModeStatusResponse {
  success: boolean;
  queueMode: QueueMode;
}

export interface VolumeResponse {
  success: boolean;
  volume: number;
}

export { PlaybackStatus, QueueMode };
