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
  LegacyConfig,
  Config,
} from "./types.js";
import { ConfigError } from "./types.js";
import {
  CliConfigSchema,
  ServerConfigSchema,
  LegacyConfigSchema,
} from "./schemas.js";
import {
  DEFAULT_DAEMON_PORT,
  DEFAULT_DAEMON_HOST,
  DEFAULT_AUDIO_DEVICE,
  DEFAULT_JELLYFIN_URL,
  DEFAULT_PROFILE_NAME,
  XDG_CONFIG_DIR,
  XDG_CONFIG_FILE,
  CLI_CONFIG_FILE,
  SERVER_CONFIG_FILE,
} from "./constants.js";

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

/**
 * Get legacy config file path (for migration)
 */
export function getLegacyConfigPath(): string {
  return join(getMusicdConfigDir(), XDG_CONFIG_FILE);
}

/**
 * @deprecated Use getCliConfigPath() or getServerConfigPath() instead
 */
export function getXdgConfigPath(): string {
  return getLegacyConfigPath();
}

/**
 * @deprecated Use getMusicdConfigDir() instead
 */
export function getXdgConfigDir(): string {
  return getMusicdConfigDir();
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

// ============================================
// Backwards Compatibility (deprecated)
// ============================================

/**
 * Information about where configuration was resolved from
 * @deprecated Use loadServerConfig() or loadCliConfig() directly
 */
export interface ConfigResolutionInfo {
  configFile: string | null;
  isDefaultConfig: boolean;
  envOverrides: string[];
  xdgConfigPath: string;
}

/**
 * @deprecated Use loadServerConfig() for server or resolveDaemonConnection() for CLI
 * Provided for gradual migration of existing code
 */
export function loadConfig(): Config {
  // Load .env file
  dotenv.config();

  // Try to load from new server config first
  const serverConfigPath = getServerConfigPath();
  const legacyConfigPath = getLegacyConfigPath();

  let fileConfig: Partial<Config> = {
    jellyfin: {
      serverUrl: DEFAULT_JELLYFIN_URL,
      username: "",
      password: "",
    },
    daemon: {
      port: DEFAULT_DAEMON_PORT,
      host: DEFAULT_DAEMON_HOST,
      password: undefined,
    },
    audio: {
      device: DEFAULT_AUDIO_DEVICE,
    },
  };

  // Try new server config first
  if (existsSync(serverConfigPath)) {
    try {
      const configData = readFileSync(serverConfigPath, "utf-8");
      const serverConfig = JSON.parse(configData);
      fileConfig = {
        jellyfin: {
          serverUrl: serverConfig.jellyfin?.serverUrl || DEFAULT_JELLYFIN_URL,
          username: "",
          password: "",
        },
        daemon: {
          port: serverConfig.daemon?.port || DEFAULT_DAEMON_PORT,
          host: serverConfig.daemon?.host || DEFAULT_DAEMON_HOST,
          password: serverConfig.daemon?.password,
        },
        audio: {
          device: serverConfig.audio?.device || DEFAULT_AUDIO_DEVICE,
        },
      };
    } catch (error) {
      console.warn(
        `Could not load server config (${serverConfigPath}):`,
        error,
      );
    }
  } else if (existsSync(legacyConfigPath)) {
    // Fall back to legacy config
    try {
      const configData = readFileSync(legacyConfigPath, "utf-8");
      fileConfig = JSON.parse(configData);
    } catch (error) {
      console.warn(`Could not load config file (${legacyConfigPath}):`, error);
    }
  }

  // Merge with environment variables (env vars take precedence)
  const config: Config = {
    jellyfin: {
      serverUrl:
        process.env.JELLYFIN_URL ||
        process.env.JELLYFIN_SERVER_URL ||
        fileConfig.jellyfin?.serverUrl ||
        DEFAULT_JELLYFIN_URL,
      username:
        process.env.JELLYFIN_USERNAME ||
        (fileConfig.jellyfin as any)?.username ||
        "",
      password:
        process.env.JELLYFIN_PASSWORD ||
        (fileConfig.jellyfin as any)?.password ||
        "",
    },
    daemon: {
      port: process.env.DAEMON_PORT
        ? parseInt(process.env.DAEMON_PORT, 10)
        : process.env.DAEMON_BIND_PORT
          ? parseInt(process.env.DAEMON_BIND_PORT, 10)
          : fileConfig.daemon?.port || DEFAULT_DAEMON_PORT,
      host:
        process.env.DAEMON_HOST ||
        process.env.DAEMON_BIND_HOST ||
        fileConfig.daemon?.host ||
        DEFAULT_DAEMON_HOST,
      password:
        process.env.DAEMON_PASSWORD || fileConfig.daemon?.password || undefined,
    },
    audio: {
      device:
        process.env.AUDIO_DEVICE ||
        fileConfig.audio?.device ||
        DEFAULT_AUDIO_DEVICE,
    },
  };

  return config;
}

/**
 * Get information about where configuration is resolved from
 * @deprecated Use loadServerConfig() or loadCliConfig() directly
 */
export function getConfigResolutionInfo(): ConfigResolutionInfo {
  // Load .env file
  dotenv.config();

  const serverConfigPath = getServerConfigPath();
  const legacyConfigPath = getLegacyConfigPath();

  let configFile: string | null = null;
  let isDefaultConfig = true;

  // Check new server config first
  if (existsSync(serverConfigPath)) {
    configFile = serverConfigPath;
    isDefaultConfig = false;
  } else if (existsSync(legacyConfigPath)) {
    configFile = legacyConfigPath;
    isDefaultConfig = false;
  }

  // Check which environment variables are set
  const envOverrides: string[] = [];
  if (process.env.JELLYFIN_URL) envOverrides.push("JELLYFIN_URL");
  if (process.env.JELLYFIN_SERVER_URL) envOverrides.push("JELLYFIN_SERVER_URL");
  if (process.env.JELLYFIN_USERNAME) envOverrides.push("JELLYFIN_USERNAME");
  if (process.env.JELLYFIN_PASSWORD) envOverrides.push("JELLYFIN_PASSWORD");
  if (process.env.DAEMON_PORT) envOverrides.push("DAEMON_PORT");
  if (process.env.DAEMON_HOST) envOverrides.push("DAEMON_HOST");
  if (process.env.DAEMON_BIND_PORT) envOverrides.push("DAEMON_BIND_PORT");
  if (process.env.DAEMON_BIND_HOST) envOverrides.push("DAEMON_BIND_HOST");
  if (process.env.DAEMON_PASSWORD) envOverrides.push("DAEMON_PASSWORD");
  if (process.env.AUDIO_DEVICE) envOverrides.push("AUDIO_DEVICE");

  return {
    configFile,
    isDefaultConfig,
    envOverrides,
    xdgConfigPath: legacyConfigPath,
  };
}
