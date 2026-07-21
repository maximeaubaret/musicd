# Implement one musicd GitHub issue

Use the `/implement` skill to implement exactly this issue:

- Issue: #{{TICKET_NUMBER}}
- URL: {{TICKET_URL}}
- Title: {{TICKET_TITLE}}

## Issue body

{{TICKET_BODY}}

## Sandcastle contract

- Treat this prompt as the explicit invocation of `/implement` for this one issue.
- Follow `/implement` fully, including its `/tdd` workflow where possible, final `/code-review`, validation, and commit.
- Read `AGENTS.md`, the domain documentation it points to, and relevant source and test files before editing.
- Never start, stop, restart, kill, or probe the music daemon. Follow the server-management restrictions in `AGENTS.md`.
- Work only on this issue. Do not select or attempt another issue.
- Do not change GitHub labels or assignments, close issues, merge branches, or open pull requests; the Sandcastle runner owns tracker and merge state.
- If the issue cannot be completed, explain the blocker and do not emit the completion signal.
- After the implementation is reviewed, validated, and committed, output `<promise>COMPLETE</promise>`.
