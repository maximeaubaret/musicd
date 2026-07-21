import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";

import { ServerConfigSchema } from "./schemas";
import { getServerConfigPath } from "./config";
import { getAuthFilePath, StoredAuthSchema } from "./token-storage";
import { SetupStorageError } from "./types";

import type { AuthenticationResult, ServerConfig } from "./types";

const SETUP_MARKER_FILE = ".setup-pending";
const CONFIG_STAGING_FILE = "server.json.setup-pending";
const AUTH_STAGING_FILE = "auth.json.setup-pending";

interface SetupPaths {
  auth: string;
  authStaging: string;
  config: string;
  configStaging: string;
  marker: string;
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function getSetupPaths(): SetupPaths {
  const config = getServerConfigPath();
  const auth = getAuthFilePath();
  return {
    auth,
    authStaging: join(dirname(auth), AUTH_STAGING_FILE),
    config,
    configStaging: join(dirname(config), CONFIG_STAGING_FILE),
    marker: join(dirname(config), SETUP_MARKER_FILE),
  };
}

function getSetupFiles(paths: SetupPaths): string[] {
  return [
    paths.auth,
    paths.authStaging,
    paths.config,
    paths.configStaging,
    paths.marker,
  ];
}

function cleanupFailedSetup(paths: SetupPaths): void {
  let cleanupFailed = false;
  for (const path of getSetupFiles(paths).filter(
    (setupPath) => setupPath !== paths.marker,
  )) {
    try {
      removeIfPresent(path);
    } catch {
      cleanupFailed = true;
    }
  }

  if (!cleanupFailed) {
    removeIfPresent(paths.marker);
  }
}

/** Remove files left by a setup transaction that did not commit. */
export function recoverInterruptedSetup(): void {
  const paths = getSetupPaths();
  if (!existsSync(paths.marker)) {
    return;
  }

  for (const path of getSetupFiles(paths)) {
    removeIfPresent(path);
  }
}

/**
 * Persist configuration and authentication as one recoverable setup commit.
 * The marker lets the next startup discard both halves after interruption.
 */
export function saveSetupState(
  config: ServerConfig,
  authResult: AuthenticationResult,
  username: string,
): void {
  const validatedConfig = ServerConfigSchema.parse(config);
  const validatedAuth = StoredAuthSchema.parse({
    accessToken: authResult.AccessToken,
    userId: authResult.User.Id,
    serverId: authResult.ServerId,
    username,
    createdAt: Date.now(),
  });
  const paths = getSetupPaths();

  ensurePrivateDirectory(dirname(paths.config));
  ensurePrivateDirectory(dirname(paths.auth));

  try {
    writeFileSync(paths.marker, "pending\n", { mode: 0o600 });
    writeFileSync(
      paths.configStaging,
      JSON.stringify(validatedConfig, null, 2),
      { mode: 0o600 },
    );
    writeFileSync(paths.authStaging, JSON.stringify(validatedAuth, null, 2), {
      mode: 0o600,
    });
    renameSync(paths.authStaging, paths.auth);
    renameSync(paths.configStaging, paths.config);
    unlinkSync(paths.marker);
  } catch (error) {
    try {
      cleanupFailedSetup(paths);
    } catch {
      // The marker remains when cleanup cannot complete, so startup retries it.
    }
    throw new SetupStorageError(`Failed to save setup state: ${error}`);
  }
}
