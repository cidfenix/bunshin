'use strict';

// `bunshin watch` — a zero-dependency localhost dashboard over every repo running Bunshin
// on this machine. It is a PURE FILE AGGREGATOR: it reads ~/.bunshin/ (registry + per-repo
// heartbeats) and never talks to a tracker — the driver stamps tracker-derived facts into
// the heartbeats, so this process needs no MCP and no credentials. Node built-ins only.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const reg = require('./registry');

const DEFAULT_PORT = 4317;
const DEFAULT_STALE_MS = 90 * 1000;

// Cross-platform liveness probe: signal 0 only tests existence. ESRCH => gone; EPERM => the
// process exists but we may not signal it (still alive).
function defaultIsPidAlive(pid) {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readHeartbeat(file) {
  try {
    const hb = JSON.parse(fs.readFileSync(file, 'utf8'));
    return hb && typeof hb === 'object' ? hb : null;
  } catch {
    return null;
  }
}

// The aggregate the page polls. Injectable (now/isPidAlive/staleMs) so liveness is testable.
function buildStatusPayload(opts) {
  opts = opts || {};
  const home = opts.home || reg.bunshinHome();
  const now = opts.now != null ? opts.now : Date.now();
  const isPidAlive = opts.isPidAlive || defaultIsPidAlive;
  const staleMs = opts.staleMs != null ? opts.staleMs : DEFAULT_STALE_MS;

  const all = reg.readAll(home);
  const totals = { running: 0, stale: 0, stopped: 0, pending: 0, inProgress: 0 };

  const repos = Object.keys(all.repos).map((repoId) => {
    const e = all.repos[repoId];
    const alive = e.pid != null && isPidAlive(e.pid);
    const hb = readHeartbeat(e.statusFile);
    const ageMs = hb && hb.updatedAt ? now - Date.parse(hb.updatedAt) : null;
    const fresh = ageMs != null && !Number.isNaN(ageMs) && ageMs < staleMs;

    let liveness;
    if (alive && fresh) liveness = 'running';
    else if (alive || fresh) liveness = 'stale';
    else liveness = 'stopped';

    totals[liveness]++;
    if (hb && hb.queue) {
      totals.pending += Number(hb.queue.pending) || 0;
      totals.inProgress += Number(hb.queue.inProgress) || 0;
    }

    return {
      repoId,
      repoPath: e.repoPath,
      projectName: e.projectName,
      provider: e.provider,
      tracker: e.tracker,
      baseBranch: e.baseBranch,
      mergeMode: e.mergeMode,
      pid: e.pid,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      liveness,
      heartbeatAgeMs: ageMs,
      heartbeat: hb,
    };
  });

  return { generatedAt: new Date(now).toISOString(), repos, totals };
}

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Serve a repo's most recent Gate-2 screenshot, if any. Path-traversal-guarded: the resolved
// file must stay inside the repo root.
function serveArtifact(repoId, home, res) {
  const all = reg.readAll(home);
  const entry = all.repos[repoId];
  const hb = entry && readHeartbeat(entry.statusFile);
  if (!entry || !hb || !hb.lastScreenshot) return notFound(res);

  const root = path.resolve(entry.repoPath);
  const file = path.resolve(root, hb.lastScreenshot);
  if (file !== root && !file.startsWith(root + path.sep)) return notFound(res);

  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) return notFound(res);
  fs.readFile(file, (err, buf) => {
    if (err) return notFound(res);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(buf);
  });
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function createServer(opts) {
  opts = opts || {};
  const home = opts.home || reg.bunshinHome();
  const staleMs = opts.staleMs != null ? opts.staleMs : DEFAULT_STALE_MS;

  return http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPage());
      return;
    }
    if (url === '/status') {
      const payload = buildStatusPayload({ home, staleMs });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }
    const m = url.match(/^\/artifact\/([0-9a-f]{12})$/);
    if (m) return serveArtifact(m[1], home, res);
    notFound(res);
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* best-effort */
  }
}

