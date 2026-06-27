# Bunshin Watch — centralized multi-repo status dashboard

> Design spec. Status: approved for planning. Date: 2026-06-27.

## Problem

A user runs `bunshin` in several repositories on one machine at the same time. Each run is an
autonomous Claude Code `/loop` draining that repo's tracker. Today there is **no way to see all of
them at once** — you would have to open each terminal and each Jira/Trello board separately. There is
also no shared notion of "which repos are running Bunshin," because Bunshin is process-only and stores
nothing about live status: the driver merely moves cards between tracker columns.

Goal: a single, graphical, centralized view showing every repo currently running Bunshin on this
machine — whether its loop is alive, which goal it is working on, and which of the three gates it is
in.

## The core problem this solves: how repos relate

There is no existing link between separate `bunshin run` invocations. This design introduces a
**shared per-user home directory, `~/.bunshin/`**, as that link. Every `bunshin run` registers itself
there on launch and the driver heartbeats there as it works; the dashboard reads that directory. That
directory *is* the answer to "how do I relate my repos."

## Key constraint and its consequence

Bunshin's locked rule is **zero runtime npm dependencies** (Node built-ins only). A plain Node web
server therefore **cannot call Jira/Trello** — those trackers live behind MCP servers with
credentials, available only *inside* the running Claude loop, not to a standalone process.

Consequence (and the cleanest part of the design): the dashboard **never talks to the trackers**. The
driver already queries the tracker every iteration (it reads the Pending column to pick the top card),
so it **stamps the tracker-derived facts into its heartbeat file**. The dashboard is a pure local-file
aggregator. No credentials, no deps, no MCP in the dashboard process.

## Responsibility split

| Component | Trust level | Responsibility |
| --- | --- | --- |
| `src/run.js` (+ new `src/registry.js`) | Deterministic code | Identity + liveness: repo path, child PID, start time, provider, base branch, merge mode. Registers on launch, marks stopped on exit. |
| `template/driver.md` (the loop, has MCP) | Best-effort, agent-followed | Live task state: current gate, current card (title/url from the tracker), worktree, queue counts, last screenshot path. Heartbeats at each step. |
| `src/watch.js` (the dashboard) | Deterministic code | Pure file aggregator + tiny `http` server. Reads registry + heartbeats, serves one HTML page. Never calls a tracker. |

## Architecture & data flow

```
  bunshin run (repo A) ──┐ writes registry entry + PID
  bunshin run (repo B) ──┼──►  ~/.bunshin/registry.json
  bunshin run (repo C) ──┘     ~/.bunshin/status/<repoId>.json  ◄── driver heartbeats
                                          │
                                          ▼
                              bunshin watch  ──►  http://127.0.0.1:PORT
                              (reads files, no MCP)   single HTML page, polls /status
```

A repo appears in the dashboard the instant it is `bunshin run`, and its liveness is computed from
**(PID alive?) + (heartbeat fresh?)** — so a crashed loop or a wedged gate shows as **stale**, never
as a false "running."

## Data contracts

### Filesystem layout

Home resolved via `os.homedir()` → `~/.bunshin/` (e.g. `C:/Users/<user>/.bunshin/` on Windows).

```
~/.bunshin/
  registry.json              # all known repos, keyed by repoId
  status/<repoId>.json       # one heartbeat file per repo, written by the driver
```

`repoId` = first 12 hex chars of `sha256(absolute repo path)`. Stable across re-runs, so a repo keeps
its identity (and its dashboard tile) every time it is launched.

All writes (registry and heartbeat) are **atomic**: write to a temp file, then `fs.rename` over the
target, so a concurrent `watch` read never observes a half-written file.

### `registry.json` (written by `src/run.js`)

```json
{
  "schemaVersion": 1,
  "repos": {
    "a1b2c3d4e5f6": {
      "repoPath": "E:/workspace/gitfenix",
      "projectName": "GitFenix",
      "provider": "jira",
      "tracker": "BUN",
      "baseBranch": "main",
      "mergeMode": "pr",
      "pid": 48213,
      "startedAt": "2026-06-27T10:01:00Z",
      "endedAt": null,
      "statusFile": "C:/Users/cidja/.bunshin/status/a1b2c3d4e5f6.json"
    }
  }
}
```

- `tracker` = `jira.projectKey` (Jira) or `board.boardName` (Trello).
- `endedAt` is stamped on the spawned child's `exit` event (best-effort; if the machine dies it stays
  `null` and liveness falls back to the PID probe).

### `status/<repoId>.json` (written by the driver)

```json
{
  "repoId": "a1b2c3d4e5f6",
  "updatedAt": "2026-06-27T10:14:22Z",
  "phase": "gate2",
  "action": "Playwright-smoking the new export button",
  "card": { "ref": "BUN-42", "title": "Add CSV export", "url": "https://.../BUN-42" },
  "worktree": "../gitfenix-goals/42-add-csv-export",
  "queue": { "pending": 5, "inProgress": 1, "blocked": 1, "done": 18 },
  "lastScreenshot": ".bunshin/artifacts/42-export.png",
  "blockedReason": null
}
```

