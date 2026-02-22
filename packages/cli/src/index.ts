#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import select from "./select-with-quit.js";
import expandableSelect from "./expandable-select.js";
import {
  loadConfig,
  APP_VERSION,
  getConfigResolutionInfo,
} from "@musicd/shared";
import type { PlaybackStatus } from "@musicd/client";
import { MusicDaemonClient } from "@musicd/client";
import { runSetup } from "./setup.js";
import { logger } from "./logger.js";

const program = new Command();

// Add global --print-logs option
program.option("--print-logs", "Enable debug logging");

// Hook to enable logger before any command runs
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  if (opts.printLogs) {
    logger.enable();
  }
});

// Load config to get daemon URL and password
let daemonUrl: string;
let daemonPassword: string | undefined;

function initializeConfig(): void {
  const info = getConfigResolutionInfo();

  logger.debug("Config resolution:");
  logger.debug(`  Config path: ${info.xdgConfigPath}`);

  if (info.configFile) {
    logger.info(`Config loaded from: ${info.configFile}`);
  } else {
    logger.warn("No config file found, using defaults");
  }

  if (info.envOverrides.length > 0) {
    logger.debug(`Environment overrides: ${info.envOverrides.join(", ")}`);
  }

  try {
    const config = loadConfig();
    daemonUrl = `http://${config.daemon.host}:${config.daemon.port}`;
    daemonPassword = config.daemon.password;
    logger.debug(`Daemon URL: ${daemonUrl}`);
    logger.debug(`Daemon password: ${daemonPassword ? "(set)" : "(not set)"}`);
  } catch (error) {
    logger.warn(`Config load error: ${error}`);
    daemonUrl = "http://127.0.0.1:8765";
    daemonPassword = undefined;
  }
}

// Initialize with defaults first (will be re-initialized in preAction if --print-logs is set)
try {
  const config = loadConfig();
  daemonUrl = `http://${config.daemon.host}:${config.daemon.port}`;
  daemonPassword = config.daemon.password;
} catch (error) {
  daemonUrl = "http://127.0.0.1:8765";
  daemonPassword = undefined;
}

// Hook to log config info and set up client logger when --print-logs is enabled
program.hook("preAction", () => {
  if (logger.isEnabled()) {
    initializeConfig();
    // Pass the logger to the client for request logging
    client.setLogger(logger);
  }
});

// Create client instance (will use the initialized values)
const client = new MusicDaemonClient(daemonUrl, daemonPassword);

/**
 * Format duration in seconds to MM:SS
 */
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// Define CLI commands
program
  .name("musicd")
  .description("CLI for Jellyfin Music Daemon")
  .version(APP_VERSION);

program
  .command("setup")
  .description("Configure Jellyfin authentication")
  .action(async () => {
    await runSetup();
  });

