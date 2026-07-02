'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  CONFIG_FILENAME,
  ORCHESTRATOR_CONFIG_FILENAME,
  packageDriverPath,
  templateDir,
  readVersion,
  gitRoot,
  isCleanTree,
  hasExecutable,
  dockerAvailable,
  resolveAgent,
  buildLaunchCommand,
  resolveRepositories,
  exists,
} = require('./util');
const { resolveSandbox, buildDockerCommand } = require('./sandbox');
const reg = require('./registry');

// The container path the host heartbeat status file is bind-mounted to (rw) in sandbox mode, so the
// driver (running at /work inside the container) writes heartbeats there and `bunshin watch` — which
// reads the host file — still sees live progress.
const CONTAINER_STATUS_PATH = '/tmp/bunshin-status.json';

// Auto-mode sync-back (the SINGLE host-repo write a sandboxed run performs): fetch the clone's
// baseBranch into the host repo, then fast-forward the host baseBranch to it. If the host base moved
// and a fast-forward is impossible, do NOT force — report and leave the clone in place for
// inspection (the goal's commits are safe there). Runs only on a clean container exit, auto mode only.
function syncBackFromClone(root, cloneDir, baseBranch) {
  const fetch = spawnSync('git', ['fetch', cloneDir, baseBranch], { cwd: root, stdio: 'inherit', shell: false });
  if (fetch.status !== 0) {
    console.error(`Sandbox sync-back: \`git fetch ${cloneDir} ${baseBranch}\` failed; the clone is left at ${cloneDir}.`);
    return;
  }
  const merge = spawnSync('git', ['merge', '--ff-only', 'FETCH_HEAD'], { cwd: root, stdio: 'inherit', shell: false });
  if (merge.status !== 0) {
    console.error(
      `Sandbox sync-back: the host ${baseBranch} could not be fast-forwarded (it moved during the run).\n` +
        `        NOT forcing. The goal's commits are safe in the clone at ${cloneDir} — merge them manually.`
    );
  }
}

