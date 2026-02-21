import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import type { AuthenticationResult } from './types.js';

const TOKEN_FILE_PATH = join(process.cwd(), '.jellyfin-auth.json');

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
export function saveAuth(authResult: AuthenticationResult, username: string): void {
  const data: StoredAuth = {
    accessToken: authResult.AccessToken,
    userId: authResult.User.Id,
    serverId: authResult.ServerId,
    username,
    createdAt: Date.now(),
  };

  try {
    writeFileSync(TOKEN_FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
    // Set file permissions to 600 (owner read/write only) for security
    chmodSync(TOKEN_FILE_PATH, 0o600);
  } catch (error) {
    throw new Error(`Failed to save authentication data: ${error}`);
  }
}

/**
 * Load authentication data from disk
 */
export function loadAuth(): StoredAuth | null {
  if (!existsSync(TOKEN_FILE_PATH)) {
    return null;
  }

  try {
    const data = readFileSync(TOKEN_FILE_PATH, 'utf-8');
    return JSON.parse(data) as StoredAuth;
  } catch (error) {
    console.warn('Failed to load authentication data:', error);
    return null;
  }
}

/**
 * Check if authentication data exists
 */
export function hasAuth(): boolean {
  return existsSync(TOKEN_FILE_PATH);
}

/**
 * Clear stored authentication data
 */
export function clearAuth(): void {
  if (existsSync(TOKEN_FILE_PATH)) {
    try {
      writeFileSync(TOKEN_FILE_PATH, '', 'utf-8');
      // Alternatively, you could delete the file:
      // unlinkSync(TOKEN_FILE_PATH);
    } catch (error) {
      console.warn('Failed to clear authentication data:', error);
    }
  }
}