program
  .command("play")
  .description("Search and play music from Jellyfin library")
  .argument("[query]", "Search query (song name, artist, or album)")
  .option("-i, --id <itemId>", "Play directly by Jellyfin item ID")
  .option("-q, --queue", "Add to queue instead of replacing it")
  .action(async (query: string | undefined, options) => {
    try {
      // Validate that either query or --id is provided
      if (!query && !options.id) {
        console.error(
          chalk.red("✗ Error: Either <query> or --id must be provided"),
        );
        console.log(chalk.gray("Usage: musicd play <query> [options]"));
        console.log(chalk.gray("   or: musicd play --id <itemId> [options]"));
        process.exit(1);
      }

      const addToQueue = options.queue || false;
      let selectedItem: any;

      // If --id is provided, skip search and play directly
      if (options.id) {
        // Play directly by ID - we'll queue it and let the daemon handle it
        const result = await client.addToQueue([options.id], {
          clearQueue: !addToQueue,
          playNow: !addToQueue,
        });

        if (addToQueue) {
          console.log(
            chalk.green("✓ Added to queue by ID:"),
            chalk.bold(options.id),
          );
          console.log(
            chalk.gray(
              `  Added ${result.tracksAdded} track${result.tracksAdded === 1 ? "" : "s"}`,
            ),
          );
        } else {
          console.log(chalk.green("▶ Playing by ID:"), chalk.bold(options.id));
          console.log(
            chalk.gray(
              `  Queued ${result.tracksAdded} track${result.tracksAdded === 1 ? "" : "s"}`,
            ),
          );
        }
        return;
      }

      // Search for music
      process.stdout.write(chalk.gray(`🔍 Searching for "${query}"...\n`));
      const searchResult = await client.search(query!);

      if (searchResult.count === 0) {
        console.log(chalk.yellow("✗ No results found"));
        process.exit(1);
      }

      // If only one result, auto-select it
      if (searchResult.count === 1) {
        selectedItem = searchResult.results[0];
        console.log(chalk.gray(`✓ Found 1 match`));
      } else {
        // Multiple results - show interactive expandable selection
        const formatItem = (item: any, isChild: boolean = false) => {
          const parts = [];

          if (!isChild) {
            // Add type indicator for top-level items
            const typeIcon =
              item.type === "Audio"
                ? "🎵"
                : item.type === "MusicAlbum"
                  ? "💿"
                  : item.type === "MusicArtist"
                    ? "👤"
                    : "📀";
            parts.push(typeIcon);
          }

          parts.push(chalk.bold.white(item.name));

          if (item.artist && item.type !== "MusicArtist") {
            parts.push(chalk.cyan(item.artist));
          }

          if (item.album && item.type !== "MusicAlbum") {
            parts.push(chalk.blue(item.album));
          }

          if (item.year) {
            parts.push(chalk.gray(`(${item.year})`));
          }

          if (item.duration > 0) {
            parts.push(chalk.gray(formatDuration(item.duration)));
          }

          return parts.join(" · ");
        };

        const choices = searchResult.results.map((item: any) => ({
          name: formatItem(item),
          value: item,
          expandable: item.type === "MusicAlbum" || item.type === "MusicArtist",
          id: item.id,
        }));

        selectedItem = await expandableSelect({
          message: "Select a song to play (Tab to expand albums/artists):",
          choices,
          onExpand: async (parentItem: any) => {
            // Fetch tracks for this album or artist using proper API endpoints
            if (parentItem.type === "MusicAlbum") {
              const albumResult = await client.getAlbum(parentItem.id);
              return albumResult.tracks.map((track: any) => ({
                name: formatItem(track, true),
                value: track,
                isChild: true,
                parentId: parentItem.id,
                id: track.id,
              }));
            } else if (parentItem.type === "MusicArtist") {
              const artistResult = await client.getArtist(parentItem.id);
              return artistResult.tracks.map((track: any) => ({
                name: formatItem(track, true),
                value: track,
                isChild: true,
                parentId: parentItem.id,
                id: track.id,
              }));
            }
            return [];
          },
        });

        // User quit with 'q'
        if (selectedItem === null) {
          console.log(chalk.gray("Cancelled"));
          process.exit(0);
        }
      }

      // Handle different item types
      if (selectedItem.type === "Audio") {
        // It's a track - add to queue
        const result = await client.addToQueue([selectedItem.id], {
          clearQueue: !addToQueue,
          playNow: !addToQueue,
        });

        if (addToQueue) {
          console.log(
            chalk.green("✓ Added to queue:"),
            chalk.bold(selectedItem.name),
          );
          if (selectedItem.artist) {
            console.log(chalk.gray("  by"), chalk.cyan(selectedItem.artist));
          }
          if (selectedItem.album) {
            console.log(chalk.gray("  from"), chalk.blue(selectedItem.album));
          }
        } else {
          console.log(chalk.green("▶ Playing:"), chalk.bold(selectedItem.name));
          if (selectedItem.artist) {
            console.log(chalk.gray("  by"), chalk.cyan(selectedItem.artist));
          }
          if (selectedItem.album) {
            console.log(chalk.gray("  from"), chalk.blue(selectedItem.album));
          }
        }
      } else if (
        selectedItem.type === "MusicAlbum" ||
        selectedItem.type === "MusicArtist"
      ) {
        // It's an album or artist - queue all tracks and play
        const itemType =
          selectedItem.type === "MusicAlbum" ? "album" : "artist";
        process.stdout.write(
          chalk.gray(
            `🎵 ${addToQueue ? "Adding" : "Queueing"} ${itemType} "${selectedItem.name}"...\n`,
          ),
        );

        const result = await client.addToQueue([selectedItem.id], {
          clearQueue: !addToQueue,
          playNow: !addToQueue,
        });

        if (addToQueue) {
          console.log(
            chalk.green("✓ Added to queue:"),
            chalk.bold(selectedItem.name),
          );
          console.log(
            chalk.gray(
              `  Added ${result.tracksAdded} track${result.tracksAdded === 1 ? "" : "s"}`,
            ),
          );
        } else {
          console.log(chalk.green("▶ Playing:"), chalk.bold(selectedItem.name));
          console.log(
            chalk.gray(
              `  Queued ${result.tracksAdded} track${result.tracksAdded === 1 ? "" : "s"}`,
            ),
          );
        }
      } else {
        console.error(
          chalk.red(`✗ Cannot play item type: ${selectedItem.type}`),
        );
        process.exit(1);
      }
    } catch (error) {
      console.error(
        chalk.red("✗ Failed to play:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("pause")
  .description("Pause playback")
  .action(async () => {
    try {
      await client.pause();
      console.log(chalk.yellow("⏸  Playback paused"));
    } catch (error) {
      console.error(
        chalk.red("✗ Failed to pause:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("resume")
  .description("Resume playback")
  .action(async () => {
    try {
      await client.resume();
      console.log(chalk.green("▶ Playback resumed"));
    } catch (error) {
      console.error(
        chalk.red("✗ Failed to resume:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("stop")
  .description("Stop playback")
  .action(async () => {
    try {
      await client.stop();
      console.log("✓ Playback stopped");
    } catch (error) {
      console.error(
        "✗ Failed to stop:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("search")
  .description("Search for music in Jellyfin library")
  .argument("<query>", "Search query (searches name, artist, and album)")
  .option("-l, --limit <number>", "Maximum number of results", "20")
  .option("--json", "Output results as JSON")
  .action(async (query: string, options) => {
    try {
      const limit = parseInt(options.limit, 10);
      if (isNaN(limit) || limit < 1 || limit > 100) {
        console.error("✗ Limit must be between 1 and 100");
        process.exit(1);
      }

      const result = await client.search(query, limit);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.count === 0) {
        console.log(chalk.yellow(`No results found for "${query}"`));
        return;
      }

      console.log(
        chalk.gray(
          `Found ${result.count} result${result.count === 1 ? "" : "s"}\n`,
        ),
      );

      for (const item of result.results) {
        const parts = [];

        // Add type indicator
        const typeIcon =
          item.type === "Audio"
            ? "🎵"
            : item.type === "MusicAlbum"
              ? "💿"
              : item.type === "MusicArtist"
                ? "👤"
                : "📀";
        parts.push(typeIcon);

        parts.push(chalk.bold.white(item.name));

        if (item.artist) {
          parts.push(chalk.cyan(`by ${item.artist}`));
        }

        if (item.album) {
          parts.push(chalk.blue(`from ${item.album}`));
        }

        if (item.year) {
          parts.push(chalk.gray(`(${item.year})`));
        }

        if (item.duration > 0) {
          parts.push(chalk.gray(formatDuration(item.duration)));
        }

        parts.push(chalk.dim(`[${item.id}]`));

        console.log(parts.join(" "));
      }
    } catch (error) {
      console.error(
        "✗ Search failed:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show current playback status")
  .action(async () => {
    try {
      const status: PlaybackStatus = await client.status();

      if (status.state === "stopped") {
        console.log(chalk.gray("⏸  No playback in progress"));

        // Show queue even if nothing is playing
        if (status.queue.length > 0) {
          console.log(
            chalk.gray(
              `\nQueue: ${status.queue.length} track${status.queue.length === 1 ? "" : "s"}`,
            ),
          );
        }
      } else {
        // Currently playing or paused
        const parts = [];
        parts.push(chalk.bold.white(status.currentItem?.name || "Unknown"));

        if (status.currentItem?.artist) {
          parts.push(chalk.cyan(status.currentItem.artist));
        }

        if (status.currentItem?.album) {
          parts.push(chalk.blue(status.currentItem.album));
        }

        const stateLabel =
          status.state === "paused" ? "⏸  Paused:" : "▶ Playing:";
        const stateColor =
          status.state === "paused" ? chalk.yellow : chalk.green;
        console.log(stateColor(stateLabel), parts.join(" · "));
        console.log(
          chalk.gray(
            `  ${formatDuration(status.position)} / ${formatDuration(status.duration)}`,
          ),
        );

        // Show queue info if there's a queue
        if (status.queue.length > 0) {
          const remaining = status.queue.length - status.queuePosition - 1;
          console.log(
            chalk.gray(
              `  Queue: ${status.queuePosition + 1}/${status.queue.length}${remaining > 0 ? ` (${remaining} remaining)` : ""}`,
            ),
          );
        }
      }
    } catch (error) {
      console.error(
        chalk.red("✗ Failed to get status:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("queue")
  .description("Show queue - select a track to play it")
  .action(async () => {
    try {
      const result = await client.getQueue();

      if (result.count === 0) {
        console.log(chalk.yellow("Queue is empty"));
        return;
      }

      // Build choices for each queue item
      const choices = result.queue.map((item: any, index: number) => {
        const isCurrent = index === result.position;
        const parts = [];

        // Current track indicator
        const prefix = isCurrent ? chalk.green("▶") : " ";
        parts.push(prefix);

        // Track number
        parts.push(chalk.gray(`${(index + 1).toString().padStart(2, " ")}.`));

        // Track name
        parts.push(chalk.bold.white(item.name));

        // Artist
        if (item.artist) {
          parts.push(chalk.cyan(item.artist));
        }

        // Album
        if (item.album) {
          parts.push(chalk.blue(item.album));
        }

        // Duration
        if (item.duration > 0) {
          parts.push(chalk.gray(formatDuration(item.duration)));
        }

        return {
          name: parts.join(" · "),
          value: index,
        };
      });

      const selectedIndex = await select({
        message: `Queue (${result.count} track${result.count === 1 ? "" : "s"}) - Select track to play:`,
        choices,
      });

      // User quit with 'q'
      if (selectedIndex === null) {
        console.log(chalk.gray("Cancelled"));
        return;
      }

      // Play from the selected queue position
      try {
        const playResult = await client.playFromQueue(selectedIndex);
        if (playResult.item) {
          console.log(
            chalk.green("▶ Playing:"),
            chalk.bold(playResult.item.name),
          );
        }
        console.log(
          chalk.gray(
            `  Queue: ${playResult.position + 1}/${playResult.queueLength}`,
          ),
        );
      } catch (error) {
        console.error(
          chalk.red("✗ Failed to play:"),
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    } catch (error) {
      console.error(
        chalk.red("✗ Queue error:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("queue-clear")
  .description("Clear the queue")
  .action(async () => {
    try {
      await client.clearQueue();
      console.log(chalk.green("✓ Queue cleared"));
    } catch (error) {
      console.error(
        chalk.red("✗ Failed to clear queue:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("next")
  .description("Skip to next song in queue")
  .action(async () => {
    try {
      await client.playNext();
      console.log(chalk.green("⏭  Skipped to next song"));
    } catch (error) {
      console.error(
        chalk.red("✗ Failed to skip:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("previous")
  .description("Go to previous song in queue")
  .action(async () => {
    try {
      await client.playPrevious();
      console.log(chalk.green("⏮  Went to previous song"));
    } catch (error) {
      console.error(
        chalk.red("✗ Failed to go back:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

// Parse arguments
program.parse();
