# Sandboxed runs — Docker Desktop (BUN-16)

**Status:** Design (approved shape, pending spec review)
**Date:** 2026-07-02
**Scope:** Single-repo `bunshin run` only. First sandbox backend: local Docker (Docker Desktop / `docker` CLI).

---

## 1. Problem & goal

`bunshin run --unattended` launches an agent CLI with **all permission prompts bypassed**
(`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`). That agent then runs
git, edits files, and merges to the base branch on the **host**, with no human in the loop. A misbehaving
or prompt-injected agent can therefore touch anything the host user can.

**Goal:** an opt-in `--sandbox` mode that **isolates the agent's destructive actions** from the host —
the agent runs inside a Docker container and, critically, **never touches the host repository at all**.
Only Bunshin's own CLI writes the host repo, and only as one deterministic, controlled step.

This is an **optional isolation wrapper**, not a new pipeline. Absent `--sandbox`, behavior is 100%
unchanged.

## 2. Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| Primary motivation | **Isolate destructive actions** of the unattended agent. |
| Boundary | **Fully isolated clone** — the agent works on a clone, never the host repo. |
| Image source | **Ship a reference Dockerfile + allow `sandbox.image` override.** |
| Secrets | **Explicit allowlist** — `sandbox.env` (env var names) + `sandbox.mounts` (files), only what's named crosses. |
| Sync-back | **Support both modes** — PR mode pushes to the remote; auto mode pushes/fetches the branch back to the host repo, host merges. |

## 3. Chosen approach — "CLI prepares an isolated clone, container is dumb"

The container orchestration lives in the **CLI** (`src/`), as pure/unit-testable functions matching this
repo's existing `resolve*` / `build*Command` pattern. The container itself does nothing clever — it just
runs the wrapped agent command against a mounted clone.

**Why not the alternatives:** an in-container `entrypoint.sh` that clones + syncs (approach B) pushes logic
into untestable shell and requires bind-mounting the real repo (weaker isolation); a driver-level sandbox
(approach C) mixes the CLI's launch job into the markdown pipeline. Approach A keeps the new logic pure,
leaves `driver.md` nearly untouched, and makes the host repo **unmounted** (strongest isolation).

### Execution model

1. **Guards** (in addition to the existing git-repo / config / clean-tree / agent-on-PATH guards):
   Docker must be available — `docker` on PATH **and** the daemon reachable (`docker info` exits 0).
   A clear "start Docker Desktop" error otherwise. The clean-tree guard **stays** (auto mode still
   fast-forwards the host tree at the end). `--sandbox` combined with `--orchestrator` errors clearly
   (out of scope for this slice).
2. **Resolve/ensure the image.** If `sandbox.image` is set → use it as-is. Else build the shipped
   reference image: `docker build -f template/sandbox/Dockerfile -t bunshin-sandbox:<pkgVersion> <ctx>`.
   Tagged by package version so it only rebuilds on a Bunshin upgrade (Docker layer cache makes repeat
   builds cheap).
3. **Prepare the isolated clone.** `git clone --local <root> <root>/.bunshin/sandbox-work` (hardlinked
   objects — fast, disk-cheap). Fresh each run (removed + re-created). The path is under the already-
   gitignored `.bunshin/` area. For **PR mode**, re-point the clone's `origin` at the real remote
   (`git remote set-url origin <realRemoteUrl>`) so the in-container push/PR targets GitHub, not the
   local source.
4. **Wrap + launch.** Build the agent command exactly as today (`buildLaunchCommand`), then wrap it via
   `buildDockerCommand`: `docker run --rm -v <clone>:/work -w /work --network <net> -e NAME … -v
   <hostFile>:<ctrFile>:ro … <image> sh -c "<agentCommand>"`. `spawn(dockerCmd, { shell:true,
   stdio:'inherit' })`. Registry + heartbeat wiring is unchanged (the dashboard still sees the repo; the
   status file is still bind-mounted in so heartbeats work).
