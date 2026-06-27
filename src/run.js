'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  AUTOPILOT_SUBDIR,
  gitRoot,
  isCleanTree,
  hasExecutable,
  exists,
} = require('./util');

// Forward-slash display form of the pipeline subdir (nicer in messages on Windows).
const SUBDIR_DISPLAY = AUTOPILOT_SUBDIR.split(path.sep).join('/');

function readProjectName(configPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return (cfg.project && cfg.project.name) || (cfg.board && cfg.board.boardName) || 'project';
  } catch {
    return 'project';
  }
}

function buildPrompt(projectName, once) {
  const scope = once
    ? "process EXACTLY ONE goal from the Trello board's Pending list"
    : "process goals from the Trello board's Pending list serially until Pending is empty";
  return (
    `Execute the ${projectName} Autopilot: read ${AUTOPILOT_SUBDIR.split(/[\\/]/).join('/')}/driver.md ` +
    `and ${scope} -- each through all three gates to a fast-forward merge -- ` +
    `then stop until the next scheduled run.`
  );
}

async function run(opts) {
  const cwd = process.cwd();
  const root = gitRoot(cwd);
  if (!root) {
    throw new Error('Not inside a git repository. Run autopilot from the repo you want to drain.');
  }

  const driver = path.join(root, AUTOPILOT_SUBDIR, 'driver.md');
  if (!exists(driver)) {
    throw new Error(
      `No autopilot pipeline found at ${SUBDIR_DISPLAY}/driver.md.\n` +
        `Run "npx claude-autopilot init" first.`
    );
  }

  // The autopilot fast-forward-merges into THIS working tree, so it must be clean.
  const clean = isCleanTree(root);
  if (clean === false) {
    throw new Error(
      'Working tree is not clean. Commit or stash your changes before running Autopilot\n' +
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
  const projectName = readProjectName(path.join(root, AUTOPILOT_SUBDIR, 'autopilot.config.json'));

  const prompt = buildPrompt(projectName, once);
  const loopCmd = `/loop ${interval} ${prompt}`;

  console.log(
    `Launching Autopilot (interval: ${interval}, once: ${once}, unattended: ${unattended})`
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
