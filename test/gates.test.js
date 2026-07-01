'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/gates.test.js
// Covers the configurable gate pipeline: resolveGates (config -> ordered, normalized
// list of gate steps). Absent config ⇒ the built-in default implement→verify→review;
// a repo can reorder, drop the web-only verify gate, or mix in custom command/skill steps.
const assert = require('assert');
const { resolveGates, BUILTIN_GATES, DEFAULT_GATE_STEPS } = require('../src/util');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('resolveGates defaults to implement→verify→review when gates is absent', () => {
  for (const cfg of [undefined, null, {}, { gates: undefined }, { gates: {} }, { gates: { steps: null } }]) {
    const steps = resolveGates(cfg);
    assert.deepStrictEqual(steps.map((s) => s.gate), ['implement', 'verify', 'review']);
    assert.ok(steps.every((s) => s.type === 'builtin'));
  }
});

test('an empty steps array falls back to the default (a no-gate pipeline is degenerate)', () => {
  const steps = resolveGates({ gates: { steps: [] } });
  assert.deepStrictEqual(steps.map((s) => s.name), DEFAULT_GATE_STEPS.slice());
});

test('exposes the built-in gate names and the default order', () => {
  assert.deepStrictEqual(BUILTIN_GATES.slice(), ['implement', 'verify', 'review']);
  assert.deepStrictEqual(DEFAULT_GATE_STEPS.slice(), ['implement', 'verify', 'review']);
});

test('config-only repos can drop the web-only verify gate', () => {
  const steps = resolveGates({ gates: { steps: ['implement', 'review'] } });
  assert.deepStrictEqual(steps.map((s) => s.gate), ['implement', 'review']);
  assert.ok(!steps.some((s) => s.gate === 'verify'), 'verify omitted');
});

test('built-in gate names are matched case- and space-insensitively', () => {
  const steps = resolveGates({ gates: { steps: [' Implement ', 'REVIEW'] } });
  assert.deepStrictEqual(steps.map((s) => s.gate), ['implement', 'review']);
});

test('gates can be reordered freely', () => {
  const steps = resolveGates({ gates: { steps: ['review', 'implement', 'verify'] } });
  assert.deepStrictEqual(steps.map((s) => s.gate), ['review', 'implement', 'verify']);
});

test('object form for a built-in gate ({gate: ...}) carries an optional display name', () => {
  const steps = resolveGates({ gates: { steps: [{ gate: 'implement', name: 'Code it' }, 'review'] } });
  assert.strictEqual(steps[0].type, 'builtin');
  assert.strictEqual(steps[0].gate, 'implement');
  assert.strictEqual(steps[0].name, 'Code it');
});

test('custom command step: {command: ...} runs a shell command in the worktree', () => {
  const steps = resolveGates({ gates: { steps: ['implement', { command: './gradlew assembleDebug', name: 'Android build' }] } });
  assert.strictEqual(steps[1].type, 'command');
  assert.strictEqual(steps[1].command, './gradlew assembleDebug');
  assert.strictEqual(steps[1].name, 'Android build');
});

test('custom command step defaults its name to the command when name is omitted', () => {
  const steps = resolveGates({ gates: { steps: [{ command: 'npm run lint' }] } });
  assert.strictEqual(steps[0].name, 'npm run lint');
});

test('custom skill step: {skill: ...} invokes an agent skill / slash command', () => {
  const steps = resolveGates({ gates: { steps: [{ skill: 'security-review' }] } });
  assert.strictEqual(steps[0].type, 'skill');
  assert.strictEqual(steps[0].skill, 'security-review');
  assert.strictEqual(steps[0].name, 'security-review');
});

test('an unknown built-in gate name throws a clear error naming the valid gates', () => {
  assert.throws(() => resolveGates({ gates: { steps: ['implement', 'deploy'] } }), /unknown built-in gate/i);
  assert.throws(() => resolveGates({ gates: { steps: [{ gate: 'nope' }] } }), /unknown built-in gate/i);
});

test('an object step with none of gate/command/skill throws', () => {
  assert.throws(() => resolveGates({ gates: { steps: [{ name: 'x' }] } }), /gate.*command.*skill|command.*skill/i);
});

test('a non-string, non-object step throws', () => {
  assert.throws(() => resolveGates({ gates: { steps: [42] } }), /invalid gate step/i);
});

console.log(`\ngates.test.js: ${passed} passed`);
