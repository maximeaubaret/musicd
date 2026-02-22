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

/** Server configuration */
export interface ServerConfig {
  jellyfin: JellyfinConfig;
  daemon: ServerBindingConfig;
  audio?: AudioConfig;
}

// ============================================
// CLI Configuration Types
// ============================================

/** A named profile for connecting to a musicd server */
export interface DaemonProfile {
  /** Daemon host address */
  host: string;
  /** Daemon port */
  port: number;
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
  password?: string;
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
  Id: string;
  Path: string;
  Protocol: string;
  Container: string;
}

// Playback types
export type PlaybackState = "playing" | "paused" | "stopped";

export interface QueueItem {
  id: string;
  name: string;
  artist?: string;
  album?: string;
  duration: number; // seconds
  jellyfinItem: JellyfinItem;
}

export interface PlaybackStatus {
  state: PlaybackState;
  currentItem: {
    id: string;
    name: string;
    artist?: string;
    album?: string;
  } | null;
  position: number; // seconds
  duration: number; // seconds
  queue: QueueItem[];
  queuePosition: number; // Current position in queue (0-based)
}

export interface PlayOptions {
  audioDevice?: string;
}

// API request/response types
export interface PlayRequest {
  itemId: string;
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

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}
