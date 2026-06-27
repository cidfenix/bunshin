'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/agent.test.js
// Covers the pluggable agent-runtime selector: resolveAgent (kind -> spawn spec)
// and buildLaunchCommand (spec -> the actual CLI invocation string).
const assert = require('assert');
const { resolveAgent, buildLaunchCommand } = require('../src/util');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('resolveAgent defaults to claude when kind is absent/empty (preserves current behavior)', () => {
  for (const k of [undefined, null, '', '   ']) {
    const a = resolveAgent(k);
    assert.strictEqual(a.kind, 'claude');
    assert.strictEqual(a.bin, 'claude');
  }
});

test('resolveAgent matches case- and space-insensitively', () => {
  assert.strictEqual(resolveAgent('CLAUDE').kind, 'claude');
  assert.strictEqual(resolveAgent(' Codex ').kind, 'codex');
  assert.strictEqual(resolveAgent('codex').bin, 'codex');
});

test('resolveAgent carries a human label and a docs url for error messages', () => {
  const claude = resolveAgent('claude');
  assert.ok(claude.label && /claude/i.test(claude.label));
  assert.ok(typeof claude.docsUrl === 'string' && claude.docsUrl.length > 0);
  const codex = resolveAgent('codex');
  assert.ok(codex.label && /codex/i.test(codex.label));
});

test('resolveAgent throws a clear error on an unknown kind', () => {
  assert.throws(() => resolveAgent('gpt5'), /unknown agent/i);
});

test('buildLaunchCommand wraps claude in a /loop carrying the interval', () => {
  const cmd = buildLaunchCommand(resolveAgent('claude'), {
    prompt: 'do the thing',
    interval: '20m',
    unattended: false,
  });
  assert.match(cmd, /^claude /);
  assert.match(cmd, /\/loop 20m do the thing/);
  assert.ok(!cmd.includes('--dangerously-skip-permissions'), 'no bypass flag when attended');
});

test('claude unattended adds --dangerously-skip-permissions', () => {
  const cmd = buildLaunchCommand(resolveAgent('claude'), {
    prompt: 'p',
    interval: '5m',
    unattended: true,
  });
  assert.match(cmd, /--dangerously-skip-permissions/);
});

test('buildLaunchCommand launches codex via `codex exec` with no /loop wrapper', () => {
  const cmd = buildLaunchCommand(resolveAgent('codex'), {
    prompt: 'do the thing',
    interval: '20m',
    unattended: false,
  });
  assert.match(cmd, /^codex exec /);
  assert.ok(!cmd.includes('/loop'), 'codex has no /loop slash command');
  assert.match(cmd, /"do the thing"/);
});

test('codex unattended adds the full-bypass flag', () => {
  const cmd = buildLaunchCommand(resolveAgent('codex'), {
    prompt: 'p',
    interval: '5m',
    unattended: true,
  });
  assert.match(cmd, /--dangerously-bypass-approvals-and-sandbox/);
});

console.log(`\nagent.test.js: ${passed} passed`);
