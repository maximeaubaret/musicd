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
  const cliProcess = Bun.spawn(
    [process.execPath, join(import.meta.dir, "index.ts"), ...args],
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
