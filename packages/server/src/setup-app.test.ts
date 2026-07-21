import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  APP_VERSION,
  getAuthFilePath,
  getServerConfigPath,
  JellyfinError,
  loadAuth,
  loadServerConfig,
  saveSetupState,
} from "@musicd/shared";

import { createSetupApp } from "./setup-app";
import { resolveServerStartup } from "./startup";

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

let testDir: string;

function restoreEnvironmentVariable(
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "musicd-setup-app-test-"));
  process.env.XDG_CONFIG_HOME = join(testDir, "config");
  process.env.XDG_DATA_HOME = join(testDir, "data");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  restoreEnvironmentVariable("XDG_CONFIG_HOME", originalXdgConfigHome);
  restoreEnvironmentVariable("XDG_DATA_HOME", originalXdgDataHome);
});

function failIfCalled(): never {
  throw new Error("Unexpected setup dependency call");
}

describe("setup-mode API", () => {
  test("exposes only health and setup authentication", async () => {
    const app = createSetupApp({
      authenticate: failIfCalled,
      persist: failIfCalled,
      startTime: 1_000,
      clock: { now: () => 125_000 },
    });

    const healthResponse = await app.request("/api/health");

    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({
      success: true,
      status: "healthy",
      uptime: 124,
      version: APP_VERSION,
    });

    for (const [method, path] of [
      ["GET", "/"],
      ["POST", "/api/play"],
      ["GET", "/api/status"],
      ["GET", "/api/search?q=test"],
      ["GET", "/api/queue"],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(404);
    }
  });

  test("successful custom-server setup becomes normal startup state", async () => {
    const authenticatedServerUrls: string[] = [];
    const app = createSetupApp({
      authenticate: async (config) => {
        authenticatedServerUrls.push(config.serverUrl);
        return {
          User: { Id: "user-1", Name: "Listener" },
          AccessToken: "token-1",
          ServerId: "server-1",
        };
      },
      persist: saveSetupState,
      startTime: 0,
    });

    const response = await app.request("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverUrl: "https://jellyfin.example",
        username: "listener",
        password: "jellyfin-password",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      user: { id: "user-1", name: "Listener" },
    });
    expect(authenticatedServerUrls).toEqual(["https://jellyfin.example"]);
    expect(loadServerConfig()).toEqual({
      jellyfin: { serverUrl: "https://jellyfin.example" },
      daemon: { host: "127.0.0.1", port: 8765 },
    });
    expect(loadAuth()).toMatchObject({
      accessToken: "token-1",
      userId: "user-1",
      serverId: "server-1",
      username: "listener",
    });
    expect(resolveServerStartup()).toMatchObject({
      mode: "normal",
      binding: { host: "127.0.0.1", port: 8765 },
      config: {
        jellyfin: { serverUrl: "https://jellyfin.example" },
      },
    });
  });

  test("failed authentication leaves configuration and credentials absent", async () => {
    let persistCalled = false;
    const app = createSetupApp({
      authenticate: async () => {
        throw new JellyfinError("Invalid username or password", 401);
      },
      persist: () => {
        persistCalled = true;
      },
      startTime: 0,
    });

    const response = await app.request("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverUrl: "https://jellyfin.example",
        username: "listener",
        password: "wrong-password",
      }),
    });

    expect(response.status).toBe(401);
    expect(persistCalled).toBe(false);
    expect(existsSync(getServerConfigPath())).toBe(false);
    expect(existsSync(getAuthFilePath())).toBe(false);
    expect(loadAuth()).toBeNull();
  });
});
