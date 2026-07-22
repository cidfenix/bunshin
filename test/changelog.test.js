'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/changelog.test.js
// Covers the top-level `changelog` key: resolveChangelog (config -> where the per-goal log
// entry lands). Absent ⇒ docs/CHANGELOG.md — deliberately NOT CLAUDE.md, which used to grow
// without bound because every goal appended a status line to the file every agent reads.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveChangelog, DEFAULT_CHANGELOG_PATH } = require('../src/util');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('the default path is docs/CHANGELOG.md (NOT CLAUDE.md)', () => {
  assert.strictEqual(DEFAULT_CHANGELOG_PATH, 'docs/CHANGELOG.md');
  assert.ok(!/CLAUDE\.md/.test(DEFAULT_CHANGELOG_PATH));
});

test('absent/null/empty ⇒ enabled at the default path', () => {
  for (const cfg of [
    undefined,
    null,
    {},
    { changelog: undefined },
    { changelog: null },
    { changelog: '' },
    { changelog: '   ' },
    { changelog: true },
  ]) {
    assert.deepStrictEqual(resolveChangelog(cfg), { enabled: true, path: 'docs/CHANGELOG.md' });
  }
});

test('an explicit repo-relative path passes through', () => {
  assert.deepStrictEqual(resolveChangelog({ changelog: 'docs/HISTORY.md' }), {
    enabled: true,
    path: 'docs/HISTORY.md',
  });
  assert.deepStrictEqual(resolveChangelog({ changelog: 'CHANGELOG.md' }), {
    enabled: true,
    path: 'CHANGELOG.md',
  });
});

test('a path is trimmed and normalized (backslashes, leading ./)', () => {
  assert.strictEqual(resolveChangelog({ changelog: '  docs/LOG.md  ' }).path, 'docs/LOG.md');
  assert.strictEqual(resolveChangelog({ changelog: 'docs\\LOG.md' }).path, 'docs/LOG.md');
  assert.strictEqual(resolveChangelog({ changelog: './docs/LOG.md' }).path, 'docs/LOG.md');
});

test('false disables the changelog entry entirely', () => {
  assert.deepStrictEqual(resolveChangelog({ changelog: false }), { enabled: false, path: null });
});

test('a repo can opt back into the old CLAUDE.md behavior explicitly', () => {
  assert.deepStrictEqual(resolveChangelog({ changelog: 'CLAUDE.md' }), {
    enabled: true,
    path: 'CLAUDE.md',
  });
});

test('a path escaping the repo throws referencing changelog', () => {
  for (const bad of ['/etc/passwd', 'C:\\tmp\\log.md', '../outside.md', 'docs/../../outside.md']) {
    assert.throws(() => resolveChangelog({ changelog: bad }), /changelog/, `expected throw for ${bad}`);
  }
});

test('a non-string, non-boolean value throws referencing changelog + the config file', () => {
  for (const bad of [1, [], {}, ['docs/CHANGELOG.md']]) {
    assert.throws(() => resolveChangelog({ changelog: bad }), /changelog/);
  }
  assert.throws(() => resolveChangelog({ changelog: 1 }), /bunshin\.config\.json/);
});

// --- The pipeline actually INSTRUCTS agents to use it -------------------------
// The resolver is only half the fix: the implement brief is what an agent reads. These guard
// that the shipped markdown tells agents to log to the changelog and NOT to CLAUDE.md, so the
// old "append a status line to CLAUDE.md" instruction can't silently come back.
const repoRoot = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

test('the implement brief points the log entry at the changelog, not CLAUDE.md', () => {
  const brief = read('template/gates/implement.md');
  assert.ok(/changelog/i.test(brief), 'implement.md must name the changelog');
  assert.ok(brief.includes(DEFAULT_CHANGELOG_PATH), `implement.md must name ${DEFAULT_CHANGELOG_PATH}`);
  // The exact instruction that made CLAUDE.md grow without bound must stay gone. (Matching the
  // OLD literal, not any mention of CLAUDE.md — the brief legitimately names CLAUDE.md to
  // PROHIBIT logging there, and to require in-place edits of durable facts.)
  assert.ok(
    !/Append a one-line entry to the CLAUDE\.md/i.test(brief),
    'implement.md must NOT tell the agent to append the per-goal log entry to CLAUDE.md'
  );
  assert.ok(
    !/CLAUDE\.md "Current status/i.test(brief),
    'implement.md must NOT send the log entry to a CLAUDE.md "Current status" section'
  );
  // …and the prohibition must be stated explicitly, not merely implied by omission.
  assert.ok(
    /Do NOT append this entry to `CLAUDE\.md`/i.test(brief),
    'implement.md must explicitly forbid appending the log entry to CLAUDE.md'
  );
});

test('the driver documents the changelog contract', () => {
  const driver = read('template/driver.md');
  assert.ok(/changelog/i.test(driver), 'driver.md must document the changelog step');
  assert.ok(driver.includes(DEFAULT_CHANGELOG_PATH), `driver.md must name ${DEFAULT_CHANGELOG_PATH}`);
});

test('both config templates ship the changelog key', () => {
  for (const rel of [
    'template/bunshin.config.template.json',
    'template/bunshin.orchestrator.template.json',
  ]) {
    const cfg = JSON.parse(read(rel));
    assert.ok(
      Object.prototype.hasOwnProperty.call(cfg, 'changelog'),
      `${rel} must ship a "changelog" key`
    );
    // The shipped templates must resolve cleanly through the real resolver.
    assert.deepStrictEqual(resolveChangelog(cfg), { enabled: true, path: 'docs/CHANGELOG.md' });
  }
});

test('README documents where the log goes', () => {
  const readme = read('README.md');
  assert.ok(readme.includes(DEFAULT_CHANGELOG_PATH), `README must name ${DEFAULT_CHANGELOG_PATH}`);
  assert.ok(/"changelog"/.test(readme), 'README must name the "changelog" config key');
});

test('this repo dogfoods it: its own history lives in docs/CHANGELOG.md, not CLAUDE.md', () => {
  assert.ok(fs.existsSync(path.join(repoRoot, DEFAULT_CHANGELOG_PATH)), 'docs/CHANGELOG.md must exist');
  const claude = read('CLAUDE.md');
  const status = claude.split(/^## Current status\s*$/m)[1] || '';
  assert.ok(status.trim().length > 0, 'CLAUDE.md must still have a Current status summary');
  // A short current-state summary, not an ever-growing log.
  const bullets = status.split('\n').filter((l) => /^- /.test(l)).length;
  assert.ok(bullets <= 10, `CLAUDE.md "Current status" should stay a short summary, found ${bullets} bullets`);
  assert.ok(
    status.includes(DEFAULT_CHANGELOG_PATH),
    'CLAUDE.md "Current status" must point at the changelog for the per-goal history'
  );
});

console.log(`\nchangelog.test.js: ${passed} passed`);
