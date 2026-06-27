'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// The single per-repo file Bunshin writes/reads, at the consuming repo's root.
const CONFIG_FILENAME = 'bunshin.config.json';

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

// The driver + agent briefs are served from the installed package (never scaffolded
// into the consuming repo), so every repo shares one canonical copy. The agent briefs
// live in `agents/` beside this driver.
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
  exists,
  ensureDir,
  copyFile,
  copyDir,
};
