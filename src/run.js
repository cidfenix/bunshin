'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  CONFIG_FILENAME,
  ORCHESTRATOR_CONFIG_FILENAME,
  packageDriverPath,
  gitRoot,
  isCleanTree,
  hasExecutable,
  resolveAgent,
  buildLaunchCommand,
  resolveRepositories,
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

// ORCHESTRATOR mode: one board's goals span MANY repositories (listed in the orchestrator
// config). The driver is the same, but each goal first passes the `triage` gate — it reads the
// goal text against the configured repositories (their description + CLAUDE.md/README) to pick
// ONE repo, then implements there. A goal triage can't place is moved to Blocked. Pure +
// unit-testable, exactly like buildPrompt.
function buildOrchestratorPrompt(projectName, once, driverPath, statusFile, configFilename, repositories) {
  const scope = once
    ? "process EXACTLY ONE goal from the Pending column"
    : "process goals from the Pending column serially until Pending is empty";
  const driver = driverPath.split(/[\\/]/).join('/');
  const repoList = (repositories || []).map((r) => `${r.id} (${r.name})`).join(', ');
  const heartbeat = statusFile
    ? `As you work, write progress heartbeats to the status file at ${statusFile.split(/[\\/]/).join('/')} ` +
      `following the driver's Heartbeat contract (best-effort; never fail the loop if the write fails). `
    : '';
  return (
    `Execute the ${projectName} Bunshin in ORCHESTRATOR MODE across ${(repositories || []).length} ` +
    `repositories [${repoList}]: read the Bunshin driver at ${driver} (its agent briefs are in the ` +
    `agents/ folder beside it) and follow it to ${scope}. The orchestrator config is ${configFilename} ` +
    `at the root of the current folder; it lists the repositories (git remote + local path) and the ` +
    `gate pipeline. For EACH goal, run the TRIAGE gate FIRST to identify which repository it belongs to ` +
    `(from the goal text plus each repo's description + CLAUDE.md/README). If triage cannot confidently ` +
    `determine the repository, move the goal to Blocked with a comment naming the candidates and the ` +
    `missing info -- do NOT guess. Otherwise implement it in that repository's worktree through the ` +
    `remaining gates to integration. ` +
    heartbeat +
    `Then stop until the next scheduled run.`
  );
}

async function run(opts) {
  const cwd = process.cwd();
  const orchestrator = Boolean(opts.orchestrator);
  const configFilename = orchestrator ? ORCHESTRATOR_CONFIG_FILENAME : CONFIG_FILENAME;

  // Single-repo mode must run from inside the repo it drains (unchanged). Orchestrator mode is
  // driven from an "orchestrator home" folder that need not itself be a git repo — the goals are
  // implemented in the target repositories the config lists, not in this folder.
  const gitTop = gitRoot(cwd);
  const root = orchestrator ? gitTop || cwd : gitTop;
  if (!root) {
    throw new Error('Not inside a git repository. Run bunshin from the repo you want to drain.');
  }

  const configPath = path.join(root, configFilename);
  if (!exists(configPath)) {
    const hint = orchestrator
      ? `Run "npx github:cidfenix/bunshin init --orchestrator" (or "setup") first.`
      : `Run "npx github:cidfenix/bunshin setup" (guided) or "… init" first.`;
    throw new Error(`No ${configFilename} found at ${orchestrator ? 'this folder' : 'the repo root'}.\n${hint}`);
  }

  // Single-repo runs fast-forward-merge finished goals into THIS working tree, so it must be clean.
  // Orchestrator mode merges into each TARGET repo (not this folder), so the home tree is exempt.
  if (!orchestrator) {
    const clean = isCleanTree(root);
    if (clean === false) {
      throw new Error(
        'Working tree is not clean. Commit or stash your changes before running Bunshin\n' +
          '(it fast-forward-merges finished goals into this tree).'
      );
    }
  }

  // In orchestrator mode, validate the repositories list up front so a bad config fails fast
  // (rather than deep inside the driver's triage gate).
  let repositories = [];
  if (orchestrator) {
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new Error(`Could not parse ${configFilename}: ${e && e.message ? e.message : e}`);
    }
    repositories = resolveRepositories(cfg); // throws a clear error on a malformed repositories array
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

  const prompt = orchestrator
    ? buildOrchestratorPrompt(projectName, once, packageDriverPath(), statusFile, configFilename, repositories)
    : buildPrompt(projectName, once, packageDriverPath(), statusFile);

  console.log(
    `Launching Bunshin via ${agent.label}${orchestrator ? ` in ORCHESTRATOR mode over ${repositories.length} repos` : ''} ` +
      `(interval: ${interval}, once: ${once}, unattended: ${unattended})`
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

module.exports = { run, buildPrompt, buildOrchestratorPrompt };
