import { Hono } from "hono";
import type { Context, Next } from "hono";
import { z } from "zod";
import type { JellyfinService } from "../services/jellyfin";
import { YouTubeService } from "../services/youtube";
import type { PlayerService } from "../services/player";
import {
  JellyfinError,
  PlayerError,
  YouTubeError,
  APP_VERSION,
} from "@musicd/shared";
import type { QueueItem } from "@musicd/shared";

const PlayRequestSchema = z.object({
  itemId: z.string().min(1, "Item ID is required"),
});

const QueueAddRequestSchema = z.object({
  itemIds: z
    .array(z.string().min(1))
    .min(1, "At least one item ID is required"),
  clearQueue: z.boolean().optional().default(false),
  playNow: z.boolean().optional().default(false),
});

/**
 * Authentication middleware for Bearer token validation
 * Validates the Authorization header against the configured daemon password
 */
function createAuthMiddleware(requiredPassword?: string) {
  return async (c: Context, next: Next) => {
    // Health endpoint is always public
    if (c.req.path === "/health") {
      return next();
    }

    // If no password is configured, skip authentication
    if (!requiredPassword) {
      return next();
    }

    const authHeader = c.req.header("Authorization");

    if (!authHeader) {
      return c.json(
        {
          success: false,
          error: "Authentication required. Missing Authorization header.",
        },
        401,
      );
    }

    // Check Bearer token format
    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return c.json(
        {
          success: false,
          error:
            "Invalid Authorization header format. Expected: Bearer <password>",
        },
        401,
      );
    }

    const providedPassword = parts[1];

    // Constant-time comparison to prevent timing attacks
    if (providedPassword !== requiredPassword) {
      return c.json(
        {
          success: false,
          error: "Invalid authentication credentials.",
        },
        401,
      );
    }

    // Authentication successful
    return next();
  };
}

