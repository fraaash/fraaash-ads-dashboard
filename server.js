"use strict";

/**
 * Fraaash Ads dashboard.
 *
 * Reads the Airtable base that the nightly Meta ads agent writes to, and serves
 * the dashboard. The Airtable token stays on this side -- the browser only ever
 * talks to /api/* on this server, never to Airtable or Meta directly.
 */

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE = process.env.AIRTABLE_BASE_ID || "appp3bMk7dH0pD5XO";

const TABLE = {
  daily: "Daily Metrics",
  adsets: "Ad Set Performance",
  log: "Agent Log",
};

/* ------------------------------------------------------------------ *
 * Small in-process cache.
 * Airtable allows 5 requests/second per base. A dashboard that several
 * people refresh would blow through that without this.
 * ------------------------------------------------------------------ */

const CACHE_MS = 60_000;
const cache = new Map();

async function cached(key, produce) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return { ...hit.val, cachedAt: hit.at };
  }
  const val = await produce();
  cache.set(key, { at: Date.now(), val });
  return { ...val, cachedAt: Date.now() };
}

/* ------------------------------------------------------------------ *
 * Airtable
 * ------------------------------------------------------------------ */

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

async function airtable(table, pairs = []) {
  if (!TOKEN) {
    throw fail(500, "no_token", "AIRTABLE_TOKEN is not set on the server.");
  }

  const records = [];
  let offset;

  do {
    const qs = new URLSearchParams(pairs);
    qs.set("pageSize", "100");
    if (offset) qs.set("offset", offset);

    const url = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}?${qs}`;
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw fail(504, "airtable_unreachable", `Could not reach Airtable: ${e.message}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw fail(502, "airtable_auth", "Airtable rejected the token. Check AIRTABLE_TOKEN and that it is scoped to this base.");
    }
    if (res.status === 404) {
      throw fail(502, "airtable_not_found", `Airtable has no table "${table}" in base ${BASE}.`);
    }
    if (res.status === 429) {
      throw fail(503, "airtable_rate_limited", "Airtable rate limit hit. Try again shortly.");
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw fail(502, "airtable_error", `Airtable returned ${res.status}. ${body.slice(0, 200)}`);
    }

    const json = await res.json();
    records.push(...(json.records || []));
    offset = json.offset;
  } while (offset && records.length < 5000);

  return records;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const isISO = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

function shiftDay(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayISO() {
  // The account and the business both run on Malaysia time.
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

function range(req) {
  const until = isISO(req.query.until) ? req.query.until : todayISO();
  const since = isISO(req.query.since) ? req.query.since : shiftDay(until, -6);
  return since <= until ? { since, until } : { since: until, until: since };
}

// Airtable's reliable date predicate. Bounds are exclusive, so widen by a day.
function dateWindow(since, until) {
  return [
    [
      "filterByFormula",
      `AND(IS_AFTER({Date}, '${shiftDay(since, -1)}'), IS_BEFORE({Date}, '${shiftDay(until, 1)}'))`,
    ],
  ];
}

const n = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const n0 = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

// Airtable percent fields store 0.0272 for 2.72%.
const pct = (v) => (typeof v === "number" && isFinite(v) ? v * 100 : null);

/* ------------------------------------------------------------------ *
 * Password gate
 *
 * Password only -- no username. The page shows its own login card and
 * posts to /api/login; there is no browser basic-auth dialog.
 *
 * The check is server-side. index.html is served to anyone, but it holds
 * no data: every figure comes from /api/*, which requires the session
 * cookie. A client-side-only gate would put the password in the page
 * source and leave the API wide open.
 *
 * The session is a signed cookie, nothing stored server-side. It is
 * signed with a key derived from the password, so changing the password
 * silently invalidates every existing session.
 *
 * Left unset, the site is open. That is the local-dev case, but it is
 * also how someone publishes their ad spend by accident, so the boot log
 * states which mode it is in.
 * ------------------------------------------------------------------ */

const PASSWORD = process.env.DASHBOARD_PASSWORD;
const SESSION_COOKIE = "fad_session";
const SESSION_DAYS = 30;

const signingKey = PASSWORD
  ? crypto.createHash("sha256").update("fad|" + PASSWORD).digest()
  : null;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function sameSecret(supplied, actual) {
  const a = Buffer.from(String(supplied), "utf8");
  const b = Buffer.from(String(actual), "utf8");
  // timingSafeEqual throws on length mismatch, and the length difference
  // is not itself a secret worth protecting.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function mintSession() {
  const exp = String(Date.now() + SESSION_DAYS * 86400_000);
  const payload = b64url(exp);
  const sig = b64url(crypto.createHmac("sha256", signingKey).update(payload).digest());
  return payload + "." + sig;
}

function sessionValid(token) {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(crypto.createHmac("sha256", signingKey).update(payload).digest());
  if (!sameSecret(sig, expected)) return false;
  const exp = parseInt(Buffer.from(payload, "base64url").toString("utf8"), 10);
  return Number.isFinite(exp) && Date.now() < exp;
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// Brute-force damping. In-process and per-instance, which is fine here:
// the aim is to make guessing slow, not to build an auth service.
const attempts = new Map();
const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW = 15 * 60_000;

function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() > rec.resetAt) return false;
  return rec.count >= ATTEMPT_LIMIT;
}
function noteAttempt(ip, ok) {
  if (ok) return attempts.delete(ip);
  const rec = attempts.get(ip);
  if (!rec || Date.now() > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: Date.now() + ATTEMPT_WINDOW });
  } else {
    rec.count++;
  }
}

