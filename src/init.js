'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG_FILENAME, templateDir, gitRoot, exists } = require('./util');

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

// Config-only model: the only thing a consuming repo owns is bunshin.config.json at
// its root. The driver + agent briefs are served from the installed package at run
// time (see `bunshin run`), so there are no generic pipeline files to scaffold.
async function init(opts) {
  const targetRoot = resolveTargetRoot(opts);
  const configDest = path.join(targetRoot, CONFIG_FILENAME);

  if (!exists(path.join(targetRoot, '.git'))) {
    console.warn(`Warning: ${targetRoot} does not look like a git repo root (no .git). Continuing anyway.`);
  }

  if (exists(configDest) && !opts.force) {
    console.log(`kept    ${CONFIG_FILENAME} (already present; pass --force to overwrite)`);
  } else {
    const rendered = renderConfig(path.join(templateDir(), 'bunshin.config.template.json'), opts, targetRoot);
    fs.writeFileSync(configDest, rendered);
    console.log(`wrote   ${CONFIG_FILENAME}`);
  }

  printNextSteps(targetRoot);
}

function printNextSteps(targetRoot) {
  const hasMcp =
    exists(path.join(targetRoot, '.mcp.json')) ||
    exists(path.join(targetRoot, '.claude', 'settings.json'));

  console.log('\n✅ Bunshin ready.\n');
  console.log('Next steps:');
  console.log(`  1. Edit ${CONFIG_FILENAME} — set provider.kind (jira | trello; default jira), fill in`);
  console.log('     baseUrl/projectKey (Jira) or the board id (Trello), and your gate / dev-server commands.');
  console.log('  2. Create the queue with four columns (defaults: Pending, In Progress, Blocked, Done —');
  console.log('     or your own names under board.lists / jira.statuses). For PR mode (merge.mode="pr"),');
  console.log('     also add an "In Review" column + set up gh / a GitHub MCP.');
  console.log(`  3. Ensure your tracker MCP (Trello or Jira) + the Playwright MCP are configured${hasMcp ? '' : ' (no .mcp.json / .claude/settings.json found yet)'}.`);
  console.log('  4. Make sure CLAUDE.md describes the project (the agents read it for context).');
  console.log('  5. Commit bunshin.config.json, then launch:  npx bunshin run');
  console.log('');
  console.log('The driver + agent briefs are served from the bunshin package — nothing else is');
  console.log('added to your repo. Update the pipeline with:  npm i -g github:cidfenix/bunshin');
  console.log('');
}

module.exports = { init };
