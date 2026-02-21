#!/usr/bin/env bun
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { loadConfig } from '../shared/config.js';
import { JellyfinService } from './services/jellyfin.js';
import { PlayerService } from './services/player.js';
import { createApiRoutes } from './api/routes.js';
import { hasAuth } from '../shared/token-storage.js';

async function main() {
  console.log('🎵 Starting Jellyfin Music Daemon...');

  // Check if setup has been completed
  if (!hasAuth()) {
    console.error('✗ Not configured. Please run setup first:');
    console.error('  bun run cli setup');
    process.exit(1);
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
    console.error('✗ Failed to load configuration:', error);
    process.exit(1);
  }

  // Initialize services
  const jellyfinService = new JellyfinService(config.jellyfin);
  const playerService = new PlayerService(config.audio.device);
  const startTime = Date.now();

  // Verify connection to Jellyfin
  try {
    await jellyfinService.verifyConnection();
    console.log('✓ Connected to Jellyfin server');
  } catch (error) {
    console.error('✗ Failed to connect to Jellyfin:', error);
    console.error('  Your authentication may have expired. Try running setup again:');
    console.error('  bun run cli setup --force');
    process.exit(1);
  }

  // Create Hono app
  const app = new Hono();

  // Add logger middleware
  app.use('*', logger());

  // Mount API routes
  app.route('/api', createApiRoutes(jellyfinService, playerService, startTime));

  // Root endpoint
  app.get('/', (c) => {
    return c.json({
      name: 'Jellyfin Music Daemon',
      version: '0.1.0',
      status: 'running',
    });
  });

  // Start server
  const server = Bun.serve({
    port: config.daemon.port,
    hostname: config.daemon.host,
    fetch: app.fetch,
  });

  console.log(`✓ Server started at http://${config.daemon.host}:${config.daemon.port}`);
  console.log('\nAPI Endpoints:');
  console.log(`  POST /api/play     - Play a Jellyfin item`);
  console.log(`  POST /api/stop     - Stop playback`);
  console.log(`  GET  /api/status   - Get playback status`);
  console.log(`  GET  /api/health   - Check daemon health`);
  console.log('\nPress Ctrl+C to stop');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    
    // Stop playback if active
    if (playerService.isPlaying()) {
      try {
        await playerService.stop();
        console.log('✓ Stopped playback');
      } catch (error) {
        console.error('✗ Error stopping playback:', error);
      }
    }

    server.stop();
    console.log('✓ Server stopped');
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