// Prepare a FRESH, fully isolated local clone of the host repo for the sandboxed agent to work in.
// `git clone --local` hardlinks objects (fast, disk-cheap). Removed + recreated each run. In PR mode
// re-point the clone's origin at the REAL remote so the in-container push/PR targets GitHub, not the
// local source. The clone lives under the already-gitignored `.bunshin/` area.
function prepareSandboxClone(root, mergeMode, remoteName) {
  const cloneDir = path.join(root, '.bunshin', 'sandbox-work');
  fs.rmSync(cloneDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
  const clone = spawnSync('git', ['clone', '--local', root, cloneDir], { stdio: 'inherit', shell: false });
  if (clone.status !== 0) {
    throw new Error(`Failed to create the isolated sandbox clone at ${cloneDir} (git clone --local).`);
  }
  if (mergeMode === 'pr') {
    const realUrl = spawnSync('git', ['remote', 'get-url', remoteName], { cwd: root, encoding: 'utf8', shell: false });
    const url = realUrl.status === 0 ? String(realUrl.stdout).trim() : '';
    if (url) {
      spawnSync('git', ['remote', 'set-url', 'origin', url], { cwd: cloneDir, stdio: 'inherit', shell: false });
    }
  }
  return cloneDir;
}

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
// built-in gate presets that sit in `gates/` beside it.
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
    `Execute the ${projectName} Bunshin: read the Bunshin driver at ${driver} (its built-in gate ` +
    `presets are in the gates/ folder beside it) and follow it to ${scope} -- each through all three gates to a ` +
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
    `repositories [${repoList}]: read the Bunshin driver at ${driver} (its built-in gate presets are in the ` +
    `gates/ folder beside it) and follow it to ${scope}. The orchestrator config is ${configFilename} ` +
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
  const sandbox = Boolean(opts.sandbox);
  const configFilename = orchestrator ? ORCHESTRATOR_CONFIG_FILENAME : CONFIG_FILENAME;

  // Sandboxing is a single-repo isolation wrapper; orchestrator sandboxing is out of scope (BUN-16 §8).
  if (sandbox && orchestrator) {
    throw new Error(
      '--sandbox cannot be combined with --orchestrator (sandboxed runs are single-repo only for now).'
    );
  }

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

  // --- Sandboxed run (BUN-16): run the agent in Docker against an ISOLATED CLONE ---------------
  // The host repo is NEVER bind-mounted; only this CLI writes it (auto: git fetch + --ff-only after a
  // clean exit; PR: via the remote). Everything before this point (guards, agent resolution, registry
  // identity) is shared; the non-sandbox path below is byte-for-byte unchanged.
  if (sandbox) {
    if (!dockerAvailable()) {
      throw new Error(
        'Docker is not available for --sandbox: the `docker` CLI must be on PATH and the daemon reachable.\n' +
          'Start Docker Desktop (or your Docker engine) and re-run. Absent --sandbox, Bunshin runs on the host as usual.'
      );
    }

    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new Error(`Could not parse ${configFilename}: ${e && e.message ? e.message : e}`);
    }
    const sb = resolveSandbox(cfg); // throws a clear sandbox.*-keyed error on a malformed block
    const mergeMode = summary.mergeMode;
    const baseBranch = summary.baseBranch || 'main';
    const remoteName = (cfg.merge && cfg.merge.remote) || 'origin';

    // Resolve/ensure the image: an explicit sandbox.image is used as-is; otherwise build the shipped
    // reference image, tagged by package version so it only rebuilds on a Bunshin upgrade.
    let image = sb.image;
    if (!image) {
      image = `bunshin-sandbox:${readVersion()}`;
      const dockerfile = sb.dockerfile
        ? path.resolve(root, sb.dockerfile)
        : path.join(templateDir(), 'sandbox', 'Dockerfile');
      const ctx = path.dirname(dockerfile);
      console.log(`Building the sandbox image ${image} from ${dockerfile.split(/[\\/]/).join('/')} (first run / after upgrade)…`);
      const build = spawnSync('docker', ['build', '-f', dockerfile, '-t', image, ctx], { stdio: 'inherit', shell: false });
      if (build.status !== 0) {
        throw new Error(`Failed to build the sandbox image ${image} from ${dockerfile}. See the docker output above.`);
      }
    }

    // Fresh isolated clone the container works in.
    const cloneDir = prepareSandboxClone(root, mergeMode, remoteName);

    // Expand `~` in mount hosts NOW (against the real host home) — resolveSandbox left it pure.
    const home = os.homedir();
    const expandedMounts = sb.mounts.map((m) => ({
      host: m.host.startsWith('~') ? path.join(home, m.host.slice(1)) : m.host,
      container: m.container,
    }));

    // The driver runs inside the container (cwd /work); tell it to heartbeat to the container status
    // path, which we bind-mount to the host status file so `bunshin watch` still sees progress.
    const sandboxPrompt = buildPrompt(projectName, once, packageDriverPath(), CONTAINER_STATUS_PATH);
    const agentCommand = buildLaunchCommand(agent, { prompt: sandboxPrompt, interval, unattended });
    const dockerCommand = buildDockerCommand({
      image,
      workdir: cloneDir,
      network: sb.network,
      envNames: sb.env,
      mounts: expandedMounts,
      statusMount: { host: statusFile, container: CONTAINER_STATUS_PATH },
      agentCommand,
    });

    console.log(
      `Launching Bunshin via ${agent.label} in SANDBOX mode (Docker, network: ${sb.network}, image: ${image}) ` +
        `against an isolated clone at ${cloneDir.split(/[\\/]/).join('/')} ` +
        `(interval: ${interval}, once: ${once}, unattended: ${unattended})`
    );
    if (unattended) {
      console.log(
        `NOTE: --unattended bypasses ALL ${agent.label} permission prompts, but inside the sandbox the agent\n` +
          '      works on the ISOLATED CLONE only — the host repo is never bind-mounted or written by the agent.'
      );
    }

    const child = spawn(dockerCommand, { stdio: 'inherit', shell: true, cwd: root });

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
      // On a clean exit, auto mode performs the single deterministic host-repo write; PR mode already
      // pushed + opened the PR against the remote, so sync-back is a no-op.
      if ((code === 0 || code == null) && mergeMode !== 'pr') {
        try {
          syncBackFromClone(root, cloneDir, baseBranch);
        } catch (e) {
          console.error(`Sandbox sync-back error: ${e && e.message ? e.message : e}`);
        }
      }
      process.exitCode = code == null ? 0 : code;
    });
    return;
  }

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
