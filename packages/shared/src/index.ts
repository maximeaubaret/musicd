// Types
export type {
  // Server config types
  JellyfinConfig,
  AudioConfig,
  ServerBindingConfig,
  StateConfig,
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
  QueueItemBase,
  JellyfinQueueItem,
  YouTubeQueueItem,
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
  YouTubeError,
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
  StateConfigSchema,
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

// State storage
export {
  saveQueueState,
  loadQueueState,
  clearQueueState,
  hasQueueState,
  getQueueFilePath,
} from "./state-storage";
export type { QueueState } from "./state-storage";

// Constants
export * from "./constants";
