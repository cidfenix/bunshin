'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// The single per-repo file Bunshin writes/reads, at the consuming repo's root.
const CONFIG_FILENAME = 'bunshin.config.json';

// The ORCHESTRATOR config file. A single board/project can hold goals for MANY repositories;
// this distinctly-named file (chosen at run time via `bunshin run --orchestrator`) lists them.
// The two files coexist by design: a repo can own a `bunshin.config.json` to evolve ITSELF and
// also hold a `bunshin.orchestrator.json` to drive OTHERS.
const ORCHESTRATOR_CONFIG_FILENAME = 'bunshin.orchestrator.json';

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function templateDir() {
  return path.join(__dirname, '..', 'template');
}

// The driver + built-in gate presets are served from the installed package (never
// scaffolded into the consuming repo), so every repo shares one canonical copy. Each
// built-in gate preset lives in `gates/` beside this driver.
function packageDriverPath() {
  return path.join(templateDir(), 'driver.md');
}

// Capture stdout of a command; returns trimmed stdout or null on non-zero exit / spawn failure.
function capture(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false });
  if (res.status === 0 && typeof res.stdout === 'string') return res.stdout.trim();
  return null;
}

// Resolve the git repository root for a directory, or null if not in a repo.
function gitRoot(cwd) {
  return capture('git', ['rev-parse', '--show-toplevel'], cwd);
}

// True if the working tree at cwd has no uncommitted changes.
function isCleanTree(cwd) {
  const res = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', shell: false });
  if (res.status !== 0) return null; // not a repo / git error
  return res.stdout.trim() === '';
}

// Locate an executable on PATH (cross-platform). Returns true if found.
function hasExecutable(name) {
  const probe = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [name] : ['-v', name];
  // `command -v` is a shell builtin; run it through the shell on posix.
  if (process.platform === 'win32') {
    return spawnSync(probe, args, { stdio: 'ignore', shell: false }).status === 0;
  }
  return spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
}

// True if Docker is usable for a `--sandbox` run: the `docker` CLI is on PATH AND the daemon is
// reachable (`docker info` exits 0 — i.e. Docker Desktop / the engine is actually running, not just
// installed). Not pure (it spawns), so it lives beside hasExecutable rather than in sandbox.js.
function dockerAvailable() {
  if (!hasExecutable('docker')) return false;
  return spawnSync('docker', ['info'], { stdio: 'ignore', shell: false }).status === 0;
}

// --- Pluggable agent runtime --------------------------------------------------
// Bunshin launches an agent CLI to run the pipeline. Claude Code is the default;
// `codex` (the codex CLI) is an alternative. Everything below is pure (no spawn,
// no fs) so it is unit-testable; run.js / setup.js consume the resolved spec.
const AGENTS = {
  claude: {
    kind: 'claude',
    bin: 'claude',
    label: 'Claude Code',
    docsUrl: 'https://docs.claude.com/claude-code',
  },
  codex: {
    kind: 'codex',
    bin: 'codex',
    label: 'Codex',
    docsUrl: 'https://github.com/openai/codex',
  },
};

// Map a config agent.kind to its spawn spec. Absent/empty ⇒ 'claude' (preserves
// the original behavior). Matching is case-insensitive and space-trimmed. An
// unrecognised non-empty kind throws a clear error rather than silently guessing.
function resolveAgent(kind) {
  const key = String(kind == null ? '' : kind).trim().toLowerCase();
  if (!key) return AGENTS.claude;
  const spec = AGENTS[key];
  if (!spec) {
    throw new Error(
      `Unknown agent kind "${kind}" in ${CONFIG_FILENAME} (agent.kind). ` +
        `Use one of: ${Object.keys(AGENTS).join(', ')}.`
    );
  }
  return spec;
}

