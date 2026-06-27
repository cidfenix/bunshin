# Bunshin Watch — dual view modes (Pro + 🥷 Bunshin/nerd)

> Design spec. Status: approved for planning. Date: 2026-06-27.
> Builds on [`2026-06-27-bunshin-watch-dashboard-design.md`](./2026-06-27-bunshin-watch-dashboard-design.md).

## Problem

The watch dashboard (`src/watch.js`) renders one professional grid of repo tiles. We want a second,
playful **"nerd" view** that visualizes the pipeline literally as *Kage Bunshin no Jutsu*: the loop is
a ninja that casts a shadow clone to work each goal, and that clone spawns a sub-clone at each gate.
The two views are switchable by a toggle in the page.

This is a **client-side presentation change only**. The status aggregator, the `~/.bunshin/` home, the
registry, and the driver heartbeat contract are all unchanged — both views consume the same `/status`
payload defined in the base watch spec.

## The metaphor (locked with the user)

- **The loop is the original ninja.** Per repo there is exactly one "original": the `bunshin run`
  loop. Between scheduled iterations it is **idle**; while picking the next card it is **checking the
  board**.
- **Working a goal = casting Kage Bunshin.** When the loop starts a goal it does *not* do the work
  itself — it spawns a **goal-clone**. The clone is what works the goal.
- **Every subagent is a clone.** The goal-clone stays in the dojo and **poofs a sub-clone at the
  active gate station** (implement → Gate 1, verify → Gate 2, review → Gate 3, integrate → Merge),
  matching the pipeline's one-fresh-subagent-per-gate reality.
- **Future concurrency grows the clone count.** Today implementation is serial (0 or 1 active goal per
  repo). If multiple goals run at once later, each is its own goal-clone with its own gate sub-clone —
  the design must not assume "at most one clone per repo."

## Decisions (locked)

1. **Toggle, default Pro.** A segmented control in the header — `Pro` | `🥷 Bunshin`. The choice
   persists in `localStorage` under `bunshin.watch.view`. Default is **Pro** so existing users see no
   change until they opt in.
