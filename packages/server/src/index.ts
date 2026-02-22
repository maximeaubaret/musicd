#!/usr/bin/env bun
import { Hono } from "hono";
import { logger } from "hono/logger";
import { loadConfig, hasAuth } from "@musicd/shared";
import { JellyfinService } from "./services/jellyfin.js";
import { PlayerService } from "./services/player.js";
import { createApiRoutes } from "./api/routes.js";

async function main() {
  console.log("🎵 Starting Jellyfin Music Daemon...");

  const isConfigured = hasAuth();
  if (!isConfigured) {
    console.warn("⚠ Not configured. Run 'bun run cli setup' to authenticate.");
    console.warn("  Starting in setup mode - only /api/auth endpoint available.");
  }

  // Load configuration
  let config;
  try {
    config = loadConfig();
    console.log(`✓ Configuration loaded`);
    console.log(`  - Jellyfin: ${config.jellyfin.serverUrl}`);
    console.log(`  - Daemon: ${config.daemon.host}:${config.daemon.port}`);
    console.log(`  - Audio device: ${config.audio.device}`);
  } catch (error) {
    console.error("✗ Failed to load configuration:", error);
    process.exit(1);
  }

  // Initialize services
  const jellyfinService = new JellyfinService(config.jellyfin);
  const playerService = new PlayerService(config.audio.device);
  const startTime = Date.now();

  // Configure player service with stream URL getter for queue auto-play
  playerService.setStreamUrlGetter((itemId) =>
    jellyfinService.getStreamUrl(itemId),
  );

  // Verify connection to Jellyfin (only if already configured)
  if (isConfigured) {
    try {
      await jellyfinService.verifyConnection();
      console.log("✓ Connected to Jellyfin server");
    } catch (error) {
      console.error("✗ Failed to connect to Jellyfin:", error);
      console.error(
        "  Your authentication may have expired. Try running setup again:",
      );
      console.error("  bun run cli setup --force");
      process.exit(1);
    }
  }

  // Create Hono app
  const app = new Hono();

  // Add logger middleware
  app.use("*", logger());

  // Mount API routes
  app.route("/api", createApiRoutes(jellyfinService, playerService, startTime));

  // Root endpoint
  app.get("/", (c) => {
    return c.json({
      name: "Jellyfin Music Daemon",
      version: "0.1.0",
      status: "running",
    });
  });

  // Start server
  const server = Bun.serve({
    port: config.daemon.port,
    hostname: config.daemon.host,
    fetch: app.fetch,
  });

  console.log(
    `✓ Server started at http://${config.daemon.host}:${config.daemon.port}`,
  );
  console.log("\nAPI Endpoints:");
  console.log(`  POST /api/auth                - Authenticate with Jellyfin`);
  console.log(`  POST /api/play                - Play a Jellyfin item`);
  console.log(`  POST /api/stop                - Stop playback`);
  console.log(`  GET  /api/status              - Get playback status`);
  console.log(`  POST /api/queue/add           - Add items to queue`);
  console.log(`  GET  /api/queue               - Get current queue`);
  console.log(`  POST /api/queue/clear         - Clear queue`);
  console.log(`  POST /api/queue/next          - Skip to next song`);
  console.log(`  POST /api/queue/previous      - Go to previous song`);
  console.log(`  POST /api/queue/play/:index   - Play from queue position`);
  console.log(`  POST /api/queue/remove/:index - Remove item from queue`);
  console.log(`  GET  /api/health              - Check daemon health`);
  console.log("\nPress Ctrl+C to stop");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n🛑 Shutting down...");

    // Stop playback if active
    if (playerService.isPlaying()) {
      try {
        await playerService.stop();
        console.log("✓ Stopped playback");
      } catch (error) {
        console.error("✗ Error stopping playback:", error);
      }
    }

    server.stop();
    console.log("✓ Server stopped");
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
