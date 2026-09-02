import { z } from "zod";

import { SEARCH_TYPES } from "@musicd/shared";

import type { PlaybackStatus, QueueItem } from "@musicd/shared";

import type {
  ActionResponse,
  AlbumResponse,
  ArtistResponse,
  AuthResponse,
  FavoriteUpdateResponse,
  FavoritesResponse,
  LibraryResponse,
  PlaybackActionResponse,
  PlayQueueResponse,
  PlayResponse,
  PlaylistResponse,
  QueueAddResponse,
  QueueModeResponse,
  QueueModeStatusResponse,
  QueueResponse,
  QueueUpdateResponse,
  SearchResponse,
  VolumeResponse,
} from "./types";

export const DaemonErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string().min(1),
});

const MediaSourceSchema = z.object({
  Id: z.string().optional(),
  Path: z.string().optional(),
  Protocol: z.string(),
  Container: z.string().optional(),
});

const JellyfinItemSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Type: z.string(),
  Artists: z.array(z.string()).optional(),
  Album: z.string().optional(),
  AlbumArtist: z.string().optional(),
  RunTimeTicks: z.number().finite().nonnegative().optional(),
  ProductionYear: z.number().int().optional(),
  IndexNumber: z.number().int().optional(),
  MediaSources: z.array(MediaSourceSchema).optional(),
});

const QueueItemBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  artist: z.string().optional(),
  album: z.string().optional(),
  duration: z.number().finite().nonnegative(),
});

const QueueItemSchema: z.ZodType<QueueItem> = z.discriminatedUnion("source", [
  QueueItemBaseSchema.extend({
    source: z.literal("jellyfin"),
    jellyfinItem: JellyfinItemSchema,
  }),
  QueueItemBaseSchema.extend({
    source: z.literal("youtube"),
    youtubeUrl: z.string(),
    videoId: z.string(),
    uploader: z.string().optional(),
  }),
]);

const PlaybackItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  artist: z.string().optional(),
  album: z.string().optional(),
  source: z.enum(["jellyfin", "youtube"]).optional(),
});

const QueueModeSchema = z.object({
  loop: z.boolean(),
  random: z.boolean(),
});

const SuccessSchema = z.literal(true);

// One contract for the one payload shape the daemon serialises every item
// with; TrackInfoSchema and SearchResultSchema are the names the responses
// below already referred to it by.
const LibraryItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  artist: z.string().optional(),
  artistId: z.string().optional(),
  album: z.string().optional(),
  albumId: z.string().optional(),
  duration: z.number().finite().nonnegative(),
  year: z.number().int().optional(),
  indexNumber: z.number().int().optional(),
});

const TrackInfoSchema = LibraryItemSchema;

const SearchResultSchema = LibraryItemSchema;

export const AuthResponseSchema: z.ZodType<AuthResponse> = z.object({
  success: SuccessSchema,
  user: z.object({
    id: z.string(),
    name: z.string(),
  }),
});

export const PlayResponseSchema: z.ZodType<PlayResponse> = z.union([
  z.object({
    success: SuccessSchema,
    message: z.string(),
    item: PlaybackItemSchema,
  }),
  z.object({
    success: SuccessSchema,
    message: z.string(),
    state: z.enum(["playing", "paused", "stopped"]),
    currentItem: PlaybackItemSchema.nullable(),
  }),
]);

export const ActionResponseSchema: z.ZodType<ActionResponse> = z.object({
  success: SuccessSchema,
  message: z.string(),
});

export const PlaybackActionResponseSchema: z.ZodType<PlaybackActionResponse> =
  z.object({
    success: SuccessSchema,
    message: z.string(),
    state: z.enum(["playing", "paused", "stopped"]),
    currentItem: PlaybackItemSchema.nullable(),
  });

export const QueueAddResponseSchema: z.ZodType<QueueAddResponse> = z.object({
  success: SuccessSchema,
  message: z.string(),
  tracksAdded: z.number().int().nonnegative(),
  queue: z.array(QueueItemSchema),
});

