# Configurable Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a top-level `concurrency` config key (default 1) bounding how many goals the Bunshin driver works at the same time, with a pure unit-tested resolver and driver/docs updates.

**Architecture:** Follows the repo's locked resolver pattern (BUN-6/13/14/15): a pure `resolveConcurrency(config)` in `src/util.js` is the canonical semantics (unit-tested without any runtime), the markdown driver reads the same key at run time, and the config templates/README/CLAUDE.md document it. Absent key ⇒ 1 ⇒ byte-for-byte current serial behavior.

**Tech Stack:** Node ≥ 18 built-ins only (CommonJS, no deps, no framework — plain `assert` test scripts run by `npm test`).

## Global Constraints

- Zero runtime npm dependencies; CommonJS; Node ≥ 18 built-ins only (LOCKED).
- No test framework: plain-Node `assert` scripts in `test/`, each wired into the `package.json` `test` script.
- Backward compatible: absent `concurrency` ⇒ 1 (serial, unchanged); `--once` unchanged; sandbox/watch untouched.
- Integration (rebase + gateChecks + merge) stays **serial** regardless of `concurrency`.
- LF line endings; Conventional Commits with explicit staged paths; commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Spec: `docs/superpowers/specs/2026-07-07-configurable-concurrency-design.md`.

---

### Task 1: `resolveConcurrency` resolver + unit tests

**Files:**
- Modify: `src/util.js` (add resolver after `resolvePrLabels`, ~line 322; add to `module.exports`)
- Create: `test/concurrency.test.js`
- Modify: `package.json:9` (wire the test into the `test` script)

**Interfaces:**
- Produces: `resolveConcurrency(config) -> number` — exported from `src/util.js`. Absent/`null` `config.concurrency` ⇒ `1`; a positive integer ⇒ itself; anything else throws an `Error` whose message contains `concurrency` and `bunshin.config.json`.

- [x] **Step 1: Write the failing test**

Create `test/concurrency.test.js`:

```js
'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/concurrency.test.js
// Covers the configurable concurrency: resolveConcurrency (config -> how many goals may be IN
// FLIGHT — worktree cut, gates running — at the same time). Absent ⇒ 1 = serial (unchanged
// behavior). Integration stays serial regardless; this only bounds the implement/gates work.
const assert = require('assert');
const { resolveConcurrency } = require('../src/util');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('resolveConcurrency returns 1 when concurrency is absent/null', () => {
  for (const cfg of [undefined, null, {}, { concurrency: undefined }, { concurrency: null }]) {
    assert.strictEqual(resolveConcurrency(cfg), 1);
  }
});

test('a positive integer resolves to itself', () => {
  assert.strictEqual(resolveConcurrency({ concurrency: 1 }), 1);
  assert.strictEqual(resolveConcurrency({ concurrency: 2 }), 2);
  assert.strictEqual(resolveConcurrency({ concurrency: 8 }), 8);
});

test('zero and negative numbers throw referencing concurrency', () => {
  assert.throws(() => resolveConcurrency({ concurrency: 0 }), /concurrency/i);
  assert.throws(() => resolveConcurrency({ concurrency: -1 }), /concurrency/i);
});

test('non-integer numbers throw referencing concurrency', () => {
  assert.throws(() => resolveConcurrency({ concurrency: 1.5 }), /concurrency/i);
  assert.throws(() => resolveConcurrency({ concurrency: NaN }), /concurrency/i);
  assert.throws(() => resolveConcurrency({ concurrency: Infinity }), /concurrency/i);
});

test('non-number values (string/boolean/array/object) throw referencing concurrency', () => {
  assert.throws(() => resolveConcurrency({ concurrency: '2' }), /concurrency/i);
  assert.throws(() => resolveConcurrency({ concurrency: true }), /concurrency/i);
  assert.throws(() => resolveConcurrency({ concurrency: [2] }), /concurrency/i);
  assert.throws(() => resolveConcurrency({ concurrency: { max: 2 } }), /concurrency/i);
});

test('the error names the config file', () => {
  assert.throws(() => resolveConcurrency({ concurrency: '2' }), /bunshin\.config\.json/);
});

console.log(`\nconcurrency.test.js: ${passed} passed`);
```

- [x] **Step 2: Run test to verify it fails**

