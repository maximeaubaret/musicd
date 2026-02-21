#!/usr/bin/env bun
import { Command } from 'commander';
import chalk from 'chalk';
import select from './select-with-quit.js';
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
  .description('Search and play music from Jellyfin library')
  .argument('<query>', 'Search query (song name, artist, or album)')
  .option('-l, --limit <number>', 'Maximum number of results to show', '20')
  .action(async (query: string, options) => {
    try {
      const limit = parseInt(options.limit, 10);
      if (isNaN(limit) || limit < 1 || limit > 100) {
        console.error(chalk.red('✗ Limit must be between 1 and 100'));
        process.exit(1);
      }

      // Search for music
      process.stdout.write(chalk.gray(`🔍 Searching for "${query}"...\n`));
      const searchResult = await apiRequest(`/search?q=${encodeURIComponent(query)}&limit=${limit}`);

      if (searchResult.count === 0) {
        console.log(chalk.yellow('✗ No results found'));
        process.exit(1);
      }

      let selectedId: string;

      // If only one result, auto-play it
      if (searchResult.count === 1) {
        const item = searchResult.results[0];
        selectedId = item.id;
        console.log(chalk.gray(`✓ Found 1 match`));
      } else {
        // Multiple results - show interactive selection
        const choices = searchResult.results.map((item: any) => {
          const parts = [chalk.bold.white(item.name)];
          
          if (item.artist) {
            parts.push(chalk.cyan(item.artist));
          }
          
          if (item.album) {
            parts.push(chalk.blue(item.album));
          }
          
          if (item.duration > 0) {
            parts.push(chalk.gray(formatDuration(item.duration)));
          }

          return {
            name: parts.join(' · '),
            value: item.id,
          };
        });

        selectedId = await select({
          message: 'Select a song to play:',
          choices,
        });

        // User quit with 'q'
        if (selectedId === null) {
          console.log(chalk.gray('Cancelled'));
          process.exit(0);
        }
      }

      // Play the selected item
      const result = await apiRequest('/play', 'POST', { itemId: selectedId });
      
      console.log(chalk.green('▶ Playing:'), chalk.bold(result.item.name));
      if (result.item.artist) {
        console.log(chalk.gray('  by'), chalk.cyan(result.item.artist));
      }
      if (result.item.album) {
        console.log(chalk.gray('  from'), chalk.blue(result.item.album));
      }
    } catch (error) {
      console.error(chalk.red('✗ Failed to play:'), error instanceof Error ? error.message : error);
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
        console.log(chalk.yellow(`No results found for "${query}"`));
        return;
      }

      console.log(chalk.gray(`Found ${result.count} result${result.count === 1 ? '' : 's'}\n`));

      for (const item of result.results) {
        const parts = [chalk.bold.white(item.name)];

        if (item.artist) {
          parts.push(chalk.cyan(`by ${item.artist}`));
        }

        if (item.album) {
          parts.push(chalk.blue(`from ${item.album}`));
        }

        if (item.duration > 0) {
          parts.push(chalk.gray(`(${formatDuration(item.duration)})`));
        }

        parts.push(chalk.dim(`[${item.id}]`));

        console.log(parts.join(' '));
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
