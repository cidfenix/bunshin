<p align="center">
  <img src="assets/bunshin-banner.svg" alt="Bunshin — Kage Bunshin no Jutsu" width="100%">
</p>

<h1 align="center">影分身 &nbsp;Bunshin</h1>

<p align="center">
  <em>Kage Bunshin no Jutsu — the Shadow Clone Technique, for your backlog.</em>
</p>

<p align="center">
  <img alt="agent" src="https://img.shields.io/badge/agent-Claude%20Code%20%7C%20Codex-ff7a18">
  <img alt="process-only" src="https://img.shields.io/badge/orchestrator-none%20(process--only)-1b1226">
  <img alt="npm dependencies" src="https://img.shields.io/badge/npm%20deps-0-2ea043">
  <img alt="trackers" src="https://img.shields.io/badge/trackers-Trello%20%7C%20Jira-ff7a18">
  <img alt="requires" src="https://img.shields.io/badge/requires-agent%20CLI%20%2B%20Trello%2FJira%20%2B%20Playwright%20MCP-1b1226">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
</p>

> 🍥 **In the anime, a ninja forms a hand-seal and *poof* — an army of shadow clones peels off to do
> the work while the original rests.** That's exactly this tool. Bunshin drops clone-agents
> (implement · verify · review) that go off and finish your goals on their own — code → a
> **configurable gate pipeline** → auto-merge — with **no human in the review loop**. You stack goals
> on a **Trello board or Jira project**; the clones drain it.

