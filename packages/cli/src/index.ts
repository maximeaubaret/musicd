#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import select from "./select-with-quit";
import expandableSelect from "./expandable-select";
import { resolveDaemonConnection, APP_VERSION } from "@musicd/shared";
import type { QueueItem } from "@musicd/shared";
import type { PlaybackStatus, SearchResult, TrackInfo } from "@musicd/client";
import { MusicDaemonClient } from "@musicd/client";
import { runSetup } from "./setup";
import { logger } from "./logger";

const program = new Command();

// Global options for daemon connection
program
  .option("--print-logs", "Enable debug logging")
  .option("--host <host>", "Daemon host address")
  .option("--port <port>", "Daemon port", (val) => parseInt(val, 10))
  .option("--password <password>", "Daemon password")
  .option("-p, --profile <name>", "Use named connection profile")
  .option("--json", "Output results as JSON");

// Client instance (lazily initialized per command)
let _client: MusicDaemonClient | null = null;

/**
 * Get or create the daemon client based on global options
 */
function getClient(): MusicDaemonClient {
  if (_client) return _client;

  const opts = program.opts();
  const connection = resolveDaemonConnection({
    host: opts.host,
    port: opts.port,
    password: opts.password,
    profile: opts.profile,
  });

  const baseUrl = `http://${connection.host}:${connection.port}`;

  logger.debug("Daemon connection:");
  logger.debug(`  URL: ${baseUrl}`);
  logger.debug(`  Profile: ${connection.profileName || "(none)"}`);
  logger.debug(`  Password: ${connection.password ? "(set)" : "(not set)"}`);

  _client = new MusicDaemonClient(baseUrl, connection.password);

  if (logger.isEnabled()) {
    _client.setLogger(logger);
  }

  return _client;
}

/**
 * Check if --json flag is set on the global program options.
 */
function isJsonMode(): boolean {
  return program.opts().json === true;
}

/**
 * Output data as formatted JSON to stdout and exit.
 * Used by all commands when --json flag is set.
 */
function outputJson(data: unknown): never {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

/**
 * Output an error as JSON to stderr and exit with code 1.
 * Used by command error handlers when --json flag is set.
 */
function outputJsonError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

// Hook to enable logger before any command
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  if (opts.printLogs) {
    logger.enable();
  }
});

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
    const opts = program.opts();
    await runSetup({
      host: opts.host,
      port: opts.port,
      password: opts.password,
      profile: opts.profile,
    });
  });

