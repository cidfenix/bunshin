# Bunshin

> 影分身の術 — *Kage Bunshin no Jutsu*. Shadow clones that drain your backlog.

Bunshin is a **standalone, zero-dependency CLI** that runs an **autonomous goal loop for Claude Code**,
driven by your **Trello board or Jira project**: you stack lightweight goals (cards / issues), and
Bunshin implements each one fully autonomously — code → a **configurable gate pipeline** → auto-merge —
with **no human in the review loop**. It is
**process-only**: there is no orchestrator daemon, just a markdown pipeline that a Claude Code `/loop`
session follows, plus a thin CLI.

This file is the canonical context for any agent working on **the Bunshin tool itself**. (Not to be
confused with the `template/driver.md` pipeline, which is the procedure Bunshin *ships* for draining a
board — see "Two halves" below.)

---

## Two halves of this repo

1. **The CLI** (`bin/`, `src/`) — what a maintainer installs (`npm i -g github:cidfenix/bunshin`). It
   has four commands (`setup` / `init` / `run` / `watch`) and does almost nothing on its own; it writes
   the config, launches Claude Code, and (`watch`) serves a read-only dashboard.
2. **The pipeline** (`template/`) — generic markdown that a launched Claude Code session *reads and
   follows*: `driver.md` (the autonomous `/loop` that drains the queue) + three agent briefs, plus
   `setup.md` (an **interactive** guide the `setup` session follows to configure the repo). All served
   **from the installed package** at run time, never copied into consuming repos.

Editing CLI behaviour → `src/`. Editing how goals get implemented/verified/reviewed → `template/`.

---

## Architecture (LOCKED decisions)

1. **Config-only model.** The ONLY thing Bunshin adds to a consuming repo is a single
   **`bunshin.config.json`** at its root (+ `.bunshin/artifacts/` screenshot output). (Separately, at
   the *user* level — not in any repo — `run`/`watch` use a shared **`~/.bunshin/`** home for the
   cross-repo dashboard registry + heartbeats; see `src/registry.js`.) The driver and
   the three agent briefs are **served from the installed package** — `bunshin run` hands Claude Code
   the absolute path to `template/driver.md`, whose briefs sit in `template/agents/` beside it. This
   is the no-duplication win: one canonical pipeline, every repo just owns its config (like
   `.eslintrc`). Update the pipeline everywhere with `npm i -g github:cidfenix/bunshin` — no per-repo
   changes. (Reversed an earlier "scaffold the whole folder into each repo" model.)
   **Orchestrator variant (BUN-7):** a second, distinctly-named config —
   **`bunshin.orchestrator.json`** — lets ONE board drive **multiple repositories** from any folder. It
   lists the target `repositories` (git remote + local path + a triage `description`) and coexists with a
   single-repo `bunshin.config.json` (a repo can evolve itself AND orchestrate others). `bunshin run
   --orchestrator` selects it (`--orchestrator` also for `init`/`setup`); absent the flag, everything is
   the unchanged single-repo path. So the invariant is "one config file **per role**": the single-repo
   config, and/or the orchestrator config.

2. **Zero runtime npm dependencies.** `src/` is plain CommonJS using only Node built-ins (`fs`,
   `path`, `child_process`). No build step — the CLI runs directly from source. Keep it this way:
   `npx github:cidfenix/bunshin` must stay instant with no install tree. This is *separate* from the
   pipeline's **runtime prerequisites**, which are real: an **agent CLI** (**Claude Code** default, or
   **Codex** — selected by `agent.kind`; resolved by `resolveAgent()` in `src/util.js`) + a tracker MCP
   (**Trello** or **Jira**, per `provider.kind`) + the **Playwright MCP** (the badge says "npm deps: 0",
   not "needs nothing").

3. **GitHub distribution, not unscoped npm.** The npm name `bunshin` is already taken, so the tool is
   run from the repo: `npx github:cidfenix/bunshin` / `npm i -g github:cidfenix/bunshin`. The package
   `name` stays `bunshin` (the bin name). If we ever publish, it would be scoped `@cidfenix/bunshin`.
   The GitHub repo must be **public** for `npx github:` to work without auth.

