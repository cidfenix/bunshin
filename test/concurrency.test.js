'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/concurrency.test.js
// Covers the configurable concurrency: resolveConcurrency (config -> how many goals may be IN
// FLIGHT — worktree cut, gates running — at the same time). Absent ⇒ 1 = serial (unchanged
// behavior). Integration stays serial regardless; this only bounds the implement/gates work.
const assert = require('assert');
const { resolveConcurrency } = require('../src/util');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('resolveConcurrency returns 1 when concurrency is absent/null', () => {
  for (const cfg of [undefined, null, {}, { concurrency: undefined }, { concurrency: null }]) {
    assert.strictEqual(resolveConcurrency(cfg), 1);
  }
});

test('a positive integer resolves to itself', () => {
  assert.strictEqual(resolveConcurrency({ concurrency: 1 }), 1);
  assert.strictEqual(resolveConcurrency({ concurrency: 2 }), 2);
  assert.strictEqual(resolveConcurrency({ concurrency: 8 }), 8);
});

test('zero and negative numbers throw referencing concurrency', () => {
  assert.throws(() => resolveConcurrency({ concurrency: 0 }), /concurrency/i);
  assert.throws(() => resolveConcurrency({ concurrency: -1 }), /concurrency/i);
});

test('non-integer numbers throw referencing concurrency', () => {
  assert.throws(() => resolveConcurrency({ concurrency: 1.5 }), /concurrency/i);
  assert.throws(() => resolveConcurrency({ concurrency: NaN }), /concurrency/i);
  assert.throws(() => resolveConcurrency({ concurrency: Infinity }), /concurrency/i);
});

test('non-number values (string/boolean/array/object) throw referencing concurrency', () => {
  assert.throws(() => resolveConcurrency({ concurrency: '2' }), /concurrency/i);
  assert.throws(() => resolveConcurrency({ concurrency: true }), /concurrency/i);
  assert.throws(() => resolveConcurrency({ concurrency: [2] }), /concurrency/i);
  assert.throws(() => resolveConcurrency({ concurrency: { max: 2 } }), /concurrency/i);
});

test('the error names the config file', () => {
  assert.throws(() => resolveConcurrency({ concurrency: '2' }), /bunshin\.config\.json/);
});

console.log(`\nconcurrency.test.js: ${passed} passed`);
