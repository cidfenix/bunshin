'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  CONFIG_FILENAME,
  templateDir,
  hasExecutable,
  resolveAgent,
  buildSetupCommand,
} = require('./util');
const { ensureConfig } = require('./init');

// Read agent.kind from the repo config (best-effort; absent ⇒ claude).
function readAgentKind(configPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return (cfg.agent && cfg.agent.kind) || 'claude';
  } catch {
    return 'claude';
  }
}

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
  const { targetRoot, configPath, wrote } = ensureConfig(opts);

  // Pluggable agent runtime: Claude Code (default) or codex, per agent.kind in the config.
  const agent = resolveAgent(readAgentKind(configPath));

  if (!hasExecutable(agent.bin)) {
    throw new Error(
      `The "${agent.bin}" CLI was not found on PATH. Install ${agent.label} and ensure \`${agent.bin}\` is runnable,\n` +
        `then re-run. See ${agent.docsUrl}`
    );
  }

  console.log(
    `${wrote ? `Created ${CONFIG_FILENAME}. ` : `${CONFIG_FILENAME} found. `}Launching ${agent.label} to guide you through setup...\n`
  );

  // Plain interactive session (NOT a /loop) — the user answers questions as it goes.
  const prompt = buildSetupPrompt(packageSetupPath());
  const command = buildSetupCommand(agent, prompt);
  const child = spawn(command, { stdio: 'inherit', shell: true, cwd: targetRoot });
  child.on('exit', (code) => {
    process.exitCode = code == null ? 0 : code;
  });
}

module.exports = { setup, buildSetupPrompt };
