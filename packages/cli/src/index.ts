#!/usr/bin/env bun
import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";

import {
  resolveDaemonConnection,
  APP_VERSION,
  isYouTubeUrl,
  DaemonProtocolSchema,
  PortStringSchema,
  SearchLimitStringSchema,
} from "@musicd/shared";
import { MusicDaemonClient } from "@musicd/client";

import select from "./select-with-quit";
import { createDaemonClient } from "./daemon-connection";
import { runSetup } from "./setup";
import { logger } from "./logger";

import type { DaemonProtocol, QueueItem, QueueMode } from "@musicd/shared";
import type {
  FavoriteKind,
  PlaybackStatus,
  QueueAddResponse,
  SearchResult,
  TrackInfo,
} from "@musicd/client";

const program = new Command();

function parsePort(value: string): number {
  const result = PortStringSchema.safeParse(value);
  if (!result.success) {
    throw new InvalidArgumentError("Port must be an integer from 1 to 65535");
  }

  return result.data;
}

function parseDaemonProtocol(value: string): DaemonProtocol {
  const result = DaemonProtocolSchema.safeParse(value);
  if (!result.success) {
    throw new InvalidArgumentError('Protocol must be either "http" or "https"');
  }

  return result.data;
}

function parseSearchLimit(value: string): number {
  const result = SearchLimitStringSchema.safeParse(value);
  if (!result.success) {
    throw new InvalidArgumentError("Limit must be an integer from 1 to 100");
  }

  return result.data;
}

function parseQueueModeState(value: string): boolean {
  if (value === "on") {
    return true;
  }
  if (value === "off") {
    return false;
  }
  throw new InvalidArgumentError('State must be either "on" or "off"');
}

function parseFavoriteKind(value: string): FavoriteKind {
  if (value === "albums" || value === "artists" || value === "songs") {
    return value;
  }
  throw new InvalidArgumentError(
    'Kind must be one of "albums", "artists", or "songs"',
  );
}

// Global options for daemon connection
program
  .option("--print-logs", "Enable debug logging")
  .option("--host <host>", "Daemon host address")
  .option("--port <port>", "Daemon port", parsePort)
  .option(
    "--protocol <protocol>",
    "Daemon protocol (http or https)",
    parseDaemonProtocol,
  )
  .option("--password <password>", "Daemon password")
  .option(
    "--allow-insecure-http",
    "Allow a daemon password over HTTP on a trusted network",
  )
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
    protocol: opts.protocol,
    password: opts.password,
    allowInsecureHttp: opts.allowInsecureHttp,
    profile: opts.profile,
  });

  const { baseUrl, client } = createDaemonClient(connection);

  logger.debug("Daemon connection:");
  logger.debug(`  URL: ${baseUrl}`);
  logger.debug(`  Profile: ${connection.profileName || "(none)"}`);
  logger.debug(`  Password: ${connection.password ? "(set)" : "(not set)"}`);

  _client = client;

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

interface QueueAddOutcome {
  result: QueueAddResponse;
  queueMode?: QueueMode;
}

