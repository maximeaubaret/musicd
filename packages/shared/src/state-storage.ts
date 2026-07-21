import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { z } from "zod";

import { XDG_DATA_DIR, XDG_QUEUE_FILE, isYouTubeUrl } from "./constants";
import type { QueueItem, QueueMode } from "./types";

const CURRENT_STATE_VERSION = 3;
const DEFAULT_QUEUE_MODE: QueueMode = { loop: false, random: false };

const MediaSourceSchema = z.object({
  Id: z.string(),
  Path: z.string(),
  Protocol: z.string(),
  Container: z.string(),
});

const JellyfinItemSchema = z.object({
  Id: z.string().min(1),
  Name: z.string(),
  Type: z.string().min(1),
  Artists: z.array(z.string()).optional(),
  Album: z.string().optional(),
  AlbumArtist: z.string().optional(),
  RunTimeTicks: z.number().finite().nonnegative().optional(),
  ProductionYear: z.number().int().optional(),
  IndexNumber: z.number().int().optional(),
  MediaSources: z.array(MediaSourceSchema).optional(),
});

const QueueItemBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  artist: z.string().optional(),
  album: z.string().optional(),
  duration: z.number().finite().nonnegative(),
});

const JellyfinQueueItemSchema = QueueItemBaseSchema.extend({
  source: z.literal("jellyfin"),
  jellyfinItem: JellyfinItemSchema,
});

const YouTubeQueueItemSchema = QueueItemBaseSchema.extend({
  source: z.literal("youtube"),
  youtubeUrl: z.string().refine(isYouTubeUrl, "Must be a YouTube URL"),
  videoId: z.string().min(1),
  uploader: z.string().optional(),
});

const QueueItemSchema: z.ZodType<QueueItem> = z.discriminatedUnion("source", [
  JellyfinQueueItemSchema,
  YouTubeQueueItemSchema,
]);

const QueuePositionSchema = z.number().int().min(-1);
const SavedAtSchema = z.number().finite().nonnegative();
const QueueModeSchema = z.object({
  loop: z.boolean(),
  random: z.boolean(),
});

const QueueStateV1Schema = z.object({
  queue: z.array(
    QueueItemBaseSchema.extend({
      jellyfinItem: JellyfinItemSchema,
    }),
  ),
  queuePosition: QueuePositionSchema,
  savedAt: SavedAtSchema,
  version: z.literal(1),
});

const QueueStateV2Schema = z.object({
  queue: z.array(QueueItemSchema),
  queuePosition: QueuePositionSchema,
  savedAt: SavedAtSchema,
  version: z.literal(2),
});

const QueueStateV3Schema = z.object({
  queue: z.array(QueueItemSchema),
  queuePosition: QueuePositionSchema,
  queueMode: QueueModeSchema,
  savedAt: SavedAtSchema,
  version: z.literal(CURRENT_STATE_VERSION),
});

const PersistedQueueStateSchema = z.discriminatedUnion("version", [
  QueueStateV1Schema,
  QueueStateV2Schema,
  QueueStateV3Schema,
]);

/**
 * Get the XDG data directory path (~/.local/share/musicd)
 */
function getXdgDataDir(): string {
  const xdgDataHome =
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdgDataHome, XDG_DATA_DIR);
}

/**
 * Get the queue state file path (~/.local/share/musicd/queue.json)
 */
export function getQueueFilePath(): string {
  return join(getXdgDataDir(), XDG_QUEUE_FILE);
}

export interface QueueState {
  queue: QueueItem[];
  queuePosition: number;
  queueMode: QueueMode;
  savedAt: number;
  version: typeof CURRENT_STATE_VERSION;
}

/**
 * Save queue state to disk
 */
export function saveQueueState(
  queue: QueueItem[],
  position: number,
  queueMode: QueueMode = { loop: false, random: false },
): void {
  const data: QueueState = {
    queue,
    queuePosition: position,
    queueMode,
    savedAt: Date.now(),
    version: CURRENT_STATE_VERSION,
  };

  try {
    // Ensure the data directory exists
    const dataDir = getXdgDataDir();
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    const queuePath = getQueueFilePath();
    writeFileSync(queuePath, JSON.stringify(data, null, 2), "utf-8");
    // Set file permissions to 600 (owner read/write only) for security
    chmodSync(queuePath, 0o600);
  } catch (error) {
    throw new Error(`Failed to save queue state: ${error}`);
  }
}

/**
 * Migrate v1 queue state to v3 by adding the Jellyfin source and queue modes.
 */
function migrateV1toV3(parsed: z.infer<typeof QueueStateV1Schema>): QueueState {
  const migratedQueue: QueueItem[] = parsed.queue.map((item) => ({
    ...item,
    source: "jellyfin" as const,
  }));

  return {
    queue: migratedQueue,
    queuePosition: parsed.queuePosition,
    queueMode: { ...DEFAULT_QUEUE_MODE },
    savedAt: parsed.savedAt,
    version: CURRENT_STATE_VERSION,
  };
}

/**
 * Migrate v2 queue state to v3 by adding queueMode field.
 */
function migrateV2toV3(parsed: z.infer<typeof QueueStateV2Schema>): QueueState {
  return {
    queue: parsed.queue,
    queuePosition: parsed.queuePosition,
    queueMode: { ...DEFAULT_QUEUE_MODE },
    savedAt: parsed.savedAt,
    version: CURRENT_STATE_VERSION,
  };
}

/**
 * Best-effort persistence keeps a valid migrated state usable in memory even
 * when the upgraded file cannot be written.
 */
function resaveMigratedState(state: QueueState): QueueState {
  try {
    saveQueueState(state.queue, state.queuePosition, state.queueMode);
  } catch {
    // Non-fatal: migration still works in memory even if re-save fails
  }
  return state;
}

/**
 * Load queue state from disk
 */
export function loadQueueState(): QueueState | null {
  const queuePath = getQueueFilePath();
  if (!existsSync(queuePath)) {
    return null;
  }

  try {
    const data = readFileSync(queuePath, "utf-8");
    const parsed: unknown = JSON.parse(data);
    const result = PersistedQueueStateSchema.safeParse(parsed);
    if (!result.success) {
      console.warn("Invalid queue state format, ignoring");
      return null;
    }

    if (result.data.version === 1) {
      return resaveMigratedState(migrateV1toV3(result.data));
    }

    if (result.data.version === 2) {
      return resaveMigratedState(migrateV2toV3(result.data));
    }
    return result.data;
  } catch (error) {
    console.warn("Failed to load queue state:", error);
    return null;
  }
}

/**
 * Check if queue state exists
 */
export function hasQueueState(): boolean {
  return existsSync(getQueueFilePath());
}

/**
 * Clear stored queue state
 */
export function clearQueueState(): void {
  const queuePath = getQueueFilePath();
  if (existsSync(queuePath)) {
    try {
      unlinkSync(queuePath);
    } catch (error) {
      console.warn("Failed to clear queue state:", error);
    }
  }
}
