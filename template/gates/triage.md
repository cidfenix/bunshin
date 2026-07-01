# Bunshin — triage gate preset (ORCHESTRATOR mode only)

Pick the ONE target repository a goal belongs to, before anything is built. This preset is used
**only in orchestrator mode** (`bunshin run --orchestrator`, config `bunshin.orchestrator.json`),
where ONE board's goals span the MANY repositories listed under `repositories`. Unlike the other
built-in gate presets, the **driver follows this itself** (it is not dispatched to a subagent): the
outcome — a chosen repository, or a PARK — steers the whole rest of the pipeline.

Put `triage` **FIRST** in the orchestrator's `gates.steps`. It runs before the worktree is cut, so
the remaining gates (implement/verify/review) and INTEGRATION all operate on the repository this
preset selects.

## How to triage
- Match the goal text to **exactly one** configured repository. Use each repo entry's `description`
  hint PLUS, for the strongest signal, its **CLAUDE.md / README** at the repo's `path` (clone
  `remote` into `path` first if the local checkout is missing). Weigh names of features / dirs /
  services mentioned in the goal against what each repo owns.
- On a confident single match: record the chosen repo's `id`, `path`, and `baseBranch` (its own
  `baseBranch`, else `git.baseBranch`) and carry them forward — the worktree is cut inside that repo
  and INTEGRATION (merge / PR) targets that repo's base branch. Note the chosen `id` in the goal's
  branch / reports and heartbeat `action`.

## When you cannot decide → PARK (never guess)
- If triage **cannot confidently determine** the repository (no match, or an ambiguous tie): **PARK**
  — transition the goal **→ Blocked** and comment naming the candidate repositories considered and
  exactly what information is missing to decide (e.g. "mention the repo/service, or a file/path that
  identifies it"). **Do NOT guess.** No worktree is created for a parked-at-triage goal.

## Bringing your own triage
- Consumers can supply their **own** triage gate instead of this preset: a custom `{"skill":
  "<name>"}` or `{"command": "<shell>"}` step that emits the chosen repo `id`. Treat a "no repo /
  undecidable" result as a PARK exactly as above.
