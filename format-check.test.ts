import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("format check reports unformatted files without rewriting them", () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "musicd-format-check-"));
  const fixturePath = join(fixtureDirectory, "unformatted.ts");
  const unformattedSource = "export const fixture={value:'unchanged'}\n";

  try {
    writeFileSync(fixturePath, unformattedSource, "utf8");

    const result = Bun.spawnSync(
      ["bun", "run", "format:check", "--", fixturePath],
      {
        cwd: import.meta.dir,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("Code style issues found");
    expect(readFileSync(fixturePath, "utf8")).toBe(unformattedSource);
  } finally {
    rmSync(fixtureDirectory, { force: true, recursive: true });
  }
});
