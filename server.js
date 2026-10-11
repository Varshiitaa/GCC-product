"use strict";
/*
 * GCC Atlas backend. Zero dependencies, Node 18+.
 *
 * - Serves the frontend from ./public
 * - GET  /api/data     the current dataset (curated baseline + latest AI collection)
 * - GET  /api/status   collector state, never includes the key
 * - POST /api/refresh  runs the collector now (needs the x-admin-token header)
 * - A daily scheduler refreshes the data when GEMINI_API_KEY is set
 *
 * The API key is read from the environment only. It is never written to a file,
 * logged, or sent to the browser.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* load .env if present */
[path.join(__dirname, ".env"), path.join(process.cwd(), ".env")].forEach((envPath) => {
  try {
    if (fs.existsSync(envPath)) {
      const raw = fs.readFileSync(envPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq > 0) {
          const key = trimmed.slice(0, eq).trim();
          let val = trimmed.slice(eq + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (e) {}
});

const PORT = process.env.PORT || 3000;
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ADMIN = process.env.ADMIN_TOKEN || "";
const MOCK = process.env.MOCK === "1";
const DAY = 24 * 3600 * 1000;
const MIN_GAP = 10 * 60 * 1000;

const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const BASE = path.join(ROOT, "data", "base.json");
const LIVE = path.join(ROOT, "data", "live.json");

const state = { running: false, lastRun: null, lastError: null, lastCounts: null, lastStart: 0 };

/* ---------- storage ---------- */
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } }
function writeJson(f, o) { const tmp = f + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(o, null, 2)); fs.renameSync(tmp, f); }
function currentData() { return readJson(LIVE) || readJson(BASE); }

/* ---------- validation of AI output (treated as untrusted) ---------- */
const isHttps = (u) => typeof u === "string" && /^https:\/\/[^\s"'<>]{4,300}$/.test(u);
const isDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));
const ageDays = (d) => (Date.now() - Date.parse(d)) / DAY;
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, n);
const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const sid = (url, date) => "ai_" + crypto.createHash("sha1").update(url + "|" + date).digest("hex").slice(0, 8);

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no JSON in model reply");
  return JSON.parse(body.slice(a, b + 1));
}

/* ---------- Gemini with Google Search grounding ---------- */
async function gemini(prompt) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.1 }
    })
  });
  if (!r.ok) throw new Error("Gemini HTTP " + r.status + ": " + (await r.text()).slice(0, 240));
  const j = await r.json();
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  return parts.map((p) => p.text || "").join("");
}

const P_CLAIMS = "Search the web for the latest published figures for the number of Global Capability Centres (GCCs) in India. " +
  "Reply with ONLY JSON in this shape: {\"claims\":[{\"label\":\"publisher and report name\",\"value\":1234,\"unit\":\"companies|centres|gcc\",\"note\":\"what is counted, as the source states it\",\"url\":\"https://...\",\"date\":\"YYYY-MM-DD\"}]}. " +
  "Only include figures that a source you actually found states directly, published in the last 18 months, with the exact page URL. Maximum 6. Do not estimate or infer.";
const P_NEWS = "Search the web for new Global Capability Centre (GCC) setups or expansions in India announced in the last 90 days. " +
  "Reply with ONLY JSON: {\"announcements\":[{\"company\":\"name\",\"city\":\"city\",\"date\":\"YYYY-MM-DD\",\"note\":\"one factual sentence\",\"url\":\"https://...\"}]}. " +
  "Only include announcements a source you found states directly, with that page's URL. Maximum 10.";
const P_CITY = "Search the web for the latest quarter's Grade A office market figures for Bengaluru, Hyderabad, Pune, Chennai, Delhi NCR and Mumbai from a named broker report (Cushman & Wakefield, JLL, CBRE, Colliers, Knight Frank or Savills). " +
  "Reply with ONLY JSON: {\"cities\":{\"Bengaluru\":{\"rent\":{\"value\":0,\"publisher\":\"\",\"url\":\"https://...\",\"date\":\"YYYY-MM-DD\"},\"vac\":{\"value\":0,\"publisher\":\"\",\"url\":\"https://...\",\"date\":\"YYYY-MM-DD\"}}}}. " +
  "rent is Rs per sq ft per month, vac is vacancy percent. Omit any city or metric you cannot source directly. Do not estimate.";

