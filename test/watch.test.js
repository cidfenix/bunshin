'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/watch.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const reg = require('../src/registry');
const watch = require('../src/watch');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-watch-'));
}

// Seed a registered repo + optional heartbeat into a fake home; returns its repoId.
function seed(home, { repoPath, pid, startedAt, heartbeat }) {
  const repoId = reg.register({ repoPath, pid, startedAt, projectName: 'P', provider: 'jira', tracker: 'BUN' }, home);
  if (heartbeat) reg.writeJsonAtomic(reg.statusFileFor(repoId, home), heartbeat);
  return repoId;
}

const NOW = Date.parse('2026-06-27T12:00:00Z');
const fresh = '2026-06-27T11:59:50Z'; // 10s old
const old = '2026-06-27T11:55:00Z'; // 5m old

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('pid alive + fresh heartbeat => running', () => {
  const home = tmpHome();
  seed(home, { repoPath: '/r/a', pid: 100, startedAt: 'x', heartbeat: { updatedAt: fresh, phase: 'gate2', queue: { pending: 3, inProgress: 1 } } });
  const payload = watch.buildStatusPayload({ home, now: NOW, isPidAlive: () => true, staleMs: 90000 });
  assert.strictEqual(payload.repos[0].liveness, 'running');
  assert.strictEqual(payload.repos[0].heartbeat.phase, 'gate2');
});

test('pid alive + stale heartbeat => stale', () => {
  const home = tmpHome();
  seed(home, { repoPath: '/r/b', pid: 100, startedAt: 'x', heartbeat: { updatedAt: old, phase: 'gate1' } });
  const payload = watch.buildStatusPayload({ home, now: NOW, isPidAlive: () => true, staleMs: 90000 });
  assert.strictEqual(payload.repos[0].liveness, 'stale');
});

test('pid dead => stopped (even with a fresh-ish heartbeat that is also old here)', () => {
  const home = tmpHome();
  seed(home, { repoPath: '/r/c', pid: 100, startedAt: 'x', heartbeat: { updatedAt: old, phase: 'idle' } });
  const payload = watch.buildStatusPayload({ home, now: NOW, isPidAlive: () => false, staleMs: 90000 });
  assert.strictEqual(payload.repos[0].liveness, 'stopped');
});

test('pid dead + fresh heartbeat => stale (loop may have just died)', () => {
  const home = tmpHome();
  seed(home, { repoPath: '/r/d', pid: 100, startedAt: 'x', heartbeat: { updatedAt: fresh, phase: 'gate3' } });
  const payload = watch.buildStatusPayload({ home, now: NOW, isPidAlive: () => false, staleMs: 90000 });
  assert.strictEqual(payload.repos[0].liveness, 'stale');
});

test('no heartbeat file + pid dead => stopped, heartbeat null', () => {
  const home = tmpHome();
  seed(home, { repoPath: '/r/e', pid: 100, startedAt: 'x' });
  const payload = watch.buildStatusPayload({ home, now: NOW, isPidAlive: () => false, staleMs: 90000 });
  assert.strictEqual(payload.repos[0].liveness, 'stopped');
  assert.strictEqual(payload.repos[0].heartbeat, null);
});

test('malformed heartbeat file does not throw; treated as no heartbeat', () => {
  const home = tmpHome();
  const id = seed(home, { repoPath: '/r/f', pid: 100, startedAt: 'x' });
  fs.mkdirSync(reg.statusDir(home), { recursive: true });
  fs.writeFileSync(reg.statusFileFor(id, home), '{ this is not json');
  const payload = watch.buildStatusPayload({ home, now: NOW, isPidAlive: () => true, staleMs: 90000 });
  assert.strictEqual(payload.repos[0].heartbeat, null);
  assert.strictEqual(payload.repos[0].liveness, 'stale'); // alive pid, no fresh heartbeat
});

test('totals aggregate liveness counts and queue sums across repos', () => {
  const home = tmpHome();
  seed(home, { repoPath: '/r/g1', pid: 1, startedAt: 'x', heartbeat: { updatedAt: fresh, phase: 'gate1', queue: { pending: 2, inProgress: 1 } } });
  seed(home, { repoPath: '/r/g2', pid: 2, startedAt: 'x', heartbeat: { updatedAt: fresh, phase: 'gate2', queue: { pending: 5, inProgress: 1 } } });
  const aliveExcept2 = (pid) => pid !== 2; // g2 is dead+fresh => stale
  const payload = watch.buildStatusPayload({ home, now: NOW, isPidAlive: aliveExcept2, staleMs: 90000 });
  assert.strictEqual(payload.totals.running, 1);
  assert.strictEqual(payload.totals.stale, 1);
  assert.strictEqual(payload.totals.stopped, 0);
  assert.strictEqual(payload.totals.pending, 7);
  assert.strictEqual(payload.totals.inProgress, 2);
});

test('empty home => empty repos and zeroed totals, no throw', () => {
  const payload = watch.buildStatusPayload({ home: path.join(os.tmpdir(), 'nope-' + Date.now()), now: NOW, isPidAlive: () => true, staleMs: 90000 });
  assert.deepStrictEqual(payload.repos, []);
  assert.strictEqual(payload.totals.running, 0);
  assert.strictEqual(payload.totals.pending, 0);
});

console.log(`\nwatch.test.js: ${passed} passed`);
