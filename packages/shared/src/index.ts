// Types
export type {
  // Server config types
  JellyfinConfig,
  AudioConfig,
  ServerBindingConfig,
  StateConfig,
  ServerConfig,
  // CLI config types
  DaemonProtocol,
  DaemonProfile,
  CliConfig,
  ResolvedDaemonConnection,
  // API types
  AuthenticationResult,
  JellyfinItem,
  MediaSource,
  PlaybackState,
  SearchType,
  QueueMode,
  QueueItemBase,
  JellyfinQueueItem,
  YouTubeQueueItem,
  QueueItem,
  PlaybackStatus,
  PlayOptions,
  PlayRequest,
  QueueAddRequest,
  YouTubeErrorCode,
  YouTubeOperation,
  YouTubeErrorContext,
} from "./types";
export { SEARCH_TYPES } from "./types";
export {
  JellyfinError,
  PlayerError,
  ConfigError,
  SetupStorageError,
  AuthenticationError,
  YouTubeError,
} from "./types";

// Schemas
export {
  // CLI schemas
  DaemonProfileSchema,
  DaemonProtocolSchema,
  CliConfigSchema,
  PortStringSchema,
  QueueIndexStringSchema,
  SearchLimitStringSchema,
  SearchTypesStringSchema,
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
  loadServerConfigIfPresent,
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

// Setup storage
export { recoverInterruptedSetup, saveSetupState } from "./setup-storage";

// State storage
export {
  saveQueueState,
  loadQueueState,
  clearQueueState,
  hasQueueState,
  getQueueFilePath,
} from "./state-storage";
export type { QueueState } from "./state-storage";

// Queue items
export { createJellyfinQueueItems } from "./queue-items";

// Credential redaction
export { isCredentialKey } from "./credential-redaction";

// Constants
export * from "./constants";
