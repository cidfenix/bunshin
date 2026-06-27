# Bunshin

> 影分身の術 — *Kage Bunshin no Jutsu*. Shadow clones that drain your backlog.

Bunshin is a **standalone, zero-dependency CLI** that runs an **autonomous goal loop for Claude Code**,
driven by your **Trello board or Jira project**: you stack lightweight goals (cards / issues), and
Bunshin implements each one fully autonomously — code → three gates → auto-merge — with **no human in
the review loop**. It is
**process-only**: there is no orchestrator daemon, just a markdown pipeline that a Claude Code `/loop`
session follows, plus a thin CLI.

This file is the canonical context for any agent working on **the Bunshin tool itself**. (Not to be
confused with the `template/driver.md` pipeline, which is the procedure Bunshin *ships* for draining a
board — see "Two halves" below.)

---

## Two halves of this repo

1. **The CLI** (`bin/`, `src/`) — what a maintainer installs (`npm i -g github:cidfenix/bunshin`). It
   has three commands (`setup` / `init` / `run`) and does almost nothing on its own; it writes the
   config and launches Claude Code.
2. **The pipeline** (`template/`) — generic markdown that a launched Claude Code session *reads and
   follows*: `driver.md` (the autonomous `/loop` that drains the queue) + three agent briefs, plus
   `setup.md` (an **interactive** guide the `setup` session follows to configure the repo). All served
   **from the installed package** at run time, never copied into consuming repos.

Editing CLI behaviour → `src/`. Editing how goals get implemented/verified/reviewed → `template/`.

---

## Architecture (LOCKED decisions)

1. **Config-only model.** The ONLY thing Bunshin adds to a consuming repo is a single
   **`bunshin.config.json`** at its root (+ `.bunshin/artifacts/` screenshot output). The driver and
   the three agent briefs are **served from the installed package** — `bunshin run` hands Claude Code
   the absolute path to `template/driver.md`, whose briefs sit in `template/agents/` beside it. This
   is the no-duplication win: one canonical pipeline, every repo just owns its config (like
   `.eslintrc`). Update the pipeline everywhere with `npm i -g github:cidfenix/bunshin` — no per-repo
   changes. (Reversed an earlier "scaffold the whole folder into each repo" model.)

