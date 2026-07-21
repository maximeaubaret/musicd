import type { JellyfinItem, JellyfinQueueItem } from "./types";

/**
 * Convert playable Jellyfin audio items into musicd queue items.
 */
export function createJellyfinQueueItems(
  items: JellyfinItem[],
): JellyfinQueueItem[] {
  return items.map((item) => ({
    id: item.Id,
    name: item.Name,
    artist: item.Artists?.[0],
    album: item.Album,
    duration: item.RunTimeTicks ? item.RunTimeTicks / 10_000_000 : 0,
    source: "jellyfin",
    jellyfinItem: item,
  }));
}