Autonomous **goal loop**, driven by your **Trello board or Jira project**. It is
**process-only**: there is no
orchestrator daemon. The package ships the markdown pipeline (a driver procedure + the built-in **gate
presets** in `template/gates/`) and a thin CLI that drops a single per-repo config file into any repo and
launches an **agent CLI** to follow it — **Claude Code** (its self-paced `/loop`) by default, or
**Codex** (`codex exec`), selected by `agent.kind`. One board can even drive **many repositories** at
once — see [Orchestrator mode](#orchestrator-mode--one-board-many-repositories).

### Why "Bunshin"?

> **分身 (bunshin)** = "a divided body; a clone." **影分身 (kage bunshin)** = "shadow clone."
> One source, many copies doing the work in parallel — the loop spawns fresh agent "clones" per goal,
> and the multi-agent future is literally *Tajū* Kage Bunshin: many at once. 🥷

## Requirements

- An **agent CLI** for your `agent.kind`, installed with its binary on your `PATH`:
  [**Claude Code**](https://docs.claude.com/claude-code) (`claude`, the default) **or**
  [**Codex**](https://github.com/openai/codex) (`codex`). See
  [Agent runtime](#agent-runtime--claude-code-or-codex) below; absent ⇒ Claude Code.
- A **task-tracker MCP server** for your `provider.kind`: the **Trello MCP** (`mcp__trello__*`) or a
  **Jira MCP** (e.g. the Atlassian MCP). The driver moves goals between columns through it.
- The **Playwright MCP server** — only if your pipeline keeps the **`verify`** gate (it smoke-tests the
  change in a browser). Non-web repos that drop `verify` from `gates.steps` don't need it. See
  [Gate pipeline](#gate-pipeline--configurable-per-repo).
- Node.js ≥ 18 — only to run the CLI itself, which has **zero npm dependencies** (pure Node
  built-ins, so `npx` pulls in nothing). Note this is separate from the runtime prerequisites above:
  the **pipeline needs your agent CLI (Claude Code *or* Codex) + a Trello *or* Jira MCP**, plus the
  **Playwright MCP** when the `verify` gate is in play.
- **Docker** — **optional**, only if you use [`bunshin run --sandbox`](#sandboxed-runs-docker-desktop)
  to isolate the agent in a container. Absent `--sandbox`, Docker is not needed.

> The `setup` command (below) can **install the MCP servers for you** — it runs `claude mcp add` with
> your approval and your credentials. Configuring them by hand is a one-time step too — see
> [Setting up the MCP servers](#setting-up-the-mcp-servers) below.

## Agent runtime — Claude Code or Codex

The agent CLI that actually runs the pipeline is **pluggable** via the `agent.kind` field in
`bunshin.config.json`:

| `agent.kind` | CLI (binary on `PATH`) | How Bunshin launches it |
| --- | --- | --- |
| `claude` *(default)* | [Claude Code](https://docs.claude.com/claude-code) (`claude`) | Self-paced `/loop` slash command on the `--interval` cadence |
| `codex` | [Codex](https://github.com/openai/codex) (`codex`) | `codex exec "<prompt>"` — **once per invocation** |

Omitting the `agent` block (or `agent.kind`) keeps the original behavior — **Claude Code** — so
existing setups are unchanged. The selected CLI must be **installed and on your `PATH`**; `run` and
`setup` refuse to start otherwise (telling you which binary is missing).

```jsonc
{
  "agent": {
    "kind": "codex"   // "claude" (default) or "codex"
  }
}
```

**The behavioral difference matters for cadence.** Claude Code drives the queue with its own
self-rescheduling `/loop`: `bunshin run` re-checks the board every `--interval` (default `20m`) until
Pending is empty, all inside one session. **Codex has no `/loop`**, so Bunshin launches it just once
per `run` via `codex exec` — it drains what it can in that single pass and then exits. To get a
recurring cadence with Codex, pair `bunshin run` with an **external scheduler** (cron, a systemd
timer, Task Scheduler, etc.) rather than relying on a self-rescheduling loop; `--interval` has no
effect under Codex.

The same selection applies to every command: `init` writes the `agent` block, `setup` launches the
chosen CLI for the interactive guided setup, and `run` launches it for the autonomous loop. The
`--unattended` flag maps to each CLI's "skip all approvals" switch — `--dangerously-skip-permissions`
for Claude Code, `--dangerously-bypass-approvals-and-sandbox` for Codex.

## Gate pipeline — configurable per repo

Each goal runs through an **ordered list of gates** defined by `gates.steps` in `bunshin.config.json`.
Omit the block (or leave `steps` empty) and you get the built-in default —
**`implement` → `verify` → `review`** — so existing setups are unchanged. Every entry is either the
**name of a built-in gate** or a **custom step object**:

| Built-in gate | What it does |
| --- | --- |
| `implement` | Codes the goal TDD-style, then runs `commands.install` + `commands.gateChecks`. |
| `verify` | Boots `commands.devServer` and Playwright-smokes the feature, committing a screenshot. **Web-only.** |
| `review` | A fresh adversarial agent reviews the diff → APPROVE / BLOCK. |
| `readme` | A fresh adversarial **docs** agent: BLOCKs when a user-facing change didn't update `README.md`. **Opt-in** — name it in `gates.steps` (not in the default pipeline). |
| `claude-md` | A fresh adversarial **docs** agent: BLOCKs when a change to architecture/conventions/LOCKED decisions didn't update `CLAUDE.md`. **Opt-in** — name it in `gates.steps` (not in the default pipeline). |

Custom steps splice in your own checks: `{"command": "<shell>", "name": "…"}` (a **non-zero exit**
Blocks the goal) or `{"skill": "<name>", "name": "…"}` (run an agent skill). Steps run in array order,
**fail-fast** — the first failure stops the pipeline and is classified (see
[Auto-unblock](#auto-unblock--self-resolving-gate-failures)): self-resolvable → auto-retry to
**Pending**; human-needed/budget-exhausted → **Blocked**.

The payoff: **non-web repos can drop the `verify` gate**, reorder the rest, or mix in their own checks.
Bunshin's own config (a zero-dep CLI with no dev server) drops `verify`:

```jsonc
{
  "gates": {
    // runs top-to-bottom, fail-fast; "verify" omitted — nothing to smoke-test in a browser
    "steps": [
      "implement",
      { "command": "npm run lint", "name": "lint" },   // custom shell gate
      "review"
    ]
  }
}
```

The built-in gate presets are **served from the package** as one file per gate under
**`template/gates/<name>.md`** (`implement` / `verify` / `review`, the orchestrator-only `triage`, and
the opt-in docs gates `readme` / `claude-md`); the driver dispatches each by name. The pure resolver is
`resolveGates()` in `src/util.js`.

## Setting up the MCP servers

`bunshin setup` can install these for you with your approval; to wire them by hand, these are one-time
`claude mcp add` commands. You only need the **tracker MCP that matches your `provider.kind`** — Jira
**or** Trello, not both — plus **Playwright**. Add `-s project` to any command to record it in the
repo's `.mcp.json` (shared with your team via git); omit it to keep the server in your personal Claude
config. Confirm they all connect with `claude mcp list` (or `/mcp` inside Claude Code) before `run`.

**Playwright** — the `verify` gate's browser smoke test (skip it if your pipeline drops `verify`):

```bash
claude mcp add playwright -- npx @playwright/mcp@latest
```

**Jira** — the official **Atlassian Remote MCP** (OAuth, nothing to paste):

```bash
claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp
```

Then run `/mcp` in Claude Code and authenticate `atlassian` in the browser. (An older
`--transport sse … /v1/sse` endpoint exists but is being retired — use the `/v1/mcp` HTTP endpoint
above.)

**Trello** — [`@delorenj/mcp-server-trello`](https://github.com/delorenj/mcp-server-trello); get a
Trello API key + token from <https://trello.com/power-ups/admin>:

```bash
claude mcp add trello \
  -e TRELLO_API_KEY=<your-key> \
  -e TRELLO_TOKEN=<your-token> \
  -- npx -y @delorenj/mcp-server-trello
```

## Usage

The npm name `bunshin` is taken, so it's distributed straight from the repo — run it with `npx`
(no install) or install the `bunshin` command globally.

### `setup` — guided, interactive (recommended)

```bash
# from the root of the repo you want to drain:
npx github:cidfenix/bunshin setup
```

Opens an interactive **agent session** (Claude Code by default, or Codex per `agent.kind`) that walks
you through it conversationally — picks your tracker (Jira/Trello), connection details, merge strategy,
and toolchain commands, fills in `bunshin.config.json`, and then **checks and installs the required MCP
servers** (Trello/Jira + Playwright) with your approval. When it's done, commit the config and run:

```bash
git add bunshin.config.json && git commit -m "add bunshin"
npx github:cidfenix/bunshin run
```

Prefer a persistent command? `npm i -g github:cidfenix/bunshin`, then `bunshin setup` / `bunshin run`.

### `init` — just write the config (no prompts)

For scripted/CI setups. Bunshin is **config-only**: the only file it adds to your repo is
**`bunshin.config.json`** at the root. The driver + the built-in gate presets (`template/gates/`) live
inside this package and are served from there at run time, so there's nothing generic to copy into (or
duplicate across) your repos.

```
your-repo/
  bunshin.config.json        # THE ONLY FILE BUNSHIN ADDS (per-repo) — commit it
  .bunshin/artifacts/        # committed Gate-2 screenshots (created on first run)
```

Useful flags:

```bash
npx github:cidfenix/bunshin init --name MyApp --base-branch main --board-id <trelloBoardId>
npx github:cidfenix/bunshin init --force     # overwrite an existing bunshin.config.json
```

`bunshin.config.json` is the only repo-specific thing — board ids, the worktree base dir, your
install/gate/dev-server commands, the `gates.steps` pipeline, and the benign-console-error allowlist.
The driver and the gate presets read every value from it. **Update the pipeline** for all your repos at
once with `npm i -g github:cidfenix/bunshin` — no per-repo changes.

To drive **many repositories from one board**, write the orchestrator variant instead:
`npx github:cidfenix/bunshin init --orchestrator` (see
[Orchestrator mode](#orchestrator-mode--one-board-many-repositories)).

### `run` — launch the loop

```bash
npx github:cidfenix/bunshin run                 # self-paced /loop, drains the queue (re-checks every 20m)
npx github:cidfenix/bunshin run --once          # process exactly one goal, then stop
npx github:cidfenix/bunshin run --interval 30m  # different re-check cadence (Claude Code /loop only)
npx github:cidfenix/bunshin run --unattended    # skip the agent CLI's permission prompts (hands-off — careful)
npx github:cidfenix/bunshin run --orchestrator  # drive MANY repos from one board (bunshin.orchestrator.json)
npx github:cidfenix/bunshin run --sandbox       # run the agent in Docker against an ISOLATED clone (host untouched)
```

`run` refuses to start if the working tree is dirty (it fast-forward-merges finished goals into the
current tree), if there's no `bunshin.config.json` yet, or if the configured agent CLI isn't on your
`PATH`. (In `--orchestrator` mode the clean-tree guard is skipped — the merge target is each listed
repo, not the orchestrator folder.)

The cadence above is the **Claude Code `/loop`** default. With `agent.kind: "codex"`, `run` launches
`codex exec` **once** and exits — `--interval` is ignored, so wrap `run` in an external scheduler for a
recurring cadence (see [Agent runtime](#agent-runtime--claude-code-or-codex)).

### Sandboxed runs (Docker Desktop)

`bunshin run --unattended` hands the agent CLI **all permission prompts bypassed**, then it runs git,
edits files, and merges on your **host** with no human in the loop. `--sandbox` is an **opt-in isolation
wrapper** for that: it runs the agent inside a **Docker container** against a **fully isolated local
clone** of your repo. **Your real working tree is never bind-mounted or written by the agent** — only
Bunshin's own CLI writes the host repo, as one deterministic step (auto mode: `git fetch` + a
fast-forward `git merge --ff-only` from the clone after a clean exit; PR mode: via the remote). Absent
`--sandbox`, behavior is 100% unchanged.

```bash
npx github:cidfenix/bunshin run --sandbox --unattended
```

Requires **Docker** running (Docker Desktop / the `docker` CLI + a reachable daemon). On first use
Bunshin builds a shipped reference image (`template/sandbox/Dockerfile` → `bunshin-sandbox:<version>`)
with git, the agent CLI, and Playwright; it only rebuilds on a Bunshin upgrade. `--sandbox` is
**single-repo only** (combining it with `--orchestrator` errors).

Everything that crosses the container boundary is an **explicit allowlist** in the optional top-level
`sandbox` config block (all keys optional):

```jsonc
"sandbox": {
  "image": "",        // "" ⇒ build/use the shipped bunshin-sandbox:<version>; else use THIS image tag as-is
  "dockerfile": "",   // "" ⇒ the shipped template/sandbox/Dockerfile; else a path relative to the repo root
  "network": "none",  // "none" (default, no network) | "default" | a named docker network
  "env": [],          // host env-var NAMES to inject, e.g. ["ANTHROPIC_API_KEY", "GH_TOKEN"]
  "mounts": []         // host files/dirs to bind-mount READ-ONLY, e.g. ["~/.claude", "~/.config/gh"] (~ = host home)
}
```

> **Network + secrets caveat.** `network: "none"` is the strongest default, but **PR mode and MCP
> trackers need network** — set `"default"` (or a named network) for those, and add the credentials the
> agent needs to `env` (e.g. `ANTHROPIC_API_KEY`, `GH_TOKEN`) and/or `mounts` (e.g. `~/.claude`,
> `~/.config/gh`). Only what you name crosses; nothing else does.

### `watch` — one dashboard for every running repo

Running Bunshin in several repos at once? `watch` serves a single localhost dashboard showing them
all: which loops are alive, the goal each is on, and which gate of the pipeline it's in.

```bash
npx github:cidfenix/bunshin watch            # serve at http://127.0.0.1:4317
npx github:cidfenix/bunshin watch --open     # …and open it in your browser
npx github:cidfenix/bunshin watch --port 5000
```

The dashboard has **two view modes**, switched by a header toggle (your choice is remembered).

**Pro** — the clean status-tile grid:

![Bunshin watch — Pro view](assets/watch-pro.png)

**🥷 Bunshin** — a pixel-art "nerd" view that renders the pipeline literally as *Kage Bunshin no
Jutsu*: each repo's loop is a ninja that idles / checks the board, then casts a shadow clone to work a
goal, and that clone poofs a sub-clone at the active gate station (Gate 1 → Gate 2 → Gate 3 → Merge).
Same data, just for fun.

![Bunshin watch — Bunshin nerd view](assets/watch-bunshin.png)

Every `bunshin run` registers itself in a shared per-user home, **`~/.bunshin/`** — that directory is
what relates your repos. `run` records each repo's identity and process there; the driver writes a
small heartbeat as it moves through the gates. `watch` is a **pure file reader** (zero deps, no tracker
credentials): it never calls Jira/Trello — the driver, which already queries the tracker each
iteration, stamps the current card and queue counts into the heartbeat for it. A repo shows as
**running**, **stale** (PID alive but the heartbeat went quiet — a likely stuck gate), or **stopped**.

## How a goal flows

The gates below are the **default pipeline** (`implement → verify → review`); a repo can reorder them,
drop `verify`, or splice in custom steps via `gates.steps`
([Gate pipeline](#gate-pipeline--configurable-per-repo)).

1. The driver takes the first **Pending** card, moves it to **In Progress**, and cuts an isolated
   worktree off the base branch (`N` = the goal's id — Trello card `idShort` or Jira issue key).
2. **`implement` (deterministic):** an implement agent codes the goal TDD-style; the driver runs your
   `install` then `gateChecks` (typecheck/build/test). The **commit step is pluggable** (`commit`): by
   default the agent makes one scoped Conventional-Commit `git commit`, but you can point it at your own
   flow — a custom `/commit` slash command / skill (`{ "skill": "/commit" }`) or a shell command
   (`{ "command": "..." }`) that stages + commits the goal's work your way (still one commit, only the
   intended files, keeping the `Co-Authored-By:` trailer). The agent also appends a one-entry record of
   what it shipped to your **changelog** (see [Where the log goes](#where-the-log-goes)).
3. **`verify` (behavioral, web-only):** a verify agent boots your dev server, exercises the feature with
   Playwright, asserts it renders with no new console errors, and commits a screenshot. (Dropped by
   config-only/CLI repos.)
4. **`review`:** a fresh adversarial agent reviews the diff and returns BLOCK or APPROVE.
5. **Integrate** (configurable via `merge.mode`):
   - **`auto`** (default): rebase, re-run `gateChecks`, fast-forward merge into the base branch, card
     → **Done**. No remote or GitHub needed. If a remote *is* configured, `merge.autoPush` (default
     `true`) pushes the base branch right after each merge so it doesn't silently drift ahead of the
     remote — best-effort (no remote, or a failed push, is logged and never blocks the goal); set it
     to `false` to keep the fully local behavior. The merged goal branch is then deleted locally, and
     on the remote if it was checkpointed there (see below).
   - **`pr`**: push the branch, open a GitHub **Pull Request**, card → **In Review**. A review reaper
     then auto-merges it once your gate is met — **≥ N approvals and/or a label** (optionally green
     checks) — or, with the gate off, simply marks the card **Done** after a human merges. Needs a
     remote + the `gh` CLI or a GitHub MCP. The PR-open step is **pluggable** (`merge.openPr`): by
     default Bunshin runs `gh pr create --fill`, but you can point it at your own flow — a custom
     `/open-pr` slash command / skill (`{ "skill": "/open-pr" }`) or a shell command
     (`{ "command": "..." }`) that applies your PR template and prints the PR URL. You can also
     **stamp labels on every PR Bunshin opens** with `merge.prLabels` (e.g. `["bunshin", "automated"]`)
     so humans can filter agent-created PRs out of their review queue (each becomes a `gh --label`; the
     label must already exist on the repo). This is a *filter* stamp — distinct from
     `merge.autoMerge.label`, which is a merge *gate* the reaper requires before auto-merging.

   Any gate failure is classified, not always parked — see
   [Auto-unblock](#auto-unblock--self-resolving-gate-failures) below: self-resolvable failures
   auto-retry to **Pending** (branch and worktree kept); human-needed or budget-exhausted failures
   go to **Blocked** with the reason (branch kept).

The card's list is the authoritative status, so a run is **crash-resumable**. Implementation is
**serial by default** — set a top-level `"concurrency"` in the config (a whole number, default `1`)
to let the driver work that many goals at once, each in its own worktree; integration (rebase +
re-gate + merge) stays serial regardless. A goal's first gate failure is classified, not always
parked (see [Auto-unblock](#auto-unblock--self-resolving-gate-failures) below): self-resolvable
failures auto-retry back to **Pending** with branch and worktree kept; human-needed or
budget-exhausted failures still park to **Blocked**. Manual re-queue by dragging a card back to
**Pending** still works and never consumes retry budget. (In `pr` mode, multiple PRs can sit in
**In Review** at once.)

A long-running `/loop` session accumulates conversation history as it drains goal after goal.
`"contextCleanupEvery"` (a whole number, default `5`, `0` to disable) has the driver run Claude Code's
`/compact` after every N completed goals to keep its context bounded proactively, instead of relying
only on reactive auto-compaction near the limit. One counter for the whole session (global across all
repos in orchestrator mode). Claude Code only — codex's `exec` restarts fresh per invocation, so there's
no accumulating session context to compact there.

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
goal-branch counterpart to `merge.autoPush`, which pushes the *base* branch after a merge. Note that
`git.pushBranches` is a separate knob from `merge.autoPush`: a repo that already set
`merge.autoPush: false` to stay fully local will still push goal branches by default, since
`git.pushBranches` defaults to `true` independently — set it to `false` too if you want the old
fully-local behavior back.

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

## Where the log goes

Every finished goal leaves one entry describing what it shipped. That entry goes in your
**changelog** — a top-level `"changelog"` path in the config, **default `docs/CHANGELOG.md`**
(created if missing; newest entries appended at the end; set `false` to skip logging entirely).

```jsonc
"changelog": "docs/CHANGELOG.md"   // or "docs/HISTORY.md", or false to disable
```

It deliberately does **not** go in `CLAUDE.md`. `CLAUDE.md` is the canonical context *every* agent
reads on *every* goal, so an append-only log inside it grows without bound: it burns context on each
future run and eventually exceeds the file's practical size limit — one real consumer reached ~1.1M
characters and had to hand-migrate its history out, twice. So Bunshin keeps the two separate:

| File | What belongs in it | How it changes |
| --- | --- | --- |
| **changelog** (`docs/CHANGELOG.md`) | The running per-goal history: what shipped, decisions made, bugs verified | **Appended** to, once per goal |
| **`CLAUDE.md`** | The *current* state: architecture, LOCKED decisions, layout, conventions | **Edited in place**, only when a durable fact actually changes |

Both review gates enforce the split: the built-in `review` gate BLOCKs a diff that appends a
progress line to `CLAUDE.md` instead of the changelog, and the opt-in `claude-md` gate BLOCKs a
change that alters architecture/conventions/a LOCKED decision without updating `CLAUDE.md` to match.

> **Upgrading an existing repo?** Nothing breaks: if you have no `changelog` key, new goals simply
> start logging to `docs/CHANGELOG.md` instead of `CLAUDE.md`. Move your existing history there once
> (or leave it — `CLAUDE.md` just stops growing). To keep the old behavior, set
> `"changelog": "CLAUDE.md"`.

## Orchestrator mode — one board, many repositories

Normally one board drives one repo. **Orchestrator mode** lets a single Jira project / Trello board
drive **many repositories** from one place. It uses a distinctly-named config —
**`bunshin.orchestrator.json`** — that coexists with a single-repo `bunshin.config.json` (a repo can
evolve *itself* **and** orchestrate *others*). The **`--orchestrator`** flag selects it on `init`,
`setup`, and `run`:

```bash
npx github:cidfenix/bunshin init --orchestrator     # write bunshin.orchestrator.json into this folder
npx github:cidfenix/bunshin run  --orchestrator      # drive every listed repo from one board
```

The orchestrator config lists the target repositories under `repositories[]` — each with a unique `id`,
a git `remote` and/or local `path`, an optional `baseBranch`, and a `description` used for routing — and
leads its `gates.steps` with the **`triage`** gate:

```jsonc
{
  "repositories": [
    { "id": "web", "name": "Acme Web", "remote": "git@github.com:acme/web.git",
      "path": "../acme-web", "description": "Customer-facing Next.js app: checkout, account UI." },
    { "id": "api", "name": "Acme API", "remote": "git@github.com:acme/api.git",
      "path": "../acme-api", "description": "Backend REST/GraphQL service: endpoints, auth, jobs." }
  ],
  "gates": { "steps": ["triage", "implement", "review"] }
}
```

**`triage`** is a built-in gate (kept **first** in `gates.steps`): for each goal it reads the goal text
against every repo's `description` + its `CLAUDE.md`/`README`, picks the ONE repository the goal belongs
to, and implements it there through the remaining gates. If triage **can't confidently place** a goal,
it's moved to **Blocked** with a comment naming the candidates — never guessed. You can supply your own
triage instead as a `{"skill": …}` / `{"command": …}` step. The orchestrator home folder needn't be a
repo being changed (the merge target is each listed repo), so the clean-tree guard doesn't apply to it.
The list is validated up front by `resolveRepositories()` in `src/util.js`, so a malformed config fails
fast.

## License

MIT