2. **Zero runtime npm dependencies.** `src/` is plain CommonJS using only Node built-ins (`fs`,
   `path`, `child_process`). No build step — the CLI runs directly from source. Keep it this way:
   `npx github:cidfenix/bunshin` must stay instant with no install tree. This is *separate* from the
   pipeline's **runtime prerequisites**, which are real: Claude Code + a tracker MCP (**Trello** or
   **Jira**, per `provider.kind`) + the **Playwright MCP** (the badge says "npm deps: 0", not "needs
   nothing").

3. **GitHub distribution, not unscoped npm.** The npm name `bunshin` is already taken, so the tool is
   run from the repo: `npx github:cidfenix/bunshin` / `npm i -g github:cidfenix/bunshin`. The package
   `name` stays `bunshin` (the bin name). If we ever publish, it would be scoped `@cidfenix/bunshin`.
   The GitHub repo must be **public** for `npx github:` to work without auth.

4. **The tracker IS the queue.** A goal is one card/issue; status is encoded by which column it's in
   (Pending → In Progress → Blocked → Done). No queue file — the run is crash-resumable from the
   tracker. Execution is **serial** and parks on the **first** gate failure (no auto-repair/retry).
   The tracker is pluggable via `provider.kind` (**`jira`** default, or **`trello`**): a
   provider-adapter table in `template/driver.md` maps each queue op (list columns, read a column,
   move a goal, comment) to Trello (`mcp__trello__*`) vs a Jira MCP (transitions/JQL); columns come
   from `board.lists` (Trello) or `jira.statuses` (Jira). Column names are matched tolerantly (aliases
   + case/space/hyphen-insensitive), so `TODO`/`To Do` both resolve.

5. **Integration is configurable** (`merge.mode`). `auto` (default) = local fast-forward merge to
   `baseBranch`, card → Done — no remote/GitHub needed. `pr` = push the branch, open a GitHub PR,
   card → **In Review**, and a **review reaper** (driver step 0, PR mode only) auto-merges it once the
   `merge.autoMerge` gate is met (≥N approvals and/or a label, optionally green checks) — or, with the
   gate disabled, just syncs the card to Done after a human merges. PR mode needs a remote + `gh` CLI
   or a GitHub MCP. Keep both paths working when editing `template/driver.md`.

---

## Key files

| File | Role |
| --- | --- |
| `bin/bunshin.js` | CLI entry: arg parsing, `--help`/`--version`, dispatch to `setup`/`init`/`run`. |
| `src/init.js` | `init` — render `template/bunshin.config.template.json` (token substitution) → `bunshin.config.json` at the repo root. Exports `ensureConfig()` (write-if-missing), reused by `setup`. |
| `src/setup.js` | `setup` — `ensureConfig()` then `spawn` Claude Code (a plain interactive session, no `/loop`) pointed at `template/setup.md`. `buildSetupPrompt()` is the unit-testable core. |
| `src/run.js` | `run` — guards (git repo · config present · clean tree · `claude` on PATH), build the `/loop` prompt pointing at the package driver, `spawn` Claude Code. `buildPrompt()` is the unit-testable core. |
| `src/util.js` | Helpers: `CONFIG_FILENAME`, `templateDir()`, `packageDriverPath()`, `gitRoot()`, `isCleanTree()`, `hasExecutable()`, `exists()`. |
| `template/driver.md` | The autonomous `/loop` driver procedure (the pipeline). |
| `template/setup.md` | The **interactive** setup guide the `setup` session follows (asks the user, fills the config, installs MCPs). |
| `template/agents/{implement,verify,review}.md` | The three agent briefs the driver dispatches. |
| `template/bunshin.config.template.json` | Placeholder config (`{{TOKENS}}` filled by `init`/`setup`). |
| `assets/bunshin-banner.svg` | Original themed README banner (no copyrighted imagery). |

---

## How a goal flows (the pipeline, in brief)

The driver takes the top Pending card, cuts an isolated **git worktree** off the base branch, then:
**Gate 1** (implement agent codes it TDD-style; run `install` + `gateChecks`) → **Gate 2** (verify
agent boots the dev server, Playwright-smokes the feature, commits a screenshot to `artifactsDir`) →
**Gate 3** (fresh adversarial review agent → APPROVE/BLOCK) → **merge** (rebase, re-run `gateChecks`,
fast-forward, card → Done). Any failure → card → Blocked with a reason; branch kept. Full detail lives
in `template/driver.md` — read it before changing pipeline behaviour.

---

## Conventions

- **No dependencies, no build, no transpile.** CommonJS, Node ≥ 18 built-ins only. If you reach for an
  npm package, stop — there's almost always a built-in.
- **No test framework** (keeps deps zero). Verify changes with ad-hoc Node smoke tests and by running
  the CLI directly:
  ```bash
  node bin/bunshin.js --help
  node bin/bunshin.js init --dir /tmp/throwaway-repo --name Demo --board-id X   # writes only bunshin.config.json
  node -e "console.log(require('./src/run').buildPrompt('Demo', false, 'X/driver.md'))"
  ```
  For local end-to-end, `npm link` makes `bunshin` a global command pointing at this checkout.
- **Cross-platform.** Primary dev is Windows; use `path` (never hardcode separators) and forward-slash
  display paths in user-facing strings. `run` spawns `claude` with `shell:true` so the `.cmd` shim
  resolves.
- **Keep `template/` and `src/` in sync.** The driver/briefs reference `bunshin.config.json` at the
  repo root and the briefs as `agents/<role>.md` beside the driver — don't reintroduce
  `docs/superpowers/...` paths (that was the old scaffold model).
- **Commits:** Conventional Commits, scoped (stage explicit paths, never `git add -A` blindly). End
  messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Files use LF endings.

---

## Distribution & repo

- Repo: `github.com/cidfenix/bunshin` (must be **public** for `npx github:` to resolve).
- Default branch: `master`.
- No secrets in the repo or its history (audited) — the package ships only placeholder config; all
  real values (board ids, commands, MCP credentials) live in the *consuming* repo's config / the
  user's Claude Code setup, never here.

## Current status

- Config-only refactor complete; CLI (`init`/`run`) working and smoke-tested.
- Themed README + banner + accurate badges in place.
- First consumer: **GitFenix** (its `bunshin.config.json` is committed and points at this pipeline).
- Not published to npm (name taken) — distributed via GitHub.