function quoteArg(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

// Build the full shell command Bunshin spawns to launch the autonomous run.
// Claude Code drives the loop via its `/loop <interval> <prompt>` slash command;
// codex has no slash command, so it runs the prompt once via `codex exec`. The
// unattended flag maps to each CLI's "skip all approvals" switch. The whole
// command is passed to spawn(..., { shell: true }); the prompt is single-line so
// collapsing runs of whitespace is safe and keeps the args tidy.
function buildLaunchCommand(agent, { prompt, interval, unattended }) {
  if (agent.kind === 'codex') {
    const flags = unattended ? '--dangerously-bypass-approvals-and-sandbox ' : '';
    return `codex exec ${flags}${quoteArg(prompt)}`.replace(/\s+/g, ' ').trim();
  }
  // claude (default)
  const loopCmd = `/loop ${interval} ${prompt}`;
  const flags = unattended ? '--dangerously-skip-permissions ' : '';
  return `claude ${flags}${quoteArg(loopCmd)}`.replace(/\s+/g, ' ').trim();
}

// Build the command for the INTERACTIVE setup session (no /loop, no bypass): both
// CLIs accept an initial prompt as the first positional argument.
function buildSetupCommand(agent, prompt) {
  return `${agent.bin} ${quoteArg(prompt)}`.replace(/\s+/g, ' ').trim();
}

// --- Configurable gate pipeline ----------------------------------------------
// The driver runs an ORDERED list of gates per goal. Historically this was the
// hard-coded implement→verify→review trio (web-app-shaped). It is now a per-repo
// preset (`gates.steps` in the config): reorder them, drop the web-only `verify`
// gate for config-only/CLI repos, or mix in custom `command`/`skill` steps.
// `resolveGates` is pure (no fs/spawn) so it is unit-testable; the driver markdown
// reads the same `gates.steps` list and runs the resolved steps in order, fail-fast.
// `triage` is the ORCHESTRATOR-mode preset gate: it picks which repository a goal belongs to
// (see resolveRepositories / template/driver.md). It is a valid step name but is NOT part of the
// single-repo default pipeline below — only orchestrator configs lead their `gates.steps` with it.
// `readme` is an OPT-IN adversarial docs gate: it BLOCKS when a user-facing change didn't update
// README.md (see template/gates/readme.md). Like `triage`, it is a valid step name but is NOT in the
// default pipeline — a repo opts in by naming it in `gates.steps`.
// `claude-md` is the sibling OPT-IN docs gate for `CLAUDE.md`: it BLOCKS when a change that alters
// architecture/conventions/LOCKED decisions didn't update CLAUDE.md (see template/gates/claude-md.md).
// Also opt-in, also NOT in the default pipeline.
const BUILTIN_GATES = Object.freeze(['triage', 'implement', 'verify', 'review', 'readme', 'claude-md']);
// Absent/empty ⇒ this default, so existing (single-repo) repos are unchanged.
const DEFAULT_GATE_STEPS = Object.freeze(['implement', 'verify', 'review']);

function normalizeGateStep(entry, index, ctx) {
  const label = (ctx && ctx.where) || 'gates.steps';
  const configFile = (ctx && ctx.configFile) || CONFIG_FILENAME;
  const where = `${label}[${index}]`;
  const assertBuiltin = (name, original) => {
    const key = String(name).trim().toLowerCase();
    if (!BUILTIN_GATES.includes(key)) {
      throw new Error(
        `Unknown built-in gate "${original}" at ${where} in ${configFile}. ` +
          `Built-in gates are: ${BUILTIN_GATES.join(', ')}. ` +
          `For a custom step use an object: {"command": "..."} or {"skill": "..."}.`
      );
    }
    return key;
  };

  if (typeof entry === 'string') {
    const gate = assertBuiltin(entry, entry);
    return { type: 'builtin', gate, name: gate };
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    if (typeof entry.gate === 'string') {
      const gate = assertBuiltin(entry.gate, entry.gate);
      return { type: 'builtin', gate, name: entry.name ? String(entry.name) : gate };
    }
    if (typeof entry.command === 'string' && entry.command.trim()) {
      return { type: 'command', command: entry.command, name: entry.name ? String(entry.name) : entry.command };
    }
    if (typeof entry.skill === 'string' && entry.skill.trim()) {
      return { type: 'skill', skill: entry.skill, name: entry.name ? String(entry.name) : entry.skill };
    }
    throw new Error(
      `Invalid gate step at ${where} in ${configFile}: an object step must have a ` +
        `"gate" (built-in), "command" (shell), or "skill" (agent skill) key.`
    );
  }
  throw new Error(
    `Invalid gate step at ${where} in ${configFile}: expected a built-in gate name ` +
      `(string) or a custom step object, got ${entry === null ? 'null' : typeof entry}.`
  );
}

// Resolve a `gates` block (`{ steps: [...] }`) into an ordered, normalized list of gate steps.
// Absent / empty ⇒ DEFAULT_GATE_STEPS (implement→verify→review, unchanged behavior).
// `opts` lets callers point error messages at a different location/file — e.g. a per-repo
// override in the orchestrator config (see resolveRepoGates): { where, configFile }.
function resolveGates(config, opts) {
  const raw = config && config.gates && config.gates.steps;
  const steps = Array.isArray(raw) && raw.length ? raw : DEFAULT_GATE_STEPS;
  const ctx = {
    where: (opts && opts.where) || 'gates.steps',
    configFile: (opts && opts.configFile) || CONFIG_FILENAME,
  };
  return steps.map((entry, index) => normalizeGateStep(entry, index, ctx));
}

// --- Configurable "skill or command" step shape ------------------------------
// Several optional config blocks let a repo swap a built-in default step for their OWN
// agent skill / slash-command OR a shell command: `merge.openPr` (how to open a PR — see
// resolveOpenPr) and `commit` (how the implement gate commits the goal's work — see
// resolveCommit). They share ONE shape: an object accepting EITHER a "skill" (an agent
// slash-command the driver invokes) OR a "command" (a shell command) — not both. Absent /
// null / all-keys-blank ⇒ the built-in default (the config uses "" as the neutral value
// throughout, like autoMerge.label / commands.install). This pure normalizer is the single
// source of truth for that shape; `label` is the config path used in error messages so a
// bad value points at the right key (e.g. "merge.openPr" / "commit").
function resolveSkillOrCommand(block, label) {
  // Absent / null ⇒ the built-in default.
  if (block == null) return { kind: 'default', value: null };
  if (typeof block !== 'object' || Array.isArray(block)) {
    throw new Error(
      `Invalid ${label} in ${CONFIG_FILENAME}: expected an object ` +
        `{"skill": "..."} or {"command": "..."}, got ${Array.isArray(block) ? 'array' : typeof block}.`
    );
  }
  // Read a key: absent/null/empty-string ⇒ unset; a present non-string value is a mistake ⇒ throw.
  const pick = (key) => {
    if (!Object.prototype.hasOwnProperty.call(block, key) || block[key] == null) return null;
    const v = block[key];
    if (typeof v !== 'string') {
      throw new Error(
        `Invalid ${label}.${key} in ${CONFIG_FILENAME}: expected a string ` +
          `(a ${key === 'skill' ? 'skill / slash-command name' : 'shell command'}), got ${Array.isArray(v) ? 'array' : typeof v}.`
      );
    }
    const trimmed = v.trim();
    return trimmed || null;
  };
  const skill = pick('skill');
  const command = pick('command');
  if (skill && command) {
    throw new Error(
      `Invalid ${label} in ${CONFIG_FILENAME}: set EITHER "skill" OR "command", not both.`
    );
  }
  if (skill) return { kind: 'skill', value: skill };
  if (command) return { kind: 'command', value: command };
  // Empty-object / all keys blank ⇒ the built-in default.
  return { kind: 'default', value: null };
}

// --- Configurable "open a PR" step (PR mode) ---------------------------------
// In `merge.mode: "pr"` the driver opens a GitHub PR from the goal branch. By default it
// runs the built-in `gh pr create --base <base> --head <branch> --fill`. Some teams open
// PRs through their own tooling — e.g. a custom Claude `/open-pr` slash-command that applies
// their PR template. `merge.openPr` lets them plug that in: `{ "skill": "/open-pr" }` (an
// agent skill / slash command the driver invokes) or `{ "command": "..." }` (a shell command).
// Absent/empty ⇒ the built-in default (unchanged behavior). `resolveOpenPr` is pure (no fs/
// spawn) so it is unit-testable; the driver reads the same `merge.openPr` block. The resolved
// skill/command is responsible for creating the PR AND printing the PR URL (the driver records
// `PR: <url>` on the issue). Mirrors the `command`/`skill` shape of custom gate steps.
function resolveOpenPr(config) {
  const openPr = config && config.merge && config.merge.openPr;
  return resolveSkillOrCommand(openPr, 'merge.openPr');
}

// --- Configurable "commit the work" step (implement gate) --------------------
// By default the implement gate stages the goal's changed files with explicit paths and
// makes ONE Conventional-Commit `git commit` (message ending with the `Co-Authored-By:`
// trailer). Some teams commit through their own tooling — e.g. a custom Claude `/commit`
// slash-command. The top-level `commit` block lets them plug that in: `{ "skill": "/commit" }`
// (an agent skill / slash command the implement gate invokes) or `{ "command": "..." }` (a
// shell command). Absent/blank ⇒ the built-in default (unchanged behavior). `resolveCommit`
// is pure (no fs/spawn) so it is unit-testable; the implement gate reads the same `commit`
// block. The resolved skill/command is RESPONSIBLE for staging + committing the goal's work on
// the current branch, and MUST still honour the implement gate's invariants: ONE commit that
// includes only the intended feature files + the changelog entry (see `resolveChangelog`), never
// stages a `neverCommit.paths` file, and keeps the `Co-Authored-By:` trailer. Mirrors
// `resolveOpenPr`.
function resolveCommit(config) {
  const commit = config && config.commit;
  return resolveSkillOrCommand(commit, 'commit');
}

// --- Configurable changelog (where the per-goal log entry lands) --------------
// Every finished goal appends ONE line describing what shipped. That line used to go into
// CLAUDE.md's "Current status" section — which made CLAUDE.md grow WITHOUT BOUND: it is the
// canonical context EVERY agent reads on EVERY goal, so an append-only log inside it burns
// context on every run and eventually blows past the file's practical size limit (a real
// consumer reached ~1.1M characters and had to hand-migrate the history out — twice).
// So the log lives in its OWN file: a top-level `changelog` path (repo-relative; absent ⇒
// `docs/CHANGELOG.md`). CLAUDE.md then changes ONLY when a DURABLE fact changes (architecture,
// conventions, a LOCKED decision) — exactly what the opt-in `claude-md` gate polices.
// `false` disables the log entry entirely; a repo that truly wants the old behavior can set
// `"changelog": "CLAUDE.md"`. `resolveChangelog` is pure (no fs) so it is unit-testable; the
// implement gate + driver read the same key. Returns `{ enabled, path }`.
const DEFAULT_CHANGELOG_PATH = 'docs/CHANGELOG.md';

function resolveChangelog(config) {
  const raw = config && config.changelog;
  if (raw == null) return { enabled: true, path: DEFAULT_CHANGELOG_PATH };
  if (raw === false) return { enabled: false, path: null };
  if (raw === true) return { enabled: true, path: DEFAULT_CHANGELOG_PATH };
  if (typeof raw !== 'string') {
    throw new Error(
      `Invalid changelog in ${CONFIG_FILENAME}: expected a repo-relative file path string ` +
        `(absent => "${DEFAULT_CHANGELOG_PATH}"), or false to disable, got ` +
        `${Array.isArray(raw) ? 'array' : typeof raw}.`
    );
  }
  // Empty / whitespace-only is neutral (like the rest of the config) ⇒ the default path.
  const trimmed = raw.trim();
  if (!trimmed) return { enabled: true, path: DEFAULT_CHANGELOG_PATH };
  const normalized = trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
  // The changelog is a file INSIDE the repo: an absolute path or a `..` escape is a mistake
  // (the implement gate writes it from a worktree — it must never reach outside).
  if (/^([/\\]|[A-Za-z]:)/.test(trimmed) || normalized.split('/').includes('..')) {
    throw new Error(
      `Invalid changelog in ${CONFIG_FILENAME}: expected a path INSIDE the repo (relative, ` +
        `no leading "/" or drive letter, no ".." segment), got ${JSON.stringify(raw)}.`
    );
  }
  return { enabled: true, path: normalized };
}

// --- Configurable PR labels (PR mode) ----------------------------------------
// In `merge.mode: "pr"` a team often wants to FILTER OUT the PRs Bunshin opens (e.g. exclude
// them from a human review queue). `merge.prLabels` is an OPTIONAL list of label strings that
// the driver STAMPS onto every PR it opens. This is a STAMP for filtering — NOT to be confused
// with `merge.autoMerge.label`, which is a merge GATE the reaper REQUIRES on a PR before it
// auto-merges. Keep them distinct. `resolvePrLabels` is pure (no fs/spawn) so it is unit-testable;
// the driver reads the same `merge.prLabels` list. Absent / null / [] / all-blank ⇒ [] (no labels
// added — today's behavior). Normalizes: trims each entry, drops empties, de-dupes (first wins).
// A non-array value, or a non-string entry, throws a clear `merge.prLabels`-referencing error.
function resolvePrLabels(config) {
  const raw = config && config.merge && config.merge.prLabels;
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `Invalid merge.prLabels in ${CONFIG_FILENAME}: expected an array of label strings ` +
        `(e.g. ["bunshin", "automated"]), got ${typeof raw}.`
    );
  }
  const out = [];
  const seen = new Set();
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      throw new Error(
        `Invalid merge.prLabels[${index}] in ${CONFIG_FILENAME}: expected a label string, ` +
          `got ${entry === null ? 'null' : Array.isArray(entry) ? 'array' : typeof entry}.`
      );
    }
    const label = entry.trim();
    if (!label || seen.has(label)) return;
    seen.add(label);
    out.push(label);
  });
  return out;
}

