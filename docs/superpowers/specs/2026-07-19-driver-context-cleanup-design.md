# Driver context cleanup (`contextCleanupEvery`)

**Status:** Approved (design settled via brainstorming; proceeding straight to implementation)
**Date:** 2026-07-19
**Scope:** `template/driver.md` + `src/run.js` + `src/util.js`. Applies to single-repo and orchestrator runs alike.

---

## 1. Problem & goal

A `bunshin run` driver session is one long-lived Claude Code `/loop` conversation that drains many goals
in sequence (bounded by `concurrency`). Over a long run, the accumulated conversation history grows —
implement/verify/review context for every goal stays in the transcript. Nothing today proactively trims
it; the harness's own automatic compaction only reacts near the context limit, not ahead of it.

**Goal:** every N completed goals, have the driver proactively run Claude Code's built-in `/compact`
command to keep its context bounded, instead of relying solely on reactive auto-compaction.

## 2. Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| Mechanism | Driver instructions tell the session to invoke **`/compact`** — no manual handoff-summary state to design/maintain. |
| Agent scope | **Claude only.** `codex exec` restarts fresh per invocation (external scheduler), so there's no accumulating session context to compact there. |
| Configurability | **Configurable, on by default at 5** — new top-level `contextCleanupEvery` (int), absent ⇒ `5`, `0` ⇒ disabled. |
| Orchestrator scope | **One global counter**, applies identically in single-repo and orchestrator runs — same driver session, same accumulating context regardless of how many repos it's touching. |

## 3. Design

### Config — new top-level key (mirrors `concurrency`)

```jsonc
"contextCleanupEvery": 5,
"contextCleanupEveryNote": "OPTIONAL. How many completed goals between context compactions in the driver's Claude Code /loop session — a whole number >= 0. Absent ⇒ 5 (compact every 5 goals). 0 ⇒ disabled. Claude Code only (agent.kind: codex ignores this — codex exec restarts fresh each invocation, so there's no accumulating session context to compact)."
```

Added to both `template/bunshin.config.template.json` and `template/bunshin.orchestrator.template.json`.

### `src/util.js` — `resolveContextCleanup(config)`

Pure resolver, same shape as `resolveConcurrency`:
- `contextCleanupEvery` absent ⇒ `5`.
- `0` is valid (disabled).
- Non-integer or negative ⇒ throws, naming `contextCleanupEvery`.

### `src/run.js` — prompt injection

`buildPrompt()` and `buildOrchestratorPrompt()` gain the resolved value as an argument. When
`agent.kind === 'claude'` **and** the resolved value is `> 0`, append one sentence to the launch prompt
(same conditional-append style already used for the heartbeat text and the concurrency-naming sentence):

> "Every `<N>` completed goals, run `/compact` to keep your context bounded before continuing."

When `agent.kind === 'codex'`, or the resolved value is `0`, the sentence is omitted entirely — no
branching logic needed inside `driver.md` itself; the CLI decides once at prompt-build time.

### `template/driver.md` — new "Context cleanup" section

Placed near the existing Heartbeat/Concurrency sections. Contract:
- Track a running count of completed goals at **INTEGRATION** (merge/PR-open) — this step is always
  serial regardless of `concurrency`, so the count is unambiguous even with multiple goals in flight.
- If the launch prompt named a cleanup interval, and the count is a multiple of it, run `/compact` before
  picking up the next goal.
- One counter for the whole session: identical behavior in single-repo and orchestrator mode (a
  triage-routed goal in a different repo still increments the same counter).

### Docs

- README: short mention beside the existing Concurrency section.
- CLAUDE.md: a "Current status" bullet (mirrors how `concurrency` was documented) once shipped.

## 4. Tests

- `test/contextCleanup.test.js` (new, wired into `npm test`): absent ⇒ `5`; `0` ⇒ valid/disabled; negative
  or non-integer throws referencing `contextCleanupEvery`.
- `test/run.test.js`: the launch/orchestrator prompt contains the compact-every-N sentence when
  `agent.kind: 'claude'` and the value is `>0`; the sentence is absent for `agent.kind: 'codex'` and for
  an explicit `0`.

## 5. Scope guardrails (YAGNI)

- No new persisted state (no counter file) — the count lives in the live conversation only, same as every
  other piece of driver "memory" today (e.g. heartbeat is write-only, never read back by the driver).
- No interaction with `sandbox` mode beyond what already applies (the driver inside the container is the
  same Claude Code session; `/compact` behaves identically).
- Not applied to `codex` — out of scope for this slice, revisit only if codex gains a persistent-session
  mode.