5. **Sync-back on exit 0.**
   - **PR mode:** nothing — the container already pushed the branch and opened the PR against the remote.
   - **auto mode:** the **host CLI** performs the single host-repo write: `git fetch <clone> <baseBranch>`
     then fast-forward the host `<baseBranch>` to the fetched sha (`git merge --ff-only`). If the host base
     moved and a fast-forward is impossible, do **not** force — report it and leave the clone in place for
     inspection (the goal's commits are safe in the clone).

   Non-zero container exit ⇒ no sync-back; surface the exit code (mirrors today's `child.on('exit')`).

The **agent never writes the host repo.** In auto mode the merge lands via Bunshin's deterministic
`git fetch` + `--ff-only`; in PR mode it lands via the remote. The host repo is never bind-mounted.

## 4. Surface

### CLI

`bunshin run --sandbox` (new boolean flag; add to `bin/bunshin.js` parseArgs' flag list + `--help`).
Absent ⇒ today's direct-host launch. `--sandbox --orchestrator` ⇒ clear error.

### Config — new top-level `sandbox` block (all keys optional)

```jsonc
"sandbox": {
  "$comment": "OPTIONAL. Only used when you pass `bunshin run --sandbox`. Runs the agent inside a Docker container against an ISOLATED CLONE of this repo — the agent never touches your real working tree. Requires Docker (Docker Desktop / the `docker` CLI) running. Absent / not passing --sandbox ⇒ the agent runs directly on the host (unchanged).",
  "image": "",            // "" ⇒ build/use the shipped reference image (bunshin-sandbox:<version>); else use THIS image tag as-is.
  "dockerfile": "",       // "" ⇒ the shipped template/sandbox/Dockerfile; else a path (relative to the repo root) to your own.
  "network": "none",      // docker --network: "none" (default, strongest — no network) | "default" | a named docker network. Note: PR mode / MCP trackers need network; set "default" then.
  "env": [],              // Allowlist of host env-var NAMES to inject into the container (-e NAME). e.g. ["ANTHROPIC_API_KEY","GH_TOKEN"]. Only what's named crosses.
  "mounts": []            // Allowlist of host files/dirs to bind-mount READ-ONLY. e.g. ["~/.claude","~/.config/gh"]. `~` expands to the host home. Only what's named crosses.
}
```

Everything is an **explicit allowlist**: only the env vars in `sandbox.env` and the files in
`sandbox.mounts` cross the boundary. `network: "none"` is the default (no network); note that PR mode
and MCP trackers require network, so those setups must set `"default"`.

## 5. New / changed code

### `src/sandbox.js` (new — pure, unit-tested)

- `resolveSandbox(config)` → normalized `{ image: string|null, dockerfile: string, network: string,
  env: string[], mounts: [{host, container}] }`.
  - Defaults: `image:null` (⇒ build shipped), `dockerfile:''`, `network:'none'`, `env:[]`, `mounts:[]`.
  - `env`: array of strings; trims, drops empties, de-dupes (mirrors `resolvePrLabels`). Non-array or
    non-string entry throws a `sandbox.env`-referencing error.
  - `mounts`: array of strings; each becomes `{host, container}` where `container` is a stable path under
    a sandbox mount root (e.g. `/sandbox-mounts/<basename>`), or `"host:container"` if a colon form is
    given. `~` is preserved as-is in the returned `host` (expanded at spawn time against the host home,
    NOT in the pure resolver — keeps it pure). Non-array / non-string throws `sandbox.mounts`-referencing.
  - `network`: string; blank ⇒ `'none'`. Non-string throws.
  - Bad-type errors reference the exact `sandbox.*` key, matching the existing resolvers' style.
- `buildDockerCommand({ image, workdir, network, envNames, mounts, statusMount, agentCommand })` → the
  full `docker run …` shell string. Pure. Handles: `--rm`, `-w /work`, `-v <workdir>:/work`, `--network`,
  one `-e NAME` per env name, one `-v host:ctr:ro` per mount (+ the status-file mount rw so heartbeats
  work), `<image>`, and `sh -c "<agentCommand>"` (quoted). Unit-testable exactly like `buildLaunchCommand`.

### `src/util.js`

- `dockerAvailable()` — `hasExecutable('docker')` **and** `docker info` exits 0 (daemon reachable). Not
  pure (spawns), lives beside `hasExecutable`. Returns boolean. (The pure builders stay in `sandbox.js`.)

### `src/run.js`

- `run()` gains a sandbox branch when `opts.sandbox`:
  - Reject `--sandbox --orchestrator` up front.
  - `dockerAvailable()` guard with the Docker-Desktop error.
  - Ensure image (build shipped if `sandbox.image` unset), prepare the clone, expand `~` in mount hosts,
    build the docker command via `buildDockerCommand`, spawn it (same `shell:true, stdio:'inherit'`).
  - On exit 0, run the auto-mode fetch + `--ff-only` sync-back (PR mode: no-op).
  - Registry `register()`/`markStopped()` unchanged. The heartbeat status file is bind-mounted into the
    container so the driver's heartbeat writes still land where `watch` reads them.
- The non-sandbox path is untouched.

### `template/sandbox/Dockerfile` (new — reference image)

Base `node:20-slim` (or bookworm), plus: `git`, the agent CLI (`@anthropic-ai/claude-code` for claude;
document the codex variant), and Playwright + its browser deps for the `verify` gate. `WORKDIR /work`.
No `ENTRYPOINT` that hijacks the command — docker runs the wrapped agent command as given (`sh -c …`).
Reference/default; overridable via `sandbox.image` / `sandbox.dockerfile` (the "ship + allow override"
decision). Keep it minimal and documented.

### `template/bunshin.config.template.json`

Add the `sandbox` block from §4 with its `$comment`, after the `commands`/`verify` area.

### `template/driver.md`

One added **"Sandbox awareness"** note near the intro (and a one-line pointer in INTEGRATION): when you
are running sandboxed you are inside an **isolated clone**, so — auto mode: the merge target is *this
clone's* `baseBranch` and the host fast-forwards it back afterward (do the local `--ff-only` merge in the
clone as usual; you do not push anywhere); PR mode: push + open the PR against the remote exactly as
today (origin already points at it). The rest of the pipeline is unchanged — the driver does not know or
care that its cwd is a clone.

## 6. Tests (`test/sandbox.test.js`, wired into `npm test`)

Plain-Node `assert`, matching the existing test style:

- `resolveSandbox`:
  - absent / `{}` / `{ sandbox: {} }` ⇒ the documented defaults.
  - `env` normalization: trims, drops blanks, de-dupes; non-array throws `/sandbox\.env/`; non-string
    entry throws `/sandbox\.env/`.
  - `mounts` normalization: string ⇒ `{host, container}`; `"host:ctr"` colon form respected; non-array /
    non-string throws `/sandbox\.mounts/`.
  - `network`: blank ⇒ `'none'`; non-string throws `/sandbox\.network/`.
  - `image`: set ⇒ passthrough; unset ⇒ `null`.
- `buildDockerCommand`:
  - contains `docker run --rm`, `-w /work`, the `-v <workdir>:/work` mount, `--network <net>`.
  - one `-e NAME` per env name; one `-v host:ctr:ro` per mount; the status mount present.
  - the agent command appears inside a quoted `sh -c "…"`.

Add a layout guard (extend `test/gates-layout.test.js` or a small check) that `template/sandbox/Dockerfile`
exists and is shipped (it's under `template/`, already in `package.json` `files`).

## 7. Docs

- **README:** new "Sandboxed runs (Docker Desktop)" section — what it isolates, `--sandbox`, the
  `sandbox` config block, the network/secrets allowlist caveat (PR/MCP need `network:"default"` + the
  relevant `env`/`mounts`), and the "host repo is never touched" guarantee. Update the badges/requirements
  prose to note Docker as an **optional** prerequisite (only for `--sandbox`).
- **CLAUDE.md:** a LOCKED-decisions note that `--sandbox` is an optional isolation wrapper (host repo
  unmounted; only the CLI writes it, via `git fetch` + `--ff-only` in auto mode / the remote in PR mode);
  a `Key files` row for `src/sandbox.js` + `template/sandbox/Dockerfile`; a "Current status" BUN-16 entry.

## 8. Scope guardrails (YAGNI)

- **Single-repo only.** `--sandbox --orchestrator` errors; orchestrator sandboxing is a later slice.
- **Docker Desktop / local `docker` CLI only.** No Podman, no remote Docker hosts, no rootless-specific
  handling yet.
- **One container per run** (like today's one process per run) — no per-goal container reuse/pooling.
- **No new npm dependencies, no build step** (LOCKED decision 2). Docker is an external *runtime*
  prerequisite alongside the agent CLI + MCPs, gated to `--sandbox`.

## 9. Open questions / risks

- **Windows path bind-mounts.** `docker run -v` needs a Docker-Desktop-consumable path. `git clone`
  writes a normal Windows path; verify `-v C:\…:/work` works (Docker Desktop accepts Windows paths) or
  normalize. Covered by manual smoke on the dev machine; the pure builder just emits the path it's given.
- **`~` expansion for mounts.** Done at spawn time against the host home (not in the pure resolver), so
  `resolveSandbox` stays pure and unit-testable.
- **First-run image build latency.** Documented; the version-tagged image + layer cache keep repeats fast.
