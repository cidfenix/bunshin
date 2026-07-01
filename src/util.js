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
const BUILTIN_GATES = Object.freeze(['triage', 'implement', 'verify', 'review', 'readme']);
// Absent/empty ⇒ this default, so existing (single-repo) repos are unchanged.
const DEFAULT_GATE_STEPS = Object.freeze(['implement', 'verify', 'review']);

function normalizeGateStep(entry, index) {
  const where = `gates.steps[${index}]`;
  const assertBuiltin = (name, original) => {
    const key = String(name).trim().toLowerCase();
    if (!BUILTIN_GATES.includes(key)) {
      throw new Error(
        `Unknown built-in gate "${original}" at ${where} in ${CONFIG_FILENAME}. ` +
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
      `Invalid gate step at ${where} in ${CONFIG_FILENAME}: an object step must have a ` +
        `"gate" (built-in), "command" (shell), or "skill" (agent skill) key.`
    );
  }
  throw new Error(
    `Invalid gate step at ${where} in ${CONFIG_FILENAME}: expected a built-in gate name ` +
      `(string) or a custom step object, got ${entry === null ? 'null' : typeof entry}.`
  );
}

// Resolve config.gates.steps into an ordered, normalized list of gate steps.
// Absent / empty ⇒ DEFAULT_GATE_STEPS (implement→verify→review, unchanged behavior).
function resolveGates(config) {
  const raw = config && config.gates && config.gates.steps;
  const steps = Array.isArray(raw) && raw.length ? raw : DEFAULT_GATE_STEPS;
  return steps.map(normalizeGateStep);
}

// --- Orchestrator repositories -----------------------------------------------
// In orchestrator mode one board's goals span MANY repositories, listed under
// `repositories` in the orchestrator config. `resolveRepositories` validates and
// normalizes that array (pure, no fs) so run.js can guard on a bad config early and
// the driver's `triage` gate has a clean candidate set. Each normalized entry:
//   { id, name, remote|null, path|null, baseBranch|null, description }
// A repo needs a unique `id` and at least a `remote` (git URL) or a `path` (local checkout).
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
    return {
      id,
      name: entry.name ? String(entry.name) : id,
      remote: remote || null,
      path: localPath || null,
      baseBranch: entry.baseBranch ? String(entry.baseBranch) : null,
      description: entry.description ? String(entry.description) : '',
    };
  });
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
  resolveAgent,
  buildLaunchCommand,
  buildSetupCommand,
  BUILTIN_GATES,
  DEFAULT_GATE_STEPS,
  resolveGates,
  resolveRepositories,
  exists,
  ensureDir,
  copyFile,
  copyDir,
};
