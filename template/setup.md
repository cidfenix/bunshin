# Bunshin setup guide

You are helping a developer set up **Bunshin** in their repository — **interactively**. Unlike the
autonomous driver, you SHOULD ask the user questions and confirm each choice. Keep it friendly and
concise: ask one topic at a time, apply the answer to the config file, briefly confirm, move on.

The config file is **`bunshin.config.json`** at the root of the current repo (already created from the
template). **Read it first** to see the fields and their inline `$comment` docs, then fill it in by
editing the file. At the end, make sure the required MCP servers are installed.

> Bunshin's pipeline (the driver + agent briefs) is served from the installed package — you are NOT
> creating those. You are only filling in this one config file and wiring up MCP servers.

> **Prerequisites — foreground these.** Beyond Claude Code itself, the pipeline cannot run without its
> MCP servers: the **tracker MCP** for the chosen provider (Trello or Jira) — always required — and the
> **Playwright MCP** for Gate 2's browser smoke, required only when the project has a web UI. These are
> the real blockers, so don't bury them behind toolchain trivia: pick the tracker (step 2) and merge
> mode (step 3), then settle the MCP servers (step 5) **before** the commands questions.

## 1. Project name
Confirm `project.name` (default: the repo folder name).

## 2. Choose the tracker — `provider.kind`
Ask: **Jira** or **Trello**? Set `provider.kind` accordingly (default `jira`).

- **Jira** → fill `jira.baseUrl` (e.g. `https://acme.atlassian.net`), `jira.projectKey` (e.g. `PROJ`),
  and optional `jira.jql` to scope the queue (e.g. `labels = bunshin`). Confirm the **status names**
  per column under `jira.statuses` (defaults: To Do / In Progress / Blocked / Done [+ In Review]) —
  adjust to match the workflow on their board.
- **Trello** → help them get the **board id**: their board URL is `trello.com/b/<shortLink>/<name>`;
  the full `boardId` can be read via the Trello API or the Trello MCP once it's connected (step 7).
  Set `board.boardId`, `board.boardShortLink`, `board.boardName`, and confirm the list names under
  `board.lists`.

They can delete the unused provider block (jira or board) if they like — it's optional.

## 3. Merge strategy — `merge.mode`
Ask: when a goal passes all gates, should it **auto-merge** locally, or **open a PR** for review?

- **auto** (default) → local fast-forward merge into `git.baseBranch`. No remote/GitHub needed.
- **pr** → set `merge.mode = "pr"`. Confirm `merge.remote` (default `origin`), `merge.prMethod`
  (`squash` | `merge` | `rebase`), and the auto-merge gate `merge.autoMerge`:
  - `approvals`: N approving reviews before it merges (`0` to ignore that gate)
  - `label`: a label that triggers merge (`""` to ignore)
  - `requireChecksGreen`: also require CI checks green
  - Explain: **both `approvals: 0` and `label: ""` ⇒ Bunshin opens PRs but never auto-merges** (humans
    merge; it just syncs the card/issue to Done afterward).
  - PR mode also needs an **In Review** column on the board and a `gh` CLI or a GitHub MCP — note this.

## 4. Branch & worktree — `git`
Confirm `git.baseBranch` (`master`/`main`), `git.branchPrefix` (default `goal/`), and
`git.worktreeBaseDir` (a sibling dir, e.g. `../<repo>-bunshin`).

## 5. MCP servers (the hard prerequisite — wire these BEFORE the commands)
Bunshin's pipeline can't run without its MCP servers, so settle them before the toolchain questions.
Check what's already configured — run `claude mcp list` (or inspect `.mcp.json` / the user's Claude
config). The repo needs:
- the **tracker MCP** for the `provider.kind` chosen in step 2 (Trello or Jira) — **always required**;
- the **Playwright MCP** (Gate 2's browser smoke) — required ONLY if the project has a web UI to
  smoke-test; skip it for a CLI / library / headless project (its `devServer` will be empty in step 6);
- (PR mode only, from step 3) GitHub access: an authenticated `gh` CLI or a GitHub MCP.

For any that are MISSING, offer to add them and — only with the user's OK — run the appropriate
`claude mcp add …` command (use the correct syntax for this Claude Code version). Ask the user for any
required credentials; **never invent tokens**. Recommended servers:
- **Playwright**: `claude mcp add playwright -- npx @playwright/mcp@latest`
- **Trello**: `@delorenj/mcp-server-trello` — needs `TRELLO_API_KEY` + `TRELLO_TOKEN`
  (get them from https://trello.com/power-ups/admin). Add with those as env vars.
- **Jira**: an Atlassian/Jira MCP (e.g. `mcp-atlassian`) — needs the Jira base URL + your email +
  an API token (https://id.atlassian.com/manage-profile/security/api-tokens). Confirm the exact
  package/command with the user before adding.
After adding, confirm each server actually connects.

## 6. Commands — `commands`
First gauge the project. If it has **no dependencies, no build step and no test framework** (e.g. a
zero-dep CLI or a small script repo), DON'T interrogate the user about a toolchain that doesn't exist —
set sensible no-ops and confirm in one line:
- `install` → `""` (nothing to install; running an installer would only risk a stray lockfile),
- `gateChecks` → a lightweight smoke that actually exercises the code (e.g. `node -e "require(...)"`
  over the source modules plus running the CLI's `--help` / `--version`),
- `devServer` → `""`.

Otherwise, ask about their toolchain (pnpm / npm / yarn / cargo / …) and fill:
- `install` — dependency install (empty if there are no deps). Keep no-build-script flags where
  relevant (for pnpm, `--ignore-scripts`; see `installNote` in the config for why).
- `gateChecks` — the deterministic checks (typecheck / build / test) run in Gate 1 and the merge re-gate.
- `devServer` — how Gate 2 boots the app for a Playwright smoke test. If the project has no web UI,
  leave it empty and tell them Gate 2's behavioral check will need adapting for their project.
- `agentStart` — optional background process for `[agent]`-tagged goals (empty if none).
Also confirm `verify.benignConsoleErrors` (expected offline console noise Gate 2 should ignore, e.g.
an API/agent localhost URL that isn't running during the smoke test) and `neverCommit.paths` (the
package-manager lockfiles agents must never stage).

## 7. Validate
Re-read `bunshin.config.json`: confirm it's valid JSON and no `{{PLACEHOLDER}}` tokens remain.

## 8. Done
Summarize the final config and which MCP servers are now configured. Tell the user to:
1. **Commit `bunshin.config.json`** (it's the only file Bunshin adds to the repo).
2. Make sure the repo has a **`CLAUDE.md`** describing the project (the agents read it for context).
3. Launch the loop: **`npx github:cidfenix/bunshin run`** (or `--once` / `--interval 30m` /
   `--unattended`).