// --- Configurable auto-push (auto mode only) ----------------------------------
// `merge.mode: "auto"` fast-forward-merges a finished goal into `git.baseBranch` LOCALLY — by
// design, no remote/GitHub is needed. `merge.autoPush` (default true) additionally pushes that
// base branch to `merge.remote` right after each such local change (the driver's own INTEGRATION
// merge, and the --sandbox host CLI's sync-back), so a repo that DOES have a remote doesn't
// silently drift behind it. Best-effort at the call site (no remote / a failed push never fails
// the goal) — this resolver only validates the boolean. `resolveAutoPush` is pure (no fs/spawn) so
// it is unit-testable. A non-boolean value throws a clear `merge.autoPush`-referencing error.
function resolveAutoPush(config) {
  const raw = config && config.merge && config.merge.autoPush;
  if (raw == null) return true;
  if (typeof raw !== 'boolean') {
    throw new Error(
      `Invalid merge.autoPush in ${CONFIG_FILENAME}: expected a boolean (absent => true), got ` +
        `${JSON.stringify(raw)}.`
    );
  }
  return raw;
}

// --- Configurable goal-branch push (crash/hand-off durability) -----------------
// A goal's work lives on `<git.branchPrefix><N>-<slug>` inside a local worktree until it merges,
// so an agent that stops — or a goal parked to Blocked — leaves that work on exactly ONE disk.
// `git.pushBranches` (default true) has the driver push the goal branch to `merge.remote` after
// every gate that may have committed, at PARK, and at auto-retry, and lets driver step 4 resume a
// goal from `<remote>/<branch>` on a DIFFERENT machine. It sits in the `git` block because it is
// branch-lifecycle, not integration — the sibling knob `merge.autoPush` pushes the BASE branch
// after a merge. Best-effort at the call site (no remote / a failed push never fails or parks the
// goal, preserving the "auto mode needs no remote" guarantee) — this resolver only validates the
// boolean. `resolvePushBranches` is pure (no fs/spawn) so it is unit-testable. A non-boolean value
// throws a clear `git.pushBranches`-referencing error.
function resolvePushBranches(config) {
  const raw = config && config.git && config.git.pushBranches;
  if (raw == null) return true;
  if (typeof raw !== 'boolean') {
    throw new Error(
      `Invalid git.pushBranches in ${CONFIG_FILENAME}: expected a boolean (absent => true), got ` +
        `${JSON.stringify(raw)}.`
    );
  }
  return raw;
}