- `phase` is a small closed enum: `booting | gate1 | gate2 | gate3 | merge | blocked | idle`. The UI
  maps it to a color/icon and to the 3-gate stepper.
- `action` is a short free-text human label for the current step.
- `card` is stamped from the tracker call the driver already makes (`ref` = Jira issue key or Trello
  idShort).
- `queue` counts are best-effort, refreshed each iteration from the tracker columns the driver reads.
- `lastScreenshot` is a repo-relative path to the most recent Gate-2 artifact (may be `null`).
- Writing the heartbeat must **never fail the loop**: a write error is swallowed.

### `/status` endpoint payload (served by `watch.js`)

The registry joined to each heartbeat, plus a computed `liveness` per repo:

- `running` — PID alive **and** heartbeat age < `stale` threshold (default **90s**).
- `stale` — PID alive but heartbeat old (stuck gate / agent not writing), **or** heartbeat fresh but
  PID missing.
- `stopped` — PID gone (and `endedAt` set, or heartbeat absent).

PID-liveness is probed cross-platform with `process.kill(pid, 0)` inside try/catch (signal `0` only
tests existence; works on Windows).

## File changes

| File | Change |
| --- | --- |
| `src/registry.js` *(new)* | Owns `~/.bunshin/`: `repoIdFor(path)`, `register(entry)`, `markStopped(repoId)`, `readAll()`, atomic-write helper. Node built-ins only. |
| `src/run.js` | After guards, around the `spawn`: `register()` the repo with the child PID; compute + pass the heartbeat file path into the loop prompt; on child `exit`, `markStopped()`. |
| `src/run.js` → `buildPrompt()` | Gains the `statusFile` absolute path argument so the driver knows where to heartbeat. Stays unit-testable (one more value in the returned string). |
| `src/watch.js` *(new)* | `bunshin watch [--port N] [--open]`: built-in `http` server bound to `127.0.0.1`; routes `/` (HTML), `/status` (JSON), `/artifact/<repoId>` (serves the heartbeat's `lastScreenshot`). `buildStatusPayload()` is the unit-testable core. |
| `bin/bunshin.js` | Register the 4th command `watch` in arg-parsing/dispatch and in `--help`/usage. |
| `template/driver.md` | New **"Heartbeat" contract** section: write the status JSON at boot, on each gate entry, on block, on done. Provider-adapter note: stamp `card`/`queue` from the tracker calls it already makes. Explicit: best-effort, never fail the loop on a write error. |
| `template/agents/verify.md` | One line: surface the committed screenshot path so the driver can populate `lastScreenshot`. |
| `README.md` / `CLAUDE.md` | Document the new command and the `~/.bunshin/` home; update "three commands" → four. |

## The UI (one self-contained HTML page)

A responsive grid of **repo tiles**, polling `/status` every 3 seconds. No build step: HTML + CSS +
vanilla JS, inlined and served as a string.

Each tile shows:
- Project name + tracker badge (provider + project/board).
- A colored **liveness dot**: green = running, amber = stale, grey = stopped.
- The current **phase** as a 3-gate stepper (Gate 1 → Gate 2 → Gate 3 → merge).
- The current **card** title, linked to its tracker URL.
- The **worktree** path.
- A small **queue bar** (pending / blocked / done counts).
- A relative "updated 8s ago" timestamp.
- A thumbnail of the last Gate-2 screenshot (`/artifact/<repoId>`), when present.

Header: totals across all repos (running / stale / stopped, total pending, total in progress).

## Scope boundaries (YAGNI)

- **Single machine only.** `~/.bunshin/` is local; no cross-host aggregation in this version.
- **Read-only.** The dashboard observes; no controls to start/stop/unblock loops.
- **No history / metrics store.** Live snapshot only; no time-series.
- **No auth.** Bound to `127.0.0.1`; single-user localhost.

## Testing approach

Consistent with the repo's no-framework convention (ad-hoc Node smoke tests + running the CLI):

- `src/registry.js`: round-trip `register` → `readAll`; `repoIdFor` stability and uniqueness; atomic
  write leaves no partial file; `markStopped` sets `endedAt`.
- `buildPrompt()`: asserts the `statusFile` path appears in the emitted prompt.
- `buildStatusPayload()`: given a fixture registry + heartbeat dir, computes correct `liveness`
  (running / stale / stopped) across PID-alive×heartbeat-fresh combinations; tolerates a missing or
  malformed heartbeat file without throwing.
- `bin/bunshin.js`: `--help` lists `watch`; `watch --port` starts and `/status` returns valid JSON
  (smoke).
- Cross-platform: `process.kill(pid, 0)` probe verified on Windows (primary dev OS).

## Open risk

The gate-level heartbeat is **best-effort** — the driver is markdown an agent follows, so a step's
heartbeat write can be skipped. This is mitigated, not eliminated: a missing/old heartbeat surfaces as
**stale** (itself a useful "stuck?" signal), and deterministic identity + PID liveness from `run.js`
always hold regardless of the agent's behavior. The dashboard never depends on the heartbeat for
"is this repo running."