async function addQueueItem(
  itemId: string,
  enableLoop: boolean,
): Promise<QueueAddOutcome> {
  try {
    const result = await getClient().addToQueue([itemId], {
      clearQueue: false,
      playNow: false,
    });
    if (!enableLoop) {
      return { result };
    }

    const modeResult = await getClient().setQueueMode({ loop: true });
    return { result, queueMode: modeResult.queueMode };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to add queue item: ${String(error)}`);
  }
}

function completeQueueAdd(
  outcome: QueueAddOutcome,
  printSuccess: () => void,
): void {
  const { result, queueMode } = outcome;
  if (isJsonMode()) {
    outputJson(queueMode ? { ...result, queueMode } : result);
  }

  printSuccess();
  console.log(
    chalk.gray(
      `  Added ${result.tracksAdded} track${result.tracksAdded === 1 ? "" : "s"}`,
    ),
  );
  if (queueMode?.loop) {
    console.log(chalk.green("⟳ Loop enabled"));
  }
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

const MAX_TITLE_LENGTH = 50;

/**
 * Truncate a string to a maximum length, appending an ellipsis if truncated.
 */
function truncateTitle(title: string): string {
  if (title.length <= MAX_TITLE_LENGTH) {
    return title;
  }
  return title.slice(0, MAX_TITLE_LENGTH) + "\u2026";
}

/**
 * Get a source indicator for queue items.
 */
function sourceIndicator(item: { source?: string }): string {
  if (item.source === "youtube") {
    return chalk.red("[YouTube]");
  }
  return chalk.magenta("[Jellyfin]");
}

// Define CLI commands
program
  .name("musicd")
  .description("CLI for Jellyfin Music Daemon")
  .version(APP_VERSION);

program
  .command("setup")
  .description("Configure Jellyfin authentication")
  .option("--jellyfin-url <url>", "Jellyfin server URL")
  .action(async (options) => {
    const opts = program.opts();
    await runSetup(
      {
        host: opts.host,
        port: opts.port,
        protocol: opts.protocol,
        password: opts.password,
        allowInsecureHttp: opts.allowInsecureHttp,
        profile: opts.profile,
      },
      options.jellyfinUrl,
    );
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

          parts.push(chalk.bold.white(truncateTitle(item.name)));

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

        selectedItem = await select({
          message: "Select a song to play (Tab to expand albums/artists):",
          choices,
          pageSize: 15,
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

async function listPlaylists(options: { limit: number }): Promise<void> {
  try {
    const result = await getClient().browseLibrary(
      "playlists",
      0,
      options.limit,
    );
    if (isJsonMode()) {
      outputJson(result);
    }

    if (result.count === 0) {
      console.log(chalk.yellow("No Jellyfin playlists found"));
      return;
    }

    console.log(
      chalk.gray(`${result.total} playlist${result.total === 1 ? "" : "s"}\n`),
    );
    for (const playlist of result.items) {
      console.log(
        `📋 ${chalk.bold.white(truncateTitle(playlist.name))} ${chalk.dim(`[${playlist.id}]`)}`,
      );
    }
  } catch (error) {
    if (isJsonMode()) {
      outputJsonError(error);
    }
    console.error(
      chalk.red("✗ Failed to list playlists:"),
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}

const playlistCmd = program
  .command("playlist")
  .alias("playlists")
  .description("Browse and play Jellyfin playlists")
  .option(
    "-l, --limit <number>",
    "Maximum playlists to show",
    parseSearchLimit,
    20,
  )
  .action(listPlaylists);

playlistCmd
  .command("show")
  .description("Show the ordered tracks in a Jellyfin playlist")
  .argument("<id>", "Jellyfin playlist ID")
  .action(async (id: string) => {
    try {
      const result = await getClient().getPlaylist(id);
      if (isJsonMode()) {
        outputJson(result);
      }

      console.log(chalk.bold.white(result.playlist.name));
      console.log(
        chalk.gray(`${result.count} track${result.count === 1 ? "" : "s"}\n`),
      );
      for (const [index, track] of result.tracks.entries()) {
        const artist = track.artist ? chalk.cyan(` · ${track.artist}`) : "";
        console.log(
          `${chalk.gray(`${index + 1}.`)} ${truncateTitle(track.name)}${artist}`,
        );
      }
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to show playlist:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

playlistCmd
  .command("play")
  .description("Play a Jellyfin playlist")
  .argument("<id>", "Jellyfin playlist ID")
  .option("-q, --queue", "Append instead of replacing the queue")
  .action(async (id: string, options) => {
    try {
      const playlist = await getClient().getPlaylist(id);
      const result = await getClient().addToQueue([id], {
        clearQueue: options.queue !== true,
        playNow: options.queue !== true,
      });
      if (isJsonMode()) {
        outputJson({ ...result, playlist: playlist.playlist });
      }

      const action = options.queue === true ? "Added" : "Playing";
      console.log(
        chalk.green(options.queue === true ? "✓ Added:" : "▶ Playing:"),
        chalk.bold(playlist.playlist.name),
      );
      console.log(
        chalk.gray(
          `  ${action} ${result.tracksAdded} track${result.tracksAdded === 1 ? "" : "s"}`,
        ),
      );
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to play playlist:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

const favoritesCmd = program
  .command("favorites")
  .alias("favorite")
  .description("Browse and update Jellyfin favorites")
  .argument(
    "[kind]",
    "Favorite kind: songs, albums, or artists",
    parseFavoriteKind,
    "songs",
  )
  .option(
    "-l, --limit <number>",
    "Maximum favorites to show",
    parseSearchLimit,
    20,
  )
  .action(async (kind: FavoriteKind, options) => {
    try {
      const result = await getClient().getFavorites(kind, 0, options.limit);
      if (isJsonMode()) {
        outputJson(result);
      }

      if (result.count === 0) {
        console.log(chalk.yellow(`No favorite ${kind} found`));
        return;
      }

      console.log(chalk.gray(`${result.total} favorite ${kind}\n`));
      for (const item of result.items) {
        const artist = item.artist ? chalk.cyan(` · ${item.artist}`) : "";
        console.log(
          `♥ ${chalk.bold.white(truncateTitle(item.name))}${artist} ${chalk.dim(`[${item.id}]`)}`,
        );
      }
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to list favorites:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

favoritesCmd
  .command("play")
  .description("Play favorite Jellyfin items")
  .argument(
    "[kind]",
    "Favorite kind: songs, albums, or artists",
    parseFavoriteKind,
    "songs",
  )
  .option("-q, --queue", "Append instead of replacing the queue")
  .option(
    "-l, --limit <number>",
    "Maximum favorites to queue",
    parseSearchLimit,
    100,
  )
  .action(async (kind: FavoriteKind, options) => {
    try {
      const favorites = await getClient().getFavorites(kind, 0, options.limit);
      if (favorites.count === 0) {
        if (isJsonMode()) {
          outputJson(favorites);
        }
        console.log(chalk.yellow(`No favorite ${kind} found`));
        return;
      }

      const result = await getClient().addToQueue(
        favorites.items.map((item) => item.id),
        {
          clearQueue: options.queue !== true,
          playNow: options.queue !== true,
        },
      );
      if (isJsonMode()) {
        outputJson({ ...result, favorites });
      }

      console.log(
        chalk.green(options.queue === true ? "✓ Added:" : "▶ Playing:"),
        `${favorites.count} favorite ${kind}`,
      );
      console.log(
        chalk.gray(
          `  Queued ${result.tracksAdded} track${result.tracksAdded === 1 ? "" : "s"}`,
        ),
      );
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to play favorites:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

favoritesCmd
  .command("add")
  .description("Mark a Jellyfin item as a favorite")
  .argument("<id>", "Jellyfin item ID")
  .action(async (id: string) => {
    try {
      const result = await getClient().favorite(id);
      if (isJsonMode()) {
        outputJson(result);
      }
      console.log(chalk.green("♥ Added to Jellyfin favorites:"), id);
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to add favorite:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

favoritesCmd
  .command("remove")
  .description("Remove a Jellyfin item from favorites")
  .argument("<id>", "Jellyfin item ID")
  .action(async (id: string) => {
    try {
      const result = await getClient().unfavorite(id);
      if (isJsonMode()) {
        outputJson(result);
      }
      console.log(chalk.green("♡ Removed from Jellyfin favorites:"), id);
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to remove favorite:"),
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
  .option(
    "-l, --limit <number>",
    "Maximum number of results",
    parseSearchLimit,
    20,
  )
  .action(async (query: string, options) => {
    try {
      const result = await getClient().search(query, options.limit);

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

        parts.push(chalk.bold.white(truncateTitle(item.name)));

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

        parts.push(
          chalk.bold.white(
            truncateTitle(status.currentItem?.name || "Unknown"),
          ),
        );

        if (status.currentItem?.artist) {
          parts.push(chalk.cyan(status.currentItem.artist));
        }

        if (status.currentItem?.album) {
          parts.push(chalk.blue(status.currentItem.album));
        }

        // Source indicator
        if (status.currentItem) {
          parts.push(sourceIndicator(status.currentItem));
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

        // Show queue mode if loop or random is enabled
        const modes: string[] = [];
        if (status.queueMode?.loop) {
          modes.push("⟳ loop");
        }
        if (status.queueMode?.random) {
          modes.push("🔀 random");
        }
        if (modes.length > 0) {
          console.log(chalk.gray(`  Mode: ${modes.join(", ")}`));
        }
      }

      // Also show mode when stopped but modes are enabled
      if (status.state === "stopped" && status.queueMode) {
        const modes: string[] = [];
        if (status.queueMode.loop) {
          modes.push("⟳ loop");
        }
        if (status.queueMode.random) {
          modes.push("🔀 random");
        }
        if (modes.length > 0) {
          console.log(chalk.gray(`Mode: ${modes.join(", ")}`));
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

/** Render the queue and play the item selected by the user. */
async function showQueue(): Promise<void> {
  try {
    const result = await getClient().getQueue();

    if (isJsonMode()) {
      outputJson(result);
    }

    if (result.count === 0) {
      console.log(chalk.yellow("Queue is empty"));
      return;
    }

    const choices = result.queue.map((item: QueueItem, index: number) => {
      const parts = [
        index === result.position ? chalk.green("▶") : " ",
        chalk.gray(`${(index + 1).toString().padStart(2, " ")}.`),
        chalk.bold.white(truncateTitle(item.name)),
      ];

      if (item.artist) {
        parts.push(chalk.cyan(item.artist));
      }
      if (item.album) {
        parts.push(chalk.blue(item.album));
      }
      if (item.duration > 0) {
        parts.push(chalk.gray(formatDuration(item.duration)));
      }
      parts.push(sourceIndicator(item));

      return { name: parts.join(" · "), value: index };
    });

    const selectedIndex = await select({
      message: `Queue (${result.count} track${result.count === 1 ? "" : "s"}) - Select track to play:`,
      choices,
    });

    if (selectedIndex === null) {
      console.log(chalk.gray("Cancelled"));
      return;
    }

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
}

// Queue parent command with subcommands
const queueCmd = program
  .command("queue")
  .alias("q")
  .description("Manage playback queue")
  .action(showQueue);

queueCmd
  .command("show")
  .alias("ls")
  .description("Show queue")
  .action(showQueue);

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
  .command("loop")
  .description("Set queue loop mode, or toggle it when state is omitted")
  .argument("[state]", "Explicit state: on or off", parseQueueModeState)
  .action(async (enabled: boolean | undefined) => {
    try {
      const result =
        enabled === undefined
          ? await getClient().toggleLoop()
          : await getClient().setQueueMode({ loop: enabled });
      if (isJsonMode()) {
        outputJson(result);
      }
      if (result.queueMode.loop) {
        console.log(
          chalk.green("⟳ Loop enabled") + chalk.gray(" - Queue will repeat"),
        );
      } else {
        console.log(chalk.yellow("⟳ Loop disabled"));
      }
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to toggle loop:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

queueCmd
  .command("random")
  .description("Set random mode, or toggle it when state is omitted")
  .argument("[state]", "Explicit state: on or off", parseQueueModeState)
  .action(async (enabled: boolean | undefined) => {
    try {
      const result =
        enabled === undefined
          ? await getClient().toggleRandom()
          : await getClient().setQueueMode({ random: enabled });
      if (isJsonMode()) {
        outputJson(result);
      }
      if (result.queueMode.random) {
        console.log(
          chalk.green("🔀 Random enabled") +
            chalk.gray(" - Playing in random order"),
        );
      } else {
        console.log(chalk.yellow("🔀 Random disabled"));
      }
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to toggle random:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

queueCmd
  .command("shuffle")
  .description("Shuffle the current queue order randomly")
  .action(async () => {
    try {
      const result = await getClient().shuffleQueue();
      if (isJsonMode()) {
        outputJson(result);
      }
      console.log(
        chalk.green("✓ Queue shuffled"),
        chalk.gray(`(${result.count} track${result.count === 1 ? "" : "s"})`),
      );
    } catch (error) {
      if (isJsonMode()) {
        outputJsonError(error);
      }
      console.error(
        chalk.red("✗ Failed to shuffle queue:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

queueCmd
  .command("add")
  .description("Add to queue by search query, Jellyfin ID, or YouTube URL")
  .argument("[query]", "Search query or YouTube URL")
  .option("-i, --id <itemId>", "Add by Jellyfin item ID")
  .option("--youtube-url <url>", "Add a YouTube URL to the queue")
  .option("--loop", "Enable loop mode after adding")
  .action(async (query: string | undefined, options) => {
    try {
      // Validate that at least one source is provided
      if (!query && !options.id && !options.youtubeUrl) {
        console.error(
          chalk.red(
            "✗ Error: Either <query>, --id, or --youtube-url must be provided",
          ),
        );
        console.log(chalk.gray("Usage: musicd queue add <query>"));
        console.log(chalk.gray("   or: musicd queue add --id <itemId>"));
        console.log(chalk.gray("   or: musicd queue add --youtube-url <url>"));
        process.exit(1);
      }

      // If --youtube-url is provided, add directly as YouTube URL
      if (options.youtubeUrl) {
        if (!isYouTubeUrl(options.youtubeUrl)) {
          console.error(chalk.red("✗ Error: Invalid YouTube URL"));
          process.exit(1);
        }

        if (!isJsonMode()) {
          process.stdout.write(chalk.gray(`[YouTube] Adding YouTube URL...\n`));
        }

        const outcome = await addQueueItem(
          options.youtubeUrl,
          options.loop === true,
        );
        completeQueueAdd(outcome, () => {
          console.log(
            chalk.green("✓ Added to queue:"),
            chalk.red("[YouTube]"),
            chalk.bold(options.youtubeUrl),
          );
        });
        return;
      }

      // If --id is provided, add directly by Jellyfin ID (no URL detection)
      if (options.id) {
        const outcome = await addQueueItem(options.id, options.loop === true);
        completeQueueAdd(outcome, () => {
          console.log(
            chalk.green("✓ Added to queue by ID:"),
            chalk.bold(options.id),
          );
        });
        return;
      }

      // Auto-detect YouTube URLs in the query argument
      if (query && isYouTubeUrl(query)) {
        if (!isJsonMode()) {
          process.stdout.write(
            chalk.gray(`[YouTube] Detected YouTube URL, adding to queue...\n`),
          );
        }

        const outcome = await addQueueItem(query, options.loop === true);
        completeQueueAdd(outcome, () => {
          console.log(
            chalk.green("✓ Added to queue:"),
            chalk.red("[YouTube]"),
            chalk.bold(query),
          );
        });
        return;
      }

      // Search for music in Jellyfin
      if (!isJsonMode()) {
        process.stdout.write(chalk.gray(`🔍 Searching for "${query}"...\n`));
      }
      const searchResult = await getClient().search(query!);

      if (searchResult.count === 0) {
        if (isJsonMode()) {
          outputJsonError(new Error("No results found"));
        }
        console.log(chalk.yellow("✗ No results found"));
        process.exit(1);
      }

      if (isJsonMode() && searchResult.count > 1) {
        outputJsonError(
          new Error("Multiple results found; use --id to select one"),
        );
      }

      let selectedItem: SearchResult | null;

      // If only one result, auto-select it
      if (searchResult.count === 1) {
        selectedItem = searchResult.results[0];
        if (!isJsonMode()) {
          console.log(chalk.gray(`✓ Found 1 match`));
        }
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

          parts.push(chalk.bold.white(truncateTitle(item.name)));

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

        selectedItem = await select({
          message:
            "Select item to add to queue (Tab to expand albums/artists):",
          choices,
          pageSize: 15,
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
      const outcome = await addQueueItem(
        selectedItem.id,
        options.loop === true,
      );
      completeQueueAdd(outcome, () => {
        console.log(
          chalk.green("✓ Added to queue:"),
          chalk.bold(selectedItem.name),
        );
      });
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