app.use(express.json({ limit: "8kb" }));

app.post("/api/login", (req, res) => {
  if (!PASSWORD) return res.json({ ok: true, open: true });

  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
  if (tooManyAttempts(ip)) {
    return res.status(429).json({
      error: { code: "too_many_attempts", message: "Too many attempts. Wait 15 minutes and try again." },
    });
  }

  const supplied = req.body && typeof req.body.password === "string" ? req.body.password : "";
  const ok = supplied.length > 0 && sameSecret(supplied, PASSWORD);
  noteAttempt(ip, ok);

  if (!ok) {
    return res.status(401).json({ error: { code: "bad_password", message: "That password is not right." } });
  }

  res.cookie(SESSION_COOKIE, mintSession(), {
    httpOnly: true,
    secure: req.secure || req.headers["x-forwarded-proto"] === "https",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400_000,
  });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (!PASSWORD) return next();

  // Render's health check sends no cookie. Gating it would make Render
  // conclude the service is down and cycle it forever.
  if (req.path === "/api/health") return next();

  if (sessionValid(readCookie(req, SESSION_COOKIE))) return next();

  // Everything under /api carries data, so it is refused. Anything else is
  // the page shell, which holds no figures -- it renders its own login card
  // once /api/* answers 401.
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: { code: "locked", message: "Password required." } });
  }
  next();
});

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    base: BASE,
    tokenConfigured: Boolean(TOKEN),
    today: todayISO(),
  });
});

