// ============================================
// Server Configuration Types
// ============================================

/** Server-side Jellyfin configuration */
export interface JellyfinConfig {
  serverUrl: string;
}

/** Audio playback configuration */
export interface AudioConfig {
  device?: string;
}

/** Server binding configuration */
export interface ServerBindingConfig {
  /** Host to bind to (default: 127.0.0.1) */
  host: string;
  /** Port to listen on (default: 8765) */
  port: number;
  /** Optional password for API authentication */
  password?: string;
}

/** State persistence configuration */
export interface StateConfig {
  /** Whether to restore queue on startup (default: true) */
  restoreQueue: boolean;
}

/** Server configuration */
export interface ServerConfig {
  jellyfin: JellyfinConfig;
  daemon: ServerBindingConfig;
  audio?: AudioConfig;
  state?: StateConfig;
}

// ============================================
// CLI Configuration Types
// ============================================

/** Transport protocol for daemon API connections */
export type DaemonProtocol = "http" | "https";

/** A named profile for connecting to a musicd server */
export interface DaemonProfile {
  /** Daemon host address */
  host: string;
  /** Daemon port */
  port: number;
  /** Transport protocol (default: http) */
  protocol?: DaemonProtocol;
  /** Allow password-bearing HTTP connections to non-loopback hosts */
  allowInsecureHttp?: boolean;
  /** Optional authentication password */
  password?: string;
}

/** CLI configuration with connection profiles */
export interface CliConfig {
  /** Default profile name to use when none specified */
  defaultProfile?: string;
  /** Named connection profiles */
  profiles: Record<string, DaemonProfile>;
}

/** Resolved daemon connection settings (after applying CLI args) */
export interface ResolvedDaemonConnection {
  host: string;
  port: number;
  protocol: DaemonProtocol;
  password?: string;
  allowInsecureHttp: boolean;
  /** Which profile was used (undefined if CLI args only) */
  profileName?: string;
}

// Jellyfin API types
export interface AuthenticationResult {
  User: {
    Id: string;
    Name: string;
  };
  AccessToken: string;
  ServerId: string;
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  Artists?: string[];
  Album?: string;
  AlbumArtist?: string;
  RunTimeTicks?: number;
  ProductionYear?: number;
  IndexNumber?: number;
  MediaSources?: MediaSource[];
}

export interface MediaSource {
  Id?: string;
  Path?: string;
  Protocol: string;
  Container?: string;
}

// Playback types
export type PlaybackState = "playing" | "paused" | "stopped";

/** Queue playback mode */
export interface QueueMode {
  /** Loop the queue indefinitely (replay from beginning when reaching the end) */
  loop: boolean;
  /** Pick a random next track instead of sequential */
  random: boolean;
}

/** Common fields shared across all queue item sources */
export interface QueueItemBase {
  id: string;
  name: string;
  artist?: string;
  album?: string;
  duration: number; // seconds
}

/** Queue item sourced from Jellyfin */
export interface JellyfinQueueItem extends QueueItemBase {
  source: "jellyfin";
  jellyfinItem: JellyfinItem;
}

/** Queue item sourced from YouTube */
export interface YouTubeQueueItem extends QueueItemBase {
  source: "youtube";
  youtubeUrl: string; // Original URL (for re-extraction on restore)
  videoId: string;
  uploader?: string;
}

/** A queue item from any supported source */
export type QueueItem = JellyfinQueueItem | YouTubeQueueItem;

export interface PlaybackStatus {
  state: PlaybackState;
  currentItem: {
    id: string;
    name: string;
    artist?: string;
    album?: string;
    source?: "jellyfin" | "youtube";
  } | null;
  position: number; // seconds
  duration: number; // seconds
  queue: QueueItem[];
  queuePosition: number; // Current position in queue (0-based)
  queueMode: QueueMode; // Current loop/random mode settings
}

export interface PlayOptions {
  audioDevice?: string;
}

// API request/response types
export interface PlayRequest {
  itemId?: string;
}

export interface QueueAddRequest {
  itemIds: string[];
  clearQueue?: boolean; // Clear existing queue before adding
  playNow?: boolean; // Start playing immediately
}

// Error types
export class JellyfinError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
  ) {
    super(message);
    this.name = "JellyfinError";
  }
}

export class PlayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayerError";
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class SetupStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupStorageError";
  }
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export type YouTubeErrorCode =
  | "EXECUTABLE_NOT_FOUND"
  | "INVALID_METADATA"
  | "INVALID_STREAM_URL"
  | "PROCESS_ERROR"
  | "PROCESS_EXIT"
  | "TERMINATION_FAILED"
  | "TIMEOUT";

export type YouTubeOperation = "availability" | "metadata" | "stream-url";

export interface YouTubeErrorContext {
  code: YouTubeErrorCode;
  operation: YouTubeOperation;
  exitCode?: number | null;
  signal?: string | null;
  stderr?: string;
  executable?: string;
  processCode?: string;
  timeoutMs?: number;
  cause?: Error;
}

export class YouTubeError extends Error {
  public readonly code: YouTubeErrorCode;
  public readonly operation: YouTubeOperation;
  public readonly exitCode?: number | null;
  public readonly signal?: string | null;
  public readonly stderr?: string;
  public readonly executable?: string;
  public readonly processCode?: string;
  public readonly timeoutMs?: number;

  constructor(message: string, context: YouTubeErrorContext) {
    super(message, { cause: context.cause });
    this.name = "YouTubeError";
    this.code = context.code;
    this.operation = context.operation;
    this.exitCode = context.exitCode;
    this.signal = context.signal;
    this.stderr = context.stderr;
    this.executable = context.executable;
    this.processCode = context.processCode;
    this.timeoutMs = context.timeoutMs;
  }
}