2. **Mini-dojo grid layout.** Each repo is a compact animated dojo card in the *existing* responsive
   grid (same footprint as today's tiles).
3. **Animated canvas sprites.** Real retro pixel sprites drawn on a `<canvas>` from in-code pixel-grid
   strings + a palette, frame-stepped. Zero npm dependencies — everything stays inlined in the single
   HTML string `watch.js` already serves.
4. **Clones look like shadow clones.** The original loop ninja renders full-color; clones render
   **semi-transparent with a cool aura** so original vs clone is readable at a glance.
5. **No screenshot thumbnail in nerd view.** The Gate-2 screenshot stays Pro-only; the nerd dojo keeps
   to sprites + a one-line card title + tiny `pending/done` counts.

## Architecture & data flow

No new endpoints. The 3-second `/status` poll stays. The page keeps the **last polled snapshot** and a
**current view mode**; a single `render(data)` dispatches:

```
  poll /status (3s) ──► lastData ──► render(lastData)
                                       ├─ view==='pro'   → renderPro(lastData)    (today's tiles, unchanged)
                                       └─ view==='nerd'  → renderNerd(lastData)   (mini-dojo grid + sprite engine)
  toggle click ──► view = 'pro'|'nerd' ──► persist ──► render(lastData)   (instant, no refetch)
```

The sprite **animation** is driven by one shared `requestAnimationFrame` loop independent of polling:
it advances frame indices from elapsed time and redraws the visible dojo canvases. With a handful of
repos this is trivial cost. The rAF loop is a no-op while the Pro view is active (nothing to animate).

## Scene model

### `sceneFor(repo)` — the one pure mapper (single source of truth)

A pure function that turns a `/status` repo entry into a **scene descriptor** the renderer draws. It is
a real exported function in `watch.js` **and** is inlined into the page via `sceneFor.toString()`, so
the exact same logic is unit-tested in Node and runs in the browser — no duplicated mapping.

```js
// PHASES = ['gate1','gate2','gate3','merge'];  STATIONS index 0..3
sceneFor(repo) => {
  liveness: 'running' | 'stale' | 'stopped',   // from repo.liveness
  loopPose: 'idle' | 'check' | 'sleep' | 'gone',
  goalActive: boolean,                          // a clone is present
  station: -1 | 0 | 1 | 2 | 3,                  // active gate index, -1 = none
  blocked: boolean,
  cardTitle: string | '',                       // from repo.heartbeat.card
  pending: number, done: number,                // from repo.heartbeat.queue
}
```

Mapping rules:

| repo.liveness | heartbeat.phase | loopPose | goalActive | station | blocked |
| --- | --- | --- | --- | --- | --- |
| `stopped` | (any / none) | `gone` | false | -1 | false |
| `stale` | (any) | `sleep` | false | -1 | false |
| `running` | `idle` / `booting` / none | `check` | false | -1 | false |
| `running` | `gate1`/`gate2`/`gate3`/`merge` | `check` | true | 0/1/2/3 | false |
| `running` | `blocked` | `check` | true | index of `heartbeat.action`'s gate if known, else last known; default 0 | true |

Notes:
- `stale` outranks phase: a wedged gate must read as "asleep," never as a busy clone.
- `blocked` keeps the goal-clone present with the sub-clone in a slumped pose at the blocked station;
  the dojo tile is tinted red. The blocked station is derived from `phase`; the heartbeat carries no
  explicit gate index when blocked, so we fall back to station 0 if it can't be inferred. (Acceptable:
  the blocked *reason* text is still shown; exact station precision isn't load-bearing.)

### What each dojo draws

Left-to-right inside the card:
- The **loop ninja** (original, full color) in its `loopPose`:
  - `idle` — gentle bob.
  - `check` — looking at a small board/scroll.
  - `sleep` — slumped with a `zzz` (stale).
  - `gone` — absent; a faint dissipating poof cloud, whole card greyed (stopped).
- Four **gate stations** in a row: `Gate1 · Gate2 · Gate3 · Merge`.
  - When `goalActive`, the **goal-clone** (semi-transparent) stands near the loop, and a **sub-clone**
    poofs in at `station` doing that gate's work animation. Stations `< station` show a faint "done"
    tick; stations `> station` are empty.
  - When `blocked`, the sub-clone at `station` is in the slumped/⛔ pose; card tinted red.
- A one-line **card title** (truncated) and tiny **`pending` / `done`** counts.

## Sprite/canvas engine

- **Pixel grids as text.** Each sprite frame is an array of equal-length strings; each character maps
  to a color via a small `PALETTE` object (`'.'` = transparent). A `drawSprite(ctx, frame, x, y,
  scale)` paints filled rectangles, `scale` px per pixel. `ctx.imageSmoothingEnabled = false` keeps
  edges crisp.
- **Poses / sprite set (kept deliberately small to stay authorable):**
  - One **base ninja** body reused for original and clone (clone = same frames drawn at reduced alpha
    + a 1px cool-tone aura).
  - Loop poses: `idle` (1–2 frame bob), `check` (board), `sleep` (slump + `zzz`).
  - A **working** body (arms moving, 2 frames) shared by all gate sub-clones, plus a small per-gate
    **prop overlay**: `gate1` keyboard, `gate2` magnifier, `gate3` scroll+stamp, `merge` braid/handshake.
  - A reusable **poof cloud** (2–3 frame puff) for clone spawn/despawn and the `gone` remnant.
  - A **blocked** frame (slumped) + red tint.
- **Animation.** A module-level `START = performance.now()`; the shared rAF computes a global frame
  counter `Math.floor((now-START)/FRAME_MS)` and each sprite indexes its own frame array by it. Poof
  transitions are time-boxed (play once on state change), tracked per-dojo by comparing the new
  descriptor to the previous one.
- **Canvas per dojo.** Each card holds one `<canvas>` sized to the card; `renderNerd` builds/refreshes
  the cards from `lastData` (diffing by `repoId` so canvases aren't recreated every poll), and the rAF
  loop redraws them. On view switch to Pro, the loop early-returns.

## File changes

| File | Change |
| --- | --- |
| `src/watch.js` | Add exported pure `sceneFor(repo)`. Refactor the inlined `PAGE`: split today's tile rendering into `renderPro(data)` (behavior unchanged), add the header **view toggle** (persisted), add `renderNerd(data)` + the sprite engine (`PALETTE`, sprite frames, `drawSprite`, the rAF loop), and inline `sceneFor` via `sceneFor.toString()`. Still one self-contained HTML string, still zero deps. |
| `test/watch.test.js` | Add `sceneFor` cases (the liveness × phase matrix above → expected descriptor) and assert `renderPage()` still returns valid HTML containing both view roots + the toggle + the inlined `sceneFor` source. |
| `README.md` | One line under `watch`: two view modes (Pro / 🥷 Bunshin nerd mode) with a toggle. |
| `CLAUDE.md` (bunshin) | Note the dual-view watch dashboard. |

Unchanged: `src/registry.js`, `src/run.js`, `template/driver.md` heartbeat contract, the `/status` and
`/artifact` endpoints, the `buildStatusPayload` logic.

## Scope boundaries (YAGNI)

- **Presentation only.** No new data, endpoints, or heartbeat fields. If a future field would make the
  blocked-station precise, that's a separate change.
- **No sound, no settings panel.** Just the toggle.
- **No new dependency, no build step.** Everything inlined, as the base dashboard already is.
- **Sprite set kept minimal** (one base body + props + poof) rather than bespoke art per gate/state.

## Testing approach

Consistent with the repo's no-framework convention (ad-hoc Node smoke tests):

- `sceneFor()`: each `(liveness × phase)` combination returns the correct
  `{loopPose, goalActive, station, blocked}`; `stale` overrides an active phase to `sleep`/no-clone;
  `stopped` → `gone`; missing/partial heartbeat tolerated without throwing.
- `renderPage()`: still returns a non-empty HTML string containing the toggle control, both view
  container roots, and the inlined `sceneFor` source (guards the toString() single-source wiring).
- Manual: `bunshin watch --open`, toggle Pro ↔ Bunshin, confirm the sprite loop animates only in nerd
  mode and the choice survives a reload.

## Open risk

The pixel sprites are authored by hand as text grids; getting them to read clearly at small scale is
iterative polish, not a correctness risk. The state→scene mapping (the load-bearing part) is pure and
fully tested. The `blocked` station precision is best-effort (see mapping notes) and not load-bearing —
the blocked reason text remains the source of truth for *why*.
