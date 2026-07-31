'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/unblock.test.js
// Covers auto-unblock config resolution: resolveUnblock (top-level `unblock` ->
// { auto, maxRetries }). Absent block/keys => { auto: true, maxRetries: 5 } — auto-unblock is ON
// by default. auto: false restores park-everything; maxRetries: 0 = classify but never retry.
const assert = require('assert');
const { resolveUnblock } = require('../src/util');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('defaults to { auto: true, maxRetries: 5 } when unblock is absent', () => {
  for (const cfg of [undefined, null, {}, { unblock: undefined }, { unblock: null }, { unblock: {} }]) {
    assert.deepStrictEqual(resolveUnblock(cfg), { auto: true, maxRetries: 5 });
  }
});

test('auto: false is honored (maxRetries still defaults)', () => {
  assert.deepStrictEqual(resolveUnblock({ unblock: { auto: false } }), { auto: false, maxRetries: 5 });
});

test('explicit maxRetries values resolve, including 0', () => {
  assert.deepStrictEqual(resolveUnblock({ unblock: { maxRetries: 0 } }), { auto: true, maxRetries: 0 });
  assert.deepStrictEqual(resolveUnblock({ unblock: { maxRetries: 3 } }), { auto: true, maxRetries: 3 });
  assert.deepStrictEqual(resolveUnblock({ unblock: { auto: false, maxRetries: 9 } }), { auto: false, maxRetries: 9 });
});

test('a non-object unblock block throws referencing unblock', () => {
  for (const bad of ['yes', 5, true, [1]]) {
    assert.throws(() => resolveUnblock({ unblock: bad }), /unblock/i);
  }
});

test('non-boolean auto throws referencing unblock.auto', () => {
  for (const bad of ['true', 1, [], {}]) {
    assert.throws(() => resolveUnblock({ unblock: { auto: bad } }), /unblock\.auto/);
  }
});

test('non-integer or negative maxRetries throws referencing unblock.maxRetries', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, '5', true, [5]]) {
    assert.throws(() => resolveUnblock({ unblock: { maxRetries: bad } }), /unblock\.maxRetries/);
  }
});

test('errors name the config file', () => {
  assert.throws(() => resolveUnblock({ unblock: { auto: 'x' } }), /bunshin\.config\.json/);
  assert.throws(() => resolveUnblock({ unblock: { maxRetries: -1 } }), /bunshin\.config\.json/);
});

console.log(`\nunblock.test.js: ${passed} passed`);
