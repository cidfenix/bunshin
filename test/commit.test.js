'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/commit.test.js
// Covers the configurable "commit the work" step (implement gate): resolveCommit (config ->
// how the implement gate commits the goal's changes). Absent/empty ⇒ the built-in default
// (the implement agent's own `git add <paths> && git commit -m "<conventional message>"`); a
// repo can instead point at a custom agent skill/slash-command ({skill: "/commit"}) or a shell
// command ({command: "..."}) that stages + commits their way (still honouring the implement
// gate's scoping / neverCommit / Co-Authored-By invariants). Mirrors test/openpr.test.js.
const assert = require('assert');
const { resolveCommit } = require('../src/util');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('resolveCommit defaults to the built-in git commit when commit is absent/empty', () => {
  for (const cfg of [
    undefined,
    null,
    {},
    { commit: undefined },
    { commit: null },
    { commit: {} },
    // "" is the neutral/disabled value throughout this config (autoMerge.label, commands.install,
    // merge.openPr), so a placeholder block with blank skill/command also resolves to the default.
    { commit: { skill: '', command: '' } },
    { commit: { skill: '   ' } },
  ]) {
    const r = resolveCommit(cfg);
    assert.strictEqual(r.kind, 'default');
    assert.strictEqual(r.value, null);
  }
});

test('a custom skill: {skill: "/commit"} resolves to a skill step', () => {
  const r = resolveCommit({ commit: { skill: '/commit' } });
  assert.strictEqual(r.kind, 'skill');
  assert.strictEqual(r.value, '/commit');
});

test('a custom command: {command: "..."} resolves to a command step', () => {
  const r = resolveCommit({ commit: { command: './scripts/commit.sh' } });
  assert.strictEqual(r.kind, 'command');
  assert.strictEqual(r.value, './scripts/commit.sh');
});

test('the skill/command value is trimmed', () => {
  assert.strictEqual(resolveCommit({ commit: { skill: '  /commit  ' } }).value, '/commit');
  assert.strictEqual(resolveCommit({ commit: { command: '  git commit -m x  ' } }).value, 'git commit -m x');
});

test('specifying BOTH skill and command is ambiguous and throws', () => {
  assert.throws(
    () => resolveCommit({ commit: { skill: '/commit', command: 'x' } }),
    /not both|either.*or/i
  );
});

test('a present but wrong-typed skill/command value throws a clear error naming commit', () => {
  assert.throws(() => resolveCommit({ commit: { skill: 42 } }), /commit\.skill/i);
  assert.throws(() => resolveCommit({ commit: { command: [] } }), /commit\.command/i);
  assert.throws(() => resolveCommit({ commit: { skill: {} } }), /commit\.skill/i);
});

test('a non-object commit (string/array/number) throws referencing commit', () => {
  assert.throws(() => resolveCommit({ commit: '/commit' }), /commit/i);
  assert.throws(() => resolveCommit({ commit: ['/commit'] }), /commit/i);
  assert.throws(() => resolveCommit({ commit: 42 }), /commit/i);
});

console.log(`\ncommit.test.js: ${passed} passed`);
