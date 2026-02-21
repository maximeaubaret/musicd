#!/usr/bin/env bun
import { Command } from 'commander';
import { loadConfig } from '../shared/config.js';
import type { PlaybackStatus, HealthResponse } from '../shared/types.js';
import { runSetup } from './setup.js';

const program = new Command();

// Load config to get daemon URL
let daemonUrl: string;
try {
  const config = loadConfig();
  daemonUrl = `http://${config.daemon.host}:${config.daemon.port}`;
} catch (error) {
  daemonUrl = 'http://127.0.0.1:3000';
}

/**
 * Make API request to daemon
 */
async function apiRequest(
  endpoint: string,
  method: 'GET' | 'POST' = 'GET',
  body?: any
): Promise<any> {
  try {
    const response = await fetch(`${daemonUrl}/api${endpoint}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = (await response.json()) as any;

    if (!response.ok) {
      throw new Error(data.error || `Request failed with status ${response.status}`);
    }

    return data;
  } catch (error) {
    if (error instanceof Error && error.message.includes('fetch failed')) {
      throw new Error(
        `Cannot connect to daemon at ${daemonUrl}. Is it running? Start it with: bun run dev`
      );
    }
    throw error;
  }
}

/**
 * Format duration in seconds to MM:SS
 */
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Define CLI commands
program
  .name('musicd')
  .description('CLI for Jellyfin Music Daemon')
  .version('0.1.0');

program
  .command('setup')
  .description('Configure Jellyfin authentication')
  .option('-f, --force', 'Force reconfiguration even if already set up')
  .action(async (options) => {
    await runSetup(options.force);
  });

program
  .command('play')
  .description('Play a Jellyfin item by ID')
  .argument('<itemId>', 'Jellyfin item ID to play')
  .action(async (itemId: string) => {
    try {
      const result = await apiRequest('/play', 'POST', { itemId });
      
      console.log('✓ Playback started');
      console.log(`  Title: ${result.item.name}`);
      if (result.item.artist) {
        console.log(`  Artist: ${result.item.artist}`);
      }
      if (result.item.album) {
        console.log(`  Album: ${result.item.album}`);
      }
    } catch (error) {
      console.error('✗ Failed to play:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop playback')
  .action(async () => {
    try {
      await apiRequest('/stop', 'POST');
      console.log('✓ Playback stopped');
    } catch (error) {
      console.error('✗ Failed to stop:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('search')
  .description('Search for music in Jellyfin library')
  .argument('<query>', 'Search query (searches name, artist, and album)')
  .option('-l, --limit <number>', 'Maximum number of results', '20')
  .option('--json', 'Output results as JSON')
  .action(async (query: string, options) => {
    try {
      const limit = parseInt(options.limit, 10);
      if (isNaN(limit) || limit < 1 || limit > 100) {
        console.error('✗ Limit must be between 1 and 100');
        process.exit(1);
      }

      const result = await apiRequest(`/search?q=${encodeURIComponent(query)}&limit=${limit}`);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.count === 0) {
        console.log(`No results found for "${query}"`);
        return;
      }

      console.log(`Found ${result.count} result${result.count === 1 ? '' : 's'} for "${query}":\n`);

      for (const item of result.results) {
        console.log(`${item.id}`);
        console.log(`  ${item.name}`);
        if (item.artist) {
          console.log(`  by ${item.artist}`);
        }
        if (item.album) {
          console.log(`  from ${item.album}`);
        }
        if (item.duration > 0) {
          console.log(`  ${formatDuration(item.duration)}`);
        }
        console.log('');
      }
    } catch (error) {
      console.error('✗ Search failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show current playback status')
  .action(async () => {
    try {
      const status: PlaybackStatus = await apiRequest('/status');

      if (status.state === 'stopped') {
        console.log('⏸  No playback in progress');
      } else {
        console.log('▶  Playing:');
        console.log(`  Title: ${status.currentItem?.name}`);
        if (status.currentItem?.artist) {
          console.log(`  Artist: ${status.currentItem.artist}`);
        }
        if (status.currentItem?.album) {
          console.log(`  Album: ${status.currentItem.album}`);
        }
        console.log(
          `  Position: ${formatDuration(status.position)} / ${formatDuration(status.duration)}`
        );
      }
    } catch (error) {
      console.error('✗ Failed to get status:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('health')
  .description('Check daemon health')
  .action(async () => {
    try {
      const health: HealthResponse = await apiRequest('/health');

      console.log(`Status: ${health.status === 'healthy' ? '✓ Healthy' : '✗ Unhealthy'}`);
      console.log(`Daemon version: ${health.daemon.version}`);
      console.log(`Uptime: ${health.daemon.uptime}s`);
      console.log(
        `Jellyfin: ${health.jellyfin.connected ? '✓ Connected' : '✗ Disconnected'} (${health.jellyfin.serverUrl})`
      );

      if (health.status !== 'healthy') {
        process.exit(1);
      }
    } catch (error) {
      console.error('✗ Health check failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Parse arguments
program.parse();
