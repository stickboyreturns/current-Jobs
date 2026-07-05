const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Storage layer: Postgres if available, else in-memory ----------
const DB_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || process.env.POSTGRES_URL || null;
let dbReady = false;
let memoryJobs = [];   // in-memory fallback so the app always works
let pool = null;

if (DB_URL) {
  pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
}

async function initDb() {
  if (!pool) {
    console.log('No database URL found - running in memory-only mode.');
    return;
  }
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS board2 (id INT PRIMARY KEY, data TEXT)");
    // load existing data into memory cache
    const r = await pool.query('SELECT data FROM board2 WHERE id = 1');
    if (r.rows.length > 0 && r.rows[0].data) {
      const parsed = JSON.parse(r.rows[0].data);
      if (Array.isArray(parsed)) memoryJobs = parsed;
    }
    dbReady = true;
    console.log('Database connected. Loaded ' + memoryJobs.length + ' jobs.');
  } catch (e) {
    dbReady = false;
    console.error('Database connect failed, using memory mode:', e.message);
  }
}

async function readJobs() {
  if (dbReady && pool) {
    try {
      const r = await pool.query('SELECT data FROM board2 WHERE id = 1');
      if (r.rows.length > 0 && r.rows[0].data) {
        const parsed = JSON.parse(r.rows[0].data);
        if (Array.isArray(parsed)) { memoryJobs = parsed; return parsed; }
      }
      return [];
    } catch (e) {
      console.error('read error, falling back to memory:', e.message);
      dbReady = false;
    }
  }
  return memoryJobs;
}

async function writeJobs(jobs) {
  memoryJobs = Array.isArray(jobs) ? jobs : [];
  // Try to (re)connect if we haven't yet
  if (!dbReady && pool) { await initDb(); }
  if (dbReady && pool) {
    try {
      await pool.query('INSERT INTO board2 (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1', [JSON.stringify(memoryJobs)]);
      return { persisted: true };
    } catch (e) {
      console.error('write error, kept in memory:', e.message);
      dbReady = false;
      return { persisted: false, reason: e.message };
    }
  }
  return { persisted: false, reason: 'no database connected' };
}

