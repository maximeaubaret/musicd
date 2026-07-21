import { describe, expect, test } from "bun:test";
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
  const preloadArgs = environment.MUSICD_CLI_TEST_SCENARIO
    ? [
        "--preload",
        join(import.meta.dir, "../../server/src/api/queue-cli-test-preload.ts"),
      ]
    : [];
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
