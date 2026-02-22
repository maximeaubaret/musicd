import { z } from "zod";
import dotenv from "dotenv";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type {
  CliConfig,
  ServerConfig,
  DaemonProfile,
  ResolvedDaemonConnection,
} from "./types";
import { ConfigError } from "./types";
import { CliConfigSchema, ServerConfigSchema } from "./schemas";
import {
  DEFAULT_DAEMON_PORT,
  DEFAULT_DAEMON_HOST,
  XDG_CONFIG_DIR,
  CLI_CONFIG_FILE,
  SERVER_CONFIG_FILE,
} from "./constants";

// ============================================
// Path Utilities
// ============================================

/**
 * Get XDG config home directory
 */
export function getXdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/**
 * Get musicd config directory
 */
export function getMusicdConfigDir(): string {
  return join(getXdgConfigHome(), XDG_CONFIG_DIR);
}

/**
 * Get CLI config file path
 */
export function getCliConfigPath(): string {
  return join(getMusicdConfigDir(), CLI_CONFIG_FILE);
}

/**
 * Get Server config file path
 */
export function getServerConfigPath(): string {
  return join(getMusicdConfigDir(), SERVER_CONFIG_FILE);
}

// ============================================
// CLI Config Functions
// ============================================

/**
 * Load CLI configuration from file
 * Returns empty config with no profiles if file doesn't exist
 */
export function loadCliConfig(): CliConfig {
  const configPath = getCliConfigPath();

  if (!existsSync(configPath)) {
    return { profiles: {} };
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    return CliConfigSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const messages = error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      throw new ConfigError(`Invalid CLI config: ${messages}`);
    }
    throw new ConfigError(`Failed to load CLI config: ${error}`);
  }
}

/**
 * Save CLI configuration to file
 */
export function saveCliConfig(config: CliConfig): void {
  const configPath = getCliConfigPath();
  const configDir = dirname(configPath);

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  // Validate before saving
  CliConfigSchema.parse(config);
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Get a specific profile from CLI config
 */
export function getProfile(
  config: CliConfig,
  profileName?: string,
): DaemonProfile | undefined {
  const name = profileName || config.defaultProfile;
  if (!name) return undefined;
  return config.profiles[name];
}

/** CLI argument overrides */
export interface CliConnectionArgs {
  host?: string;
  port?: number;
  password?: string;
  profile?: string;
}

/**
 * Resolve daemon connection from CLI config + CLI args + env vars
 * Priority (highest to lowest):
 * 1. CLI arguments (--host, --port, --password)
 * 2. Environment variables (DAEMON_HOST, DAEMON_PORT, DAEMON_PASSWORD)
 * 3. Named profile (--profile or defaultProfile)
 * 4. Built-in defaults
 */
export function resolveDaemonConnection(
  args: CliConnectionArgs = {},
): ResolvedDaemonConnection {
  // Load .env file
  dotenv.config();

  const config = loadCliConfig();

  // Get profile settings (if any)
  const profileName = args.profile || config.defaultProfile;
  const profile = profileName ? config.profiles[profileName] : undefined;

  // If user explicitly requested a profile that doesn't exist, error out
  if (args.profile && !profile) {
    const available = Object.keys(config.profiles);
    if (available.length > 0) {
      throw new ConfigError(
        `Profile '${args.profile}' not found. Available profiles: ${available.join(", ")}`,
      );
    } else {
      throw new ConfigError(
        `Profile '${args.profile}' not found. No profiles configured in ${getCliConfigPath()}`,
      );
    }
  }

  // Layer: defaults -> profile -> env -> CLI args (CLI wins)
  const host =
    args.host ??
    process.env.DAEMON_HOST ??
    profile?.host ??
    DEFAULT_DAEMON_HOST;

  const port =
    args.port ??
    (process.env.DAEMON_PORT
      ? parseInt(process.env.DAEMON_PORT, 10)
      : undefined) ??
    profile?.port ??
    DEFAULT_DAEMON_PORT;

  const password =
    args.password ?? process.env.DAEMON_PASSWORD ?? profile?.password;

  return {
    host,
    port,
    password,
    profileName: profile ? profileName : undefined,
  };
}

// ============================================
// Server Config Functions
// ============================================

/**
 * Load server configuration from file
 * Throws if config file doesn't exist
 */
export function loadServerConfig(): ServerConfig {
  // Load .env file
  dotenv.config();

  const configPath = getServerConfigPath();

  if (!existsSync(configPath)) {
    throw new ConfigError(
      `Server config not found at ${configPath}. Run 'musicd setup' to configure.`,
    );
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);

    // Apply environment variable overrides
    if (process.env.JELLYFIN_SERVER_URL || process.env.JELLYFIN_URL) {
      parsed.jellyfin = parsed.jellyfin || {};
      parsed.jellyfin.serverUrl =
        process.env.JELLYFIN_SERVER_URL || process.env.JELLYFIN_URL;
    }
    if (process.env.DAEMON_BIND_HOST) {
      parsed.daemon = parsed.daemon || {};
      parsed.daemon.host = process.env.DAEMON_BIND_HOST;
    }
    if (process.env.DAEMON_BIND_PORT) {
      parsed.daemon = parsed.daemon || {};
      parsed.daemon.port = parseInt(process.env.DAEMON_BIND_PORT, 10);
    }
    if (process.env.DAEMON_PASSWORD) {
      parsed.daemon = parsed.daemon || {};
      parsed.daemon.password = process.env.DAEMON_PASSWORD;
    }
    if (process.env.AUDIO_DEVICE) {
      parsed.audio = parsed.audio || {};
      parsed.audio.device = process.env.AUDIO_DEVICE;
    }

    return ServerConfigSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const messages = error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      throw new ConfigError(`Invalid server config: ${messages}`);
    }
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(`Failed to load server config: ${error}`);
  }
}

/**
 * Save server configuration to file
 */
export function saveServerConfig(config: ServerConfig): void {
  const configPath = getServerConfigPath();
  const configDir = dirname(configPath);

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  // Validate before saving
  ServerConfigSchema.parse(config);
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}
