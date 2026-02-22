// Types
export type {
  // Server config types
  JellyfinConfig,
  AudioConfig,
  ServerBindingConfig,
  ServerConfig,
  // CLI config types
  DaemonProfile,
  CliConfig,
  ResolvedDaemonConnection,
  // API types
  AuthenticationResult,
  JellyfinItem,
  MediaSource,
  PlaybackState,
  QueueItem,
  PlaybackStatus,
  PlayOptions,
  PlayRequest,
  QueueAddRequest,
} from "./types";
export {
  JellyfinError,
  PlayerError,
  ConfigError,
  AuthenticationError,
} from "./types";

// Schemas
export {
  // CLI schemas
  DaemonProfileSchema,
  CliConfigSchema,
  // Server schemas
  JellyfinConfigSchema,
  AudioConfigSchema,
  ServerBindingConfigSchema,
  ServerConfigSchema,
} from "./schemas";

// Configuration
export {
  // Path utilities
  getXdgConfigHome,
  getMusicdConfigDir,
  getCliConfigPath,
  getServerConfigPath,
  // CLI config functions
  loadCliConfig,
  saveCliConfig,
  getProfile,
  resolveDaemonConnection,
  // Server config functions
  loadServerConfig,
  saveServerConfig,
} from "./config";
export type { CliConnectionArgs } from "./config";

// Token storage
export {
  saveAuth,
  loadAuth,
  hasAuth,
  clearAuth,
  getAuthFilePath,
} from "./token-storage";
export type { StoredAuth } from "./token-storage";

// Constants
export * from "./constants";