/* ---------- mock fixtures so the pipeline can be tested without a key ---------- */
const today = () => new Date().toISOString().slice(0, 10);
const MOCKS = {
  claims: () => ({ claims: [{ label: "Mock Research", value: 2200, unit: "companies", note: "fixture", url: "https://example.com/mock-report", date: today() }] }),
  news: () => ({ announcements: [{ company: "Mock Corp", city: "Pune", date: today(), note: "Fixture announcement for testing.", url: "https://example.com/mock-news" }] }),
  city: () => ({ cities: { Pune: { rent: { value: 91.5, publisher: "Mock Broker", url: "https://example.com/mock-rent", date: today() } } } })
};

/* ---------- collectors: each returns validated records only ---------- */
async function collectClaims() {
  const j = MOCK ? MOCKS.claims() : extractJson(await gemini(P_CLAIMS));
  return (Array.isArray(j.claims) ? j.claims : []).slice(0, 6).map((c) => {
    const value = num(c.value);
    if (value == null || value < 500 || value > 10000 || !isHttps(c.url) || !isDate(c.date) || ageDays(c.date) > 550 || ageDays(c.date) < -1) return null;
    const unit = clean(c.unit, 12).toLowerCase();
    return { label: clean(c.label, 60), note: clean(c.note, 80), value, kind: unit === "centres" ? "centres" : "gcc", url: c.url, date: c.date };
  }).filter(Boolean);
}
async function collectNews() {
  const j = MOCK ? MOCKS.news() : extractJson(await gemini(P_NEWS));
  return (Array.isArray(j.announcements) ? j.announcements : []).slice(0, 10).map((a) => {
    if (!isHttps(a.url) || !isDate(a.date) || ageDays(a.date) > 120 || ageDays(a.date) < -1 || !clean(a.company, 60) || !clean(a.city, 40)) return null;
    return { company: clean(a.company, 60), city: clean(a.city, 40), date: a.date, note: clean(a.note, 200), url: a.url };
  }).filter(Boolean);
}
const CITY_OK = { Bengaluru: 1, Hyderabad: 1, Pune: 1, Chennai: 1, "Delhi NCR": 1, Mumbai: 1 };
async function collectCities() {
  const j = MOCK ? MOCKS.city() : extractJson(await gemini(P_CITY));
  const out = [];
  Object.keys(j.cities || {}).forEach((city) => {
    if (!CITY_OK[city]) return;
    [["rent", 30, 300], ["vac", 0, 40]].forEach((m) => {
      const o = j.cities[city] && j.cities[city][m[0]];
      if (!o) return;
      const v = num(o.value);
      if (v == null || v < m[1] || v > m[2] || !isHttps(o.url) || !isDate(o.date) || ageDays(o.date) > 200 || ageDays(o.date) < -1) return;
      out.push({ city, metric: m[0], value: v, publisher: clean(o.publisher, 50), url: o.url, date: o.date });
    });
  });
  return out;
}