4. **The tracker IS the queue.** A goal is one card/issue; status is encoded by which column it's in
   (Pending → In Progress → Blocked → Done). No queue file — the run is crash-resumable from the
   tracker. Execution is **serial** and parks on the **first** gate failure (no auto-repair/retry).
   The **gate pipeline is a per-repo configurable preset** (`gates.steps` in the config; absent/empty ⇒
   the built-in default `implement → verify → review`, so existing repos are unchanged): an ordered list
   of built-in gates (`implement`/`verify`/`review`) and/or custom `command`/`skill` steps. The driver
   runs the resolved list in order, fail-fast. This lets Bunshin serve repos that are **not** web apps —
   drop the web-only `verify` gate for config-only/CLI/Android repos, or mix in your own gates. Pure
   resolver: `resolveGates()` in `src/util.js` (unit-tested in `test/gates.test.js`); the driver reads
   the same `gates.steps`. (Reversed the earlier hard-coded three-gate pipeline.) In **orchestrator mode**
   (BUN-7) the pipeline leads with a new built-in gate **`triage`** (added to `BUILTIN_GATES`, but NOT to
   the single-repo default): it identifies which repository a goal belongs to from the goal text + each
   repo's `description`/CLAUDE.md/README; a goal it cannot place is moved to **Blocked** with a comment
   (never guessed). Consumers can supply their own triage gate as a `command`/`skill` step.
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
| `src/setup.js` | `setup` — `ensureConfig()` then `spawn` the selected agent CLI (`resolveAgent`/`buildSetupCommand`; a plain interactive session, no `/loop`) pointed at `template/setup.md`. `buildSetupPrompt()` is the unit-testable core. |
| `src/run.js` | `run` — guards (git repo · config present · clean tree · agent CLI on PATH), build the prompt pointing at the package driver, `spawn` the selected agent CLI (`resolveAgent`/`buildLaunchCommand` — claude `/loop` vs `codex exec`). Also registers the repo in `~/.bunshin/` (with the child PID) and passes the heartbeat status-file path into the prompt. `buildPrompt()` is the unit-testable core. The **`--orchestrator`** flag switches it to the `bunshin.orchestrator.json` config (validated up front via `resolveRepositories`; clean-tree guard skipped — the merge target is each repo, not the home) and builds `buildOrchestratorPrompt()` (also pure/unit-testable) instead. |
| `src/registry.js` | The shared per-user home `~/.bunshin/` that relates every running repo: `repoIdFor()`, `register()`, `markStopped()`, `readAll()`, atomic writes. Keyed by `repoId` = sha256(repo path)[:12]. |
| `src/watch.js` | `watch` — zero-dep localhost dashboard (built-in `http`). Pure file aggregator over `~/.bunshin/` (registry + per-repo heartbeats); never calls a tracker. `buildStatusPayload()` (liveness: running/stale/stopped) is the unit-testable core. The served page has **two view modes** (header toggle, localStorage-persisted): **Pro** (status tiles) and **🥷 Bunshin** (pixel-art canvas dojos — loop ninja casts a shadow clone per goal, sub-clone per gate). `sceneFor(repo)` is the pure state→scene mapper, unit-tested in Node and inlined into the page via `.toString()` (single source of truth). |
| `src/util.js` | Helpers: `CONFIG_FILENAME`, `ORCHESTRATOR_CONFIG_FILENAME`, `templateDir()`, `packageDriverPath()`, `gitRoot()`, `isCleanTree()`, `hasExecutable()`, `exists()`, plus the pluggable agent runtime — `resolveAgent(kind)` (claude default / codex; kind→spawn spec), `buildLaunchCommand()` (run: claude `/loop` vs `codex exec`), `buildSetupCommand()`, plus the configurable gate pipeline — `resolveGates(config)` (normalizes `gates.steps` → ordered built-in/`command`/`skill` steps; absent ⇒ `implement → verify → review`), `BUILTIN_GATES` (now incl. `triage`), `DEFAULT_GATE_STEPS`, plus orchestrator — `resolveRepositories(config)` (validates/normalizes the `repositories` array; unit-tested in `test/orchestrator.test.js`). |
| `template/driver.md` | The autonomous `/loop` driver procedure (the pipeline). |
| `template/setup.md` | The **interactive** setup guide the `setup` session follows (asks the user, fills the config, installs MCPs). |
| `template/agents/{implement,verify,review}.md` | The three agent briefs the driver dispatches. |
| `template/bunshin.config.template.json` | Placeholder single-repo config (`{{TOKENS}}` filled by `init`/`setup`). |
| `template/bunshin.orchestrator.template.json` | Placeholder **orchestrator** config (BUN-7): adds the `repositories` array + a triage-led `gates.steps`; written by `init --orchestrator`. |
| `assets/bunshin-banner.svg` | Original themed README banner (no copyrighted imagery). |

---

## How a goal flows (the pipeline, in brief)

