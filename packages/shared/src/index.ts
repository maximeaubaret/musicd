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
  // Legacy types (deprecated)
  LegacyConfig,
  DaemonConfig,
  Config,
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
} from "./types.js";
export {
  JellyfinError,
  PlayerError,
  ConfigError,
  AuthenticationError,
} from "./types.js";

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
  // Legacy schemas
  LegacyConfigSchema,
} from "./schemas.js";

// Configuration
export {
  // Path utilities
  getXdgConfigHome,
  getMusicdConfigDir,
  getCliConfigPath,
  getServerConfigPath,
  getLegacyConfigPath,
  // CLI config functions
  loadCliConfig,
  saveCliConfig,
  getProfile,
  resolveDaemonConnection,
  // Server config functions
  loadServerConfig,
  saveServerConfig,
  // Migration functions
  checkNeedsMigration,
  migrateLegacyConfig,
  // Deprecated (for backwards compatibility)
  loadConfig,
  getXdgConfigPath,
  getXdgConfigDir,
  getConfigResolutionInfo,
} from "./config.js";
export type {
  CliConnectionArgs,
  MigrationResult,
  ConfigResolutionInfo,
} from "./config.js";

// Token storage
export {
  saveAuth,
  loadAuth,
  hasAuth,
  clearAuth,
  getAuthFilePath,
} from "./token-storage.js";
export type { StoredAuth } from "./token-storage.js";

// Constants
export * from "./constants.js";
