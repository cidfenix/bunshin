'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { CONFIG_FILENAME, templateDir, hasExecutable } = require('./util');
const { ensureConfig } = require('./init');

function packageSetupPath() {
  return path.join(templateDir(), 'setup.md');
}

// The setup guide is read by an INTERACTIVE Claude Code session (unlike the autonomous
// driver, it asks the user questions). We hand Claude the absolute path to the package's
// setup.md and the repo's config file to fill in.
function buildSetupPrompt(guidePath) {
  const guide = guidePath.split(/[\\/]/).join('/');
  return (
    `Help me set up Bunshin in this repository. Read the Bunshin setup guide at ${guide} and walk me ` +
    `through it INTERACTIVELY: configure ${CONFIG_FILENAME} at the repo root (choose my tracker — Jira ` +
    `or Trello — its connection details, my merge strategy, and my toolchain commands), then check and ` +
    `(with my approval) install the required MCP servers. Ask me each decision; don't assume defaults ` +
    `without confirming.`
  );
}

async function setup(opts) {
  const { targetRoot, wrote } = ensureConfig(opts);

  if (!hasExecutable('claude')) {
    throw new Error(
      'The "claude" CLI was not found on PATH. Install Claude Code and ensure `claude` is runnable,\n' +
        'then re-run. See https://docs.claude.com/claude-code'
    );
  }

  console.log(
    `${wrote ? `Created ${CONFIG_FILENAME}. ` : `${CONFIG_FILENAME} found. `}Launching Claude Code to guide you through setup...\n`
  );

  // Plain interactive session (NOT a /loop) — the user answers questions as it goes.
  const prompt = buildSetupPrompt(packageSetupPath());
  const command = `claude "${prompt.replace(/"/g, '\\"')}"`;
  const child = spawn(command, { stdio: 'inherit', shell: true, cwd: targetRoot });
  child.on('exit', (code) => {
    process.exitCode = code == null ? 0 : code;
  });
}

module.exports = { setup, buildSetupPrompt };