program
  .command("browse")
  .alias("b")
  .description("Interactive search and play music")
  .argument("[query]", "Search query (song name, artist, or album)")
  .option("-q, --queue", "Add to queue instead of replacing it")
  .action(async (query: string | undefined, options) => {
    try {
      const addToQueue = options.queue || false;
      let selectedItem: SearchResult | null;

      // Search for music
      if (!isJsonMode()) {
        if (query) {
          process.stdout.write(chalk.gray(`🔍 Searching for "${query}"...\n`));
        } else {
          process.stdout.write(chalk.gray(`🔍 Browsing music library...\n`));
        }
      }

      const searchResult = await getClient().search(query || "");

      if (isJsonMode()) {
        outputJson(searchResult);
      }

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
        const formatItem = (
          item: SearchResult | TrackInfo,
          isChild: boolean = false,
        ) => {
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

        const choices = searchResult.results.map((item) => ({
          name: formatItem(item),
          value: item,
          expandable: item.type === "MusicAlbum" || item.type === "MusicArtist",
          id: item.id,
        }));

        selectedItem = await expandableSelect({
          message: "Select a song to play (Tab to expand albums/artists):",
          choices,
          onExpand: async (parentItem: SearchResult) => {
            // Fetch tracks for this album or artist using proper API endpoints
            if (parentItem.type === "MusicAlbum") {
              const albumResult = await getClient().getAlbum(parentItem.id);
              return albumResult.tracks.map((track) => ({
                name: formatItem(track, true),
                value: track,
                isChild: true,
                parentId: parentItem.id,
                id: track.id,
              }));
            } else if (parentItem.type === "MusicArtist") {
              const artistResult = await getClient().getArtist(parentItem.id);
              return artistResult.tracks.map((track) => ({
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
        await getClient().addToQueue([selectedItem.id], {
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

        const result = await getClient().addToQueue([selectedItem.id], {
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
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to browse:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("play")
  .alias("p")
  .description("Play/resume current queue")
  .action(async () => {
    try {
      const result = await getClient().resume();
      if (isJsonMode()) {
        outputJson(result);
      }
      console.log(chalk.green("▶ Playback resumed"));
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to play:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("pause")
  .alias("pp")
  .description("Pause playback")
  .action(async () => {
    try {
      const result = await getClient().pause();
      if (isJsonMode()) {
        outputJson(result);
      }
      console.log(chalk.yellow("⏸  Playback paused"));
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to pause:"),
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
      const result = await getClient().stop();
      if (isJsonMode()) {
        outputJson(result);
      }
      console.log("✓ Playback stopped");
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
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
  .action(async (query: string, options) => {
    try {
      const limit = parseInt(options.limit, 10);
      if (isNaN(limit) || limit < 1 || limit > 100) {
        console.error("✗ Limit must be between 1 and 100");
        process.exit(1);
      }

      const result = await getClient().search(query, limit);

      if (isJsonMode()) {
        outputJson(result);
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
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        "✗ Search failed:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("status")
  .alias("s")
  .description("Show current playback status")
  .action(async () => {
    try {
      const status: PlaybackStatus = await getClient().status();

      if (isJsonMode()) {
        outputJson(status);
      }

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
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to get status:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

// Queue parent command with subcommands
const queueCmd = program
  .command("queue")
  .alias("q")
  .description("Manage playback queue")
  .action(async () => {
    // Default action: show queue (same as 'queue show')
    try {
      const result = await getClient().getQueue();

      if (isJsonMode()) {
        outputJson(result);
      }

      if (result.count === 0) {
        console.log(chalk.yellow("Queue is empty"));
        return;
      }

      // Build choices for each queue item
      const choices = result.queue.map((item: QueueItem, index: number) => {
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
        const playResult = await getClient().playFromQueue(selectedIndex);
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
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Queue error:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

queueCmd
  .command("show")
  .alias("ls")
  .description("Show queue")
  .action(async () => {
    // Same implementation as default queue action
    try {
      const result = await getClient().getQueue();

      if (isJsonMode()) {
        outputJson(result);
      }

      if (result.count === 0) {
        console.log(chalk.yellow("Queue is empty"));
        return;
      }

      // Build choices for each queue item
      const choices = result.queue.map((item: QueueItem, index: number) => {
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
        const playResult = await getClient().playFromQueue(selectedIndex);
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
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Queue error:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

queueCmd
  .command("clear")
  .description("Clear the queue")
  .action(async () => {
    try {
      const result = await getClient().clearQueue();
      if (isJsonMode()) {
        outputJson(result);
      }
      console.log(chalk.green("✓ Queue cleared"));
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to clear queue:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

queueCmd
  .command("add")
  .description("Add to queue by search query or ID")
  .argument("[query]", "Search query")
  .option("-i, --id <itemId>", "Add by Jellyfin item ID")
  .action(async (query: string | undefined, options) => {
    try {
      // Validate that either query or --id is provided
      if (!query && !options.id) {
        console.error(
          chalk.red("✗ Error: Either <query> or --id must be provided"),
        );
        console.log(chalk.gray("Usage: musicd queue add <query>"));
        console.log(chalk.gray("   or: musicd queue add --id <itemId>"));
        process.exit(1);
      }

      // If --id is provided, add directly by ID
      if (options.id) {
        const result = await getClient().addToQueue([options.id], {
          clearQueue: false,
          playNow: false,
        });

        if (isJsonMode()) {
          outputJson(result);
        }

        console.log(
          chalk.green("✓ Added to queue by ID:"),
          chalk.bold(options.id),
        );
        console.log(
          chalk.gray(
            `  Added ${result.tracksAdded} track${result.tracksAdded === 1 ? "" : "s"}`,
          ),
        );
        return;
      }

      // Search for music
      if (!isJsonMode()) {
        process.stdout.write(chalk.gray(`🔍 Searching for "${query}"...\n`));
      }
      const searchResult = await getClient().search(query!);

      if (isJsonMode()) {
        outputJson(searchResult);
      }

      if (searchResult.count === 0) {
        console.log(chalk.yellow("✗ No results found"));
        process.exit(1);
      }

      let selectedItem: SearchResult | null;

      // If only one result, auto-select it
      if (searchResult.count === 1) {
        selectedItem = searchResult.results[0];
        console.log(chalk.gray(`✓ Found 1 match`));
      } else {
        // Multiple results - show interactive expandable selection
        const formatItem = (
          item: SearchResult | TrackInfo,
          isChild: boolean = false,
        ) => {
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

        const choices = searchResult.results.map((item) => ({
          name: formatItem(item),
          value: item,
          expandable: item.type === "MusicAlbum" || item.type === "MusicArtist",
          id: item.id,
        }));

        selectedItem = await expandableSelect({
          message:
            "Select item to add to queue (Tab to expand albums/artists):",
          choices,
          onExpand: async (parentItem: SearchResult) => {
            // Fetch tracks for this album or artist using proper API endpoints
            if (parentItem.type === "MusicAlbum") {
              const albumResult = await getClient().getAlbum(parentItem.id);
              return albumResult.tracks.map((track) => ({
                name: formatItem(track, true),
                value: track,
                isChild: true,
                parentId: parentItem.id,
                id: track.id,
              }));
            } else if (parentItem.type === "MusicArtist") {
              const artistResult = await getClient().getArtist(parentItem.id);
              return artistResult.tracks.map((track) => ({
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

      // Add to queue
      const result = await getClient().addToQueue([selectedItem.id], {
        clearQueue: false,
        playNow: false,
      });

      console.log(
        chalk.green("✓ Added to queue:"),
        chalk.bold(selectedItem.name),
      );
      console.log(
        chalk.gray(
          `  Added ${result.tracksAdded} track${result.tracksAdded === 1 ? "" : "s"}`,
        ),
      );
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to add to queue:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("next")
  .alias("n")
  .description("Skip to next song in queue")
  .action(async () => {
    try {
      const result = await getClient().playNext();
      if (isJsonMode()) {
        outputJson(result);
      }
      console.log(chalk.green("⏭  Skipped to next song"));
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to skip:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("previous")
  .alias("prev")
  .description("Go to previous song in queue")
  .action(async () => {
    try {
      const result = await getClient().playPrevious();
      if (isJsonMode()) {
        outputJson(result);
      }
      console.log(chalk.green("⏮  Went to previous song"));
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to go back:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

// Parse arguments
program.parse();
