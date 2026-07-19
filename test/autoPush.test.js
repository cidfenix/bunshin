'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/autoPush.test.js
// Covers merge.autoPush (auto mode only): resolveAutoPush (config -> whether to push
// git.baseBranch to merge.remote after each local auto-mode merge). Absent ⇒ true.
const assert = require('assert');
const { resolveAutoPush } = require('../src/util');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('resolveAutoPush returns true when merge.autoPush is absent/null', () => {
  for (const cfg of [undefined, null, {}, { merge: {} }, { merge: { autoPush: undefined } }, { merge: { autoPush: null } }]) {
    assert.strictEqual(resolveAutoPush(cfg), true);
  }
});

test('an explicit boolean passes through', () => {
  assert.strictEqual(resolveAutoPush({ merge: { autoPush: true } }), true);
  assert.strictEqual(resolveAutoPush({ merge: { autoPush: false } }), false);
});

test('non-boolean values throw referencing merge.autoPush', () => {
  assert.throws(() => resolveAutoPush({ merge: { autoPush: 'true' } }), /merge\.autoPush/);
  assert.throws(() => resolveAutoPush({ merge: { autoPush: 1 } }), /merge\.autoPush/);
  assert.throws(() => resolveAutoPush({ merge: { autoPush: [] } }), /merge\.autoPush/);
  assert.throws(() => resolveAutoPush({ merge: { autoPush: {} } }), /merge\.autoPush/);
});

test('the error names the config file', () => {
  assert.throws(() => resolveAutoPush({ merge: { autoPush: 'true' } }), /bunshin\.config\.json/);
});

console.log(`\nautoPush.test.js: ${passed} passed`);
