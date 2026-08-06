# Bunshin changelog

Per-goal shipping history for the Bunshin tool itself: what each goal shipped, the decisions behind
it, and the bugs it verified. Archived out of `CLAUDE.md` on 2026-07-22, when Bunshin adopted its own
new default (`changelog`, absent => `docs/CHANGELOG.md`) — `CLAUDE.md` is the CURRENT state, this file
is the running log. Newest entries at the end. Grep it for a ticket id or topic; do not read it whole.

## History (archived from CLAUDE.md)

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
- **auto-unblock**: the driver now classifies every gate failure at park time instead of always
  parking. Self-resolvable failures (in-repo fix + re-run gates) round-trip to Pending with a scoped
  `Auto-retry <n>/<max>` comment, keeping branch AND worktree (no re-install on retry); human-needed
  failures still park to Blocked, which now means "needs a human". New top-level `unblock` config
  (`{auto, maxRetries}`, default ON with 5 retries; per-repo override in orchestrator mode);
  `resolveUnblock` in `src/util.js` pins the semantics (`test/unblock.test.js`). Driver step 4 gained
  explicit resume semantics (reuse kept worktree → add worktree on existing branch → fresh), which
  also fixes manual unblocks; the implement brief gained a "Retry attempts" scoping note. Spec:
  `docs/superpowers/specs/2026-07-31-auto-unblock-design.md`.
- **push goal branches**: goal branches are now checkpointed to `merge.remote` instead of living only
  on the machine that produced them. New `git.pushBranches` config (boolean, absent ⇒ `true`;
  `resolvePushBranches` in `src/util.js`, `test/pushBranches.test.js` — which also guards both config
  templates and the shipped driver text). The driver pushes `<branchPrefix><N>-<slug>` after each
  gate step completes (passing or failing), at PARK, and at auto-retry, and driver step 4 now syncs
  with the remote on the way back in: it resumes from `<remote>/<branch>` when no local branch exists,
  and fast-forwards the local branch from the remote when one does — together they let a second agent,
  or a different computer, resume a parked goal without the originating machine silently resuming (and
  merging) stale work. That fast-forward uses an ff-only refspec — never a reset or a force — and on a
  diverged history the local branch wins and the divergence is reported. Every checkpoint push is
  best-effort (no remote / a failed push is logged, never a gate failure or a park), so auto mode still
  needs no remote. A merged goal's remote branch is deleted with its local one; parked branches are
  kept. Both the checkpoint pushes and PR-mode integration push with `--force-with-lease` — the
  pre-merge rebase rewrites shas the checkpoints already pushed, which a plain push would reject
  (silently, on the best-effort path); Bunshin is the sole writer of `<branchPrefix>*` branches, and
  the lease still refuses if anyone else moved the ref. Sandboxed auto runs skip the pushes and the
  step-4 remote reads (the clone's `origin` is the host repo path). Placed in the `git` block,
  deliberately distinct from `merge.autoPush` (base
  branch). Design: `docs/superpowers/specs/2026-08-07-push-goal-branches-design.md`.
