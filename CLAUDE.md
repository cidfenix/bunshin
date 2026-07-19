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
   follows*: `driver.md` (the autonomous `/loop` that drains the queue) + the **built-in gate presets**
   in `template/gates/` (`implement`/`verify`/`review` briefs + the orchestrator-only `triage` + the
   opt-in docs gates `readme`/`claude-md`), plus `setup.md` (an **interactive** guide the `setup`
   session follows to configure the repo). All served
   **from the installed package** at run time, never copied into consuming repos.

Editing CLI behaviour → `src/`. Editing how goals get implemented/verified/reviewed → `template/`.

---

## Architecture (LOCKED decisions)

1. **Config-only model.** The ONLY thing Bunshin adds to a consuming repo is a single
   **`bunshin.config.json`** at its root (+ `.bunshin/artifacts/` screenshot output). (Separately, at
   the *user* level — not in any repo — `run`/`watch` use a shared **`~/.bunshin/`** home for the
   cross-repo dashboard registry + heartbeats; see `src/registry.js`.) The driver and
   the built-in gate presets are **served from the installed package** — `bunshin run` hands Claude Code
   the absolute path to `template/driver.md`, whose presets sit in `template/gates/` beside it. This
   is the no-duplication win: one canonical pipeline, every repo just owns its config (like
   `.eslintrc`). Update the pipeline everywhere with `npm i -g github:cidfenix/bunshin` — no per-repo
   changes. (Reversed an earlier "scaffold the whole folder into each repo" model.) The **built-in gate
   presets** are self-contained files in `template/gates/` beside the driver (`implement`/`verify`/
   `review` briefs + the orchestrator-only `triage` + the opt-in docs gates `readme`/`claude-md`) — one
   file per `BUILTIN_GATES` name; the driver references them as `gates/<name>.md`.
   **Orchestrator variant (BUN-7):** a second, distinctly-named config —
   **`bunshin.orchestrator.json`** — lets ONE board drive **multiple repositories** from any folder. It
   lists the target `repositories` (git remote + local path + a triage `description`, plus **optional
   per-repo `gates`/`commands` overrides** — BUN-12) and coexists with a
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
   tracker. Execution is **serial by default** — a top-level **`concurrency`** (whole number, absent ⇒ 1)
   bounds how many goals may be in flight at once (pure `resolveConcurrency()` in `src/util.js`,
   unit-tested in `test/concurrency.test.js`; integration is ALWAYS serial) — and each goal parks on
   its **first** gate failure (no auto-repair/retry). A long `/loop` session accumulates conversation
   history across many goals, so a top-level **`contextCleanupEvery`** (whole number, absent ⇒ 5, `0` ⇒
   disabled) has the driver proactively run Claude Code's `/compact` every N completed goals — one
   global counter for the whole session (single-repo or orchestrator). **Claude Code only**: `agent.kind:
   codex` ignores it, since `codex exec` restarts fresh per invocation and never accumulates
   cross-goal session context. Pure `resolveContextCleanup()` in `src/util.js` (unit-tested in
   `test/contextCleanup.test.js`); the launch prompt built by `buildPrompt()`/`buildOrchestratorPrompt()`
   in `src/run.js` names the cadence only when `agent.kind` is claude (unit-tested in `test/run.test.js`).
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
   `baseBranch`, card → Done — no remote/GitHub needed. **`merge.autoPush`** (default `true`)
   additionally pushes `baseBranch` to `merge.remote` right after each such merge (the driver's own
   INTEGRATION step, and the `--sandbox` host CLI's sync-back) — best-effort: no remote configured, or
   a failed push, is logged and never fails/parks the goal, preserving the "no remote needed"
   guarantee; set it to `false` for the old fully-local behavior. Pure `resolveAutoPush()` in
   `src/util.js` (unit-tested in `test/autoPush.test.js`); `pr` = push the branch, open a GitHub PR,
   card → **In Review**, and a **review reaper** (driver step 0, PR mode only) auto-merges it once the
   `merge.autoMerge` gate is met (≥N approvals and/or a label, optionally green checks) — or, with the
   gate disabled, just syncs the card to Done after a human merges. PR mode needs a remote + `gh` CLI
   or a GitHub MCP. Keep both paths working when editing `template/driver.md`. The **PR-open step is
   itself pluggable** (`merge.openPr`, PR mode only): absent/blank ⇒ the built-in
   `gh pr create --base <base> --head <branch> --fill`; set `{ "skill": "/open-pr" }` (an agent
   slash-command/skill) or `{ "command": "..." }` (a shell command) to open the PR through your own
   flow/template — it must print the PR URL so the driver records `PR: <url>`. Pure resolver:
   `resolveOpenPr()` in `src/util.js` (unit-tested in `test/openpr.test.js`); mirrors the custom-gate
   `command`/`skill` shape. Absent ⇒ default, so existing repos are unchanged. Bunshin can also **stamp
   labels on every PR it opens** via `merge.prLabels` (an array of label strings, PR mode only): the
   driver adds one `--label` per entry on the default `gh pr create` path (or instructs the custom
   `merge.openPr` step to apply them). This is a **filter stamp** so humans can exclude agent-created
   PRs — kept **distinct** from `merge.autoMerge.label`, which is a merge **gate** the reaper requires
   before auto-merging. Pure resolver: `resolvePrLabels()` in `src/util.js` (trims/drops-empties/de-dupes;
   non-array or non-string entry throws; absent/empty ⇒ `[]` = no labels, unchanged; unit-tested in
   `test/prlabels.test.js`).
   **Sandboxed runs (BUN-16):** an OPT-IN **`bunshin run --sandbox`** isolation wrapper (single-repo
   only) runs the unattended agent inside a **Docker container** against a **fully isolated local clone**
   (under the per-user home `~/.bunshin/sandbox/<repoId>/work` — OUTSIDE the tracked tree so it can never
   dirty the host `git status`; `git clone --local`) — the host working tree is **never bind-mounted or
   written by the agent**. Only the CLI writes the host repo, as ONE deterministic step: **auto mode**
   fast-forwards the host base branch from the clone (`git fetch <clone> <baseBranch>` + `git merge
   --ff-only`) after a clean container exit (if a ff is impossible it does NOT force — reports + leaves
   the clone); **PR mode** lands via the remote (the clone's `origin` is re-pointed at it). Everything
   crossing the boundary is an **explicit allowlist** (`sandbox.env` names + `sandbox.mounts` files,
   `sandbox.network` default `none`). Pure pieces (`resolveSandbox`/`buildDockerCommand`) live in
   `src/sandbox.js`, unit-tested in `test/sandbox.test.js` WITHOUT a Docker daemon; `dockerAvailable()`
   (impure guard) in `src/util.js`; the orchestration + sync-back in `src/run.js`. Docker is an OPTIONAL
   runtime prereq gated to `--sandbox`. Absent the flag, behavior is 100% unchanged. `--sandbox
   --orchestrator` errors (out of scope for now).

---

## Key files

| File | Role |
| --- | --- |
| `bin/bunshin.js` | CLI entry: arg parsing, `--help`/`--version`, dispatch to `setup`/`init`/`run`. |
| `src/init.js` | `init` — render `template/bunshin.config.template.json` (token substitution) → `bunshin.config.json` at the repo root. Exports `ensureConfig()` (write-if-missing), reused by `setup`. |
| `src/setup.js` | `setup` — `ensureConfig()` then `spawn` the selected agent CLI (`resolveAgent`/`buildSetupCommand`; a plain interactive session, no `/loop`) pointed at `template/setup.md`. `buildSetupPrompt()` is the unit-testable core. |
| `src/run.js` | `run` — guards (git repo · config present · clean tree · agent CLI on PATH), build the prompt pointing at the package driver, `spawn` the selected agent CLI (`resolveAgent`/`buildLaunchCommand` — claude `/loop` vs `codex exec`). Also registers the repo in `~/.bunshin/` (with the child PID) and passes the heartbeat status-file path into the prompt. `buildPrompt()` is the unit-testable core. The **`--orchestrator`** flag switches it to the `bunshin.orchestrator.json` config (validated up front via `resolveRepositories`; clean-tree guard skipped — the merge target is each repo, not the home) and builds `buildOrchestratorPrompt()` (also pure/unit-testable) instead. The **`--sandbox`** flag (BUN-16, single-repo only) adds an isolation branch: `dockerAvailable()` guard, ensure/build the image, `git clone --local` a fresh isolated clone (`~/.bunshin/sandbox/<repoId>/work`, OUTSIDE the tracked tree via `registry.sandboxCloneFor` — never dirties the host `git status`), expand `~` in mounts, wrap the agent command via `buildDockerCommand` and `spawn` it, then on a clean exit do the auto-mode `git fetch` + `--ff-only` sync-back (PR mode: no-op). The non-sandbox path is byte-for-byte unchanged. |
| `src/sandbox.js` | The PURE pieces of the opt-in `--sandbox` run (BUN-16): `resolveSandbox(config)` (normalizes the optional `sandbox` block → `{image,dockerfile,network,env,mounts}`; `sandbox.*`-keyed throws) + `buildDockerCommand({…})` (the `docker run …` string wrapping the agent command against the isolated clone). No spawn/fs/Docker ⇒ unit-testable in `test/sandbox.test.js` without a daemon. The impure guard `dockerAvailable()` is in `src/util.js`; the clone prep + spawn + auto-mode sync-back live in `src/run.js`. |
| `template/sandbox/Dockerfile` | Reference sandbox image (BUN-16), built + tagged `bunshin-sandbox:<pkgVersion>` when `sandbox.image` is unset: `node:20-bookworm-slim` + `git` + the agent CLI (`@anthropic-ai/claude-code`; codex variant documented) + Playwright/browsers for the `verify` gate. No hijacking `ENTRYPOINT`. Overridable via `sandbox.image`/`sandbox.dockerfile`. |
| `src/registry.js` | The shared per-user home `~/.bunshin/` that relates every running repo: `repoIdFor()`, `register()`, `markStopped()`, `readAll()`, `sandboxCloneFor()` (the out-of-tree `~/.bunshin/sandbox/<repoId>/work` clone path for `--sandbox`), atomic writes. Keyed by `repoId` = sha256(repo path)[:12]. |
| `src/watch.js` | `watch` — zero-dep localhost dashboard (built-in `http`). Pure file aggregator over `~/.bunshin/` (registry + per-repo heartbeats); never calls a tracker. `buildStatusPayload()` (liveness: running/stale/stopped) is the unit-testable core. The served page has **two view modes** (header toggle, localStorage-persisted): **Pro** (status tiles) and **🥷 Bunshin** (pixel-art canvas dojos — loop ninja casts a shadow clone per goal, sub-clone per gate). `sceneFor(repo)` is the pure state→scene mapper, unit-tested in Node and inlined into the page via `.toString()` (single source of truth). |
| `src/util.js` | Helpers: `CONFIG_FILENAME`, `ORCHESTRATOR_CONFIG_FILENAME`, `templateDir()`, `packageDriverPath()`, `gitRoot()`, `isCleanTree()`, `hasExecutable()`, `exists()`, plus the pluggable agent runtime — `resolveAgent(kind)` (claude default / codex; kind→spawn spec), `buildLaunchCommand()` (run: claude `/loop` vs `codex exec`), `buildSetupCommand()`, plus the configurable gate pipeline — `resolveGates(config)` (normalizes `gates.steps` → ordered built-in/`command`/`skill` steps; absent ⇒ `implement → verify → review`), **`resolveOpenPr(config)`** (PR mode: how to open the PR — `merge.openPr` → `{kind:'skill'\|'command'\|'default', value}`; absent/blank ⇒ the built-in `gh pr create --fill`; EITHER a `skill` OR a `command`, unit-tested in `test/openpr.test.js`), **`resolvePrLabels(config)`** (PR mode: the label strings to STAMP on every opened PR for filtering — `merge.prLabels` → normalized `string[]`, trimmed/de-duped; absent/empty ⇒ `[]`; DISTINCT from the `merge.autoMerge.label` merge gate; unit-tested in `test/prlabels.test.js`), **`resolveConcurrency(config)`** (top-level `concurrency` → how many goals may be in flight at once; absent ⇒ 1 = serial; non-integer/<1 throws; unit-tested in `test/concurrency.test.js`), **`resolveContextCleanup(config)`** (top-level `contextCleanupEvery` → how many completed goals between driver `/compact` calls; absent ⇒ 5, `0` = disabled; non-integer/<0 throws; Claude-only gating happens in `src/run.js`'s prompt builders, not here; unit-tested in `test/contextCleanup.test.js`), **`resolveAutoPush(config)`** (auto mode only: `merge.autoPush` → whether to push `baseBranch` to `merge.remote` after each local merge; absent ⇒ `true`; non-boolean throws; unit-tested in `test/autoPush.test.js`), **`resolveCommit(config)`** (implement gate: how to commit the goal's work — top-level `commit` → `{kind:'skill'\|'command'\|'default', value}`; absent/blank ⇒ the built-in scoped `git commit`; same EITHER-skill-OR-command shape, sharing the pure `resolveSkillOrCommand` helper with `resolveOpenPr`, unit-tested in `test/commit.test.js`), `BUILTIN_GATES` (now incl. the opt-in `triage` + `readme` + `claude-md`), `DEFAULT_GATE_STEPS`, plus orchestrator — `resolveRepositories(config)` (validates/normalizes the `repositories` array, now carrying each entry's optional per-repo `gates`/`commands` through) + **`resolveRepoGates(orchestratorConfig, repo)`** (effective ordered gates for a triaged repo: its own `gates.steps` → orchestrator-global → `DEFAULT_GATE_STEPS`; reuses `resolveGates`, errors name the repo) + **`resolveRepoCommands(orchestratorConfig, repo)`** (repo `commands` shallow-merged over the global); unit-tested in `test/orchestrator.test.js`). |
| `template/driver.md` | The autonomous `/loop` driver procedure (the pipeline). |
| `template/setup.md` | The **interactive** setup guide the `setup` session follows (asks the user, fills the config, installs MCPs). |
| `template/gates/{implement,verify,review,triage,readme,claude-md}.md` | The built-in **gate presets** — one file per `BUILTIN_GATES` name. `implement`/`verify`/`review` are the agent briefs the driver dispatches; `triage` (orchestrator-only) is a preset the driver follows itself; `readme` is an opt-in adversarial docs gate (BLOCKs when a user-facing change didn't update `README.md`); `claude-md` is the sibling opt-in docs gate for `CLAUDE.md` (BLOCKs when a change to architecture/conventions/LOCKED decisions didn't update `CLAUDE.md`). Referenced from `driver.md` as `gates/<name>.md`. |
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
- **Keep `template/` and `src/` in sync.** The driver/presets reference `bunshin.config.json` at the
  repo root and each built-in gate preset as `gates/<name>.md` beside the driver (moved from the old
  `template/agents/` layout in BUN-8) — don't reintroduce `template/agents/...` or `docs/superpowers/...`
  paths (those were older layouts). Every `BUILTIN_GATES` name must have a `template/gates/<name>.md`
  file; `test/gates-layout.test.js` guards this.
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
- README refreshed for gates + orchestrator (BUN-9): documented the configurable gate pipeline (new
  "Gate pipeline — configurable per repo" section with a `gates.steps` example incl. dropping `verify` +
  a custom `command` step, and the `template/gates/` preset layout) and orchestrator mode (new
  "Orchestrator mode — one board, many repositories" section: `--orchestrator` on init/setup/run, the
  `bunshin.orchestrator.json` config + `repositories[]`, the triage gate). Fixed now-inaccurate prose
  (three-gate/agent-briefs wording, Playwright now only for the `verify` gate, `run --orchestrator`
  clean-tree note). Docs only — no source/behavior changes; extended `test/gates-layout.test.js` with a
  README consistency guard (mentions `gates.steps` + `--orchestrator`, names `bunshin.orchestrator.json`,
  no stale `template/agents/` path).
- Gate presets extracted to `template/gates/` (BUN-8): moved the `implement`/`verify`/`review` briefs out
  of `template/agents/` (folder removed) and added a self-contained `triage.md`, so every `BUILTIN_GATES`
  name now has a discoverable `template/gates/<name>.md` preset. `template/driver.md` references them as
  `gates/<name>.md` (triage's long inline definition thinned to a pointer + summary); updated the
  `agents/`→`gates/` references in `src/run.js`, `src/util.js`, the config-template `$comment`, and
  CLAUDE.md. Structural/behavior-preserving refactor. New `test/gates-layout.test.js` guards the layout
  (each built-in gate ⇒ a `gates/<name>.md` file; no stale `agents/<role>` path in the live driver/src/
  template files), wired into `npm test`.
- Opt-in `readme` docs gate (BUN-10): new built-in gate `readme` (added to `BUILTIN_GATES` in `src/util.js`,
  NOT to `DEFAULT_GATE_STEPS`) with a self-contained adversarial preset `template/gates/readme.md` — it
  BLOCKs when a user-facing change (CLI/flags/output, config keys, public API, setup/requirements,
  documented behavior) didn't update `README.md`, and APPROVEs purely internal changes. Opt-in: a repo
  enables it by naming `"readme"` in `gates.steps`, so existing repos/the default pipeline are unchanged.
  Documented in `template/driver.md` (new gate section) + README's built-in-gate table; covered by
  `test/gates.test.js` (resolvable/opt-in) and the `test/gates-layout.test.js` layout guard. This repo's
  own `gates.steps` left as-is.
- Opt-in `claude-md` docs gate (BUN-11): sibling of `readme` — new built-in gate `claude-md` (added to
  `BUILTIN_GATES` in `src/util.js`, NOT to `DEFAULT_GATE_STEPS`) with a self-contained adversarial preset
  `template/gates/claude-md.md` — it BLOCKs when a change that alters architecture/conventions/LOCKED
  decisions didn't update `CLAUDE.md`, and APPROVEs changes that touch nothing `CLAUDE.md` documents.
  Opt-in: enabled by naming `"claude-md"` in `gates.steps`, so existing repos/the default pipeline are
  unchanged. Documented in `template/driver.md` (new gate section) + README's built-in-gate table;
  covered by `test/gates.test.js` (resolvable/opt-in) and the `test/gates-layout.test.js` layout guard.
  This repo's own `gates.steps` left as-is (`["implement","review"]`).
- Per-repo gates & commands (BUN-12): in ORCHESTRATOR mode each `repositories[]` entry can now define its
  OWN optional `gates` (`{steps:[...]}`) and/or `commands` block, overriding the orchestrator-global
  default — so heterogeneous repos (web app vs config-only CLI vs Android) get different pipelines/toolchains
  under ONE orchestrator, replacing the old "lowest-common-denominator or separate orchestrators" workaround.
  `resolveRepositories` now carries each entry's raw `gates`/`commands` through; new pure resolvers
  `resolveRepoGates(orchestratorConfig, repo)` (own steps → global → `DEFAULT_GATE_STEPS`; reuses
  `resolveGates` — custom `command`/`skill` steps + all built-ins work per-repo, unknown gate throws naming
  the repo) and `resolveRepoCommands(orchestratorConfig, repo)` (repo keys shallow-merged over the global) in
  `src/util.js` (`resolveGates` gained an opts `{where,configFile}` for repo-scoped error messages). The
  orchestrator template documents + demonstrates a per-repo override (the `api` example drops `verify` + uses
  its own install/test); `template/driver.md` (intro, step 5, GATES per-repo note) tells the driver to run the
  triaged repo's EFFECTIVE gates/commands. Single-repo mode and orchestrator configs without per-repo
  overrides are 100% unchanged (backward compatible). Tests: `test/orchestrator.test.js`.
- Custom "open a PR" step (BUN-13): in PR mode the driver's PR-open step is now pluggable via
  `merge.openPr` — set `{ "skill": "/open-pr" }` (an agent slash-command/skill, e.g. one that applies a
  team's PR template) or `{ "command": "..." }` (a shell command) to open the PR your own way; it must
  print the PR URL so the driver records `PR: <url>`. Absent/blank ⇒ the built-in
  `gh pr create --base <base> --head <branch> --fill` (unchanged). Pure `resolveOpenPr()` in `src/util.js`
  returning `{kind:'skill'|'command'|'default', value}` (EITHER skill OR command; empty-string = neutral
  like the rest of the config; wrong-typed value throws), unit-tested in `test/openpr.test.js` (wired into
  `npm test`); `template/driver.md` PR-mode step 3 branches on it; `merge.openPr` block + `$comment` added
  to the config template. `auto` mode and PR-mode-without-`openPr` are 100% unchanged (backward compatible).
- Custom "commit the work" step (BUN-14): the implement gate's commit is now pluggable via a new
  top-level `commit` block — set `{ "skill": "/commit" }` (an agent slash-command/skill, e.g. a
  customer's custom Claude `/commit`) or `{ "command": "..." }` (a shell command) to stage + commit the
  goal's work your own way; it must still produce ONE commit that stages only the intended feature files
  + the CLAUDE.md status line, never a `neverCommit.paths` file, keeping the `Co-Authored-By:` trailer.
  Absent/blank ⇒ the built-in scoped `git commit` (unchanged). Pure `resolveCommit()` in `src/util.js`
  returning `{kind:'skill'|'command'|'default', value}` — mirrors `resolveOpenPr` and now shares a single
  `resolveSkillOrCommand()` helper with it (both read the same EITHER-skill-OR-command shape; empty-string
  = neutral; wrong-typed value throws naming the key) — unit-tested in `test/commit.test.js` (wired into
  `npm test`); `template/gates/implement.md` step 5 + `template/driver.md`'s `implement`-gate commit step
  branch on it; `commit` block + `$comment` added to the config template. Absent `commit` ⇒ behavior is
  exactly as before (backward compatible).
- Custom PR labels (BUN-15): in PR mode Bunshin can now STAMP one or more labels onto every PR it opens
  via a new optional `merge.prLabels` array (e.g. `["bunshin", "automated"]`), so humans can filter
  agent-created PRs out of their review queue. Pure `resolvePrLabels()` in `src/util.js` normalizes to a
  `string[]` (trims, drops empties, de-dupes; non-array or non-string entry throws referencing
  `merge.prLabels`; absent/empty ⇒ `[]` = no labels, unchanged behavior), unit-tested in
  `test/prlabels.test.js` (wired into `npm test`). `template/driver.md` PR-mode INTEGRATION step 3 adds one
  `--label <l>` per entry on the default `gh pr create` path (and instructs the custom `merge.openPr`
  step to apply them); `merge.prLabels` + `prLabelsNote` added to the config template. Kept DISTINCT from
  `merge.autoMerge.label` (a merge GATE the reaper requires) — this is only a filter STAMP. `auto` mode
  and PR mode without `prLabels` are 100% unchanged (backward compatible).
- Sandboxed runs (BUN-16): OPT-IN `bunshin run --sandbox` (single-repo only) runs the unattended agent
  inside a **Docker container** against a **fully isolated local clone** (under the per-user home,
  `~/.bunshin/sandbox/<repoId>/work` via `registry.sandboxCloneFor` — OUTSIDE the tracked tree) — the
  host working tree is NEVER bind-mounted or written by the agent; only the CLI writes it (auto mode:
  `git fetch <clone> <baseBranch>` + `git merge --ff-only` after a clean exit, no force if the base
  moved; PR mode: via the remote, clone `origin` re-pointed). New pure `src/sandbox.js` —
  `resolveSandbox()` (normalizes the optional `sandbox` block: `image`/`dockerfile`/`network`/`env`/
  `mounts`; env mirrors `resolvePrLabels`, mounts → `{host,container}` with `~` preserved, `sandbox.*`
  bad-type throws) + `buildDockerCommand()` (the `docker run …` wrapper) — unit-tested in
  `test/sandbox.test.js` WITHOUT a Docker daemon; impure `dockerAvailable()` in `src/util.js`; the
  clone/build/spawn/sync-back orchestration + `--sandbox --orchestrator` rejection in `src/run.js`.
  Shipped reference image `template/sandbox/Dockerfile` (built `bunshin-sandbox:<pkgVersion>` when
  `sandbox.image` unset). Explicit allowlist across the boundary (`sandbox.env`/`sandbox.mounts`,
  `network` default `none`). Docker is an OPTIONAL runtime prereq gated to `--sandbox`. `sandbox` block +
  `$comment` in the config template; "Sandbox awareness" note in `template/driver.md`; README "Sandboxed
  runs (Docker Desktop)" section + Docker optional-prereq line; layout guard for the Dockerfile in
  `test/gates-layout.test.js`. Absent `--sandbox`, behavior is 100% unchanged (backward compatible).
- BUN-16 fix (Gate-3 BLOCK): the sandbox isolated clone was created IN the tracked tree at
  `.bunshin/sandbox-work` under a FALSE "already gitignored" claim — but `.bunshin/artifacts/` is
  committed output and `.gitignore` only lists `node_modules/`/`*.log`/`.DS_Store`, so the leftover
  clone left `git status` dirty and the clean-tree guard bricked ALL subsequent runs. Moved the clone
  OUT of the working tree to the per-user home via new pure `registry.sandboxCloneFor(repoId, home)` →
  `~/.bunshin/sandbox/<repoId>/work` (namespaced per repo; reuses the `~/.bunshin/` home + `repoId`);
  `prepareSandboxClone` now takes the target dir. Corrected the false "gitignored" wording in
  `src/run.js`, this file (LOCKED decision 5 + key-files + status), and left the config `$comment`
  (which never claimed gitignored) as-is. Isolation guarantees intact (host never bind-mounted; clone
  at `/work`; `git fetch <clone>` + host `--ff-only` sync-back; status heartbeat mount unchanged);
  non-sandbox path byte-for-byte unchanged. Locked by a `sandboxCloneFor` test in `test/registry.test.js`
  (asserts the clone is under `~/.bunshin/`, never under the repo's `.bunshin/`). No test needs Docker.
- Configurable concurrency: a top-level `concurrency` (whole number, absent ⇒ 1 = serial — unchanged)
  bounds how many goals the driver works AT ONCE, each in its own worktree; a gate failure parks only
  that goal, and INTEGRATION stays strictly serial (one rebase + re-gate + merge at a time). Pure
  `resolveConcurrency()` in `src/util.js` (unit-tested in `test/concurrency.test.js`, wired into
  `npm test`); `template/driver.md` gained a Concurrency contract (intro + step 1 takes Pending goals
  until `concurrency` are in flight + BOUNDED-concurrency rule + single-card heartbeat note);
  `concurrency`/`concurrencyNote` added to both config templates; README + LOCKED decision 4 updated
  (serial → serial BY DEFAULT). Launch prompts in `src/run.js` name the knob (tests extended in
  `test/run.test.js`).
- Driver context cleanup: a top-level `contextCleanupEvery` (whole number, absent ⇒ 5, `0` ⇒ disabled)
  has the driver run Claude Code's `/compact` every N completed goals to keep a long `/loop` session's
  context bounded proactively, rather than relying only on reactive auto-compaction near the limit. One
  running counter for the WHOLE session, incremented at INTEGRATION (always serial, so unambiguous even
  with `concurrency` > 1); applies identically in single-repo and orchestrator mode (global across all
  triaged repos). **Claude Code only** — `agent.kind: codex` never gets the instruction, since `codex
  exec` restarts fresh per invocation and has no accumulating session context to compact. Pure
  `resolveContextCleanup()` in `src/util.js` (unit-tested in `test/contextCleanup.test.js`, wired into
  `npm test`); `template/driver.md` gained a Context cleanup contract (near Sandbox awareness, before The
  queue); `contextCleanupEvery`/`contextCleanupEveryNote` added to both config templates; README gained a
  paragraph beside the Concurrency one. `buildPrompt()`/`buildOrchestratorPrompt()` in `src/run.js` gained
  an `agentKind` parameter and append the compact-cadence sentence only when it resolves to `claude`
  (tests extended in `test/run.test.js`). Design: `docs/superpowers/specs/2026-07-19-driver-context-cleanup-design.md`.
- Auto-mode remote sync: `merge.autoPush` (boolean, absent ⇒ `true`) pushes `git.baseBranch` to
  `merge.remote` right after every local auto-mode merge, so a repo that DOES have a remote doesn't
  silently drift behind it — best-effort (no remote, or a failed push, is logged and never
  parks/fails the goal), preserving auto mode's "no remote needed" guarantee when there truly is none.
  Covers BOTH places master/main moves in auto mode: the driver's own INTEGRATION fast-forward
  (`template/driver.md`, new sub-step after the merge) and the `--sandbox` host CLI's sync-back
  (`syncBackFromClone()` in `src/run.js`, now pushes after its `--ff-only` merge). `pr` mode is
  untouched — it already syncs via the remote/GitHub and the reaper never writes the local base
  branch. Pure `resolveAutoPush()` in `src/util.js` (unit-tested in `test/autoPush.test.js`, wired into
  `npm test`); `autoPush`/`autoPushNote` added to both config templates (orchestrator-global only — not
  a per-repo `gates`/`commands`-style override); README's auto-mode bullet updated. Design:
  `docs/superpowers/specs/2026-07-19-merge-auto-push-design.md`.
