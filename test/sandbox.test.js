'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/sandbox.test.js
// Covers the OPT-IN sandboxed run (BUN-16): the pure resolvers/builders in src/sandbox.js.
// `resolveSandbox` normalizes the optional top-level `sandbox` config block; `buildDockerCommand`
// wraps the agent command in a `docker run …` string that runs the agent against an isolated clone.
// Everything here is PURE (no spawn, no Docker daemon) so it runs anywhere, exactly like the other
// resolve*/build* unit tests. Docker itself (dockerAvailable, the actual run) is NOT tested here.
const assert = require('assert');
const { resolveSandbox, buildDockerCommand } = require('../src/sandbox');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// --- resolveSandbox: defaults --------------------------------------------------
test('resolveSandbox returns the documented defaults when the block is absent/empty', () => {
  for (const cfg of [undefined, null, {}, { sandbox: undefined }, { sandbox: null }, { sandbox: {} }]) {
    const r = resolveSandbox(cfg);
    assert.strictEqual(r.image, null);
    assert.strictEqual(r.dockerfile, '');
    assert.strictEqual(r.network, 'none');
    assert.deepStrictEqual(r.env, []);
    assert.deepStrictEqual(r.mounts, []);
  }
});

// --- resolveSandbox: image -----------------------------------------------------
test('image set ⇒ passthrough; unset/blank ⇒ null', () => {
  assert.strictEqual(resolveSandbox({ sandbox: { image: 'my-image:1' } }).image, 'my-image:1');
  assert.strictEqual(resolveSandbox({ sandbox: { image: '  my-image:1  ' } }).image, 'my-image:1');
  assert.strictEqual(resolveSandbox({ sandbox: { image: '' } }).image, null);
  assert.strictEqual(resolveSandbox({ sandbox: { image: '   ' } }).image, null);
});

// --- resolveSandbox: network ---------------------------------------------------
test('network: blank ⇒ "none"; a value passes through; non-string throws /sandbox.network/', () => {
  assert.strictEqual(resolveSandbox({ sandbox: { network: '' } }).network, 'none');
  assert.strictEqual(resolveSandbox({ sandbox: { network: '   ' } }).network, 'none');
  assert.strictEqual(resolveSandbox({ sandbox: { network: 'default' } }).network, 'default');
  assert.strictEqual(resolveSandbox({ sandbox: { network: '  my-net  ' } }).network, 'my-net');
  assert.throws(() => resolveSandbox({ sandbox: { network: 42 } }), /sandbox\.network/i);
  assert.throws(() => resolveSandbox({ sandbox: { network: [] } }), /sandbox\.network/i);
});

// --- resolveSandbox: env (mirrors resolvePrLabels) -----------------------------
test('env: trims, drops blanks, de-dupes', () => {
  assert.deepStrictEqual(resolveSandbox({ sandbox: { env: ['ANTHROPIC_API_KEY', 'GH_TOKEN'] } }).env, [
    'ANTHROPIC_API_KEY',
    'GH_TOKEN',
  ]);
  assert.deepStrictEqual(
    resolveSandbox({ sandbox: { env: ['  A ', '', '   ', 'B', ' A '] } }).env,
    ['A', 'B']
  );
});

test('env: non-array throws /sandbox.env/; a non-string entry throws /sandbox.env/', () => {
  assert.throws(() => resolveSandbox({ sandbox: { env: 'A' } }), /sandbox\.env/i);
  assert.throws(() => resolveSandbox({ sandbox: { env: 42 } }), /sandbox\.env/i);
  assert.throws(() => resolveSandbox({ sandbox: { env: ['A', 42] } }), /sandbox\.env/i);
  assert.throws(() => resolveSandbox({ sandbox: { env: ['A', null] } }), /sandbox\.env/i);
});

// --- resolveSandbox: mounts ----------------------------------------------------
test('mounts: a bare string ⇒ {host, container:/sandbox-mounts/<basename>}, ~ preserved', () => {
  const r = resolveSandbox({ sandbox: { mounts: ['~/.claude', '~/.config/gh'] } });
  assert.deepStrictEqual(r.mounts, [
    { host: '~/.claude', container: '/sandbox-mounts/.claude' },
    { host: '~/.config/gh', container: '/sandbox-mounts/gh' },
  ]);
});

