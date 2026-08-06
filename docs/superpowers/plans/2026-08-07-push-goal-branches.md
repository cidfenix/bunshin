# `git.pushBranches` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push each goal's branch to `merge.remote` at every point its content changes or it leaves the in-flight set, so an interrupted or parked goal can be resumed by another agent or another computer.

**Architecture:** One pure boolean resolver (`resolvePushBranches`) in `src/util.js` pins the config semantics and is unit-tested; the actual pushes are **markdown procedure** in `template/driver.md` (the driver owns the remote — gate briefs are untouched). Guard tests assert the shipped markdown and both config templates still document the key, so the resolver and the procedure cannot drift apart. This mirrors `merge.autoPush` exactly, feature for feature.

**Tech Stack:** Plain CommonJS on Node ≥ 18 built-ins. No dependencies, no build, no test framework — tests are plain-Node `assert` scripts run by `npm test`.

**Spec:** `docs/superpowers/specs/2026-08-07-push-goal-branches-design.md`

## Global Constraints

- **Zero runtime npm dependencies.** `src/` uses only `fs`, `path`, `child_process`. If you reach for a package, stop.
- **No test framework.** Tests are `node test/<name>.test.js` scripts using `assert`, following the exact shape of `test/autoPush.test.js`. Every new test file must be appended to the `test` script in `package.json` or it never runs.
- **Config key:** `git.pushBranches`, boolean, **absent ⇒ `true`**. The remote is the existing `merge.remote` (default `origin`). No new remote key.
- **Best-effort contract, everywhere:** no remote configured, or a push failing for any reason, is logged and the run continues. It never fails a gate, never parks a goal, never changes a gate verdict.
- **Cross-platform.** Use `path` — never hardcode separators. Forward-slash display paths in user-facing strings.
- **Files use LF endings.**
- **Commits:** Conventional Commits, scoped — stage explicit paths, never `git add -A`. End every message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Changelog, not CLAUDE.md:** the running log goes in `docs/CHANGELOG.md`. `CLAUDE.md` is edited in place only where a durable fact changed.

---

### Task 1: The `resolvePushBranches` resolver

**Files:**
- Create: `test/pushBranches.test.js`
- Modify: `src/util.js` (add the resolver after `resolveAutoPush`, which ends at line 384; add the export beside `resolveAutoPush` in the `module.exports` block)
- Modify: `package.json:9` (the `test` script)

**Interfaces:**
- Consumes: `CONFIG_FILENAME` (already defined at the top of `src/util.js`, value `bunshin.config.json`).
- Produces: `resolvePushBranches(config) -> boolean`, exported from `src/util.js`. Throws `Error` on a non-boolean. Later tasks reference the key name `git.pushBranches` in markdown only — no other code consumes this.

- [ ] **Step 1: Write the failing test**

Create `test/pushBranches.test.js`:

```js
'use strict';

// Ad-hoc smoke test (Node built-ins only). Run: node test/pushBranches.test.js
// Covers git.pushBranches: resolvePushBranches (config -> whether the driver pushes each goal
// branch to merge.remote after every commit / at park / at auto-retry). Absent ⇒ true.
// Best-effort at the call site (no remote / a failed push never parks a goal) — this resolver
// only validates the boolean.
const assert = require('assert');
const { resolvePushBranches } = require('../src/util');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('resolvePushBranches returns true when git.pushBranches is absent/null', () => {
  for (const cfg of [
    undefined,
    null,
    {},
    { git: {} },
    { git: { pushBranches: undefined } },
    { git: { pushBranches: null } },
  ]) {
    assert.strictEqual(resolvePushBranches(cfg), true);
  }
});

test('an explicit boolean passes through', () => {
  assert.strictEqual(resolvePushBranches({ git: { pushBranches: true } }), true);
  assert.strictEqual(resolvePushBranches({ git: { pushBranches: false } }), false);
});

test('non-boolean values throw referencing git.pushBranches', () => {
  assert.throws(() => resolvePushBranches({ git: { pushBranches: 'true' } }), /git\.pushBranches/);
  assert.throws(() => resolvePushBranches({ git: { pushBranches: 1 } }), /git\.pushBranches/);
  assert.throws(() => resolvePushBranches({ git: { pushBranches: [] } }), /git\.pushBranches/);
  assert.throws(() => resolvePushBranches({ git: { pushBranches: {} } }), /git\.pushBranches/);
});

test('the error names the config file', () => {
  assert.throws(() => resolvePushBranches({ git: { pushBranches: 'true' } }), /bunshin\.config\.json/);
});

test('it is independent of merge.autoPush (base-branch push, a different knob)', () => {
  assert.strictEqual(resolvePushBranches({ git: { pushBranches: false }, merge: { autoPush: true } }), false);
  assert.strictEqual(resolvePushBranches({ git: { pushBranches: true }, merge: { autoPush: false } }), true);
});

console.log(`\npushBranches.test.js: ${passed} passed`);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/pushBranches.test.js`
Expected: FAIL — `TypeError: resolvePushBranches is not a function`.

