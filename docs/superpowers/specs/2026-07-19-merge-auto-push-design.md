# Auto-push after auto-mode integration (`merge.autoPush`)

**Status:** Approved (design settled via brainstorming; proceeding straight to implementation)
**Date:** 2026-07-19
**Scope:** `template/driver.md` (auto-mode INTEGRATION) + `src/run.js` (`--sandbox` sync-back) +
`src/util.js`.

---

## 1. Problem & goal

`merge.mode: auto` (the default) fast-forward-merges a finished goal into `<git.baseBranch>` **locally**
— by design, no remote or GitHub is needed (LOCKED decision 5). That means the local base branch can
silently drift ahead of its remote (if one exists) after every goal, with nothing pushing it back up.

**Goal:** an opt-out-able `merge.autoPush` (default `true`) that pushes the base branch to
`merge.remote` right after every local change to it in auto mode — the driver's own INTEGRATION merge,
and the `--sandbox` host CLI's sync-back merge.

## 2. Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| No remote configured | **Best-effort, skip silently** — never park/fail the goal over it; preserves the "no remote needed" guarantee. |
| `--sandbox` scope | **Both paths** — the driver's normal auto-mode merge AND the CLI's `syncBackFromClone` sync-back. |
| Config placement | **`merge.autoPush`** — nested under the existing `merge` block, beside `mode`/`remote`. |

`pr` mode is untouched: it already pushes the branch and merges via the remote/GitHub; the reaper never
touches the local base branch (confirmed by reading `template/driver.md`'s REVIEW REAPER section), so
there's nothing for `autoPush` to add there.

## 3. Design

### Config

```jsonc
"merge": {
  "mode": "auto",
  "remote": "origin",
  "autoPush": true,
  "autoPushNote": "OPTIONAL (mode='auto' only). Push <git.baseBranch> to `merge.remote` right after each local fast-forward merge (and after the --sandbox sync-back), so the remote doesn't silently drift behind. Absent ⇒ true. Best-effort: no remote configured, or the push fails, ⇒ log and continue — the goal is still Done, never parked over this. Set to false to keep today's fully local, no-remote-needed behavior."
}
```

### `src/util.js` — `resolveAutoPush(config)`

Pure resolver: `config.merge && config.merge.autoPush`, absent ⇒ `true`; non-boolean throws referencing
`merge.autoPush`. Unit-tested in `test/autoPush.test.js`.

### `template/driver.md` — auto-mode INTEGRATION, new step after the fast-forward merge

After step 3 (`git checkout <baseBranch> && git merge --ff-only <branch>`) succeeds: if
`merge.autoPush` (absent ⇒ true), run `git push <merge.remote> <git.baseBranch>`. If there's no remote
named `merge.remote`, or the push fails for any reason, report it (do not park — the merge already
succeeded locally and the goal is still Done) and continue to step 4 (cleanup) as normal.

### `src/run.js` — `syncBackFromClone` (the `--sandbox` auto-mode path)

After the existing `git merge --ff-only FETCH_HEAD` succeeds, if the resolved `merge.autoPush` is true,
attempt `git push <remote> <baseBranch>` on the host repo; on failure, `console.error` and continue —
mirrors the existing error-log-only style already used in this function for fetch/merge failures. `run()`
resolves `merge.autoPush` from the parsed config (already parsed once for `resolveSandbox`) and passes it
through to `syncBackFromClone`.

### Docs

- README: a sentence in the existing auto-mode paragraph.
- CLAUDE.md: LOCKED decision 5 gains a note; key-files row for `resolveAutoPush`; a "Current status"
  bullet.

## 4. Tests

- `test/autoPush.test.js` (new, wired into `npm test`): absent ⇒ `true`; explicit `true`/`false`
  pass through; non-boolean (string/number/null-is-absent-so-excluded/array/object) throws referencing
  `merge.autoPush`.
- `syncBackFromClone`'s push step is impure (spawnSync) and follows the same untested-orchestration
  pattern as the rest of that function (verified by code review + `npm test` passing, not a unit test) —
  consistent with how the rest of `src/run.js`'s spawn-based code is covered today.

## 5. Scope guardrails (YAGNI)

- No retry/backoff on a failed push — best-effort, log and move on, matching the fetch/merge error
  handling already in `syncBackFromClone`.
- No new remote-detection helper — "no remote" is just "the push command fails," handled the same as
  any other push failure (best-effort skip), not specially detected in advance.
- `pr` mode unaffected — `autoPush` is a no-op there (documented, not enforced with a config error, since
  a stray `merge.autoPush` in `pr` mode is harmless rather than a mistake worth blocking on).
