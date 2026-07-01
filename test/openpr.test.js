'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/openpr.test.js
// Covers the configurable "open a PR" step (PR mode): resolveOpenPr (config -> how the
// driver opens the PR). Absent/empty ⇒ the built-in default (`gh pr create --fill`); a repo
// can instead point at a custom agent skill/slash-command ({skill: "/open-pr"}) or a shell
// command ({command: "..."}) that applies their PR template and prints the PR URL.
const assert = require('assert');
const { resolveOpenPr } = require('../src/util');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('resolveOpenPr defaults to the built-in gh pr create when merge.openPr is absent/empty', () => {
  for (const cfg of [
    undefined,
    null,
    {},
    { merge: undefined },
    { merge: {} },
    { merge: { openPr: null } },
    { merge: { openPr: {} } },
    // "" is the neutral/disabled value throughout this config (autoMerge.label, commands.install),
    // so a placeholder block with blank skill/command also resolves to the built-in default.
    { merge: { openPr: { skill: '', command: '' } } },
    { merge: { openPr: { skill: '   ' } } },
  ]) {
    const r = resolveOpenPr(cfg);
    assert.strictEqual(r.kind, 'default');
    assert.strictEqual(r.value, null);
  }
});

test('a custom skill: {skill: "/open-pr"} resolves to a skill step', () => {
  const r = resolveOpenPr({ merge: { openPr: { skill: '/open-pr' } } });
  assert.strictEqual(r.kind, 'skill');
  assert.strictEqual(r.value, '/open-pr');
});

test('a custom command: {command: "..."} resolves to a command step', () => {
  const r = resolveOpenPr({ merge: { openPr: { command: './scripts/open-pr.sh' } } });
  assert.strictEqual(r.kind, 'command');
  assert.strictEqual(r.value, './scripts/open-pr.sh');
});

test('the skill/command value is trimmed', () => {
  assert.strictEqual(resolveOpenPr({ merge: { openPr: { skill: '  /open-pr  ' } } }).value, '/open-pr');
  assert.strictEqual(resolveOpenPr({ merge: { openPr: { command: '  gh pr create --fill  ' } } }).value, 'gh pr create --fill');
});

test('specifying BOTH skill and command is ambiguous and throws', () => {
  assert.throws(
    () => resolveOpenPr({ merge: { openPr: { skill: '/open-pr', command: 'x' } } }),
    /not both|either.*or/i
  );
});

test('a present but wrong-typed skill/command value throws a clear error', () => {
  assert.throws(() => resolveOpenPr({ merge: { openPr: { skill: 42 } } }), /openPr\.skill/i);
  assert.throws(() => resolveOpenPr({ merge: { openPr: { command: [] } } }), /openPr\.command/i);
  assert.throws(() => resolveOpenPr({ merge: { openPr: { skill: {} } } }), /openPr\.skill/i);
});

test('a non-object openPr (string/array/number) throws', () => {
  assert.throws(() => resolveOpenPr({ merge: { openPr: '/open-pr' } }), /openPr/i);
  assert.throws(() => resolveOpenPr({ merge: { openPr: ['/open-pr'] } }), /openPr/i);
  assert.throws(() => resolveOpenPr({ merge: { openPr: 42 } }), /openPr/i);
});

console.log(`\nopenpr.test.js: ${passed} passed`);
