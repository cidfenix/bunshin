<p align="center">
  <img src="assets/bunshin-banner.svg" alt="Bunshin — Kage Bunshin no Jutsu" width="100%">
</p>

<h1 align="center">影分身 &nbsp;Bunshin</h1>

<p align="center">
  <em>Kage Bunshin no Jutsu — the Shadow Clone Technique, for your backlog.</em>
</p>

<p align="center">
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-%2Floop-ff7a18">
  <img alt="process-only" src="https://img.shields.io/badge/orchestrator-none%20(process--only)-1b1226">
  <img alt="npm dependencies" src="https://img.shields.io/badge/npm%20deps-0-2ea043">
  <img alt="requires" src="https://img.shields.io/badge/requires-Claude%20Code%20%2B%20Trello%20%26%20Playwright%20MCP-ff7a18">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
</p>

> 🍥 **In the anime, a ninja forms a hand-seal and *poof* — an army of shadow clones peels off to do
> the work while the original rests.** That's exactly this tool. Bunshin drops clone-agents
> (implement · verify · review) that go off and finish your goals on their own — code → three gates →
> auto-merge — with **no human in the review loop**. You stack cards on a Trello board; the clones
> drain it.

Autonomous **Trello-driven goal loop for Claude Code**. It is **process-only**: there is no
orchestrator daemon. The package ships the markdown pipeline (a driver procedure + three agent briefs)
and a thin CLI that drops a single per-repo config file into any repo and launches the Claude Code
`/loop` that follows it.

### Why "Bunshin"?

> **分身 (bunshin)** = "a divided body; a clone." **影分身 (kage bunshin)** = "shadow clone."
> One source, many copies doing the work in parallel — the loop spawns fresh agent "clones" per goal,
> and the multi-agent future is literally *Tajū* Kage Bunshin: many at once. 🥷

## Requirements

- [Claude Code](https://docs.claude.com/claude-code) installed, with `claude` on your `PATH`.
- The **Trello MCP server** configured for the target project (the driver moves cards between lists
  through `mcp__trello__*` tools).
- The **Playwright MCP server** configured (Gate 2 smoke-tests the change in a browser).
- Node.js ≥ 18 — only to run the CLI itself, which has **zero npm dependencies** (pure Node
  built-ins, so `npx` pulls in nothing). Note this is separate from the runtime prerequisites above:
  the **pipeline needs Claude Code + the Trello & Playwright MCP servers** to actually do its work.

> The CLI can scaffold files and launch `claude`, but it **cannot** install/configure the MCP servers
> for you — that's a one-time Claude Code setup in the target project.

## Usage

Install the CLI from GitHub (the npm name `bunshin` is taken, so it's distributed straight from the
repo), then drop one config file into the repo you want to drain and launch the loop:

```bash
# one-time: install the `bunshin` command from GitHub
npm i -g github:cidfenix/bunshin

# then, from the root of your target repo:
bunshin init
#   …edit bunshin.config.json (board id + your build commands)…  then commit it
bunshin run
```

Or run it without installing: `npx github:cidfenix/bunshin init` / `… run`.

### `init` — write the config

Bunshin is **config-only**: the only file it adds to your repo is **`bunshin.config.json`** at the
root. The driver + the three agent briefs live inside this package and are served from there at run
time, so there's nothing generic to copy into (or duplicate across) your repos.

```
your-repo/
  bunshin.config.json        # THE ONLY FILE BUNSHIN ADDS (per-repo) — commit it
  .bunshin/artifacts/        # committed Gate-2 screenshots (created on first run)
```

Useful flags:

```bash
npx bunshin init --name MyApp --base-branch main --board-id <trelloBoardId>
npx bunshin init --force     # overwrite an existing bunshin.config.json
```

`bunshin.config.json` is the only repo-specific thing — board ids, the worktree base dir, your
install/gate/dev-server commands, and the benign-console-error allowlist. The driver and briefs read
every value from it. **Update the pipeline** for all your repos at once with
`npm i -g github:cidfenix/bunshin` — no per-repo changes.

### `run` — launch the loop

```bash
npx bunshin run                 # self-paced /loop, drains all Pending goals (re-checks every 20m)
npx bunshin run --once          # process exactly one goal, then stop
npx bunshin run --interval 30m  # different re-check cadence
npx bunshin run --unattended    # skip Claude Code permission prompts (hands-off — use with care)
```

`run` refuses to start if the working tree is dirty (it fast-forward-merges finished goals into the
current tree) or if there's no `bunshin.config.json` yet.

## How a goal flows

1. The driver takes the first **Pending** card, moves it to **In Progress**, and cuts an isolated
   worktree off the base branch (`N` = the card's Trello `idShort`).
2. **Gate 1 (deterministic):** an implement agent codes the goal TDD-style; the driver runs your
   `install` then `gateChecks` (typecheck/build/test).
3. **Gate 2 (behavioral):** a verify agent boots your dev server, exercises the feature with
   Playwright, asserts it renders with no new console errors, and commits a screenshot.
4. **Gate 3 (review):** a fresh adversarial agent reviews the diff and returns BLOCK or APPROVE.
5. **Merge:** rebase onto the base branch, re-run `gateChecks`, fast-forward merge, move the card to
   **Done**. Any gate failure → **Blocked** with the reason (branch kept).

The card's list is the authoritative status, so a run is **crash-resumable**. Execution is **serial**
and parks on the **first** gate failure — no auto-repair; you re-queue by dragging the card back to
**Pending**.

## License

MIT
