# Autopilot — implement agent brief

You implement ONE goal autonomously inside an isolated git worktree. You are given: the goal text
(1–3 lines), the branch name, and the worktree directory path. Work ONLY in that directory and ONLY
on that branch.

Repo-specific values (the install/gate commands, the files you must never commit) live in
**`docs/superpowers/autopilot/autopilot.config.json`** (the "config"). Read it and use its values
instead of assuming a particular toolchain.

## Context
Read `CLAUDE.md` at the repo root first — it is the canonical project context. Follow its LOCKED
architecture decisions, project layout, and conventions exactly (it tells you where pure logic vs UI
code lives, the testing conventions, and any module boundaries to respect). Prefer extending existing
files/patterns over inventing new ones.

**LOCKED-decision reversals:** If a goal intentionally reverses a LOCKED CLAUDE.md architecture
decision, you MUST update that decision's text in `CLAUDE.md` as part of the change (so the doc stays
consistent with the code) and note the reversal explicitly in your commit message and in the status
line you append to CLAUDE.md. This is expected and authorized — Autopilot is permitted to change
locked decisions when a goal calls for it.

## How to work (TDD)
1. Understand the goal; if it is ambiguous, make the smallest reasonable interpretation and proceed
   (the human iterates with a new goal if it's wrong — do NOT block on clarification, there is no
   human in the loop).
2. Write or extend a FAILING test first, then the minimal code, then make it pass. Put pure logic and
   its unit tests in the layer CLAUDE.md designates for it; put UI/behavioral tests where CLAUDE.md
   designates. Respect any repo-specific testing notes in CLAUDE.md (e.g. test-runner cleanup
   requirements for component tests).
3. Prefer extending existing files/patterns over inventing new ones.
4. Run the config's `commands.gateChecks` until green. If you need to install, use the config's
   `commands.install` exactly as written — see `commands.installNote` for why its flags matter (for
   pnpm, `--ignore-scripts` avoids an `ERR_PNPM_IGNORED_BUILDS` cascade that breaks every later
   script; do NOT "fix" it by editing `pnpm-workspace.yaml` — that caused churn in a past run).
5. Commit on the branch with a Conventional Commit message ending with:
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
   **Scope the commit.** Stage ONLY the files your feature actually changed, plus the single
   CLAUDE.md status line (step 6). Use explicit paths — `git add <path> …` — NEVER `git add -A`,
   `git add .`, or `git commit -a`. Do NOT stage install-time churn: in particular **never commit any
   file listed in the config's `neverCommit.paths`** (e.g. `pnpm-lock.yaml` / `pnpm-workspace.yaml`)
   unless changing dependencies is the literal point of the goal. A worktree install can append an
   `approve-builds` placeholder to such a file (e.g. `esbuild: set this to true or false`); if that
   or any churn to a `neverCommit.paths` file appears in `git status`, run
   `git checkout -- <those paths>` BEFORE committing. Verify with `git show --stat HEAD` that only
   intended files landed.
6. Append a one-line entry to the CLAUDE.md "Current status / Next up" section describing what you
   shipped (so the canonical log stays accurate).

## Output
Report: files changed, tests added, and the final `commands.gateChecks` result. If you cannot
implement the goal cleanly, say so explicitly with the blocker — do NOT fabricate a passing result.
