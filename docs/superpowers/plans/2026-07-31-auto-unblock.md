# Auto-unblock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a gate fails, the driver classifies the failure and self-retries goals whose fix is achievable in-repo (scoped `Auto-retry` comment, back to Pending, worktree kept), parking to Blocked only what genuinely needs a human.

**Architecture:** Bunshin is process-only: the behavior change lives in the markdown driver (`template/driver.md`) and one gate brief; the JS side gains one pure config resolver (`resolveUnblock`) that pins the `unblock` block's semantics and validation, mirrored by the driver prose — the same pattern as `resolveConcurrency`/`resolveAutoPush`. Spec: `docs/superpowers/specs/2026-07-31-auto-unblock-design.md`.

**Tech Stack:** Node built-ins only (repo has zero npm deps). Ad-hoc `node test/<name>.test.js` tests chained in `package.json`'s `test` script.

## Global Constraints

- Defaults: `unblock` absent ⇒ `{ auto: true, maxRetries: 5 }` (ON by default). `maxRetries: 0` = classify but never retry.
- Validation: non-boolean `auto`, or non-integer / negative `maxRetries`, is a config error that names the offending key and `bunshin.config.json` — report, never guess.
- Retry counting: attempt number = 1 + count of existing issue comments starting with the literal marker `Auto-retry`. Human comments never consume budget.
- On auto-retry: transition **In Progress → Pending**, KEEP worktree AND branch. On human-needed park (and budget exhaustion): Blocked, worktree removed, branch kept — exactly today's behavior.
- Classification doubt → human-needed.
- `gates/review.md` must NOT be changed.
- All code/comments in English; repo commit style is Conventional Commits (`feat(...)`, `docs(...)`); every commit ends with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- Working directory for all commands: `C:\workspace\bunshin` (POSIX path `/c/workspace/bunshin`).

---

### Task 1: `resolveUnblock` resolver + unit test

**Files:**
- Modify: `src/util.js` (new function after `resolveConcurrency`, ~line 394; new export in the `module.exports` block ~line 579)
- Create: `test/unblock.test.js`
- Modify: `package.json` (append `&& node test/unblock.test.js` to the `test` script chain, before `test/orchestrator.test.js` to keep resolver tests grouped)

**Interfaces:**
- Consumes: `CONFIG_FILENAME` constant already defined in `src/util.js`.
- Produces: `resolveUnblock(config) -> { auto: boolean, maxRetries: number }`, exported from `src/util.js`. Task 5's template-guard test and Task 6's CLAUDE.md entry rely on this exact name and shape.

- [ ] **Step 1: Write the failing test**

Create `test/unblock.test.js` (mirrors `test/concurrency.test.js` style):

```js
'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/unblock.test.js
// Covers auto-unblock config resolution: resolveUnblock (top-level `unblock` ->
// { auto, maxRetries }). Absent block/keys => { auto: true, maxRetries: 5 } — auto-unblock is ON
// by default. auto: false restores park-everything; maxRetries: 0 = classify but never retry.
const assert = require('assert');
const { resolveUnblock } = require('../src/util');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('defaults to { auto: true, maxRetries: 5 } when unblock is absent', () => {
  for (const cfg of [undefined, null, {}, { unblock: undefined }, { unblock: null }, { unblock: {} }]) {
    assert.deepStrictEqual(resolveUnblock(cfg), { auto: true, maxRetries: 5 });
  }
});

test('auto: false is honored (maxRetries still defaults)', () => {
  assert.deepStrictEqual(resolveUnblock({ unblock: { auto: false } }), { auto: false, maxRetries: 5 });
});

test('explicit maxRetries values resolve, including 0', () => {
  assert.deepStrictEqual(resolveUnblock({ unblock: { maxRetries: 0 } }), { auto: true, maxRetries: 0 });
  assert.deepStrictEqual(resolveUnblock({ unblock: { maxRetries: 3 } }), { auto: true, maxRetries: 3 });
  assert.deepStrictEqual(resolveUnblock({ unblock: { auto: false, maxRetries: 9 } }), { auto: false, maxRetries: 9 });
});

test('a non-object unblock block throws referencing unblock', () => {
  for (const bad of ['yes', 5, true, [1]]) {
    assert.throws(() => resolveUnblock({ unblock: bad }), /unblock/i);
  }
});

test('non-boolean auto throws referencing unblock.auto', () => {
  for (const bad of ['true', 1, [], {}]) {
    assert.throws(() => resolveUnblock({ unblock: { auto: bad } }), /unblock\.auto/);
  }
});

test('non-integer or negative maxRetries throws referencing unblock.maxRetries', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, '5', true, [5]]) {
    assert.throws(() => resolveUnblock({ unblock: { maxRetries: bad } }), /unblock\.maxRetries/);
  }
});

test('errors name the config file', () => {
  assert.throws(() => resolveUnblock({ unblock: { auto: 'x' } }), /bunshin\.config\.json/);
  assert.throws(() => resolveUnblock({ unblock: { maxRetries: -1 } }), /bunshin\.config\.json/);
});

console.log(`\nunblock.test.js: ${passed} passed`);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /c/workspace/bunshin && node test/unblock.test.js`
Expected: FAIL — `TypeError: resolveUnblock is not a function` (not exported yet).

