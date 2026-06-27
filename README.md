# bunshin

Autonomous **Trello-driven goal loop for Claude Code**. Drains a board of lightweight, human-authored
goals by implementing each one fully autonomously — code → three gates → auto-merge — with **no human
in the review loop**.

It is **process-only**: there is no orchestrator daemon. The package ships the markdown pipeline (a
driver procedure + three agent briefs) plus a single per-repo config file, and a thin CLI that
scaffolds them into any repo and launches the Claude Code `/loop` that follows them.

## Requirements

- [Claude Code](https://docs.claude.com/claude-code) installed, with `claude` on your `PATH`.
- The **Trello MCP server** configured for the target project (the driver moves cards between lists
  through `mcp__trello__*` tools).
- The **Playwright MCP server** configured (Gate 2 smoke-tests the change in a browser).
- Node.js ≥ 18 (only needed to run the CLI itself; it has **zero dependencies**).

> The CLI can scaffold files and launch `claude`, but it **cannot** install/configure the MCP servers
> for you — that's a one-time Claude Code setup in the target project.

## Usage

Scaffold the pipeline into the repo you want to drain, then launch the loop:

```bash
# from the root of your target repo
npx bunshin init
#   …edit docs/superpowers/bunshin/bunshin.config.json (board id + your build commands)…
npx bunshin run
```

### `init` — scaffold

Writes the generic pipeline + a config template into `docs/superpowers/bunshin/`:

```
docs/superpowers/bunshin/
  driver.md                  # the /loop procedure (generic)
  agents/implement.md        # implement-agent brief  (generic)
  agents/verify.md           # verify-agent brief     (generic)
  agents/review.md           # review-agent brief     (generic)
  README.md                  # how-to-reuse guide
  bunshin.config.json        # THE ONLY FILE YOU EDIT (per-repo)
  artifacts/                 # committed Gate-2 screenshots
```

Useful flags:

```bash
npx bunshin init --name MyApp --base-branch main --board-id <trelloBoardId>
npx bunshin init --upgrade   # refresh the generic files, keep your config
npx bunshin init --force     # also overwrite the config
```

Only `bunshin.config.json` is repo-specific — board ids, the worktree base dir, your
install/gate/dev-server commands, and the benign-console-error allowlist. The driver and briefs read
every value from it.

### `run` — launch the loop

```bash
npx bunshin run                 # self-paced /loop, drains all Pending goals (re-checks every 20m)
npx bunshin run --once          # process exactly one goal, then stop
npx bunshin run --interval 30m  # different re-check cadence
npx bunshin run --unattended    # skip Claude Code permission prompts (hands-off — use with care)
```

`run` refuses to start if the working tree is dirty (it fast-forward-merges finished goals into the
current tree) or if no pipeline has been scaffolded yet.

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
