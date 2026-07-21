import type {
  PlaybackState,
  PlaybackStatus,
  QueueItem,
  QueueMode,
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

export interface SearchResult {
  id: string;
  name: string;
  type: string;
  artist?: string;
  album?: string;
  duration: number;
  year?: number;
}

export interface SearchResponse {
  success: boolean;
  query: string;
  count: number;
  results: SearchResult[];
}

export interface TrackInfo {
  id: string;
  name: string;
  type: string;
  artist?: string;
  album?: string;
  duration: number;
  year?: number;
  indexNumber?: number;
}

export interface AlbumResponse {
  success: boolean;
  album: {
    id: string;
    name: string;
    artist?: string;
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

export { PlaybackStatus, QueueMode };
