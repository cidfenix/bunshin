#!/usr/bin/env node
'use strict';

// bunshin CLI entry point.
//   bunshin init [options]   write a bunshin.config.json into the current repo
//   bunshin run  [options]   launch the Claude Code /loop that drains the board

const { init } = require('../src/init');
const { run } = require('../src/run');
const { readVersion } = require('../src/util');

function printHelp() {
  console.log(`bunshin — autonomous Trello-driven goal loop for Claude Code

Usage:
  npx bunshin <command> [options]

Commands:
  init      Write a bunshin.config.json into the current repo (the only per-repo file;
            the driver + agent briefs are served from this package at run time).
  run       Launch the self-paced Claude Code /loop that drains the board.

init options:
  --dir <path>          Target repo root (default: the current git repo / cwd).
  --name <name>         Project name written into the config.
  --board-id <id>       Trello board id.
  --board-shortlink <s> Trello board short link.
  --board-name <name>   Trello board name (defaults to --name).
  --base-branch <b>     Branch goals merge into (default: main).
  --worktree-dir <p>    Where per-goal worktrees are created (default: ../<repo>-bunshin).
  --force               Overwrite an existing bunshin.config.json.

run options:
  --interval <t>        Re-check cadence for the /loop (default: 20m).
  --once                Process exactly one goal, then stop.
  --unattended          Pass --dangerously-skip-permissions to Claude Code (hands-off; use with care).

Global:
  -h, --help            Show this help.
  -v, --version         Show the version.
`);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once' || a === '--unattended' || a === '--force') {
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
    case 'init':
      await init(opts);
      break;
    case 'run':
      await run(opts);
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
