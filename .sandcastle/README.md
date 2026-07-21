# Sandcastle issue runner

This runner connects GitHub Issues to the `/implement` skill. It discovers the
current dependency frontier, gives each selected issue a fresh Codex context and
isolated git worktree, and invokes `/implement` exactly once.

## Prerequisites

- Docker is running.
- `codex login` has authenticated the host CLI.
- `gh auth status` succeeds for this repository with permission to edit issues.
- The `ready-for-agent` and `ready-for-human` labels exist in GitHub.
- The repository has an initial commit and no non-ignored working-tree changes.
- Issue dependencies use GitHub's native `blocked by` relationships.
- Implementation issues contain a `## What to build` section; feature-level specs
  are therefore kept out of the execution queue.

## Setup

```sh
bun install
cp .sandcastle/.env.example .sandcastle/.env
bun run sandcastle:build-image
```

Commit the Sandcastle setup before running the queue; the runner refuses to create
worktrees from a dirty repository.

## Run

Preview eligible issues without starting Docker or changing GitHub state:

```sh
bun run sandcastle:dry-run
```

Process one eligible issue:

```sh
bun run sandcastle
```

Workers may remain silent while a long-running tool call is active. The default
idle timeout is 30 minutes and can be overridden in seconds:

```sh
SANDCASTLE_IDLE_TIMEOUT_SECONDS=3600 bun run sandcastle
```

Process up to 20 issues, with at most three independent frontier issues at once:

```sh
SANDCASTLE_MAX_ISSUES=20 SANDCASTLE_PARALLEL_ISSUES=3 bun run sandcastle
```

The runner claims each selected issue by assigning it to `@me`. A successful
`/implement` run is merged into the current branch and closes the issue, which may
expose a new dependency frontier. A worker failure with no commits removes the
assignment so the issue can be retried. Partial work or a merge conflict is
preserved on its Sandcastle branch and relabelled `ready-for-human`.

Because successful branches are merged automatically after `/implement` completes
its own code review, start with concurrency `1`. Raise it only for issues that are
genuinely independent; concurrent branches are merged sequentially and conflicts
are handed to a human rather than guessed through.
