import { describe, expect, test } from "bun:test";

import {
  GitHubIssueTracker,
  blockedReasons,
  selectFrontier,
} from "./github-issues.mts";

import type {
  GhCommandResult,
  GitHubTicket,
  RunGhCommand,
} from "./github-issues.mts";

describe("GitHub issue tracker", () => {
  test("selects unassigned ready issues whose blockers are closed", () => {
    const tickets = [
      ticket(1),
      ticket(2, { blockedBy: [dependency(1, "CLOSED")] }),
      ticket(3, { blockedBy: [dependency(2, "OPEN")] }),
      ticket(4, { assignees: ["maintainer"] }),
      ticket(5, { body: "## Problem Statement\n\nA feature-level spec." }),
    ];

    expect(
      selectFrontier(tickets).map((candidate) => candidate.number),
    ).toEqual([1, 2]);
    expect(blockedReasons(tickets[2]!)).toEqual(["#2 (Issue 2)"]);
  });

  test("discovers and validates issues returned by gh", () => {
    const fake = fakeGh(JSON.stringify([ticketJson(12)]));
    const tracker = new GitHubIssueTracker("/repo", fake.run);

    expect(tracker.discoverTickets()).toEqual([ticket(12)]);
    expect(fake.calls[0]?.at(-1)).toContain("blockedBy");
  });

  test("claims an issue through assignment and a comment", () => {
    const fake = fakeGh("");
    const tracker = new GitHubIssueTracker("/repo", fake.run);

    tracker.claim(ticket(7));

    expect(fake.calls).toEqual([
      ["issue", "edit", "7", "--add-assignee", "@me"],
      ["issue", "comment", "7", "--body", "Claimed by Sandcastle."],
    ]);
  });

  test("returns commitless failures to the unassigned queue", () => {
    const fake = fakeGh("");
    const tracker = new GitHubIssueTracker("/repo", fake.run);

    tracker.retry(ticket(7), "Worker failed.");

    expect(fake.calls).toEqual([
      ["issue", "comment", "7", "--body", "Worker failed."],
      ["issue", "edit", "7", "--remove-assignee", "@me"],
    ]);
  });

  test("hands partial work to a human", () => {
    const fake = fakeGh("");
    const tracker = new GitHubIssueTracker("/repo", fake.run);

    tracker.escalate(ticket(7), "Partial work is on a branch.");

    expect(fake.calls).toEqual([
      [
        "issue",
        "edit",
        "7",
        "--remove-label",
        "ready-for-agent",
        "--add-label",
        "ready-for-human",
        "--remove-assignee",
        "@me",
      ],
      ["issue", "comment", "7", "--body", "Partial work is on a branch."],
    ]);
  });

  test("closes completed issues with the merge detail", () => {
    const fake = fakeGh("");
    const tracker = new GitHubIssueTracker("/repo", fake.run);

    tracker.complete(ticket(7), "Merged branch.");

    expect(fake.calls).toEqual([
      ["issue", "close", "7", "--comment", "Merged branch."],
    ]);
  });
});

interface FakeGh {
  calls: string[][];
  run: RunGhCommand;
}

function fakeGh(stdout: string): FakeGh {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: readonly string[]): GhCommandResult => {
      calls.push([...args]);
      return { status: 0, stdout, stderr: "" };
    },
  };
}

function ticket(
  number: number,
  overrides: Partial<GitHubTicket> = {},
): GitHubTicket {
  return {
    key: String(number),
    number,
    title: `Issue ${number}`,
    body: `## What to build\n\nBody ${number}`,
    url: `https://github.com/example/repo/issues/${number}`,
    labels: ["ready-for-agent"],
    assignees: [],
    blockedBy: [],
    ...overrides,
  };
}

function ticketJson(number: number): object {
  return {
    number,
    title: `Issue ${number}`,
    body: `## What to build\n\nBody ${number}`,
    url: `https://github.com/example/repo/issues/${number}`,
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    blockedBy: { nodes: [], totalCount: 0 },
  };
}

function dependency(
  number: number,
  state: string,
): GitHubTicket["blockedBy"][number] {
  return {
    number,
    title: `Issue ${number}`,
    state,
    url: `https://github.com/example/repo/issues/${number}`,
  };
}