export function createApiRoutes(
  jellyfinService: JellyfinService,
  youtubeService: YouTubeService,
  playerService: PlayerService,
  startTime: number,
  daemonPassword?: string,
  ytDlpAvailable: boolean = false,
) {
  const app = new Hono();

  // Apply authentication middleware to all routes
  const authMiddleware = createAuthMiddleware(daemonPassword);
  app.use("*", authMiddleware);

  /**
   * POST /api/auth - Authenticate with Jellyfin
   * Used by CLI setup command instead of direct JellyfinService import
   */
  app.post("/auth", async (c) => {
    try {
      const body = await c.req.json();
      const { username, password } = z
        .object({
          username: z.string().min(1),
          password: z.string().min(1),
        })
        .parse(body);

      const result = await jellyfinService.authenticate(username, password);

      return c.json({
        success: true,
        user: {
          id: result.User.Id,
          name: result.User.Name,
        },
      });
    } catch (error) {
      if (error instanceof JellyfinError) {
        return c.json(
          { success: false, error: error.message },
          (error.statusCode || 500) as 401 | 500,
        );
      }
      return c.json({ success: false, error: "Authentication failed" }, 500);
    }
  });

  /**
   * POST /api/play - Smart play command or play specific item
   * Without itemId: Smart play (resume if paused, play from queue if stopped)
   * With itemId: Add item to queue and start playing
   */
  app.post("/play", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));

      // If no itemId provided, do smart play
      if (!body.itemId) {
        await playerService.play();
        const status = await playerService.getStatus();

        return c.json({
          success: true,
          message:
            status.state === "playing"
              ? "Playback started"
              : "Playback resumed",
          state: status.state,
          currentItem: status.currentItem,
        });
      }

      // Otherwise, play specific item (add to queue and play)
      const { itemId } = PlayRequestSchema.parse(body);

      // Auto-detect YouTube URLs
      if (YouTubeService.isYouTubeUrl(itemId)) {
        if (!ytDlpAvailable) {
          return c.json(
            {
              success: false,
              error: "YouTube playback unavailable: yt-dlp is not installed",
            },
            503,
          );
        }

        const queueItem = await youtubeService.createQueueItem(itemId);
        playerService.addItems([queueItem], true);
        await playerService.playFromQueue(0);

        return c.json({
          success: true,
          message: "Playing YouTube video",
          item: {
            id: queueItem.id,
            name: queueItem.name,
            artist: queueItem.artist,
            source: "youtube",
          },
        });
      }

      // Jellyfin item: get metadata, add to queue, and play
      const item = await jellyfinService.getItem(itemId);

      playerService.addJellyfinItems([item], true);
      await playerService.playFromQueue(0);

      return c.json({
        success: true,
        message: "Playback started",
        item: {
          id: item.Id,
          name: item.Name,
          artist: item.Artists?.[0],
          album: item.Album,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json(
          {
            success: false,
            error: "Invalid request",
            details: error.errors,
          },
          400,
        );
      }

      if (error instanceof JellyfinError) {
        const statusCode = (error.statusCode || 500) as 500 | 404 | 400 | 401;
        return c.json(
          {
            success: false,
            error: error.message,
          },
          statusCode,
        );
      }

      if (error instanceof YouTubeError) {
        return c.json(
          {
            success: false,
            error: error.message,
          },
          502,
        );
      }

      if (error instanceof PlayerError) {
        return c.json(
          {
            success: false,
            error: error.message,
          },
          500,
        );
      }

      console.error("Unexpected error in /play:", error);
      return c.json(
        {
          success: false,
          error: "Internal server error",
        },
        500,
      );
    }
  });

  /**
   * POST /api/pause - Pause playback
   */
  app.post("/pause", async (c) => {
    try {
      playerService.pause();

      return c.json({
        success: true,
        message: "Playback paused",
      });
    } catch (error) {
      if (error instanceof PlayerError) {
        return c.json(
          {
            success: false,
            error: error.message,
          },
          400,
        );
      }

      console.error("Unexpected error in /pause:", error);
      return c.json(
        {
          success: false,
          error: "Internal server error",
        },
        500,
      );
    }
  });

  /**
   * POST /api/resume - Resume playback
   */
  app.post("/resume", async (c) => {
    try {
      await playerService.resume();
      const status = await playerService.getStatus();
      return c.json({
        success: true,
        message:
          status.state === "playing" ? "Playback resumed" : "Nothing to resume",
      });
    } catch (error) {
      if (error instanceof PlayerError) {
        return c.json(
          {
            success: false,
            error: error.message,
          },
          400,
        );
      }

      console.error("Unexpected error in /resume:", error);
      return c.json(
        {
          success: false,
          error: "Internal server error",
        },
        500,
      );
    }
  });

  /**
   * POST /api/stop - Stop playback
   */
  app.post("/stop", async (c) => {
    try {
      if (!playerService.isPlaying()) {
        return c.json(
          {
            success: false,
            error: "No playback in progress",
          },
          400,
        );
      }

      await playerService.stop();

      return c.json({
        success: true,
        message: "Playback stopped",
      });
    } catch (error) {
      if (error instanceof PlayerError) {
        return c.json(
          {
            success: false,
            error: error.message,
          },
          500,
        );
      }

      console.error("Unexpected error in /stop:", error);
      return c.json(
        {
          success: false,
          error: "Internal server error",
        },
        500,
      );
    }
  });

  /**
   * GET /api/status - Get playback status
   */
  app.get("/status", async (c) => {
    try {
      const status = await playerService.getStatus();
      return c.json(status);
    } catch (error) {
      console.error("Error getting status:", error);
      return c.json(
        {
          success: false,
          error: "Failed to get status",
        },
        500,
      );
    }
  });

  /**
   * POST /api/queue/add - Add items to queue
   * Accepts Jellyfin item IDs and YouTube URLs in the same request
   */
  app.post("/queue/add", async (c) => {
    try {
      const body = await c.req.json();
      const { itemIds, clearQueue, playNow } =
        QueueAddRequestSchema.parse(body);

      // Partition into YouTube URLs and Jellyfin IDs
      const youtubeUrls: string[] = [];
      const jellyfinIds: string[] = [];

      for (const id of itemIds) {
        if (YouTubeService.isYouTubeUrl(id)) {
          youtubeUrls.push(id);
        } else {
          jellyfinIds.push(id);
        }
      }

      // Check yt-dlp availability if YouTube URLs are present
      if (youtubeUrls.length > 0 && !ytDlpAvailable) {
        return c.json(
          {
            success: false,
            error: "YouTube playback unavailable: yt-dlp is not installed",
          },
          503,
        );
      }

      // Resolve all items in order, preserving the original sequence
      const allQueueItems: QueueItem[] = [];

      for (const id of itemIds) {
        if (YouTubeService.isYouTubeUrl(id)) {
          // YouTube URL: create queue item via yt-dlp
          const queueItem = await youtubeService.createQueueItem(id);
          allQueueItems.push(queueItem);
        } else {
          // Jellyfin ID: fetch item and expand albums/artists
          const item = await jellyfinService.getItem(id);

          if (item.Type === "MusicAlbum") {
            const tracks = await jellyfinService.getAlbumTracks(item.Id);
            for (const track of tracks) {
              allQueueItems.push({
                id: track.Id,
                name: track.Name,
                artist: track.Artists?.[0],
                album: track.Album,
                duration: track.RunTimeTicks
                  ? track.RunTimeTicks / 10000000
                  : 0,
                source: "jellyfin",
                jellyfinItem: track,
              });
            }
          } else if (item.Type === "MusicArtist") {
            const tracks = await jellyfinService.getArtistTracks(item.Id);
            for (const track of tracks) {
              allQueueItems.push({
                id: track.Id,
                name: track.Name,
                artist: track.Artists?.[0],
                album: track.Album,
                duration: track.RunTimeTicks
                  ? track.RunTimeTicks / 10000000
                  : 0,
                source: "jellyfin",
                jellyfinItem: track,
              });
            }
          } else if (item.Type === "Audio") {
            allQueueItems.push({
              id: item.Id,
              name: item.Name,
              artist: item.Artists?.[0],
              album: item.Album,
              duration: item.RunTimeTicks ? item.RunTimeTicks / 10000000 : 0,
              source: "jellyfin",
              jellyfinItem: item,
            });
          }
        }
      }

      if (allQueueItems.length === 0) {
        return c.json(
          {
            success: false,
            error: "No playable tracks found",
          },
          400,
        );
      }

      // Add to queue
      playerService.addItems(allQueueItems, clearQueue);

      // Play now if requested, OR if nothing is currently playing
      if (playNow || !playerService.isPlaying()) {
        await playerService.playFromQueue(0);
      }

      return c.json({
        success: true,
        message: `Added ${allQueueItems.length} track${allQueueItems.length === 1 ? "" : "s"} to queue`,
        tracksAdded: allQueueItems.length,
        queue: playerService.getQueue(),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json(
          {
            success: false,
            error: "Invalid request",
            details: error.errors,
          },
          400,
        );
      }

      if (error instanceof JellyfinError) {
        const statusCode = (error.statusCode || 500) as 500 | 404 | 400 | 401;
        return c.json(
          {
            success: false,
            error: error.message,
          },
          statusCode,
        );
      }

      if (error instanceof YouTubeError) {
        return c.json(
          {
            success: false,
            error: error.message,
          },
          502,
        );
      }

      if (error instanceof PlayerError) {
        return c.json(
          {
            success: false,
            error: error.message,
          },
          500,
        );
      }

      console.error("Unexpected error in /queue/add:", error);
      return c.json(
        {
          success: false,
          error: "Internal server error",
        },
        500,
      );
    }
  });

  /**
   * GET /api/queue - Get current queue
   */
  app.get("/queue", async (c) => {
    try {
      const queue = playerService.getQueue();
      const position = playerService.getQueuePosition();

      return c.json({
        success: true,
        queue,
        position,
        count: queue.length,
      });
    } catch (error) {
      console.error("Error getting queue:", error);
      return c.json(
        {
          success: false,
          error: "Failed to get queue",
        },
        500,
      );
    }
  });

  /**
   * POST /api/queue/clear - Clear the queue
   */
  app.post("/queue/clear", async (c) => {
    try {
      playerService.clearQueue();

      return c.json({
        success: true,
        message: "Queue cleared",
      });
    } catch (error) {
      console.error("Error clearing queue:", error);
      return c.json(
        {
          success: false,
          error: "Failed to clear queue",
        },
        500,
      );
    }
  });

  /**
   * POST /api/queue/next - Play next song in queue
   * Now works when stopped (starts next track) and stops at end of queue
   */
  app.post("/queue/next", async (c) => {
    try {
      await playerService.playNext();
      const status = await playerService.getStatus();

      return c.json({
        success: true,
        message:
          status.state === "stopped"
            ? "End of queue reached"
            : "Playing next song",
        state: status.state,
        currentItem: status.currentItem,
      });
    } catch (error) {
      if (error instanceof PlayerError) {
        return c.json(
          {
            success: false,
            error: error.message,
          },
          500,
        );
      }

      console.error("Unexpected error in /queue/next:", error);
      return c.json(
        {
          success: false,
          error: "Internal server error",
        },
        500,
      );
    }
  });

  /**
   * POST /api/queue/previous - Play previous song in queue
   * Now works when stopped and restarts current track at position 0
   */
  app.post("/queue/previous", async (c) => {
    try {
      await playerService.playPrevious();
      const status = await playerService.getStatus();

      return c.json({
        success: true,
        message:
          status.state === "stopped"
            ? "At beginning of queue"
            : "Playing previous song",
        state: status.state,
        currentItem: status.currentItem,
      });
    } catch (error) {
      if (error instanceof PlayerError) {
        return c.json(
          {
            success: false,
            error: error.message,
          },
          500,
        );
      }

      console.error("Unexpected error in /queue/previous:", error);
      return c.json(
        {
          success: false,
          error: "Internal server error",
        },
        500,
      );
    }
  });

  /**
   * POST /api/queue/remove/:index - Remove item from queue by index
   */
  app.post("/queue/remove/:index", async (c) => {
    try {
      const indexStr = c.req.param("index");
      const index = parseInt(indexStr, 10);

      if (isNaN(index)) {
        return c.json(
          {
            success: false,
            error: "Invalid index parameter",
          },
          400,
        );
      }

      playerService.removeFromQueue(index);

      return c.json({
        success: true,
        message: `Removed item at index ${index} from queue`,
        queue: playerService.getQueue(),
        position: playerService.getQueuePosition(),
      });
    } catch (error) {
      if (error instanceof PlayerError) {
        return c.json(
          {
            success: false,
            error: error.message,
          },
          400,
        );
      }

      console.error("Unexpected error in /queue/remove:", error);
      return c.json(
        {
          success: false,
          error: "Internal server error",
        },
        500,
      );
    }
  });

  /**
   * POST /api/queue/play/:index - Play from specific queue position
   */
  app.post("/queue/play/:index", async (c) => {
    try {
      const indexStr = c.req.param("index");
      const index = parseInt(indexStr, 10);

      if (isNaN(index)) {
        return c.json(
          {
            success: false,
            error: "Invalid index parameter",
          },
          400,
        );
      }

      await playerService.playFromQueue(index);

      const queue = playerService.getQueue();
      const item = queue[index];

      return c.json({
        success: true,
        message: `Playing from queue position ${index + 1}`,
        item: item
          ? {
              name: item.name,
              artist: item.artist,
              album: item.album,
            }
          : null,
        position: index,
        queueLength: queue.length,
      });
    } catch (error) {
      if (error instanceof PlayerError) {
        return c.json(
          {
            success: false,
            error: error.message,
          },
          400,
        );
      }

      console.error("Unexpected error in /queue/play:", error);
      return c.json(
        {
          success: false,
          error: "Internal server error",
        },
        500,
      );
    }
  });

  /**
   * GET /api/search - Search for music items
   */
  app.get("/search", async (c) => {
    try {
      const query = c.req.query("q");
      const limitStr = c.req.query("limit");

      if (!query) {
        return c.json(
          {
            success: false,
            error: 'Query parameter "q" is required',
          },
          400,
        );
      }

      const limit = limitStr ? parseInt(limitStr, 10) : 20;
      if (isNaN(limit) || limit < 1 || limit > 100) {
        return c.json(
          {
            success: false,
            error: "Limit must be between 1 and 100",
          },
          400,
        );
      }

      const results = await jellyfinService.search(query, limit);

      return c.json({
        success: true,
        query,
        count: results.length,
        results: results.map((item) => ({
          id: item.Id,
          name: item.Name,
          type: item.Type,
          artist: item.Artists?.[0] || item.AlbumArtist,
          album: item.Album,
          duration: item.RunTimeTicks
            ? Math.floor(item.RunTimeTicks / 10000000)
            : 0,
          year: item.ProductionYear,
        })),
      });
    } catch (error) {
      if (error instanceof JellyfinError) {
        const statusCode = (error.statusCode || 500) as 500 | 404 | 400 | 401;
        return c.json(
          {
            success: false,
            error: error.message,
          },
          statusCode,
        );
      }

      console.error("Error searching:", error);
      return c.json(
        {
          success: false,
          error: "Search failed",
        },
        500,
      );
    }
  });

  /**
   * GET /api/album/:id - Get album info with tracks
   */
  app.get("/album/:id", async (c) => {
    try {
      const albumId = c.req.param("id");

      if (!albumId) {
        return c.json(
          {
            success: false,
            error: "Album ID is required",
          },
          400,
        );
      }

      // Get album metadata
      const album = await jellyfinService.getItem(albumId);

      if (album.Type !== "MusicAlbum") {
        return c.json(
          {
            success: false,
            error: "Item is not an album",
          },
          400,
        );
      }

      // Get all tracks from the album
      const tracks = await jellyfinService.getAlbumTracks(albumId);

      return c.json({
        success: true,
        album: {
          id: album.Id,
          name: album.Name,
          artist: album.AlbumArtist || album.Artists?.[0],
          type: album.Type,
        },
        tracks: tracks.map((track) => ({
          id: track.Id,
          name: track.Name,
          type: track.Type,
          artist: track.Artists?.[0],
          album: track.Album,
          duration: track.RunTimeTicks
            ? Math.floor(track.RunTimeTicks / 10000000)
            : 0,
          year: track.ProductionYear,
          indexNumber: track.IndexNumber,
        })),
        count: tracks.length,
      });
    } catch (error) {
      if (error instanceof JellyfinError) {
        const statusCode = (error.statusCode || 500) as 500 | 404 | 400 | 401;
        return c.json(
          {
            success: false,
            error: error.message,
          },
          statusCode,
        );
      }

      console.error("Error getting album tracks:", error);
      return c.json(
        {
          success: false,
          error: "Failed to get album tracks",
        },
        500,
      );
    }
  });

  /**
   * GET /api/artist/:id - Get artist info with tracks
   */
  app.get("/artist/:id", async (c) => {
    try {
      const artistId = c.req.param("id");

      if (!artistId) {
        return c.json(
          {
            success: false,
            error: "Artist ID is required",
          },
          400,
        );
      }

      // Get artist metadata
      const artist = await jellyfinService.getItem(artistId);

      if (artist.Type !== "MusicArtist") {
        return c.json(
          {
            success: false,
            error: "Item is not an artist",
          },
          400,
        );
      }

      // Get all tracks from the artist
      const tracks = await jellyfinService.getArtistTracks(artistId);

      return c.json({
        success: true,
        artist: {
          id: artist.Id,
          name: artist.Name,
          type: artist.Type,
        },
        tracks: tracks.map((track) => ({
          id: track.Id,
          name: track.Name,
          type: track.Type,
          artist: track.Artists?.[0],
          album: track.Album,
          duration: track.RunTimeTicks
            ? Math.floor(track.RunTimeTicks / 10000000)
            : 0,
          year: track.ProductionYear,
        })),
        count: tracks.length,
      });
    } catch (error) {
      if (error instanceof JellyfinError) {
        const statusCode = (error.statusCode || 500) as 500 | 404 | 400 | 401;
        return c.json(
          {
            success: false,
            error: error.message,
          },
          statusCode,
        );
      }

      console.error("Error getting artist tracks:", error);
      return c.json(
        {
          success: false,
          error: "Failed to get artist tracks",
        },
        500,
      );
    }
  });

  /**
   * GET /health - Health check endpoint (no auth required)
   */
  app.get("/health", async (c) => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    return c.json({
      success: true,
      status: "healthy",
      uptime,
      version: APP_VERSION,
    });
  });

  return app;
}