// --- Configurable concurrency (goals in flight) --------------------------------
// How many goals the driver may work AT THE SAME TIME (worktree cut, gates running).
// Historically hard-serial (exactly one); a top-level `concurrency` in the config now bounds
// it per repo/queue. Absent ⇒ 1 = serial (unchanged behavior). INTEGRATION (rebase +
// gateChecks + merge) stays serial regardless — this only bounds the implement/gates work.
// `resolveConcurrency` is pure (no fs/spawn) so it is unit-testable; the driver reads the
// same top-level `concurrency` key. A non-number / non-integer / < 1 value throws a clear
// `concurrency`-referencing error rather than silently degrading to serial.
function resolveConcurrency(config) {
  const raw = config && config.concurrency;
  if (raw == null) return 1;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new Error(
      `Invalid concurrency in ${CONFIG_FILENAME}: expected a whole number >= 1 ` +
        `(how many goals may be in flight at once; absent => 1 = serial), got ` +
        `${typeof raw === 'number' ? raw : JSON.stringify(raw)}.`
    );
  }
  return raw;
}

// --- Auto-unblock (self-resolving gate failures) ---------------------------------
// When a gate fails, the driver classifies the failure: self-resolvable (fixable by editing the
// repo and re-running the gates) goals are sent back to Pending with a scoped `Auto-retry`
// comment — worktree and branch kept — while human-needed failures park to Blocked as before.
// The top-level `unblock` block tunes it: absent ⇒ { auto: true, maxRetries: 5 } (ON by
// default); `auto: false` restores park-everything; `maxRetries: 0` = classify but never retry.
// `resolveUnblock` is pure (no fs/spawn) so it is unit-testable; the driver reads the same
// `unblock` key and mirrors these semantics. Invalid values throw a clear key-referencing error
// rather than silently degrading.
function resolveUnblock(config) {
  const raw = config && config.unblock;
  if (raw == null) return { auto: true, maxRetries: 5 };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `Invalid unblock in ${CONFIG_FILENAME}: expected an object like {"auto": true, "maxRetries": 5}, got ` +
        `${JSON.stringify(raw)}.`
    );
  }
  const auto = raw.auto == null ? true : raw.auto;
  if (typeof auto !== 'boolean') {
    throw new Error(
      `Invalid unblock.auto in ${CONFIG_FILENAME}: expected a boolean (absent => true), got ` +
        `${JSON.stringify(raw.auto)}.`
    );
  }
  const maxRetries = raw.maxRetries == null ? 5 : raw.maxRetries;
  if (typeof maxRetries !== 'number' || !Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error(
      `Invalid unblock.maxRetries in ${CONFIG_FILENAME}: expected a whole number >= 0 (absent => 5), got ` +
        `${JSON.stringify(raw.maxRetries)}.`
    );
  }
  return { auto, maxRetries };
}

