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

1. **Config-only model.** The only thing Bunshin adds to a consuming repo is a single
   **`bunshin.config.json`** at its root (+ `.bunshin/artifacts/` screenshot output, and the
   **changelog** each goal appends to — `docs/CHANGELOG.md` by default, see decision 6). (Separately, at
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
   tracker. Execution is **serial by default** — a top-level **`concurrency`** (whole number, absent
   ⇒ 1) bounds how many goals may be in flight at once (pure `resolveConcurrency()` in
   `src/util.js`, unit-tested in `test/concurrency.test.js`; integration is ALWAYS serial) — and
   each goal's gates run fail-fast, with the first failure CLASSIFIED at park time (auto-unblock:
   top-level `unblock` config, absent ⇒ `{auto: true, maxRetries: 5}` = ON by default; pure
   `resolveUnblock()` in `src/util.js`, unit-tested in `test/unblock.test.js`): a self-resolvable
   failure round-trips through **Pending** with a scoped `Auto-retry <n>/<max>` comment, keeping
   branch AND worktree, while a failure that genuinely needs a human still parks to **Blocked**. A
   long `/loop` session accumulates conversation
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

   **Branch checkpoints (`git.pushBranches`, default `true`):** the goal branch itself is pushed to
   `merge.remote` after EACH gate step completes (passing or failing), at PARK, and at auto-retry, so
   a stopped agent or a parked goal does not strand its work on one disk; driver step 4 gained a rung
   that resumes a goal from `<remote>/<branch>` when no local branch exists (the "another computer"
   path) and, when a local branch DOES exist, first FAST-FORWARDS it from the remote (ff-only refspec,
   never a reset/force; on divergence the local branch wins and the divergence is reported) — without
   that, the local rung would always win on the originating machine and silently merge over newer work
   another machine pushed. Every such push is **best-effort** — no remote, or a failed push, is logged
   and the goal continues, so the "auto mode needs no remote" guarantee above still holds. A MERGED
   goal's remote branch is deleted alongside the local one; parked branches are kept. Sandboxed `auto`
   runs skip these pushes and step 4's remote reads (the clone's `origin` is the host repo path —
   pushing there would write the host `.git`, which decision 5's sandbox rules forbid); sandboxed PR
   runs push normally. BOTH the checkpoint pushes and PR mode's integration push use
   `--force-with-lease`, since the pre-merge rebase rewrites already-pushed shas (and Bunshin is the
   sole writer of `<branchPrefix>*` branches, so the lease still refuses if anyone else moved the ref).
   It sits in the `git` block (branch lifecycle), NOT in `merge` — distinct from `merge.autoPush`,
   which pushes the BASE branch. Pure `resolvePushBranches()` in `src/util.js` (unit-tested in
   `test/pushBranches.test.js`, which also guards both config templates and the shipped driver text).

