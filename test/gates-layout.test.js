'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/gates-layout.test.js
// Guards the STRUCTURE of the built-in gate presets: each preset is a self-contained
// file under template/gates/ (one per BUILTIN_GATES name), the old template/agents/
// folder is gone, and no live file (driver + src + template config) still points at a
// stale `agents/<role>.md` path. A layout guard so the folder can't silently rot.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { BUILTIN_GATES } = require('../src/util');

const repoRoot = path.join(__dirname, '..');
const gatesDir = path.join(repoRoot, 'template', 'gates');
const agentsDir = path.join(repoRoot, 'template', 'agents');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

test('every built-in gate has a self-contained preset file under template/gates/', () => {
  assert.ok(exists(gatesDir), 'template/gates/ folder must exist');
  for (const name of BUILTIN_GATES) {
    const file = path.join(gatesDir, `${name}.md`);
    assert.ok(exists(file), `missing preset file template/gates/${name}.md for built-in gate "${name}"`);
    assert.ok(fs.readFileSync(file, 'utf8').trim().length > 0, `template/gates/${name}.md must not be empty`);
  }
});

test('the old template/agents/ folder no longer exists (presets moved to template/gates/)', () => {
  assert.ok(!exists(agentsDir), 'template/agents/ should have been moved to template/gates/');
});

test('the driver references the presets from gates/, never from agents/', () => {
  const driver = read('template/driver.md');
  assert.ok(!/agents\//.test(driver), 'driver.md must not reference any agents/ path (use gates/)');
  for (const name of ['implement', 'verify', 'review', 'triage']) {
    assert.ok(driver.includes(`gates/${name}.md`), `driver.md must reference gates/${name}.md`);
  }
});

test('no live source/template file carries a stale agents/<role>.md path', () => {
  for (const rel of [
    'src/run.js',
    'src/util.js',
    'template/driver.md',
    'template/bunshin.config.template.json',
    'template/bunshin.orchestrator.template.json',
  ]) {
    assert.ok(!/agents\/(implement|verify|review|triage)/.test(read(rel)), `${rel} must not reference agents/<role>`);
  }
});

console.log(`\ngates-layout.test.js: ${passed} passed`);