Run: `node test/concurrency.test.js`
Expected: FAIL — `TypeError: resolveConcurrency is not a function` (it isn't exported yet).

- [x] **Step 3: Write minimal implementation**

In `src/util.js`, insert after the closing brace of `resolvePrLabels` (before the `--- Orchestrator repositories ---` banner):

```js
// --- Configurable concurrency (goals in flight) --------------------------------
// How many goals the driver may work AT THE SAME TIME (worktree cut, gates running).
// Historically hard-serial (exactly one); a top-level `concurrency` in the config now bounds
// it per repo/queue. Absent ⇒ 1 = serial (unchanged behavior). INTEGRATION (rebase +
// gateChecks + merge) stays serial regardless — this only bounds the implement/gates work.
// `resolveConcurrency` is pure (no fs/spawn) so it is unit-testable; the driver reads the
// same top-level `concurrency` key. A non-number / non-integer / < 1 value throws a clear
// `concurrency`-referencing error rather than silently degrading to serial.
function resolveConcurrency(config) {
  const raw = config && config.concurrency;
  if (raw == null) return 1;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new Error(
      `Invalid concurrency in ${CONFIG_FILENAME}: expected a whole number >= 1 ` +
        `(how many goals may be in flight at once; absent => 1 = serial), got ` +
        `${typeof raw === 'number' ? raw : JSON.stringify(raw)}.`
    );
  }
  return raw;
}
```

Add `resolveConcurrency,` to `module.exports` (after `resolvePrLabels,`).

- [x] **Step 4: Run test to verify it passes**

Run: `node test/concurrency.test.js`
Expected: PASS — `concurrency.test.js: 6 passed`.

- [x] **Step 5: Wire into `npm test` and run the full suite**

In `package.json` line 9, insert `node test/concurrency.test.js && ` before `node test/orchestrator.test.js` (keeping the existing order otherwise).

Run: `npm test`
Expected: every suite passes, including the new one.

- [x] **Step 6: Commit**

```bash
git add src/util.js test/concurrency.test.js package.json
git commit -m "feat(config): resolveConcurrency — configurable goals-in-flight (default 1)"
```
(with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.)

---

### Task 2: Launch-prompt wording in `src/run.js`

**Files:**
- Modify: `src/run.js:100-116` (`buildPrompt`) and `src/run.js:123-146` (`buildOrchestratorPrompt`)
- Modify: `test/run.test.js` (extend the existing prompt assertions)

**Interfaces:**
- Consumes: nothing new (pure string builders; concurrency itself is read by the driver from the config, not plumbed through the prompt).
- Produces: prompts that still match `/serially/` and now also `/concurrency/`.

- [x] **Step 1: Extend the tests (failing first)**

In `test/run.test.js`, next to the existing `assert.match(buildPrompt('Demo', false, 'd.md', sf), /serially/);` (line ~30) add:

```js
  // The not-once scope must point the driver at the configurable concurrency (default serial).
  assert.match(buildPrompt('Demo', false, 'd.md', sf), /concurrency/);
```

and next to the orchestrator `/serially/` assertion (line ~53) add:

```js
  assert.match(buildOrchestratorPrompt('Acme', false, 'd.md', sf, 'bunshin.orchestrator.json', REPOS), /concurrency/);
```

- [x] **Step 2: Run test to verify it fails**

Run: `node test/run.test.js`
Expected: FAIL — the new `/concurrency/` match throws `AssertionError`.

- [x] **Step 3: Update both scope strings**

In BOTH `buildPrompt` and `buildOrchestratorPrompt`, replace the not-once scope string:

```js
    : "process goals from the Pending column serially until Pending is empty";
```

with:

```js
    : 'process goals from the Pending column until Pending is empty -- serially by default, ' +
      "or up to the config's `concurrency` goals at a time";
```

(The `--once` branch is untouched.)

- [x] **Step 4: Run tests to verify they pass**

Run: `node test/run.test.js && npm test`
Expected: PASS (old `/serially/` assertions still match "serially by default").

- [x] **Step 5: Commit**

```bash
git add src/run.js test/run.test.js
git commit -m "feat(run): launch prompt names the configurable concurrency"
```
(with the trailer.)

---

### Task 3: Driver semantics + config templates

**Files:**
- Modify: `template/driver.md` (intro before `## One iteration`; iteration steps 1 and 7; Heartbeat section; Rules first bullet)
- Modify: `template/bunshin.config.template.json` (top-level `concurrency` + note, before the `gates` block)
- Modify: `template/bunshin.orchestrator.template.json` (same, before its `gates` block)

**Interfaces:**
- Consumes: the `concurrency` key semantics from Task 1 (absent ⇒ 1; whole number ≥ 1).
- Produces: the driver-facing contract later docs reference: at most `concurrency` goals in flight; integration always serial; heartbeat unchanged (single `card` = the goal currently being acted on).

- [x] **Step 1: Add a Concurrency paragraph to the driver intro**

In `template/driver.md`, insert a new paragraph immediately BEFORE the `## One iteration` heading:

```markdown
**Concurrency.** A top-level **`concurrency`** number in the config (absent ⇒ **1**) bounds how many
goals may be **in flight** (worktree cut, gates running) at the same time. At `1` (the default)
everything below reads exactly as written — strictly serial. Above `1`, take additional Pending goals
(step 1) until `concurrency` goals are in flight and work them side by side: each goal keeps its OWN
worktree/branch, its gates still run in order fail-fast, and a gate failure PARKS only that goal —
the others continue. Gate agents for DIFFERENT goals may be dispatched in parallel. **INTEGRATION is
always serial** regardless of `concurrency`: merge one goal at a time (each rebases onto the
just-updated base and re-runs `commands.gateChecks` before its fast-forward). A non-integer or < 1
`concurrency` is a config error — report it rather than guessing.
```

- [x] **Step 2: Rewrite iteration step 1 (take up to `concurrency` goals)**

Replace step 1 of `## One iteration`:

```markdown
1. Resolve the columns. If an issue is already in **In Progress** (a crashed/interrupted run), RESUME
   that issue — its branch `<git.branchPrefix><N>-<slug>` and worktree may already exist; re-derive
   N/slug from it (step 2) and continue from the gates (step 5). Otherwise read the **Pending** status
   (a JQL search ordered by Rank/created) and take the FIRST issue.
```

with:

```markdown
1. Resolve the columns. If issues are already in **In Progress** (a crashed/interrupted run), RESUME
   them — each branch `<git.branchPrefix><N>-<slug>` and worktree may already exist; re-derive
   N/slug from it (step 2) and continue from the gates (step 5). Then, while FEWER than `concurrency`
   goals are in flight (default 1 — see **Concurrency** above), read the **Pending** status
   (a JQL search ordered by Rank/created) and take issues from the TOP until `concurrency` goals are
   in flight (at the default of 1: take the FIRST issue). Steps 2–6 below apply to EACH in-flight
   goal (at `concurrency` 1 there is exactly one).
```

- [x] **Step 3: Note multi-goal heartbeat + adjust step 7**

In the `## Heartbeat` section, append this bullet to the "Write a heartbeat at each of these moments" list:

```markdown
- With `concurrency` > 1 the heartbeat keeps this SAME single-`card` shape: report the goal you are
  acting on right now (the `queue.inProgress` count still shows how many are in flight).
```

In step 7 of `## One iteration`, replace:

```markdown
7. If **Pending** still has issues, loop immediately (no wait). Otherwise go to step 1's idle path.
```

with:

```markdown
7. If **Pending** still has issues (or goals are still in flight), loop immediately (no wait).
   Otherwise go to step 1's idle path.
```

- [x] **Step 4: Replace the SERIAL rule**

In `## Rules`, replace the first bullet:

```markdown
- SERIAL implementation — never create a second worktree while one goal is being implemented. (In PR
  mode multiple PRs may sit open in **In Review** at once; that's fine — only the
  implement→gates→integrate work is serial. The reaper merges open PRs at the start of each iteration.)
```

with:

```markdown
- BOUNDED concurrency — never have more than `concurrency` goals (default 1 = strictly serial: never
  a second worktree while one goal is being implemented) in flight at once, and INTEGRATE serially
  no matter what: one merge at a time, each rebased onto the just-updated base with
  `commands.gateChecks` re-run. (In PR mode multiple PRs may sit open in **In Review** at once;
  that's fine — the reaper merges open PRs at the start of each iteration.)
```

- [x] **Step 5: Add `concurrency` to both config templates**

In `template/bunshin.config.template.json`, insert between the `commit` block and the `gates` block (as two top-level keys, matching the `prLabels`/`prLabelsNote` scalar-plus-note style):

```json
  "concurrency": 1,
  "concurrencyNote": "OPTIONAL. How many goals the driver may work AT THE SAME TIME (worktree cut, gates running) — a whole number >= 1. Absent/1 ⇒ strictly serial (unchanged behavior). Above 1 the driver takes more Pending goals until that many are in flight, each in its OWN worktree; a gate failure parks only that goal. INTEGRATION (rebase + gateChecks + fast-forward/PR) is ALWAYS serial regardless. The watch heartbeat still reports one card: the goal currently being acted on.",
```

In `template/bunshin.orchestrator.template.json`, insert the same two keys between `merge` and `gates`, with the note's first sentence adapted: `"OPTIONAL. How many goals the driver may work AT THE SAME TIME across ALL repositories (worktree cut, gates running) — a whole number >= 1. ..."` (rest identical).

- [x] **Step 6: Sanity-check the templates parse and the suite passes**

Run: `node -e "JSON.parse(require('fs').readFileSync('template/bunshin.config.template.json','utf8')); JSON.parse(require('fs').readFileSync('template/bunshin.orchestrator.template.json','utf8')); console.log('templates ok')" && npm test`
Expected: `templates ok`, all suites pass (gates-layout guard included).

- [x] **Step 7: Commit**

```bash
git add template/driver.md template/bunshin.config.template.json template/bunshin.orchestrator.template.json
git commit -m "feat(driver): bounded concurrency — work up to config concurrency goals at once"
```
(with the trailer.)

---

### Task 4: README + CLAUDE.md documentation

**Files:**
- Modify: `README.md:347-349` (the "serial" claim in *How a goal flows*)
- Modify: `CLAUDE.md` (LOCKED decision 4 at line ~72; `src/util.js` key-files row; append a status entry)

**Interfaces:**
- Consumes: the contract from Tasks 1 and 3 (key name `concurrency`, default 1, integration always serial).

- [x] **Step 1: Update README's How-a-goal-flows wording**

Replace (README lines 347–349):

```markdown
The card's list is the authoritative status, so a run is **crash-resumable**. Implementation is
**serial** and parks on the **first** gate failure — no auto-repair; you re-queue by dragging the card
back to **Pending**. (In `pr` mode, multiple PRs can sit in **In Review** at once.)
```

with:

```markdown
The card's list is the authoritative status, so a run is **crash-resumable**. Implementation is
**serial by default** — set a top-level `"concurrency"` in the config (a whole number, default `1`)
to let the driver work that many goals at once, each in its own worktree; integration (rebase +
re-gate + merge) stays serial regardless. A goal parks on the **first** gate failure — no
auto-repair; you re-queue by dragging the card back to **Pending**. (In `pr` mode, multiple PRs can
sit in **In Review** at once.)
```

- [x] **Step 2: Update CLAUDE.md LOCKED decision 4**

In CLAUDE.md line ~72, replace:

```markdown
   tracker. Execution is **serial** and parks on the **first** gate failure (no auto-repair/retry).
```

with:

```markdown
   tracker. Execution is **serial by default** — a top-level **`concurrency`** (whole number, absent ⇒ 1)
   bounds how many goals may be in flight at once (pure `resolveConcurrency()` in `src/util.js`,
   unit-tested in `test/concurrency.test.js`; integration is ALWAYS serial) — and each goal parks on
   its **first** gate failure (no auto-repair/retry).
```

- [x] **Step 3: Update CLAUDE.md's `src/util.js` key-files row and add a status entry**

In the `src/util.js` row of the key-files table, after the `resolvePrLabels` description, add:

```
**`resolveConcurrency(config)`** (top-level `concurrency` → how many goals may be in flight at once; absent ⇒ 1 = serial; non-integer/<1 throws; unit-tested in `test/concurrency.test.js`),
```

Append to `## Current status`:

```markdown
- Configurable concurrency: a top-level `concurrency` (whole number, absent ⇒ 1 = serial — unchanged)
  bounds how many goals the driver works AT ONCE, each in its own worktree; a gate failure parks only
  that goal, and INTEGRATION stays strictly serial (one rebase + re-gate + merge at a time). Pure
  `resolveConcurrency()` in `src/util.js` (unit-tested in `test/concurrency.test.js`, wired into
  `npm test`); `template/driver.md` gained a Concurrency contract (intro + step 1 takes Pending goals
  until `concurrency` are in flight + BOUNDED-concurrency rule + single-card heartbeat note);
  `concurrency`/`concurrencyNote` added to both config templates; README + LOCKED decision 4 updated
  (serial → serial BY DEFAULT). Launch prompts in `src/run.js` name the knob (tests extended in
  `test/run.test.js`).
```

- [x] **Step 4: Run the suite (README consistency guard lives in gates-layout.test.js)**

Run: `npm test`
Expected: all suites pass.

- [x] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document configurable concurrency (goals in flight, default 1)"
```
(with the trailer.)