// --- Configurable context cleanup (driver /compact cadence) --------------------
// A long `/loop` driver session accumulates conversation history as it drains goals. A
// top-level `contextCleanupEvery` bounds how many COMPLETED goals pass between proactive
// `/compact` calls (Claude Code only -- codex exec restarts fresh per invocation, so there's
// no accumulating session context to compact there). Absent ⇒ 5. `0` ⇒ disabled. `resolveContextCleanup`
// is pure (no fs/spawn) so it is unit-testable; a non-number / non-integer / < 0 value throws a clear
// `contextCleanupEvery`-referencing error.
function resolveContextCleanup(config) {
  const raw = config && config.contextCleanupEvery;
  if (raw == null) return 5;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new Error(
      `Invalid contextCleanupEvery in ${CONFIG_FILENAME}: expected a whole number >= 0 ` +
        `(how many completed goals between /compact calls; absent => 5, 0 => disabled), got ` +
        `${typeof raw === 'number' ? raw : JSON.stringify(raw)}.`
    );
  }
  return raw;
}

// --- Orchestrator repositories -----------------------------------------------
// In orchestrator mode one board's goals span MANY repositories, listed under
// `repositories` in the orchestrator config. `resolveRepositories` validates and
// normalizes that array (pure, no fs) so run.js can guard on a bad config early and
// the driver's `triage` gate has a clean candidate set. Each normalized entry:
//   { id, name, remote|null, path|null, baseBranch|null, description, gates|null, commands|null }
// A repo needs a unique `id` and at least a `remote` (git URL) or a `path` (local checkout).
// `gates`/`commands` are OPTIONAL per-repo overrides carried through raw (a repo can define its
// OWN gate pipeline / command set — heterogeneous repos need different toolchains); they are
// resolved on demand by resolveRepoGates / resolveRepoCommands, not here.
function resolveRepositories(config) {
  const raw = config && config.repositories;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `Orchestrator config ${ORCHESTRATOR_CONFIG_FILENAME} needs a non-empty "repositories" array ` +
        `(each entry: id + a remote and/or path). None found — is this an orchestrator config?`
    );
  }
  const seen = new Set();
  return raw.map((entry, index) => {
    const where = `repositories[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `Invalid ${where} in ${ORCHESTRATOR_CONFIG_FILENAME}: expected an object with id + remote/path, ` +
          `got ${entry === null ? 'null' : typeof entry}.`
      );
    }
    const id = String(entry.id == null ? '' : entry.id).trim();
    if (!id) {
      throw new Error(`Missing "id" at ${where} in ${ORCHESTRATOR_CONFIG_FILENAME} (a short unique repository slug).`);
    }
    const key = id.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate repository id "${id}" at ${where} in ${ORCHESTRATOR_CONFIG_FILENAME}; ids must be unique.`);
    }
    seen.add(key);
    const remote = String(entry.remote == null ? '' : entry.remote).trim();
    const localPath = String(entry.path == null ? '' : entry.path).trim();
    if (!remote && !localPath) {
      throw new Error(
        `Repository "${id}" at ${where} in ${ORCHESTRATOR_CONFIG_FILENAME} needs at least a ` +
          `"remote" (git URL) or a "path" (local checkout).`
      );
    }
    const gates = entry.gates && typeof entry.gates === 'object' && !Array.isArray(entry.gates) ? entry.gates : null;
    const commands =
      entry.commands && typeof entry.commands === 'object' && !Array.isArray(entry.commands) ? entry.commands : null;
    return {
      id,
      name: entry.name ? String(entry.name) : id,
      remote: remote || null,
      path: localPath || null,
      baseBranch: entry.baseBranch ? String(entry.baseBranch) : null,
      description: entry.description ? String(entry.description) : '',
      gates,
      commands,
    };
  });
}

