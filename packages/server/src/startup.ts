import type { Hono } from "hono";

import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  loadAuth,
  loadServerConfigIfPresent,
  recoverInterruptedSetup,
  saveSetupState,
} from "@musicd/shared";

import { createSetupApp } from "./setup-app";
import { JellyfinService } from "./services/jellyfin";

import type { ServerBindingConfig, ServerConfig } from "@musicd/shared";

export interface SetupServerStartup {
  mode: "setup";
  binding: ServerBindingConfig;
  existingConfig: ServerConfig | null;
}

export interface NormalServerStartup {
  mode: "normal";
  binding: ServerBindingConfig;
  config: ServerConfig;
}

export type ServerStartup = SetupServerStartup | NormalServerStartup;

/** Resolve the daemon's startup mode without opening a network listener. */
export function resolveServerStartup(): ServerStartup {
  recoverInterruptedSetup();
  const config = loadServerConfigIfPresent();
  const auth = loadAuth();

  if (!config || !auth) {
    return {
      mode: "setup",
      binding: {
        host: DEFAULT_DAEMON_HOST,
        port: DEFAULT_DAEMON_PORT,
      },
      existingConfig: config,
    };
  }

  return {
    mode: "normal",
    binding: config.daemon,
    config,
  };
}

/** Assemble setup mode with a non-persisting Jellyfin authentication attempt. */
export function createSetupModeApp(
  startup: SetupServerStartup,
  startTime: number,
): Hono {
  return createSetupApp({
    existingConfig: startup.existingConfig,
    startTime,
    authenticate: (config, username, password) => {
      const jellyfinService = new JellyfinService(config, () => null, null);
      return jellyfinService.authenticate(username, password);
    },
    persist: saveSetupState,
  });
}