app.get("/api/daily", async (req, res, next) => {
  const { since, until } = range(req);
  try {
    const out = await cached(`daily:${since}:${until}`, async () => {
      const recs = await airtable(TABLE.daily, [
        ...dateWindow(since, until),
        ["sort[0][field]", "Date"],
        ["sort[0][direction]", "asc"],
      ]);

      const rows = recs
        .map((r) => r.fields || {})
        .filter((f) => isISO(f.Date) && f.Date >= since && f.Date <= until)
        .map((f) => ({
          date: f.Date,
          spend: n0(f.Spend),
          purchases: n0(f.Purchases),
          cac: n(f.CAC),
          roas: n(f.ROAS),
          ctr: pct(f.CTR),
          impressions: n0(f.Impressions),
          clicks: n0(f.Clicks),
          aov: n(f.AOV),
          budgetTotal: n(f["Budget Total"]),
          updatedAt: f["Updated At"] || null,
        }));

      return { since, until, rows, totals: totalsOf(rows) };
    });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

function totalsOf(rows) {
  const t = rows.reduce(
    (a, r) => {
      a.spend += r.spend;
      a.purchases += r.purchases;
      a.impressions += r.impressions;
      a.clicks += r.clicks;
      // ROAS is a ratio; reconstruct revenue before summing.
      if (r.roas !== null) a.revenue += r.roas * r.spend;
      return a;
    },
    { spend: 0, purchases: 0, impressions: 0, clicks: 0, revenue: 0 }
  );

  return {
    spend: t.spend,
    purchases: t.purchases,
    impressions: t.impressions,
    clicks: t.clicks,
    cac: t.purchases > 0 ? t.spend / t.purchases : null,
    ctr: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : null,
    roas: t.spend > 0 && t.revenue > 0 ? t.revenue / t.spend : null,
    aov: t.purchases > 0 && t.revenue > 0 ? t.revenue / t.purchases : null,
    budgetTotal: rows.length ? rows[rows.length - 1].budgetTotal : null,
  };
}

app.get("/api/adsets", async (req, res, next) => {
  const { since, until } = range(req);
  try {
    const out = await cached(`adsets:${since}:${until}`, async () => {
      const recs = await airtable(TABLE.adsets, [
        ...dateWindow(since, until),
        ["sort[0][field]", "Date"],
        ["sort[0][direction]", "asc"],
      ]);

      // One row per ad set per day -> aggregate across the window.
      // CAC, CTR and ROAS are recomputed from their components; averaging the
      // stored per-day values would weight a RM5 day the same as a RM300 day.
      const byId = new Map();

      for (const rec of recs) {
        const f = rec.fields || {};
        if (!isISO(f.Date) || f.Date < since || f.Date > until) continue;

        const id = f["Ad Set ID"] || f["Ad Set"] || rec.id;
        if (!byId.has(id)) {
          byId.set(id, {
            id,
            name: f["Ad Set"] || "Untitled",
            status: f.Status || "",
            lastDate: f.Date,
            spend: 0, purchases: 0, impressions: 0, clicks: 0,
            revenue: 0, cpmWeighted: 0, freqWeighted: 0,
          });
        }

        const a = byId.get(id);
        const spend = n0(f.Spend);
        const impr = n0(f.Impressions);

        a.spend += spend;
        a.purchases += n0(f.Purchases);
        a.impressions += impr;
        a.clicks += n0(f.Clicks);
        if (n(f.ROAS) !== null) a.revenue += f.ROAS * spend;
        if (n(f.CPM) !== null) a.cpmWeighted += f.CPM * impr;
        if (n(f.Frequency) !== null) a.freqWeighted += f.Frequency * impr;

        if (f.Date >= a.lastDate) {
          a.lastDate = f.Date;
          a.status = f.Status || a.status;
          a.name = f["Ad Set"] || a.name;
        }
      }

      const rows = [...byId.values()]
        .map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          spend: a.spend,
          purchases: a.purchases,
          cac: a.purchases > 0 ? a.spend / a.purchases : null,
          ctr: a.impressions > 0 ? (a.clicks / a.impressions) * 100 : null,
          roas: a.spend > 0 && a.revenue > 0 ? a.revenue / a.spend : null,
          cpm: a.impressions > 0 ? a.cpmWeighted / a.impressions : null,
          freq: a.impressions > 0 ? a.freqWeighted / a.impressions : null,
        }))
        .filter((r) => r.spend > 0)
        .sort((x, y) => {
          if (x.cac === null) return 1;
          if (y.cac === null) return -1;
          return x.cac - y.cac;
        });

      return { since, until, rows };
    });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

app.get("/api/log", async (req, res, next) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  try {
    const out = await cached(`log:${limit}`, async () => {
      const recs = await airtable(TABLE.log, [
        ["sort[0][field]", "Date"],
        ["sort[0][direction]", "desc"],
        ["maxRecords", String(limit)],
      ]);

      const rows = recs.map((rec) => {
        const f = rec.fields || {};
        let actions = [];
        if (typeof f.Actions === "string" && f.Actions.trim()) {
          try {
            const parsed = JSON.parse(f.Actions);
            if (Array.isArray(parsed)) actions = parsed;
          } catch {
            // The agent wrote something that is not JSON. Show it rather than
            // dropping it -- a malformed entry is still information.
            actions = [{ type: "note", status: "done", entity: "Unparsed log entry", why: f.Actions }];
          }
        }
        return {
          date: f.Date || null,
          verdict: f.Verdict || "hold",
          summary: f.Summary || "",
          actions,
          cac: n(f.CAC),
          spend: n(f.Spend),
          purchases: n(f.Purchases),
          roas: n(f.ROAS),
          budgetTotal: n(f["Budget Total"]),
          budgetChanged: Boolean(f["Budget Changed"]),
          needsApproval: Boolean(f["Needs Approval"]),
        };
      });

      return { rows };
    });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ *
 * Static + errors
 * ------------------------------------------------------------------ */

app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

app.use("/api", (_req, res) => {
  res.status(404).json({ error: { code: "not_found", message: "No such endpoint." } });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error("[error]", err.code || "unknown", err.message);
  res.status(status).json({
    error: {
      code: err.code || "server_error",
      message: err.message || "Something went wrong.",
    },
  });
});

app.listen(PORT, () => {
  console.log(`Fraaash Ads dashboard on :${PORT}`);
  console.log(`Airtable base ${BASE} | token ${TOKEN ? "configured" : "MISSING"}`);
  console.log(
    PASSWORD
      ? "Password gate ON"
      : "Password gate OFF - DASHBOARD_PASSWORD is not set, anyone with the URL can read this"
  );
});
