import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { getAuthFilePath, loadAuth } from "./token-storage";

let testDir: string;
let originalXdgDataHome: string | undefined;
let originalWarn: typeof console.warn;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `musicd-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = testDir;
  originalWarn = console.warn;
});

afterEach(() => {
  console.warn = originalWarn;
  if (originalXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalXdgDataHome;
  }
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

function writeAuthFile(auth: unknown): void {
  mkdirSync(join(testDir, "musicd"), { recursive: true });
  writeFileSync(getAuthFilePath(), JSON.stringify(auth), "utf-8");
}

describe("token storage", () => {
  test("loads complete stored authentication", () => {
    writeAuthFile({
      accessToken: "token-1",
      userId: "user-1",
      serverId: "server-1",
      username: "listener",
      createdAt: 1_700_000_000_000,
    });

    expect(loadAuth()).toEqual({
      accessToken: "token-1",
      userId: "user-1",
      serverId: "server-1",
      username: "listener",
      createdAt: 1_700_000_000_000,
    });
  });

  test("ignores incomplete stored authentication", () => {
    writeAuthFile({
      accessToken: "token-1",
      userId: "user-1",
      username: "listener",
      createdAt: 1_700_000_000_000,
    });

    expect(loadAuth()).toBeNull();
  });

  test("ignores malformed stored authentication JSON", () => {
    mkdirSync(join(testDir, "musicd"), { recursive: true });
    writeFileSync(getAuthFilePath(), "{not-json", "utf-8");

    expect(loadAuth()).toBeNull();
  });

  test("ignores incorrectly typed stored authentication without exposing credentials", () => {
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    writeAuthFile({
      accessToken: "jellyfin-token-DO-NOT-LOG",
      userId: "user-1",
      serverId: "server-1",
      username: "listener",
      createdAt: "yesterday",
    });

    expect(loadAuth()).toBeNull();
    expect(warnings.join("\n")).toContain(
      "Invalid authentication data format, ignoring",
    );
    expect(warnings.join("\n")).not.toContain("jellyfin-token-DO-NOT-LOG");
  });
});
