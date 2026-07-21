import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { loadAuth, loadServerConfig } from "@musicd/shared";

import { createSetupModeApp, resolveServerStartup } from "./startup";

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalFetch = globalThis.fetch;

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
  testDir = mkdtempSync(join(tmpdir(), "musicd-startup-test-"));
  process.env.XDG_CONFIG_HOME = join(testDir, "config");
  process.env.XDG_DATA_HOME = join(testDir, "data");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(testDir, { recursive: true, force: true });
  restoreEnvironmentVariable("XDG_CONFIG_HOME", originalXdgConfigHome);
  restoreEnvironmentVariable("XDG_DATA_HOME", originalXdgDataHome);
});

describe("server startup", () => {
  test("a clean install starts in setup mode on loopback-safe defaults", () => {
    expect(resolveServerStartup()).toEqual({
      mode: "setup",
      binding: {
        host: "127.0.0.1",
        port: 8765,
      },
      existingConfig: null,
    });
  });

  test("an interrupted setup is discarded before startup mode is resolved", () => {
    const configDir = join(testDir, "config", "musicd");
    const dataDir = join(testDir, "data", "musicd");
    const configPath = join(configDir, "server.json");
    const authPath = join(dataDir, "auth.json");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(configDir, ".setup-pending"), "pending\n");
    writeFileSync(
      configPath,
      JSON.stringify({
        jellyfin: { serverUrl: "https://partial.example" },
        daemon: { host: "127.0.0.1", port: 8765 },
      }),
    );
    writeFileSync(
      authPath,
      JSON.stringify({
        accessToken: "partial-token",
        userId: "user-1",
        serverId: "server-1",
        username: "listener",
        createdAt: 1,
      }),
    );

    expect(resolveServerStartup()).toMatchObject({ mode: "setup" });
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(authPath)).toBe(false);
  });

  test("the assembled setup app authenticates and commits startup state", async () => {
    const fetchMock = mock(async () =>
      Response.json({
        User: { Id: "user-1", Name: "Listener" },
        AccessToken: "token-1",
        ServerId: "server-1",
      }),
    );
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const startup = resolveServerStartup();
    if (startup.mode !== "setup") {
      throw new Error("Expected setup mode");
    }
    const app = createSetupModeApp(startup, 0);

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
    expect(loadServerConfig().jellyfin.serverUrl).toBe(
      "https://jellyfin.example",
    );
    expect(loadAuth()).toMatchObject({ accessToken: "token-1" });
  });
});
