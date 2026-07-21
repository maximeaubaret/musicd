import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { ConfigError } from "./types";
import { loadServerConfig, resolveDaemonConnection } from "./config";

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalDaemonPort = process.env.DAEMON_PORT;
const originalDaemonBindPort = process.env.DAEMON_BIND_PORT;
const originalDaemonProtocol = process.env.DAEMON_PROTOCOL;
const originalDaemonPassword = process.env.DAEMON_PASSWORD;
const originalAllowInsecureHttp = process.env.DAEMON_ALLOW_INSECURE_HTTP;

let configHome: string;

function restoreEnvironmentVariable(
  name: string,
  originalValue: string | undefined,
): void {
  if (originalValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = originalValue;
  }
}

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "musicd-config-test-"));
  process.env.XDG_CONFIG_HOME = configHome;
  delete process.env.DAEMON_PORT;
  delete process.env.DAEMON_BIND_PORT;
  delete process.env.DAEMON_PROTOCOL;
  delete process.env.DAEMON_PASSWORD;
  delete process.env.DAEMON_ALLOW_INSECURE_HTTP;
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
  restoreEnvironmentVariable("XDG_CONFIG_HOME", originalXdgConfigHome);
  restoreEnvironmentVariable("DAEMON_PORT", originalDaemonPort);
  restoreEnvironmentVariable("DAEMON_BIND_PORT", originalDaemonBindPort);
  restoreEnvironmentVariable("DAEMON_PROTOCOL", originalDaemonProtocol);
  restoreEnvironmentVariable("DAEMON_PASSWORD", originalDaemonPassword);
  restoreEnvironmentVariable(
    "DAEMON_ALLOW_INSECURE_HTTP",
    originalAllowInsecureHttp,
  );
});

describe("daemon connection protocol", () => {
  test("profiles select HTTPS while existing profiles default to HTTP", () => {
    const musicdConfigDir = join(configHome, "musicd");
    mkdirSync(musicdConfigDir, { recursive: true });
    writeFileSync(
      join(musicdConfigDir, "cli.json"),
      JSON.stringify({
        profiles: {
          local: { host: "127.0.0.1", port: 8765 },
          remote: {
            host: "music.example.com",
            port: 443,
            protocol: "https",
          },
        },
      }),
    );

    expect(resolveDaemonConnection({ profile: "local" }).protocol).toBe("http");
    expect(resolveDaemonConnection({ profile: "remote" }).protocol).toBe(
      "https",
    );
  });

  test("CLI settings override environment settings, which override profiles", () => {
    const musicdConfigDir = join(configHome, "musicd");
    mkdirSync(musicdConfigDir, { recursive: true });
    writeFileSync(
      join(musicdConfigDir, "cli.json"),
      JSON.stringify({
        defaultProfile: "remote",
        profiles: {
          remote: {
            host: "profile.example.com",
            port: 443,
            protocol: "https",
            password: "profile-password",
            allowInsecureHttp: false,
          },
        },
      }),
    );

    process.env.DAEMON_PROTOCOL = "http";
    process.env.DAEMON_PASSWORD = "environment-password";
    process.env.DAEMON_ALLOW_INSECURE_HTTP = "true";

    expect(resolveDaemonConnection()).toMatchObject({
      protocol: "http",
      password: "environment-password",
      allowInsecureHttp: true,
    });
    expect(
      resolveDaemonConnection({
        protocol: "https",
        password: "cli-password",
        allowInsecureHttp: false,
      }),
    ).toMatchObject({
      protocol: "https",
      password: "cli-password",
      allowInsecureHttp: false,
    });
  });
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
