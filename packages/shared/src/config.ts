import { z } from "zod";
import dotenv from "dotenv";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Config } from "./types.js";
import { ConfigError } from "./types.js";
import {
  DEFAULT_DAEMON_PORT,
  DEFAULT_DAEMON_HOST,
  DEFAULT_AUDIO_DEVICE,
  DEFAULT_JELLYFIN_URL,
  CONFIG_FILE_PATH,
  XDG_CONFIG_DIR,
  XDG_CONFIG_FILE,
} from "./constants.js";

// Zod schema for validation
const ConfigSchema = z.object({
  jellyfin: z.object({
    serverUrl: z.string().url(),
    username: z.string().optional(),
    password: z.string().optional(),
  }),
  daemon: z.object({
    port: z.number().int().min(1).max(65535),
    host: z.string().min(1),
  }),
  audio: z.object({
    device: z.string().min(1),
  }),
});

/**
 * Get XDG config directory path
 */
export function getXdgConfigPath(): string {
  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfigHome, XDG_CONFIG_DIR, XDG_CONFIG_FILE);
}

/**
 * Get XDG config directory (without filename)
 */
export function getXdgConfigDir(): string {
  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfigHome, XDG_CONFIG_DIR);
}

/**
 * Load configuration from file and environment variables
 * Priority: env vars > XDG config > local config file > defaults
 */
export function loadConfig(): Config {
  // Load .env file
  dotenv.config();

  // Load config file
  let fileConfig: Partial<Config> = {
    jellyfin: {
      serverUrl: DEFAULT_JELLYFIN_URL,
      username: "",
      password: "",
    },
    daemon: {
      port: DEFAULT_DAEMON_PORT,
      host: DEFAULT_DAEMON_HOST,
    },
    audio: {
      device: DEFAULT_AUDIO_DEVICE,
    },
  };

  // Try XDG config directory first
  const xdgConfigPath = getXdgConfigPath();
  if (existsSync(xdgConfigPath)) {
    try {
      const configData = readFileSync(xdgConfigPath, "utf-8");
      fileConfig = JSON.parse(configData);
    } catch (error) {
      console.warn(`Could not load XDG config file (${xdgConfigPath}):`, error);
    }
  } else {
    // Fall back to local config file
    try {
      const configPath = join(process.cwd(), CONFIG_FILE_PATH);
      const configData = readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(configData);
    } catch (error) {
      // Silent fallback to defaults
    }
  }

  // Merge with environment variables (env vars take precedence)
  const config: Config = {
    jellyfin: {
      serverUrl:
        process.env.JELLYFIN_URL ||
        fileConfig.jellyfin?.serverUrl ||
        DEFAULT_JELLYFIN_URL,
      username:
        process.env.JELLYFIN_USERNAME || fileConfig.jellyfin?.username || "",
      password:
        process.env.JELLYFIN_PASSWORD || fileConfig.jellyfin?.password || "",
    },
    daemon: {
      port: process.env.DAEMON_PORT
        ? parseInt(process.env.DAEMON_PORT, 10)
        : fileConfig.daemon?.port || DEFAULT_DAEMON_PORT,
      host:
        process.env.DAEMON_HOST ||
        fileConfig.daemon?.host ||
        DEFAULT_DAEMON_HOST,
    },
    audio: {
      device:
        process.env.AUDIO_DEVICE ||
        fileConfig.audio?.device ||
        DEFAULT_AUDIO_DEVICE,
    },
  };

  // Validate configuration
  try {
    ConfigSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const messages = error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      throw new ConfigError(`Invalid configuration: ${messages}`);
    }
    throw error;
  }

  return config;
}
