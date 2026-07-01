'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/prlabels.test.js
// Covers the configurable PR labels (PR mode): resolvePrLabels (config -> the list of labels
// Bunshin stamps onto every PR it opens, so humans can FILTER OUT agent-created PRs). This is a
// STAMP, distinct from merge.autoMerge.label (a merge GATE the reaper requires). Absent/empty ⇒ []
// (no labels added — unchanged behavior).
const assert = require('assert');
const { resolvePrLabels } = require('../src/util');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('resolvePrLabels returns [] when merge.prLabels is absent/null/empty', () => {
  for (const cfg of [
    undefined,
    null,
    {},
    { merge: undefined },
    { merge: {} },
    { merge: { prLabels: null } },
    { merge: { prLabels: [] } },
    // Blank / whitespace-only entries are dropped, so an all-blank array is also [].
    { merge: { prLabels: ['', '   '] } },
  ]) {
    const r = resolvePrLabels(cfg);
    assert.deepStrictEqual(r, []);
  }
});

test('a list of labels resolves to a normalized string[]', () => {
  const r = resolvePrLabels({ merge: { prLabels: ['bunshin', 'automated'] } });
  assert.deepStrictEqual(r, ['bunshin', 'automated']);
});

test('labels are trimmed', () => {
  const r = resolvePrLabels({ merge: { prLabels: ['  bunshin  ', ' automated'] } });
  assert.deepStrictEqual(r, ['bunshin', 'automated']);
});

test('blank/whitespace entries are dropped', () => {
  const r = resolvePrLabels({ merge: { prLabels: ['bunshin', '', '   ', 'automated'] } });
  assert.deepStrictEqual(r, ['bunshin', 'automated']);
});

test('duplicate labels are de-duped (after trimming), keeping first order', () => {
  const r = resolvePrLabels({ merge: { prLabels: ['bunshin', 'automated', ' bunshin ', 'automated'] } });
  assert.deepStrictEqual(r, ['bunshin', 'automated']);
});

test('a non-array prLabels (string/object/number) throws referencing merge.prLabels', () => {
  assert.throws(() => resolvePrLabels({ merge: { prLabels: 'bunshin' } }), /merge\.prLabels/i);
  assert.throws(() => resolvePrLabels({ merge: { prLabels: { 0: 'bunshin' } } }), /merge\.prLabels/i);
  assert.throws(() => resolvePrLabels({ merge: { prLabels: 42 } }), /merge\.prLabels/i);
});

test('a non-string entry throws referencing merge.prLabels', () => {
  assert.throws(() => resolvePrLabels({ merge: { prLabels: ['bunshin', 42] } }), /merge\.prLabels/i);
  assert.throws(() => resolvePrLabels({ merge: { prLabels: ['bunshin', null] } }), /merge\.prLabels/i);
  assert.throws(() => resolvePrLabels({ merge: { prLabels: [['bunshin']] } }), /merge\.prLabels/i);
});

console.log(`\nprlabels.test.js: ${passed} passed`);
