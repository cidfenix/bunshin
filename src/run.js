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
  resolveAgent,
  buildLaunchCommand,
  exists,
} = require('./util');
const reg = require('./registry');

// Pull the identity facts the dashboard shows, straight from the repo config. Tracker is the
// Jira project key or the Trello board name, per provider.
function readConfigSummary(configPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const provider = (cfg.provider && cfg.provider.kind) || 'jira';
    const tracker =
      provider === 'trello'
        ? cfg.board && cfg.board.boardName
        : cfg.jira && cfg.jira.projectKey;
    return {
      projectName: (cfg.project && cfg.project.name) || (cfg.board && cfg.board.boardName) || 'project',
      provider,
      tracker: tracker || null,
      baseBranch: (cfg.git && cfg.git.baseBranch) || null,
      mergeMode: (cfg.merge && cfg.merge.mode) || 'auto',
      agentKind: (cfg.agent && cfg.agent.kind) || 'claude',
    };
  } catch {
    return { projectName: 'project', provider: 'jira', tracker: null, baseBranch: null, mergeMode: 'auto', agentKind: 'claude' };
  }
}

// The driver lives in the installed package; the repo only owns CONFIG_FILENAME at its
// root. We hand Claude Code the absolute path to the package driver so one canonical copy
// drives every repo. The driver itself reads ./bunshin.config.json and dispatches the
// agent briefs that sit in `agents/` beside it.
function buildPrompt(projectName, once, driverPath, statusFile) {
  const scope = once
    ? "process EXACTLY ONE goal from the Pending column"
    : "process goals from the Pending column serially until Pending is empty";
  const driver = driverPath.split(/[\\/]/).join('/');
  const heartbeat = statusFile
    ? `As you work, write progress heartbeats to the status file at ${statusFile.split(/[\\/]/).join('/')} ` +
      `following the driver's Heartbeat contract (best-effort; never fail the loop if the write fails). `
    : '';
  return (
    `Execute the ${projectName} Bunshin: read the Bunshin driver at ${driver} (its agent briefs are ` +
    `in the agents/ folder beside it) and follow it to ${scope} -- each through all three gates to a ` +
    `fast-forward merge. The per-repo config is ${CONFIG_FILENAME} at the root of the current repo. ` +
    heartbeat +
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

  const interval = opts.interval || '20m';
  const once = Boolean(opts.once);
  const unattended = Boolean(opts.unattended);
  const summary = readConfigSummary(configPath);
  const projectName = summary.projectName;

  // Pluggable agent runtime: Claude Code (default) or codex, per agent.kind in the config.
  const agent = resolveAgent(summary.agentKind);

  if (!hasExecutable(agent.bin)) {
    throw new Error(
      `The "${agent.bin}" CLI was not found on PATH. Install ${agent.label} and ensure \`${agent.bin}\` is runnable,\n` +
        `then re-run. See ${agent.docsUrl}`
    );
  }

  // Register this repo in the shared ~/.bunshin/ home so `bunshin watch` can see it, and tell
  // the driver where to heartbeat. statusFile depends only on the repo path (not the PID).
  const repoId = reg.repoIdFor(root);
  const statusFile = reg.statusFileFor(repoId);

  const prompt = buildPrompt(projectName, once, packageDriverPath(), statusFile);

  console.log(
    `Launching Bunshin via ${agent.label} (interval: ${interval}, once: ${once}, unattended: ${unattended})`
  );
  if (unattended) {
    console.log(
      `WARNING: --unattended bypasses ALL ${agent.label} permission prompts for the whole session.\n` +
        '         It will run git, edit files, dispatch agents, and merge to the base branch without asking.'
    );
  }

  // Build the agent invocation (claude → `/loop … <prompt>`; codex → `codex exec <prompt>`)
  // and pass it as a single shell string. shell:true is the most portable way to resolve the
  // CLI (a .cmd shim on Windows); the prompt has no shell metacharacters, so the single
  // double-quoted argument is safe on both cmd.exe and POSIX sh.
  const command = buildLaunchCommand(agent, { prompt, interval, unattended });

  const child = spawn(command, { stdio: 'inherit', shell: true, cwd: root });

  // Best-effort registration; a registry write failure must never block the actual loop.
  try {
    reg.register({
      repoPath: root,
      projectName,
      provider: summary.provider,
      tracker: summary.tracker,
      baseBranch: summary.baseBranch,
      mergeMode: summary.mergeMode,
      pid: child.pid,
      startedAt: new Date().toISOString(),
    });
  } catch {
    /* dashboard is optional; keep going */
  }

  child.on('exit', (code) => {
    try {
      reg.markStopped(repoId);
    } catch {
      /* ignore */
    }
    process.exitCode = code == null ? 0 : code;
  });
}

module.exports = { run, buildPrompt };
