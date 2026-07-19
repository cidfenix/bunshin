'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/contextCleanup.test.js
// Covers the configurable driver context cleanup: resolveContextCleanup (config -> how many
// COMPLETED goals pass between /compact calls in the driver's Claude Code /loop session).
// Absent ⇒ 5. 0 ⇒ disabled. Claude Code only (codex exec restarts fresh per invocation).
const assert = require('assert');
const { resolveContextCleanup } = require('../src/util');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('resolveContextCleanup returns 5 when contextCleanupEvery is absent/null', () => {
  for (const cfg of [undefined, null, {}, { contextCleanupEvery: undefined }, { contextCleanupEvery: null }]) {
    assert.strictEqual(resolveContextCleanup(cfg), 5);
  }
});

test('zero is valid (disabled)', () => {
  assert.strictEqual(resolveContextCleanup({ contextCleanupEvery: 0 }), 0);
});

test('a positive integer resolves to itself', () => {
  assert.strictEqual(resolveContextCleanup({ contextCleanupEvery: 1 }), 1);
  assert.strictEqual(resolveContextCleanup({ contextCleanupEvery: 10 }), 10);
});

test('negative numbers throw referencing contextCleanupEvery', () => {
  assert.throws(() => resolveContextCleanup({ contextCleanupEvery: -1 }), /contextCleanupEvery/i);
});

test('non-integer numbers throw referencing contextCleanupEvery', () => {
  assert.throws(() => resolveContextCleanup({ contextCleanupEvery: 1.5 }), /contextCleanupEvery/i);
  assert.throws(() => resolveContextCleanup({ contextCleanupEvery: NaN }), /contextCleanupEvery/i);
  assert.throws(() => resolveContextCleanup({ contextCleanupEvery: Infinity }), /contextCleanupEvery/i);
});

test('non-number values (string/boolean/array/object) throw referencing contextCleanupEvery', () => {
  assert.throws(() => resolveContextCleanup({ contextCleanupEvery: '5' }), /contextCleanupEvery/i);
  assert.throws(() => resolveContextCleanup({ contextCleanupEvery: true }), /contextCleanupEvery/i);
  assert.throws(() => resolveContextCleanup({ contextCleanupEvery: [5] }), /contextCleanupEvery/i);
  assert.throws(() => resolveContextCleanup({ contextCleanupEvery: { max: 5 } }), /contextCleanupEvery/i);
});

test('the error names the config file', () => {
  assert.throws(() => resolveContextCleanup({ contextCleanupEvery: '5' }), /bunshin\.config\.json/);
});

console.log(`\ncontextCleanup.test.js: ${passed} passed`);
