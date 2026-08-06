'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/pushBranches.test.js
// Covers git.pushBranches: resolvePushBranches (config -> whether the driver pushes each goal
// branch to merge.remote after every commit / at park / at auto-retry). Absent ⇒ true.
// Best-effort at the call site (no remote / a failed push never parks a goal) — this resolver
// only validates the boolean.
const assert = require('assert');
const { resolvePushBranches } = require('../src/util');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('resolvePushBranches returns true when git.pushBranches is absent/null', () => {
  for (const cfg of [
    undefined,
    null,
    {},
    { git: {} },
    { git: { pushBranches: undefined } },
    { git: { pushBranches: null } },
  ]) {
    assert.strictEqual(resolvePushBranches(cfg), true);
  }
});

test('an explicit boolean passes through', () => {
  assert.strictEqual(resolvePushBranches({ git: { pushBranches: true } }), true);
  assert.strictEqual(resolvePushBranches({ git: { pushBranches: false } }), false);
});

test('non-boolean values throw referencing git.pushBranches', () => {
  assert.throws(() => resolvePushBranches({ git: { pushBranches: 'true' } }), /git\.pushBranches/);
  assert.throws(() => resolvePushBranches({ git: { pushBranches: 1 } }), /git\.pushBranches/);
  assert.throws(() => resolvePushBranches({ git: { pushBranches: [] } }), /git\.pushBranches/);
  assert.throws(() => resolvePushBranches({ git: { pushBranches: {} } }), /git\.pushBranches/);
});

test('the error names the config file', () => {
  assert.throws(() => resolvePushBranches({ git: { pushBranches: 'true' } }), /bunshin\.config\.json/);
});

test('it is independent of merge.autoPush (base-branch push, a different knob)', () => {
  assert.strictEqual(resolvePushBranches({ git: { pushBranches: false }, merge: { autoPush: true } }), false);
  assert.strictEqual(resolvePushBranches({ git: { pushBranches: true }, merge: { autoPush: false } }), true);
});

// --- Shipped-artifact guards --------------------------------------------------
// The resolver and the artifacts consumers actually receive must not drift apart.
const fs = require('fs');
const path = require('path');
const repoRoot = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

test('both config templates ship git.pushBranches: true with a note', () => {
  for (const rel of [
    'template/bunshin.config.template.json',
    'template/bunshin.orchestrator.template.json',
  ]) {
    const cfg = readJson(rel);
    assert.strictEqual(cfg.git.pushBranches, true, `${rel} must ship git.pushBranches: true`);
    assert.ok(
      typeof cfg.git.pushBranchesNote === 'string' && cfg.git.pushBranchesNote.length > 40,
      `${rel} must explain git.pushBranches in a pushBranchesNote`
    );
    assert.strictEqual(resolvePushBranches(cfg), true, `${rel}'s shipped value must resolve`);
  }
});

test('driver.md documents every git.pushBranches behaviour', () => {
  const driver = read('template/driver.md');
  assert.ok(driver.includes('git.pushBranches'), 'driver.md must name the git.pushBranches key');
  assert.ok(
    /--force-with-lease/.test(driver),
    'driver.md must force-with-lease the PR-mode branch push (the rebase rewrites pushed shas)'
  );
  assert.ok(
    /push\s+<merge\.remote>\s+--delete/.test(driver),
    'driver.md must delete the remote goal branch after an auto-mode merge'
  );
  assert.ok(
    /pushed to <merge\.remote>/.test(driver),
    'driver.md must name the pushed ref in the park comment so a second machine can resume'
  );
  assert.ok(
    /git fetch <merge\.remote> <git\.branchPrefix><N>-<slug>/.test(driver),
    'driver.md step 4 must be able to resume a goal from the remote branch'
  );
});

console.log(`\npushBranches.test.js: ${passed} passed`);
