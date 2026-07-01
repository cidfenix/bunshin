'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG_FILENAME, ORCHESTRATOR_CONFIG_FILENAME, templateDir, gitRoot, exists } = require('./util');

function resolveTargetRoot(opts) {
  if (opts.dir) return path.resolve(opts.dir);
  const root = gitRoot(process.cwd());
  return root || process.cwd();
}

function renderConfig(templatePath, opts, targetRoot) {
  let text = fs.readFileSync(templatePath, 'utf8');
  const repoName = path.basename(targetRoot);
  const replacements = {
    '{{PROJECT_NAME}}': opts.name || repoName,
    '{{BOARD_ID}}': opts['board-id'] || '',
    '{{BOARD_SHORTLINK}}': opts['board-shortlink'] || '',
    '{{BOARD_NAME}}': opts['board-name'] || opts.name || repoName,
    '{{BASE_BRANCH}}': opts['base-branch'] || 'main',
    '{{WORKTREE_BASE_DIR}}': opts['worktree-dir'] || `../${repoName}-bunshin`,
  };
  for (const [token, value] of Object.entries(replacements)) {
    text = text.split(token).join(value);
  }
  return text;
}

// Ensure the config file exists at the repo/home root (write the template if missing,
// or when --force). Returns where it is and whether it was just created. Shared by
// `init` and `setup` (the config-only model: this is the only file in the repo; the
// driver + agent briefs are served from the installed package).
//
// `opts.orchestrator` selects the ORCHESTRATOR config — a distinctly-named
// `bunshin.orchestrator.json` (from bunshin.orchestrator.template.json) that lists MANY
// repositories one board drives. It coexists with a single-repo `bunshin.config.json`.
function ensureConfig(opts = {}) {
  const targetRoot = resolveTargetRoot(opts);
  const orchestrator = Boolean(opts.orchestrator);
  const filename = orchestrator ? ORCHESTRATOR_CONFIG_FILENAME : CONFIG_FILENAME;
  const templateName = orchestrator ? 'bunshin.orchestrator.template.json' : 'bunshin.config.template.json';
  const configPath = path.join(targetRoot, filename);

  if (!exists(path.join(targetRoot, '.git'))) {
    console.warn(`Warning: ${targetRoot} does not look like a git repo root (no .git). Continuing anyway.`);
  }

  let wrote = false;
  if (!exists(configPath) || opts.force) {
    const rendered = renderConfig(path.join(templateDir(), templateName), opts, targetRoot);
    fs.writeFileSync(configPath, rendered);
    wrote = true;
  }
  return { targetRoot, configPath, wrote, orchestrator };
}

async function init(opts) {
  const { targetRoot, wrote, orchestrator } = ensureConfig(opts);
  const filename = orchestrator ? ORCHESTRATOR_CONFIG_FILENAME : CONFIG_FILENAME;
  console.log(wrote ? `wrote   ${filename}` : `kept    ${filename} (already present; pass --force to overwrite)`);
  if (orchestrator) {
    console.log(`\n✅ Bunshin orchestrator config ready.\n`);
    console.log(`Edit ${filename} — list your repositories (id, git remote, local path, optional description`);
    console.log('for triage), pick the provider/board, and keep "triage" first in gates.steps. Then launch:');
    console.log('  npx github:cidfenix/bunshin run --orchestrator');
    console.log('');
    return;
  }
  printNextSteps(targetRoot);
}

function printNextSteps(targetRoot) {
  const hasMcp =
    exists(path.join(targetRoot, '.mcp.json')) ||
    exists(path.join(targetRoot, '.claude', 'settings.json'));

  console.log('\n✅ Bunshin ready.\n');
  console.log('💡 Prefer a guided setup? Run  npx github:cidfenix/bunshin setup  — an interactive Claude');
  console.log('   session walks you through provider, merge strategy, commands, and MCP install.\n');
  console.log('Or configure it by hand:');
  console.log(`  1. Edit ${CONFIG_FILENAME} — set provider.kind (jira | trello; default jira), fill in`);
  console.log('     baseUrl/projectKey (Jira) or the board id (Trello), and your gate / dev-server commands.');
  console.log('  2. Create the queue with four columns (defaults: Pending, In Progress, Blocked, Done —');
  console.log('     or your own names under board.lists / jira.statuses). For PR mode (merge.mode="pr"),');
  console.log('     also add an "In Review" column + set up gh / a GitHub MCP.');
  console.log(`  3. Ensure your tracker MCP (Trello or Jira) + the Playwright MCP are configured${hasMcp ? '' : ' (no .mcp.json / .claude/settings.json found yet)'}.`);
  console.log('  4. Make sure CLAUDE.md describes the project (the agents read it for context).');
  console.log('  5. Commit bunshin.config.json, then launch:  npx github:cidfenix/bunshin run');
  console.log('');
  console.log('The driver + agent briefs are served from the bunshin package — nothing else is');
  console.log('added to your repo. Update the pipeline with:  npm i -g github:cidfenix/bunshin');
  console.log('');
}

module.exports = { init, ensureConfig };
