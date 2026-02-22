import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AuthenticationResult } from "./types.js";
import { XDG_DATA_DIR, XDG_AUTH_FILE } from "./constants.js";

/**
 * Get the XDG data directory path (~/.local/share/musicd)
 */
function getXdgDataDir(): string {
  const xdgDataHome =
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdgDataHome, XDG_DATA_DIR);
}

/**
 * Get the auth file path (~/.local/share/musicd/auth.json)
 */
export function getAuthFilePath(): string {
  return join(getXdgDataDir(), XDG_AUTH_FILE);
}

export interface StoredAuth {
  accessToken: string;
  userId: string;
  serverId: string;
  username: string;
  createdAt: number;
}

/**
 * Save authentication data to disk
 */
export function saveAuth(
  authResult: AuthenticationResult,
  username: string,
): void {
  const data: StoredAuth = {
    accessToken: authResult.AccessToken,
    userId: authResult.User.Id,
    serverId: authResult.ServerId,
    username,
    createdAt: Date.now(),
  };

  try {
    // Ensure the data directory exists
    const dataDir = getXdgDataDir();
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const authPath = getAuthFilePath();
    writeFileSync(authPath, JSON.stringify(data, null, 2), "utf-8");
    // Set file permissions to 600 (owner read/write only) for security
    chmodSync(authPath, 0o600);
  } catch (error) {
    throw new Error(`Failed to save authentication data: ${error}`);
  }
}

/**
 * Load authentication data from disk
 */
export function loadAuth(): StoredAuth | null {
  const authPath = getAuthFilePath();
  if (!existsSync(authPath)) {
    return null;
  }

  try {
    const data = readFileSync(authPath, "utf-8");
    return JSON.parse(data) as StoredAuth;
  } catch (error) {
    console.warn("Failed to load authentication data:", error);
    return null;
  }
}

/**
 * Check if authentication data exists
 */
export function hasAuth(): boolean {
  return existsSync(getAuthFilePath());
}

/**
 * Clear stored authentication data
 */
export function clearAuth(): void {
  const authPath = getAuthFilePath();
  if (existsSync(authPath)) {
    try {
      unlinkSync(authPath);
    } catch (error) {
      console.warn("Failed to clear authentication data:", error);
    }
  }
}