- [ ] **Step 3: Implement `resolveUnblock` in `src/util.js`**

Insert AFTER the `resolveConcurrency` function body (Read the file first; the function ends near line 405), following the comment style of its neighbors:

```js
// --- Auto-unblock (self-resolving gate failures) ---------------------------------
// When a gate fails, the driver classifies the failure: self-resolvable (fixable by editing the
// repo and re-running the gates) goals are sent back to Pending with a scoped `Auto-retry`
// comment — worktree and branch kept — while human-needed failures park to Blocked as before.
// The top-level `unblock` block tunes it: absent ⇒ { auto: true, maxRetries: 5 } (ON by
// default); `auto: false` restores park-everything; `maxRetries: 0` = classify but never retry.
// `resolveUnblock` is pure (no fs/spawn) so it is unit-testable; the driver reads the same
// `unblock` key and mirrors these semantics. Invalid values throw a clear key-referencing error
// rather than silently degrading.
function resolveUnblock(config) {
  const raw = config && config.unblock;
  if (raw == null) return { auto: true, maxRetries: 5 };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `Invalid unblock in ${CONFIG_FILENAME}: expected an object like {"auto": true, "maxRetries": 5}, got ` +
        `${JSON.stringify(raw)}.`
    );
  }
  const auto = raw.auto == null ? true : raw.auto;
  if (typeof auto !== 'boolean') {
    throw new Error(
      `Invalid unblock.auto in ${CONFIG_FILENAME}: expected a boolean (absent => true), got ` +
        `${JSON.stringify(raw.auto)}.`
    );
  }
  const maxRetries = raw.maxRetries == null ? 5 : raw.maxRetries;
  if (typeof maxRetries !== 'number' || !Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error(
      `Invalid unblock.maxRetries in ${CONFIG_FILENAME}: expected a whole number >= 0 (absent => 5), got ` +
        `${JSON.stringify(raw.maxRetries)}.`
    );
  }
  return { auto, maxRetries };
}
```

