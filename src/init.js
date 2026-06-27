'use strict';

const fs = require('fs');
const path = require('path');
const {
  AUTOPILOT_SUBDIR,
  templateDir,
  gitRoot,
  exists,
  ensureDir,
  copyFile,
  copyDir,
} = require('./util');

// Files copied verbatim from the package template (generic; read every repo-specific
// value from autopilot.config.json). The config itself is handled separately.
const GENERIC_FILES = ['driver.md', 'README.md'];

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
    '{{WORKTREE_BASE_DIR}}': opts['worktree-dir'] || `../${repoName}-autopilot`,
  };
  for (const [token, value] of Object.entries(replacements)) {
    text = text.split(token).join(value);
  }
  return text;
}

async function init(opts) {
  const tpl = templateDir();
  const targetRoot = resolveTargetRoot(opts);
  const destDir = path.join(targetRoot, AUTOPILOT_SUBDIR);

  if (!exists(path.join(targetRoot, '.git'))) {
    console.warn(`Warning: ${targetRoot} does not look like a git repo root (no .git). Continuing anyway.`);
  }

  ensureDir(destDir);

  // Generic markdown — overwrite on --force/--upgrade, otherwise keep existing.
  const overwriteGeneric = Boolean(opts.force || opts.upgrade);
  for (const f of GENERIC_FILES) {
    const wrote = copyFile(path.join(tpl, f), path.join(destDir, f), overwriteGeneric);
    console.log(`${wrote ? 'wrote' : 'kept'}   ${path.join(AUTOPILOT_SUBDIR, f)}`);
  }
  copyDir(path.join(tpl, 'agents'), path.join(destDir, 'agents'), overwriteGeneric);
  console.log(`${overwriteGeneric ? 'wrote' : 'ensured'} ${path.join(AUTOPILOT_SUBDIR, 'agents')}/ (implement.md, verify.md, review.md)`);

  // Artifacts dir with a .gitkeep so it survives a fresh clone.
  const artifacts = path.join(destDir, 'artifacts');
  ensureDir(artifacts);
  const gitkeep = path.join(artifacts, '.gitkeep');
  if (!exists(gitkeep)) fs.writeFileSync(gitkeep, '');
  console.log(`ensured ${path.join(AUTOPILOT_SUBDIR, 'artifacts')}/`);

  // Config — never clobbered unless --force. --upgrade explicitly preserves it.
  const configDest = path.join(destDir, 'autopilot.config.json');
  if (exists(configDest) && !opts.force) {
    console.log(`kept    ${path.join(AUTOPILOT_SUBDIR, 'autopilot.config.json')} (already present; pass --force to overwrite)`);
  } else if (opts.upgrade) {
    console.log(`kept    ${path.join(AUTOPILOT_SUBDIR, 'autopilot.config.json')} (--upgrade preserves the config)`);
  } else {
    const rendered = renderConfig(path.join(tpl, 'autopilot.config.template.json'), opts, targetRoot);
    fs.writeFileSync(configDest, rendered);
    console.log(`wrote   ${path.join(AUTOPILOT_SUBDIR, 'autopilot.config.json')}`);
  }

  printNextSteps(targetRoot, opts);
}

function printNextSteps(targetRoot, opts) {
  const hasMcp =
    exists(path.join(targetRoot, '.mcp.json')) ||
    exists(path.join(targetRoot, '.claude', 'settings.json'));

  console.log('\n✅ Autopilot scaffolded.\n');
  if (opts.upgrade) {
    console.log('Generic files refreshed; your autopilot.config.json was left untouched.\n');
    return;
  }
  console.log('Next steps:');
  console.log(`  1. Edit ${path.join(AUTOPILOT_SUBDIR, 'autopilot.config.json')} — fill in the Trello board id`);
  console.log('     and the project\'s install / gate / dev-server commands.');
  console.log('  2. Create a Trello board with lists: Pending, In Progress, Blocked, Done.');
  console.log(`  3. Ensure the Trello + Playwright MCP servers are configured for this project${hasMcp ? '' : ' (no .mcp.json / .claude/settings.json found yet)'}.`);
  console.log('  4. Make sure CLAUDE.md describes the project (the agents read it for context).');
  console.log('  5. Launch:  npx claude-autopilot run');
  console.log('');
}

module.exports = { init };
