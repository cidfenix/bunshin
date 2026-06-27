# Autopilot — reusable autonomous goal loop

Autopilot drains a Trello board of lightweight, human-authored goals by implementing each one fully
autonomously — code → three gates → auto-merge — with **no human in the review loop**. It is
**process-only**: no orchestrator program, just markdown the driver follows plus a single config
file. Full design rationale: `docs/superpowers/specs/2026-06-24-autopilot-goal-loop-design.md`.

This folder is designed to be **dropped into any repository**. All repo-specific values are isolated
in `autopilot.config.json`; the driver and the three agent briefs are generic and read from it.

## What's in this folder

| File | Generic or per-repo? | Purpose |
| --- | --- | --- |
| `autopilot.config.json` | **PER-REPO** (the only file you edit) | All repo-specific values: board ids, worktree base dir, install/gate/dev-server commands, artifact dir, benign-console-error allowlist. |
| `driver.md` | Generic | The `/loop` driver procedure: pick a card, worktree, three gates, fast-forward merge. |
| `agents/implement.md` | Generic | Implement-agent brief (TDD, scoped commit, CLAUDE.md status line). |
| `agents/verify.md` | Generic | Verify-agent brief (Playwright smoke + reachability + screenshot). |
| `agents/review.md` | Generic | Adversarial review-agent brief (BLOCK/APPROVE). |
| `artifacts/` | Per-repo output | Committed Gate 2 screenshots (the audit trail). |

The driver, the briefs, and the workflow do **not** change between repositories — only
`autopilot.config.json` does.

## How to reuse this autopilot in another repository

1. **Copy the folder.** Copy `docs/superpowers/autopilot/` into the new repo (keep the same path so
   the driver's internal references resolve). You may empty `artifacts/`.
2. **Create the Trello board.** Make a board with four lists named exactly **Pending**, **In
   Progress**, **Blocked**, **Done** (or pick your own names and set them under `board.lists`). The
   board is reached via the `mcp__trello__*` MCP server — make sure that MCP is configured for the
   project so the launched `claude` session inherits it.
3. **Edit `autopilot.config.json`** — this is the only file you change:
   - `board.boardId` / `board.boardShortLink` / `board.boardName` — your new board's ids. (List ids
     are resolved by NAME at runtime, so you never hardcode them.)
   - `git.baseBranch` — the branch goals merge into (`master`/`main`).
   - `git.worktreeBaseDir` — where per-goal worktrees are created (a sibling dir to the repo).
   - `git.branchPrefix` — branch/worktree name prefix (default `goal/`).
   - `artifactsDir` — where Gate 2 screenshots are committed.
   - `commands.install` — the project's dependency install (keep any no-build-scripts flag; see
     `commands.installNote`).
   - `commands.gateChecks` — the deterministic Gate 1 + merge re-gate checks (typecheck/build/test).
   - `commands.devServer` / `commands.agentStart` — how Gate 2 boots the app (and the optional local
     agent for `[agent]`-tagged goals).
   - `verify.agentTag` — the card-name token that flips a goal to the agent path.
   - `verify.benignConsoleErrors` — substrings of EXPECTED offline console noise Gate 2 must ignore
     (e.g. your cloud/agent endpoints that aren't running during the smoke test).
   - `neverCommit.paths` — install-churn files the agents must never stage and Gate 3 blocks.
4. **Make sure the repo has a `CLAUDE.md`** with the project's architecture, layout, conventions, and
   a "Current status / Next up" section — the agents read it for context and append a status line on
   merge.
5. **Launch the loop.** Run `npx claude-autopilot run` (or `npx claude-autopilot run --once` /
   `--interval 30m` / `--unattended`). It checks the tree is clean, builds the self-paced `/loop`
   prompt (*read `docs/superpowers/autopilot/driver.md` and drain the board*), and launches Claude
   Code. The driver re-reads `driver.md` + `autopilot.config.json` each iteration, so the config is
   always live.

## How a goal flows (unchanged per repo)

1. The driver takes the first **Pending** card, moves it to **In Progress**, and cuts an isolated
   worktree `<worktreeBaseDir>/<N>-<slug>` on branch `<branchPrefix><N>-<slug>` off `<baseBranch>`
   (`N` = the card's Trello `idShort`).
2. **Gate 1 (deterministic):** the implement agent codes the goal TDD-style; the driver runs
   `commands.install` then `commands.gateChecks`.
3. **Gate 2 (behavioral):** the verify agent boots `commands.devServer` (+ `commands.agentStart` for
   `[agent]` goals), exercises the feature with Playwright, asserts it renders with no NEW console
   errors (ignoring `verify.benignConsoleErrors`), and commits a screenshot to `artifactsDir`.
4. **Gate 3 (review):** a fresh adversarial agent reviews the diff and returns BLOCK or APPROVE.
5. **Merge:** rebase onto `<baseBranch>`, re-run `commands.gateChecks`, fast-forward merge, move the
   card to **Done** with a `merged: <sha>` comment. Any gate failure → **Blocked** with the reason
   (branch kept, worktree removed).

The card's list is the authoritative status, so a run is crash-resumable (a card in **In Progress**
is an interrupted run to resume). Execution is **serial** and parks on the **first** gate failure —
no auto-repair, no retry; the human re-queues by dragging the card back to **Pending**.
