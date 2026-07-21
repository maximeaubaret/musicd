import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

async function runCli(
  args: string[],
  environment: Record<string, string> = {},
): Promise<CliResult> {
  const preloadPath = environment.MUSICD_CLI_EXPECTED_URL
    ? join(import.meta.dir, "connection-test-preload.ts")
    : environment.MUSICD_CLI_TEST_SCENARIO
      ? join(import.meta.dir, "../../server/src/api/queue-cli-test-preload.ts")
      : undefined;
  const preloadArgs = preloadPath ? ["--preload", preloadPath] : [];
  const cliProcess = Bun.spawn(
    [
      process.execPath,
      ...preloadArgs,
      join(import.meta.dir, "index.ts"),
      ...args,
    ],
    {
      env: { ...process.env, NO_COLOR: "1", ...environment },
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  const [exitCode, stderr, stdout] = await Promise.all([
    cliProcess.exited,
    new Response(cliProcess.stderr).text(),
    new Response(cliProcess.stdout).text(),
  ]);

  return { exitCode, stderr, stdout };
}

describe("CLI daemon transport", () => {
  test("remote HTTPS profiles work through the daemon client", async () => {
    const configHome = mkdtempSync(join(tmpdir(), "musicd-cli-https-test-"));
    const configDir = join(configHome, "musicd");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "cli.json"),
      JSON.stringify({
        defaultProfile: "remote",
        profiles: {
          remote: {
            host: "music.example.com",
            port: 443,
            protocol: "https",
            password: "secret",
          },
        },
      }),
    );

    try {
      const result = await runCli(["status"], {
        XDG_CONFIG_HOME: configHome,
        MUSICD_CLI_EXPECTED_URL: "https://music.example.com/api/status",
        MUSICD_CLI_EXPECTED_AUTHORIZATION: "Bearer secret",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("No playback in progress");
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  test("CLI overrides select HTTPS for a remote password-bearing connection", async () => {
    const result = await runCli(
      [
        "--protocol",
        "https",
        "--host",
        "music.example.com",
        "--port",
        "443",
        "--password",
        "secret",
        "status",
      ],
      {
        MUSICD_CLI_EXPECTED_URL: "https://music.example.com/api/status",
        MUSICD_CLI_EXPECTED_AUTHORIZATION: "Bearer secret",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("No playback in progress");
  });

  test("remote password-bearing HTTP fails without the explicit override", async () => {
    const result = await runCli(
      ["--host", "music.lan", "--password", "secret", "status"],
      {
        MUSICD_CLI_EXPECTED_URL: "http://music.lan:8765/api/status",
        MUSICD_CLI_EXPECTED_AUTHORIZATION: "Bearer secret",
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Refusing to send a daemon password over insecure HTTP",
    );
    expect(result.stdout).toBe("");
  });

  test("the insecure HTTP override is clearly surfaced to the user", async () => {
    const result = await runCli(
      [
        "--protocol",
        "http",
        "--host",
        "music.lan",
        "--password",
        "secret",
        "--allow-insecure-http",
        "status",
      ],
      {
        MUSICD_CLI_EXPECTED_URL: "http://music.lan:8765/api/status",
        MUSICD_CLI_EXPECTED_AUTHORIZATION: "Bearer secret",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Insecure HTTP override enabled");
    expect(result.stderr).toContain("without transport encryption");
    expect(result.stdout).toContain("No playback in progress");
  });
});

describe("CLI queue intent", () => {
  test("browse -q prepares an empty stopped queue without playback", async () => {
    const result = await runCli(["browse", "track", "-q"], {
      MUSICD_CLI_TEST_SCENARIO: "stopped-empty-browse-queue",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Added to queue: Test Track");
  });

  test("queue add appends to an existing stopped queue without playback", async () => {
    const result = await runCli(["queue", "add", "--id", "track-id"], {
      MUSICD_CLI_TEST_SCENARIO: "stopped-existing-queue-add",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Added to queue by ID: track-id");
  });

  test("browse -q does not replace current playback", async () => {
    const result = await runCli(["browse", "track", "-q"], {
      MUSICD_CLI_TEST_SCENARIO: "playing-existing-browse-queue",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Added to queue: Test Track");
  });

  test("browse without -q replaces current playback immediately", async () => {
    const result = await runCli(["browse", "track"], {
      MUSICD_CLI_TEST_SCENARIO: "playing-existing-browse-play",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Playing: Test Track");
  });

  test("queue add --loop leaves an already-enabled loop enabled", async () => {
    const result = await runCli(
      ["queue", "add", "--id", "track-id", "--loop"],
      { MUSICD_CLI_TEST_SCENARIO: "loop-enabled-queue-add" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Loop enabled");
  });

  test("queue add --loop completes every side effect before one JSON result", async () => {
    const result = await runCli(
      ["--json", "queue", "add", "--id", "track-id", "--loop"],
      { MUSICD_CLI_TEST_SCENARIO: "loop-enabled-queue-add" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      tracksAdded: 1,
      queueMode: { loop: true, random: false },
    });
  });

  test("search-based queue add emits only its final JSON result", async () => {
    const result = await runCli(["--json", "queue", "add", "track", "--loop"], {
      MUSICD_CLI_TEST_SCENARIO: "stopped-empty-browse-queue",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      tracksAdded: 1,
      queueMode: { loop: true, random: false },
    });
  });

  test("queue loop and random accept explicit states while retaining toggles", async () => {
    const loopResult = await runCli(["--json", "queue", "loop", "on"], {
      MUSICD_CLI_TEST_SCENARIO: "loop-enabled-queue-add",
    });
    const randomResult = await runCli(["--json", "queue", "random", "off"], {
      MUSICD_CLI_TEST_SCENARIO: "loop-enabled-queue-add",
    });
    const toggleResult = await runCli(["--json", "queue", "loop"], {
      MUSICD_CLI_TEST_SCENARIO: "loop-enabled-queue-add",
    });

    expect(JSON.parse(loopResult.stdout)).toMatchObject({
      queueMode: { loop: true, random: false },
    });
    expect(JSON.parse(randomResult.stdout)).toMatchObject({
      queueMode: { loop: true, random: false },
    });
    expect(JSON.parse(toggleResult.stdout)).toMatchObject({
      queueMode: { loop: false, random: false },
    });
  });
});

describe("CLI integer input validation", () => {
  test("--port rejects malformed, empty, and out-of-range values", async () => {
    for (const port of ["1junk", "1.5", "", "0", "65536"]) {
      const result = await runCli(["--port", port, "--version"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Port must be an integer from 1 to 65535",
      );
    }
  });

  test("--port accepts its documented bounds", async () => {
    for (const port of ["1", "65535"]) {
      const result = await runCli(["--port", port, "--version"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
    }
  });

  test("search --limit rejects malformed, empty, and out-of-range values", async () => {
    for (const limit of ["1junk", "1.5", "", "0", "101"]) {
      const result = await runCli(["search", "test", "--limit", limit], {
        DAEMON_PORT: "0",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Limit must be an integer from 1 to 100");
    }
  });

  test("invalid DAEMON_PORT values fail before a command runs", async () => {
    const emptyConfigHome = join(
      tmpdir(),
      `musicd-cli-config-${process.pid}-${Date.now()}`,
    );

    for (const port of ["1junk", "1.5", "", "0", "65536"]) {
      const result = await runCli(["status"], {
        DAEMON_PORT: port,
        XDG_CONFIG_HOME: emptyConfigHome,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "DAEMON_PORT must be an integer from 1 to 65535",
      );
    }
  });
});
