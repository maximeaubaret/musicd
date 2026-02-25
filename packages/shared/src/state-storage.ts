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
import type { QueueItem, JellyfinItem } from "./types";
import { XDG_DATA_DIR, XDG_QUEUE_FILE } from "./constants";

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
  savedAt: number;
  version: number;
}

const CURRENT_STATE_VERSION = 2;

/**
 * Save queue state to disk
 */
export function saveQueueState(queue: QueueItem[], position: number): void {
  const data: QueueState = {
    queue,
    queuePosition: position,
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
 * Migrate v1 queue state to v2 by adding source: "jellyfin" to all items.
 * V1 items always have jellyfinItem but no source field.
 */
function migrateV1toV2(parsed: {
  queue: {
    id: string;
    name: string;
    artist?: string;
    album?: string;
    duration: number;
    jellyfinItem: JellyfinItem;
  }[];
  queuePosition: number;
  savedAt: number;
  version: number;
}): QueueState {
  const migratedQueue: QueueItem[] = parsed.queue.map((item) => ({
    ...item,
    source: "jellyfin" as const,
  }));

  return {
    queue: migratedQueue,
    queuePosition: parsed.queuePosition,
    savedAt: parsed.savedAt,
    version: CURRENT_STATE_VERSION,
  };
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
    const parsed = JSON.parse(data);

    // Basic validation
    if (!parsed.queue || !Array.isArray(parsed.queue)) {
      console.warn("Invalid queue state format, ignoring");
      return null;
    }

    // Check version compatibility
    if (parsed.version > CURRENT_STATE_VERSION) {
      console.warn(
        `Queue state version ${parsed.version} is newer than supported version ${CURRENT_STATE_VERSION}, ignoring`,
      );
      return null;
    }

    // Migrate v1 -> v2: add source: "jellyfin" to all items
    if (parsed.version === 1) {
      const migrated = migrateV1toV2(parsed);
      // Re-save with new version
      try {
        saveQueueState(migrated.queue, migrated.queuePosition);
      } catch {
        // Non-fatal: migration still works in memory even if re-save fails
      }
      return migrated;
    }

    return parsed as QueueState;
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
