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

// Pure canvas geometry for the 🥷 Bunshin dojo, given a canvas size. SINGLE SOURCE OF
// TRUTH: exported for the Node tests AND inlined into the page via dojoLayout.toString(),
// so the browser computes the exact same layout. Drives the (now much larger, anime-styled)
// figure height and the four gate-station x positions. MUST stay self-contained.
function dojoLayout(W, H) {
  var groundY = Math.round(H * 0.92);
  var figH = Math.round(H * 0.7); // big figures: most of the tile height (was ~33px)
  var loopX = Math.round(W * 0.1); // loop ninja, far left
  var cloneX = Math.round(W * 0.26); // its cast shadow clone
  var first = Math.round(W * 0.46);
  var last = W - Math.round(W * 0.07);
  var gap = (last - first) / 3; // four stations: gate1, gate2, gate3, merge
  var stations = [0, 1, 2, 3].map(function (i) { return Math.round(first + i * gap); });
  return { groundY: groundY, figH: figH, loopX: loopX, cloneX: cloneX, stations: stations, gap: gap };
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
  .dojo-canvas { width: 100%; height: auto; image-rendering: auto;
    background: radial-gradient(120% 90% at 50% 18%, #11151f 0%, #0b0e15 70%);
    border-radius: 8px; display: block; }
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
${dojoLayout.toString()}

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

/* ---------- 🥷 Bunshin view (anime-styled Kage Bunshin dojos) ----------
   Figures are now drawn as smooth, detailed vector ninja (big head, spiky Naruto
   hair, headband + forehead protector, scarf, jumpsuit) instead of coarse pixel
   sprites — much larger and less blocky. dojoLayout() (inlined above) sizes them. */
const GATE_KEYS = ['gate1','gate2','gate3','merge'];

// rounded rectangle path helper
function rrect(ctx,x,y,w,h,r){
  r=Math.min(r,Math.abs(w)/2,Math.abs(h)/2);
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}

// A soft chakra aura behind a shadow clone.
function drawAura(ctx,cx,cy,r,col){
  var g=ctx.createRadialGradient(cx,cy,0,cx,cy,r);
  g.addColorStop(0,col+'55'); g.addColorStop(0.6,col+'22'); g.addColorStop(1,col+'00');
  ctx.save(); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill(); ctx.restore();
}

// Poof of smoke (shadow clone dispelled).
function drawPoof(ctx,cx,cy,r,a){
  ctx.save(); ctx.globalAlpha=a; ctx.fillStyle='#cdd3e0';
  var p=[[0,0,1],[-0.8,0.15,0.65],[0.8,0.1,0.65],[-0.4,-0.55,0.55],[0.45,-0.5,0.55],[0,0.55,0.6]];
  for(var i=0;i<p.length;i++){ ctx.beginPath(); ctx.arc(cx+p[i][0]*r, cy+p[i][1]*r, r*p[i][2]*0.7, 0, Math.PI*2); ctx.fill(); }
  ctx.restore();
}

// Drowsy "z z z".
function drawZ(ctx,x,y,sz){
  ctx.save(); ctx.fillStyle='#7d8597'; ctx.textBaseline='alphabetic';
  for(var z=0;z<3;z++){ ctx.globalAlpha=0.85-z*0.22; ctx.font='bold '+Math.round(sz*(1+z*0.5))+'px sans-serif';
    ctx.fillText('z', x+z*sz*1.1, y-z*sz*1.4); }
  ctx.restore();
}

// A little parchment scroll/clipboard the loop ninja & gate-1 clone hold.
function drawScroll(ctx,x,y,sz){
  ctx.save();
  ctx.fillStyle='#e8d8a8'; rrect(ctx,x,y,sz*1.5,sz,sz*0.16); ctx.fill();
  ctx.fillStyle='#c0a060'; rrect(ctx,x-sz*0.06,y,sz*0.2,sz,sz*0.08); ctx.fill();
  rrect(ctx,x+sz*1.36,y,sz*0.2,sz,sz*0.08); ctx.fill();
  ctx.strokeStyle='#7a5a2a'; ctx.lineWidth=Math.max(1,sz*0.07);
  for(var i=1;i<=2;i++){ ctx.beginPath(); ctx.moveTo(x+sz*0.32,y+sz*i/3); ctx.lineTo(x+sz*1.2,y+sz*i/3); ctx.stroke(); }
  ctx.restore();
}

// Per-gate tool glyph held by the working sub-clone.
function drawProp(ctx, key, x, y, sz){
  ctx.save();
  if(key==='gate1'){ drawScroll(ctx,x,y,sz); }
  else if(key==='gate2'){ // screen with a glowing eye (Playwright smoke)
    ctx.fillStyle='#0b0e15'; rrect(ctx,x,y,sz*1.5,sz,sz*0.12); ctx.fill();
    ctx.strokeStyle='#39c5cf'; ctx.lineWidth=Math.max(1,sz*0.08); rrect(ctx,x+sz*0.1,y+sz*0.12,sz*1.3,sz*0.76,sz*0.1); ctx.stroke();
    ctx.fillStyle='#39c5cf'; ctx.beginPath(); ctx.arc(x+sz*0.75,y+sz*0.5,sz*0.22,0,Math.PI*2); ctx.fill();
  } else if(key==='gate3'){ // approval seal/stamp
    ctx.fillStyle='#ffd84d'; ctx.beginPath(); ctx.arc(x+sz*0.6,y+sz*0.5,sz*0.5,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#0b0e15'; ctx.lineWidth=Math.max(1.5,sz*0.1); ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(x+sz*0.36,y+sz*0.55); ctx.lineTo(x+sz*0.55,y+sz*0.72); ctx.lineTo(x+sz*0.86,y+sz*0.3); ctx.stroke();
  } else { // merge swirl
    ctx.strokeStyle='#ff7a18'; ctx.lineWidth=Math.max(1.5,sz*0.14); ctx.lineCap='round';
    ctx.beginPath(); ctx.arc(x+sz*0.6,y+sz*0.5,sz*0.42,-0.4,Math.PI*1.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(x+sz*0.6,y+sz*0.5,sz*0.18,Math.PI,Math.PI*2.6); ctx.stroke();
  }
  ctx.restore();
}

// The star: a smooth, detailed chibi-anime ninja. cx = horizontal center, footY = ground,
// h = total height. o: { alpha, body, accent, skin, hair, plate, line, flutter }.
function drawNinja(ctx, cx, footY, h, o){
  o=o||{};
  var a=o.alpha==null?1:o.alpha;
  var body=o.body||'#28304a';     // jumpsuit
  var accent=o.accent||'#ff7a18'; // scarf / trim (Naruto orange by default)
  var skin=o.skin||'#f2c79c';
  var hair=o.hair||'#10131c';
  var plate=o.plate||'#aab4c6';   // forehead metal protector
  var line=o.line||'#0b0e15';
  var flut=o.flutter||0;
  ctx.save();
  ctx.globalAlpha=a; ctx.lineJoin='round'; ctx.lineCap='round';

  var headR=h*0.2;
  var headCY=footY-h*0.74;
  var shoulderY=headCY+headR*0.92;
  var hipY=footY-h*0.3;
  var torsoW=h*0.32;
  var armW=h*0.09, armLen=hipY-shoulderY+h*0.03;

  // ----- legs + sandals -----
  var legW=h*0.115, legGap=h*0.025;
  ctx.fillStyle=body;
  rrect(ctx, cx-legGap-legW, hipY, legW, footY-hipY, legW*0.45); ctx.fill();
  rrect(ctx, cx+legGap, hipY, legW, footY-hipY, legW*0.45); ctx.fill();
  ctx.fillStyle=line;
  rrect(ctx, cx-legGap-legW-h*0.01, footY-h*0.05, legW+h*0.02, h*0.055, h*0.025); ctx.fill();
  rrect(ctx, cx+legGap-h*0.01, footY-h*0.05, legW+h*0.02, h*0.055, h*0.025); ctx.fill();

  // ----- arms (behind torso) -----
  ctx.fillStyle=body;
  rrect(ctx, cx-torsoW/2-armW*0.55, shoulderY+h*0.03, armW, armLen, armW*0.5); ctx.fill();
  rrect(ctx, cx+torsoW/2-armW*0.45, shoulderY+h*0.03, armW, armLen, armW*0.5); ctx.fill();
  ctx.fillStyle=skin; // hands
  ctx.beginPath(); ctx.arc(cx-torsoW/2-armW*0.05, shoulderY+h*0.03+armLen, armW*0.55,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx+torsoW/2+armW*0.05, shoulderY+h*0.03+armLen, armW*0.55,0,Math.PI*2); ctx.fill();

  // ----- torso (jumpsuit) -----
  ctx.fillStyle=body;
  rrect(ctx, cx-torsoW/2, shoulderY, torsoW, hipY-shoulderY+h*0.03, h*0.06); ctx.fill();
  ctx.fillStyle=accent; // zipper stripe
  ctx.fillRect(cx-h*0.014, shoulderY+h*0.04, h*0.028, (hipY-shoulderY)-h*0.02);

  // ----- scarf + fluttering tail -----
  ctx.fillStyle=accent;
  rrect(ctx, cx-torsoW*0.52, shoulderY-h*0.03, torsoW*1.04, h*0.07, h*0.035); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx+torsoW*0.38, shoulderY-h*0.01);
  ctx.quadraticCurveTo(cx+torsoW*0.8+flut, shoulderY+h*0.08, cx+torsoW*0.58+flut*0.6, shoulderY+h*0.22);
  ctx.quadraticCurveTo(cx+torsoW*0.5, shoulderY+h*0.12, cx+torsoW*0.32, shoulderY+h*0.06);
  ctx.closePath(); ctx.fill();

  // ----- head -----
  ctx.fillStyle=skin;
  ctx.beginPath(); ctx.arc(cx, headCY, headR, 0, Math.PI*2); ctx.fill();

  // ----- spiky hair (Naruto) -----
  ctx.fillStyle=hair;
  ctx.beginPath(); ctx.arc(cx, headCY-headR*0.06, headR*1.03, Math.PI*1.04, Math.PI*1.96); ctx.fill();
  var spikes=7;
  for(var i=0;i<spikes;i++){
    var t=i/(spikes-1);
    var sxx=cx-headR*0.96 + t*1.92*headR;
    var topY=headCY-headR*0.62 - (0.55-Math.abs(0.5-t)*0.5)*headR*1.3;
    ctx.beginPath();
    ctx.moveTo(sxx-headR*0.2, headCY-headR*0.42);
    ctx.lineTo(sxx, topY);
    ctx.lineTo(sxx+headR*0.2, headCY-headR*0.42);
    ctx.closePath(); ctx.fill();
  }

  // ----- headband + forehead protector -----
  var bandY=headCY-headR*0.34, bandH=headR*0.44;
  ctx.fillStyle='#1b2740';
  rrect(ctx, cx-headR*1.04, bandY, headR*2.08, bandH, bandH*0.28); ctx.fill();
  ctx.fillStyle=plate;
  rrect(ctx, cx-headR*0.58, bandY+bandH*0.14, headR*1.16, bandH*0.7, bandH*0.22); ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,0.5)'; ctx.lineWidth=Math.max(1,h*0.006);
  ctx.beginPath(); ctx.moveTo(cx-headR*0.42, bandY+bandH*0.32); ctx.lineTo(cx-headR*0.12, bandY+bandH*0.32); ctx.stroke();
  ctx.strokeStyle=line; ctx.lineWidth=Math.max(1,h*0.009); // leaf swirl emblem
  ctx.beginPath(); ctx.arc(cx, bandY+bandH*0.48, bandH*0.18, 0.5, Math.PI*1.7); ctx.stroke();

  // ----- eyes (anime, with glints) -----
  var eyeY=headCY+headR*0.2, eyeDx=headR*0.44, eyeR=headR*0.15;
  ctx.fillStyle=line;
  ctx.beginPath(); ctx.ellipse(cx-eyeDx, eyeY, eyeR*0.78, eyeR, 0, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx+eyeDx, eyeY, eyeR*0.78, eyeR, 0, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle='rgba(255,255,255,0.9)';
  ctx.beginPath(); ctx.arc(cx-eyeDx+eyeR*0.25, eyeY-eyeR*0.35, eyeR*0.28, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx+eyeDx+eyeR*0.25, eyeY-eyeR*0.35, eyeR*0.28, 0, Math.PI*2); ctx.fill();

  ctx.restore();
}

function drawDojo(cv, repo, now){
  var ctx=cv.getContext('2d'); if(!ctx) return;
  ctx.imageSmoothingEnabled=true;
  var W=cv.width, H=cv.height;
  var L=dojoLayout(W,H);
  var s=sceneFor(repo);
  ctx.clearRect(0,0,W,H);
  if(s.blocked){ ctx.fillStyle='#2a1416'; ctx.fillRect(0,0,W,H); }
  // ground line
  ctx.fillStyle='#1d2230'; ctx.fillRect(0,L.groundY,W,Math.max(2,H*0.013));

  var bob=Math.sin(now/350)*(H*0.018);
  var fast=Math.sin(now/120)*(H*0.02);
  var flut=Math.sin(now/220)*(H*0.05);

  // gate-station platforms (+ done ticks)
  var pw=L.gap*0.62;
  for(var i=0;i<4;i++){
    var sx=L.stations[i];
    var passed=s.goalActive && i<s.station;
    var current=s.goalActive && i===s.station;
    ctx.fillStyle = passed ? '#2f81f7' : (current ? '#3a2c52' : '#232a3a');
    rrect(ctx, sx-pw/2, L.groundY-H*0.02, pw, H*0.035, H*0.015); ctx.fill();
    if(passed){ ctx.fillStyle='#3fb950'; ctx.beginPath(); ctx.arc(sx, L.groundY-H*0.07, H*0.022, 0, Math.PI*2); ctx.fill(); }
  }

  // ----- loop ninja (far left, full colour) -----
  if(s.loopPose==='gone'){
    drawPoof(ctx, L.loopX, L.groundY-L.figH*0.4, H*0.2, 0.45);
  } else if(s.loopPose==='sleep'){
    drawNinja(ctx, L.loopX, L.groundY, L.figH*0.92, { alpha:0.6, flutter:flut*0.3 });
    drawZ(ctx, L.loopX+L.figH*0.28, L.groundY-L.figH*0.82, H*0.05);
  } else {
    drawNinja(ctx, L.loopX, L.groundY+bob, L.figH, { alpha:1, flutter:flut });
    if(s.loopPose==='check') drawScroll(ctx, L.loopX+L.figH*0.18, L.groundY+bob-L.figH*0.3, H*0.12);
  }

  // ----- cast shadow clone + active-gate sub-clone (translucent, cyan chakra) -----
  if(s.goalActive){
    drawAura(ctx, L.cloneX, L.groundY-L.figH*0.42, L.figH*0.52, '#39c5cf');
    drawNinja(ctx, L.cloneX, L.groundY+bob, L.figH*0.96,
      { alpha:0.62, body:'#26344e', accent:'#39c5cf', hair:'#16243a', flutter:flut });

    if(s.station>=0){
      var stX=L.stations[s.station];
      var subY=L.groundY+(s.blocked?0:fast);
      if(s.blocked){
        drawNinja(ctx, stX, subY, L.figH*0.82,
          { alpha:0.9, body:'#3a1c22', accent:'#f85149', hair:'#2a1014', plate:'#caa6a6', flutter:0 });
        ctx.save(); ctx.fillStyle='#f85149'; ctx.textBaseline='alphabetic';
        ctx.font='bold '+Math.round(H*0.17)+'px sans-serif';
        ctx.fillText('!', stX+L.figH*0.2, subY-L.figH*0.5); ctx.restore();
      } else {
        drawAura(ctx, stX, L.groundY-L.figH*0.38, L.figH*0.46, '#39c5cf');
        drawNinja(ctx, stX, subY, L.figH*0.84,
          { alpha:0.72, body:'#26344e', accent:'#39c5cf', hair:'#16243a', flutter:fast });
        drawProp(ctx, GATE_KEYS[s.station], stX+L.figH*0.16, subY-L.figH*0.34, H*0.12);
      }
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
    + '<canvas class="dojo-canvas" data-repo="'+r.repoId+'" width="460" height="170"></canvas>'
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

module.exports = { watch, buildStatusPayload, createServer, defaultIsPidAlive, renderPage, sceneFor, dojoLayout, DEFAULT_PORT };
