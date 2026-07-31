# Auto-unblock: self-resolving gate failures — design

**Date:** 2026-07-31
**Status:** Approved

## Problem

The driver parks every gate failure to **Blocked** ("PARK on the FIRST gate failure. No repair, no
retry.") and waits for a human. In practice, most parks do not need a human: review-gate BLOCKs
arrive with concrete, verified findings and prescribed fixes, and the human's "unblock" action is
mechanical — accept the findings, scope the retry, move the goal back to **Pending**. Observed on the
sysfenix board: SYS-453 went through four such cycles, SYS-470 one, each requiring a human round-trip
that added no information. Meanwhile some parks genuinely DO need a human (SYS-468: "fix is in the
Cloudflare dashboard, no code deliverable") and must keep parking.

## Decision summary

| Decision | Choice |
| --- | --- |
| Trigger point | At park time — classify the failure when the gate fails; a self-resolvable goal never rests in Blocked |
| Retry cap | 5 auto-retries per goal by default, configurable |
| Classification | Driver judges by a written rubric; when in doubt → human |
| Default | On by default for every repo; disable per repo |
| Retry mechanics | Round-trip through Pending, but KEEP the worktree and branch (no teardown/re-install on retry) |

**Consequence for board semantics:** the Blocked column now MEANS "needs a human." Everything else
self-retries until it passes or exhausts its budget.

## Config

New OPTIONAL top-level block in `bunshin.config.json` (and the orchestrator config):

```json
"unblock": {
  "auto": true,
  "maxRetries": 5
}
```

- Absent block, or absent keys ⇒ `auto: true`, `maxRetries: 5` — auto-unblock is ON by default.
- `auto: false` restores today's park-everything behavior exactly.
- `maxRetries` must be a whole number ≥ 0; anything else is a config error — report, don't guess.
  (`0` = classify but never retry: self-resolvable failures park with the classification noted.)
- **Orchestrator mode:** the top-level `unblock` is the default; a `repositories[]` entry MAY carry
  its own `unblock` block that overrides it for that repo (same pattern as per-repo
  `gates`/`commands` — shallow merge, repo keys win).

## Driver changes (`template/driver.md`)

### 1. Classify at park time (step 6, the gate-failure path)

When a gate fails (and at every other PARK site: merge re-gate failure, triage no-match, open-PR
failure, reaper "PR closed unmerged"), the driver FIRST classifies the failure reason against this
rubric, before touching the tracker:

- **Self-resolvable** — the fix is achievable by editing this repository and re-running the gates.
  Typical: a review BLOCK citing code/copy defects (with or without prescribed fixes), failing
  `commands.gateChecks`, a verify-gate functional failure, an infra flake, a merge re-gate failure.
- **Human-needed** — resolving it requires anything outside the repo's and the agent's reach:
  external dashboards / credentials / DNS / third-party services, a product or scope decision,
  spending or publishing approval, a triage no-match or ambiguous tie ("never guess" stands), a PR
  closed unmerged by a human.
- **When in doubt → human.** A wasted human look is cheaper than five wasted gate cycles. The park
  comment states the doubt.

`unblock.auto: false` skips classification entirely — every failure parks as today.

### 2. The retry action (self-resolvable AND budget remaining)

1. **Attempt number** = 1 + the count of prior driver-authored comments on the issue starting with
   the literal marker `Auto-retry` (deterministic, crash-safe, survives session restarts). Comments
   written by humans — including manual unblock comments — never count against the budget.
2. If attempt number > `maxRetries` ⇒ park to **Blocked** as today, with the reason prefixed
   `retry budget exhausted (<maxRetries> auto-retries)` followed by the gate's verdict.
3. Otherwise comment on the issue:
   `Auto-retry <n>/<maxRetries>: Gate <position> (<name>) — ` followed by the FULL gate verdict,
   then the scoped retry instructions: the findings are the fix list; resume on branch
   `<git.branchPrefix><N>-<slug>` from `<head sha>`; do NOT redo anything the gate verified sound.
4. Transition the issue **In Progress → Pending**. **KEEP the worktree AND the branch** — no
   teardown, so the retry skips the slow fresh-worktree install. (A human-needed park still removes
   the worktree and keeps only the branch, exactly as today.)
5. The normal loop re-takes the goal from Pending in board order; other pending goals may interleave.

### 3. Resume semantics (step 4 — also fixes the manual-unblock path)

When taking a Pending goal, before creating anything:

- If the worktree dir `<git.worktreeBaseDir>/<N>-<slug>` already exists and is checked out on branch
  `<git.branchPrefix><N>-<slug>` → REUSE it as-is. Skip `git worktree add`. The `implement` gate may
  skip re-running `commands.install` only if its dependency dir (e.g. `node_modules`) is present;
  `commands.gateChecks` always runs in full.
- Else if only the branch exists (today's post-park state, e.g. after a manual unblock) →
  `git worktree add <dir> <branch>` (NO `-b`), continuing from the branch head.
- Else → create fresh with `-b`, as today.

This codifies the resume behavior that manual unblock comments ("Resume on branch X from commit Y")
have relied on implicitly.

### 4. Feeding the verdict to the retry attempt

When the taken goal is a resume (either an `Auto-retry` round-trip or a manual unblock), the driver
reads the LATEST `Auto-retry` / `Blocked:` / unblock comment and passes its content to the
`implement` agent alongside the goal text, as the attempt's scope.

### 5. Rules section amendment

Replace: "PARK on the FIRST gate failure. No repair, no retry." with: gates still run fail-fast —
the FIRST failure stops the pipeline. The goal is then AUTO-RETRIED (if classified self-resolvable
and retry budget remains) or PARKED. Gates themselves never silently repair; the retry is a fresh
pipeline run with the verdict as scope. Playwright infra flakes are self-resolvable — name them in
the retry comment.

### 6. Heartbeat

No schema change. A retry round-trip just re-enters the normal phases on the next take
(`booting` → `gate1` → …). `phase: "blocked"` / `blockedReason` remain reserved for real
(human-needed or budget-exhausted) parks.

## Gate brief changes

- **`gates/implement.md`** — add a short "Retry attempt" note: when the driver passes a
  prior-attempt verdict, treat its findings as the scope — fix exactly those, do not redo work the
  verdict verified sound, and do not re-litigate accepted findings.
- **`gates/review.md`** — UNCHANGED. Every attempt gets a fresh adversarial review of the full
  branch diff with no implementer context; that independence is what makes unattended retry safe.
- Other briefs (`verify`, `triage`, `readme`, `claude-md`) — unchanged.

## Docs & tests

- `README.md`: new "Auto-unblock" section (behavior, rubric summary, config knob, Blocked-column
  semantics change) + the config field guide entry.
- Bunshin's own `CLAUDE.md`: update the pipeline description where it states the no-retry rule.
- Both config templates (`template/bunshin.config.template.json`,
  `template/bunshin.orchestrator.template.json`): add the `unblock` block with `$comment`s.
- `test/run.test.js`: config-validation cases for `unblock` (defaults applied when absent; `auto:
  false` honored; bad `maxRetries` rejected).
- `docs/CHANGELOG.md`: entry for the feature.

## Out of scope

- No sweep/reaper over the Blocked column — Blocked now means "needs a human", and rescuing goals
  parked by older versions stays manual.
- No changes to the verify/triage/readme/claude-md briefs beyond the above.
- No tracker-side automation (webhooks, Jira automation rules).
- No per-gate retry budgets or backoff — one flat per-goal cap.
