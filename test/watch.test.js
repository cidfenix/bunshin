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

// --- sceneFor(repo): the pure state -> nerd-view scene mapper ---

// Build a /status-style repo entry as buildStatusPayload would produce.
function repoEntry(liveness, heartbeat) {
  return { repoId: 'abc', projectName: 'P', liveness, heartbeat: heartbeat || null };
}

test('sceneFor: stopped => loop gone, no clone', () => {
  const s = watch.sceneFor(repoEntry('stopped', { phase: 'gate2' }));
  assert.strictEqual(s.loopPose, 'gone');
  assert.strictEqual(s.goalActive, false);
  assert.strictEqual(s.station, -1);
  assert.strictEqual(s.blocked, false);
});

test('sceneFor: stale overrides an active phase => sleep, no clone', () => {
  const s = watch.sceneFor(repoEntry('stale', { phase: 'gate3' }));
  assert.strictEqual(s.loopPose, 'sleep');
  assert.strictEqual(s.goalActive, false);
  assert.strictEqual(s.station, -1);
});

test('sceneFor: running idle => loop checking board, no clone', () => {
  const s = watch.sceneFor(repoEntry('running', { phase: 'idle' }));
  assert.strictEqual(s.loopPose, 'check');
  assert.strictEqual(s.goalActive, false);
  assert.strictEqual(s.station, -1);
});

test('sceneFor: running with no heartbeat => loop checking board', () => {
  const s = watch.sceneFor(repoEntry('running', null));
  assert.strictEqual(s.loopPose, 'check');
  assert.strictEqual(s.goalActive, false);
  assert.strictEqual(s.station, -1);
});

test('sceneFor: running gate1..merge => clone at the matching station', () => {
  const map = { gate1: 0, gate2: 1, gate3: 2, merge: 3 };
  for (const phase of Object.keys(map)) {
    const s = watch.sceneFor(repoEntry('running', { phase }));
    assert.strictEqual(s.goalActive, true, phase);
    assert.strictEqual(s.station, map[phase], phase);
    assert.strictEqual(s.blocked, false, phase);
  }
});

test('sceneFor: running blocked => clone present, blocked true, station >= 0', () => {
  const s = watch.sceneFor(repoEntry('running', { phase: 'blocked' }));
  assert.strictEqual(s.goalActive, true);
  assert.strictEqual(s.blocked, true);
  assert.ok(s.station >= 0);
});

test('sceneFor: surfaces card title and queue counts', () => {
  const s = watch.sceneFor(repoEntry('running', {
    phase: 'gate1',
    card: { ref: 'BUN-42', title: 'Add CSV export' },
    queue: { pending: 5, done: 18 },
  }));
  assert.ok(s.cardTitle.includes('Add CSV export'));
  assert.strictEqual(s.pending, 5);
  assert.strictEqual(s.done, 18);
});

test('sceneFor: tolerates missing card/queue without throwing', () => {
  const s = watch.sceneFor(repoEntry('running', { phase: 'gate2' }));
  assert.strictEqual(s.cardTitle, '');
  assert.strictEqual(s.pending, 0);
  assert.strictEqual(s.done, 0);
});

// --- dojoLayout(W,H): pure canvas geometry for the bigger anime figures ---

test('dojoLayout: 4 increasing gate stations, all inside the canvas', () => {
  const L = watch.dojoLayout(440, 150);
  assert.strictEqual(L.stations.length, 4);
  for (let i = 1; i < L.stations.length; i++) assert.ok(L.stations[i] > L.stations[i - 1], 'monotonic');
  L.stations.forEach((x) => assert.ok(x >= 0 && x <= 440, 'within width'));
});

test('dojoLayout: figures are big (taller than the old 33px sprite) but fit the canvas', () => {
  const L = watch.dojoLayout(440, 150);
  assert.ok(L.figH > 33, 'bigger than the old 11-row * 3px sprite');
  assert.ok(L.figH < 150, 'still fits the canvas height');
  assert.ok(L.groundY <= 150 && L.groundY > L.figH * 0.5, 'ground sits below the figure');
});

test('dojoLayout: geometry scales with canvas size', () => {
  const small = watch.dojoLayout(300, 100);
  const big = watch.dojoLayout(600, 200);
  assert.ok(big.figH > small.figH, 'taller canvas => taller figure');
  assert.ok(big.stations[3] > small.stations[3], 'wider canvas => stations spread further');
});

// --- renderPage(): both views + toggle + inlined single-source mappers ---

test('renderPage: serves both view roots, the toggle, and the inlined single-source helpers', () => {
  const html = watch.renderPage();
  assert.ok(html.includes('id="view-pro"'), 'has pro view root');
  assert.ok(html.includes('id="view-nerd"'), 'has nerd view root');
  assert.ok(html.includes('bunshin.watch.view'), 'persists view choice');
  assert.ok(html.includes('function sceneFor'), 'inlines sceneFor source');
  assert.ok(html.includes('function dojoLayout'), 'inlines dojoLayout source');
  assert.ok(html.includes('function drawNinja'), 'inlines the anime ninja renderer');
});

console.log(`\nwatch.test.js: ${passed} passed`);
