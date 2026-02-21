// Configuration types
export interface JellyfinConfig {
  serverUrl: string;
  username?: string;
  password?: string;
}

export interface DaemonConfig {
  port: number;
  host: string;
}

export interface AudioConfig {
  device: string;
}

export interface Config {
  jellyfin: JellyfinConfig;
  daemon: DaemonConfig;
  audio: AudioConfig;
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
  MediaSources?: MediaSource[];
}

export interface MediaSource {
  Id: string;
  Path: string;
  Protocol: string;
  Container: string;
}

// Playback types
export type PlaybackState = "playing" | "stopped";

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
}

export interface PlayOptions {
  audioDevice?: string;
}

// API request/response types
export interface PlayRequest {
  itemId: string;
}

export interface HealthResponse {
  status: "healthy" | "unhealthy";
  daemon: {
    uptime: number;
    version: string;
  };
  jellyfin: {
    connected: boolean;
    serverUrl: string;
  };
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
