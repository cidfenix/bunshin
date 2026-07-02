'use strict';

// --- Sandboxed runs (BUN-16) --------------------------------------------------
// OPT-IN `bunshin run --sandbox`: run the unattended agent inside a Docker container against a
// FULLY ISOLATED local clone of the repo — the host working tree is never bind-mounted or written
// by the agent. Only Bunshin's own CLI writes the host repo (auto mode: `git fetch` + `--ff-only`
// after a clean exit; PR mode: via the remote). This file holds ONLY the PURE pieces (no spawn, no
// fs, no Docker), matching the repo's `resolve*` / `build*Command` pattern so they are unit-testable
// without Docker installed. The impure orchestration (dockerAvailable, cloning, spawning, sync-back)
// lives in src/util.js + src/run.js. Absent `--sandbox`, none of this runs and behavior is unchanged.

const CONFIG_FILENAME = 'bunshin.config.json';

// Container path root under which bare-string mounts are exposed (read-only), e.g. `~/.claude` ⇒
// `/sandbox-mounts/.claude`. A stable, unlikely-to-collide location inside the container.
const MOUNT_ROOT = '/sandbox-mounts';

// Cross-platform basename: split on BOTH separators so a Windows host path (`C:\Users\me\.claude`)
// and a POSIX one (`~/.config/gh`) both yield the trailing segment. Empty ⇒ the raw string.
function basename(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

// Split a mount entry into { host, container }. A `"host:container"` colon form is honoured; a bare
// string maps to `<MOUNT_ROOT>/<basename>`. A Windows drive-letter prefix (`C:\…`, `D:/…`) is NOT
// treated as the host/container separator — we look for a colon PAST that prefix. `~` in the host is
// preserved as-is (expanded at spawn time against the host home, keeping this resolver pure).
function parseMount(raw) {
  const s = raw.trim();
  const winDrive = /^[A-Za-z]:[\\/]/.test(s);
  const colon = s.indexOf(':', winDrive ? 2 : 0);
  if (colon > 0) {
    return { host: s.slice(0, colon), container: s.slice(colon + 1) };
  }
  return { host: s, container: `${MOUNT_ROOT}/${basename(s)}` };
}

// Normalize the optional top-level `sandbox` config block. Pure — throws a clear `sandbox.*`-keyed
// error on a bad type, exactly like the other resolvers. Shape:
//   { image: string|null, dockerfile: string, network: string, env: string[], mounts: [{host,container}] }
// Defaults (absent/empty block): image:null (⇒ build the shipped reference image), dockerfile:'',
// network:'none' (strongest — no network), env:[], mounts:[].
function resolveSandbox(config) {
  const block = config && config.sandbox;
  if (block == null) return { image: null, dockerfile: '', network: 'none', env: [], mounts: [] };
  if (typeof block !== 'object' || Array.isArray(block)) {
    throw new Error(
      `Invalid sandbox in ${CONFIG_FILENAME}: expected an object ` +
        `(image/dockerfile/network/env/mounts), got ${Array.isArray(block) ? 'array' : typeof block}.`
    );
  }

  // image: set ⇒ passthrough (trimmed); unset/blank ⇒ null.
  let image = null;
  if (block.image != null) {
    if (typeof block.image !== 'string') {
      throw new Error(`Invalid sandbox.image in ${CONFIG_FILENAME}: expected a string image tag, got ${typeof block.image}.`);
    }
    const trimmed = block.image.trim();
    image = trimmed || null;
  }

  // dockerfile: a path relative to the repo root; blank ⇒ '' (⇒ the shipped Dockerfile).
  let dockerfile = '';
  if (block.dockerfile != null) {
    if (typeof block.dockerfile !== 'string') {
      throw new Error(`Invalid sandbox.dockerfile in ${CONFIG_FILENAME}: expected a path string, got ${typeof block.dockerfile}.`);
    }
    dockerfile = block.dockerfile.trim();
  }

  // network: blank ⇒ 'none'; non-string throws.
  let network = 'none';
  if (block.network != null) {
    if (typeof block.network !== 'string') {
      throw new Error(`Invalid sandbox.network in ${CONFIG_FILENAME}: expected a docker --network string (e.g. "none", "default"), got ${typeof block.network}.`);
    }
    network = block.network.trim() || 'none';
  }

  // env: array of host env-var NAMES; trim/drop-empty/de-dupe (mirrors resolvePrLabels).
  const env = [];
  if (block.env != null) {
    if (!Array.isArray(block.env)) {
      throw new Error(`Invalid sandbox.env in ${CONFIG_FILENAME}: expected an array of env-var name strings (e.g. ["ANTHROPIC_API_KEY"]), got ${typeof block.env}.`);
    }
    const seen = new Set();
    block.env.forEach((entry, index) => {
      if (typeof entry !== 'string') {
        throw new Error(
          `Invalid sandbox.env[${index}] in ${CONFIG_FILENAME}: expected an env-var name string, ` +
            `got ${entry === null ? 'null' : Array.isArray(entry) ? 'array' : typeof entry}.`
        );
      }
      const name = entry.trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      env.push(name);
    });
  }

  // mounts: array of host file/dir strings; each ⇒ {host, container}. Trim/drop-empty.
  const mounts = [];
  if (block.mounts != null) {
    if (!Array.isArray(block.mounts)) {
      throw new Error(`Invalid sandbox.mounts in ${CONFIG_FILENAME}: expected an array of host path strings (e.g. ["~/.claude"]), got ${typeof block.mounts}.`);
    }
    block.mounts.forEach((entry, index) => {
      if (typeof entry !== 'string') {
        throw new Error(
          `Invalid sandbox.mounts[${index}] in ${CONFIG_FILENAME}: expected a host path string, ` +
            `got ${entry === null ? 'null' : Array.isArray(entry) ? 'array' : typeof entry}.`
        );
      }
      if (!entry.trim()) return;
      mounts.push(parseMount(entry));
    });
  }

  return { image, dockerfile, network, env, mounts };
}

// Escape a string for embedding inside a double-quoted shell argument.
function shDquote(s) {
  return String(s).replace(/"/g, '\\"');
}

// Build the full `docker run …` shell string that runs the wrapped agent command against the
// isolated clone. Pure (returns a single-line string spawned with { shell:true }), exactly like
// buildLaunchCommand. Layout:
//   docker run --rm -w /work -v <workdir>:/work --network <net> [-e NAME]… [-v host:ctr:ro]…
//     -v <statusHost>:<statusCtr> <image> sh -c "<agentCommand>"
// The workdir clone is mounted rw at /work (the agent's cwd); each allowlisted mount is read-only;
// the heartbeat status file is mounted READ-WRITE so `bunshin watch` still sees live progress.
function buildDockerCommand({ image, workdir, network, envNames, mounts, statusMount, agentCommand }) {
  const parts = ['docker', 'run', '--rm', '-w', '/work', '-v', `${workdir}:/work`, '--network', network];
  for (const name of envNames || []) {
    parts.push('-e', name);
  }
  for (const m of mounts || []) {
    parts.push('-v', `${m.host}:${m.container}:ro`);
  }
  if (statusMount && statusMount.host && statusMount.container) {
    // Read-write (no :ro) so the driver's heartbeat writes land where watch reads them.
    parts.push('-v', `${statusMount.host}:${statusMount.container}`);
  }
  parts.push(image, 'sh', '-c', `"${shDquote(agentCommand)}"`);
  return parts.join(' ');
}

module.exports = { resolveSandbox, buildDockerCommand, MOUNT_ROOT };