- [ ] **Step 3: Implement the resolver**

In `src/util.js`, insert immediately **after** the closing brace of `resolveAutoPush` (line 384) and before the `// --- Configurable concurrency` comment block:

```js
// --- Configurable goal-branch push (crash/hand-off durability) -----------------
// A goal's work lives on `<git.branchPrefix><N>-<slug>` inside a local worktree until it merges,
// so an agent that stops — or a goal parked to Blocked — leaves that work on exactly ONE disk.
// `git.pushBranches` (default true) has the driver push the goal branch to `merge.remote` after
// every gate that may have committed, at PARK, and at auto-retry, and lets driver step 4 resume a
// goal from `<remote>/<branch>` on a DIFFERENT machine. It sits in the `git` block because it is
// branch-lifecycle, not integration — the sibling knob `merge.autoPush` pushes the BASE branch
// after a merge. Best-effort at the call site (no remote / a failed push never fails or parks the
// goal, preserving the "auto mode needs no remote" guarantee) — this resolver only validates the
// boolean. `resolvePushBranches` is pure (no fs/spawn) so it is unit-testable. A non-boolean value
// throws a clear `git.pushBranches`-referencing error.
function resolvePushBranches(config) {
  const raw = config && config.git && config.git.pushBranches;
  if (raw == null) return true;
  if (typeof raw !== 'boolean') {
    throw new Error(
      `Invalid git.pushBranches in ${CONFIG_FILENAME}: expected a boolean (absent => true), got ` +
        `${JSON.stringify(raw)}.`
    );
  }
  return raw;
}
```

Then add the export to the `module.exports` object, on the line immediately after `resolveAutoPush,`:

```js
  resolvePushBranches,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/pushBranches.test.js`
Expected: PASS — `pushBranches.test.js: 5 passed`.

- [ ] **Step 5: Wire it into `npm test`**

In `package.json:9`, inside the `test` script, replace:

```
node test/autoPush.test.js &&
```

with:

```
node test/autoPush.test.js && node test/pushBranches.test.js &&
```

(It is one long single-line script — edit the substring in place, keeping it on one line.)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, and `pushBranches.test.js: 5 passed` appears in the output.

- [ ] **Step 7: Commit**

```bash
git add src/util.js test/pushBranches.test.js package.json
git commit -m "feat(push-branches): resolvePushBranches — git.pushBranches config resolver

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: The key in both config templates

**Files:**
- Modify: `template/bunshin.config.template.json` (the `git` block, lines 69-74)
- Modify: `template/bunshin.orchestrator.template.json` (the `git` block, lines 80-85)
- Modify: `test/pushBranches.test.js` (append guard tests)

**Interfaces:**
- Consumes: `resolvePushBranches` from Task 1 — the guard tests parse each template and assert the resolver accepts its shipped value.
- Produces: the shipped default `"pushBranches": true` in both templates. Nothing consumes it in code; the driver (Task 3) reads it at run time.

- [ ] **Step 1: Write the failing guard tests**

Append to `test/pushBranches.test.js`, **before** the final `console.log` line:

```js
// --- Shipped-artifact guards --------------------------------------------------
// The resolver and the artifacts consumers actually receive must not drift apart.
const fs = require('fs');
const path = require('path');
const repoRoot = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

