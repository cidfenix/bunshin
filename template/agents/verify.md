# Bunshin — verify agent brief

You behaviorally test ONE just-implemented goal using the Playwright MCP browser tools (or the
`verify` skill). Inputs: goal text, the branch diff, the worktree path, and whether the goal is
tagged with the agent token. This is a SMOKE + REACHABILITY check, not precise acceptance.

Repo-specific values (the dev-server / agent-start commands, the artifact dir, the agent token, the
benign-console-error allowlist) live in **`bunshin.config.json`** (the
"config"). Read it and use its values.

## Steps
0. Gate 1 has already run in this worktree, so deps are installed (`commands.install`) and packages
   are built (the build step in `commands.gateChecks`). If you must install yourself, use
   `commands.install` exactly (its flags matter — see `commands.installNote`; a plain install can
   break the dev server). The dev server can't resolve workspace imports unless the build has run —
   it has, via Gate 1.
1. In the worktree, start the web app with the config's `commands.devServer`. It boots fully offline
   with a seeded demo repo. Note the localhost URL it prints — it may NOT be the default port if that
   port is busy, so read the actual URL from the output.
2. If the goal is tagged with the config's `verify.agentTag` (e.g. `[agent]`), also start the local
   agent with `commands.agentStart`, then connect it in the UI (sidebar "⚡ Connect agent" with the
   printed URL + token).
3. Open the app in the browser and open the seeded demo repo.
4. Read the branch diff to learn what changed, then exercise that feature the most obvious way —
   click the new control, open the new dialog/panel, or perform the new action.
5. Assert the NON-NEGOTIABLES:
   - the new feature is reachable and actually renders. Prefer a CONCRETE, feature-specific check
     over a generic one — e.g. `document.querySelectorAll('[draggable="true"]')` count, or the new
     dialog/button/text being present — using `browser_evaluate`/`browser_snapshot`. A precise
     assertion on the thing the goal added is worth far more than "the page looks fine".
   - nothing crashed (no white screen, no React error boundary).
   - NO NEW console errors INTRODUCED BY THE FEATURE. IGNORE expected baseline noise: any console
     error whose text matches an entry in the config's `verify.benignConsoleErrors` (e.g. when login
     is off / the cloud isn't running the app logs `ERR_CONNECTION_REFUSED` to `localhost:8787`, and
     the local agent endpoint `127.0.0.1:7777` when not connected) plus font/network warnings — these
     are NORMAL offline and must NOT fail the gate. Only fail on errors clearly caused by the change
     (component stack traces, thrown exceptions from the new code, failed asset loads for new files).
     When in doubt, compare against the `verify.benignConsoleErrors` list.
6. Take a screenshot. NOTE: Playwright MCP writes screenshots (and a `.playwright-mcp/` scratch dir)
   into the MAIN session working directory, NOT the worktree — so save/copy the file to the worktree
   path `<worktree>/<artifactsDir>/<N>-<slug>.png`, where `<artifactsDir>` is the config's
   `artifactsDir` and `<N>-<slug>` is the branch name minus the `git.branchPrefix` (e.g.
   `1-add-repo-drag-drop` for branch `goal/1-add-repo-drag-drop`). Create the directory first if it
   doesn't exist (`mkdir -p <artifactsDir>` in the worktree — bunshin no longer scaffolds it), and
   verify the file actually exists at that worktree path before committing. Then commit it on the goal
   branch so it reaches the base branch via the fast-forward merge:
   ```
   git add <artifactsDir>/<N>-<slug>.png
   git commit -m "chore(bunshin): add Gate 2 screenshot for <branch>

   Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
   ```
7. TEARDOWN (always do this, even on FAIL): HARD-stop the dev server (and the agent if you started
   one) — don't just send it to the background. Kill the process listening on the port you used
   (e.g. on Windows: `Get-NetTCPConnection -LocalPort <port> -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }`);
   confirm the port is free. Then remove the Playwright scratch you created in the MAIN working
   directory: delete `.playwright-mcp/` and any stray screenshot copy left there (the committed copy
   lives in the worktree — only the loose main-cwd artifacts get cleaned). Leave the repo with no
   leftover processes or untracked Playwright files.

## Output
Report PASS or FAIL. On PASS, include the committed screenshot's repo-relative path
(`<artifactsDir>/<N>-<slug>.png`) so the driver can surface it in its heartbeat (`lastScreenshot`).
On FAIL, give the specific reason: the console error text, the missing element,
or the crash. If the dev server itself failed to boot, report
`FAIL — infra: dev server did not boot` so the driver records it as a flake.
