/**
 * Sky Transfers — agent portal
 * ----------------------------
 * Mounted by stripe-server.js, which passes in everything it already owns:
 * the fare table, the lead-time rule, the mailer and the booking formatter.
 * Kept in its own file so the portal can change without rewriting the
 * payment server around it.
 *
 * Two audiences:
 *   /agent/*   travel agents and DMCs — quote, book, amend, cancel, voucher
 *   /admin/*   Sky Transfers — create agents, reset PINs, pay commission
 *
 * Environment:
 *   DATABASE_URL   Postgres (Render links this from the sky-transfers-agents instance)
 *   AGENT_SECRET   signs session tokens for both audiences
 *   ADMIN_PIN      the office PIN for /admin; without it the admin side stays shut
 *   AGENT_SEED     optional bootstrap agents, see seedAgents below
 */
module.exports = function installAgentPortal(ctx) {
  const {
    app, computeFare, VEHICLES, leadTimeShortfall, LEAD_TIME_ERROR,
    makeRef, bookingSummary, mailer, BOOKINGS_EMAIL, PLACES_FOR_AGENTS,
    stripe,
    /* The website's own confirmation pieces, so what the office sends a guest
       is byte-for-byte what the site would have sent. */
    bookingPdf, bookingEmailHtml, guestAttachments, fareForBooking, returnLeg, HUB_NAMES,
    hourlyHours,
  } = ctx;
  const hoursOf = (b) => (typeof hourlyHours === "function" ? hourlyHours(b) : null);
  const { Pool } = require("pg");
  const crypto = require("crypto");
  const PDFDocument = require("pdfkit");
  const path = require("path");
  const fs = require("fs");

  const AGENT_SECRET = process.env.AGENT_SECRET || "";
  const ADMIN_PIN = process.env.ADMIN_PIN || "";
  const LOGO = path.join(__dirname, "logo.png");
  const HAS_LOGO = fs.existsSync(LOGO);
  const pool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        /* Render's managed Postgres presents a certificate signed by its own
           internal CA. The connection stays inside Render's private network. */
        ssl: { rejectUnauthorized: false },
        max: 4,
      })
    : null;
  const AGENTS_ON = Boolean(pool && AGENT_SECRET);

  /* Amendments and cancellations close 24 hours out, matching the free-change
     promise the public site already makes. Brisbane is UTC+10 year round, and
     this box runs in Singapore, so the pick-up is turned into an absolute
     instant arithmetically rather than read off any local clock. */
  const CHANGE_CUTOFF_HOURS = 24;
  const BNE_OFFSET_MS = 10 * 3600 * 1000;
  function hoursUntil(dateStr, timeStr) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
    const t = /^(\d{1,2}):(\d{2})/.exec(String(timeStr || ""));
    if (!d || !t) return null;
    const when = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]) - BNE_OFFSET_MS;
    return (when - Date.now()) / 3600000;
  }
  const CHANGE_CLOSED =
    `Changes and cancellations close ${CHANGE_CUTOFF_HOURS} hours before pick-up. ` +
    "Call +61 481 437 772 and we'll do what we can.";

  /* One idempotent migration at boot. The ALTERs are separate and guarded so
     an instance running the previous version can be rolled forward without a
     migration step or a maintenance window. */
  async function initAgentSchema() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        code            TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        email           TEXT,
        pin_hash        TEXT NOT NULL,
        commission_pct  NUMERIC(5,2) NOT NULL DEFAULT 10,
        active          BOOLEAN NOT NULL DEFAULT TRUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS gallery_photos (
        id          SERIAL PRIMARY KEY,
        caption     TEXT NOT NULL DEFAULT '',
        vehicle     TEXT NOT NULL DEFAULT '',
        mime        TEXT NOT NULL,
        width       INTEGER NOT NULL,
        height      INTEGER NOT NULL,
        bytes       BYTEA NOT NULL,
        sha1        TEXT NOT NULL,
        sort        INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS gallery_photos_sha1_key ON gallery_photos (sha1);
      CREATE TABLE IF NOT EXISTS agent_bookings (
        ref               TEXT PRIMARY KEY,
        agent_code        TEXT NOT NULL REFERENCES agents(code),
        pickup            TEXT NOT NULL,
        dropoff           TEXT NOT NULL,
        vehicle           TEXT NOT NULL,
        pickup_date       DATE NOT NULL,
        pickup_time       TEXT NOT NULL,
        passenger_name    TEXT NOT NULL,
        passenger_phone   TEXT NOT NULL,
        passenger_email   TEXT,
        flight            TEXT,
        address           TEXT,
        notes             TEXT,
        pax               INT NOT NULL DEFAULT 1,
        child_seats       INT NOT NULL DEFAULT 0,
        trailer           BOOLEAN NOT NULL DEFAULT FALSE,
        total_cents       INT NOT NULL,
        commission_cents  INT NOT NULL,
        commission_pct    NUMERIC(5,2) NOT NULL,
        status            TEXT NOT NULL DEFAULT 'confirmed',
        settled           BOOLEAN NOT NULL DEFAULT FALSE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS settled_at   TIMESTAMPTZ;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ;
      -- Agent portal v2 (19 Oct 2026): the agency's own reference, a return
      -- leg, by-the-hour hire, and the two ends as the page priced them (JSON,
      -- so an amendment can be priced again from the same addresses).
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS client_ref    TEXT;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS return_date   DATE;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS return_time   TEXT;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS return_flight TEXT;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS hire_hours    INTEGER;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS ends          TEXT;
      -- stops on the way (outbound): JSON {list, extra, km}, as web_bookings
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS stops         TEXT;
      CREATE INDEX IF NOT EXISTS agent_bookings_by_agent
        ON agent_bookings (agent_code, created_at DESC);
      CREATE TABLE IF NOT EXISTS web_bookings (
        ref             TEXT PRIMARY KEY,
        pickup          TEXT,
        dropoff         TEXT,
        vehicle         TEXT,
        pickup_date     DATE,
        pickup_time     TEXT,
        passenger_name  TEXT,
        passenger_phone TEXT,
        passenger_email TEXT,
        flight          TEXT,
        address         TEXT,
        notes           TEXT,
        pax             INT     NOT NULL DEFAULT 1,
        child_seats     INT     NOT NULL DEFAULT 0,
        trailer         BOOLEAN NOT NULL DEFAULT FALSE,
        total_cents     INT     NOT NULL DEFAULT 0,
        status          TEXT    NOT NULL DEFAULT 'requested',
        user_agent      TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        confirmed_at    TIMESTAMPTZ,
        declined_at     TIMESTAMPTZ,
        paid_at         TIMESTAMPTZ
      );
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS return_date      DATE;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS return_time      TEXT;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS return_flight    TEXT;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS payment_link_id  TEXT;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS payment_link_url TEXT;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS link_seq         INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS payment_intent   TEXT;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS balance_cents    INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS balance_link_id  TEXT;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS balance_link_url TEXT;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS hire_hours       INTEGER;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS stops            TEXT;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS cancelled_at     TIMESTAMPTZ;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS refunded_cents   INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS cancel_note      TEXT;
      CREATE INDEX IF NOT EXISTS web_bookings_recent ON web_bookings (created_at DESC);
      CREATE INDEX IF NOT EXISTS web_bookings_status ON web_bookings (status, created_at DESC);
    `);
  }

  /* ---- who the agents are ---------------------------------------------
     AGENT_SEED is a bootstrap, not the management tool — /admin is. It is
     kept so a fresh database comes up with a working login.

     AGENT_SEED = [{"code":"NEXUS","name":"Nexus Travel","email":"ops@nexus.com","pct":12.5,"pin":"4821"}]

     Name, email and rate reapply every boot. The PIN is only written when the
     agent is created, so a redeploy never silently resets a PIN an agent has
     been given. Deactivate with "active": false — never delete the row, the
     bookings behind their wallet balance point at it. */
  async function seedAgents() {
    if (!pool || !process.env.AGENT_SEED) return;
    let list;
    try {
      list = JSON.parse(process.env.AGENT_SEED);
    } catch (e) {
      console.error("AGENT_SEED is not valid JSON — no agents were seeded:", e.message);
      return;
    }
    if (!Array.isArray(list)) return console.error("AGENT_SEED must be a JSON array.");
    for (const a of list) {
      const code = String(a.code || "").trim().toUpperCase();
      if (!code || !a.name || a.pin == null) {
        console.error("Skipping an AGENT_SEED entry missing code, name or pin.");
        continue;
      }
      await pool.query(
        `INSERT INTO agents (code, name, email, pin_hash, commission_pct, active)
              VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (code) DO UPDATE
              SET name = EXCLUDED.name,
                  email = EXCLUDED.email,
                  commission_pct = EXCLUDED.commission_pct,
                  active = EXCLUDED.active`,
        [code, a.name, a.email || null, makePinHash(a.pin),
         Number(a.pct) || 0, a.active === false ? false : true]
      );
    }
    console.log(`Agent seed applied: ${list.length} agent(s).`);
  }

  /* ---- PIN storage ----------------------------------------------------
     scrypt with a per-agent salt. A PIN is only four to six digits, so it is
     guessable by brute force in principle — the throttle below is what makes
     it safe in practice, not the hash. */
  function hashPin(pin, salt) {
    return crypto.scryptSync(String(pin), salt, 32).toString("hex");
  }
  function makePinHash(pin) {
    const salt = crypto.randomBytes(16).toString("hex");
    return `${salt}$${hashPin(pin, salt)}`;
  }
  function pinMatches(pin, stored) {
    const [salt, want] = String(stored || "").split("$");
    if (!salt || !want) return false;
    const got = hashPin(pin, salt);
    const a = Buffer.from(got, "hex");
    const b = Buffer.from(want, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  /* Four digits, no leading zero lost to a string conversion later. */
  function newPin() {
    return String(crypto.randomInt(1000, 10000));
  }

  /* Five wrong PINs locks that code for fifteen minutes. In-memory on purpose:
     the process restarting is not an attack, and a Redis dependency for one
     counter would be silly. */
  const LOGIN_FAILS = new Map();
  const MAX_FAILS = 5;
  const LOCKOUT_MS = 15 * 60 * 1000;
  function loginLocked(code) {
    const rec = LOGIN_FAILS.get(code);
    if (!rec) return false;
    if (Date.now() - rec.at > LOCKOUT_MS) { LOGIN_FAILS.delete(code); return false; }
    return rec.n >= MAX_FAILS;
  }
  function noteLoginFail(code) {
    const rec = LOGIN_FAILS.get(code);
    if (rec && Date.now() - rec.at <= LOCKOUT_MS) { rec.n += 1; rec.at = Date.now(); }
    else LOGIN_FAILS.set(code, { n: 1, at: Date.now() });
  }

  /* ---- session tokens -------------------------------------------------
     payload.signature, no library. Twelve hours for agents, long enough for a
     working day and short enough that a shared office computer forgets by
     morning; the admin session is deliberately shorter. */
  function signToken(code, role, ttlMs) {
    const body = Buffer.from(JSON.stringify({ code, role, exp: Date.now() + ttlMs })).toString("base64url");
    const sig = crypto.createHmac("sha256", AGENT_SECRET).update(body).digest("base64url");
    return `${body}.${sig}`;
  }
  function readToken(token) {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;
    const want = crypto.createHmac("sha256", AGENT_SECRET).update(body).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const claim = JSON.parse(Buffer.from(body, "base64url").toString());
      return claim.exp > Date.now() ? claim : null;
    } catch { return null; }
  }
  const bearer = (req) =>
    (req.headers.authorization || "").replace(/^Bearer /, "") || String(req.query.t || "");

  async function requireAgent(req, res, next) {
    if (!AGENTS_ON) return res.status(503).json({ error: "The agent portal is not configured on this server." });
    const claim = readToken(bearer(req));
    if (!claim || claim.role !== "agent") return res.status(401).json({ error: "Your session has expired — please sign in again." });
    const { rows } = await pool.query(
      "SELECT code, name, email, commission_pct, active FROM agents WHERE code = $1", [claim.code]);
    if (!rows.length || !rows[0].active) return res.status(401).json({ error: "This account is no longer active." });
    req.agent = rows[0];
    next();
  }

  function requireAdmin(req, res, next) {
    if (!AGENTS_ON) return res.status(503).json({ error: "The agent portal is not configured on this server." });
    if (!ADMIN_PIN) return res.status(503).json({ error: "Admin access is not configured on this server." });
    const claim = readToken(bearer(req));
    if (!claim || claim.role !== "admin") return res.status(401).json({ error: "Your admin session has expired." });
    next();
  }

  const agentPct = (a) => Number(a.commission_pct);
  const commissionOf = (totalCents, pct) => Math.round(totalCents * pct / 100);
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;

  /* ---- sign in --------------------------------------------------------- */
  app.post("/agent/login", async (req, res) => {
    try {
      if (!AGENTS_ON) return res.status(503).json({ error: "The agent portal is not configured on this server." });
      const code = String(req.body?.code || "").trim().toUpperCase();
      const pin = String(req.body?.pin || "").trim();
      if (!code || !pin) return res.status(400).json({ error: "Enter your agent code and PIN." });
      if (loginLocked(code)) {
        return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes, or call +61 481 437 772." });
      }
      const { rows } = await pool.query(
        "SELECT code, name, pin_hash, commission_pct, active FROM agents WHERE code = $1", [code]);
      const a = rows[0];
      /* One message for every failure, so the form cannot be used to discover
         which agent codes exist. */
      if (!a || !a.active || !pinMatches(pin, a.pin_hash)) {
        noteLoginFail(code);
        return res.status(401).json({ error: "That code and PIN do not match." });
      }
      LOGIN_FAILS.delete(code);
      res.json({ token: signToken(a.code, "agent", 12 * 3600 * 1000), name: a.name, code: a.code, commissionPct: agentPct(a) });
    } catch (err) {
      console.error("agent login:", err);
      res.status(500).json({ error: "Could not sign you in just now." });
    }
  });

  app.post("/admin/login", (req, res) => {
    if (!AGENTS_ON) return res.status(503).json({ error: "The agent portal is not configured on this server." });
    if (!ADMIN_PIN) return res.status(503).json({ error: "Admin access is not configured on this server." });
    const pin = String(req.body?.pin || "").trim();
    if (loginLocked("__admin__")) {
      return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    }
    const a = Buffer.from(pin);
    const b = Buffer.from(ADMIN_PIN);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      noteLoginFail("__admin__");
      return res.status(401).json({ error: "Wrong PIN." });
    }
    LOGIN_FAILS.delete("__admin__");
    res.json({ token: signToken("__admin__", "admin", 4 * 3600 * 1000) });
  });

  /* The portal holds no rate tables of its own — it asks for the same places
     and the same fares the public site is quoting, so the two cannot drift. */
  app.get("/agent/places", requireAgent, (req, res) => {
    res.json({ places: PLACES_FOR_AGENTS, vehicles: VEHICLES });
  });

  /* ---- pricing: exactly what the public site charges --------------------
     Agents get the same engine as the website, through fareForBooking: the
     zone tables first; then, for an address we have no zone fare for, the
     road distance to the airport (to 300 km); then point-to-point between
     any two addresses; and by-the-hour hire. The page sends the two ends as
     it picked them ({suburb, address, lat, lng}); the server measures again
     and never takes a fare from the page. */
  const AGENT_HUBS = new Set(HUB_NAMES || []);
  function endOf(o, name) {
    const src = o && typeof o === "object" ? o : {};
    const e = { suburb: String(src.suburb || name || "").trim().slice(0, 120) };
    if (src.address) e.address = String(src.address).trim().slice(0, 300);
    if (src.lat != null && src.lng != null && Number.isFinite(+src.lat) && Number.isFinite(+src.lng)) { e.lat = +src.lat; e.lng = +src.lng; }
    if (!e.address) e.address = e.suburb + ", QLD, Australia";
    return e;
  }
  function tripOf(b) {
    const hours = hoursOf(b);
    const ends = b.ends && typeof b.ends === "object" ? b.ends : {};
    const pickup = String(b.pickup || "").trim(), dropoff = hours ? "As directed" : String(b.dropoff || "").trim();
    /* Stops on the way, outbound only and at most three, as the page picked
       them. By the hour has none - it is as directed already. */
    const stops = hours || !Array.isArray(b.stops) ? []
      : b.stops.slice(0, 3).filter((s) => s && typeof s === "object" && String(s.address || s.suburb || "").trim().length >= 3)
          .map((s) => endOf(s, s.suburb));
    return { pickup, dropoff, hours, stops, pu: endOf(ends.pickup, pickup), dro: hours ? null : endOf(ends.dropoff, dropoff) };
  }
  /* {fare, stops, stopsExtra, stopsKm} or null. One call to fareForBooking,
     which also prices any stops by the extra distance (stops.js) - exactly
     the website's charge - and refuses the trip if a stop can't be measured. */
  async function agentFare(t, vehicle) {
    if (!t.pickup || !t.dropoff) return null;
    const q = { pickup: t.pickup, dropoff: t.dropoff, vehicle };
    if (t.hours) q.hourly = { hours: t.hours };
    else {
      if (t.stops.length) { q.stops = t.stops.map((s) => ({ ...s })); q.stopsEnds = { pickup: t.pu, dropoff: t.dro }; }
      if (computeFare(t.pickup, t.dropoff, vehicle) == null) {
        const puHub = AGENT_HUBS.has(t.pickup), droHub = AGENT_HUBS.has(t.dropoff);
        if (puHub && droHub) return null;
        if (puHub || droHub) q.km = { place: puHub ? t.dro : t.pu };
        else q.p2p = { pickup: t.pu, dropoff: t.dro };
      }
    }
    const fare = await fareForBooking(q).catch((e) => { console.error("agent fare:", e.message); return null; });
    if (fare == null) return null;
    return { fare, stops: Array.isArray(q.stops) ? q.stops : [], stopsExtra: q.stopsExtra || 0, stopsKm: q.stopsKm != null ? q.stopsKm : null };
  }
  const withStops = (b, r) => ({ ...b, stops: r.stops, stopsExtra: r.stopsExtra, stopsKm: r.stopsKm });
  /* The same rules the website enforces on a return leg. */
  function returnTripOf(b, hours) {
    if (hours) return { ret: null };
    const ret = typeof returnLeg === "function" ? returnLeg(b) : null;
    if (!ret) return { ret: null };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ret.date) || !/^\d{1,2}:\d{2}/.test(ret.time)) return { error: "Please give both a date and a time for the return trip." };
    if (ret.date < b.date || (ret.date === b.date && ret.time <= b.time)) return { error: "The return trip has to be after the outbound one." };
    if (leadTimeShortfall(ret.date, ret.time) !== null) return { error: LEAD_TIME_ERROR };
    return { ret };
  }

  app.post("/agent/quote", requireAgent, async (req, res) => {
    try {
      const body = req.body || {};
      const t = tripOf(body);
      const pct = agentPct(req.agent);
      const isReturn = !t.hours && !!body.returnTrip;
      const fares = await Promise.all(VEHICLES.map((v) => agentFare(t, v).catch(() => null)));
      const out = VEHICLES.map((v, i) => {
        const r = fares[i];
        if (r == null) return null;
        /* the transfer price for what was asked: one way, both legs (10% off,
           the site's own formula), or the hours - plus any stops, added once
           after the discount - before seats and trailer */
        const total = bookingSummary(withStops({ pickup: t.pickup, dropoff: t.dropoff, vehicle: v, hourly: t.hours ? { hours: t.hours } : undefined }, r),
          r.fare, 0, false, isReturn ? { date: "", time: "", flight: "" } : null).total;
        return { vehicle: v, fare: r.fare, total, stopsExtra: r.stopsExtra, commission: commissionOf(total * 100, pct) / 100 };
      }).filter(Boolean);
      const stopsKm = (fares.find((r) => r && r.stopsKm != null) || {}).stopsKm;
      if (!out.length) {
        return res.json({ quotable: false, message: "We can't fix a price for that trip online — call +61 481 437 772 and we'll price it for you." });
      }
      res.json({ quotable: true, commissionPct: pct, kind: t.hours ? "hourly" : isReturn ? "return" : "oneway", hours: t.hours,
                 stops: t.stops.length, stopsKm: stopsKm != null ? stopsKm : null, vehicles: out });
    } catch (err) {
      console.error("agent quote:", err);
      res.status(500).json({ error: "Could not price that just now." });
    }
  });

  /* Shared by book and amend: validate, price, and normalise one booking. */
  async function priceBooking(b, pct) {
    const t = tripOf(b);
    b.pickup = t.pickup; b.dropoff = t.dropoff;
    for (const f of ["pickup", "dropoff", "vehicle", "date", "time", "name", "phone"]) {
      if (!b[f]) return { error: "Please fill in every required field." };
    }
    const email = String(b.email || "").trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "That passenger email doesn't look right." };
    const priced = await agentFare(t, b.vehicle);
    if (priced == null) return { error: t.stops.length ? "We couldn't price the trip with those stops — check each stop was picked from the list, or call us." : "That trip needs a manual quote — please call us." };
    const fare = priced.fare;
    if (leadTimeShortfall(b.date, b.time) !== null) return { error: LEAD_TIME_ERROR };
    const r = returnTripOf(b, t.hours);
    if (r.error) return { error: r.error };
    const seats = Math.min(Math.max(parseInt(b.childSeats, 10) || 0, 0), 3);
    const trailer = b.trailer === true || b.trailer === "true";
    if (t.hours) b.hourly = { hours: t.hours };
    const s = bookingSummary(withStops({ ...b, email: email || b.agentEmail || BOOKINGS_EMAIL }, priced), fare, seats, trailer, r.ret);
    const totalCents = Math.round(s.total * 100);
    return {
      fare, priced, seats, trailer, summary: s, totalCents, ret: r.ret, hours: t.hours, email: email || null,
      /* the same shape web_bookings and ops.js read: {list, extra, km} */
      stops: priced.stops.length ? JSON.stringify({ list: priced.stops.map((x) => ({ address: x.address, suburb: x.suburb, lat: x.lat, lng: x.lng })),
                                                    extra: priced.stopsExtra, km: priced.stopsKm }) : null,
      clientRef: String(b.clientRef || "").trim().slice(0, 60) || null,
      ends: t.hours ? JSON.stringify({ pickup: t.pu }) : JSON.stringify({ pickup: t.pu, dropoff: t.dro }),
      commissionCents: commissionOf(totalCents, pct),
      pax: parseInt(b.pax, 10) || 1,
    };
  }

  function notifyOffice(subject, body, agent) {
    if (!mailer) return;
    mailer.sendMail({
      from: `"Sky Transfers Agent Portal" <${process.env.GMAIL_USER}>`,
      to: BOOKINGS_EMAIL,
      replyTo: agent.email || BOOKINGS_EMAIL,
      subject,
      text: body,
    }).catch((e) => console.error("agent portal email:", e.message));
  }

  app.post("/agent/book", requireAgent, async (req, res) => {
    try {
      const pct = agentPct(req.agent);
      const b = { ...(req.body || {}), agentEmail: req.agent.email };
      const p = await priceBooking(b, pct);
      if (p.error) return res.status(400).json({ error: p.error });
      b.ref = makeRef(b.date);
      /* again now the reference exists, so the emails carry it */
      p.summary = bookingSummary(withStops({ ...b, email: p.email || b.agentEmail || BOOKINGS_EMAIL }, p.priced), p.fare, p.seats, p.trailer, p.ret);

      await pool.query(
        `INSERT INTO agent_bookings
           (ref, agent_code, pickup, dropoff, vehicle, pickup_date, pickup_time,
            passenger_name, passenger_phone, passenger_email, flight, address, notes,
            pax, child_seats, trailer, total_cents, commission_cents, commission_pct,
            client_ref, return_date, return_time, return_flight, hire_hours, ends, stops)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
        [b.ref, req.agent.code, b.pickup, b.dropoff, b.vehicle, b.date, b.time,
         b.name, b.phone, p.email, b.flight || null, b.address || null, b.notes || null,
         p.pax, p.seats, p.trailer, p.totalCents, p.commissionCents, pct,
         p.clientRef, p.ret ? p.ret.date : null, p.ret ? p.ret.time : null, p.ret ? (p.ret.flight || null) : null, p.hours, p.ends, p.stops]
      );

      notifyOffice(
        `AGENT booking (${req.agent.code}): ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time}) [${b.ref}]`,
        `AGENT BOOKING — ${req.agent.name} (${req.agent.code})\n` + (p.clientRef ? `Agent reference: ${p.clientRef}\n` : "") + `\n${p.summary.text}\n\n` +
        `Agent commission: ${pct}% = ${money(p.commissionCents)}\n` +
        `Net to invoice the agent: ${money(p.totalCents - p.commissionCents)}\n`,
        req.agent
      );
      if (mailer && req.agent.email) {
        mailer.sendMail({
          from: `"Sky Transfers" <${process.env.GMAIL_USER}>`,
          to: req.agent.email,
          replyTo: BOOKINGS_EMAIL,
          subject: `Booking confirmed — ${b.ref} · Sky Transfers`,
          text:
            `Hi ${req.agent.name},\n\nYour booking is in and we'll confirm the chauffeur shortly.\n\n` +
            (p.clientRef ? `Your reference: ${p.clientRef}\n` : "") + `${p.summary.text}\n\n` +
            `Your commission on this booking: ${money(p.commissionCents)} (${pct}%)\n` +
            `This booking will appear on your monthly invoice at ${money(p.totalCents - p.commissionCents)}.\n\n` +
            `You can download a passenger voucher, change or cancel this booking in the portal up to ` +
            `${CHANGE_CUTOFF_HOURS} hours before pick-up.\n\nSky Transfers`,
        }).catch((e) => console.error("agent copy email:", e.message));
      }

      res.json({ ok: true, ref: b.ref, total: p.summary.total, commission: p.commissionCents / 100 });
    } catch (err) {
      console.error("agent book:", err);
      res.status(500).json({ error: "Could not save that booking — please call us so it isn't lost." });
    }
  });

  /* Fetch one of this agent's bookings, or explain why it can't be touched. */
  async function loadOwnBooking(req, ref, { forChange }) {
    const { rows } = await pool.query(
      "SELECT * FROM agent_bookings WHERE ref = $1 AND agent_code = $2", [ref, req.agent.code]);
    const bk = rows[0];
    if (!bk) return { error: "We can't find that booking.", code: 404 };
    if (forChange) {
      if (bk.status !== "confirmed") return { error: "That booking is already cancelled.", code: 400 };
      const iso = bk.pickup_date instanceof Date ? bk.pickup_date.toISOString().slice(0, 10) : String(bk.pickup_date);
      const h = hoursUntil(iso, bk.pickup_time);
      if (h == null || h < CHANGE_CUTOFF_HOURS) return { error: CHANGE_CLOSED, code: 400 };
    }
    return { booking: bk };
  }

  app.post("/agent/booking/cancel", requireAgent, async (req, res) => {
    try {
      const found = await loadOwnBooking(req, String(req.body?.ref || ""), { forChange: true });
      if (found.error) return res.status(found.code).json({ error: found.error });
      const bk = found.booking;
      await pool.query(
        "UPDATE agent_bookings SET status = 'cancelled', cancelled_at = now() WHERE ref = $1", [bk.ref]);
      /* The commission goes with it: the wallet only counts confirmed bookings,
         so cancelling reverses the earning automatically. */
      notifyOffice(
        `AGENT CANCELLED (${req.agent.code}): ${bk.pickup} -> ${bk.dropoff} [${bk.ref}]`,
        `CANCELLED by ${req.agent.name} (${req.agent.code})\n\n` +
        `Reference: ${bk.ref}\nRoute: ${bk.pickup} -> ${bk.dropoff}\n` +
        `Was: ${bk.pickup_date instanceof Date ? bk.pickup_date.toISOString().slice(0,10) : bk.pickup_date} ${bk.pickup_time}\n` +
        `Passenger: ${bk.passenger_name}\nVehicle: ${bk.vehicle}\n` +
        `Commission reversed: ${money(bk.commission_cents)}\n`,
        req.agent
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("agent cancel:", err);
      res.status(500).json({ error: "Could not cancel that booking — please call us." });
    }
  });

  app.post("/agent/booking/update", requireAgent, async (req, res) => {
    try {
      const found = await loadOwnBooking(req, String(req.body?.ref || ""), { forChange: true });
      if (found.error) return res.status(found.code).json({ error: found.error });
      const old = found.booking;
      const pct = agentPct(req.agent);
      const b = { ...(req.body || {}), agentEmail: req.agent.email };
      b.ref = old.ref;
      const p = await priceBooking(b, pct);
      if (p.error) return res.status(400).json({ error: p.error });

      await pool.query(
        `UPDATE agent_bookings SET
           pickup=$2, dropoff=$3, vehicle=$4, pickup_date=$5, pickup_time=$6,
           passenger_name=$7, passenger_phone=$8, passenger_email=$9, flight=$10,
           address=$11, notes=$12, pax=$13, child_seats=$14, trailer=$15,
           total_cents=$16, commission_cents=$17, commission_pct=$18, updated_at=now(),
           client_ref=$19, return_date=$20, return_time=$21, return_flight=$22, hire_hours=$23, ends=$24, stops=$25
         WHERE ref = $1`,
        [old.ref, b.pickup, b.dropoff, b.vehicle, b.date, b.time,
         b.name, b.phone, p.email, b.flight || null, b.address || null, b.notes || null,
         p.pax, p.seats, p.trailer, p.totalCents, p.commissionCents, pct,
         p.clientRef, p.ret ? p.ret.date : null, p.ret ? p.ret.time : null, p.ret ? (p.ret.flight || null) : null, p.hours, p.ends, p.stops]
      );

      const wasDate = old.pickup_date instanceof Date ? old.pickup_date.toISOString().slice(0, 10) : old.pickup_date;
      notifyOffice(
        `AGENT AMENDED (${req.agent.code}): ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time}) [${old.ref}]`,
        `AMENDED by ${req.agent.name} (${req.agent.code})\n\n` +
        `WAS: ${old.pickup} -> ${old.dropoff}, ${old.vehicle}, ${wasDate} ${old.pickup_time}, ` +
        `${old.passenger_name}, total ${money(old.total_cents)}\n\n` +
        `NOW:\n${p.summary.text}\n\n` +
        `Commission now: ${pct}% = ${money(p.commissionCents)} (was ${money(old.commission_cents)})\n` +
        `Net to invoice: ${money(p.totalCents - p.commissionCents)}\n`,
        req.agent
      );
      res.json({ ok: true, ref: old.ref, total: p.summary.total, commission: p.commissionCents / 100 });
    } catch (err) {
      console.error("agent update:", err);
      res.status(500).json({ error: "Could not save that change — please call us." });
    }
  });

  /* ---- passenger voucher ----------------------------------------------
     Deliberately carries no money at all — not the commission, and not the
     fare either. The agent sets their own price with their customer; a
     voucher that quoted what Sky Transfers charges would undercut them in
     front of their own client. It is a service confirmation, not an invoice. */
  function voucherPdf(bk, agentName) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 0 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const W = 595.28, L = 48, R = W - 48, CW = R - L;
      const NAVY = "#101828", INK = "#141D30", GOLD = "#C9A227", GOLD_D = "#8E701C",
            GOLD_LT = "#D9B44A", MUTED = "#68707F", LINE = "#E5E0D2", SOFT = "#F6EED9", CREAM = "#F6F2E8";
      const date = bk.pickup_date instanceof Date
        ? bk.pickup_date.toISOString().slice(0, 10) : String(bk.pickup_date);

      doc.rect(0, 0, W, 118).fill(NAVY);
      if (HAS_LOGO) { try { doc.image(LOGO, R - 96, 22, { fit: [96, 74] }); } catch (e) {} }
      doc.font("Times-Roman").fontSize(26).fillColor(CREAM).text("SKY TRANSFERS", L, 34, { characterSpacing: 4 });
      doc.font("Helvetica-Bold").fontSize(9).fillColor(GOLD_LT)
        .text("PASSENGER VOUCHER", L, 70, { characterSpacing: 2.5 });
      doc.font("Helvetica").fontSize(8.5).fillColor("#98A0B0")
        .text("Gold Coast & Brisbane private airport transfers", L, 86);
      doc.rect(0, 118, W, 3).fill(GOLD);

      let y = 146;
      doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("BOOKING REFERENCE", L, y, { characterSpacing: 1.5 });
      doc.font("Helvetica-Bold").fontSize(17).fillColor(INK).text(bk.ref, L, y + 12);
      const pill = "CONFIRMED";
      doc.font("Helvetica-Bold").fontSize(8);
      const pillW = doc.widthOfString(pill) + 24;
      doc.roundedRect(R - pillW, y + 8, pillW, 20, 10).fill("#1E7F4F");
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#FFFFFF")
        .text(pill, R - pillW, y + 14, { width: pillW, align: "center", characterSpacing: 1 });

      y += 48;
      const extras = [
        bk.child_seats > 0 ? `${bk.child_seats} child seat${bk.child_seats > 1 ? "s" : ""}` : "",
        bk.trailer ? "Luggage trailer" : "",
      ].filter(Boolean).join(", ") || "None";
      const rdate = bk.return_date instanceof Date ? bk.return_date.toISOString().slice(0, 10) : (bk.return_date ? String(bk.return_date) : "");
      const rows = [
        bk.hire_hours ? ["SERVICE", `${bk.hire_hours} hours as directed from ${bk.pickup}`] : ["ROUTE", `${bk.pickup}  to  ${bk.dropoff}`],
        ["DATE & TIME", `${date} at ${bk.pickup_time}`],
        (() => { let l = []; try { const j = bk.stops ? JSON.parse(bk.stops) : null; l = j && Array.isArray(j.list) ? j.list : []; } catch (e) { l = []; }
                 return l.length ? ["STOPS ON THE WAY", l.map((x, i) => `${i + 1}) ${x.address || x.suburb}`).join("\n")] : null; })(),
        rdate ? ["RETURN",`${rdate} at ${bk.return_time || ""}  ·  ${bk.dropoff}  to  ${bk.pickup}${bk.return_flight ? "  ·  flight " + bk.return_flight : ""}`] : null,
        bk.client_ref ? ["YOUR REFERENCE", bk.client_ref] : null,
        ["VEHICLE", bk.vehicle],
        ["PASSENGERS", String(bk.pax || "—")],
        bk.flight ? ["FLIGHT", bk.flight] : null,
        bk.address ? ["PICK-UP / DROP-OFF ADDRESS", bk.address] : null,
        ["LEAD PASSENGER", `${bk.passenger_name}   ·   ${bk.passenger_phone}`],
        ["EXTRAS", extras],
        ["BOOKED BY", agentName],
      ].filter(Boolean);

      doc.font("Helvetica").fontSize(10.5);
      const rowH = rows.map(([, val]) => Math.max(30, doc.heightOfString(val, { width: CW - 190 }) + 18));
      const cardH = rowH.reduce((a, c) => a + c, 0) + 8;
      doc.roundedRect(L, y, CW, cardH, 8).lineWidth(1).strokeColor(LINE).stroke();
      let ry = y + 4;
      rows.forEach(([lab, val], i) => {
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED).text(lab, L + 18, ry + 10, { characterSpacing: 1.2, width: 150 });
        doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(val, L + 172, ry + 8, { width: CW - 190 });
        ry += rowH[i];
        if (i < rows.length - 1) doc.moveTo(L + 18, ry).lineTo(R - 18, ry).lineWidth(0.5).strokeColor(LINE).stroke();
      });

      y += cardH + 18;
      doc.roundedRect(L, y, CW, 44, 8).fill(SOFT);
      doc.rect(L, y + 4, 3, 36).fill(GOLD);
      doc.font("Helvetica-Bold").fontSize(9).fillColor(GOLD_D).text("ALL CHARGES SETTLED WITH YOUR TRAVEL AGENT", L + 20, y + 12, { characterSpacing: 1 });
      doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
        .text("Nothing to pay the chauffeur.", L + 20, y + 26);

      y += 64;
      /* A long trip (return, three stops, a long address) can leave no room
         above the footer; the trip details matter more than the selling
         points, so those give way rather than run into the footer. */
      if (y + 92 + 40 < 841.89 - 74 - 8) {
        doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("INCLUDED WITH EVERY TRANSFER", L, y, { characterSpacing: 1.5 });
        y += 14;
        [
          "Meet & greet — your chauffeur waits at arrivals with a name board",
          "Flight tracking with 30 minutes' free airport waiting (60 min international at BNE)",
          "Private vehicle — never shared, never a shuttle",
          "24/7 dispatch on +61 481 437 772",
        ].forEach((t) => {
          doc.circle(L + 4, y + 5, 1.8).fill(GOLD);
          doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(t, L + 14, y, { width: CW - 14 });
          y += 16;
        });
      }

      y += 10;
      doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED)
        .text("Please show this voucher to your chauffeur. Any changes to your trip should go through the travel agent who made this booking.", L, y, { width: CW });

      const FY = 841.89 - 74;
      doc.rect(0, FY, W, 74).fill(NAVY);
      doc.rect(0, FY, W, 2).fill(GOLD);
      doc.font("Times-Roman").fontSize(13).fillColor(CREAM).text("SKY TRANSFERS", L, FY + 16, { characterSpacing: 3 });
      doc.font("Helvetica").fontSize(8.5).fillColor("#98A0B0")
        .text("24/7  ·  +61 481 437 772  ·  info@skytransfers.com.au  ·  www.skytransfers.com.au", L, FY + 36);
      doc.font("Helvetica").fontSize(8.5).fillColor(GOLD_LT)
        .text(`Ref ${bk.ref}`, L, FY + 16, { width: CW, align: "right" });

      doc.end();
    });
  }

  /* A GET so the browser can save it straight to disk; the token rides in the
     query string because a download navigation cannot carry a header. */
  app.get("/agent/booking/voucher", requireAgent, async (req, res) => {
    try {
      const found = await loadOwnBooking(req, String(req.query.ref || ""), { forChange: false });
      if (found.error) return res.status(found.code).json({ error: found.error });
      const pdf = await voucherPdf(found.booking, req.agent.name);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="SkyTransfers-${found.booking.ref}.pdf"`);
      res.send(pdf);
    } catch (err) {
      console.error("voucher:", err);
      res.status(500).json({ error: "Could not build that voucher." });
    }
  });

  /* ---- the agent's own view -------------------------------------------- */
  const bookingRow = (r) => ({
    ref: r.ref,
    pickup: r.pickup,
    dropoff: r.dropoff,
    route: `${r.pickup} → ${r.dropoff}`,
    vehicle: r.vehicle,
    date: r.pickup_date instanceof Date ? r.pickup_date.toISOString().slice(0, 10) : r.pickup_date,
    time: r.pickup_time,
    passenger: r.passenger_name,
    phone: r.passenger_phone,
    email: r.passenger_email,
    flight: r.flight,
    address: r.address,
    notes: r.notes,
    pax: r.pax,
    childSeats: r.child_seats,
    trailer: r.trailer,
    total: r.total_cents / 100,
    commission: r.commission_cents / 100,
    status: r.status,
    settled: r.settled,
    clientRef: r.client_ref || "",
    returnDate: r.return_date instanceof Date ? r.return_date.toISOString().slice(0, 10) : (r.return_date || null),
    returnTime: r.return_time || null,
    returnFlight: r.return_flight || "",
    hours: r.hire_hours || null,
    ends: (() => { try { return r.ends ? JSON.parse(r.ends) : null; } catch (e) { return null; } })(),
    ...(() => {
      try { const j = r.stops ? JSON.parse(r.stops) : null; return { stops: j && Array.isArray(j.list) ? j.list : [], stopsExtra: j && j.extra || 0 }; }
      catch (e) { return { stops: [], stopsExtra: 0 }; }
    })(),
  });

  /* Trip status per leg, from guest-updates.js (mounted later, so it is
     handed in). Without it the bookings list simply has no status column. */
  let tripStatus = null;
  const setTripStatus = (fn) => { tripStatus = typeof fn === "function" ? fn : null; };

  app.get("/agent/summary", requireAgent, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM agent_bookings WHERE agent_code = $1 ORDER BY created_at DESC LIMIT 200`,
        [req.agent.code]);
      let trips = {};
      if (tripStatus) {
        const want = rows.filter((r) => r.status === "confirmed").map((r) => { const b = bookingRow(r); return { ref: b.ref, date: b.date, returnDate: b.returnDate }; });
        trips = await tripStatus(want).catch((e) => { console.error("agent trip status:", e.message); return {}; });
      }
      /* The wallet is derived, never stored — a stored balance is one failed
         write away from disagreeing with the bookings that justify it. */
      const live = rows.filter((r) => r.status === "confirmed");
      const earned = live.reduce((n, r) => n + r.commission_cents, 0);
      const paid = live.filter((r) => r.settled).reduce((n, r) => n + r.commission_cents, 0);
      res.json({
        agent: { code: req.agent.code, name: req.agent.name, commissionPct: agentPct(req.agent) },
        wallet: { earned: earned / 100, paid: paid / 100, balance: (earned - paid) / 100 },
        changeCutoffHours: CHANGE_CUTOFF_HOURS,
        bookings: rows.map((r) => {
          const b = bookingRow(r);
          const h = hoursUntil(b.date, b.time);
          b.changeable = r.status === "confirmed" && h != null && h >= CHANGE_CUTOFF_HOURS;
          b.trip = trips[b.ref] || null;
          return b;
        }),
      });
    } catch (err) {
      console.error("agent summary:", err);
      res.status(500).json({ error: "Could not load your bookings just now." });
    }
  });

  /* ---- admin ------------------------------------------------------------ */
  app.get("/admin/agents", requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT a.code, a.name, a.email, a.commission_pct, a.active, a.created_at,
               COALESCE(SUM(CASE WHEN b.status='confirmed' THEN b.commission_cents END), 0)                        AS earned_cents,
               COALESCE(SUM(CASE WHEN b.status='confirmed' AND b.settled THEN b.commission_cents END), 0)          AS paid_cents,
               COUNT(b.ref) FILTER (WHERE b.status='confirmed')                                                    AS trips,
               COALESCE(SUM(CASE WHEN b.status='confirmed' THEN b.total_cents END), 0)                             AS gross_cents
          FROM agents a
          LEFT JOIN agent_bookings b ON b.agent_code = a.code
         GROUP BY a.code
         ORDER BY a.name`);
      res.json({
        agents: rows.map((r) => ({
          code: r.code, name: r.name, email: r.email,
          commissionPct: Number(r.commission_pct), active: r.active,
          trips: Number(r.trips),
          gross: Number(r.gross_cents) / 100,
          earned: Number(r.earned_cents) / 100,
          paid: Number(r.paid_cents) / 100,
          owing: (Number(r.earned_cents) - Number(r.paid_cents)) / 100,
        })),
      });
    } catch (err) {
      console.error("admin agents:", err);
      res.status(500).json({ error: "Could not load the agent list." });
    }
  });

  /* ---- web bookings -----------------------------------------------------
     Bookings made on the public website, as opposed to agent bookings. Until
     now these existed only as two emails: nothing was stored anywhere, so
     "how many requests turned into payments" could not be answered at all.

     Every caller treats this as fire-and-forget. A database hiccup must never
     stop a booking email going out - the email is still the path the business
     actually runs on, and this is a record of it, not a replacement for it.
     --------------------------------------------------------------------- */
  const WEB_STATUSES = ["requested", "confirmed", "declined", "paid", "cancelled"];

  /* Stops along the way are kept as JSON: {list:[{address,suburb,lat,lng}],
     extra, km}. extra is the dollars charged for them when the booking was
     priced, so a resend or an amendment shows the same figure. */
  const stopsJson = (b) => (Array.isArray(b && b.stops) && b.stops.length)
    ? JSON.stringify({ list: b.stops.slice(0, 3).map((s) => ({ address: String(s.address || s.suburb || "").slice(0, 200), suburb: s.suburb || "", lat: s.lat != null ? s.lat : null, lng: s.lng != null ? s.lng : null })),
                       extra: Math.round(Number(b.stopsExtra) || 0), km: b.stopsKm != null ? b.stopsKm : null })
    : null;
  function stopsOf(r) {
    try { const j = r && r.stops ? JSON.parse(r.stops) : null; return j && Array.isArray(j.list) && j.list.length ? j : null; }
    catch (e) { return null; }
  }

  const webRow = (r) => ({
    ref: r.ref, created: r.created_at,
    date: r.pickup_date, time: r.pickup_time,
    pickup: r.pickup, dropoff: r.dropoff, vehicle: r.vehicle,
    name: r.passenger_name, phone: r.passenger_phone, email: r.passenger_email,
    flight: r.flight, address: r.address, notes: r.notes,
    pax: r.pax, childSeats: r.child_seats, trailer: r.trailer,
    returnDate: r.return_date, returnTime: r.return_time, returnFlight: r.return_flight,
    hours: r.hire_hours || null,
    /* Plain text dates for the amend form; the Date objects above can slide a day in JSON. */
    dateText: r.pickup_date_text || null, returnDateText: r.return_date_text || null,
    total: r.total_cents / 100, status: r.status,
    confirmedAt: r.confirmed_at, declinedAt: r.declined_at, paidAt: r.paid_at,
    stops: (stopsOf(r) || { list: [] }).list.map((s) => s.address),
    cancelledAt: r.cancelled_at || null, refunded: (r.refunded_cents || 0) / 100, cancelNote: r.cancel_note || "",
    balance: (r.balance_cents || 0) / 100,
  });

  async function saveWebBooking(b, s, status) {
    if (!AGENTS_ON || !pool) return;
    if (!WEB_STATUSES.includes(status)) throw new Error("bad web booking status: " + status);
    const ref = String((b && b.ref) || "").trim();
    if (!ref) return;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String((b && b.date) || "")) ? b.date : null;
    const cents = Math.round(Number((s && s.total) || 0) * 100);
    await pool.query(
      `INSERT INTO web_bookings
         (ref, pickup, dropoff, vehicle, pickup_date, pickup_time, passenger_name,
          passenger_phone, passenger_email, flight, address, notes, pax, child_seats,
          trailer, total_cents, status, user_agent, return_date, return_time, return_flight,
          payment_intent, hire_hours, stops, confirmed_at, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
               CASE WHEN $17 IN ('confirmed','paid') THEN now() END,
               CASE WHEN $17 = 'paid' THEN now() END)
       ON CONFLICT (ref) DO UPDATE SET
         /* Never walk a booking backwards. The webhook and a later re-save can
            arrive in either order, and paid is the end of the line - as is
            cancelled, which only the office's Cancel button sets. */
         status       = CASE WHEN web_bookings.status IN ('paid', 'cancelled') THEN web_bookings.status
                             ELSE EXCLUDED.status END,
         stops        = COALESCE(web_bookings.stops, EXCLUDED.stops),
         total_cents  = GREATEST(web_bookings.total_cents, EXCLUDED.total_cents),
         confirmed_at = COALESCE(web_bookings.confirmed_at, EXCLUDED.confirmed_at),
         paid_at      = COALESCE(web_bookings.paid_at, EXCLUDED.paid_at),
         payment_intent = COALESCE(web_bookings.payment_intent, EXCLUDED.payment_intent)`,
      [ref, b.pickup || null, b.dropoff || null, b.vehicle || null, date, b.time || null,
       b.name || null, b.phone || null, b.email || null, b.flight || null,
       b.address || null, b.notes || null,
       parseInt(b.pax, 10) || 1, parseInt(b.childSeats, 10) || 0,
       b.trailer === true || b.trailer === "true",
       cents, status, String(b.userAgent || "").slice(0, 300) || null,
       /* Null, not an empty string: the column is a DATE and "" will not cast. */
       /^\d{4}-\d{2}-\d{2}$/.test(String((b && b.returnDate) || "")) ? b.returnDate : null,
       String((b && b.returnTime) || "").trim() || null,
       String((b && b.returnFlight) || "").trim().slice(0, 40) || null,
       String((b && b.paymentIntent) || "").trim() || null,
       hoursOf(b), stopsJson(b)]
    );
    /* Paid means the link has done its job. Switching it off stops a second
       payment and stops a forwarded link being payable by anyone else. */
    if (status === "paid") {
      deactivatePaymentLink(ref).catch((e) => console.error("deactivate link:", e.message));
    }
  }

  /* ---- one-click confirm from the dispatch email ------------------------
     The office gets a booking request by email and decides yes or no. Until
     now that decision was a human writing a separate email with a payment
     link in it, and only about half of those links were ever paid.

     The token carries nothing but a reference and an expiry. Stage 1 put the
     booking in the database, so the handler loads the real row rather than
     trusting anything in the URL - a tampered link cannot change a price or
     an address, because neither travels in it.

     GET renders a page. POST does the work. That split is the whole point:
     mail scanners and clients routinely fetch links in messages before a
     person opens them, and a GET that acted would let a scanner confirm
     bookings and email payment demands at guests with nobody deciding.
     --------------------------------------------------------------------- */
  const ACTION_BASE = String(process.env.PUBLIC_SERVER_URL ||
    "https://sky-transfers-booking-server.onrender.com").replace(/\/+$/, "");
  const ACTION_TTL_MS = 30 * 24 * 3600 * 1000;

  function signAction(ref, act) {
    const body = Buffer.from(JSON.stringify({ ref, act, exp: Date.now() + ACTION_TTL_MS })).toString("base64url");
    const sig = crypto.createHmac("sha256", AGENT_SECRET).update(body).digest("base64url");
    return `${body}.${sig}`;
  }
  function readAction(token) {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;
    const want = crypto.createHmac("sha256", AGENT_SECRET).update(body).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const claim = JSON.parse(Buffer.from(body, "base64url").toString());
      if (!claim || !claim.ref || claim.exp <= Date.now()) return null;
      if (claim.act !== "approve" && claim.act !== "decline") return null;
      return claim;
    } catch (e) { return null; }
  }
  function actionLinks(ref) {
    if (!AGENTS_ON || !ref) return null;
    return {
      approve: ACTION_BASE + "/booking/action?t=" + encodeURIComponent(signAction(ref, "approve")),
      decline: ACTION_BASE + "/booking/action?t=" + encodeURIComponent(signAction(ref, "decline")),
    };
  }

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function actionPage(title, inner, code) {
    return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} &mdash; Sky Transfers</title><style>
body{margin:0;background:#F7F4ED;color:#333B4C;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.w{max-width:540px;margin:0 auto;padding:40px 20px}
.c{background:#fff;border:1px solid #E5E0D2;border-radius:14px;padding:28px}
h1{font:400 26px/1.3 Georgia,"Times New Roman",serif;color:#141D30;margin:0 0 16px}
dl{margin:0 0 24px;display:grid;grid-template-columns:auto 1fr;gap:7px 18px;font-size:15px}
dt{color:#68707F}dd{margin:0;font-weight:600;color:#141D30}
button{font:600 16px/1 inherit;padding:16px 26px;border:0;border-radius:9px;cursor:pointer;width:100%}
.go{background:#C9A227;color:#141D30}.no{background:#141D30;color:#F6F2E8}
.muted{color:#68707F;font-size:14px}a{color:#6F5510}
</style></head><body><div class="w"><div class="c">${inner}</div></div></body></html>`;
  }
  const DASH = '<p class="muted" style="margin:18px 0 0"><a href="https://www.skytransfers.com.au/admin.html">Open the office dashboard</a></p>';

  async function findOpenWebBooking(q) {
    /* Has this guest already got a reference for this exact trip? Looked up
       server-side on purpose: the reference is never read from a request body,
       so a caller cannot supply one and overwrite somebody else's row. */
    if (!AGENTS_ON || !pool || !q || !q.email) return null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(q.date || "")) ? q.date : null;
    const { rows } = await pool.query(
      `SELECT ref FROM web_bookings
        WHERE status IN ('requested', 'confirmed')
          AND lower(passenger_email) = lower($1)
          AND pickup = $2 AND dropoff = $3
          AND pickup_date IS NOT DISTINCT FROM $4::date
          AND COALESCE(pickup_time, '') = COALESCE($5, '')
          AND created_at > now() - interval '60 days'
        ORDER BY created_at DESC LIMIT 1`,
      [q.email, q.pickup || null, q.dropoff || null, date, q.time || ""]);
    return rows[0] ? rows[0].ref : null;
  }

  async function getWebBooking(ref) {
    /* to_char, not the DATE itself: node-postgres hands back a Date at local
       midnight and toISOString() can then slide it a day. */
    const { rows } = await pool.query(
      `SELECT *, to_char(pickup_date, 'YYYY-MM-DD') AS pickup_date_text,
                 to_char(return_date, 'YYYY-MM-DD') AS return_date_text
         FROM web_bookings WHERE ref = $1`, [ref]);
    return rows[0] || null;
  }
  async function setWebStatus(ref, status) {
    await pool.query(
      `UPDATE web_bookings SET
         status       = $2,
         confirmed_at = CASE WHEN $2 = 'confirmed' THEN COALESCE(confirmed_at, now()) ELSE confirmed_at END,
         declined_at  = CASE WHEN $2 = 'declined'  THEN COALESCE(declined_at,  now()) ELSE declined_at  END
       WHERE ref = $1 AND status NOT IN ('paid', 'cancelled')`, [ref, status]);
  }
  const rowMoney = (r) => "$" + (r.total_cents / 100).toFixed(0);
  function rowLines(r) {
    return [
      `Booking reference: ${r.ref}`,
      `Route: ${r.pickup} -> ${r.dropoff}`,
      `When: ${r.pickup_date_text || "-"} ${r.pickup_time || ""}`.trim(),
      `Vehicle: ${r.vehicle}`,
      `Passengers: ${r.pax}`,
      r.child_seats ? `Child seats: ${r.child_seats}` : null,
      r.trailer ? "Luggage trailer: yes" : null,
      r.flight ? `Flight: ${r.flight}` : null,
      r.address ? `Pick-up address: ${r.address}` : null,
      `TOTAL: ${rowMoney(r)}`,
    ].filter(Boolean).join("\n");
  }
  function rowDl(r) {
    return `<dl>
<dt>Reference</dt><dd>${esc(r.ref)}</dd>
<dt>Passenger</dt><dd>${esc(r.passenger_name)}</dd>
<dt>Route</dt><dd>${esc(r.pickup)} &rarr; ${esc(r.dropoff)}</dd>
<dt>When</dt><dd>${esc(r.pickup_date_text || "-")} ${esc(r.pickup_time || "")}</dd>
<dt>Vehicle</dt><dd>${esc(r.vehicle)}</dd>
<dt>Total</dt><dd>${esc(rowMoney(r))}</dd>
</dl>`;
  }

  /* ---- the payment link ---------------------------------------------------
     A Stripe Checkout Session dies 24 hours after it is created - measured on
     this account, all 38 of them had exactly a 24.0 hour life, and 24 hours is
     also Stripe's maximum. A guest who slept on it came back to a dead link
     and had to ask for another one.

     A Payment Link has no expiry field at all, only an `active` flag, so it is
     still there on Thursday. Stripe copies the link's metadata onto the
     Checkout Session it creates, so the existing webhook reads exactly what it
     read before and needs no change.

     The link is stored on the booking: pressing Confirm twice re-sends the
     same URL rather than minting a second way to pay, and once the webhook
     reports payment the link is switched off so it cannot be paid again or
     forwarded to somebody else.
     --------------------------------------------------------------------- */
  async function createPaymentLinkFor(r) {
    const price = await stripe.prices.create({
      currency: "aud",
      unit_amount: r.total_cents,
      product_data: { name: `Transfer — ${r.pickup} to ${r.dropoff}` },
    }, { idempotencyKey: "price-" + r.ref + "-" + (r.link_seq || 0) });

    const link = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      /* Copied onto the Checkout Session by Stripe, which is what the
         /stripe-webhook handler reads. Same keys it has always read. */
      metadata: {
        ref: r.ref, pickup: String(r.pickup || ""), dropoff: String(r.dropoff || ""),
        vehicle: String(r.vehicle || ""), date: String(r.pickup_date_text || ""),
        time: String(r.pickup_time || ""), pax: String(r.pax || ""),
        flight: String(r.flight || ""), child_seats: String(r.child_seats || 0),
        trailer: r.trailer ? "yes" : "no",
        passenger_name: String(r.passenger_name || ""), phone: String(r.passenger_phone || ""),
        pickup_address: String(r.address || ""), notes: String(r.notes || "").slice(0, 450),
        /* The return leg. Without these the webhook printed a return booking
           as a one-way at the return price the moment the guest paid - found
           on ST-261024-9GCS, 13 Oct 2026. */
        return_date: String(r.return_date_text || ""), return_time: String(r.return_time || ""),
        return_flight: String(r.return_flight || "").slice(0, 40),
        hours: r.hire_hours ? String(r.hire_hours) : "",
      },
      after_completion: {
        type: "redirect",
        redirect: { url: process.env.SUCCESS_URL || "https://www.skytransfers.com.au/?booking=confirmed" },
      },
      inactive_message: "This booking has already been paid. If you need anything, call or text +61 481 437 772.",
    }, { idempotencyKey: "plink-" + r.ref + "-" + (r.link_seq || 0) });

    await pool.query(
      `UPDATE web_bookings SET payment_link_id = $2, payment_link_url = $3 WHERE ref = $1`,
      [r.ref, link.id, link.url]);
    return link.url;
  }

  async function paymentUrlFor(r) {
    /* client_reference_id rides in the query string and Stripe puts it on the
       Checkout Session, so the booking is identifiable even if metadata ever
       stops being copied. */
    const base = r.payment_link_url || await createPaymentLinkFor(r);
    return base + (base.indexOf("?") === -1 ? "?" : "&") +
           "client_reference_id=" + encodeURIComponent(r.ref);
  }

  /* The PaymentIntent a paid booking was charged on. Rows saved since the
     column existed carry it; older ones are found through Stripe - by the
     payment link the office sent, or by the reference Checkout stamped on the
     session - and the answer is written back so it is only looked up once. */
  async function findPaymentIntent(r) {
    if (r.payment_intent) return r.payment_intent;
    if (!stripe) return null;
    const piOf = (sess) => (sess && sess.payment_status === "paid")
      ? (typeof sess.payment_intent === "string" ? sess.payment_intent : (sess.payment_intent && sess.payment_intent.id) || null) : null;
    let pi = null;
    if (r.payment_link_id) {
      const { data } = await stripe.checkout.sessions.list({ payment_link: r.payment_link_id, limit: 10 });
      pi = (data || []).map(piOf).find(Boolean) || null;
    }
    if (!pi) {
      const { data } = await stripe.checkout.sessions.list({ limit: 100 });
      const hit = (data || []).find((x) => (x.client_reference_id === r.ref || (x.metadata && x.metadata.ref === r.ref)) && piOf(x));
      pi = hit ? piOf(hit) : null;
    }
    if (pi) await pool.query(`UPDATE web_bookings SET payment_intent = $2 WHERE ref = $1`, [r.ref, pi]);
    return pi;
  }

  /* A link for the unpaid difference after a paid booking grew. The webhook
     recognises balance_for and settles it instead of treating it as a new
     booking. */
  async function createBalanceLinkFor(r, cents) {
    const seq = (r.link_seq || 0) + 1;
    const price = await stripe.prices.create({
      currency: "aud", unit_amount: cents,
      product_data: { name: `Balance for booking ${r.ref} — change to your transfer` },
    }, { idempotencyKey: "balprice-" + r.ref + "-" + seq });
    const link = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: { ref: r.ref, balance_for: r.ref, passenger_name: String(r.passenger_name || ""), balance_cents: String(cents) },
      after_completion: { type: "redirect", redirect: { url: process.env.SUCCESS_URL || "https://www.skytransfers.com.au/?booking=confirmed" } },
      inactive_message: "This balance has already been settled. If you need anything, call or text +61 481 437 772.",
    }, { idempotencyKey: "ballink-" + r.ref + "-" + seq });
    await pool.query(
      `UPDATE web_bookings SET balance_cents = $2, balance_link_id = $3, balance_link_url = $4, link_seq = $5 WHERE ref = $1`,
      [r.ref, cents, link.id, link.url, seq]);
    return link.url + "?client_reference_id=" + encodeURIComponent(r.ref);
  }

  /* The balance link was paid: clear it, switch the link off. */
  async function settleBalance(ref) {
    const r = await getWebBooking(ref);
    if (!r) return null;
    await pool.query(`UPDATE web_bookings SET balance_cents = 0, balance_link_id = NULL, balance_link_url = NULL WHERE ref = $1`, [ref]);
    if (r.balance_link_id && stripe) {
      await stripe.paymentLinks.update(r.balance_link_id, { active: false }).catch((e) => console.error("settle balance link:", e.message));
    }
    return getWebBooking(ref);
  }

  async function deactivatePaymentLink(ref) {
    if (!stripe || !pool) return;
    const { rows } = await pool.query(`SELECT payment_link_id FROM web_bookings WHERE ref = $1`, [ref]);
    const id = rows[0] && rows[0].payment_link_id;
    if (!id) return;
    await stripe.paymentLinks.update(id, { active: false });
  }

  app.get("/booking/action", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!AGENTS_ON) return res.status(503).send(actionPage("Unavailable", "<h1>Not configured</h1>"));
      const claim = readAction(req.query.t);
      if (!claim) return res.status(400).send(actionPage("Link expired",
        `<h1>That link has expired</h1><p>Confirm or decline this booking from the dashboard instead.</p>${DASH}`));
      const r = await getWebBooking(claim.ref);
      if (!r) return res.status(404).send(actionPage("Not found",
        `<h1>We don&rsquo;t have that booking</h1><p class="muted">Reference ${esc(claim.ref)}.</p>${DASH}`));
      if (r.status === "paid") return res.send(actionPage("Already paid",
        `<h1>Already paid</h1>${rowDl(r)}<p>Nothing to do &mdash; this one is settled.</p>${DASH}`));
      if (r.status === "cancelled") return res.send(actionPage("Cancelled",
        `<h1>This booking was cancelled</h1>${rowDl(r)}<p>Nothing to do.</p>${DASH}`));

      const approving = claim.act === "approve";
      const already = approving && r.status === "confirmed";
      const head = approving
        ? (already ? "<h1>Already confirmed</h1><p>Send the payment link again?</p>"
                   : "<h1>Confirm this booking?</h1><p>The guest is emailed a confirmation and a payment link the moment you press the button.</p>")
        : "<h1>Turn this booking down?</h1><p>The guest gets a short note. Nothing is charged.</p>";
      return res.send(actionPage(approving ? "Confirm booking" : "Decline booking",
        `${head}${rowDl(r)}
<form method="POST" action="/booking/action">
  <input type="hidden" name="t" value="${esc(req.query.t)}">
  <button class="${approving ? "go" : "no"}" type="submit">${
    approving ? (already ? "Send the payment link again" : "Yes &mdash; confirm and send the link")
              : "Yes &mdash; turn it down"}</button>
</form>
<p class="muted" style="margin:16px 0 0">Current status: ${esc(r.status)}.</p>${DASH}`));
    } catch (err) {
      console.error("booking action page:", err);
      res.status(500).send(actionPage("Something went wrong", "<h1>Something went wrong</h1>" + DASH));
    }
  });

  app.post("/booking/action", require("express").urlencoded({ extended: false }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!AGENTS_ON) return res.status(503).send(actionPage("Unavailable", "<h1>Not configured</h1>"));
      const claim = readAction((req.body && req.body.t) || req.query.t);
      if (!claim) return res.status(400).send(actionPage("Link expired",
        `<h1>That link has expired</h1>${DASH}`));
      const r = await getWebBooking(claim.ref);
      if (!r) return res.status(404).send(actionPage("Not found", `<h1>We don&rsquo;t have that booking</h1>${DASH}`));
      if (r.status === "paid") return res.send(actionPage("Already paid",
        `<h1>Already paid</h1>${rowDl(r)}${DASH}`));
      if (r.status === "cancelled") return res.send(actionPage("Cancelled",
        `<h1>This booking was cancelled</h1>${rowDl(r)}${DASH}`));

      if (claim.act === "decline") {
        await setWebStatus(r.ref, "declined");
        if (mailer && r.passenger_email) {
          await mailer.sendMail({
            from: `"Sky Transfers" <${process.env.GMAIL_USER}>`,
            to: r.passenger_email, replyTo: BOOKINGS_EMAIL,
            subject: `About your transfer request — Sky Transfers · ${r.ref}`,
            text: `Hi ${r.passenger_name},\n\nSorry — we can't cover this one. Nothing has been charged.\n\n` +
                  `If the timing is flexible, call or text +61 481 437 772 and we'll see what we can do.\n\n` +
                  `Sky Transfers\nwww.skytransfers.com.au`,
          });
        }
        return res.send(actionPage("Declined",
          `<h1>Turned down</h1>${rowDl(r)}<p>${r.passenger_email ? "The guest has been told." : "No email address on file, so nobody was told."}</p>${DASH}`));
      }

      if (!stripe) return res.status(503).send(actionPage("Payments off",
        `<h1>Payments are not configured</h1><p>The booking is unchanged.</p>${DASH}`));

      const payUrl = await paymentUrlFor(r);

      await setWebStatus(r.ref, "confirmed");

      if (mailer && r.passenger_email) {
        await mailer.sendMail({
          from: `"Sky Transfers" <${process.env.GMAIL_USER}>`,
          to: r.passenger_email, replyTo: BOOKINGS_EMAIL,
          subject: `Booking confirmed — Sky Transfers · ${r.ref}`,
          text: `Hi ${r.passenger_name},\n\nGood news — your transfer is confirmed. Your chauffeur is booked.\n\n` +
                `${rowLines(r)}\n\nTo secure it, pay here:\n${payUrl}\n\n` +
                `We track your flight and your chauffeur meets you with a name board. Free changes up to 24 hours ` +
                `before pick-up — reply to this email or call +61 481 437 772.\n\n` +
                `Sky Transfers — Gold Coast & Brisbane airport transfers\nwww.skytransfers.com.au`,
          html: `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#333B4C;max-width:540px">
<h1 style="font:400 26px/1.3 Georgia,serif;color:#141D30;margin:0 0 14px">Your transfer is confirmed</h1>
<p style="margin:0 0 20px">Hi ${esc(r.passenger_name)}, your chauffeur is booked. Pay below to secure it.</p>
<p style="margin:0 0 24px"><a href="${esc(payUrl)}" style="display:inline-block;background:#C9A227;color:#141D30;font-weight:700;text-decoration:none;padding:15px 28px;border-radius:9px">Pay ${esc(rowMoney(r))} now</a></p>
<pre style="font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;background:#F7F4ED;border:1px solid #E5E0D2;border-radius:10px;padding:16px;white-space:pre-wrap;margin:0">${esc(rowLines(r))}</pre>
<p style="margin:18px 0 0;font-size:14px;color:#68707F">Free changes up to 24 hours before pick-up &mdash; reply to this email or call +61 481 437 772.</p></div>`,
        });
      }
      if (mailer) {
        await mailer.sendMail({
          from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`,
          to: BOOKINGS_EMAIL, replyTo: r.passenger_email || undefined,
          subject: `CONFIRMED, awaiting payment: ${r.pickup} -> ${r.dropoff} [${r.ref}]`,
          text: `Confirmed from the dispatch email. The guest has the payment link.\n\n${rowLines(r)}\n\n${payUrl}\n`,
        });
      }
      return res.send(actionPage("Confirmed",
        `<h1>Confirmed</h1>${rowDl(r)}<p>${r.passenger_email
          ? "The guest has the confirmation and the payment link."
          : "No email address on file, so no link could be sent."}</p>${DASH}`));
    } catch (err) {
      console.error("booking action:", err);
      res.status(500).send(actionPage("Something went wrong",
        `<h1>Something went wrong</h1><p class="muted">The booking has not been changed.</p>${DASH}`));
    }
  });

  /* ---- the office books for a guest, or sends a confirmation again --------
     Both reuse the website's own summary, email and PDF, handed in from
     stripe-server.js, so a guest cannot tell which door the booking came in
     through. Admin bookings skip the six-hour rule on purpose: the office
     knows what is free right now, which is the whole point of the phone. */
  const HUBS = new Set(HUB_NAMES || []);
  const PRICED_PLACES = new Set(PLACES_FOR_AGENTS || []);
  const isoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "";
  const hhmm = (v) => /^\d{1,2}:\d{2}/.test(String(v || "")) ? String(v).slice(0, 5) : "";

  app.get("/admin/places", requireAdmin, (req, res) => {
    res.json({ places: PLACES_FOR_AGENTS, vehicles: VEHICLES });
  });

  /* A web_bookings row in the shape the website's email and PDF expect. */
  function rowToBooking(r) {
    return {
      ref: r.ref, pickup: r.pickup, dropoff: r.dropoff, vehicle: r.vehicle,
      date: r.pickup_date_text || "", time: r.pickup_time || "",
      pax: r.pax, flight: r.flight || "", childSeats: r.child_seats || 0,
      trailer: !!r.trailer, name: r.passenger_name, phone: r.passenger_phone,
      email: r.passenger_email || "", address: r.address || "", notes: r.notes || "",
      returnDate: r.return_date_text || "", returnTime: r.return_time || "",
      returnFlight: r.return_flight || "",
      hourly: r.hire_hours ? { hours: r.hire_hours } : undefined,
      paid: r.status === "paid", confirmed: r.status === "confirmed" || r.status === "paid",
      ...(() => { const j = stopsOf(r); return j ? { stops: j.list, stopsExtra: j.extra || 0, stopsKm: j.km } : {}; })(),
    };
  }
  const balanceUrlFor = (r) => (r.balance_cents > 0 && r.balance_link_url)
    ? r.balance_link_url + (r.balance_link_url.indexOf("?") === -1 ? "?" : "&") + "client_reference_id=" + encodeURIComponent(r.ref)
    : null;

  /* The summary for a stored row. The total is the row's figure - the agreed
     price, or what Stripe charged - never a recomputation, so the fare lines
     are stripped exactly as the webhook strips them. */
  function summaryForRow(r, b) {
    const total = Math.round((r.total_cents || 0) / 100);
    const ret = returnLeg(b);
    const text = bookingSummary(b, 0, b.childSeats, b.trailer, ret).text
      .replace(/Fare: \$0 one-way\n/, "")
      .replace(/^Return fare: .*\n/m, "")
      .replace(/TOTAL: \$\d+/, "TOTAL: $" + total + (b.paid ? " (PAID)" : ""));
    const s = { total, isReturn: !!ret, text };
    /* A paid booking that was amended upwards carries the unpaid difference. */
    if (b.paid && r.balance_cents > 0) {
      s.balance = Math.round(r.balance_cents / 100);
      s.text = s.text.replace(/\(PAID\)/, "(paid $" + (total - s.balance) + ", balance $" + s.balance + " to pay)");
    }
    return s;
  }

  async function emailGuestConfirmation(b, s, payUrl) {
    const pdf = await bookingPdf(b, s).catch((e) => { console.error("PDF failed:", e.message); return null; });
    const subject = s.balance ? `Booking updated — $${s.balance} balance to pay — Sky Transfers · ${b.ref}`
                  : s.refund ? `Booking updated — $${s.refund} refunded — Sky Transfers · ${b.ref}`
                  : b.paid ? `Booking confirmed & paid — Sky Transfers · ${b.ref}`
                  : b.confirmed ? `Booking confirmed — Sky Transfers · ${b.ref}`
                  : `Booking request received — Sky Transfers · ${b.ref}`;
    const opening = s.balance
      ? `Your booking has been updated. Your earlier payment of $${s.total - s.balance} is held against it, and the $${s.balance} difference can be paid securely here:\n${payUrl || ""}\n\nYour updated confirmation is attached.`
      : s.refund
      ? `Your booking has been updated, and $${s.refund} has been refunded to the card you paid with - it usually shows within 5 to 10 business days. Your updated confirmation is attached.`
      : b.paid
      ? "Your transfer is confirmed and paid. Your printable confirmation is attached."
      : b.confirmed
        ? "Your transfer is confirmed and your chauffeur is booked. Your printable confirmation is attached" +
          (payUrl ? `, and you can pay securely here to secure it:\n${payUrl}` : ".")
        : "Thanks for your booking request. We'll reply shortly, usually within the hour, to confirm your chauffeur.";
    await mailer.sendMail({
      from: `"Sky Transfers" <${process.env.GMAIL_USER}>`,
      to: b.email, replyTo: BOOKINGS_EMAIL, subject,
      text: `Hi ${b.name},\n\n${opening}\n\n${s.text}\n\n` +
            `We track your flight and your chauffeur meets you with a name board. Free changes to 24 hours ` +
            `before pick-up: reply to this email or call +61 481 437 772.\n\n` +
            `Sky Transfers — Gold Coast & Brisbane airport transfers\nwww.skytransfers.com.au`,
      html: bookingEmailHtml(b, payUrl ? { ...s, payUrl } : s),
      attachments: guestAttachments(pdf),
    });
  }

  /* The office form, parsed, validated and priced - shared by create and
     amend so the two can never disagree about what a valid booking is.
     Sends the refusal itself and returns null when the form is not usable. */
  async function parseOfficeBooking(b0, res) {
    const b = {
      pickup: String(b0.pickup || "").trim(), dropoff: String(b0.dropoff || "").trim(),
      vehicle: String(b0.vehicle || "").trim(), date: isoDate(b0.date), time: hhmm(b0.time),
      pax: Math.min(Math.max(parseInt(b0.pax, 10) || 1, 1), 53),
      flight: String(b0.flight || "").trim().slice(0, 40),
      childSeats: Math.min(Math.max(parseInt(b0.childSeats, 10) || 0, 0), 3),
      trailer: b0.trailer === true || b0.trailer === "true",
      name: String(b0.name || "").trim(), phone: String(b0.phone || "").trim(),
      email: String(b0.email || "").trim(), address: String(b0.address || "").trim(),
      notes: String(b0.notes || "").trim().slice(0, 450),
      returnDate: isoDate(b0.returnDate), returnTime: hhmm(b0.returnTime),
      returnFlight: String(b0.returnFlight || "").trim().slice(0, 40),
      /* Up to three stops along the way, each an address the office typed;
         priced by the extra distance in fareForBooking. */
      stops: (Array.isArray(b0.stops) ? b0.stops : [])
        .map((s) => (typeof s === "string" ? { address: s.trim() } : s))
        .filter((s) => s && String(s.address || "").trim().length >= 3).slice(0, 3)
        .map((s) => ({ address: String(s.address).trim().slice(0, 200), lat: s.lat != null ? s.lat : null, lng: s.lng != null ? s.lng : null })),
    };
    /* Every refusal is logged with its reason. A booking the office could not
       make is worth a line in the log even when nothing went wrong. */
    const refuse = (msg, code) => {
      console.log("office booking refused:", msg, "|", b.pickup || "-", "->", b.dropoff || "-", "|", b.vehicle || "-");
      res.status(code || 400).json({ error: msg });
      return null;
    };
    const missing = ["pickup", "dropoff", "vehicle", "date", "time", "name", "phone"].filter((f) => !b[f]);
    if (missing.length) return refuse("Please fill in: " + missing.join(", ") + ".");
    if (b.pickup === b.dropoff) return refuse("Pick-up and drop-off are the same place.");
    const ret = returnLeg(b);
    if (ret && (!ret.date || !ret.time)) return refuse("Please give both a date and a time for the return trip.");
    if (ret && (ret.date < b.date || (ret.date === b.date && ret.time <= b.time))) {
      return refuse("The return trip has to be after the outbound one.");
    }
    const override = Math.round(Number(b0.overrideTotal));
    const hasOverride = Number.isFinite(override) && override > 0;
    /* The two ends must be places we price - a suburb or airport from the
       list - unless the office is naming its own total. A street address
       belongs in the exact-address field, not here. */
    if (!hasOverride) {
      const unknown = [b.pickup, b.dropoff].filter((p) => !PRICED_PLACES.has(p));
      if (unknown.length) {
        return refuse(`"${unknown[0]}" is not in our priced places list. Pick-up and drop-off need to be a suburb or airport from the suggestions ` +
          `(start typing and choose one) - put the street address in the exact-address box. Or type the agreed total in the override box.`);
      }
    }

    /* Priced as the website prices it. Two suburbs with no airport between
       them are handed to the point-to-point engine by name, exactly as the
       form would send them. Whatever is still unpriced needs the override. */
    let fare = hasOverride ? null : await fareForBooking(b);
    if (fare == null && !hasOverride && !HUBS.has(b.pickup) && !HUBS.has(b.dropoff)) {
      fare = await fareForBooking({ ...b, p2p: {
        pickup: { suburb: b.pickup, address: b.pickup + ", QLD, Australia" },
        dropoff: { suburb: b.dropoff, address: b.dropoff + ", QLD, Australia" },
      } });
    }
    if (fare == null && !hasOverride) {
      return refuse("There is no online price for that route or vehicle — type the agreed total in the override box.");
    }
    return { b, ret, fare, override, hasOverride };
  }

  app.post("/admin/web-booking/create", requireAdmin, async (req, res) => {
    try {
      if (!mailer) return res.status(500).json({ error: "Email is not configured on the server." });
      const b0 = req.body || {};
      const parsed = await parseOfficeBooking(b0, res);
      if (!parsed) return;
      const { b, ret, fare, override, hasOverride } = parsed;
      const mode = b0.mode === "paid" ? "paid" : "link";
      if (mode === "link" && !stripe) {
        console.log("office booking refused: payments not configured |", b.pickup, "->", b.dropoff);
        return res.status(503).json({ error: "Payments are not configured, so no link can be sent. Choose 'paid elsewhere'." });
      }
      b.ref = makeRef(b.date);
      b.paid = mode === "paid";
      b.confirmed = true;
      const s = bookingSummary(b, hasOverride ? 0 : fare, b.childSeats, b.trailer, ret);
      if (hasOverride) s.total = override;
      const tag = b.paid ? " (PAID)" : hasOverride ? " (agreed price)" : "";
      s.text = s.text
        .replace(/Fare: \$0 one-way\n/, "")
        .replace(/^Return fare: \$0 .*\n/m, "")
        .replace(/TOTAL: \$\d+/, "TOTAL: $" + s.total + tag);

      await saveWebBooking({ ...b, userAgent: "office" }, s, b.paid ? "paid" : "confirmed");

      let payUrl = null;
      if (mode === "link") {
        const row = await getWebBooking(b.ref);
        payUrl = await paymentUrlFor(row);
      }
      let emailed = null;
      if (b.email) { await emailGuestConfirmation(b, s, payUrl); emailed = b.email; }
      mailer.sendMail({
        from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`,
        to: BOOKINGS_EMAIL, replyTo: b.email || undefined,
        subject: `OFFICE booking${b.paid ? " (paid elsewhere)" : ", payment link sent"}: ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time}) [${b.ref}]`,
        text: `OFFICE BOOKING — made from the admin page\n\n${s.text}\n` + (payUrl ? `\nPayment link: ${payUrl}\n` : ""),
      }).catch((e) => console.error("office booking copy:", e.message));
      console.log("office booking:", b.ref, mode, emailed ? "emailed" : "no guest email");
      res.json({ ok: true, ref: b.ref, total: s.total, emailed, payUrl });
    } catch (err) {
      console.error("office booking:", err);
      res.status(500).json({ error: "Could not make that booking." });
    }
  });

  app.post("/admin/web-booking/resend", requireAdmin, async (req, res) => {
    try {
      if (!mailer) return res.status(500).json({ error: "Email is not configured on the server." });
      const ref = String((req.body && req.body.ref) || "").trim();
      const r = ref ? await getWebBooking(ref) : null;
      if (!r) return res.status(404).json({ error: "No booking with that reference." });
      if (r.status === "declined") return res.status(409).json({ error: "That booking was declined — there is nothing to confirm." });
      if (r.status === "cancelled") return res.status(409).json({ error: "That booking was cancelled — there is nothing to confirm." });
      /* The office may send it somewhere other than the address on the
         booking - a corrected address, a travel agent, a second passenger.
         The booking's own record is not changed. */
      const to = String((req.body && req.body.to) || "").trim() || r.passenger_email || "";
      if (!to) return res.status(400).json({ error: "That booking has no email address — type one to send it to." });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "That doesn't look like an email address." });
      const b = rowToBooking(r);
      b.email = to;
      const s = summaryForRow(r, b);
      /* A link only for a confirmed, unpaid booking. A request that has not
         been confirmed yet gets its request receipt again, not a link - that
         decision belongs to the Confirm button in the dispatch email. */
      let payUrl = null;
      if (r.status === "confirmed" && stripe) {
        payUrl = await paymentUrlFor(r).catch((e) => { console.error("resend pay link:", e.message); return null; });
      }
      if (r.status === "paid") payUrl = balanceUrlFor(r);
      await emailGuestConfirmation(b, s, payUrl);
      console.log("confirmation resent:", ref, "->", to, to === r.passenger_email ? "" : "(not the booking's own address)");
      res.json({ ok: true, ref, to, payUrl });
    } catch (err) {
      console.error("resend confirmation:", err);
      res.status(500).json({ error: "Could not send that confirmation." });
    }
  });

  /* ---- amend a booking from the admin page --------------------------------
     Anything but the reference can change. The row gets its own UPDATE because
     saveWebBooking's ON CONFLICT deliberately never lowers a total or touches
     the trip fields. A confirmed booking's old payment link is switched off
     (with a message saying why) and a fresh one made for the new total, and
     the guest is sent the updated confirmation. Paid bookings are refused:
     money has moved, and that is a refund or a second charge, not an edit. */
  app.post("/admin/web-booking/amend", requireAdmin, async (req, res) => {
    try {
      if (!mailer) return res.status(500).json({ error: "Email is not configured on the server." });
      const b0 = req.body || {};
      const ref = String(b0.ref || "").trim();
      const r = ref ? await getWebBooking(ref) : null;
      if (!r) return res.status(404).json({ error: "No booking with that reference." });
      if (r.status === "cancelled") return res.status(409).json({ error: "That booking was cancelled — make a new booking instead." });
      const wasPaid = r.status === "paid";
      const manual = b0.manualMoney === true || b0.manualMoney === "true";
      const parsed = await parseOfficeBooking(b0, res);
      if (!parsed) return;
      const { b, ret, fare, override, hasOverride } = parsed;
      b.ref = ref;
      b.paid = wasPaid;
      b.confirmed = r.status === "confirmed" || wasPaid;
      const s = bookingSummary(b, hasOverride ? 0 : fare, b.childSeats, b.trailer, ret);
      if (hasOverride) s.total = override;
      s.text = s.text
        .replace(/Fare: \$0 one-way\n/, "")
        .replace(/^Return fare: \$0 .*\n/m, "")
        .replace(/TOTAL: \$\d+/, "TOTAL: $" + s.total + (wasPaid ? " (PAID)" : hasOverride ? " (agreed price)" : ""));
      const wasCents = r.total_cents || 0;
      const oldLink = wasPaid ? null : (r.payment_link_id || null);
      const newCents = Math.round(s.total * 100);
      /* What the guest has actually paid: the old total less any balance
         still outstanding from an earlier amendment. */
      const paidCents = wasPaid ? wasCents - (r.balance_cents || 0) : 0;
      const diff = wasPaid ? newCents - paidCents : 0;
      let refundId = null;
      if (wasPaid && diff < 0 && !manual) {
        if (!stripe) return res.status(503).json({ error: "Payments are not configured, so the difference cannot be refunded automatically.", needsManual: true });
        const pi = await findPaymentIntent(r).catch((e) => { console.error("amend: find payment:", e.message); return null; });
        if (!pi) {
          return res.status(409).json({ needsManual: true,
            error: `The card payment for ${ref} could not be found in Stripe, so the $${Math.round(-diff / 100)} difference cannot be refunded automatically. ` +
                   "Refund it from the Stripe dashboard, then save again with 'settle the money by hand' ticked." });
        }
        const refund = await stripe.refunds.create({ payment_intent: pi, amount: -diff, metadata: { ref, reason: "booking amended by office" } });
        refundId = refund.id;
        s.refund = Math.round(-diff / 100);
      }

      await pool.query(
        `UPDATE web_bookings SET
           pickup = $2, dropoff = $3, vehicle = $4, pickup_date = $5, pickup_time = $6,
           passenger_name = $7, passenger_phone = $8, passenger_email = $9, flight = $10,
           address = $11, notes = $12, pax = $13, child_seats = $14, trailer = $15,
           total_cents = $16, return_date = $17, return_time = $18, return_flight = $19,
           stops = $20, balance_cents = 0, balance_link_id = NULL, balance_link_url = NULL` +
        /* An unpaid booking's link is replaced; a paid one keeps its payment history. */
        (wasPaid ? "" : ", payment_link_id = NULL, payment_link_url = NULL, link_seq = link_seq + 1") +
        ` WHERE ref = $1`,
        [ref, b.pickup, b.dropoff, b.vehicle, b.date, b.time, b.name, b.phone, b.email || null,
         b.flight || null, b.address || null, b.notes || null, b.pax, b.childSeats, b.trailer,
         newCents, b.returnDate || null, b.returnTime || null, b.returnFlight || null, stopsJson(b)]);

      /* An earlier balance link, if any, is now wrong - switch it off. */
      if (r.balance_link_id && stripe) {
        await stripe.paymentLinks.update(r.balance_link_id, { active: false,
          inactive_message: "This booking has been updated again. Please use the link in your latest email, or call +61 481 437 772." })
          .catch((e) => console.error("amend: old balance link:", e.message));
      }
      if (oldLink && stripe) {
        await stripe.paymentLinks.update(oldLink, {
          active: false,
          inactive_message: "This booking has been updated. Please use the payment link in your latest email, or call +61 481 437 772.",
        }).catch((e) => console.error("amend: old link:", e.message));
      }
      let payUrl = null;
      if (wasPaid) {
        if (diff > 0 && !manual && stripe) {
          payUrl = await createBalanceLinkFor(await getWebBooking(ref), diff).catch((e) => { console.error("amend balance link:", e.message); return null; });
          if (payUrl) {
            s.balance = Math.round(diff / 100);
            s.text = s.text.replace(/\(PAID\)/, "(paid $" + Math.round(paidCents / 100) + ", balance $" + s.balance + " to pay)");
          }
        }
        if (manual && diff !== 0) s.text += "\nPrice change of $" + Math.round(Math.abs(diff) / 100) + " settled with the office.";
      } else if (b.confirmed && stripe) {
        payUrl = await paymentUrlFor(await getWebBooking(ref)).catch((e) => { console.error("amend pay link:", e.message); return null; });
      }
      /* A request that is not confirmed yet is not re-sent: confirming it is
         still the dispatch email's job, and that email carries the new figures. */
      let emailed = null;
      if (b.confirmed && b.email) { await emailGuestConfirmation(b, s, payUrl); emailed = b.email; }
      mailer.sendMail({
        from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`,
        to: BOOKINGS_EMAIL, replyTo: b.email || undefined,
        subject: `OFFICE amended: ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time}) [${ref}] now $${s.total}` +
                 (s.refund ? ` ($${s.refund} refunded)` : s.balance ? ` ($${s.balance} balance link sent)` : ""),
        text: `OFFICE AMENDMENT - changed from the admin page\nWas $${Math.round(wasCents / 100)}, now $${s.total}.\n` +
              (s.refund ? `Refunded $${s.refund} to the guest's card (Stripe ${refundId}).\n` : "") +
              (s.balance ? `Guest emailed a link for the $${s.balance} balance.\n` : "") +
              (wasPaid && manual && diff !== 0 ? `Money settled by hand: ${diff < 0 ? "refund" : "collect"} $${Math.round(Math.abs(diff) / 100)}.\n` : "") +
              `\n${s.text}\n` +
              (payUrl && !s.balance ? `\nNew payment link: ${payUrl}\n` : "") + (oldLink ? "The previous payment link has been switched off.\n" : ""),
      }).catch((e) => console.error("office amend copy:", e.message));
      console.log("office booking amended:", ref, "$" + Math.round(wasCents / 100), "->", "$" + s.total,
        s.refund ? "refunded $" + s.refund : s.balance ? "balance $" + s.balance : wasPaid && manual ? "manual money" : "", emailed ? "emailed" : "no guest email");
      res.json({ ok: true, ref, total: s.total, was: Math.round(wasCents / 100), emailed, payUrl, status: r.status,
                 refunded: s.refund || 0, balance: s.balance || 0, manual: wasPaid && manual && diff !== 0 });
    } catch (err) {
      console.error("office amend:", err);
      res.status(500).json({ error: "Could not change that booking." });
    }
  });

  /* ---- cancel a booking from the admin page -------------------------------
     The record is kept (status 'cancelled'), unlike Remove, so the history and
     any refund stay on file. The terms (section 4): more than 24 hours before
     pick-up, a full refund; within 24 hours a fee of up to the full fare may
     apply - so the office chooses the refund then (Aman, 19 Oct 2026), and the
     page suggests none. A refund goes back to the card through Stripe; an
     unpaid booking's payment links are switched off. The guest is emailed,
     the board drops the job (ops.js skips cancelled rows), and if a driver had
     already been sent it the office is told to let them know. */
  app.post("/admin/web-booking/cancel", requireAdmin, async (req, res) => {
    try {
      const b0 = req.body || {};
      const ref = String(b0.ref || "").trim();
      const r = ref ? await getWebBooking(ref) : null;
      if (!r) return res.status(404).json({ error: "No booking with that reference." });
      if (r.status === "cancelled") return res.status(409).json({ error: "That booking is already cancelled." });
      if (r.status === "declined") return res.status(409).json({ error: "That booking was declined - there is nothing to cancel." });
      const paid = r.status === "paid";
      const paidCents = paid ? Math.max(0, (r.total_cents || 0) - (r.balance_cents || 0)) : 0;
      const when = Date.parse(`${r.pickup_date_text || ""}T${String(r.pickup_time || "00:00").slice(0, 5)}:00+10:00`);
      const hoursOut = Number.isFinite(when) ? (when - Date.now()) / 3600e3 : null;
      const early = hoursOut != null && hoursOut > 24;
      const manual = b0.manualMoney === true || b0.manualMoney === "true";
      let refundCents = paid ? (early ? paidCents : 0) : 0;
      if (paid && b0.refund !== undefined && b0.refund !== null && b0.refund !== "") {
        const want = Math.round(Number(b0.refund) * 100);
        if (!Number.isFinite(want) || want < 0) return res.status(400).json({ error: "The refund has to be an amount of dollars, or 0." });
        if (want > paidCents) return res.status(400).json({ error: `The guest paid $${Math.round(paidCents / 100)} - the refund can't be more than that.` });
        refundCents = want;
      }
      const reason = String(b0.reason || "").trim().slice(0, 300);
      let refundId = null;
      if (refundCents > 0 && !manual) {
        if (!stripe) return res.status(503).json({ error: "Payments are not configured, so the refund cannot be made automatically.", needsManual: true });
        const pi = await findPaymentIntent(r).catch((e) => { console.error("cancel: find payment:", e.message); return null; });
        if (!pi) {
          return res.status(409).json({ needsManual: true,
            error: `The card payment for ${ref} could not be found in Stripe, so the $${Math.round(refundCents / 100)} refund cannot be made automatically. ` +
                   "Refund it from the Stripe dashboard, then cancel again with 'settle the money by hand' ticked." });
        }
        const refund = await stripe.refunds.create({ payment_intent: pi, amount: refundCents, metadata: { ref, reason: "booking cancelled by office" } },
          { idempotencyKey: "cancel-" + ref + "-" + refundCents });
        refundId = refund.id;
      }
      await pool.query(
        `UPDATE web_bookings SET status = 'cancelled', cancelled_at = now(), refunded_cents = refunded_cents + $2, cancel_note = $3 WHERE ref = $1`,
        [ref, manual ? 0 : refundCents, reason || null]);
      /* No payment link may stay payable for a cancelled trip. */
      await deactivatePaymentLink(ref).catch((e) => console.error("cancel: link off:", e.message));
      if (r.balance_link_id && stripe) {
        await stripe.paymentLinks.update(r.balance_link_id, { active: false, inactive_message: "This booking has been cancelled. Questions: +61 481 437 772." })
          .catch((e) => console.error("cancel: balance link off:", e.message));
      }
      /* Who had already been sent this job. ops.js's tables exist only when
         dispatch is on, so this is a best effort. */
      let drivers = [];
      try {
        drivers = (await pool.query(
          `SELECT d.leg, r.name, r.phone FROM ops_dispatch d JOIN ops_drivers r ON r.id = d.driver_id
            WHERE d.ref = $1 AND (d.sent_at IS NOT NULL OR d.status IN ('accepted','on_way','on_location','pob'))`, [ref])).rows;
      } catch (e) { drivers = []; }
      const refundTxt = refundCents > 0
        ? (manual ? `$${Math.round(refundCents / 100)} to be refunded by hand` : `$${Math.round(refundCents / 100)} refunded to the card (Stripe ${refundId})`)
        : paid ? "no refund" : "nothing had been paid";
      const notify = b0.notifyGuest !== false && b0.notifyGuest !== "false";
      let emailed = null;
      if (notify && r.passenger_email && mailer) {
        const first = String(r.passenger_name || "").trim().split(/\s+/)[0] || "there";
        const money = refundCents > 0
          ? (manual
            ? `A refund of $${Math.round(refundCents / 100)} is being arranged - we'll let you know when it has been sent.`
            : `$${Math.round(refundCents / 100)} has been refunded to the card you paid with - it usually shows within 5 to 10 business days.`)
          : paid ? (early ? "The fare is not refunded." : "As the cancellation was within 24 hours of pick-up, the fare is not refunded, in line with our booking terms.")
          : "Nothing was charged.";
        /* The booking is already cancelled and any refund made, so a failed
           email must not turn into an error that invites a second attempt. */
        try { await mailer.sendMail({
          from: `"Sky Transfers" <${process.env.GMAIL_USER}>`, to: r.passenger_email, replyTo: BOOKINGS_EMAIL,
          subject: `Booking cancelled - Sky Transfers · ${ref}`,
          text: `Hi ${first},\n\nYour booking ${ref} has been cancelled:\n\n  ${r.pickup_date_text} at ${r.pickup_time}\n  ${r.pickup} -> ${r.dropoff}\n  ${r.vehicle}\n\n${money}\n\n` +
                `If this wasn't what you expected, or you'd like to book again, reply to this email or call +61 481 437 772.\n\nSky Transfers\nwww.skytransfers.com.au`,
        }); emailed = r.passenger_email; } catch (e) { console.error("cancel guest email:", e.message); }
      }
      if (mailer) {
        Promise.resolve().then(() => mailer.sendMail({
          from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`, to: BOOKINGS_EMAIL, replyTo: r.passenger_email || undefined,
          subject: `CANCELLED: ${r.pickup} -> ${r.dropoff} (${r.pickup_date_text} ${r.pickup_time}) [${ref}] - ${refundTxt}`,
          text: `CANCELLED from the admin page.\n\n${rowLines(r)}\n\nMoney: ${refundTxt}.` +
                (reason ? `\nReason: ${reason}` : "") + (emailed ? `\nGuest emailed at ${emailed}.` : "\nGuest NOT emailed.") +
                (drivers.length ? `\n\nTELL THE DRIVER - this job had been sent to: ${drivers.map((d) => `${d.name} (${d.phone})${d.leg === "ret" ? " for the return" : ""}`).join(", ")}.` : ""),
        })).catch((e) => console.error("cancel copy:", e.message));
      }
      console.log("web booking cancelled:", ref, refundTxt, hoursOut != null ? Math.round(hoursOut) + "h out" : "");
      res.json({ ok: true, ref, refunded: manual ? 0 : refundCents / 100, refundManual: manual && refundCents > 0 ? refundCents / 100 : 0,
                 emailed, drivers: drivers.map((d) => ({ name: d.name, phone: d.phone, leg: d.leg })), hoursOut: hoursOut != null ? Math.round(hoursOut) : null });
    } catch (err) {
      console.error("cancel web booking:", err);
      res.status(500).json({ error: "Could not cancel that booking - check Stripe before trying again if it was paid." });
    }
  });

  app.post("/admin/web-booking/remove", requireAdmin, async (req, res) => {
    try {
      const ref = String((req.body && req.body.ref) || "").trim();
      if (!ref) return res.status(400).json({ error: "Which booking?" });
      const r = await getWebBooking(ref);
      if (!r) return res.status(404).json({ error: "No booking with that reference." });
      /* Paid bookings stay put. The privacy policy promises booking and
         payment records are kept for seven years, and a button on a dashboard
         is not the place to start breaking that promise. */
      if (r.status === "paid" || r.paid_at) {
        return res.status(409).json({ error: "A paid booking cannot be removed - cancel it instead, which keeps the record." });
      }
      /* Kill the payment link first, so removing the row cannot leave a live
         payable link behind with nothing to reconcile it against. */
      await deactivatePaymentLink(ref).catch((e) => console.error("deactivate on remove:", e.message));
      await pool.query(`DELETE FROM web_bookings WHERE ref = $1 AND status <> 'paid'`, [ref]);
      console.log("web booking removed:", ref);
      res.json({ ok: true, ref });
    } catch (err) {
      console.error("remove web booking:", err);
      res.status(500).json({ error: "Could not remove that booking." });
    }
  });

  app.get("/admin/web-bookings", requireAdmin, async (req, res) => {
    try {
      const status = String(req.query.status || "").trim().toLowerCase();
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
      const filtered = WEB_STATUSES.includes(status);
      const { rows } = await pool.query(
        `SELECT *, to_char(pickup_date, 'YYYY-MM-DD') AS pickup_date_text,
                  to_char(return_date, 'YYYY-MM-DD') AS return_date_text
           FROM web_bookings ${filtered ? "WHERE status = $2" : ""}
         ORDER BY created_at DESC LIMIT $1`,
        filtered ? [limit, status] : [limit]);
      const { rows: counts } = await pool.query(
        `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total_cents),0)::int AS cents
           FROM web_bookings GROUP BY status`);
      const summary = {};
      for (const c of counts) summary[c.status] = { count: c.n, total: c.cents / 100 };
      res.json({ bookings: rows.map(webRow), summary });
    } catch (err) {
      console.error("admin web bookings:", err);
      res.status(500).json({ error: "Could not load web bookings." });
    }
  });

  app.get("/admin/bookings", requireAdmin, async (req, res) => {
    try {
      const code = String(req.query.code || "").trim().toUpperCase();
      const { rows } = await pool.query(
        `SELECT * FROM agent_bookings WHERE agent_code = $1 ORDER BY created_at DESC LIMIT 300`, [code]);
      res.json({ bookings: rows.map(bookingRow) });
    } catch (err) {
      console.error("admin bookings:", err);
      res.status(500).json({ error: "Could not load those bookings." });
    }
  });

  /* Create or edit an agent. A new agent gets a PIN generated here and shown
     once — Sky Transfers passes it on. Editing never touches the PIN unless a
     reset is asked for, so changing a rate cannot lock an agent out. */
  app.post("/admin/agent", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const code = String(b.code || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{2,16}$/.test(code)) {
        return res.status(400).json({ error: "Agent code must be 2–16 letters or digits, no spaces." });
      }
      if (!b.name) return res.status(400).json({ error: "Give the agency a name." });
      const pct = Number(b.commissionPct);
      if (!(pct >= 0 && pct <= 60)) return res.status(400).json({ error: "Commission must be between 0 and 60%." });

      const { rows: existing } = await pool.query("SELECT code FROM agents WHERE code = $1", [code]);
      let pin = null;
      if (!existing.length || b.resetPin) pin = newPin();

      if (existing.length) {
        await pool.query(
          `UPDATE agents SET name=$2, email=$3, commission_pct=$4, active=$5
             ${pin ? ", pin_hash=$6" : ""} WHERE code=$1`,
          pin
            ? [code, b.name, b.email || null, pct, b.active !== false, makePinHash(pin)]
            : [code, b.name, b.email || null, pct, b.active !== false]
        );
      } else {
        await pool.query(
          `INSERT INTO agents (code, name, email, pin_hash, commission_pct, active)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [code, b.name, b.email || null, makePinHash(pin), pct, b.active !== false]
        );
      }
      LOGIN_FAILS.delete(code);
      res.json({ ok: true, code, pin, created: !existing.length });
    } catch (err) {
      console.error("admin agent:", err);
      res.status(500).json({ error: "Could not save that agent." });
    }
  });

  /* Pay out. Marks every confirmed, unsettled booking for that agent as
     settled and reports what was cleared, so the wallet balance drops to zero
     and the history keeps showing which trips the payment covered. */
  app.post("/admin/settle", requireAdmin, async (req, res) => {
    try {
      const code = String(req.body?.code || "").trim().toUpperCase();
      const { rows } = await pool.query(
        `UPDATE agent_bookings SET settled = TRUE, settled_at = now()
          WHERE agent_code = $1 AND status = 'confirmed' AND settled = FALSE
        RETURNING ref, commission_cents`, [code]);
      const cleared = rows.reduce((n, r) => n + r.commission_cents, 0);
      res.json({ ok: true, trips: rows.length, amount: cleared / 100 });
    } catch (err) {
      console.error("admin settle:", err);
      res.status(500).json({ error: "Could not record that payment." });
    }
  });

  /* The gallery is wrapped because this module is required from the very
     bottom of stripe-server.js: anything that throws out here takes the
     booking server down with it. A gallery that fails to mount should cost
     the office a photo page, never a night of bookings. */
  try {
    const express = require("express");
    /* ---- vehicle photo gallery -------------------------------------------
       Photographs live in the Postgres that is already running for the agent
       portal, so the office can add one without a deploy. The upload route
       takes the image bytes raw rather than as JSON: stripe-server.js installs
       express.json() globally with the default 100kb ceiling, and express.json
       ignores a body whose Content-Type is not JSON, so an image/* body passes
       straight through to the parser mounted here. The admin page re-encodes
       each photograph through a canvas before sending, which both shrinks it
       and drops the EXIF block - phone photographs carry GPS coordinates and
       those have no business being served from the website.
       ---------------------------------------------------------------------- */
    const GALLERY_TYPES = ["image/jpeg", "image/png", "image/webp"];
    const galleryBody = express.raw({ type: GALLERY_TYPES, limit: "8mb" });

    /* Read the real pixel size out of the file itself. The browser tells us
       what it thinks it sent, but a size that decides page layout should come
       from the bytes being stored, not from the client. Returns null when the
       buffer is not an image we recognise, so this doubles as the format check. */
    function imageSize(buf) {
      if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 &&
          buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString("latin1", 12, 16) === "IHDR") {
        return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.length > 30 && buf.toString("latin1", 0, 4) === "RIFF" &&
          buf.toString("latin1", 8, 12) === "WEBP") {
        const tag = buf.toString("latin1", 12, 16);
        if (tag === "VP8X") return { mime: "image/webp",
          width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
        if (tag === "VP8 ") return { mime: "image/webp",
          width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        if (tag === "VP8L") {
          const b = buf.readUInt32LE(21);
          return { mime: "image/webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
        }
        return null;
      }
      if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i + 9 < buf.length) {
          if (buf[i] !== 0xff) { i++; continue; }
          const marker = buf[i + 1];
          if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
          const len = buf.readUInt16BE(i + 2);
          const isSOF = marker >= 0xc0 && marker <= 0xcf &&
                        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
          if (isSOF) return { mime: "image/jpeg",
            height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
          if (len < 2) return null;
          i += 2 + len;
        }
      }
      return null;
    }

    const galleryOff = (res) =>
      res.status(503).json({ error: "The photo gallery is not configured on this server." });

    /* Public: what the gallery page lists. Never selects the bytes column. */
    app.get("/gallery", async (req, res) => {
      if (!pool) return galleryOff(res);
      try {
        const { rows } = await pool.query(
          `SELECT id, caption, vehicle, width, height,
                  to_char(created_at, 'YYYY-MM-DD') AS added
             FROM gallery_photos ORDER BY sort DESC, id DESC LIMIT 300`);
        res.set("Cache-Control", "public, max-age=120");
        res.json({ photos: rows });
      } catch (err) {
        console.error("gallery list:", err);
        res.status(500).json({ error: "Could not load the gallery." });
      }
    });

    /* Public: one photograph. Immutable - a new upload is always a new id. */
    app.get("/gallery/photo/:id", async (req, res) => {
      if (!pool) return galleryOff(res);
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id < 1) return res.status(400).send("Bad photo id.");
      try {
        const { rows } = await pool.query(
          "SELECT bytes, mime, sha1 FROM gallery_photos WHERE id = $1", [id]);
        if (!rows.length) return res.status(404).send("No such photo.");
        const tag = '"' + rows[0].sha1 + '"';
        res.set("ETag", tag);
        res.set("Cache-Control", "public, max-age=31536000, immutable");
        res.type(rows[0].mime);
        if (req.headers["if-none-match"] === tag) return res.status(304).end();
        res.send(rows[0].bytes);
      } catch (err) {
        console.error("gallery photo:", err);
        res.status(500).send("Could not load that photo.");
      }
    });

    /* Office only. Caption and vehicle ride in the query string because the
       body is the image itself. */
    app.post("/gallery/upload", galleryBody, requireAdmin, async (req, res) => {
      if (!pool) return galleryOff(res);
      try {
        const buf = req.body;
        if (!Buffer.isBuffer(buf) || !buf.length)
          return res.status(400).json({ error: "No image arrived. Please pick a file and try again." });
        const info = imageSize(buf);
        if (!info)
          return res.status(400).json({ error: "That file is not a JPEG, PNG or WebP image." });
        if (info.width < 400 || info.height < 300)
          return res.status(400).json({ error: `That image is only ${info.width}x${info.height}. Please use one at least 400x300.` });
        const sha1 = crypto.createHash("sha1").update(buf).digest("hex");
        const caption = String(req.query.caption || "").trim().slice(0, 200);
        const vehicle = String(req.query.vehicle || "").trim().slice(0, 60);
        const { rows } = await pool.query(
          `INSERT INTO gallery_photos (caption, vehicle, mime, width, height, bytes, sha1, sort)
           VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE((SELECT MAX(sort) FROM gallery_photos), 0) + 1)
           ON CONFLICT (sha1) DO NOTHING
           RETURNING id`,
          [caption, vehicle, info.mime, info.width, info.height, buf, sha1]);
        if (!rows.length)
          return res.status(409).json({ error: "That photo is already in the gallery." });
        res.json({ ok: true, id: rows[0].id, width: info.width, height: info.height, bytes: buf.length });
      } catch (err) {
        console.error("gallery upload:", err);
        res.status(500).json({ error: "Could not save that photo." });
      }
    });

    app.post("/gallery/remove", requireAdmin, async (req, res) => {
      if (!pool) return galleryOff(res);
      const id = parseInt(req.body && req.body.id, 10);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Which photo?" });
      try {
        const { rowCount } = await pool.query("DELETE FROM gallery_photos WHERE id = $1", [id]);
        if (!rowCount) return res.status(404).json({ error: "That photo is already gone." });
        res.json({ ok: true });
      } catch (err) {
        console.error("gallery remove:", err);
        res.status(500).json({ error: "Could not remove that photo." });
      }
    });

    console.log("Vehicle photo gallery ready");
  } catch (err) {
    console.error("Photo gallery not mounted (bookings unaffected):", err.message);
  }

  /* ---- retention: the two-year promise in the privacy policy -------------
     privacy.html says "Quote enquiries that never became bookings are deleted
     within two years". Nothing performed that until 8 Oct 2026, so it was a
     promise with no machinery behind it.

     Only enquiries go: a row still 'requested' (nobody ever answered it) or
     'declined' (we said no). 'confirmed' and 'paid' are bookings and are kept
     seven years for the tax and corporate record-keeping the same policy
     relies on, which is also why /admin/web-booking/remove refuses a paid row.

     There is no scheduler on this service and it sleeps between requests, so a
     timer would not fire reliably. It runs at boot instead - every deploy and
     every wake - which is ample for a rule measured in years.
     ---------------------------------------------------------------------- */
  const RETAIN_ENQUIRY_YEARS = 2;
  const PURGEABLE = ["requested", "declined"];

  /* Count first, delete second, and never in the same call by accident:
     dryRun is the default so a mistake costs a SELECT. */
  async function purgeOldEnquiries({ dryRun = true } = {}) {
    if (!pool) return null;
    const where = `status = ANY($1) AND created_at < now() - ($2 || ' years')::interval`;
    const args = [PURGEABLE, String(RETAIN_ENQUIRY_YEARS)];
    const { rows } = await pool.query(
      `SELECT status, count(*)::int AS n, min(created_at) AS oldest
         FROM web_bookings WHERE ${where} GROUP BY status`, args);
    const total = rows.reduce((n, r) => n + r.n, 0);
    if (dryRun || !total) return { dryRun: true, total, byStatus: rows };
    const del = await pool.query(`DELETE FROM web_bookings WHERE ${where}`, args);
    console.log(`Retention: removed ${del.rowCount} enquiry row(s) older than ${RETAIN_ENQUIRY_YEARS} years`);
    return { dryRun: false, total: del.rowCount, byStatus: rows };
  }

  /* What would go, without touching anything. */
  app.get("/admin/retention", requireAdmin, async (req, res) => {
    try {
      const r = await purgeOldEnquiries({ dryRun: true });
      if (!r) return res.status(503).json({ error: "No database configured on this server." });
      const { rows: all } = await pool.query(
        "SELECT status, count(*)::int AS n FROM web_bookings GROUP BY status ORDER BY status");
      res.json({ retainEnquiryYears: RETAIN_ENQUIRY_YEARS, purgeableStatuses: PURGEABLE,
                 wouldDelete: r.total, breakdown: r.byStatus, tableNow: all,
                 autoPurgeOnBoot: AUTO_PURGE });
    } catch (err) {
      console.error("retention report:", err);
      res.status(500).json({ error: "Could not read the retention figures." });
    }
  });

  /* Deleting customer records is irreversible, so this asks for it in words. */
  app.post("/admin/retention/purge", requireAdmin, async (req, res) => {
    if (String(req.body && req.body.confirm) !== "DELETE OLD ENQUIRIES")
      return res.status(400).json({ error: 'Send {"confirm":"DELETE OLD ENQUIRIES"} to run this.' });
    try {
      const r = await purgeOldEnquiries({ dryRun: false });
      if (!r) return res.status(503).json({ error: "No database configured on this server." });
      res.json({ ok: true, deleted: r.total });
    } catch (err) {
      console.error("retention purge:", err);
      res.status(500).json({ error: "Could not complete the purge." });
    }
  });

  /* Kicked off, deliberately not returned. This used to be `return
     initAgentSchema()...`, which made everything below it unreachable - the
     module handed stripe-server.js a Promise instead of its functions, so
     recordBooking silently did nothing and no website booking was ever
     stored. Nothing waits on this; the handlers that need the tables are
     HTTP routes that cannot fire before it settles. */
  /* Flip RETENTION_AUTO_PURGE to "on" once the dry run has been eyeballed.
     Until then this reports and deletes nothing. */
  const AUTO_PURGE = String(process.env.RETENTION_AUTO_PURGE || "").toLowerCase() === "on";

  initAgentSchema()
    .then(seedAgents)
    .then(async () => {
      try {
        const r = await purgeOldEnquiries({ dryRun: !AUTO_PURGE });
        if (r && r.total) console.log(
          `Retention: ${r.total} enquiry row(s) older than ${RETAIN_ENQUIRY_YEARS} years` +
          (r.dryRun ? " would be removed (RETENTION_AUTO_PURGE is off)" : " removed"));
      } catch (e) { console.error("Retention check failed:", e.message); }
    })
    .then(() => console.log(
      AGENTS_ON
        ? `Agent portal ready (admin ${ADMIN_PIN ? "on" : "OFF — set ADMIN_PIN"})`
        : "Agent portal off (set DATABASE_URL and AGENT_SECRET)"))
    .catch((e) => console.error("Agent portal setup failed:", e.message));

  /* stripe-server.js records public-site bookings through this. requireAdmin
     is handed out so other modules can sit behind the same admin login rather
     than growing a second path that accepts the PIN. */
  /* pool goes to ops.js (the dispatch board), which reads these same tables. */
  return { saveWebBooking, actionLinks, findOpenWebBooking, requireAdmin, getWebBooking, rowToBooking, summaryForRow, settleBalance, pool, setTripStatus };
};
