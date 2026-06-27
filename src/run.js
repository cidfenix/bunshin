'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  CONFIG_FILENAME,
  packageDriverPath,
  gitRoot,
  isCleanTree,
  hasExecutable,
  exists,
} = require('./util');

function readProjectName(configPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return (cfg.project && cfg.project.name) || (cfg.board && cfg.board.boardName) || 'project';
  } catch {
    return 'project';
  }
}

// The driver lives in the installed package; the repo only owns CONFIG_FILENAME at its
// root. We hand Claude Code the absolute path to the package driver so one canonical copy
// drives every repo. The driver itself reads ./bunshin.config.json and dispatches the
// agent briefs that sit in `agents/` beside it.
function buildPrompt(projectName, once, driverPath) {
  const scope = once
    ? "process EXACTLY ONE goal from the Trello board's Pending list"
    : "process goals from the Trello board's Pending list serially until Pending is empty";
  const driver = driverPath.split(/[\\/]/).join('/');
  return (
    `Execute the ${projectName} Bunshin: read the Bunshin driver at ${driver} (its agent briefs are ` +
    `in the agents/ folder beside it) and follow it to ${scope} -- each through all three gates to a ` +
    `fast-forward merge. The per-repo config is ${CONFIG_FILENAME} at the root of the current repo. ` +
    `Then stop until the next scheduled run.`
  );
}

async function run(opts) {
  const cwd = process.cwd();
  const root = gitRoot(cwd);
  if (!root) {
    throw new Error('Not inside a git repository. Run bunshin from the repo you want to drain.');
  }

  const configPath = path.join(root, CONFIG_FILENAME);
  if (!exists(configPath)) {
    throw new Error(
      `No ${CONFIG_FILENAME} found at the repo root.\n` +
        `Run "npx github:cidfenix/bunshin setup" (guided) or "… init" first.`
    );
  }

  // The bunshin loop fast-forward-merges into THIS working tree, so it must be clean.
  const clean = isCleanTree(root);
  if (clean === false) {
    throw new Error(
      'Working tree is not clean. Commit or stash your changes before running Bunshin\n' +
        '(it fast-forward-merges finished goals into this tree).'
    );
  }

  if (!hasExecutable('claude')) {
    throw new Error(
      'The "claude" CLI was not found on PATH. Install Claude Code and ensure `claude` is runnable,\n' +
        'then re-run. See https://docs.claude.com/claude-code'
    );
  }

  const interval = opts.interval || '20m';
  const once = Boolean(opts.once);
  const unattended = Boolean(opts.unattended);
  const projectName = readProjectName(configPath);

  const prompt = buildPrompt(projectName, once, packageDriverPath());
  const loopCmd = `/loop ${interval} ${prompt}`;

  console.log(
    `Launching Bunshin (interval: ${interval}, once: ${once}, unattended: ${unattended})`
  );
  if (unattended) {
    console.log(
      'WARNING: --unattended bypasses ALL Claude Code permission prompts for the whole session.\n' +
        '         It will run git, edit files, dispatch agents, and merge to the base branch without asking.'
    );
  }

  // Pass the whole "/loop ..." string to Claude Code as a SINGLE argument (matching the
  // original .ps1/.sh launchers). shell:true is the most portable way to resolve `claude`
  // (a .cmd shim on Windows); the prompt contains no shell metacharacters, so a single
  // double-quoted argument is safe on both cmd.exe and POSIX sh.
  const args = unattended ? ['--dangerously-skip-permissions'] : [];
  const quoted = `"${loopCmd.replace(/"/g, '\\"')}"`;
  const command = `claude ${args.join(' ')} ${quoted}`.replace(/\s+/g, ' ').trim();

  const child = spawn(command, { stdio: 'inherit', shell: true, cwd: root });
  child.on('exit', (code) => {
    process.exitCode = code == null ? 0 : code;
  });
}

module.exports = { run, buildPrompt };