// --- Per-repo gate / command overrides (orchestrator mode) -------------------
// Heterogeneous repos (a web app vs a config-only CLI vs an Android app) need DIFFERENT
// gate pipelines and build/test commands. In orchestrator mode each `repositories[]` entry
// may carry its OWN optional `gates` (`{ steps: [...] }`) and/or `commands` block, overriding
// the orchestrator-global default. These pure resolvers return the EFFECTIVE values for the
// repo the `triage` gate picked. `repo` is a normalized entry (from resolveRepositories) or a
// raw repositories entry — either way its `gates`/`commands` fields are honoured.

// Effective ordered gate list for a repo: the repo's OWN `gates.steps` if present, else the
// orchestrator-global `gates.steps`, else DEFAULT_GATE_STEPS. Reuses resolveGates so custom
// `command`/`skill` steps and all built-ins work per-repo too; an unknown gate throws with a
// message identifying WHICH repository (so a bad override is easy to trace).
function resolveRepoGates(orchestratorConfig, repo) {
  const ownSteps = repo && repo.gates && repo.gates.steps;
  if (Array.isArray(ownSteps) && ownSteps.length) {
    const id = repo && repo.id != null ? String(repo.id) : '?';
    return resolveGates(
      { gates: repo.gates },
      { where: `repositories["${id}"].gates.steps`, configFile: ORCHESTRATOR_CONFIG_FILENAME }
    );
  }
  // Fall back to the orchestrator-global gates (resolveGates itself falls back to
  // DEFAULT_GATE_STEPS when the global block is absent/empty too).
  return resolveGates(orchestratorConfig, { configFile: ORCHESTRATOR_CONFIG_FILENAME });
}