// ---------- Pages ----------
const PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Production Board</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:"MS Sans Serif",Arial,sans-serif; background:#008080; padding:8px; }
  .win { background:#c0c0c0; border:2px solid; border-color:#dfdfdf #808080 #808080 #dfdfdf; box-shadow:1px 1px #fff inset,-1px -1px #808080 inset; margin:0 auto 8px; max-width:900px; }
  .bar { background:linear-gradient(90deg,#000080,#1084d7); color:#fff; padding:3px 5px; display:flex; justify-content:space-between; align-items:center; font-weight:bold; font-size:12px; }
  .bar .btns button { width:18px; height:15px; padding:0; font-size:10px; margin-left:2px; }
  .pad { padding:6px; }
  .toprow { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .toprow .status { color:#000080; font-weight:bold; font-size:12px; margin-left:auto; }
  button { font-family:"MS Sans Serif",Arial,sans-serif; font-size:12px; padding:5px 12px; border:2px solid; border-color:#dfdfdf #808080 #808080 #dfdfdf; background:#c0c0c0; cursor:pointer; color:#000; }
  button:active { border-color:#808080 #dfdfdf #dfdfdf #808080; }
  .row { margin-bottom:7px; }
  label { display:block; font-size:12px; font-weight:bold; margin-bottom:3px; }
  input,textarea,select { width:100%; padding:4px; font-family:"MS Sans Serif",Arial,sans-serif; font-size:12px; border:2px solid; border-color:#808080 #dfdfdf #dfdfdf #808080; background:#fff; }
  input[type=range] { border:none; padding:0; }
  textarea { min-height:60px; resize:vertical; }
  .prog { display:flex; gap:5px; align-items:center; }
  .prog input[type=range] { flex:1; }
  .prog button { width:34px; padding:5px 0; font-weight:bold; font-size:15px; }
  .searchwin input { width:100%; }
  .banner { background:#ffffcc; border:2px solid; border-color:#808080 #dfdfdf #dfdfdf #808080; padding:5px 8px; font-size:11px; color:#806000; }
</style>
</head>
<body>

<div class="win">
  <div class="bar">
    <span>Production Board &mdash; Editor &middot; v9</span>
    <span class="btns"><button>_</button><button>[]</button><button>X</button></span>
  </div>
  <div class="pad toprow">
    <button id="newBtn">+ New job</button>
    <button id="displayBtn">Open display</button>
    <span class="status" id="status">Saved</span>
  </div>
</div>

<div class="win" id="memBanner" style="display:none"><div class="banner" id="memBannerText"></div></div>

<div class="win searchwin">
  <div class="pad"><input type="text" id="search" placeholder="Search jobs..."></div>
</div>

<div class="win" id="newWin" style="display:none">
  <div class="bar"><span>+ New job</span><span class="btns"><button id="newClose">X</button></span></div>
  <div class="pad">
    <div class="row"><label>Job</label><input type="text" id="nTitle"></div>
    <div class="row"><label>Client</label><input type="text" id="nClient"></div>
    <div class="row"><label>Status</label><select id="nStatus"><option>Next Up</option><option>In Progress</option><option>Waiting On</option><option>Review</option><option>Wrapped</option></select></div>
    <div class="row"><label>Progress &mdash; <span id="nPct">0%</span></label>
      <div class="prog"><button id="nMinus">-</button><input type="range" id="nProg" min="0" max="100" step="2" value="0"><button id="nPlus">+</button></div>
    </div>
    <div class="row"><label>Next task</label><textarea id="nNext"></textarea></div>
    <div style="display:flex; gap:6px"><button id="nSave">Save</button><button id="nCancel">Cancel</button></div>
  </div>
</div>

<div id="list"></div>

<script>
var jobs = [];
var STATUSES = ["Next Up","In Progress","Waiting On","Review","Wrapped"];
function $(id){ return document.getElementById(id); }

$("newBtn").addEventListener("click", function(){ $("newWin").style.display = "block"; });
$("newClose").addEventListener("click", closeNew);
$("nCancel").addEventListener("click", closeNew);
$("displayBtn").addEventListener("click", function(){ location.href = "/display"; });
$("search").addEventListener("input", draw);
$("nProg").addEventListener("input", function(){ $("nPct").textContent = $("nProg").value + "%"; });
$("nMinus").addEventListener("click", function(){ nStep(-2); });
$("nPlus").addEventListener("click", function(){ nStep(2); });
$("nSave").addEventListener("click", saveNew);

function nStep(d){
  var v = Math.max(0, Math.min(100, (parseInt($("nProg").value)||0) + d));
  $("nProg").value = v; $("nPct").textContent = v + "%";
}
function closeNew(){
  $("newWin").style.display = "none";
  $("nTitle").value=""; $("nClient").value=""; $("nStatus").value="Next Up";
  $("nProg").value="0"; $("nPct").textContent="0%"; $("nNext").value="";
}
function saveNew(){
  var title = $("nTitle").value.trim();
  if(!title){ alert("Job name required"); return; }
  jobs.push({ id:"j"+Date.now(), title:title, client:$("nClient").value.trim(), status:$("nStatus").value, progress:parseInt($("nProg").value)||0, next:$("nNext").value.trim() });
  save(); closeNew();
}

function draw(){
  var q = $("search").value.toLowerCase();
  var list = $("list"); list.innerHTML = "";
  for(var i=0;i<jobs.length;i++){
    var j = jobs[i];
    if(q && j.title.toLowerCase().indexOf(q)<0 && (j.client||"").toLowerCase().indexOf(q)<0 && (j.next||"").toLowerCase().indexOf(q)<0) continue;
    list.appendChild(buildCard(j));
  }
}

function buildCard(j){
  var win = document.createElement("div"); win.className="win";
  var bar = document.createElement("div"); bar.className="bar";
  var t = document.createElement("span"); t.textContent = j.title;
  var btns = document.createElement("span"); btns.className="btns";
  var x = document.createElement("button"); x.textContent="X";
  x.addEventListener("click", function(){ del(j.id); });
  btns.appendChild(x); bar.appendChild(t); bar.appendChild(btns); win.appendChild(bar);

  var pad = document.createElement("div"); pad.className="pad";
  pad.appendChild(field("Job","text",j.title,function(v){ upd(j.id,"title",v); }));
  pad.appendChild(field("Client","text",j.client,function(v){ upd(j.id,"client",v); }));

  var sRow = document.createElement("div"); sRow.className="row";
  var sLbl = document.createElement("label"); sLbl.textContent="Status"; sRow.appendChild(sLbl);
  var sel = document.createElement("select");
  for(var s=0;s<STATUSES.length;s++){ var o=document.createElement("option"); o.textContent=STATUSES[s]; if(STATUSES[s]===j.status)o.selected=true; sel.appendChild(o); }
  sel.addEventListener("change", function(){ upd(j.id,"status",sel.value); });
  sRow.appendChild(sel); pad.appendChild(sRow);

  var pRow = document.createElement("div"); pRow.className="row";
  var pLbl = document.createElement("label");
  var pct = document.createElement("span"); pct.textContent=(j.progress||0)+"%";
  pLbl.appendChild(document.createTextNode("Progress \\u2014 ")); pLbl.appendChild(pct); pRow.appendChild(pLbl);
  var pd = document.createElement("div"); pd.className="prog";
  var mn = document.createElement("button"); mn.textContent="-";
  var rng = document.createElement("input"); rng.type="range"; rng.min="0"; rng.max="100"; rng.step="2"; rng.value=j.progress||0;
  var pl = document.createElement("button"); pl.textContent="+";
  rng.addEventListener("input", function(){ pct.textContent=rng.value+"%"; upd(j.id,"progress",parseInt(rng.value)); });
  mn.addEventListener("click", function(){ var v=Math.max(0,(parseInt(rng.value)||0)-2); rng.value=v; pct.textContent=v+"%"; upd(j.id,"progress",v); });
  pl.addEventListener("click", function(){ var v=Math.min(100,(parseInt(rng.value)||0)+2); rng.value=v; pct.textContent=v+"%"; upd(j.id,"progress",v); });
  pd.appendChild(mn); pd.appendChild(rng); pd.appendChild(pl); pRow.appendChild(pd); pad.appendChild(pRow);

  var nRow = document.createElement("div"); nRow.className="row";
  var nLbl = document.createElement("label"); nLbl.textContent="Next task"; nRow.appendChild(nLbl);
  var ta = document.createElement("textarea"); ta.value=j.next||"";
  ta.addEventListener("change", function(){ upd(j.id,"next",ta.value); });
  nRow.appendChild(ta); pad.appendChild(nRow);

  win.appendChild(pad); return win;
}

function field(labelText,type,value,onChange){
  var row=document.createElement("div"); row.className="row";
  var l=document.createElement("label"); l.textContent=labelText; row.appendChild(l);
  var inp=document.createElement("input"); inp.type=type; inp.value=value||"";
  inp.addEventListener("change", function(){ onChange(inp.value); });
  row.appendChild(inp); return row;
}

function upd(id,f,v){ for(var i=0;i<jobs.length;i++){ if(jobs[i].id===id){ jobs[i][f]=v; break; } } save(); }
function del(id){ if(!confirm("Delete this job?"))return; jobs=jobs.filter(function(j){return j.id!==id;}); save(); }

function save(){
  $("status").textContent = "Saving...";
  fetch("/jobs",{ method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify({jobs:jobs}) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      if(res.persisted){
        $("status").style.color="#000080"; $("status").textContent="Saved";
        $("memBanner").style.display="none";
      } else {
        $("status").style.color="#806000"; $("status").textContent="Saved (this session)";
        $("memBanner").style.display="block";
        $("memBannerText").textContent="Note: not connected to the database yet, so jobs are kept only until the app restarts. Add the DATABASE_URL variable in Railway to make them permanent.";
      }
      load();
    })
    .catch(function(e){ console.error(e); $("status").style.color="#c00000"; $("status").textContent="Error: "+e.message; });
}

function load(){
  fetch("/jobs").then(function(r){ return r.json(); }).then(function(d){
    jobs = d.jobs || [];
    if(d.persisted === false){
      $("memBanner").style.display="block";
      $("memBannerText").textContent="Note: not connected to the database yet, so jobs are kept only until the app restarts. Add the DATABASE_URL variable in Railway to make them permanent.";
    } else {
      $("memBanner").style.display="none";
    }
    draw();
  });
}

load();
</script>
</body>
</html>`;

const DISPLAY = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Display</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:100%; height:100%; }
  body { font-family:"MS Sans Serif",Arial,sans-serif; background:#008080; display:flex; align-items:center; justify-content:center; overflow:hidden; }

  /* 4:3 frame that fits the screen */
  .frame {
    aspect-ratio:4/3;
    width:min(100vw, calc(100vh * 4 / 3));
    height:min(100vh, calc(100vw * 3 / 4));
    background:#c0c0c0;
    border:3px solid; border-color:#dfdfdf #808080 #808080 #dfdfdf;
    box-shadow:2px 2px #fff inset,-2px -2px #808080 inset;
    display:flex; flex-direction:column;
  }
  .frame-bar {
    background:linear-gradient(90deg,#000080,#1084d7); color:#fff;
    padding:5px 8px; font-weight:bold; font-size:16px;
    display:flex; justify-content:space-between; align-items:center;
  }
  .frame-body { flex:1; display:flex; flex-direction:column; gap:12px; padding:14px; }

  .card {
    flex:1; background:#c0c0c0;
    border:2px solid; border-color:#dfdfdf #808080 #808080 #dfdfdf;
    box-shadow:1px 1px #fff inset,-1px -1px #808080 inset;
    display:flex; flex-direction:column;
  }
  .card-bar {
    background:linear-gradient(90deg,#000080,#1084d7); color:#fff;
    padding:4px 8px; font-weight:bold; font-size:15px;
    display:flex; justify-content:space-between; align-items:center;
  }
  .card-body { flex:1; display:flex; align-items:center; padding:10px 16px; gap:20px; }
  .meta { flex:1; min-width:0; }
  .meta .client { font-size:15px; margin-bottom:3px; }
  .meta .status { font-size:14px; color:#000080; font-weight:bold; }

  .prog-wrap { display:flex; flex-direction:column; align-items:flex-end; gap:6px; }
  .prog-pct { font-size:14px; font-weight:bold; }
  .squares { display:flex; gap:4px; }
  .sq {
    width:26px; height:26px;
    border:2px solid; border-color:#808080 #dfdfdf #dfdfdf #808080;
    background:#fff;
  }
  .sq.on { background:#000080; }

  .empty { flex:1; display:flex; align-items:center; justify-content:center; color:#808080; font-size:16px; }

  .back {
    position:fixed; bottom:16px; left:16px;
    font-family:"MS Sans Serif",Arial,sans-serif; font-size:13px; padding:6px 14px;
    border:2px solid; border-color:#dfdfdf #808080 #808080 #dfdfdf;
    background:#c0c0c0; color:#000; cursor:pointer;
  }
  .back:active { border-color:#808080 #dfdfdf #dfdfdf #808080; }
</style>
</head>
<body>
<div class="frame">
  <div class="frame-bar"><span>Production Board &mdash; Display</span><span id="clock"></span></div>
  <div class="frame-body" id="body">
    <div class="empty">Loading...</div>
  </div>
</div>
<button class="back" id="back">&larr; Back to editor</button>
<script>
var jobs=[], idx=0, mode="regular", timer=null;
document.getElementById("back").addEventListener("click", function(){ location.href="/edit"; });

function urgent(j){ return (/urgent|asap/i).test(j.next||""); }

function tick(){
  var d=new Date();
  var h=d.getHours(), m=d.getMinutes();
  var ap=h>=12?"PM":"AM"; var hh=h%12; if(hh===0)hh=12;
  document.getElementById("clock").textContent = hh+":"+(m<10?"0"+m:m)+" "+ap;
}

function squares(progress){
  var filled = Math.round((progress||0)/10); // 0-10 squares
  if(filled<0)filled=0; if(filled>10)filled=10;
  var html='<div class="squares">';
  for(var i=1;i<=10;i++){ html += '<div class="sq'+(i<=filled?' on':'')+'"></div>'; }
  html+='</div>';
  return html;
}

function cardHtml(j){
  return '<div class="card">' +
    '<div class="card-bar"><span>'+escapeHtml(j.title||"")+'</span></div>' +
    '<div class="card-body">' +
      '<div class="meta">' +
        '<div class="client">'+escapeHtml(j.client||"")+'</div>' +
        '<div class="status">'+escapeHtml(j.status||"")+'</div>' +
      '</div>' +
      '<div class="prog-wrap"><div class="prog-pct">'+(j.progress||0)+'%</div>'+squares(j.progress)+'</div>' +
    '</div>' +
  '</div>';
}

function escapeHtml(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function draw(){
  var list = mode==="urgent" ? jobs.filter(urgent) : jobs.filter(function(j){return !urgent(j);});
  var body=document.getElementById("body");
  if(list.length===0){ body.innerHTML='<div class="empty">No jobs to show</div>'; return; }
  var a=list[idx % list.length];
  var b=list[(idx+1) % list.length];
  body.innerHTML = cardHtml(a) + cardHtml(b);
}

function rotate(){
  var list = mode==="urgent" ? jobs.filter(urgent) : jobs.filter(function(j){return !urgent(j);});
  idx += 2;
  if(idx>=list.length){ idx=0; var hu=jobs.some(urgent), hr=jobs.some(function(j){return !urgent(j);}); mode=(mode==="urgent"&&hr)?"regular":(hu?"urgent":"regular"); }
  draw();
}

function load(){
  fetch("/jobs").then(function(r){return r.json();}).then(function(d){
    jobs=d.jobs||[]; idx=0; mode=jobs.some(urgent)?"urgent":"regular"; draw();
    if(timer)clearInterval(timer); timer=setInterval(rotate, mode==="urgent"?15000:30000);
  });
}
tick(); setInterval(tick,10000);
load(); setInterval(load,60000);
</script>
</body>
</html>`;

// ---------- Routes ----------
app.get('/', (req, res) => res.redirect('/edit'));
app.get('/edit', (req, res) => res.type('text/html').send(PAGE));
app.get('/display', (req, res) => res.type('text/html').send(DISPLAY));

app.get('/jobs', async (req, res) => {
  const jobs = await readJobs();
  res.json({ jobs: jobs, persisted: dbReady });
});

app.put('/jobs', async (req, res) => {
  const result = await writeJobs(req.body.jobs || []);
  res.json({ ok: true, persisted: result.persisted, reason: result.reason });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/db-check', async (req, res) => {
  if (!DB_URL) return res.json({ connected: false, reason: 'No DATABASE_URL variable set on this Railway service.' });
  try { await pool.query('SELECT 1'); res.json({ connected: true, message: 'Database connected and working.' }); }
  catch (e) { res.json({ connected: false, reason: e.message }); }
});

initDb();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on ' + PORT + (dbReady ? ' (db)' : ' (memory)')));
