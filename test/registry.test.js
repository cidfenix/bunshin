'use strict';

// Ad-hoc smoke test (no framework — Node built-ins only). Run: node test/registry.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const reg = require('../src/registry');

// Each test gets an isolated fake home so we never touch the real ~/.bunshin.
function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-reg-'));
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('repoIdFor is stable for the same path and 12 lowercase hex chars', () => {
  const a = reg.repoIdFor('E:/workspace/gitfenix');
  const b = reg.repoIdFor('E:/workspace/gitfenix');
  assert.strictEqual(a, b);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('repoIdFor differs for different paths', () => {
  assert.notStrictEqual(reg.repoIdFor('E:/workspace/a'), reg.repoIdFor('E:/workspace/b'));
});

test('register then readAll round-trips the entry and assigns a stable repoId', () => {
  const home = tmpHome();
  const repoId = reg.register(
    {
      repoPath: 'E:/workspace/gitfenix',
      projectName: 'GitFenix',
      provider: 'jira',
      tracker: 'BUN',
      baseBranch: 'main',
      mergeMode: 'pr',
      pid: 48213,
      startedAt: '2026-06-27T10:01:00Z',
    },
    home
  );
  assert.strictEqual(repoId, reg.repoIdFor('E:/workspace/gitfenix'));

  const all = reg.readAll(home);
  assert.strictEqual(all.schemaVersion, 1);
  const entry = all.repos[repoId];
  assert.strictEqual(entry.projectName, 'GitFenix');
  assert.strictEqual(entry.pid, 48213);
  assert.strictEqual(entry.endedAt, null);
  // statusFile points inside the same home's status/ dir, named by repoId.
  assert.strictEqual(entry.statusFile, reg.statusFileFor(repoId, home));
});

test('register twice for the same repo updates in place (one entry, newest pid)', () => {
  const home = tmpHome();
  reg.register({ repoPath: '/x/repo', pid: 1, startedAt: 'a' }, home);
  const repoId = reg.register({ repoPath: '/x/repo', pid: 2, startedAt: 'b' }, home);
  const all = reg.readAll(home);
  assert.strictEqual(Object.keys(all.repos).length, 1);
  assert.strictEqual(all.repos[repoId].pid, 2);
});

test('markStopped sets endedAt on the entry', () => {
  const home = tmpHome();
  const repoId = reg.register({ repoPath: '/x/repo', pid: 9, startedAt: 'a' }, home);
  reg.markStopped(repoId, home, '2026-06-27T11:00:00Z');
  assert.strictEqual(reg.readAll(home).repos[repoId].endedAt, '2026-06-27T11:00:00Z');
});

test('readAll on a missing home returns an empty registry, not a throw', () => {
  const all = reg.readAll(path.join(os.tmpdir(), 'bunshin-does-not-exist-' + Date.now()));
  assert.deepStrictEqual(all, { schemaVersion: 1, repos: {} });
});

test('writeJsonAtomic leaves no temp file behind and writes valid JSON', () => {
  const home = tmpHome();
  reg.register({ repoPath: '/x/repo', pid: 1, startedAt: 'a' }, home);
  const files = fs.readdirSync(home);
  assert.ok(files.includes('registry.json'));
  assert.ok(!files.some((f) => f.includes('.tmp')), 'no leftover .tmp file');
  JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8')); // must parse
});

console.log(`\nregistry.test.js: ${passed} passed`);
