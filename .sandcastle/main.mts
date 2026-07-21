import { codex, createSandbox } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  GitHubIssueTracker,
  blockedReasons,
  selectFrontier,
} from "./github-issues.mts";

import type { GitHubTicket } from "./github-issues.mts";

interface PipelineResult {
  ticket: GitHubTicket;
  branch: string;
  baseSha: string;
  completed: boolean;
  commits: number;
  logFilePath?: string;
  error?: string;
}

interface GitCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

const repoRoot = process.cwd();
loadDotEnv(path.join(repoRoot, ".sandcastle", ".env"));

const maxIssues = positiveInteger("SANDCASTLE_MAX_ISSUES", 1);
const parallelIssues = positiveInteger("SANDCASTLE_PARALLEL_ISSUES", 1);
const idleTimeoutSeconds = positiveInteger(
  "SANDCASTLE_IDLE_TIMEOUT_SECONDS",
  1800,
);
const model = process.env.SANDCASTLE_CODEX_MODEL ?? "gpt-5.6-sol";
const effort = codexEffort(process.env.SANDCASTLE_CODEX_EFFORT ?? "high");
const imageName =
  process.env.SANDCASTLE_DOCKER_IMAGE ?? "musicd-sandcastle:latest";
const dryRun = process.env.SANDCASTLE_DRY_RUN === "1";
const processed = new Set<string>();
const tracker = new GitHubIssueTracker(repoRoot);

if (!dryRun) assertRunnableRepository();

console.log(
  `Sandcastle: max=${maxIssues} parallel=${parallelIssues} idleTimeout=${idleTimeoutSeconds}s model=${model} effort=${effort} dryRun=${dryRun ? "1" : "0"}`,
);

let remaining = maxIssues;
while (remaining > 0) {
  const allTickets = tracker.discoverTickets();
  reportBlockedTickets(allTickets);
  const frontier = selectFrontier(allTickets)
    .filter((ticket) => !processed.has(ticket.key))
    .slice(0, Math.min(parallelIssues, remaining));

  if (frontier.length === 0) {
    console.log("No eligible, unblocked ready-for-agent issues found.");
    break;
  }

  for (const ticket of frontier) processed.add(ticket.key);
  remaining -= frontier.length;

  if (dryRun) {
    for (const ticket of frontier) {
      console.log(`Would implement #${ticket.number}: ${ticket.title}`);
    }
    continue;
  }

  const claimed = frontier.filter((ticket) => {
    try {
      tracker.claim(ticket);
      return true;
    } catch (error) {
      console.error(
        `Could not claim #${ticket.number}: ${errorMessage(error)}`,
      );
      return false;
    }
  });

  console.log(`Running ${claimed.length} issue(s) in parallel.`);
  const results = await Promise.all(claimed.map(runTicket));
  for (const result of results) finishTicket(result);
}

async function runTicket(ticket: GitHubTicket): Promise<PipelineResult> {
  const baseSha = git(["rev-parse", "HEAD"]).stdout.trim();
  const branch = `sandcastle/issue-${ticket.number}-${slug(ticket.title)}-${Date.now()}`;
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
  let commits = 0;
  let logFilePath: string | undefined;

  console.log(`\n=== #${ticket.number}: ${ticket.title} ===`);
  console.log(`Branch: ${branch}`);

  try {
    sandbox = await createSandbox({
      branch,
      baseBranch: baseSha,
      sandbox: docker({
        imageName,
        env: {
          CI: "1",
        },
        mounts: [
          { hostPath: "~/.codex", sandboxPath: "~/.codex" },
          {
            hostPath: "~/.agents/skills",
            sandboxPath: "~/.agents/skills",
            readonly: true,
          },
        ],
      }),
      hooks: {
        sandbox: {
          onSandboxReady: [{ command: "bun install --frozen-lockfile" }],
        },
      },
    });

    const result = await sandbox.run({
      name: `implement-issue-${ticket.number}`,
      agent: codex(model, { effort }),
      maxIterations: 1,
      idleTimeoutSeconds,
      promptFile: "./.sandcastle/implement-prompt.md",
      promptArgs: {
        TICKET_NUMBER: String(ticket.number),
        TICKET_URL: ticket.url,
        TICKET_TITLE: ticket.title,
        TICKET_BODY: ticket.body || "No issue body was provided.",
      },
      completionSignal: "<promise>COMPLETE</promise>",
    });

    commits = result.commits.length;
    logFilePath = result.logFilePath;
    if (result.completionSignal !== "<promise>COMPLETE</promise>") {
      throw new Error(
        "The implementation worker did not emit its completion signal.",
      );
    }
    if (commits === 0) {
      throw new Error(
        "The /implement worker completed without making a commit.",
      );
    }

    return {
      ticket,
      branch,
      baseSha,
      completed: true,
      commits,
      logFilePath,
    };
  } catch (error) {
    return {
      ticket,
      branch,
      baseSha,
      completed: false,
      commits,
      logFilePath,
      error: errorMessage(error),
    };
  } finally {
    if (sandbox) await sandbox.close();
  }
}

