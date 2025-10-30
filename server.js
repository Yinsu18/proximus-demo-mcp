// server.js
// Proximus Demo Web App — Render-ready single-file Express app
// Features
// - Login (hardcoded): username "proximus", password "proximus123"
// - 3 strikes lockout per IP for 10 minutes
// - Dummy SMS traffic dataset + simple filters
// - JSON API + SSE stream (/api/sms/stream)
// - Minimal UI (served from this file) to log in and view data
// - MCP bridge endpoint to call your Proximus MCP (proxy) OR mock it if MCP_URL not set
// - Health check for Render
//
// Deploy on Render as a Node Web Service with:
//   Build Command: npm install
//   Start Command: node server.js
// Required env vars (set on Render):
//   SESSION_SECRET=<long random string>
//   (optional) MCP_URL=https://your-proximus-mcp.example.com/query
//   (optional) MCP_API_KEY=sk-... (if your MCP needs it)

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// --- Basic security & parsing ---
app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// --- Sessions ---
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60, httpOnly: true }
}));

// --- In-memory lockout (per IP) ---
const lockouts = new Map(); // ip -> { attempts, until }
const MAX_ATTEMPTS = 3;
const LOCK_MINUTES = 10;

function checkLockout(ip) {
  const entry = lockouts.get(ip);
  if (!entry) return { locked: false };
  const now = Date.now();
  if (entry.until && entry.until > now) {
    return { locked: true, minutesLeft: Math.ceil((entry.until - now) / 60000) };
  }
  // expired lock
  lockouts.delete(ip);
  return { locked: false };
}

function registerAttempt(ip, success) {
  const entry = lockouts.get(ip) || { attempts: 0, until: 0 };
  if (success) {
    lockouts.delete(ip);
    return;
  }
  entry.attempts += 1;
  if (entry.attempts >= MAX_ATTEMPTS) {
    entry.until = Date.now() + LOCK_MINUTES * 60000;
    entry.attempts = 0; // reset counter after locking
  }
  lockouts.set(ip, entry);
}

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// --- Dummy SMS dataset ---
const smsData = (() => {
  const countries = ['US','GB','DE','FR','BR','IN','MX','CO','ES','IT'];
  const carriers = ['TeleOne','GlobalTel','SkyMobile','ProNet'];
  const statuses = ['DELIVERED','FAILED','BLOCKED','PENDING'];
  const arr = [];
  let id = 1;
  for (let i=0;i<500;i++) {
    const c = countries[Math.floor(Math.random()*countries.length)];
    const k = carriers[Math.floor(Math.random()*carriers.length)];
    const s = statuses[Math.floor(Math.random()*statuses.length)];
    const latencyMs = Math.floor(Math.random()*3000)+100;
    const ts = Date.now() - Math.floor(Math.random()*1000*60*60*24*7);
    arr.push({
      id: id++,
      country: c,
      carrier: k,
      status: s,
      latency_ms: latencyMs,
      message: 'Hello from Proximus demo',
      timestamp: ts
    });
  }
  return arr;
})();

// --- Health ---
app.get('/healthz', (req,res)=>res.send('ok'));

// --- Auth routes ---
app.post('/api/login', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'local';
  const lock = checkLockout(ip);
  if (lock.locked) return res.status(429).json({ error: `Too many attempts. Try again in ${lock.minutesLeft} minute(s).` });

  const { username, password } = req.body;
  const ok = username === 'proximus' && password === 'proximus123';
  registerAttempt(ip, ok);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  req.session.user = { name: 'Proximus Demo User' };
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.user), user: req.session?.user || null });
});

// --- SMS API ---
app.get('/api/sms', requireAuth, (req,res)=>{
  const { country, status, limit = 100 } = req.query;
  let out = smsData;
  if (country) out = out.filter(r => r.country === String(country).toUpperCase());
  if (status) out = out.filter(r => r.status === String(status).toUpperCase());
  const lim = Math.min(parseInt(limit,10) || 100, 500);
  res.json(out.slice(0, lim));
});

// SSE stream of random rows
app.get('/api/sms/stream', requireAuth, (req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.flushHeaders?.();

  const send = () => {
    const row = smsData[Math.floor(Math.random()*smsData.length)];
    const withNow = { ...row, timestamp: Date.now(), id: crypto.randomUUID() };
    res.write(`data: ${JSON.stringify(withNow)}\n\n`);
  };
  const timer = setInterval(send, 1500);
  req.on('close', ()=> clearInterval(timer));
});

// --- MCP bridge ---
// If MCP_URL is set, we forward queries to your real Proximus MCP.
// Otherwise, we mock a minimal response so the LLM/tooling path is testable.
const MCP_URL = process.env.MCP_URL || null;
const MCP_API_KEY = process.env.MCP_API_KEY || null;

app.post('/api/mcp/query', requireAuth, async (req, res) => {
  const { prompt, resource, filters } = req.body || {};
  try {
    if (MCP_URL) {
      const resp = await fetch(MCP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(MCP_API_KEY ? { 'Authorization': `Bearer ${MCP_API_KEY}` } : {})
        },
        body: JSON.stringify({ prompt, resource, filters })
      });
      const data = await resp.json();
      return res.json({ source: 'proximus-mcp', data });
    } else {
      // Mock behavior: interpret filters against our dummy smsData
      let out = smsData;
      if (filters?.country) out = out.filter(r => r.country === String(filters.country).toUpperCase());
      if (filters?.status) out = out.filter(r => r.status === String(filters.status).toUpperCase());
      // Basic aggregation example
      if (resource === 'kpis') {
        const total = out.length;
        const delivered = out.filter(r=>r.status==='DELIVERED').length;
        const failed = out.filter(r=>r.status==='FAILED').length;
        const blocked = out.filter(r=>r.status==='BLOCKED').length;
        const avgLatency = out.reduce((a,b)=>a+b.latency_ms,0) / Math.max(1,total);
        return res.json({ source: 'mock-mcp', data: { total, delivered, failed, blocked, avgLatency } });
      }
      return res.json({ source: 'mock-mcp', data: out.slice(0, 200) });
    }
  } catch (e) {
    console.error('MCP error', e);
    res.status(502).json({ error: 'MCP bridge failed', details: String(e?.message||e) });
  }
});

