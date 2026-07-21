import { spawnSync } from "node:child_process";

export interface GhCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type RunGhCommand = (args: readonly string[]) => GhCommandResult;

export interface GitHubIssueDependency {
  number: number;
  title: string;
  state: string;
  url: string;
}

export interface GitHubTicket {
  key: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignees: string[];
  blockedBy: GitHubIssueDependency[];
}

const READY_FOR_AGENT_LABEL = "ready-for-agent";
const READY_FOR_HUMAN_LABEL = "ready-for-human";

export class GitHubIssueTracker {
  private readonly runCommand: RunGhCommand;

  constructor(repoRoot: string, runCommand?: RunGhCommand) {
    this.runCommand = runCommand ?? createGhRunner(repoRoot);
  }

  /** List every open issue in the Sandcastle queue. */
  discoverTickets(): GitHubTicket[] {
    const output = this.execute([
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      READY_FOR_AGENT_LABEL,
      "--limit",
      "1000",
      "--json",
      "number,title,body,url,labels,assignees,blockedBy",
    ]);
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) {
      throw new Error("gh issue list returned a non-array response.");
    }
    return parsed.map(parseTicket).sort(compareTickets);
  }

  /** Assign an eligible issue to the authenticated GitHub user. */
  claim(ticket: GitHubTicket): void {
    this.execute([
      "issue",
      "edit",
      String(ticket.number),
      "--add-assignee",
      "@me",
    ]);
    this.comment(ticket, "Claimed by Sandcastle.");
  }

  /** Return a failed issue with no commits to the unassigned queue. */
  retry(ticket: GitHubTicket, detail: string): void {
    this.comment(ticket, detail);
    this.execute([
      "issue",
      "edit",
      String(ticket.number),
      "--remove-assignee",
      "@me",
    ]);
  }

  /** Hand an issue with partial work or a merge conflict to a human. */
  escalate(ticket: GitHubTicket, detail: string): void {
    this.execute([
      "issue",
      "edit",
      String(ticket.number),
      "--remove-label",
      READY_FOR_AGENT_LABEL,
      "--add-label",
      READY_FOR_HUMAN_LABEL,
      "--remove-assignee",
      "@me",
    ]);
    this.comment(ticket, detail);
  }

  /** Close an issue after its implementation branch has merged. */
  complete(ticket: GitHubTicket, detail: string): void {
    this.execute([
      "issue",
      "close",
      String(ticket.number),
      "--comment",
      detail,
    ]);
  }

  private comment(ticket: GitHubTicket, body: string): void {
    this.execute(["issue", "comment", String(ticket.number), "--body", body]);
  }

  private execute(args: readonly string[]): string {
    const result = this.runCommand(args);
    if (result.status !== 0) {
      throw new Error(
        `gh ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result.stdout;
  }
}

/** Select unassigned issues whose native GitHub dependencies are all closed. */
export function selectFrontier(tickets: GitHubTicket[]): GitHubTicket[] {
  return tickets
    .filter((ticket) => ticket.labels.includes(READY_FOR_AGENT_LABEL))
    .filter((ticket) => /^## What to build\s*$/im.test(ticket.body))
    .filter((ticket) => ticket.assignees.length === 0)
    .filter((ticket) =>
      ticket.blockedBy.every(
        (dependency) => dependency.state.toLowerCase() === "closed",
      ),
    )
    .sort(compareTickets);
}

/** Explain which open dependencies keep an issue outside the frontier. */
export function blockedReasons(ticket: GitHubTicket): string[] {
  return ticket.blockedBy
    .filter((dependency) => dependency.state.toLowerCase() !== "closed")
    .map((dependency) => `#${dependency.number} (${dependency.title})`);
}

function createGhRunner(repoRoot: string): RunGhCommand {
  return (args: readonly string[]): GhCommandResult => {
    const result = spawnSync("gh", [...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

function parseTicket(value: unknown): GitHubTicket {
  const issue = record(value, "issue");
  const number = numberValue(issue.number, "issue.number");
  return {
    key: String(number),
    number,
    title: stringValue(issue.title, "issue.title"),
    body: nullableString(issue.body, "issue.body"),
    url: stringValue(issue.url, "issue.url"),
    labels: namedValues(issue.labels, "issue.labels", "name"),
    assignees: namedValues(issue.assignees, "issue.assignees", "login"),
    blockedBy: dependencies(issue.blockedBy),
  };
}

function dependencies(value: unknown): GitHubIssueDependency[] {
  if (value === null) return [];
  const connection = record(value, "issue.blockedBy");
  if (!Array.isArray(connection.nodes)) {
    throw new Error("issue.blockedBy.nodes must be an array.");
  }
  return connection.nodes.map((candidate): GitHubIssueDependency => {
    const dependency = record(candidate, "issue.blockedBy entry");
    return {
      number: numberValue(dependency.number, "dependency.number"),
      title: stringValue(dependency.title, "dependency.title"),
      state: stringValue(dependency.state, "dependency.state"),
      url: stringValue(dependency.url, "dependency.url"),
    };
  });
}

function namedValues(value: unknown, field: string, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }
  return value.map((candidate) => {
    const item = record(candidate, `${field} entry`);
    return stringValue(item[key], `${field}.${key}`);
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string {
  if (value === null) return "";
  return stringValue(value, field);
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer.`);
  }
  return value;
}

function compareTickets(left: GitHubTicket, right: GitHubTicket): number {
  return left.number - right.number;
}