function finishTicket(result: PipelineResult): void {
  const { ticket, branch, baseSha } = result;
  if (!result.completed) {
    const hasPartialCommits = branchAheadOf(branch, baseSha);
    const detail = [
      `Sandcastle implementation failed: ${result.error ?? "unknown error"}.`,
      hasPartialCommits
        ? `Partial work is preserved on branch \`${branch}\`.`
        : "",
      result.logFilePath ? `Log: \`${result.logFilePath}\`.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (hasPartialCommits) {
      tracker.escalate(ticket, detail);
    } else {
      tracker.retry(ticket, detail);
      deleteBranch(branch);
    }
    console.error(`#${ticket.number} failed: ${result.error}`);
    return;
  }

  const merge = git(["merge", "--no-ff", "--no-edit", branch], false);
  if (merge.status !== 0) {
    git(["merge", "--abort"], false);
    tracker.escalate(
      ticket,
      `Implementation passed but could not be merged automatically. Resolve branch \`${branch}\` manually.`,
    );
    console.error(
      `Merge failed for #${ticket.number}; branch preserved: ${branch}`,
    );
    return;
  }

  tracker.complete(
    ticket,
    `Implemented with /implement and merged from branch \`${branch}\` (${result.commits} worker commit(s)).`,
  );
  deleteBranch(branch);
  console.log(`Completed #${ticket.number}.`);
}

function reportBlockedTickets(tickets: GitHubTicket[]): void {
  for (const ticket of tickets) {
    const reasons = blockedReasons(ticket);
    if (reasons.length > 0) {
      console.log(`#${ticket.number} blocked by ${reasons.join(", ")}.`);
    }
  }
}

function assertRunnableRepository(): void {
  const head = git(["rev-parse", "--verify", "HEAD"], false);
  if (head.status !== 0) {
    throw new Error(
      "Sandcastle requires an initial git commit before it can create issue worktrees.",
    );
  }

  const status = git(["status", "--porcelain", "--untracked-files=normal"]);
  if (status.stdout.trim()) {
    throw new Error(
      "Commit or remove non-ignored working-tree changes before running Sandcastle.",
    );
  }
}

function branchAheadOf(branch: string, baseSha: string): boolean {
  const count = git(["rev-list", "--count", `${baseSha}..${branch}`], false);
  return count.status === 0 && Number(count.stdout.trim()) > 0;
}

function deleteBranch(branch: string): void {
  git(["branch", "-D", branch], false);
}

function git(args: string[], throwOnFailure = true): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const output: GitCommandResult = {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  if (throwOnFailure && output.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${output.stderr.trim()}`);
  }
  return output;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function codexEffort(value: string): "low" | "medium" | "high" | "xhigh" {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  throw new Error(
    "SANDCASTLE_CODEX_EFFORT must be low, medium, high, or xhigh.",
  );
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadDotEnv(filePath: string): void {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]!] !== undefined) continue;
    process.env[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
}
