'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/run.test.js
const assert = require('assert');
const { buildPrompt, buildOrchestratorPrompt } = require('../src/run');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('buildPrompt embeds the driver path and the project name', () => {
  const p = buildPrompt('Demo', false, 'C:/pkg/template/driver.md', 'C:/home/.bunshin/status/abc.json');
  assert.match(p, /Demo/);
  assert.match(p, /template\/driver\.md/);
});

test('buildPrompt tells the driver where to write its heartbeat (statusFile)', () => {
  const sf = 'C:/Users/me/.bunshin/status/a1b2c3d4e5f6.json';
  const p = buildPrompt('Demo', false, 'C:/pkg/template/driver.md', sf);
  assert.ok(p.includes(sf.split(/[\\/]/).join('/')), 'prompt should contain the forward-slashed statusFile path');
  assert.match(p, /heartbeat/i);
});

test('once flag changes the scope wording', () => {
  const sf = 'C:/h/.bunshin/status/x.json';
  assert.match(buildPrompt('Demo', true, 'd.md', sf), /EXACTLY ONE/);
  assert.match(buildPrompt('Demo', false, 'd.md', sf), /serially/);
});

// --- Orchestrator mode (BUN-7): one board, many repositories -----------------
const REPOS = [
  { id: 'web', name: 'Acme Web', remote: 'r1', path: '../acme-web', baseBranch: null, description: '' },
  { id: 'api', name: 'Acme API', remote: 'r2', path: '../acme-api', baseBranch: null, description: '' },
];

test('buildOrchestratorPrompt signals orchestrator mode, the config file, and the triage step', () => {
  const p = buildOrchestratorPrompt('Acme', false, 'C:/pkg/template/driver.md', 'C:/h/.bunshin/status/x.json', 'bunshin.orchestrator.json', REPOS);
  assert.match(p, /orchestrator/i);
  assert.match(p, /bunshin\.orchestrator\.json/);
  assert.match(p, /triage/i);
  assert.match(p, /template\/driver\.md/);
  // names the repositories so the triage gate knows the candidate set
  assert.match(p, /web/);
  assert.match(p, /api/);
});

test('buildOrchestratorPrompt keeps the once/serial scope wording and heartbeat like buildPrompt', () => {
  const sf = 'C:/h/.bunshin/status/x.json';
  assert.match(buildOrchestratorPrompt('Acme', true, 'd.md', sf, 'bunshin.orchestrator.json', REPOS), /EXACTLY ONE/);
  assert.match(buildOrchestratorPrompt('Acme', false, 'd.md', sf, 'bunshin.orchestrator.json', REPOS), /serially/);
  assert.match(buildOrchestratorPrompt('Acme', false, 'd.md', sf, 'bunshin.orchestrator.json', REPOS), /heartbeat/i);
});

test('buildOrchestratorPrompt tells triage to Block a goal it cannot place', () => {
  const p = buildOrchestratorPrompt('Acme', false, 'd.md', 'sf.json', 'bunshin.orchestrator.json', REPOS);
  assert.match(p, /Blocked/i);
});

console.log(`\nrun.test.js: ${passed} passed`);