Then add `resolveUnblock,` to the `module.exports` block (alphabetical/grouped next to `resolveConcurrency`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /c/workspace/bunshin && node test/unblock.test.js`
Expected: all tests pass, `unblock.test.js: 7 passed`.

- [ ] **Step 5: Chain it into `package.json` and run the full suite**

In `package.json`'s `test` script, insert `node test/unblock.test.js && ` immediately before `node test/orchestrator.test.js`. Then run `cd /c/workspace/bunshin && npm test` — expected: every suite passes.

- [ ] **Step 6: Commit**

```bash
cd /c/workspace/bunshin
git add src/util.js test/unblock.test.js package.json
git commit -m "feat(unblock): resolveUnblock config resolver ({auto, maxRetries}, on by default)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: driver.md — AUTO-UNBLOCK section, classify-at-park in step 6, Rules amendment, comment-read adapter row

**Files:**
- Modify: `template/driver.md` (provider adapter table ~line 91-99; step 6 ~line 151-162; new section between `### Custom step {"skill"...}` and `## INTEGRATION` ~line 327; Rules bullet ~line 404-405)

**Interfaces:**
- Consumes: nothing from other tasks (prose only; the config semantics match Task 1's `resolveUnblock` exactly).
- Produces: the section heading `## AUTO-UNBLOCK (classify at park time)` and the comment marker `Auto-retry` — Task 3 and Task 4 reference both verbatim.

- [ ] **Step 1: Add a comment-read row to the provider adapter table**

Read `template/driver.md`. In the provider adapter table, after the row `| Comment on a goal | add a comment to the issue | add_comment |`, add:

```markdown
| Read a goal's comments | read the issue's comments (newest last) | `get_card` (comments/actions) |
```

- [ ] **Step 2: Rewrite step 6's failure path**

Replace (exact current text, starting at "If ANY gate failed"):

```markdown
   If ANY gate failed → PARK: transition the issue **→ Blocked** and comment
   `Blocked: <reason> (branch: <git.branchPrefix><N>-<slug>)`; remove the worktree
   (`git worktree remove --force <git.worktreeBaseDir>/<N>-<slug>`) but KEEP the branch.
```

with:

```markdown
   If ANY gate failed → run **AUTO-UNBLOCK (classify at park time)** (see the section below). A
   self-resolvable failure with retry budget left goes BACK TO PENDING with an `Auto-retry` comment —
   **keeping the worktree AND the branch**. Everything else (human-needed, budget exhausted, or
   `unblock.auto: false`) → PARK: transition the issue **→ Blocked** and comment
   `Blocked: <reason> (branch: <git.branchPrefix><N>-<slug>)`; remove the worktree
   (`git worktree remove --force <git.worktreeBaseDir>/<N>-<slug>`) but KEEP the branch.
```

(The WINDOWS long-path bullet that follows stays unchanged — it applies to the PARK path.)

- [ ] **Step 3: Insert the AUTO-UNBLOCK section**

Insert this whole section immediately BEFORE the `## INTEGRATION` heading:

```markdown
## AUTO-UNBLOCK (classify at park time)

Most gate failures do not need a human: an adversarial-review BLOCK arrives with concrete findings
that ARE the fix list for a retry. Instead of parking every failure, classify it first — controlled
by the config's OPTIONAL top-level `unblock` block: `{"auto": true|false, "maxRetries": <n>}`.
Absent block/keys ⇒ `auto: true`, `maxRetries: 5` (auto-unblock is ON by default). `auto: false` ⇒
skip this section entirely — every failure PARKS to Blocked exactly as the park steps describe. A
non-boolean `auto`, or a non-integer / negative `maxRetries`, is a config error — report it rather
than guessing. (`maxRetries: 0` = classify but never retry: self-resolvable failures still park,
with the classification stated in the park comment.) **ORCHESTRATOR MODE:** the top-level `unblock`
is the default; a `repositories[]` entry MAY carry its own `unblock` block that overrides it for
that repo only (same pattern as per-repo `gates`/`commands`).

Every PARK site routes through this classification: a gate failure (step 6), a merge re-gate
failure (INTEGRATION), an open-PR failure, triage's no-match/ambiguity, and the reaper's
"PR closed unmerged".

**The rubric:**

- **Self-resolvable** — the fix is achievable by editing THIS repository and re-running the gates.
  Typical: a `review` BLOCK citing code/copy defects (with or without prescribed fixes), failing
  `commands.gateChecks`, a `verify` functional failure, a Playwright infra flake (name it in the
  retry comment), a merge re-gate failure.
- **Human-needed** — resolving it requires anything outside the repository's and your reach:
  external dashboards / credentials / DNS / third-party services, a product or scope decision,
  spending or publishing approval, a triage no-match or ambiguous tie (never guess), a PR a human
  closed unmerged.
- **When in doubt → human-needed.** A wasted human look is cheaper than `maxRetries` wasted gate
  cycles; state the doubt in the park comment.

**Human-needed, or retry budget exhausted** → PARK to Blocked exactly as the park steps describe
(worktree removed, branch kept). When the budget is what stopped you, prefix the park reason:
`retry budget exhausted (<maxRetries> auto-retries) — <verdict>`.

**Self-resolvable with budget left** → retry:

1. **Attempt number** = 1 + the count of the issue's existing comments that START with the literal
   marker `Auto-retry` (read the issue's comments — see the provider adapter table). Deterministic
   and crash-safe across sessions. Comments written by humans — including manual unblock comments —
   NEVER count against the budget.
2. Attempt number > `maxRetries` ⇒ the budget is exhausted — PARK as above.
3. Comment on the issue: `Auto-retry <n>/<maxRetries>: Gate <position> (<name>) — ` followed by the
   FULL gate verdict, then the scoped retry instructions: the findings above are the COMPLETE fix
   list; resume on branch `<git.branchPrefix><N>-<slug>` from `<head sha>`; do NOT redo anything
   the verdict verified sound.
4. Transition the issue **In Progress → Pending** and **KEEP the worktree AND the branch** — no
   teardown, so the retry skips the fresh-worktree install (step 4 reuses it). The goal leaves the
   in-flight set (its `concurrency` slot frees); the normal loop re-takes it from Pending in board
   order, so other pending goals may interleave.

Heartbeat note: an auto-retry is NOT a park — never write `phase: "blocked"` for it; the goal simply
re-enters the normal phases when re-taken. `phase: "blocked"` / `blockedReason` stay reserved for
real (human-needed or budget-exhausted) parks.
```

- [ ] **Step 4: Amend the Rules bullet**

Replace:

```markdown
- PARK on the FIRST gate failure. No repair, no retry. Playwright infra flakes are parked too; name
  them in the reason so they're easy to re-queue (move the issue back to Pending).
```

with:

```markdown
- Gates run fail-fast: the FIRST failure stops the pipeline. The goal is then AUTO-RETRIED (if
  classified self-resolvable with retry budget left — see AUTO-UNBLOCK) or PARKED. Gates themselves
  never silently repair; a retry is a FRESH pipeline run with the previous verdict as its scope.
  Playwright infra flakes are self-resolvable — name them in the retry comment.
```

- [ ] **Step 5: Verify structure and commit**

Run `cd /c/workspace/bunshin && npm test` (the layout guards read `driver.md`; expected: all pass). Then:

```bash
cd /c/workspace/bunshin
git add template/driver.md
git commit -m "feat(unblock): driver classifies gate failures at park time and self-retries in-repo fixes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: driver.md — step 4 resume ladder + implement-gate resume context

**Files:**
- Modify: `template/driver.md` (step 4 ~line 136-143; `### Built-in gate implement` bullets ~line 245-257)

**Interfaces:**
- Consumes: the `Auto-retry` marker and AUTO-UNBLOCK section from Task 2.
- Produces: the phrase "On a RESUME" and the pass-the-verdict dispatch rule that Task 4's implement-brief note answers to.

- [ ] **Step 1: Rewrite step 4 with the resume ladder**

Replace:

```markdown
4. Create an isolated worktree on a fresh branch off `<git.baseBranch>`, under `<git.worktreeBaseDir>`:
   `git worktree add <git.worktreeBaseDir>/<N>-<slug> -b <git.branchPrefix><N>-<slug> <git.baseBranch>`
   All implementation/test work happens in that worktree directory.
```

with:

```markdown
4. Ensure the goal's isolated worktree exists — RESUME before you create (an auto-retried or
   manually-unblocked goal arrives from Pending with prior work on its branch):
   - If `<git.worktreeBaseDir>/<N>-<slug>` already exists and is checked out on branch
     `<git.branchPrefix><N>-<slug>` (a worktree KEPT by an auto-retry) → REUSE it as-is; skip
     `git worktree add`.
   - Else if branch `<git.branchPrefix><N>-<slug>` already exists (the post-park state — e.g. a
     manual unblock) → `git worktree add <git.worktreeBaseDir>/<N>-<slug> <git.branchPrefix><N>-<slug>`
     (NO `-b`), continuing from the branch head.
   - Else → create fresh:
     `git worktree add <git.worktreeBaseDir>/<N>-<slug> -b <git.branchPrefix><N>-<slug> <git.baseBranch>`
   All implementation/test work happens in that worktree directory. Either resume case is "a RESUME"
   wherever this driver says so.
```

(The ORCHESTRATOR MODE bullet under step 4 stays unchanged.)

- [ ] **Step 2: Pass the verdict to the implement agent, and allow the install skip**

In `### Built-in gate implement`, replace the dispatch bullet:

```markdown
- Dispatch the implement agent with the `Agent` tool (`subagent_type: general-purpose`), passing the
  brief `gates/implement.md`, the goal text (the issue summary), the branch
  name, and the worktree path.
```

with:

```markdown
- Dispatch the implement agent with the `Agent` tool (`subagent_type: general-purpose`), passing the
  brief `gates/implement.md`, the goal text (the issue summary), the branch
  name, and the worktree path. **On a RESUME** (step 4 found the branch/worktree already existing),
  ALSO pass the content of the issue's LATEST `Auto-retry` / `Blocked:` / unblock comment as the
  attempt's scope — the implement brief's "Retry attempts" section tells the agent how to use it.
```

And replace the install bullet's first line:

```markdown
- After it returns, run in the worktree: the config's `commands.install`, then `commands.gateChecks`.
```

with:

```markdown
- After it returns, run in the worktree: the config's `commands.install`, then `commands.gateChecks`.
  On a REUSED worktree whose dependency dir (e.g. `node_modules`) is already present, you MAY skip
  `commands.install`; `commands.gateChecks` always runs in full.
```

- [ ] **Step 3: Verify and commit**

Run `cd /c/workspace/bunshin && npm test` — expected: all pass. Then:

```bash
cd /c/workspace/bunshin
git add template/driver.md
git commit -m "feat(unblock): resume semantics — reuse kept worktrees/branches, feed prior verdict to implement

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: implement brief — "Retry attempts" note

**Files:**
- Modify: `template/gates/implement.md` (insert a new section between `## Context` and `## How to work (TDD)`)

**Interfaces:**
- Consumes: the driver passes "the latest `Auto-retry` / `Blocked:` / unblock comment" (Task 3).
- Produces: nothing downstream. `gates/review.md` is deliberately NOT touched.

- [ ] **Step 1: Insert the section**

Between the `## Context` section and `## How to work (TDD)`, insert:

```markdown
## Retry attempts
If the driver passed you a prior-attempt verdict (the content of an `Auto-retry` / `Blocked:` /
unblock comment), this branch already carries a previous attempt's work — do NOT start over. The
verdict's findings are your COMPLETE scope: fix exactly those, re-running only the checks they
touch. Do NOT redo, re-audit, or restructure work the verdict verified sound, and do NOT
re-litigate accepted findings. Your commit for the attempt follows the same rules as step 5 below.
```

- [ ] **Step 2: Verify and commit**

Run `cd /c/workspace/bunshin && npm test` — expected: all pass. Confirm `git diff --stat` touches ONLY `template/gates/implement.md` (review.md untouched). Then:

```bash
cd /c/workspace/bunshin
git add template/gates/implement.md
git commit -m "feat(unblock): implement brief learns retry-attempt scoping

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: config templates + template-guard tests

**Files:**
- Modify: `template/bunshin.config.template.json` (insert after the `concurrencyNote` line, ~line 89)
- Modify: `template/bunshin.orchestrator.template.json` (insert after its `concurrencyNote`, ~line 103; extend the `repositories` `$comment`)
- Modify: `test/unblock.test.js` (append template-guard tests)

**Interfaces:**
- Consumes: `resolveUnblock` from Task 1.
- Produces: an `unblock` block in both templates that resolves to the defaults.

- [ ] **Step 1: Write the failing template-guard tests**

Append to `test/unblock.test.js`, before the final `console.log`:

```js
const fs = require('fs');
const path = require('path');

test('both config templates carry an unblock block that resolves to the defaults', () => {
  for (const rel of ['template/bunshin.config.template.json', 'template/bunshin.orchestrator.template.json']) {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
    assert.ok(cfg.unblock, `${rel} is missing the unblock block`);
    assert.ok(typeof cfg.unblock.$comment === 'string' && cfg.unblock.$comment.length > 0, `${rel} unblock block needs a $comment`);
    assert.deepStrictEqual(resolveUnblock(cfg), { auto: true, maxRetries: 5 });
  }
});
```

Run: `cd /c/workspace/bunshin && node test/unblock.test.js`
Expected: FAIL — `template/bunshin.config.template.json is missing the unblock block`.

- [ ] **Step 2: Add the block to both templates**

In BOTH template JSONs, immediately after the `"concurrencyNote"` entry, insert:

```json
"unblock": {
  "$comment": "OPTIONAL. Auto-unblock: when a gate fails, the driver CLASSIFIES the failure instead of always parking. Self-resolvable failures (fixable by editing this repo and re-running the gates — e.g. a review BLOCK with concrete findings, failing gateChecks, a Playwright infra flake) go straight back to Pending with a scoped `Auto-retry <n>/<max>` comment, KEEPING the branch and worktree (fast retry, no re-install). Human-needed failures (external dashboards/credentials/DNS/third-party services, product or scope decisions, spending/publishing approval, triage ambiguity) park to Blocked as before — so the Blocked column MEANS 'needs a human'. auto: false restores the old park-everything behavior. maxRetries caps auto-retries per goal (absent => 5; 0 = classify but never retry); retries are counted from the issue's own `Auto-retry` comments, and human comments never consume budget.",
  "auto": true,
  "maxRetries": 5
},
```

In the ORCHESTRATOR template only, additionally find the `repositories` `$comment` sentence that lists per-repo overrides (`gates`/`commands`) and extend the list to include `unblock` (per-repo override, same shallow-merge pattern). Read the current sentence first and edit it in place, keeping its style.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cd /c/workspace/bunshin && node test/unblock.test.js`
Expected: all pass, `unblock.test.js: 8 passed`. Then `npm test` — all suites pass.

- [ ] **Step 4: Commit**

```bash
cd /c/workspace/bunshin
git add template/bunshin.config.template.json template/bunshin.orchestrator.template.json test/unblock.test.js
git commit -m "feat(unblock): unblock block in both config templates, guarded by tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: docs — README, CLAUDE.md, CHANGELOG

**Files:**
- Modify: `README.md` (new subsection after the concurrency section, ~line 352 area)
- Modify: `CLAUDE.md` (the pipeline summary ~lines 73-75; the `src/util.js` row of the file table ~line 172)
- Modify: `docs/CHANGELOG.md` (append entry)

**Interfaces:**
- Consumes: names/semantics fixed by Tasks 1-5 (`resolveUnblock`, `unblock.auto`, `unblock.maxRetries`, `Auto-retry` marker).
- Produces: nothing downstream; final task.

- [ ] **Step 1: README section**

Read `README.md` around the concurrency paragraph (~line 352) and insert after that section:

```markdown
### Auto-unblock — self-resolving gate failures

A failed gate does not always need you. By default the driver **classifies** every failure: if the
fix is achievable by editing the repo and re-running the gates (a review `BLOCK` with concrete
findings, failing `gateChecks`, a Playwright infra flake), the goal goes straight back to
**Pending** with a scoped `Auto-retry <n>/<max>` comment — branch and worktree kept, so the retry
skips the fresh-worktree install — and the loop re-takes it. Only failures that genuinely need a
human (external dashboards/credentials, product or scope decisions, triage ambiguity, a PR closed
unmerged) park to **Blocked** — so the Blocked column now *means* "needs a human". When in doubt,
the driver parks.

Tune it with a top-level `"unblock"` block in the config: `{ "auto": true, "maxRetries": 5 }` (the
defaults — auto-unblock is ON). `"auto": false` restores park-everything; `maxRetries` caps
auto-retries per goal (`0` = classify but never retry), counted from the issue's own `Auto-retry`
comments — comments written by humans never consume budget. In orchestrator mode each
`repositories[]` entry may override `unblock` per repo, like `gates`/`commands`.
```

- [ ] **Step 2: CLAUDE.md updates**

Read `CLAUDE.md` lines 60-90. Find the sentence stating that each goal "parks on" the first gate failure and rewrite it to state: gates run fail-fast; the first failure is CLASSIFIED (auto-unblock, `unblock` config, default on, `maxRetries` 5) — self-resolvable failures round-trip through Pending with an `Auto-retry` comment keeping branch + worktree, human-needed failures park to Blocked. Keep the surrounding sentence structure and length discipline of the file.

Then in the `src/util.js` row of the file table (~line 172), append to the resolver list (matching the existing bold-name style):

```markdown
**`resolveUnblock(config)`** (auto-unblock: top-level `unblock` → `{auto, maxRetries}`; absent ⇒ `{auto: true, maxRetries: 5}` = ON by default; `auto: false` restores park-everything; non-boolean `auto` / non-integer or negative `maxRetries` throws; unit-tested in `test/unblock.test.js`),
```

- [ ] **Step 3: CHANGELOG entry**

Read the tail of `docs/CHANGELOG.md` for the entry format, then append (newest at the end):

```markdown
- **auto-unblock**: the driver now classifies every gate failure at park time instead of always
  parking. Self-resolvable failures (in-repo fix + re-run gates) round-trip to Pending with a scoped
  `Auto-retry <n>/<max>` comment, keeping branch AND worktree (no re-install on retry); human-needed
  failures still park to Blocked, which now means "needs a human". New top-level `unblock` config
  (`{auto, maxRetries}`, default ON with 5 retries; per-repo override in orchestrator mode);
  `resolveUnblock` in `src/util.js` pins the semantics (`test/unblock.test.js`). Driver step 4 gained
  explicit resume semantics (reuse kept worktree → add worktree on existing branch → fresh), which
  also fixes manual unblocks; the implement brief gained a "Retry attempts" scoping note. Spec:
  `docs/superpowers/specs/2026-07-31-auto-unblock-design.md`.
```

- [ ] **Step 4: Full suite + commit**

Run `cd /c/workspace/bunshin && npm test` — expected: all suites pass. Then:

```bash
cd /c/workspace/bunshin
git add README.md CLAUDE.md docs/CHANGELOG.md
git commit -m "docs(unblock): README section, CLAUDE.md pipeline + resolver table, changelog entry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
