#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import select from "./select-with-quit.js";
import expandableSelect from "./expandable-select.js";
import { loadConfig } from "../shared/config.js";
import type { PlaybackStatus, HealthResponse } from "../shared/types.js";
import { runSetup } from "./setup.js";

const program = new Command();

// Load config to get daemon URL
let daemonUrl: string;
try {
  const config = loadConfig();
  daemonUrl = `http://${config.daemon.host}:${config.daemon.port}`;
} catch (error) {
  daemonUrl = "http://127.0.0.1:8765";
}

/**
 * Make API request to daemon
 */
async function apiRequest(
  endpoint: string,
  method: "GET" | "POST" = "GET",
  body?: any,
): Promise<any> {
  try {
    const response = await fetch(`${daemonUrl}/api${endpoint}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = (await response.json()) as any;

    if (!response.ok) {
      throw new Error(
        data.error || `Request failed with status ${response.status}`,
      );
    }

    return data;
  } catch (error) {
    if (error instanceof Error && error.message.includes("fetch failed")) {
      throw new Error(
        `Cannot connect to daemon at ${daemonUrl}. Is it running? Start it with: bun run dev`,
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
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// Define CLI commands
program
  .name("musicd")
  .description("CLI for Jellyfin Music Daemon")
  .version("0.1.0");

program
  .command("setup")
  .description("Configure Jellyfin authentication")
  .option("-f, --force", "Force reconfiguration even if already set up")
  .action(async (options) => {
    await runSetup(options.force);
  });

program
  .command("play")
  .description("Search and play music from Jellyfin library")
  .argument("<query>", "Search query (song name, artist, or album)")
  .option("-q, --queue", "Add to queue instead of replacing it")
  .action(async (query: string, options) => {
    try {
      const addToQueue = options.queue || false;

      // Search for music
      process.stdout.write(chalk.gray(`🔍 Searching for "${query}"...\n`));
      const searchResult = await apiRequest(
        `/search?q=${encodeURIComponent(query)}`,
      );

      if (searchResult.count === 0) {
        console.log(chalk.yellow("✗ No results found"));
        process.exit(1);
      }

      let selectedItem: any;

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
              const albumResult = await apiRequest(
                `/album/${parentItem.id}`,
              );
              return albumResult.tracks.map((track: any) => ({
                name: formatItem(track, true),
                value: track,
                isChild: true,
                parentId: parentItem.id,
                id: track.id,
              }));
            } else if (parentItem.type === "MusicArtist") {
              const artistResult = await apiRequest(
                `/artist/${parentItem.id}`,
              );
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
        const result = await apiRequest("/queue/add", "POST", {
          itemIds: [selectedItem.id],
          clearQueue: !addToQueue,
          playNow: true,
        });

        if (addToQueue) {
          console.log(chalk.green("✓ Added to queue:"), chalk.bold(selectedItem.name));
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
          chalk.gray(`🎵 ${addToQueue ? "Adding" : "Queueing"} ${itemType} "${selectedItem.name}"...\n`),
        );

        const result = await apiRequest("/queue/add", "POST", {
          itemIds: [selectedItem.id],
          clearQueue: !addToQueue,
          playNow: !addToQueue,
        });

        if (addToQueue) {
          console.log(chalk.green("✓ Added to queue:"), chalk.bold(selectedItem.name));
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
  .command("stop")
  .description("Stop playback")
  .action(async () => {
    try {
      await apiRequest("/stop", "POST");
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

      const result = await apiRequest(
        `/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      );

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
      const status: PlaybackStatus = await apiRequest("/status");

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
        // Currently playing
        const parts = [];
        parts.push(chalk.bold.white(status.currentItem?.name || "Unknown"));

        if (status.currentItem?.artist) {
          parts.push(chalk.cyan(status.currentItem.artist));
        }

        if (status.currentItem?.album) {
          parts.push(chalk.blue(status.currentItem.album));
        }

        console.log(chalk.green("▶ Playing:"), parts.join(" · "));
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
  .command("health")
  .description("Check daemon health")
  .action(async () => {
    try {
      const health: HealthResponse = await apiRequest("/health");

      console.log(
        `Status: ${health.status === "healthy" ? "✓ Healthy" : "✗ Unhealthy"}`,
      );
      console.log(`Daemon version: ${health.daemon.version}`);
      console.log(`Uptime: ${health.daemon.uptime}s`);
      console.log(
        `Jellyfin: ${health.jellyfin.connected ? "✓ Connected" : "✗ Disconnected"} (${health.jellyfin.serverUrl})`,
      );

      if (health.status !== "healthy") {
        process.exit(1);
      }
    } catch (error) {
      console.error(
        "✗ Health check failed:",
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
      const result = await apiRequest("/queue");

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
        const playResult = await apiRequest(
          `/queue/play/${selectedIndex}`,
          "POST",
        );
        console.log(
          chalk.green("▶ Playing:"),
          chalk.bold(playResult.item.name),
        );
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
      await apiRequest("/queue/clear", "POST");
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
      await apiRequest("/queue/next", "POST");
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
      await apiRequest("/queue/previous", "POST");
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
