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
  resolveRepoGates,
  resolveRepoCommands,
  ORCHESTRATOR_CONFIG_FILENAME,
  CONFIG_FILENAME,
  BUILTIN_GATES,
  DEFAULT_GATE_STEPS,
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
    gates: null,
    commands: null,
  });
  // name defaults to id; baseBranch/description default to null/''; gates/commands default to null
  assert.strictEqual(repos[1].name, 'api');
  assert.strictEqual(repos[1].baseBranch, null);
  assert.strictEqual(repos[1].description, '');
  assert.strictEqual(repos[1].gates, null);
  assert.strictEqual(repos[1].commands, null);
});

// --- Per-repo gates (BUN-12): heterogeneous repos need DIFFERENT gate pipelines --------------
test('resolveRepositories carries a per-repo `gates`/`commands` override through (raw)', () => {
  const repos = resolveRepositories({
    repositories: [
      { id: 'web', path: '../web', gates: { steps: ['implement', 'verify', 'review'] }, commands: { gateChecks: 'pnpm test' } },
    ],
  });
  assert.deepStrictEqual(repos[0].gates, { steps: ['implement', 'verify', 'review'] });
  assert.deepStrictEqual(repos[0].commands, { gateChecks: 'pnpm test' });
});

test('resolveRepoGates: a repo with its OWN gates.steps resolves to those (overriding the global)', () => {
  const cfg = {
    gates: { steps: ['triage', 'implement', 'verify', 'review'] },
    repositories: [
      { id: 'cli', path: '../cli', gates: { steps: ['implement', 'review'] } },
      { id: 'web', path: '../web' },
    ],
  };
  const repos = resolveRepositories(cfg);
  // cli drops the web-only verify gate via its own override
  assert.deepStrictEqual(resolveRepoGates(cfg, repos[0]).map((s) => s.name), ['implement', 'review']);
  // ...and its own steps do NOT need to include triage (triage runs from the global list before the worktree)
  assert.ok(!resolveRepoGates(cfg, repos[0]).some((s) => s.gate === 'verify'), 'verify dropped for cli');
});

test('resolveRepoGates: a repo WITHOUT its own gates falls back to the orchestrator-global gates', () => {
  const cfg = {
    gates: { steps: ['triage', 'implement', 'review'] },
    repositories: [{ id: 'web', path: '../web' }],
  };
  const repos = resolveRepositories(cfg);
  assert.deepStrictEqual(resolveRepoGates(cfg, repos[0]).map((s) => s.gate), ['triage', 'implement', 'review']);
});

test('resolveRepoGates: neither per-repo nor global gates set ⇒ DEFAULT_GATE_STEPS', () => {
  const cfg = { repositories: [{ id: 'web', path: '../web' }] };
  const repos = resolveRepositories(cfg);
  assert.deepStrictEqual(resolveRepoGates(cfg, repos[0]).map((s) => s.gate), DEFAULT_GATE_STEPS.slice());
});

test('resolveRepoGates: per-repo custom command/skill steps and case/space-insensitive names work too', () => {
  const cfg = {
    repositories: [{ id: 'android', path: '../android', gates: { steps: [' Implement ', { command: './gradlew test', name: 'Android tests' }] } }],
  };
  const repos = resolveRepositories(cfg);
  const steps = resolveRepoGates(cfg, repos[0]);
  assert.strictEqual(steps[0].gate, 'implement');
  assert.strictEqual(steps[1].type, 'command');
  assert.strictEqual(steps[1].command, './gradlew test');
});

test('resolveRepoGates: an invalid per-repo gate throws identifying the repo AND the orchestrator file', () => {
  const cfg = { repositories: [{ id: 'web', path: '../web', gates: { steps: ['implement', 'deploy'] } }] };
  const repos = resolveRepositories(cfg);
  assert.throws(() => resolveRepoGates(cfg, repos[0]), (err) => {
    return /unknown built-in gate/i.test(err.message) &&
      /repositories\["web"\]\.gates\.steps/.test(err.message) &&
      err.message.includes(ORCHESTRATOR_CONFIG_FILENAME);
  });
});

test('resolveRepoCommands: repo command keys override the orchestrator-global ones (rest inherited)', () => {
  const cfg = {
    commands: { install: 'npm ci', gateChecks: 'npm test', devServer: '' },
    repositories: [{ id: 'android', path: '../android', commands: { install: './gradlew', gateChecks: './gradlew test' } }],
  };
  const repos = resolveRepositories(cfg);
  assert.deepStrictEqual(resolveRepoCommands(cfg, repos[0]), {
    install: './gradlew',
    gateChecks: './gradlew test',
    devServer: '',
  });
});

test('resolveRepoCommands: a repo without its own commands inherits the global block verbatim', () => {
  const cfg = { commands: { install: 'npm ci', gateChecks: 'npm test' }, repositories: [{ id: 'web', path: '../web' }] };
  const repos = resolveRepositories(cfg);
  assert.deepStrictEqual(resolveRepoCommands(cfg, repos[0]), { install: 'npm ci', gateChecks: 'npm test' });
});

test('BACKWARD COMPAT: an orchestrator config whose repos have NO gates ⇒ every repo uses the global gates', () => {
  const cfg = {
    gates: { steps: ['triage', 'implement', 'verify', 'review'] },
    repositories: [{ id: 'web', path: '../web' }, { id: 'api', path: '../api' }],
  };
  const repos = resolveRepositories(cfg);
  const global = resolveGates(cfg).map((s) => s.gate);
  for (const repo of repos) {
    assert.deepStrictEqual(resolveRepoGates(cfg, repo).map((s) => s.gate), global);
  }
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
  // The template demonstrates a PER-REPO gates override: at least one example repo has its own gates
  // (dropping the web-only verify gate), and it resolves independently of the global list.
  const withOwnGates = repos.find((r) => r.gates && Array.isArray(r.gates.steps) && r.gates.steps.length);
  assert.ok(withOwnGates, 'template ships an example repo with a per-repo gates override');
  const ownGateNames = resolveRepoGates(cfg, withOwnGates).map((s) => s.gate || s.name);
  assert.ok(!ownGateNames.includes('triage'), 'a per-repo list does not repeat the global triage gate');
  // A repo WITHOUT its own gates falls back to the global (triage-led) pipeline.
  const withoutOwnGates = repos.find((r) => !(r.gates && Array.isArray(r.gates.steps) && r.gates.steps.length));
  if (withoutOwnGates) {
    assert.strictEqual(resolveRepoGates(cfg, withoutOwnGates).map((s) => s.gate || s.name)[0], 'triage');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the single-repo config path is unchanged (ensureConfig with no flag still writes bunshin.config.json)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-single-'));
  const { configPath } = ensureConfig({ dir, name: 'Acme' });
  assert.strictEqual(path.basename(configPath), CONFIG_FILENAME);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\norchestrator.test.js: ${passed} passed`);
