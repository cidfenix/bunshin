'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/orchestrator.test.js
// Covers ORCHESTRATOR mode (BUN-7): one board whose goals span MULTIPLE repos.
//   - resolveRepositories: config.repositories -> normalized, validated list.
//   - ORCHESTRATOR_CONFIG_FILENAME: the distinct config file (coexists with the single-repo one).
//   - ensureConfig({ orchestrator: true }) renders the orchestrator template.
//   - the rendered template is valid + its gate pipeline leads with the `triage` gate.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveRepositories,
  ORCHESTRATOR_CONFIG_FILENAME,
  CONFIG_FILENAME,
  BUILTIN_GATES,
  resolveGates,
} = require('../src/util');
const { ensureConfig } = require('../src/init');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('the orchestrator config has its OWN distinct filename (so it can coexist with the single-repo config)', () => {
  assert.strictEqual(ORCHESTRATOR_CONFIG_FILENAME, 'bunshin.orchestrator.json');
  assert.notStrictEqual(ORCHESTRATOR_CONFIG_FILENAME, CONFIG_FILENAME);
});

test('resolveRepositories normalizes each entry (id/name/remote/path/baseBranch/description)', () => {
  const repos = resolveRepositories({
    repositories: [
      { id: 'web', name: 'Acme Web', remote: 'git@github.com:acme/web.git', path: '../acme-web', baseBranch: 'main', description: 'the site' },
      { id: 'api', remote: 'git@github.com:acme/api.git', path: '../acme-api' },
    ],
  });
  assert.strictEqual(repos.length, 2);
  assert.deepStrictEqual(repos[0], {
    id: 'web',
    name: 'Acme Web',
    remote: 'git@github.com:acme/web.git',
    path: '../acme-web',
    baseBranch: 'main',
    description: 'the site',
  });
  // name defaults to id; baseBranch/description default to null/''
  assert.strictEqual(repos[1].name, 'api');
  assert.strictEqual(repos[1].baseBranch, null);
  assert.strictEqual(repos[1].description, '');
});

test('a repo needs at least a remote OR a path', () => {
  const repos = resolveRepositories({ repositories: [{ id: 'only-remote', remote: 'git@x:y.git' }, { id: 'only-path', path: '../y' }] });
  assert.strictEqual(repos[0].path, null);
  assert.strictEqual(repos[1].remote, null);
  assert.throws(() => resolveRepositories({ repositories: [{ id: 'nope' }] }), /remote.*path|path.*remote/i);
});

test('resolveRepositories requires a non-empty repositories array', () => {
  for (const cfg of [undefined, null, {}, { repositories: [] }, { repositories: 'x' }]) {
    assert.throws(() => resolveRepositories(cfg), /repositories/i);
  }
});

test('resolveRepositories requires an id on every entry', () => {
  assert.throws(() => resolveRepositories({ repositories: [{ remote: 'git@x:y.git', path: '../y' }] }), /id/i);
});

test('resolveRepositories rejects duplicate ids (case-insensitively)', () => {
  assert.throws(
    () => resolveRepositories({ repositories: [{ id: 'Web', remote: 'r' }, { id: 'web', path: 'p' }] }),
    /duplicate/i
  );
});

test('`triage` is a recognized built-in gate (the orchestrator triage preset)', () => {
  assert.ok(BUILTIN_GATES.includes('triage'), 'triage should be a built-in gate name');
  const steps = resolveGates({ gates: { steps: ['triage', 'implement', 'review'] } });
  assert.deepStrictEqual(steps.map((s) => s.gate), ['triage', 'implement', 'review']);
});

test('ensureConfig({ orchestrator: true }) writes bunshin.orchestrator.json with a valid, well-formed schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-orch-'));
  const { configPath, wrote } = ensureConfig({ dir, name: 'Acme', orchestrator: true });
  assert.ok(wrote, 'should have written the file');
  assert.strictEqual(path.basename(configPath), ORCHESTRATOR_CONFIG_FILENAME);
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  // No unresolved placeholder tokens survive rendering.
  assert.ok(!fs.readFileSync(configPath, 'utf8').includes('{{'), 'no {{TOKENS}} should remain');
  // The schema the loader/driver rely on:
  const repos = resolveRepositories(cfg);
  assert.ok(repos.length >= 1, 'template ships at least one example repository');
  // Orchestrator gate pipeline leads with triage.
  const gateNames = resolveGates(cfg).map((s) => s.gate || s.name);
  assert.strictEqual(gateNames[0], 'triage', 'triage runs first in orchestrator mode');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the single-repo config path is unchanged (ensureConfig with no flag still writes bunshin.config.json)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-single-'));
  const { configPath } = ensureConfig({ dir, name: 'Acme' });
  assert.strictEqual(path.basename(configPath), CONFIG_FILENAME);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\norchestrator.test.js: ${passed} passed`);