function watch(opts) {
  opts = opts || {};
  const port = Number(opts.port) || DEFAULT_PORT;
  const server = createServer(opts);
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`Bunshin dashboard at ${url}  (Ctrl-C to stop)`);
    if (opts.open) openBrowser(url);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is in use. Pick another with --port <n>.`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  });
  return server;
}

function renderPage() {
  return PAGE;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Bunshin — dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif;
    background: #0d1017; color: #e6e9ef; }
  header { padding: 18px 24px; border-bottom: 1px solid #1d2230;
    display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  header h1 { margin: 0; font-size: 18px; letter-spacing: .5px; font-weight: 600; }
  header .sub { color: #7d8597; font-size: 12px; }
  .totals { margin-left: auto; display: flex; gap: 14px; font-size: 12px; color: #9aa3b2; }
  .totals b { color: #e6e9ef; }
  main { padding: 24px; display: grid; gap: 16px;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
  .card { background: #141925; border: 1px solid #1d2230; border-radius: 12px; padding: 16px;
    display: flex; flex-direction: column; gap: 10px; }
  .row { display: flex; align-items: center; gap: 8px; }
  .name { font-weight: 600; font-size: 15px; }
  .badge { font-size: 11px; color: #9aa3b2; background: #1d2230; padding: 2px 8px; border-radius: 999px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .running { background: #3fb950; box-shadow: 0 0 8px #3fb95088; }
  .stale { background: #d29922; box-shadow: 0 0 8px #d2992288; }
  .stopped { background: #4b5263; }
  .live-label { margin-left: auto; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: #7d8597; }
  .stepper { display: flex; gap: 6px; }
  .step { flex: 1; height: 5px; border-radius: 3px; background: #232a3a; }
  .step.done { background: #2f81f7; }
  .step.active { background: #58a6ff; box-shadow: 0 0 8px #58a6ff88; }
  .step.blocked { background: #f85149; }
  .card-title { font-size: 13px; }
  .card-title a { color: #58a6ff; text-decoration: none; }
  .meta { font-size: 12px; color: #7d8597; word-break: break-all; }
  .queue { display: flex; gap: 12px; font-size: 12px; color: #9aa3b2; }
  .queue b { color: #e6e9ef; }
  .thumb { margin-top: 4px; border-radius: 8px; border: 1px solid #1d2230; max-height: 140px; object-fit: cover; }
  .empty { color: #7d8597; padding: 48px; text-align: center; grid-column: 1 / -1; }
  .blocked-reason { color: #f85149; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>影分身 · Bunshin</h1>
  <span class="sub" id="ts">connecting…</span>
  <div class="totals" id="totals"></div>
</header>
<main id="grid"></main>
<script>
const PHASES = ['gate1','gate2','gate3','merge'];
function ago(ms){ if(ms==null) return '—'; const s=Math.round(ms/1000);
  if(s<60) return s+'s ago'; const m=Math.round(s/60); if(m<60) return m+'m ago'; return Math.round(m/60)+'h ago'; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function stepper(hb){
  const phase = hb && hb.phase;
  const blocked = phase === 'blocked';
  const idx = PHASES.indexOf(phase);
  return '<div class="stepper">' + PHASES.map((p,i)=>{
    let cls='step';
    if(blocked) cls+=' blocked';
    else if(i<idx) cls+=' done';
    else if(i===idx) cls+=' active';
    return '<div class="'+cls+'" title="'+p+'"></div>';
  }).join('') + '</div>';
}

function cardHtml(r){
  const hb = r.heartbeat;
  const card = hb && hb.card;
  const title = card ? (card.ref? esc(card.ref)+' · ':'') + esc(card.title||'') : '<span class="meta">no active goal</span>';
  const titleHtml = card && card.url ? '<a href="'+esc(card.url)+'" target="_blank">'+title+'</a>' : title;
  const q = (hb && hb.queue) || {};
  const action = hb && hb.action ? '<div class="meta">'+esc(hb.action)+'</div>' : '';
  const blocked = hb && hb.phase==='blocked' && hb.blockedReason ? '<div class="blocked-reason">⛔ '+esc(hb.blockedReason)+'</div>' : '';
  const wt = hb && hb.worktree ? '<div class="meta">⌥ '+esc(hb.worktree)+'</div>' : '';
  const thumb = hb && hb.lastScreenshot ? '<img class="thumb" src="/artifact/'+r.repoId+'?t='+Date.now()+'" onerror="this.remove()"/>' : '';
  return '<div class="card">'
    + '<div class="row"><span class="dot '+r.liveness+'"></span><span class="name">'+esc(r.projectName||r.repoPath)+'</span>'
      + '<span class="badge">'+esc(r.provider||'')+(r.tracker?' · '+esc(r.tracker):'')+'</span>'
      + '<span class="live-label">'+r.liveness+'</span></div>'
    + stepper(hb)
    + '<div class="card-title">'+titleHtml+'</div>'
    + action + blocked + wt
    + '<div class="queue"><span>pending <b>'+(q.pending||0)+'</b></span><span>blocked <b>'+(q.blocked||0)+'</b></span><span>done <b>'+(q.done||0)+'</b></span>'
      + '<span style="margin-left:auto">'+ago(r.heartbeatAgeMs)+'</span></div>'
    + thumb
    + '</div>';
}

async function tick(){
  try {
    const res = await fetch('/status'); const data = await res.json();
    const grid = document.getElementById('grid');
    if(!data.repos.length){ grid.innerHTML = '<div class="empty">No repos registered yet. Run <code>bunshin run</code> in a repo.</div>'; }
    else { grid.innerHTML = data.repos.map(cardHtml).join(''); }
    const t = data.totals;
    document.getElementById('totals').innerHTML =
      '<span><b>'+t.running+'</b> running</span><span><b>'+t.stale+'</b> stale</span>'
      +'<span><b>'+t.stopped+'</b> stopped</span><span><b>'+t.pending+'</b> pending</span><span><b>'+t.inProgress+'</b> in progress</span>';
    document.getElementById('ts').textContent = 'updated '+new Date(data.generatedAt).toLocaleTimeString();
  } catch(e){ document.getElementById('ts').textContent = 'disconnected'; }
}
tick(); setInterval(tick, 3000);

</script>
</body>
</html>`;

module.exports = { watch, buildStatusPayload, createServer, defaultIsPidAlive, renderPage, DEFAULT_PORT };