test('both config templates ship git.pushBranches: true with a note', () => {
  for (const rel of [
    'template/bunshin.config.template.json',
    'template/bunshin.orchestrator.template.json',
  ]) {
    const cfg = readJson(rel);
    assert.strictEqual(cfg.git.pushBranches, true, `${rel} must ship git.pushBranches: true`);
    assert.ok(
      typeof cfg.git.pushBranchesNote === 'string' && cfg.git.pushBranchesNote.length > 40,
      `${rel} must explain git.pushBranches in a pushBranchesNote`
    );
    assert.strictEqual(resolvePushBranches(cfg), true, `${rel}'s shipped value must resolve`);
  }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/pushBranches.test.js`
Expected: FAIL — `template/bunshin.config.template.json must ship git.pushBranches: true`.

- [ ] **Step 3: Add the key to the single-repo template**

In `template/bunshin.config.template.json`, replace the `git` block:

```json
  "git": {
    "$comment": "Worktree + branch conventions. The driver creates one isolated worktree per goal at <worktreeBaseDir>/<N>-<slug> on branch <branchPrefix><N>-<slug> cut from <baseBranch>, where N = the card's Trello idShort and slug = kebab-cased card name (~5 words).",
    "baseBranch": "{{BASE_BRANCH}}",
    "branchPrefix": "goal/",
    "worktreeBaseDir": "{{WORKTREE_BASE_DIR}}"
  },
```

with:

```json
  "git": {
    "$comment": "Worktree + branch conventions. The driver creates one isolated worktree per goal at <worktreeBaseDir>/<N>-<slug> on branch <branchPrefix><N>-<slug> cut from <baseBranch>, where N = the card's Trello idShort and slug = kebab-cased card name (~5 words).",
    "baseBranch": "{{BASE_BRANCH}}",
    "branchPrefix": "goal/",
    "worktreeBaseDir": "{{WORKTREE_BASE_DIR}}",
    "pushBranches": true,
    "pushBranchesNote": "OPTIONAL. Push each GOAL branch to merge.remote as it progresses — after every gate that may have committed, at PARK (Blocked) and at auto-retry — so the work survives the machine that produced it: another agent, or you on another computer, can resume a parked goal (the driver fetches <remote>/<branch> when no local branch exists). Absent ⇒ true. Best-effort: no remote configured, or a failed push, is logged and the goal continues — never a gate failure, never a park, so the 'auto mode needs no remote' guarantee holds. On a successful auto-mode merge the remote goal branch is DELETED along with the local one (merged goal branches are ephemeral checkpoints; parked ones are always kept). Set false to keep goal branches strictly local. NOTE: this is the GOAL branch; merge.autoPush is the separate knob for pushing the BASE branch after a merge."
  },
```

- [ ] **Step 4: Add the key to the orchestrator template**

In `template/bunshin.orchestrator.template.json`, replace the `git` block:

```json
  "git": {
    "$comment": "Branch + worktree conventions applied inside EACH target repository (the one triage picks). The driver cuts the worktree off that repo's baseBranch (a repository entry can override `baseBranch`). `worktreeBaseDir` is where per-goal worktrees are created for the chosen repo (relative to that repo, or absolute).",
    "baseBranch": "{{BASE_BRANCH}}",
    "branchPrefix": "goal/",
    "worktreeBaseDir": "{{WORKTREE_BASE_DIR}}"
  },
```

with:

```json
  "git": {
    "$comment": "Branch + worktree conventions applied inside EACH target repository (the one triage picks). The driver cuts the worktree off that repo's baseBranch (a repository entry can override `baseBranch`). `worktreeBaseDir` is where per-goal worktrees are created for the chosen repo (relative to that repo, or absolute).",
    "baseBranch": "{{BASE_BRANCH}}",
    "branchPrefix": "goal/",
    "worktreeBaseDir": "{{WORKTREE_BASE_DIR}}",
    "pushBranches": true,
    "pushBranchesNote": "OPTIONAL. Push each GOAL branch to the triaged repository's merge.remote as it progresses — after every gate that may have committed, at PARK (Blocked) and at auto-retry — so the work survives the machine that produced it: another agent, or you on another computer, can resume a parked goal (the driver fetches <remote>/<branch> when no local branch exists). Absent ⇒ true. Best-effort: no remote configured, or a failed push, is logged and the goal continues — never a gate failure, never a park. On a successful auto-mode merge the remote goal branch is DELETED along with the local one. This is orchestrator-GLOBAL (no per-repository override). Set false to keep goal branches strictly local. NOTE: this is the GOAL branch; merge.autoPush is the separate knob for pushing the BASE branch after a merge."
  },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node test/pushBranches.test.js`
Expected: PASS — `pushBranches.test.js: 6 passed`.

- [ ] **Step 6: Verify both templates are still valid JSON that `init` can render**

Run: `npm test`
Expected: the full suite passes.

Then render each template through the real `init` (it writes into an existing directory, so create
one first — this one-liner is cross-platform and cleans up after itself):

```bash
node -e "const os=require('os'),fs=require('fs'),path=require('path'),cp=require('child_process');const d=fs.mkdtempSync(path.join(os.tmpdir(),'bunshin-pb-'));for(const a of [[],['--orchestrator']]){cp.execFileSync(process.execPath,['bin/bunshin.js','init','--dir',d,'--name','Demo','--board-id','X',...a],{stdio:'inherit'});}const f=(n)=>JSON.parse(fs.readFileSync(path.join(d,n),'utf8')).git.pushBranches;console.log('single-repo:',f('bunshin.config.json'),'orchestrator:',f('bunshin.orchestrator.json'));fs.rmSync(d,{recursive:true,force:true});"
```

Expected: both `init` runs succeed, then `single-repo: true orchestrator: true`.

- [ ] **Step 7: Commit**

```bash
git add template/bunshin.config.template.json template/bunshin.orchestrator.template.json test/pushBranches.test.js
git commit -m "feat(push-branches): git.pushBranches in both config templates, guarded by tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Driver procedure — the eight push points

**Files:**
- Modify: `template/driver.md` (eight edits, anchors below)
- Modify: `test/pushBranches.test.js` (append the driver guard test)

**Interfaces:**
- Consumes: the config key documented in Task 2.
- Produces: the shipped procedure. Nothing in `src/` reads it — `bunshin run` hands Claude Code the path to this file.

Do the guard test first (Steps 1-2), then all eight edits (Step 3), then re-run (Step 4). The edits are one coherent deliverable: a half-applied set would ship a contradictory procedure.

- [ ] **Step 1: Write the failing guard test**

Append to `test/pushBranches.test.js`, **before** the final `console.log` line:

```js
test('driver.md documents every git.pushBranches behaviour', () => {
  const driver = read('template/driver.md');
  assert.ok(driver.includes('git.pushBranches'), 'driver.md must name the git.pushBranches key');
  assert.ok(
    /--force-with-lease/.test(driver),
    'driver.md must force-with-lease the PR-mode branch push (the rebase rewrites pushed shas)'
  );
  assert.ok(
    /push\s+<merge\.remote>\s+--delete/.test(driver),
    'driver.md must delete the remote goal branch after an auto-mode merge'
  );
  assert.ok(
    /pushed to <merge\.remote>/.test(driver),
    'driver.md must name the pushed ref in the park comment so a second machine can resume'
  );
  assert.ok(
    /git fetch <merge\.remote> <git\.branchPrefix><N>-<slug>/.test(driver),
    'driver.md step 4 must be able to resume a goal from the remote branch'
  );
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/pushBranches.test.js`
Expected: FAIL — `driver.md must name the git.pushBranches key`.

- [ ] **Step 3: Apply all eight edits to `template/driver.md`**

**Edit A — the contract paragraph.** After the "Changelog, not CLAUDE.md" paragraph (it ends `…so each repo keeps its own changelog.`, line 63) and before the `## The queue (Trello or Jira)` heading, insert a blank line and:

```markdown
**Branch checkpoints (`git.pushBranches`).** A goal's work lives on `<git.branchPrefix><N>-<slug>`
inside a local worktree until it merges — so an agent that stops, or a goal parked to **Blocked**,
leaves that work on exactly ONE disk. Unless the config sets `git.pushBranches` to `false` (absent ⇒
**true**), push the goal branch to `<merge.remote>` (default `origin`) at each of these moments:
**after every gate step that completes** (step 5 — covers the `implement` commit, the `verify`
screenshot commit, and any custom gate that commits), **at PARK**, and **at auto-retry** (step 6).
The command is always `git -C <git.worktreeBaseDir>/<N>-<slug> push -u <merge.remote>
<git.branchPrefix><N>-<slug>` — idempotent, and a no-op (`Everything up-to-date`) when nothing is new.
**Every one of these pushes is BEST-EFFORT: no remote named `merge.remote`, or a push failing for any
reason, is reported and the run CONTINUES — it never fails a gate, never parks a goal, and never
changes a gate verdict** (the "auto mode needs no remote" guarantee is preserved). This is the GOAL
branch; `merge.autoPush` is the separate knob for the BASE branch after a merge. See also step 4's
resume-from-remote rung — that is what lets another agent, or you on another computer, pick a parked
goal back up.
```

**Edit B — sandbox exception.** In the **Sandbox awareness** paragraph, replace:

```markdown
detect or care about this — the pipeline is identical — with one nuance at INTEGRATION: in **auto** mode
you do the usual local `--ff-only` merge into *this clone's* `<git.baseBranch>` and **do not push
anywhere**; the Bunshin CLI on the host fast-forwards its own base branch from the clone after you exit.
In **PR** mode you push + open the PR against the remote exactly as today (the clone's `origin` already
points at the real remote). Nothing else changes.
```

with:

```markdown
detect or care about this — the pipeline is identical — with one nuance at INTEGRATION: in **auto** mode
you do the usual local `--ff-only` merge into *this clone's* `<git.baseBranch>` and **do not push
anywhere**; the Bunshin CLI on the host fast-forwards its own base branch from the clone after you exit.
In **PR** mode you push + open the PR against the remote exactly as today (the clone's `origin` already
points at the real remote). The same split applies to `git.pushBranches` (below): **sandboxed + auto
mode ⇒ skip the goal-branch pushes entirely** — the clone's `origin` is the HOST REPOSITORY PATH, so
pushing there would not help a second machine and would write the host `.git`, which the sandbox
guarantees forbid. Sandboxed **PR** mode pushes goal branches normally. Nothing else changes.
```

**Edit C — step 4's resume-from-remote rung.** Replace:

```markdown
   - Else if branch `<git.branchPrefix><N>-<slug>` already exists (the post-park state — e.g. a
     manual unblock) → `git worktree add <git.worktreeBaseDir>/<N>-<slug> <git.branchPrefix><N>-<slug>`
     (NO `-b`), continuing from the branch head.
   - Else → create fresh:
```

with:

```markdown
   - Else if branch `<git.branchPrefix><N>-<slug>` already exists (the post-park state — e.g. a
     manual unblock) → `git worktree add <git.worktreeBaseDir>/<N>-<slug> <git.branchPrefix><N>-<slug>`
     (NO `-b`), continuing from the branch head.
   - Else if `git.pushBranches` is not `false` AND the branch exists ON THE REMOTE — a goal another
     agent (or another COMPUTER) checkpointed and left, typically parked to Blocked and unblocked
     here → `git fetch <merge.remote> <git.branchPrefix><N>-<slug>` then
     `git worktree add <git.worktreeBaseDir>/<N>-<slug> -b <git.branchPrefix><N>-<slug> FETCH_HEAD`,
     continuing from the pushed head instead of discarding it. Check with
     `git ls-remote --exit-code --heads <merge.remote> <git.branchPrefix><N>-<slug>`; ANY failure
     here (no remote, no such branch, network down) is not an error — fall through to the fresh
     rung below.
   - Else → create fresh:
```

**Edit D — push after each gate step.** In the **GATES (the configurable pipeline)** section, replace:

```markdown
**AUTO-UNBLOCK** — retry or PARK. Number the gates by their **1-based position** for heartbeats
(1st→`gate1`, 2nd→`gate2`, 3rd+→`gate3`) and for the reason (`Gate <position> (<name>): <short error>`).
```

with:

```markdown
**AUTO-UNBLOCK** — retry or PARK. Number the gates by their **1-based position** for heartbeats
(1st→`gate1`, 2nd→`gate2`, 3rd+→`gate3`) and for the reason (`Gate <position> (<name>): <short error>`).

**After EACH gate step completes** (passing or failing), checkpoint the branch: unless
`git.pushBranches` is `false` — or you are sandboxed in `auto` mode — run
`git -C <git.worktreeBaseDir>/<N>-<slug> push -u <merge.remote> <git.branchPrefix><N>-<slug>`.
This is what puts the `implement` gate's commit, the `verify` gate's screenshot commit, and any
custom `command`/`skill` gate's commit beyond the reach of the machine you are on. The driver owns
this push — the gate briefs never push. **Best-effort: report a failure and carry on** (a failed
checkpoint must never turn a passing gate into a failure, nor a failing gate into a different one).
```

**Edit E — the park comment.** Replace:

```markdown
   `unblock.auto: false`) → PARK: transition the issue **→ Blocked** and comment
   `Blocked: <reason> (branch: <git.branchPrefix><N>-<slug>)`; remove the worktree
```

with:

```markdown
   `unblock.auto: false`) → PARK: push the branch first (`git.pushBranches`, best-effort — the
   parked branch is exactly what a human or another machine will resume from), transition the issue
   **→ Blocked** and comment
   `Blocked: <reason> (branch: <git.branchPrefix><N>-<slug>, pushed to <merge.remote>)` — if the
   push did not happen (disabled, no remote, or it failed), say so in the comment instead of naming
   a ref that isn't there; remove the worktree
```

**Edit F — the auto-retry comment + teardown.** In the **AUTO-UNBLOCK** section, replace:

```markdown
3. Comment on the issue: `Auto-retry <n>/<maxRetries>: Gate <position> (<name>) — ` followed by the
   FULL gate verdict, then the scoped retry instructions: the findings above are the COMPLETE fix
   list; resume on branch `<git.branchPrefix><N>-<slug>` from `<head sha>`; do NOT redo anything
   the verdict verified sound.
```

with:

```markdown
3. Push the branch (`git.pushBranches`, best-effort — see **Branch checkpoints** above), then
   comment on the issue: `Auto-retry <n>/<maxRetries>: Gate <position> (<name>) — ` followed by the
   FULL gate verdict, then the scoped retry instructions: the findings above are the COMPLETE fix
   list; resume on branch `<git.branchPrefix><N>-<slug>` from `<head sha>` (pushed to
   `<merge.remote>` — omit this if the push was disabled or failed); do NOT redo anything
   the verdict verified sound.
```

**Edit G — delete the remote branch after an auto merge.** In **INTEGRATION → mode `auto`**, replace:

```markdown
4. Clean up: `git worktree remove <git.worktreeBaseDir>/<N>-<slug>` and
   `git branch -d <git.branchPrefix><N>-<slug>`. (On Windows, if `git worktree remove` fails with
   "Filename too long", delete the dir with a long-path-safe method then `git worktree prune` — see
   the PARK note.)
```

with:

```markdown
4. Clean up: `git worktree remove <git.worktreeBaseDir>/<N>-<slug>` and
   `git branch -d <git.branchPrefix><N>-<slug>`. (On Windows, if `git worktree remove` fails with
   "Filename too long", delete the dir with a long-path-safe method then `git worktree prune` — see
   the PARK note.) If you pushed this branch (`git.pushBranches`), delete it on the remote too:
   `git push <merge.remote> --delete <git.branchPrefix><N>-<slug>` — **best-effort**, and only for a
   MERGED goal (the checkpoint has served its purpose; the work is on `<git.baseBranch>`). Parked
   branches are NEVER deleted, locally or remotely — that is the point of keeping them.
```

**Edit H — force-with-lease in PR mode.** In **INTEGRATION → mode `pr`**, replace:

```markdown
2. Push the branch: `git -C <worktree> push -u <merge.remote> <git.branchPrefix><N>-<slug>`.
```

with:

```markdown
2. Push the branch: `git -C <worktree> push -u --force-with-lease <merge.remote>
   <git.branchPrefix><N>-<slug>`. The `--force-with-lease` is REQUIRED whenever `git.pushBranches`
   checkpointed this branch earlier: step 1 just rebased it, rewriting the shas already on the
   remote, so a plain push would be rejected as non-fast-forward. It is safe because Bunshin is the
   sole writer of `<git.branchPrefix>*` branches, and `--force-with-lease` still refuses if someone
   else moved the ref. (Harmless when nothing was pushed before.) Unlike the checkpoint pushes, THIS
   push is not best-effort — PR mode cannot open a PR without it, so a failure routes through
   **AUTO-UNBLOCK** like the open-PR step below.
```

- [ ] **Step 4: Run the guard test**

Run: `node test/pushBranches.test.js`
Expected: PASS — `pushBranches.test.js: 7 passed`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. (`test/gates-layout.test.js` and `test/changelog.test.js` also read `template/driver.md` — they must still pass.)

- [ ] **Step 6: Re-read the edited sections for coherence**

Read `template/driver.md` start to finish and confirm: no remaining statement claims goal branches stay local; the sandbox exception is stated once and matches Edits A/D; the park comment and the auto-retry comment both hedge when no push happened. Fix any contradiction inline.

- [ ] **Step 7: Commit**

```bash
git add template/driver.md test/pushBranches.test.js
git commit -m "feat(push-branches): driver checkpoints goal branches to the remote

Pushes after every gate step, at PARK and at auto-retry; resumes a goal from
<remote>/<branch> when no local branch exists; deletes the remote branch after an
auto merge; force-with-lease on the PR-mode push (the rebase rewrites pushed shas);
skipped when sandboxed in auto mode.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Documentation

**Files:**
- Modify: `README.md` (the auto-mode bullet in the pipeline walkthrough, around line 335)
- Modify: `CLAUDE.md` (LOCKED decision 5; the `src/util.js` row of the Key files table)
- Modify: `docs/CHANGELOG.md` (append one entry at the end)

**Interfaces:**
- Consumes: everything from Tasks 1-3. Nothing depends on this task.

- [ ] **Step 1: README — document the knob**

In `README.md`, in the numbered pipeline walkthrough, replace the `auto` bullet:

```markdown
   - **`auto`** (default): rebase, re-run `gateChecks`, fast-forward merge into the base branch, card
     → **Done**. No remote or GitHub needed. If a remote *is* configured, `merge.autoPush` (default
     `true`) pushes the base branch right after each merge so it doesn't silently drift ahead of the
     remote — best-effort (no remote, or a failed push, is logged and never blocks the goal); set it
     to `false` to keep the fully local behavior.
```

with:

```markdown
   - **`auto`** (default): rebase, re-run `gateChecks`, fast-forward merge into the base branch, card
     → **Done**. No remote or GitHub needed. If a remote *is* configured, `merge.autoPush` (default
     `true`) pushes the base branch right after each merge so it doesn't silently drift ahead of the
     remote — best-effort (no remote, or a failed push, is logged and never blocks the goal); set it
     to `false` to keep the fully local behavior. The merged goal branch is then deleted locally, and
     on the remote if it was checkpointed there (see below).
```

Then, immediately after the numbered walkthrough's closing paragraph, add a subsection:

```markdown
### Branch checkpoints — resuming from another machine

A goal's work sits on `goal/<N>-<slug>` in a local worktree until it merges, so an agent that stops
mid-run — or a goal parked to **Blocked** — would leave that work on one disk. **`git.pushBranches`**
(default `true`) pushes the goal branch to `merge.remote` after every gate that may have committed,
at park, and at auto-retry. If no local branch exists when the goal is re-taken, the driver fetches
`<remote>/goal/<N>-<slug>` and resumes from it — so a second agent, or you on a different computer,
can pick up a parked goal exactly where it stopped.

Every checkpoint push is **best-effort**: no remote configured, or a push that fails, is logged and
the goal continues — it never fails a gate and never parks anything, so auto mode still needs no
remote. Once a goal merges, its remote branch is deleted along with the local one; parked branches
are always kept. Set `git.pushBranches` to `false` to keep goal branches strictly local. It is the
goal-branch counterpart to `merge.autoPush`, which pushes the *base* branch after a merge.
```

- [ ] **Step 2: CLAUDE.md — LOCKED decision 5**

In `CLAUDE.md`, decision 5 ends with the sandbox paragraph, whose last sentence is
`` `--sandbox --orchestrator` errors (out of scope for now). ``. Leave every existing sentence of
decision 5 untouched and append this NEW paragraph directly after that sentence, as the decision's
final paragraph (same 3-space indentation as the rest of the decision body):

```markdown
   **Branch checkpoints (`git.pushBranches`, default `true`):** the goal branch itself is pushed to
   `merge.remote` after every gate step that may have committed, at PARK, and at auto-retry, so a
   stopped agent or a parked goal does not strand its work on one disk; driver step 4 gained a rung
   that resumes a goal from `<remote>/<branch>` when no local branch exists (the "another computer"
   path). Every such push is **best-effort** — no remote, or a failed push, is logged and the goal
   continues, so the "auto mode needs no remote" guarantee above still holds. A MERGED goal's remote
   branch is deleted alongside the local one; parked branches are kept. Sandboxed `auto` runs skip
   these pushes (the clone's `origin` is the host repo path — pushing there would write the host
   `.git`, which decision 5's sandbox rules forbid); sandboxed PR runs push normally. PR mode's
   integration push is `--force-with-lease`, since the pre-PR rebase rewrites already-pushed shas.
   It sits in the `git` block (branch lifecycle), NOT in `merge` — distinct from `merge.autoPush`,
   which pushes the BASE branch. Pure `resolvePushBranches()` in `src/util.js` (unit-tested in
   `test/pushBranches.test.js`, which also guards both config templates and the shipped driver text).
```

- [ ] **Step 3: CLAUDE.md — the `src/util.js` Key files row**

In the Key files table's `src/util.js` row, immediately after the `**`resolveAutoPush(config)`** (…unit-tested in `test/autoPush.test.js`)` clause, insert:

```markdown
, **`resolvePushBranches(config)`** (goal-branch checkpoints: `git.pushBranches` → whether the driver pushes each goal branch to `merge.remote` after every committing gate / at park / at auto-retry, enabling the resume-from-remote rung; absent ⇒ `true`; non-boolean throws; best-effort at the call site; DISTINCT from `merge.autoPush`, which pushes the BASE branch; unit-tested in `test/pushBranches.test.js`)
```

- [ ] **Step 4: Append the changelog entry**

Append to the END of `docs/CHANGELOG.md`:

```markdown
- **push goal branches**: goal branches are now checkpointed to `merge.remote` instead of living only
  on the machine that produced them. New `git.pushBranches` config (boolean, absent ⇒ `true`;
  `resolvePushBranches` in `src/util.js`, `test/pushBranches.test.js` — which also guards both config
  templates and the shipped driver text). The driver pushes `<branchPrefix><N>-<slug>` after every
  gate step that may have committed, at PARK, and at auto-retry, and gained a step-4 resume rung that
  fetches `<remote>/<branch>` when no local branch exists — that rung is what lets a second agent, or
  a different computer, resume a parked goal. Every checkpoint push is best-effort (no remote / a
  failed push is logged, never a gate failure or a park), so auto mode still needs no remote. A merged
  goal's remote branch is deleted with its local one; parked branches are kept. PR-mode integration
  now pushes with `--force-with-lease` — the pre-PR rebase rewrites shas the checkpoints already
  pushed, which a plain push would reject. Sandboxed auto runs skip the pushes (the clone's `origin`
  is the host repo path). Placed in the `git` block, deliberately distinct from `merge.autoPush` (base
  branch). Design: `docs/superpowers/specs/2026-08-07-push-goal-branches-design.md`.
```

- [ ] **Step 5: Verify**

Run: `npm test`
Expected: PASS — including `test/changelog.test.js`, which reads `docs/CHANGELOG.md` and `template/driver.md`.

- [ ] **Step 6: Confirm the docs match what shipped**

Re-read the three edited docs against `template/driver.md`. Every claim must be true of the shipped procedure: the default, the push points, the best-effort contract, the sandbox exception, the delete-on-merge, and `--force-with-lease`. Fix any drift inline.

- [ ] **Step 7: Commit**

```bash
git add README.md CLAUDE.md docs/CHANGELOG.md
git commit -m "docs(push-branches): README section, CLAUDE.md decision 5 + resolver row, changelog entry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `npm test` passes in full.
- [ ] `node bin/bunshin.js --help` still runs.
- [ ] `git log --oneline -4` shows four scoped commits, each with the `Co-Authored-By:` trailer.
- [ ] `git status` is clean.