// Effective command map for a repo: the orchestrator-global `commands`, shallow-merged with the
// repo's OWN `commands` (repo keys win). So a repo can override just `gateChecks`/`install`/
// `devServer` while inheriting the rest. Both blocks absent ⇒ {}.
function resolveRepoCommands(orchestratorConfig, repo) {
  const global =
    orchestratorConfig && orchestratorConfig.commands && typeof orchestratorConfig.commands === 'object' && !Array.isArray(orchestratorConfig.commands)
      ? orchestratorConfig.commands
      : {};
  const own = repo && repo.commands && typeof repo.commands === 'object' && !Array.isArray(repo.commands) ? repo.commands : {};
  return { ...global, ...own };
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Copy a single file, creating parent dirs. Skips if dest exists and overwrite is false.
function copyFile(src, dest, overwrite) {
  ensureDir(path.dirname(dest));
  if (!overwrite && exists(dest)) return false;
  fs.copyFileSync(src, dest);
  return true;
}

// Recursively copy a directory tree.
function copyDir(srcDir, destDir, overwrite) {
  ensureDir(destDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dest, overwrite);
    } else {
      copyFile(src, dest, overwrite);
    }
  }
}

module.exports = {
  CONFIG_FILENAME,
  ORCHESTRATOR_CONFIG_FILENAME,
  readVersion,
  templateDir,
  packageDriverPath,
  capture,
  gitRoot,
  isCleanTree,
  hasExecutable,
  dockerAvailable,
  resolveAgent,
  buildLaunchCommand,
  buildSetupCommand,
  BUILTIN_GATES,
  DEFAULT_GATE_STEPS,
  resolveGates,
  resolveOpenPr,
  resolvePrLabels,
  resolveAutoPush,
  resolvePushBranches,
  resolveConcurrency,
  resolveUnblock,
  resolveContextCleanup,
  resolveCommit,
  DEFAULT_CHANGELOG_PATH,
  resolveChangelog,
  resolveRepositories,
  resolveRepoGates,
  resolveRepoCommands,
  exists,
  ensureDir,
  copyFile,
  copyDir,
};