export const QueueResponseSchema: z.ZodType<QueueResponse> = z.object({
  success: SuccessSchema,
  queue: z.array(QueueItemSchema),
  position: z.number().int().min(-1),
  count: z.number().int().nonnegative(),
});

export const QueueUpdateResponseSchema: z.ZodType<QueueUpdateResponse> =
  z.object({
    success: SuccessSchema,
    message: z.string(),
    queue: z.array(QueueItemSchema),
    position: z.number().int().min(-1),
  });

export const QueueShuffleResponseSchema: z.ZodType<QueueResponse> = z.object({
  success: SuccessSchema,
  message: z.string(),
  queue: z.array(QueueItemSchema),
  position: z.number().int().min(-1),
  count: z.number().int().nonnegative(),
});

export const PlayQueueResponseSchema: z.ZodType<PlayQueueResponse> = z.object({
  success: SuccessSchema,
  message: z.string(),
  item: z
    .object({
      name: z.string(),
      artist: z.string().optional(),
      album: z.string().optional(),
    })
    .nullable(),
  position: z.number().int().nonnegative(),
  queueLength: z.number().int().nonnegative(),
});

export const QueueModeResponseSchema: z.ZodType<QueueModeResponse> = z.object({
  success: SuccessSchema,
  message: z.string(),
  loop: z.boolean().optional(),
  random: z.boolean().optional(),
  queueMode: QueueModeSchema,
});

export const QueueModeStatusResponseSchema: z.ZodType<QueueModeStatusResponse> =
  z.object({
    success: SuccessSchema,
    queueMode: QueueModeSchema,
  });

export const VolumeResponseSchema: z.ZodType<VolumeResponse> = z.object({
  success: SuccessSchema,
  volume: z.number().finite().min(0).max(100),
});

export const SearchResponseSchema: z.ZodType<SearchResponse> = z.object({
  success: SuccessSchema,
  query: z.string(),
  types: z.array(z.enum(SEARCH_TYPES)),
  count: z.number().int().nonnegative(),
  results: z.array(SearchResultSchema),
});

export const LibraryResponseSchema: z.ZodType<LibraryResponse> = z.object({
  success: SuccessSchema,
  kind: z.enum(["albums", "artists", "playlists", "songs"]),
  startIndex: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  items: z.array(SearchResultSchema),
});

export const FavoritesResponseSchema: z.ZodType<FavoritesResponse> = z.object({
  success: SuccessSchema,
  kind: z.enum(["albums", "artists", "songs"]),
  startIndex: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  items: z.array(SearchResultSchema),
});

export const AlbumResponseSchema: z.ZodType<AlbumResponse> = z.object({
  success: SuccessSchema,
  album: z.object({
    id: z.string(),
    name: z.string(),
    artist: z.string().optional(),
    artistId: z.string().optional(),
    type: z.string(),
  }),
  tracks: z.array(TrackInfoSchema),
  count: z.number().int().nonnegative(),
});

export const ArtistResponseSchema: z.ZodType<ArtistResponse> = z.object({
  success: SuccessSchema,
  artist: z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
  }),
  tracks: z.array(TrackInfoSchema),
  count: z.number().int().nonnegative(),
});

export const PlaylistResponseSchema: z.ZodType<PlaylistResponse> = z.object({
  success: SuccessSchema,
  playlist: z.object({
    id: z.string(),
    name: z.string(),
    type: z.literal("Playlist"),
  }),
  tracks: z.array(TrackInfoSchema),
  count: z.number().int().nonnegative(),
});

export const FavoriteUpdateResponseSchema: z.ZodType<FavoriteUpdateResponse> =
  z.object({
    success: SuccessSchema,
    itemId: z.string(),
    favorite: z.boolean(),
  });

export const PlaybackStatusSchema: z.ZodType<PlaybackStatus> = z.object({
  state: z.enum(["playing", "paused", "stopped"]),
  currentItem: PlaybackItemSchema.nullable(),
  position: z.number().finite().nonnegative(),
  duration: z.number().finite().nonnegative(),
  queue: z.array(QueueItemSchema),
  queuePosition: z.number().int().min(-1),
  queueMode: z.object({
    loop: z.boolean(),
    random: z.boolean(),
  }),
});
