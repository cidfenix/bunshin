'use strict';

// The shared per-user home that RELATES every repo running Bunshin on this machine.
// `bunshin run` registers a repo here (identity + PID); the driver heartbeats per goal
// into status/<repoId>.json; `bunshin watch` reads this directory. Node built-ins only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;

function bunshinHome() {
  return path.join(os.homedir(), '.bunshin');
}

function statusDir(home) {
  return path.join(home || bunshinHome(), 'status');
}

function registryPath(home) {
  return path.join(home || bunshinHome(), 'registry.json');
}

// Stable, filesystem-safe id for a repo: first 12 hex of sha256(absolute path). The same
// checkout keeps its id (and dashboard tile) across re-runs.
function repoIdFor(repoPath) {
  const resolved = path.resolve(repoPath);
  return crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 12);
}

function statusFileFor(repoId, home) {
  return path.join(statusDir(home), `${repoId}.json`);
}

// Atomic write: temp file in the same dir, then rename over the target, so a concurrent
// reader never sees a half-written file.
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// Tolerant read: a missing or unreadable registry yields an empty one rather than throwing.
function readAll(home) {
  try {
    const data = JSON.parse(fs.readFileSync(registryPath(home), 'utf8'));
    if (!data || typeof data !== 'object' || !data.repos) return { schemaVersion: SCHEMA_VERSION, repos: {} };
    return data;
  } catch {
    return { schemaVersion: SCHEMA_VERSION, repos: {} };
  }
}

// Register (or update in place) a repo. `entry.repoPath` is required; repoId is derived.
// Returns the repoId. Fills in statusFile and a null endedAt.
function register(entry, home) {
  if (!entry || !entry.repoPath) throw new Error('register: entry.repoPath is required');
  const repoId = repoIdFor(entry.repoPath);
  const all = readAll(home);
  all.schemaVersion = SCHEMA_VERSION;
  all.repos[repoId] = {
    repoPath: path.resolve(entry.repoPath).split(/[\\/]/).join('/'),
    projectName: entry.projectName || null,
    provider: entry.provider || null,
    tracker: entry.tracker || null,
    baseBranch: entry.baseBranch || null,
    mergeMode: entry.mergeMode || null,
    pid: entry.pid != null ? entry.pid : null,
    startedAt: entry.startedAt || null,
    endedAt: null,
    statusFile: statusFileFor(repoId, home),
  };
  writeJsonAtomic(registryPath(home), all);
  return repoId;
}

// Mark a repo's loop as ended (best-effort; the dashboard also probes the PID).
function markStopped(repoId, home, endedAt) {
  const all = readAll(home);
  const entry = all.repos[repoId];
  if (!entry) return;
  entry.endedAt = endedAt || new Date().toISOString();
  writeJsonAtomic(registryPath(home), all);
}

module.exports = {
  SCHEMA_VERSION,
  bunshinHome,
  statusDir,
  registryPath,
  repoIdFor,
  statusFileFor,
  writeJsonAtomic,
  readAll,
  register,
  markStopped,
};
