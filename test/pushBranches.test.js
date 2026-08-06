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

console.log(`\npushBranches.test.js: ${passed} passed`);