test('mounts: a "host:container" colon form is respected (~ still preserved in host)', () => {
  const r = resolveSandbox({ sandbox: { mounts: ['~/.claude:/root/.claude'] } });
  assert.deepStrictEqual(r.mounts, [{ host: '~/.claude', container: '/root/.claude' }]);
});

test('mounts: entries are trimmed and blanks dropped', () => {
  const r = resolveSandbox({ sandbox: { mounts: ['  ~/.claude  ', '', '   '] } });
  assert.deepStrictEqual(r.mounts, [{ host: '~/.claude', container: '/sandbox-mounts/.claude' }]);
});

test('mounts: non-array throws /sandbox.mounts/; a non-string entry throws /sandbox.mounts/', () => {
  assert.throws(() => resolveSandbox({ sandbox: { mounts: '~/.claude' } }), /sandbox\.mounts/i);
  assert.throws(() => resolveSandbox({ sandbox: { mounts: 42 } }), /sandbox\.mounts/i);
  assert.throws(() => resolveSandbox({ sandbox: { mounts: ['~/.claude', 42] } }), /sandbox\.mounts/i);
  assert.throws(() => resolveSandbox({ sandbox: { mounts: ['~/.claude', null] } }), /sandbox\.mounts/i);
});

// --- buildDockerCommand --------------------------------------------------------
// workdir is the isolated clone — under the per-user ~/.bunshin/ home (registry.sandboxCloneFor),
// OUTSIDE the tracked tree, so a leftover clone never dirties the host `git status` (BUN-16 fix).
const BASE = {
  image: 'bunshin-sandbox:0.2.0',
  workdir: '/home/me/.bunshin/sandbox/abc123/work',
  network: 'none',
  envNames: [],
  mounts: [],
  statusMount: { host: '/home/me/.bunshin/status/abc.json', container: '/tmp/bunshin-status.json' },
  agentCommand: 'claude "/loop 20m go"',
};

test('buildDockerCommand emits the core docker run scaffold', () => {
  const cmd = buildDockerCommand(BASE);
  assert.ok(cmd.includes('docker run --rm'), 'docker run --rm');
  assert.ok(cmd.includes('-w /work'), '-w /work');
  assert.ok(cmd.includes('-v /home/me/.bunshin/sandbox/abc123/work:/work'), 'workdir mounted at /work');
  assert.ok(cmd.includes('--network none'), '--network <net>');
  assert.ok(cmd.includes('bunshin-sandbox:0.2.0'), 'the image tag');
});

test('buildDockerCommand runs the agent command inside a quoted sh -c "…" (inner quotes escaped)', () => {
  const cmd = buildDockerCommand(BASE);
  assert.ok(/sh -c "/.test(cmd), 'wraps in sh -c "…"');
  assert.ok(cmd.includes('sh -c "claude \\"/loop 20m go\\""'), 'agent command escaped inside sh -c');
});

test('buildDockerCommand emits one -e per env name', () => {
  const cmd = buildDockerCommand({ ...BASE, envNames: ['ANTHROPIC_API_KEY', 'GH_TOKEN'] });
  assert.ok(cmd.includes('-e ANTHROPIC_API_KEY'), '-e ANTHROPIC_API_KEY');
  assert.ok(cmd.includes('-e GH_TOKEN'), '-e GH_TOKEN');
});

test('buildDockerCommand emits one read-only -v per mount', () => {
  const cmd = buildDockerCommand({
    ...BASE,
    mounts: [
      { host: '/home/me/.claude', container: '/sandbox-mounts/.claude' },
      { host: '/home/me/.config/gh', container: '/sandbox-mounts/gh' },
    ],
  });
  assert.ok(cmd.includes('-v /home/me/.claude:/sandbox-mounts/.claude:ro'), 'mount 1 read-only');
  assert.ok(cmd.includes('-v /home/me/.config/gh:/sandbox-mounts/gh:ro'), 'mount 2 read-only');
});

test('buildDockerCommand bind-mounts the status file read-write (heartbeats)', () => {
  const cmd = buildDockerCommand(BASE);
  assert.ok(
    cmd.includes('-v /home/me/.bunshin/status/abc.json:/tmp/bunshin-status.json'),
    'status file mounted'
  );
  // must NOT be :ro — the driver writes heartbeats there.
  assert.ok(!cmd.includes('/tmp/bunshin-status.json:ro'), 'status mount is read-write');
});

console.log(`\nsandbox.test.js: ${passed} passed`);
