const express = require("express");
const session = require("express-session");
const path = require("path");
const crypto = require("crypto");
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// Environment
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const MCP_URL = process.env.MCP_URL || null; // e.g. https://<mcp>.onrender.com/query
const MCP_API_KEY = process.env.MCP_API_KEY || null;
const DEMO_API_KEY = process.env.DEMO_API_KEY || null; // allow server-to-server access

app.disable("x-powered-by");
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 },
  })
);

// ---- Simple hardcoded auth ----
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === "proximus" && password === "proximus123") {
    req.session.user = { name: "Proximus User" };
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Invalid credentials" });
});

app.post("/api/logout", (req, res) =>
  req.session.destroy(() => res.json({ ok: true }))
);
app.get("/api/me", (req, res) =>
  res.json({ authenticated: !!req.session.user })
);

function requireAuth(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// ---- Demo data (authoritative source for MCP) ----
const countries = ["US", "GB", "DE", "FR", "BR", "IN", "MX", "CO", "ES", "IT"];
const carriers = ["TeleOne", "GlobalTel", "SkyMobile", "ProNet"];
const statuses = ["DELIVERED", "FAILED", "BLOCKED", "PENDING"];

function seedData(n = 400) {
  const arr = [];
  let id = 1;
  for (let i = 0; i < n; i++) {
    arr.push({
      id: id++,
      country: countries[Math.floor(Math.random() * countries.length)],
      carrier: carriers[Math.floor(Math.random() * carriers.length)],
      status: statuses[Math.floor(Math.random() * statuses.length)],
      latency_ms: Math.floor(Math.random() * 3000) + 100,
      message: "Hello from Proximus",
      timestamp:
        Date.now() - Math.floor(Math.random() * 7 * 24 * 60 * 60 * 1000),
    });
  }
  return arr;
}
const DATA = seedData();

// ---- /api/data (session or X-API-Key) ----
app.get("/api/data", (req, res) => {
  const apiKey = req.get("X-API-Key");
  const authed =
    !!(req.session && req.session.user) ||
    (DEMO_API_KEY && apiKey === DEMO_API_KEY);
  if (!authed) return res.status(401).json({ error: "Unauthorized" });

  let out = DATA;
  const { country, status, limit } = req.query;
  if (country)
    out = out.filter((r) => r.country === String(country).toUpperCase());
  if (status)
    out = out.filter((r) => r.status === String(status).toUpperCase());
  const lim = Math.min(parseInt(limit, 10) || 100, 1000);
  res.json(out.slice(0, lim));
});

// ---- Bridge to MCP ----
app.post("/api/mcp/query", requireAuth, async (req, res) => {
  if (!MCP_URL)
    return res.status(500).json({ error: "MCP_URL not set on demo service" });

  try {
    const resp = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(MCP_API_KEY ? { Authorization: `Bearer ${MCP_API_KEY}` } : {}),
      },
      body: JSON.stringify(req.body || {}),
    });
    const ct = resp.headers.get("content-type") || "";
    const isJson = ct.includes("application/json");
    if (!resp.ok) {
      const body = isJson ? await resp.json().catch(() => ({})) : await resp.text();
      return res
        .status(502)
        .json({ error: "MCP bridge failed", details: JSON.stringify(body) });
    }
    const data = isJson ? await resp.json() : { raw: await resp.text() };
    res.json(data);
  } catch (e) {
    res
      .status(502)
      .json({ error: "MCP bridge failed", details: String(e?.message || e) });
  }
});

// ---- Static UI ----
app.use(express.static(__dirname));
app.get("/healthz", (req, res) => res.send("ok"));
app.listen(PORT, () => console.log(`demo-app running on port ${PORT}`));