// --- Minimal UI ---
app.get('/', (req,res)=>{
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Proximus Demo — Login</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0b1020;color:#e6e8ef;margin:0;}
    .card{max-width:420px;margin:10vh auto;padding:24px;background:#121933;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.35)}
    input,button,select{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #2a355b;background:#0f1429;color:#e6e8ef}
    button{cursor:pointer;background:#4c7dff;border-color:#4c7dff;font-weight:600}
    .row{display:flex;gap:10px}
    .row>*{flex:1}
    .muted{opacity:.8;font-size:12px}
    table{width:100%;border-collapse:collapse;margin-top:12px}
    th,td{padding:8px;border-bottom:1px solid #223}
    code{background:#0f1429;padding:2px 6px;border-radius:6px}
    .tag{display:inline-block;padding:2px 8px;border:1px solid #2e3b6e;border-radius:999px;font-size:12px}
  </style>
</head>
<body>
  <div class="card">
    <h2>Proximus Demo</h2>
    <p class="muted">Login with <code>proximus / proximus123</code></p>
    <div id="login">
      <div class="row">
        <input id="u" placeholder="username" />
        <input id="p" placeholder="password" type="password" />
      </div>
      <button id="btnLogin">Login</button>
      <p id="msg" class="muted"></p>
    </div>

    <div id="app" style="display:none">
      <div class="row">
        <button id="btnLogout">Logout</button>
        <select id="country">
          <option value="">All Countries</option>
          <option>US</option><option>GB</option><option>DE</option><option>FR</option><option>BR</option><option>IN</option><option>MX</option><option>CO</option><option>ES</option><option>IT</option>
        </select>
        <select id="status">
          <option value="">All Statuses</option>
          <option>DELIVERED</option><option>FAILED</option><option>BLOCKED</option><option>PENDING</option>
        </select>
      </div>
      <div class="row">
        <button id="btnLoad">Load SMS</button>
        <button id="btnStream">Start Stream</button>
        <button id="btnStop">Stop Stream</button>
        <button id="btnKpi">Ask MCP KPIs</button>
      </div>
      <div>
        <span class="tag" id="kpi"></span>
      </div>
      <table>
        <thead><tr><th>Time</th><th>Country</th><th>Status</th><th>Carrier</th><th>Latency (ms)</th></tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </div>
<script>
const el = (id)=>document.getElementById(id);
const msg = el('msg');

async function me(){
  const r = await fetch('/api/me');
  return r.json();
}

async function login(){
  msg.textContent='';
  const r = await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:el('u').value,password:el('p').value})});
  const j = await r.json();
  if(!r.ok){ msg.textContent=j.error||'Login failed'; return; }
  showApp();
}

async function logout(){ await fetch('/api/logout',{method:'POST'}); location.reload(); }

function showApp(){
  el('login').style.display='none';
  el('app').style.display='block';
}

function rowHtml(r){
  const dt = new Date(r.timestamp);
  return `<tr><td>${dt.toLocaleString()}</td><td>${r.country}</td><td>${r.status}</td><td>${r.carrier}</td><td>${r.latency_ms}</td></tr>`;
}

async function loadSms(){
  const qs = new URLSearchParams();
  if(el('country').value) qs.set('country', el('country').value);
  if(el('status').value) qs.set('status', el('status').value);
  const r = await fetch('/api/sms?'+qs.toString());
  if(!r.ok){ alert('auth required'); return; }
  const j = await r.json();
  el('tbody').innerHTML = j.map(rowHtml).join('');
}

let es;
function startStream(){
  if(es) es.close();
  es = new EventSource('/api/sms/stream');
  es.onmessage = (ev)=>{
    const r = JSON.parse(ev.data);
    el('tbody').insertAdjacentHTML('afterbegin', rowHtml(r));
  };
  es.onerror = ()=>{ es?.close(); };
}
function stopStream(){ es?.close(); }

async function askKpi(){
  const filters = {};
  if(el('country').value) filters.country = el('country').value;
  if(el('status').value) filters.status = el('status').value;
  const r = await fetch('/api/mcp/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:'Compute KPIs', resource:'kpis', filters})});
  const j = await r.json();
  if(!r.ok){ alert(j.error||'MCP error'); return; }
  const d = j.data || j;
  if(d.avgLatency!==undefined){
    el('kpi').textContent = `total ${d.total} · delivered ${d.delivered} · failed ${d.failed} · blocked ${d.blocked} · avgLatency ${d.avgLatency.toFixed(0)}ms`;
  } else {
    el('kpi').textContent = 'See console for MCP data';
    console.log('MCP result', j);
  }
}

el('btnLogin').onclick = login;
el('btnLogout').onclick = logout;

el('btnLoad')?.addEventListener('click', loadSms);   // ← FIXED: was 'ele(' instead of 'el('
el('btnStream').onclick = startStream;
el('btnStop').onclick = stopStream;
el('btnKpi').onclick = askKpi;

me().then((j)=>{ if(j.authenticated) showApp(); });
</script>
</body>
</html>`);
});

// Start server
app.listen(PORT, ()=>{
  console.log(`Proximus demo listening on :${PORT}`);
});
