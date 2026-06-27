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

// Pure state -> nerd-view scene descriptor. SINGLE SOURCE OF TRUTH: exported for the
// Node tests AND inlined into the page via sceneFor.toString(), so the browser runs the
// exact same mapping. MUST stay self-contained (no closure over module scope).
function sceneFor(repo) {
  var hb = (repo && repo.heartbeat) || null;
  var phase = hb && hb.phase;
  var liveness = repo && repo.liveness;
  var STATIONS = { gate1: 0, gate2: 1, gate3: 2, merge: 3 };
  var card = hb && hb.card;
  var q = (hb && hb.queue) || {};
  var cardTitle = card ? (card.ref ? card.ref + ' · ' : '') + (card.title || '') : '';
  var scene = {
    liveness: liveness,
    loopPose: 'check',
    goalActive: false,
    station: -1,
    blocked: false,
    cardTitle: cardTitle,
    pending: Number(q.pending) || 0,
    done: Number(q.done) || 0,
  };
  if (liveness === 'stopped') { scene.loopPose = 'gone'; return scene; }
  if (liveness === 'stale') { scene.loopPose = 'sleep'; return scene; }
  // running: the loop checks the board, and if a goal is active a clone works a gate.
  if (phase === 'blocked') {
    scene.goalActive = true;
    scene.blocked = true;
    scene.station = 0; // best-effort: heartbeat carries no gate index when blocked
    return scene;
  }
  if (Object.prototype.hasOwnProperty.call(STATIONS, phase)) {
    scene.goalActive = true;
    scene.station = STATIONS[phase];
  }
  return scene;
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
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { margin: 0; font-size: 18px; letter-spacing: .5px; font-weight: 600; }
  header .sub { color: #7d8597; font-size: 12px; }
  .toggle { display: flex; border: 1px solid #1d2230; border-radius: 999px; overflow: hidden; }
  .tg { background: transparent; color: #9aa3b2; border: 0; padding: 5px 13px; font: inherit;
    font-size: 12px; cursor: pointer; }
  .tg.on { background: #ff7a18; color: #0d1017; font-weight: 600; }
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
  .dojo { background: #141925; border: 1px solid #1d2230; border-radius: 12px; padding: 12px;
    display: flex; flex-direction: column; gap: 6px; }
  .dojo.is-blocked { border-color: #f8514955; }
  .dojo-canvas { width: 100%; height: auto; image-rendering: pixelated;
    background: #0b0e15; border-radius: 8px; display: block; }
  .stations { display: flex; justify-content: space-between; font-size: 10px;
    letter-spacing: .5px; color: #7d8597; padding: 0 6px; }
</style>
</head>
<body>
<header>
  <h1>影分身 · Bunshin</h1>
  <div class="toggle">
    <button id="tg-pro" class="tg on" onclick="setView('pro')">Pro</button>
    <button id="tg-nerd" class="tg" onclick="setView('nerd')">🥷 Bunshin</button>
  </div>
  <span class="sub" id="ts">connecting…</span>
  <div class="totals" id="totals"></div>
</header>
<main id="view-pro"></main>
<main id="view-nerd" style="display:none"></main>
<script>
${sceneFor.toString()}

const PHASES = ['gate1','gate2','gate3','merge'];
function ago(ms){ if(ms==null) return '—'; const s=Math.round(ms/1000);
  if(s<60) return s+'s ago'; const m=Math.round(s/60); if(m<60) return m+'m ago'; return Math.round(m/60)+'h ago'; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/* ---------- Pro view (the original tile grid) ---------- */
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

function renderPro(data){
  const root = document.getElementById('view-pro');
  if(!data.repos.length){ root.innerHTML = '<div class="empty">No repos registered yet. Run <code>bunshin run</code> in a repo.</div>'; }
  else { root.innerHTML = data.repos.map(cardHtml).join(''); }
}

/* ---------- Nerd view (Kage Bunshin pixel dojos) ---------- */
const PALETTE = {
  '.': null,
  'K': '#0d0a12', 'b': '#241a33', 'g': '#3a2c52', 's': '#e8b58a',
  'e': '#ffffff', 'a': '#ff7a18', 'w': '#cdd3e0', 'y': '#ffd84d',
};
const NINJA = [
  '..KKKKKK..','.KKKKKKKK.','.KaaaaaaK.','.KKeKKeKK.','.KKKKKKKK.',
  '..KbbbbK..','.KbbbbbbK.','.KbgbbgbK.','.KbbbbbbK.','..Kb..bK..','..KK..KK..',
];
const POOF = ['...ww....','..wwww.w.','.wwwwwww.','.wwwwwww.','..wwwww..'];
const PROP_BOARD = ['wwwwww','wKKKKw','wKwwKw','wwwwww'];
const PROPS = {
  gate1: ['KKKKKK','KwKwKw'],
  gate2: ['.ww..','w..w.','w..w.','.ww..','...KK'],
  gate3: ['yyyyyy','yKyyKy','yyyyyy'],
  merge: ['aa..aa','.aaaa.'],
};
const GATE_KEYS = ['gate1','gate2','gate3','merge'];

function drawSprite(ctx, rows, x, y, sc, alpha, tint){
  if(!rows) return;
  ctx.save();
  if(alpha!=null) ctx.globalAlpha = alpha;
  for(var r=0;r<rows.length;r++){
    var row=rows[r];
    for(var c=0;c<row.length;c++){
      var col=PALETTE[row[c]];
      if(!col) continue;
      ctx.fillStyle = tint || col;
      ctx.fillRect(x + c*sc, y + r*sc, sc, sc);
    }
  }
  ctx.restore();
}

function drawDojo(cv, repo, now){
  var ctx=cv.getContext('2d'); if(!ctx) return;
  ctx.imageSmoothingEnabled=false;
  var W=cv.width, H=cv.height, sc=3;
  var s=sceneFor(repo);
  ctx.clearRect(0,0,W,H);
  if(s.blocked){ ctx.fillStyle='#2a1416'; ctx.fillRect(0,0,W,H); }
  ctx.fillStyle='#1d2230'; ctx.fillRect(0,H-6,W,2);            // ground line
  var bob=Math.round(Math.sin(now/300)*2);
  var fast=Math.round(Math.sin(now/110)*2);
  var nh=NINJA.length*sc, nw=NINJA[0].length*sc, baseY=H-8-nh, lx=8;
  // loop ninja (original)
  if(s.loopPose==='gone'){
    drawSprite(ctx, POOF, lx, baseY+10, sc, 0.35);
  } else if(s.loopPose==='sleep'){
    drawSprite(ctx, NINJA, lx, baseY+4, sc, 0.6);
    ctx.fillStyle='#7d8597';
    for(var z=0;z<3;z++) ctx.fillRect(lx+nw+z*4, baseY+2-z*4, 2, 2);   // zzz
  } else {
    drawSprite(ctx, NINJA, lx, baseY+bob, sc, 1);
    if(s.loopPose==='check') drawSprite(ctx, PROP_BOARD, lx+nw+2, baseY+bob+8, sc, 1);
  }
  // gate-station platforms
  var startX=86, span=W-startX-12, gap=span/4;
  for(var i=0;i<4;i++){
    var sx=startX+i*gap, passed=s.goalActive && i<s.station;
    ctx.fillStyle = passed ? '#2f81f7' : (s.goalActive && i===s.station ? '#3a2c52' : '#232a3a');
    ctx.fillRect(sx, H-7, gap-12, 3);
    if(passed){ ctx.fillStyle='#3fb950'; ctx.fillRect(sx+(gap-12)/2-2, H-13, 4, 4); }   // done tick
  }
  // goal-clone + active-gate sub-clone (shadow clones: translucent + cool aura)
  if(s.goalActive){
    var cx=44;
    drawSprite(ctx, NINJA, cx+2, baseY+bob, sc, 0.22, '#39c5cf');
    drawSprite(ctx, NINJA, cx, baseY+bob, sc, 0.55);
    if(s.station>=0){
      var stX=startX+s.station*gap+2, subY=baseY+(s.blocked?6:fast);
      drawSprite(ctx, NINJA, stX+2, subY, sc, 0.2, '#39c5cf');
      drawSprite(ctx, NINJA, stX, subY, sc, s.blocked?0.5:0.6, s.blocked?'#f85149':null);
      if(s.blocked){ ctx.fillStyle='#f85149'; ctx.fillRect(stX+nw, subY, 3, 3); ctx.fillRect(stX+nw, subY+6, 3, 3); }
      else { var prop=PROPS[GATE_KEYS[s.station]]; if(prop) drawSprite(ctx, prop, stX+nw, subY+nh-10, sc, 0.95); }
    }
  }
}

var repoById = {};
var nerdKeys = '';
function dojoHtml(r){
  return '<div class="dojo" id="dj-'+r.repoId+'">'
    + '<div class="row"><span id="dj-dot-'+r.repoId+'" class="dot '+r.liveness+'"></span>'
      + '<span class="name">'+esc(r.projectName||r.repoPath)+'</span>'
      + '<span class="live-label">'+r.liveness+'</span></div>'
    + '<canvas class="dojo-canvas" data-repo="'+r.repoId+'" width="320" height="88"></canvas>'
    + '<div class="stations"><span>Gate1</span><span>Gate2</span><span>Gate3</span><span>Merge</span></div>'
    + '<div class="card-title" id="dj-title-'+r.repoId+'"></div>'
    + '<div class="queue" id="dj-queue-'+r.repoId+'"></div>'
    + '</div>';
}

function renderNerd(data){
  const root = document.getElementById('view-nerd');
  repoById = {}; data.repos.forEach(function(r){ repoById[r.repoId]=r; });
  if(!data.repos.length){
    root.innerHTML = '<div class="empty">No repos registered yet. Run <code>bunshin run</code> in a repo.</div>';
    nerdKeys=''; return;
  }
  // Only rebuild the DOM (and re-create canvases) when the set of repos changes;
  // the rAF loop keeps drawing, and per-tick text is patched in place below.
  const keys = data.repos.map(function(r){ return r.repoId; }).join(',');
  if(keys!==nerdKeys){ nerdKeys=keys; root.innerHTML = data.repos.map(dojoHtml).join(''); }
  data.repos.forEach(function(r){
    var s=sceneFor(r);
    var dot=document.getElementById('dj-dot-'+r.repoId); if(dot) dot.className='dot '+r.liveness;
    var t=document.getElementById('dj-title-'+r.repoId); if(t) t.textContent = s.cardTitle || '— no active goal —';
    var q=document.getElementById('dj-queue-'+r.repoId);
    if(q) q.innerHTML = 'pending <b>'+s.pending+'</b> · done <b>'+s.done+'</b>';
    var card=document.getElementById('dj-'+r.repoId); if(card) card.className='dojo'+(s.blocked?' is-blocked':'');
  });
}

function animate(now){
  if(view==='nerd'){
    var list=document.querySelectorAll('#view-nerd canvas[data-repo]');
    for(var i=0;i<list.length;i++){ var r=repoById[list[i].getAttribute('data-repo')]; if(r) drawDojo(list[i], r, now); }
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

/* ---------- view toggle + polling ---------- */
var view = localStorage.getItem('bunshin.watch.view')==='nerd' ? 'nerd' : 'pro';
var lastData = null;
function render(data){ if(view==='pro') renderPro(data); else renderNerd(data); }
function setView(v){
  view = (v==='nerd') ? 'nerd' : 'pro';
  localStorage.setItem('bunshin.watch.view', view);
  document.getElementById('view-pro').style.display = view==='pro' ? '' : 'none';
  document.getElementById('view-nerd').style.display = view==='nerd' ? '' : 'none';
  document.getElementById('tg-pro').className = 'tg'+(view==='pro'?' on':'');
  document.getElementById('tg-nerd').className = 'tg'+(view==='nerd'?' on':'');
  if(lastData) render(lastData);
}

async function tick(){
  try {
    const res = await fetch('/status'); const data = await res.json();
    lastData = data;
    render(data);
    const t = data.totals;
    document.getElementById('totals').innerHTML =
      '<span><b>'+t.running+'</b> running</span><span><b>'+t.stale+'</b> stale</span>'
      +'<span><b>'+t.stopped+'</b> stopped</span><span><b>'+t.pending+'</b> pending</span><span><b>'+t.inProgress+'</b> in progress</span>';
    document.getElementById('ts').textContent = 'updated '+new Date(data.generatedAt).toLocaleTimeString();
  } catch(e){ document.getElementById('ts').textContent = 'disconnected'; }
}
setView(view);          // apply persisted choice on load
tick(); setInterval(tick, 3000);

</script>
</body>
</html>`;

module.exports = { watch, buildStatusPayload, createServer, defaultIsPidAlive, renderPage, sceneFor, DEFAULT_PORT };