/* ---------- refresh: baseline + validated collection, written atomically ---------- */
async function refresh() {
  if (state.running) throw new Error("A refresh is already running");
  state.running = true; state.lastStart = Date.now(); state.lastError = null;
  try {
    const base = readJson(BASE);
    if (!base) throw new Error("data/base.json is missing");
    const prev = readJson(LIVE);
    const data = JSON.parse(JSON.stringify(base));
    const errors = [];
    const run = async (name, fn) => { try { return await fn(); } catch (e) { errors.push(name + ": " + e.message); return []; } };
    const [claims, news, cityMetrics] = await Promise.all([run("claims", collectClaims), run("news", collectNews), run("cities", collectCities)]);

    claims.forEach((c) => {
      const k = sid(c.url, c.date);
      data.sources[k] = { name: c.label, url: c.url, date: c.date, ai: true };
      data.claims.push({ label: c.label, note: c.note, value: c.value, kind: c.kind, src: k });
    });
    cityMetrics.forEach((m) => {
      const k = sid(m.url, m.date);
      data.sources[k] = { name: m.publisher || "Broker report", url: m.url, date: m.date, ai: true };
      data.cities[m.city] = data.cities[m.city] || {};
      const existing = data.cities[m.city][m.metric];
      const existingDate = existing && data.sources[existing[1]] ? Date.parse(data.sources[existing[1]].date) : 0;
      if (Date.parse(m.date) >= existingDate) data.cities[m.city][m.metric] = [m.value, k];
    });
    const seen = {};
    const merged = news.concat(((prev && prev.pipeline && prev.pipeline.announcements) || []).filter((a) => a && isHttps(a.url)))
      .filter((a) => (seen[a.url] ? false : (seen[a.url] = true)))
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 40);
    data.pipeline = data.pipeline || { expect: [] };
    data.pipeline.announcements = merged;

    const counts = { claims: claims.length, announcements: news.length, cityMetrics: cityMetrics.length };
    if (errors.length && !counts.claims && !counts.announcements && !counts.cityMetrics) throw new Error(errors.join(" | "));
    data.meta = { collectedAt: new Date().toISOString(), via: MOCK ? "mock" : "gemini", model: MOCK ? "mock" : MODEL, counts, errors };
    writeJson(LIVE, data);
    state.lastRun = data.meta.collectedAt; state.lastCounts = counts;
    if (errors.length) state.lastError = errors.join(" | ");
    return { collectedAt: state.lastRun, counts, errors };
  } catch (e) {
    state.lastError = e.message; throw e;
  } finally { state.running = false; }
}

/* ---------- HTTP ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({ "content-type": type || "application/json; charset=utf-8", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" }, extra || {}));
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function safeEqual(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/api/health") return send(res, 200, { ok: true });
    if (p === "/api/data" && req.method === "GET") {
      const d = currentData();
      return d ? send(res, 200, d, null, { "cache-control": "no-cache" }) : send(res, 500, { error: "no data" });
    }
    if (p === "/api/status" && req.method === "GET") {
      const d = currentData();
      return send(res, 200, { collector: KEY || MOCK ? (MOCK ? "mock" : "ready") : "disabled (no GEMINI_API_KEY)", model: MODEL, running: state.running, lastRun: state.lastRun || (d && d.meta && d.meta.collectedAt) || null, lastCounts: state.lastCounts, lastError: state.lastError });
    }
    if (p === "/api/refresh" && req.method === "POST") {
      if (!ADMIN) return send(res, 403, { error: "Set ADMIN_TOKEN to enable manual refresh" });
      const t = String(req.headers["x-admin-token"] || "");
      if (!safeEqual(t, ADMIN)) return send(res, 401, { error: "bad token" });
      if (!KEY && !MOCK) return send(res, 400, { error: "GEMINI_API_KEY is not set" });
      if (Date.now() - state.lastStart < MIN_GAP && state.lastStart) return send(res, 429, { error: "Refreshed recently. Try again in a few minutes." });
      try { return send(res, 200, await refresh()); } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" });
    let f = path.normalize(path.join(PUB, p === "/" ? "index.html" : p));
    if (!f.startsWith(PUB + path.sep) && f !== PUB) return send(res, 403, "forbidden", "text/plain");
    fs.readFile(f, (err, buf) => err ? send(res, 404, "not found", "text/plain") : send(res, 200, buf, TYPES[path.extname(f)] || "application/octet-stream"));
  } catch (e) { send(res, 500, { error: "server error" }); }
});

/* ---------- scheduler ---------- */
function maybeRefresh() {
  if (!KEY && !MOCK) return;
  const last = state.lastRun || (currentData() && currentData().meta && currentData().meta.collectedAt);
  if (!last || Date.now() - Date.parse(last) > DAY) refresh().then((r) => console.log("refreshed", JSON.stringify(r.counts))).catch((e) => console.error("refresh failed:", e.message));
}
if (require.main === module) {
  server.listen(PORT, () => {
    console.log("GCC Atlas on http://localhost:" + PORT + " | collector: " + (MOCK ? "mock" : KEY ? "on (" + MODEL + ")" : "off, set GEMINI_API_KEY"));
    setTimeout(maybeRefresh, 3000);
    setInterval(maybeRefresh, 6 * 3600 * 1000).unref();
  });
}
module.exports = { server, refresh };
