'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/run.test.js
const assert = require('assert');
const { buildPrompt } = require('../src/run');

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

console.log(`\nrun.test.js: ${passed} passed`);
