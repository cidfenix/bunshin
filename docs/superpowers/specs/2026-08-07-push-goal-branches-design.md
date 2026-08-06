# Push goal branches to the remote (`git.pushBranches`) — design

**Date:** 2026-08-07
**Status:** approved, ready for an implementation plan

## Problem

A goal's work lives on a local branch inside a local worktree until it merges. If the agent stops —
the machine sleeps, the container dies, the `/loop` session is killed — every commit made so far
exists on exactly one disk. The same is true of a goal parked to **Blocked**: the driver keeps the
branch (deliberately), but only locally, so a human or a second agent can only pick it up on the
machine that produced it.

Bunshin already pushes the *base* branch after each auto-mode merge (`merge.autoPush`). Nothing
pushes the *goal* branch.

## Solution

A configurable, best-effort push of each goal branch to `merge.remote` at every point where its
content changes or it leaves the in-flight set, plus a driver resume path that can pick a goal back
up from the remote when no local branch exists.

### The config knob

**`git.pushBranches`** — boolean, absent ⇒ `true`.

Placed in the `git` block because it concerns the *goal branch lifecycle*, alongside `branchPrefix`,
`baseBranch` and `worktreeBaseDir` — not integration. The remote is the existing **`merge.remote`**
(default `origin`); no new remote key is introduced.

It is the sibling of `merge.autoPush` and inherits the same **best-effort contract**: no remote
configured, or a push failing for any reason, is logged and the run continues. It never fails a gate,
never parks a goal, and never changes a gate verdict. This is what allows the default to be `true`
without violating LOCKED decision 5's "auto mode needs no remote" guarantee.

`resolvePushBranches(config)` in `src/util.js` is pure (no fs/spawn) and unit-testable: absent/null ⇒
`true`, an explicit boolean passes through, any non-boolean throws an error naming
`git.pushBranches` and the config filename. It mirrors `resolveAutoPush` exactly.

### Driver behaviour (`template/driver.md`)

All pushes below happen only when `git.pushBranches` resolves true, and all are best-effort.

1. **After each gate step completes** — `git -C <worktree> push -u <merge.remote> <branch>`.
   This covers the `implement` gate's goal commit, the `verify` gate's screenshot commit, and any
   custom `command`/`skill` gate that commits. The **driver** owns the remote, not the gate briefs,
   so `gates/*.md` are unchanged. A push with nothing new is a cheap `Everything up-to-date`.

2. **On PARK → Blocked** — push first, then include the ref in the comment:
   `Blocked: <reason> (branch: <git.branchPrefix><N>-<slug>, pushed to <merge.remote>)`.
   If the push failed, the comment says so instead of claiming a ref that isn't there.

3. **On auto-retry → Pending** — push, and name the pushed ref in the `Auto-retry` comment next to
   the head sha it already records.

4. **Resume ladder (driver step 4), new bottom rung** — when neither the worktree nor the local
   branch exists, but `<merge.remote>/<git.branchPrefix><N>-<slug>` does, fetch it and cut the
   worktree from the remote branch rather than starting fresh off the base branch. This is the rung
   that makes a Blocked goal resumable from a different computer. It is tried before the existing
   "create fresh" rung and after the existing local-worktree / local-branch rungs.

5. **INTEGRATION, `auto` mode** — after the local `git branch -d`, also
   `git push <merge.remote> --delete <branch>`, best-effort. Goal branches are ephemeral checkpoints;
   once merged, the work is on the base branch. Parked branches are never deleted — that is the whole
   point of keeping them.

6. **INTEGRATION, `pr` mode** — the existing branch push becomes `--force-with-lease`. This is
   required, not cosmetic: PR mode rebases onto the remote base *before* pushing, so a branch already
   pushed at gate time would otherwise be rejected as non-fast-forward. It is safe because Bunshin is
   the sole writer of `<git.branchPrefix>*` branches.

7. **Sandboxed runs** — in `auto` mode, goal-branch pushes are **skipped**, the same rule the sandbox
   already applies to `merge.autoPush`. The isolated clone's `origin` is the *host repository path*,
   so pushing there would not help a second machine and would write the host `.git` — which LOCKED
   decision 5 forbids. Sandboxed **PR** mode pushes normally, since the clone's `origin` is the real
   remote.

### Orchestrator mode

The key is read from the config the driver is already using, exactly like `merge.autoPush`. No
per-repository override is added.

## Surface touched

| File | Change |
| --- | --- |
| `src/util.js` | `resolvePushBranches(config)` + export |
| `test/pushBranches.test.js` | New: resolver unit tests, plus a guard that `template/driver.md` still documents `git.pushBranches` (same pattern as `test/changelog.test.js`) |
| `template/bunshin.config.template.json` | `git.pushBranches: true` + a `pushBranchesNote` |
| `template/bunshin.orchestrator.template.json` | Same key + note |
| `template/driver.md` | The seven behaviours above |
| `README.md` | Document the key where `merge.autoPush` is documented |
| `CLAUDE.md` | LOCKED decision 5 + the `src/util.js` resolver row |
| `docs/CHANGELOG.md` | One goal entry |

Not touched: `src/run.js`, `src/sandbox.js`, `template/gates/*.md`.

## Testing

`npm test` (this repo's `gateChecks`) picks up `test/pushBranches.test.js` — plain-Node `assert`, no
framework, matching every other resolver test. Coverage:

- absent / `null` / missing `git` block ⇒ `true`
- explicit `true` / `false` pass through
- non-boolean (`"true"`, `1`, `[]`, `{}`) throws, and the error names both `git.pushBranches` and
  `bunshin.config.json`
- the shipped `template/driver.md` still mentions `git.pushBranches`, so the resolver and the
  procedure cannot drift apart

The driver-side behaviour is markdown procedure, verified the same way every other driver change in
this repo is: by the markdown guard test plus review of the shipped text.

## Decisions and rejected alternatives

- **`git.pushBranches`, not `merge.pushBranches`.** `merge.autoPush` lives in `merge` because it is
  part of integration. Pushing checkpoints is not integration; it is branch lifecycle. The note in
  each block cross-references the other so neither is missed.
- **No separate `deleteRemoteOnMerge` knob.** Remote-branch cleanup is folded into the same flag.
  YAGNI — a repo that wants pushed checkpoints does not want a permanent pile of merged `goal/*`
  branches.
- **Default on, not opt-in.** Best-effort semantics make "on" a no-op for repos without a remote, so
  the durability benefit is available without every consumer editing config.
- **Driver-owned pushes, not gate-brief-owned.** One place owns the remote; the gate briefs stay
  generic and custom gates that commit are covered for free.
- **Push after every commit, not only at park.** A crash mid-gate is precisely the "first agent
  stops" case; parking-only checkpoints would not cover it.
