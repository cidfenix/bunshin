#!/usr/bin/env node
'use strict';

// bunshin CLI entry point.
//   bunshin setup [options]  guided, interactive setup (a Claude Code session)
//   bunshin init  [options]  write a bunshin.config.json into the current repo (no prompts)
//   bunshin run   [options]  launch the Claude Code /loop that drains the queue
//   bunshin watch [options]  serve the multi-repo status dashboard on localhost

const { init } = require('../src/init');
const { setup } = require('../src/setup');
const { run } = require('../src/run');
const { watch } = require('../src/watch');
const { readVersion } = require('../src/util');

function printHelp() {
  console.log(`bunshin — autonomous Jira/Trello goal loop for Claude Code

Usage:
  npx github:cidfenix/bunshin <command> [options]

Commands:
  setup     Guided, interactive setup — opens a Claude Code session that walks you
            through provider, merge strategy, and commands, then checks/installs the
            required MCP servers. (Recommended first run.)
  init      Just write a bunshin.config.json into the current repo (no prompts; the
            driver + agent briefs are served from this package at run time).
  run       Launch the self-paced agent loop (Claude Code /loop by default, or
            codex via agent.kind) that drains the queue.
  watch     Serve a localhost dashboard of every repo running Bunshin on this
            machine (liveness, current gate, current goal). Reads ~/.bunshin/.

setup / init options:
  --orchestrator        Write/target the ORCHESTRATOR config (bunshin.orchestrator.json — one
                        board driving MANY repositories) instead of the single-repo config.
  --dir <path>          Target repo root (default: the current git repo / cwd).
  --name <name>         Project name written into the config.
  --board-id <id>       Trello board id.
  --board-shortlink <s> Trello board short link.
  --board-name <name>   Trello board name (defaults to --name).
  --base-branch <b>     Branch goals merge into (default: main).
  --worktree-dir <p>    Where per-goal worktrees are created (default: ../<repo>-bunshin).
  --force               Overwrite an existing bunshin.config.json.

run options:
  --orchestrator        Run the ORCHESTRATOR config (bunshin.orchestrator.json): one board whose
                        goals span MANY repos; each goal is triaged to its repo before implementing.
  --interval <t>        Re-check cadence for the /loop (default: 20m).
  --once                Process exactly one goal, then stop.
  --unattended          Bypass ALL of the agent CLI's permission prompts (hands-off; use with care).

watch options:
  --port <n>            Port for the dashboard (default: 4317).
  --open                Open the dashboard in your default browser.

Global:
  -h, --help            Show this help.
  -v, --version         Show the version.
`);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once' || a === '--unattended' || a === '--force' || a === '--open' || a === '--orchestrator') {
      opts[a.slice(2)] = true;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    return;
  }
  if (argv.includes('-v') || argv.includes('--version')) {
    console.log(readVersion());
    return;
  }

  const command = argv[0];
  const opts = parseArgs(argv.slice(1));

  switch (command) {
    case 'setup':
      await setup(opts);
      break;
    case 'init':
      await init(opts);
      break;
    case 'run':
      await run(opts);
      break;
    case 'watch':
      watch(opts);
      break;
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