6. **The per-goal log lives in a CHANGELOG, never in `CLAUDE.md`.** Every finished goal appends ONE
   entry describing what it shipped. That entry goes to the file named by the top-level
   **`changelog`** key (repo-relative; absent ⇒ **`docs/CHANGELOG.md`**, created if missing; `false`
   ⇒ no entry at all). It used to be appended to `CLAUDE.md`'s "Current status" section — reversed,
   because `CLAUDE.md` is the canonical context EVERY agent reads on EVERY goal, so an append-only
   log inside it grows without bound: it burns context on every future run and eventually exceeds the
   file's practical size limit (a real consumer, sysfenix, reached ~1.1M characters and had to
   hand-migrate its history out — twice). The split is now: **changelog = the running log, appended
   once per goal; `CLAUDE.md` = the CURRENT state, edited in place only when a durable fact changes.**
   Pure `resolveChangelog()` + `DEFAULT_CHANGELOG_PATH` in `src/util.js` (unit-tested in
   `test/changelog.test.js`, which also guards that the shipped `implement`/driver markdown still
   says so); `template/gates/implement.md` step 6 + `template/driver.md`'s "Changelog, not CLAUDE.md"
   contract carry the instruction; BOTH review gates enforce it (`review` BLOCKs a progress line
   appended to `CLAUDE.md`; `claude-md` BLOCKs a durable fact left stale). In orchestrator mode the
   path resolves against the TRIAGED repo's root, so each repo keeps its own changelog. A repo that
   truly wants the old behavior sets `"changelog": "CLAUDE.md"`. This repo dogfoods it — its own
   history now lives in `docs/CHANGELOG.md`.

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
| `src/util.js` | Helpers: `CONFIG_FILENAME`, `ORCHESTRATOR_CONFIG_FILENAME`, `templateDir()`, `packageDriverPath()`, `gitRoot()`, `isCleanTree()`, `hasExecutable()`, `exists()`, plus the pluggable agent runtime — `resolveAgent(kind)` (claude default / codex; kind→spawn spec), `buildLaunchCommand()` (run: claude `/loop` vs `codex exec`), `buildSetupCommand()`, plus the configurable gate pipeline — `resolveGates(config)` (normalizes `gates.steps` → ordered built-in/`command`/`skill` steps; absent ⇒ `implement → verify → review`), **`resolveOpenPr(config)`** (PR mode: how to open the PR — `merge.openPr` → `{kind:'skill'\|'command'\|'default', value}`; absent/blank ⇒ the built-in `gh pr create --fill`; EITHER a `skill` OR a `command`, unit-tested in `test/openpr.test.js`), **`resolvePrLabels(config)`** (PR mode: the label strings to STAMP on every opened PR for filtering — `merge.prLabels` → normalized `string[]`, trimmed/de-duped; absent/empty ⇒ `[]`; DISTINCT from the `merge.autoMerge.label` merge gate; unit-tested in `test/prlabels.test.js`), **`resolveConcurrency(config)`** (top-level `concurrency` → how many goals may be in flight at once; absent ⇒ 1 = serial; non-integer/<1 throws; unit-tested in `test/concurrency.test.js`), **`resolveContextCleanup(config)`** (top-level `contextCleanupEvery` → how many completed goals between driver `/compact` calls; absent ⇒ 5, `0` = disabled; non-integer/<0 throws; Claude-only gating happens in `src/run.js`'s prompt builders, not here; unit-tested in `test/contextCleanup.test.js`), **`resolveAutoPush(config)`** (auto mode only: `merge.autoPush` → whether to push `baseBranch` to `merge.remote` after each local merge; absent ⇒ `true`; non-boolean throws; unit-tested in `test/autoPush.test.js`), **`resolvePushBranches(config)`** (goal-branch checkpoints: `git.pushBranches` → whether the driver pushes each goal branch to `merge.remote` after every committing gate / at park / at auto-retry, enabling the resume-from-remote rung; absent ⇒ `true`; non-boolean throws; best-effort at the call site; DISTINCT from `merge.autoPush`, which pushes the BASE branch; unit-tested in `test/pushBranches.test.js`), **`resolveCommit(config)`** (implement gate: how to commit the goal's work — top-level `commit` → `{kind:'skill'\|'command'\|'default', value}`; absent/blank ⇒ the built-in scoped `git commit`; same EITHER-skill-OR-command shape, sharing the pure `resolveSkillOrCommand` helper with `resolveOpenPr`, unit-tested in `test/commit.test.js`), **`resolveChangelog(config)`** (implement gate: WHERE the per-goal log entry lands — top-level `changelog` → `{enabled, path}`; absent/blank ⇒ `DEFAULT_CHANGELOG_PATH` = `docs/CHANGELOG.md`, `false` ⇒ disabled; rejects an absolute path or a `..` escape so the entry can never be written outside the repo; unit-tested in `test/changelog.test.js`), **`resolveUnblock(config)`** (auto-unblock: top-level `unblock` → `{auto, maxRetries}`; absent ⇒ `{auto: true, maxRetries: 5}` = ON by default; `auto: false` restores park-everything; non-boolean `auto` / non-integer or negative `maxRetries` throws; unit-tested in `test/unblock.test.js`), `BUILTIN_GATES` (now incl. the opt-in `triage` + `readme` + `claude-md`), `DEFAULT_GATE_STEPS`, plus orchestrator — `resolveRepositories(config)` (validates/normalizes the `repositories` array, now carrying each entry's optional per-repo `gates`/`commands` through) + **`resolveRepoGates(orchestratorConfig, repo)`** (effective ordered gates for a triaged repo: its own `gates.steps` → orchestrator-global → `DEFAULT_GATE_STEPS`; reuses `resolveGates`, errors name the repo) + **`resolveRepoCommands(orchestratorConfig, repo)`** (repo `commands` shallow-merged over the global); unit-tested in `test/orchestrator.test.js`). |
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
Then **merge** (rebase, re-run `gateChecks`, fast-forward, card → Done). Any failure is CLASSIFIED
(AUTO-UNBLOCK, default on): self-resolvable → auto-retry, card back to Pending with an `Auto-retry`
comment, branch and worktree kept; human-needed or budget-exhausted → card → Blocked with a reason,
branch kept. The implement gate also appends the goal's one-entry log to the repo's
**changelog** (`changelog`, absent ⇒ `docs/CHANGELOG.md`) — never to `CLAUDE.md` (LOCKED decision 6).
Full detail lives in `template/driver.md` — read it before changing pipeline behaviour.

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

**Shipping history:** `docs/CHANGELOG.md` — the per-goal log (what shipped, when, and why).
This section stays a SHORT current-state summary; goals append to the changelog, never here.
