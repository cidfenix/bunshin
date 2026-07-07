# Configurable concurrency — number of goals in flight at once

**Date:** 2026-07-07
**Status:** Approved (autonomous /goal run)
**Goal:** Make the number of issues (goals) being worked on at the same time configurable. Default 1
(today's serial behavior, unchanged).

## Problem

Bunshin's driver is hard-serial: the Rules section of `template/driver.md` says "SERIAL
implementation — never create a second worktree while one goal is being implemented", and LOCKED
decision 4 in `CLAUDE.md` states "Execution is **serial**". For queues with many small independent
goals, a repo may want the driver to work several goals at once (each already isolated in its own
git worktree). This must be opt-in per repo, defaulting to the exact current behavior.

## Approaches considered

1. **Top-level `concurrency` config key + pure resolver + driver semantics (CHOSEN).** Matches every
   prior feature (BUN-6 `gates.steps`, BUN-13 `merge.openPr`, BUN-14 `commit`, BUN-15
   `merge.prLabels`): a config key the driver reads, a pure unit-tested resolver in `src/util.js`
   as the canonical semantics, docs in the config template `$comment`s / README / CLAUDE.md.
   Absent ⇒ default ⇒ unchanged behavior.
2. **CLI flag `bunshin run --concurrency N`.** Rejected: Bunshin is config-only ("one config file
   per role" is LOCKED); existing flags (`--orchestrator`, `--sandbox`, `--once`) select *modes*,
   not tuning values, and a flag wouldn't be crash-resumable state the way config is.
3. **N parallel driver processes.** Rejected: breaks the single-session `/loop` architecture, the
   `~/.bunshin/` registry (one PID per repo), and the heartbeat contract; enormous complexity for
   no benefit — the driver can already dispatch gate agents in parallel within one session.

## Design

### Config key

A **top-level `"concurrency"`** number in `bunshin.config.json` (and identically in
`bunshin.orchestrator.json` — it is a *queue* property, so no per-repo override):

- Absent / `null` ⇒ **1** (serial — today's behavior, backward compatible).
- A positive integer (`>= 1`) ⇒ at most that many goals may be *in flight* (worktree cut, gates
  running) at once.
- Anything else (non-number, boolean, string, non-integer like `1.5`, `0`, negative, `NaN`) ⇒ a
  clear config error naming `concurrency`.

### Pure resolver — `resolveConcurrency(config)` in `src/util.js`

Returns the effective integer. Pure (no fs/spawn), exported, unit-tested in
`test/concurrency.test.js` (wired into `npm test`). Error messages reference `concurrency` and
`CONFIG_FILENAME`, mirroring `resolvePrLabels`. The driver reads the same key; the resolver is the
canonical semantics (same split as `resolveGates`).

### Driver semantics (`template/driver.md`)

- **Take step (iteration step 1):** first RESUME every issue already in **In Progress** (crash
  recovery, unchanged), then take Pending issues until `concurrency` goals are in flight. With
  `concurrency` 1 this reads exactly as today (resume the one In Progress issue, else take the
  first Pending issue).
- **Parallel work:** each in-flight goal keeps its own worktree/branch (already isolated). Gate
  agents for different goals MAY be dispatched in parallel; gates *within* one goal stay ordered,
  fail-fast. A gate failure PARKS only that goal — the others continue.
- **INTEGRATION is always serial**, regardless of `concurrency`: merge one goal at a time — rebase
  its branch onto the *just-updated* base, re-run `commands.gateChecks`, fast-forward. This keeps
  the never-merge-ungated invariant intact when the base moves under a sibling goal.
- **Rules section:** the "SERIAL implementation" rule becomes "BOUNDED concurrency — at most
  `concurrency` goals (default 1 = serial) in flight; integration always serial".
- **Heartbeat:** format unchanged (single `card`). With `concurrency > 1` the heartbeat reflects
  the goal currently being acted on; `queue.inProgress` may exceed 1. Documented as best-effort —
  `src/watch.js` is NOT touched (out of scope).

### Launch prompt wording (`src/run.js`)

`buildPrompt` / `buildOrchestratorPrompt` currently say "process goals … **serially** until Pending
is empty". Reword to "… until Pending is empty — serially by default, or up to the configured
`concurrency` goals at a time". Keeps the existing `/serially/` test assertions passing; tests
extended to assert the `concurrency` mention. `--once` wording unchanged (exactly one goal).

### Docs

- `template/bunshin.config.template.json` + `template/bunshin.orchestrator.template.json`: add
  top-level `"concurrency": 1` + a `concurrencyNote` sibling (template style for scalars).
- `README.md`: amend the "serial" claim in *How a goal flows*; document the key.
- `CLAUDE.md`: amend LOCKED decision 4 ("Execution is serial" → serial *by default*, bounded by
  `concurrency`; integration always serial), the `src/util.js` key-files row, and a status entry.

## Testing

- `test/concurrency.test.js` (new, plain-Node `assert`, added to `package.json` `test` script):
  default 1 for absent/null; passthrough for 1/2/8; throws naming `concurrency` for `0`, negatives,
  non-integers, strings, booleans, arrays, objects.
- `test/run.test.js`: extend prompt assertions (`/serially/` kept, `/concurrency/` added).
- No Docker / network / tracker needed; `npm test` stays green.

## Out of scope

- `bunshin watch` multi-goal visualization (dojo shows one active goal; heartbeat contract kept).
- Per-repo `concurrency` overrides in orchestrator mode (queue-level knob only).
- Any change to `--once` (still exactly one goal) or the sandbox path.
