import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { ConfigError } from "./types";
import { loadServerConfig, resolveDaemonConnection } from "./config";

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalDaemonPort = process.env.DAEMON_PORT;
const originalDaemonBindPort = process.env.DAEMON_BIND_PORT;

let configHome: string;

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "musicd-config-test-"));
  process.env.XDG_CONFIG_HOME = configHome;
  delete process.env.DAEMON_PORT;
  delete process.env.DAEMON_BIND_PORT;
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });

  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalDaemonPort === undefined) {
    delete process.env.DAEMON_PORT;
  } else {
    process.env.DAEMON_PORT = originalDaemonPort;
  }
  if (originalDaemonBindPort === undefined) {
    delete process.env.DAEMON_BIND_PORT;
  } else {
    process.env.DAEMON_BIND_PORT = originalDaemonBindPort;
  }
});

describe("port environment configuration", () => {
  test("DAEMON_PORT rejects malformed, empty, and out-of-range values", () => {
    for (const port of ["1junk", "1.5", "", "0", "65536"]) {
      process.env.DAEMON_PORT = port;

      expect(() => resolveDaemonConnection()).toThrow(ConfigError);
    }
  });

  test("DAEMON_BIND_PORT rejects malformed, empty, and out-of-range values", () => {
    const musicdConfigDir = join(configHome, "musicd");
    mkdirSync(musicdConfigDir, { recursive: true });
    writeFileSync(
      join(musicdConfigDir, "server.json"),
      JSON.stringify({
        jellyfin: { serverUrl: "http://localhost:8096" },
        daemon: { host: "127.0.0.1", port: 8765 },
      }),
    );

    for (const port of ["1junk", "1.5", "", "0", "65536"]) {
      process.env.DAEMON_BIND_PORT = port;

      expect(() => loadServerConfig()).toThrow(ConfigError);
    }
  });

  test("port environment variables accept their documented bounds", () => {
    const musicdConfigDir = join(configHome, "musicd");
    mkdirSync(musicdConfigDir, { recursive: true });
    writeFileSync(
      join(musicdConfigDir, "server.json"),
      JSON.stringify({
        jellyfin: { serverUrl: "http://localhost:8096" },
        daemon: { host: "127.0.0.1", port: 8765 },
      }),
    );

    for (const port of ["1", "65535"]) {
      process.env.DAEMON_PORT = port;
      process.env.DAEMON_BIND_PORT = port;

      expect(resolveDaemonConnection().port).toBe(Number(port));
      expect(loadServerConfig().daemon.port).toBe(Number(port));
    }
  });
});