The driver takes the top Pending card, cuts an isolated **git worktree** off the base branch, then runs
the repo's **configured gate pipeline** (`gates.steps`; default `implement → verify → review`) in order,
fail-fast. The built-in gates: **`implement`** (agent codes it TDD-style; run `install` + `gateChecks`)
→ **`verify`** (verify agent boots the dev server, Playwright-smokes the feature, commits a screenshot
to `artifactsDir` — web-only, omit for config-only/CLI repos) → **`review`** (fresh adversarial review
agent → APPROVE/BLOCK). A repo can reorder these, drop `verify`, or add custom `command`/`skill` gates.
Then **merge** (rebase, re-run `gateChecks`, fast-forward, card → Done). Any failure → card → Blocked
with a reason; branch kept. Full detail lives in `template/driver.md` — read it before changing pipeline
behaviour.

---

## Conventions

- **No dependencies, no build, no transpile.** CommonJS, Node ≥ 18 built-ins only. If you reach for an
  npm package, stop — there's almost always a built-in.
- **No test framework** (keeps deps zero). Tests are plain-Node `assert` scripts in `test/`, run via
  `npm test` (which is also this repo's `gateChecks`). Add a failing test there first, then the code.
  You can also verify by running the CLI directly:
  ```bash
  npm test
  node bin/bunshin.js --help
  node bin/bunshin.js init --dir /tmp/throwaway-repo --name Demo --board-id X   # writes only bunshin.config.json
  node -e "console.log(require('./src/run').buildPrompt('Demo', false, 'X/driver.md', 'S/status.json'))"
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
- Pluggable agent runtime (`agent.kind`): **Claude Code** (default) or **Codex**. `resolveAgent()` +
  `buildLaunchCommand()`/`buildSetupCommand()` in `src/util.js` map the kind→spawn spec; `run`/`setup`
  launch the selected CLI (claude `/loop` vs `codex exec`). Updates the prerequisite in LOCKED decision 2
  (was Claude-Code-only); absent ⇒ claude, so existing repos are unchanged. Unit-tested in `test/agent.test.js`.
- 🥷 Bunshin watch view: redrew the dojo characters as **bigger, smoother anime/Naruto-style ninja**
  (vector canvas: chibi proportions, spiky hair, headband + forehead protector, scarf, jumpsuit, eyes)
  replacing the small blocky pixel sprites; bigger canvas (460×170) + new pure `dojoLayout(W,H)` geometry
  helper (exported + inlined, unit-tested in `test/watch.test.js`). `sceneFor` mapping unchanged.
- README now documents the pluggable agent runtime (`agent.kind`: Claude Code default / Codex): new
  "Agent runtime" section + generalized badges, Requirements, and setup/run prose (Claude `/loop` cadence
  vs `codex exec` once-per-run needing an external scheduler). Docs only — no source/behavior changes.
- Configurable gate pipeline (`gates.steps`, BUN-6): replaced the hard-coded implement→verify→review trio
  with a per-repo ordered preset — reorder gates, drop the web-only `verify` gate for config-only/CLI/Android
  repos, or mix in custom `command`/`skill` steps. Pure `resolveGates()` + `BUILTIN_GATES`/`DEFAULT_GATE_STEPS`
  in `src/util.js` (unit-tested in `test/gates.test.js`); `template/driver.md` reads `gates.steps` and runs
  them in order, fail-fast; new `gates` block + `$comment` docs in the template config. Absent ⇒ the old
  default, so existing repos are unchanged. Reverses LOCKED decision 4's fixed-gates assumption. Bunshin's
  own config now drops `verify` (it's a CLI repo, no dev server).
- Orchestrator mode — first slice (BUN-7): one board can drive MULTIPLE repositories. New distinct config
  `bunshin.orchestrator.json` (template + `$comment` docs) with a validated `repositories` array
  (`resolveRepositories()` in `src/util.js`, unit-tested); `bunshin run --orchestrator` (and
  `init`/`setup --orchestrator`) select it — pure `buildOrchestratorPrompt()` in `src/run.js`, single-repo
  path 100% unchanged when the flag is absent. New built-in `triage` gate documented in
  `template/driver.md` (leads the orchestrator `gates.steps`; infers the repo from goal text +
  description/CLAUDE.md/README; undecidable ⇒ Blocked with a comment) + a dedicated-vs-orchestrator note in
  `template/setup.md`. Extends LOCKED decisions 1 (config-per-role) & 4 (triage gate). Tests:
  `test/orchestrator.test.js` (+ run/gates coverage), wired into `npm test`.
