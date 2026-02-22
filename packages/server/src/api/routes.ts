import { Hono } from "hono";
import { z } from "zod";
import type { JellyfinService } from "../services/jellyfin.js";
import type { PlayerService } from "../services/player.js";
import type {
  PlayRequest,
  HealthResponse,
  QueueAddRequest,
} from "@musicd/shared";
import { JellyfinError, PlayerError, APP_VERSION } from "@musicd/shared";

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

export function createApiRoutes(
  jellyfinService: JellyfinService,
  playerService: PlayerService,
  startTime: number,
) {
  const app = new Hono();

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
   * POST /api/play - Play a Jellyfin item
   */
  app.post("/play", async (c) => {
    try {
      const body = await c.req.json();
      const { itemId } = PlayRequestSchema.parse(body);

      // Get item metadata
      const item = await jellyfinService.getItem(itemId);

      // Get stream URL
      const streamUrl = await jellyfinService.getStreamUrl(itemId);

      // Play the item
      await playerService.play(streamUrl, item);

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
   */
  app.post("/queue/add", async (c) => {
    try {
      const body = await c.req.json();
      const { itemIds, clearQueue, playNow } =
        QueueAddRequestSchema.parse(body);

      // Fetch all items
      const items = await Promise.all(
        itemIds.map((id) => jellyfinService.getItem(id)),
      );

      // Expand albums and artists to their tracks
      const expandedItems = [];
      for (const item of items) {
        if (item.Type === "MusicAlbum") {
          // Get all tracks from the album
          const tracks = await jellyfinService.getAlbumTracks(item.Id);
          expandedItems.push(...tracks);
        } else if (item.Type === "MusicArtist") {
          // Get all tracks from the artist
          const tracks = await jellyfinService.getArtistTracks(item.Id);
          expandedItems.push(...tracks);
        } else if (item.Type === "Audio") {
          // It's already a track
          expandedItems.push(item);
        }
      }

      if (expandedItems.length === 0) {
        return c.json(
          {
            success: false,
            error: "No playable tracks found",
          },
          400,
        );
      }

      // Add to queue
      playerService.addToQueue(expandedItems, clearQueue);

      // Play now if requested
      if (playNow) {
        await playerService.playFromQueue(0);
      }

      return c.json({
        success: true,
        message: `Added ${expandedItems.length} track${expandedItems.length === 1 ? "" : "s"} to queue`,
        tracksAdded: expandedItems.length,
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
   */
  app.post("/queue/next", async (c) => {
    try {
      if (!playerService.hasNext()) {
        return c.json(
          {
            success: false,
            error: "No next song in queue",
          },
          400,
        );
      }

      await playerService.playNext();

      return c.json({
        success: true,
        message: "Playing next song",
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
   */
  app.post("/queue/previous", async (c) => {
    try {
      if (!playerService.hasPrevious()) {
        return c.json(
          {
            success: false,
            error: "No previous song in queue",
          },
          400,
        );
      }

      await playerService.playPrevious();

      return c.json({
        success: true,
        message: "Playing previous song",
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
   * GET /api/health - Check daemon health
   */
  app.get("/health", async (c) => {
    try {
      const jellyfinConnected = await jellyfinService
        .verifyConnection()
        .then(() => true)
        .catch(() => false);

      const health: HealthResponse = {
        status: jellyfinConnected ? "healthy" : "unhealthy",
        daemon: {
          uptime: Math.floor((Date.now() - startTime) / 1000),
          version: APP_VERSION,
        },
        jellyfin: {
          connected: jellyfinConnected,
          serverUrl: jellyfinService["config"].serverUrl,
        },
      };

      return c.json(health);
    } catch (error) {
      console.error("Error checking health:", error);
      return c.json(
        {
          status: "unhealthy",
          error: "Health check failed",
        },
        500,
      );
    }
  });

  return app;
}
