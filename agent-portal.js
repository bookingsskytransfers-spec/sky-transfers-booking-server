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
    hourlyHours, normaliseAddresses, COMPANY,
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
  /* The DMC rate card (rate-card.js), for agencies ticked "Rate card" in
     admin.html: net prices, no commission, and the card's own cancellation
     policy - changes close 12 hours out instead of 24. */
  const card = require("./rate-card")({ OOL: (HUB_NAMES || [])[0], BNE: (HUB_NAMES || [])[1], CRUISE: (HUB_NAMES || [])[2] });
  const onCard = (a) => !!(a && a.rate_card);
  const cutoffFor = (a) => (onCard(a) ? card.CANCEL.freeHours : CHANGE_CUTOFF_HOURS);
  const closedFor = (a) => (onCard(a) ? card.CLOSED_TEXT : CHANGE_CLOSED);
  /* Inside 12 hours a card agency can still cancel online, at the card's
     charge: 50%, or 100% inside 6 hours. null once the pick-up has passed. */
  const lateFeePct = (h) => (h == null || h <= 0 ? null : h < card.CANCEL.halfHours ? 100 : h < card.CANCEL.freeHours ? 50 : 0);

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
      -- staff logins (19 Oct 2026): who made or last changed a booking, and
      -- the tour a booking was made in, if it was booked as part of one
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS booked_by     TEXT;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS booked_by_id  INTEGER;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS changed_by    TEXT;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS tour_ref      TEXT;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS tour_name     TEXT;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS tour_seq      INTEGER;
      -- paying one booking by card (20 Oct 2026): a Stripe payment link the
      -- agent pays or forwards to their client; once paid the trip is
      -- settled and stays off the monthly invoice
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS pay_link_id    TEXT;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS pay_link_url   TEXT;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS pay_link_cents INTEGER;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS card_paid_at   TIMESTAMPTZ;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS card_pi        TEXT;
      -- the DMC rate card (21 Oct 2026): which agencies get it, which card
      -- price a booking was made at, and the charge on a late cancellation
      -- (status 'late_cancel' keeps the charge on the invoice, off the board)
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS rate_card BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS rate_card      TEXT;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS cancel_fee_pct INTEGER;
      CREATE INDEX IF NOT EXISTS agent_bookings_by_agent
        ON agent_bookings (agent_code, created_at DESC);
      CREATE INDEX IF NOT EXISTS agent_bookings_by_tour ON agent_bookings (tour_ref);
      -- One row per staff login. The agency's own code + PIN stays the main
      -- login; these are extra people at the same agency, each with their own
      -- PIN. role: 'manager' (everything, team included) or 'staff' (bookings
      -- only - no wallet, commission or invoices). pin_ver goes up on a PIN
      -- reset so sessions signed in with the old PIN end.
      CREATE TABLE IF NOT EXISTS agent_users (
        id            SERIAL PRIMARY KEY,
        agent_code    TEXT NOT NULL REFERENCES agents(code),
        name          TEXT NOT NULL,
        email         TEXT,
        pin_hash      TEXT NOT NULL,
        pin_ver       INTEGER NOT NULL DEFAULT 1,
        role          TEXT NOT NULL DEFAULT 'staff',
        active        BOOLEAN NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS agent_users_by_agent ON agent_users (agent_code);
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
      -- the two ends' street addresses on their own (20 Oct 2026); the address
      -- column keeps the single combined line the dispatch text has always had
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS pu_address       TEXT;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS do_address       TEXT;
      -- a deposit booking (20 Oct 2026): the percentage the first link
      -- charges, and the PaymentIntents of any balance paid after it
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS deposit_pct      INTEGER;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS balance_pis      TEXT;
      -- paid another way (23 Oct 2026): how the office was paid, when the
      -- whole fare came in outside Stripe - a bank transfer, cash
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS paid_note        TEXT;
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
  function signToken(code, role, ttlMs, extra) {
    const body = Buffer.from(JSON.stringify({ ...(extra || {}), code, role, exp: Date.now() + ttlMs })).toString("base64url");
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
      "SELECT code, name, email, commission_pct, active, rate_card FROM agents WHERE code = $1", [claim.code]);
    if (!rows.length || !rows[0].active) return res.status(401).json({ error: "This account is no longer active." });
    req.agent = rows[0];
    /* A staff login is re-checked on every request, so switching someone off
       or resetting their PIN takes effect at once, not when the token expires. */
    if (claim.uid) {
      const { rows: us } = await pool.query(
        "SELECT id, name, email, role, active, pin_ver FROM agent_users WHERE id = $1 AND agent_code = $2", [claim.uid, claim.code]);
      const u = us[0];
      if (!u || !u.active || Number(u.pin_ver) !== Number(claim.pv)) return res.status(401).json({ error: "This login has been switched off or its PIN changed — please sign in again." });
      req.user = { id: u.id, name: u.name, email: u.email, role: u.role === "manager" ? "manager" : "staff" };
    } else {
      req.user = { id: null, name: rows[0].name, email: rows[0].email, role: "owner" };
    }
    next();
  }
  /* Bookings-only staff see fares but not the commission, the wallet or the
     agency's invoices; the main login and managers see everything. */
  const canMoney = (req) => !req.user || req.user.role !== "staff";
  const canManage = (req) => !!req.user && (req.user.role === "owner" || req.user.role === "manager");
  const ACCOUNTS_ONLY = "Your login is for bookings only — ask whoever manages your agency's account.";
  function requireAgentAccounts(req, res, next) {
    requireAgent(req, res, () => {
      if (!canMoney(req)) return res.status(403).json({ error: ACCOUNTS_ONLY });
      next();
    }).catch((err) => { console.error("agent auth:", err); res.status(500).json({ error: "Could not check your sign-in just now." }); });
  }
  /* "Jane Smith at Nexus Travel (NEXUS)" for a staff login, else the agency. */
  const whoDid = (req) => (req.user && req.user.id ? `${req.user.name} at ` : "") + `${req.agent.name} (${req.agent.code})`;
  const bookedByOf = (req) => (req.user && req.user.id ? req.user.name : null);

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
      /* The agency's own PIN first, then its staff logins: everyone signs in
         with the agency code and their own PIN, so the form stays the same. */
      let user = null;
      const main = !!(a && a.active && pinMatches(pin, a.pin_hash));
      if (a && a.active && !main) {
        const { rows: us } = await pool.query(
          "SELECT id, name, role, pin_hash, pin_ver FROM agent_users WHERE agent_code = $1 AND active ORDER BY id", [code]);
        user = us.find((u) => pinMatches(pin, u.pin_hash)) || null;
      }
      if (!main && !user) {
        noteLoginFail(code);
        return res.status(401).json({ error: "That code and PIN do not match." });
      }
      LOGIN_FAILS.delete(code);
      if (user) {
        await pool.query("UPDATE agent_users SET last_login_at = now() WHERE id = $1", [user.id]).catch(() => {});
        const role = user.role === "manager" ? "manager" : "staff";
        return res.json({ token: signToken(a.code, "agent", 12 * 3600 * 1000, { uid: user.id, pv: Number(user.pin_ver) }),
                          name: a.name, code: a.code, user: { name: user.name, role },
                          commissionPct: role === "staff" ? null : agentPct(a) });
      }
      res.json({ token: signToken(a.code, "agent", 12 * 3600 * 1000), name: a.name, code: a.code,
                 user: { name: a.name, role: "owner" }, commissionPct: agentPct(a) });
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
    res.json({ places: PLACES_FOR_AGENTS, vehicles: VEHICLES, rateCard: onCard(req.agent) ? card.publicCard() : null });
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

  /* A service picked from the rate card fixes one end (and the hours): set
     them before the trip is read, so the rest of the code sees an ordinary
     booking. */
  function applyService(b) {
    const svc = b.service ? card.SERVICE[String(b.service)] : null;
    if (!svc) return null;
    b.ends = b.ends && typeof b.ends === "object" ? { ...b.ends } : {};
    if (svc.kind === "pkg") { b.pickup = svc.from; b.ends.pickup = { suburb: svc.from }; delete b.hourly; }
    else if (svc.kind === "park") { b.dropoff = svc.park; b.ends.dropoff = { suburb: svc.park, address: svc.park }; delete b.hourly; b.returnTrip = true; }
    else { b.hourly = { hours: svc.hours }; b.dropoff = ""; }
    b.stops = [];
    return svc;
  }
  /* The card's answer for this trip (null: not on the card), with any stops
     priced as the website prices them (the 21-seater as the 14-seat Sprinter). */
  async function cardQuote(b, t) {
    const svc = b.service ? card.SERVICE[String(b.service)] : null;
    const isReturn = svc ? svc.kind === "park" : !t.hours && !!(b.returnTrip || b.returnDate);
    const c = card.quote({ service: svc ? svc.id : (b.service || null), pickup: t.pickup, dropoff: t.dropoff, hours: svc ? null : t.hours, isReturn,
      date: b.date, time: b.time, ret: { date: b.returnDate, time: b.returnTime } });
    if (!c || c.error || !t.stops.length) return c;
    for (const v of c.vehicles) {
      const r = await agentFare(t, v.vehicle === card.MINIBUS ? "Mercedes Sprinter 14-Seater" : v.vehicle).catch(() => null);
      if (!r) return { error: "We couldn't price those stops — check each stop was picked from the list, or call us." };
      v.stopsExtra = r.stopsExtra || 0; v.stops = r.stops; v.stopsKm = r.stopsKm;
    }
    return c;
  }

  app.post("/agent/quote", requireAgent, async (req, res) => {
    try {
      const body = { ...(req.body || {}) };
      if (onCard(req.agent)) applyService(body);
      const t = tripOf(body);
      if (onCard(req.agent)) {
        const c = await cardQuote(body, t);
        if (c && c.error) return res.json({ quotable: false, message: c.error });
        if (c) {
          return res.json({ quotable: true, commissionPct: canMoney(req) ? 0 : null, net: true, kind: c.kind, hours: c.hours,
            rateCard: { id: c.id, label: c.label, kind: c.kind }, stops: t.stops.length,
            vehicles: c.vehicles.map((v) => ({ vehicle: v.vehicle, fare: v.fare, total: v.total + (v.stopsExtra || 0), stopsExtra: v.stopsExtra || 0,
              surcharge: [...new Set(v.legs.flatMap((l) => l.notes))], commission: canMoney(req) ? 0 : null })) });
        }
        if (body.service) return res.json({ quotable: false, message: "Choose a vehicle from your rate card, or call us." });
      }
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
        return { vehicle: v, fare: r.fare, total, stopsExtra: r.stopsExtra, commission: canMoney(req) ? commissionOf(total * 100, pct) / 100 : null };
      }).filter(Boolean);
      const stopsKm = (fares.find((r) => r && r.stopsKm != null) || {}).stopsKm;
      if (!out.length) {
        return res.json({ quotable: false, message: "We can't fix a price for that trip online — call +61 481 437 772 and we'll price it for you." });
      }
      res.json({ quotable: true, commissionPct: canMoney(req) ? pct : null, kind: t.hours ? "hourly" : isReturn ? "return" : "oneway", hours: t.hours,
                 stops: t.stops.length, stopsKm: stopsKm != null ? stopsKm : null, vehicles: out });
    } catch (err) {
      console.error("agent quote:", err);
      res.status(500).json({ error: "Could not price that just now." });
    }
  });

  /* Shared by book and amend: validate, price, and normalise one booking. */
  async function priceBooking(b, pct, agent) {
    const svc = onCard(agent) ? applyService(b) : null;
    if (b.service && !svc && onCard(agent)) return { error: "That rate card service isn't on the card any more - choose another, or call us." };
    if (b.service && !onCard(agent)) return { error: "Your agency isn't on the rate card - book it as a normal trip." };
    const t = tripOf(b);
    if (onCard(agent)) {
      b.pickup = t.pickup; b.dropoff = t.dropoff;
      const c = await cardQuote(b, t);
      if (c && c.error) return { error: c.error };
      if (c) return cardBooking(b, t, c, svc);
    }
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

  /* A booking priced from the rate card: the same shape priceBooking
     returns, so book, tour and change treat it like any other. */
  function cardBooking(b, t, c, svc) {
    for (const f of ["pickup", "dropoff", "vehicle", "date", "time", "name", "phone"]) {
      if (!b[f]) return { error: "Please fill in every required field." };
    }
    const email = String(b.email || "").trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "That passenger email doesn't look right." };
    const v = c.vehicles.find((x) => x.vehicle === b.vehicle);
    if (!v) return { error: "That vehicle isn't on your rate card for this trip - choose another, or call us." };
    if (leadTimeShortfall(b.date, b.time) !== null) return { error: LEAD_TIME_ERROR };
    const r = returnTripOf(b, t.hours);
    if (r.error) return { error: r.error };
    if (c.legsCount === 2 && !r.ret) return { error: svc && svc.kind === "park" ? "Give the date and time to collect them from the park (the return pick-up)." : "Please give both a date and a time for the return trip." };
    const seats = Math.min(Math.max(parseInt(b.childSeats, 10) || 0, 0), 3);
    const trailer = b.trailer === true || b.trailer === "true";
    const stopsObj = v.stops && v.stops.length ? { list: v.stops.map((x) => ({ address: x.address, suburb: x.suburb, lat: x.lat, lng: x.lng })), extra: v.stopsExtra, km: v.stopsKm } : null;
    const hours = svc ? (svc.hours || null) : t.hours;
    const sumOf = (bb) => card.summary({ ...bb, email: email || bb.agentEmail || BOOKINGS_EMAIL }, c, v, seats, trailer, r.ret, stopsObj);
    const s = sumOf(b);
    return {
      fare: v.fare, priced: { stops: v.stops || [], stopsExtra: v.stopsExtra || 0, stopsKm: v.stopsKm != null ? v.stopsKm : null },
      seats, trailer, summary: s, totalCents: Math.round(s.total * 100), ret: r.ret, hours, email: email || null,
      stops: stopsObj ? JSON.stringify(stopsObj) : null,
      clientRef: String(b.clientRef || "").trim().slice(0, 60) || null,
      ends: t.hours ? JSON.stringify({ pickup: t.pu }) : JSON.stringify({ pickup: t.pu, dropoff: t.dro }),
      commissionCents: 0, pct: 0, rateCard: c.id, cardLabel: c.label, resummarize: sumOf,
      pax: parseInt(b.pax, 10) || 1,
    };
  }
  /* the booking text again once the reference exists */
  const resummary = (b, p) => (p.resummarize ? p.resummarize(b)
    : bookingSummary(withStops({ ...b, email: p.email || b.agentEmail || BOOKINGS_EMAIL }, p.priced), p.fare, p.seats, p.trailer, p.ret));
  /* commission lines for the emails: a card booking has none */
  const officeMoney = (p, pct, totalCents, commCents, what) => (p && p.rateCard
    ? `Invoice the agent the rate card price: ${money(totalCents)}${what || ""} (net - no commission)\n`
    : `Invoice the agent the full fare: ${money(totalCents)}${what || ""}\n` +
      `Agent commission: ${pct}% = ${money(commCents)}, to their wallet - paid out separately\n`);
  const agentMoney = (p, pct, totalCents, commCents, what) => (p && p.rateCard
    ? `This ${what || "booking"} is at your rate card price, ${money(totalCents)}, and will appear on your monthly invoice at that price.\n\n`
    : `Your commission on this ${what || "booking"}: ${money(commCents)} (${pct}%), added to your wallet and paid out to you separately.\n` +
      `This ${what === "tour" ? "tour's trips" : "booking"} will appear on your monthly invoice at the full fare, ${money(totalCents)}${what === "tour" ? " in all" : ""}.\n\n`);

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

  /* One INSERT for a single booking and for every leg of a tour. q is the
     pool, or a client inside a transaction. */
  function insertAgentBooking(q, req, b, p, pct, tour) {
    return q.query(
      `INSERT INTO agent_bookings
         (ref, agent_code, pickup, dropoff, vehicle, pickup_date, pickup_time,
          passenger_name, passenger_phone, passenger_email, flight, address, notes,
          pax, child_seats, trailer, total_cents, commission_cents, commission_pct,
          client_ref, return_date, return_time, return_flight, hire_hours, ends, stops,
          booked_by, booked_by_id, tour_ref, tour_name, tour_seq, rate_card)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)`,
      [b.ref, req.agent.code, b.pickup, b.dropoff, b.vehicle, b.date, b.time,
       b.name, b.phone, p.email, b.flight || null, b.address || null, b.notes || null,
       p.pax, p.seats, p.trailer, p.totalCents, p.commissionCents, p.pct != null ? p.pct : pct,
       p.clientRef, p.ret ? p.ret.date : null, p.ret ? p.ret.time : null, p.ret ? (p.ret.flight || null) : null, p.hours, p.ends, p.stops,
       bookedByOf(req), req.user && req.user.id ? req.user.id : null,
       tour ? tour.ref : null, tour ? tour.name : null, tour ? tour.seq : null, p.rateCard || null]
    );
  }

  /* The agency's copy goes to the agency's own address, as it always has.
     A staff login with its own email also gets a copy - without the
     commission line if their login is bookings only. */
  function agentCopies(req, subject, lead, body, moneyLines) {
    if (!mailer) return;
    const send = (to, withMoney, hi) => mailer.sendMail({
      from: `"Sky Transfers" <${process.env.GMAIL_USER}>`, to, replyTo: BOOKINGS_EMAIL, subject,
      text: `Hi ${hi},\n\n${lead}\n\n${body}\n\n` + (withMoney ? moneyLines : "") +
        `You can download a passenger voucher, change or cancel in the portal up to ` +
        `${cutoffFor(req.agent)} hours before pick-up.` +
        (onCard(req.agent) ? " Inside 12 hours a cancellation is charged at 50% of the fare, inside 6 hours at 100%." : "") + `\n\nSky Transfers`,
    }).catch((e) => console.error("agent copy email:", e.message));
    if (req.agent.email) send(req.agent.email, true, req.agent.name);
    const mine = req.user && req.user.id && req.user.email ? String(req.user.email).trim() : "";
    if (mine && mine.toLowerCase() !== String(req.agent.email || "").trim().toLowerCase()) send(mine, canMoney(req), req.user.name.split(" ")[0]);
  }

  app.post("/agent/book", requireAgent, async (req, res) => {
    try {
      const pct = agentPct(req.agent);
      const b = { ...(req.body || {}), agentEmail: req.agent.email };
      const p = await priceBooking(b, pct, req.agent);
      if (p.error) return res.status(400).json({ error: p.error });
      b.ref = makeRef(b.date);
      /* again now the reference exists, so the emails carry it */
      p.summary = resummary(b, p);

      await insertAgentBooking(pool, req, b, p, pct, null);

      notifyOffice(
        `AGENT booking (${req.agent.code}): ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time}) [${b.ref}]`,
        `AGENT BOOKING — ${req.agent.name} (${req.agent.code})\n` + (bookedByOf(req) ? `Booked by: ${bookedByOf(req)}\n` : "") +
        (p.clientRef ? `Agent reference: ${p.clientRef}\n` : "") + `\n${p.summary.text}\n\n` +
        /* Agencies are invoiced the FULL fare; commission sits in their wallet
           and is paid out separately (Aman, 19 Oct 2026). */
        officeMoney(p, pct, p.totalCents, p.commissionCents),
        req.agent
      );
      agentCopies(req, `Booking confirmed — ${b.ref} · Sky Transfers`,
        "Your booking is in and we'll confirm the chauffeur shortly.",
        (p.clientRef ? `Your reference: ${p.clientRef}\n` : "") + p.summary.text,
        agentMoney(p, pct, p.totalCents, p.commissionCents));

      res.json({ ok: true, ref: b.ref, total: p.summary.total, commission: canMoney(req) ? p.commissionCents / 100 : null });
    } catch (err) {
      console.error("agent book:", err);
      res.status(500).json({ error: "Could not save that booking — please call us so it isn't lost." });
    }
  });

  /* ---- a whole tour in one go ------------------------------------------
     Every leg is priced and checked exactly as a single booking is, and
     either every leg is booked or none is: a group itinerary half-booked is
     worse than not booked. Each leg is an ordinary booking with its own
     reference (change, cancel and voucher work on it as normal), tied
     together by a tour reference and name. */
  const TOUR_MAX = 15;
  app.post("/agent/tour", requireAgent, async (req, res) => {
    let client = null;
    try {
      const pct = agentPct(req.agent);
      const body = req.body || {};
      const legs = Array.isArray(body.legs) ? body.legs : [];
      const name = String(body.tourName || "").trim().slice(0, 80);
      if (legs.length < 2) return res.status(400).json({ error: "A tour needs at least two trips — book a single trip with the normal Book button." });
      if (legs.length > TOUR_MAX) return res.status(400).json({ error: `A tour can have up to ${TOUR_MAX} trips — split a longer one in two, or call us.` });
      if (!name) return res.status(400).json({ error: "Give the tour a name — the group or lead passenger — so it's easy to find." });
      const priced = [];
      for (let i = 0; i < legs.length; i++) {
        const b = { ...(legs[i] && typeof legs[i] === "object" ? legs[i] : {}), agentEmail: req.agent.email };
        if (!String(b.clientRef || "").trim() && body.clientRef) b.clientRef = body.clientRef;
        const p = await priceBooking(b, pct, req.agent);
        if (p.error) return res.status(400).json({ error: `Trip ${i + 1} (${b.date || "no date"}, ${b.pickup || "?"} to ${b.hourly ? "as directed" : (b.dropoff || "?")}): ${p.error}`, leg: i });
        priced.push({ b, p });
      }
      const refs = new Set();
      for (const x of priced) {
        let ref; do { ref = makeRef(x.b.date); } while (refs.has(ref));
        refs.add(ref); x.b.ref = ref;
        x.p.summary = resummary(x.b, x.p);
      }
      const tour = { ref: makeRef(priced[0].b.date).replace(/^ST-/, "TR-"), name };

      client = await pool.connect();
      await client.query("BEGIN");
      for (let i = 0; i < priced.length; i++) {
        await insertAgentBooking(client, req, priced[i].b, priced[i].p, pct, { ...tour, seq: i + 1 });
      }
      await client.query("COMMIT");
      client.release(); client = null;

      const totalCents = priced.reduce((n, x) => n + x.p.totalCents, 0);
      const commCents = priced.reduce((n, x) => n + x.p.commissionCents, 0);
      const legText = priced.map((x, i) => `--- TRIP ${i + 1} of ${priced.length} ---\n${x.p.summary.text}`).join("\n\n");
      notifyOffice(
        `AGENT TOUR (${req.agent.code}): ${priced.length} trips, ${name}, from ${priced[0].b.date} [${tour.ref}]`,
        `AGENT TOUR — ${req.agent.name} (${req.agent.code})\n` + (bookedByOf(req) ? `Booked by: ${bookedByOf(req)}\n` : "") +
        `Tour: ${name}\nTour reference: ${tour.ref}\nTrips: ${priced.length} (${priced.map((x) => x.b.ref).join(", ")})\n\n${legText}\n\n` +
        (priced.some((x) => x.p.rateCard) ? `Rate card trips: ${priced.filter((x) => x.p.rateCard).length} of ${priced.length} (net - no commission on those)\n` : "") +
        `Invoice the agent${priced.some((x) => x.p.rateCard) ? "" : " the full fare"}: ${money(totalCents)} for the whole tour\n` +
        (commCents ? `Agent commission: ${pct}% = ${money(commCents)}, to their wallet - paid out separately\n` : ""),
        req.agent
      );
      agentCopies(req, `Tour booked — ${name}, ${priced.length} trips · ${tour.ref} · Sky Transfers`,
        `Your tour "${name}" is in: ${priced.length} trips, tour reference ${tour.ref}. We'll confirm each chauffeur shortly.`,
        legText,
        (commCents ? `Your commission on this tour: ${money(commCents)} (${pct}%), added to your wallet and paid out to you separately.\n` : "") +
        `These trips will appear on your monthly invoice${priced.some((x) => x.p.rateCard) ? " (rate card trips at your rate card price)" : " at the full fare"}, ${money(totalCents)} in all.\n\n`);

      res.json({ ok: true, tourRef: tour.ref, tourName: name, refs: priced.map((x) => x.b.ref),
                 total: totalCents / 100, commission: canMoney(req) ? commCents / 100 : null });
    } catch (err) {
      if (client) { await client.query("ROLLBACK").catch(() => {}); client.release(); }
      console.error("agent tour:", err);
      res.status(500).json({ error: "Could not save that tour — nothing was booked. Please try again or call us." });
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
      /* money has been taken for it, so a change or refund is the office's */
      if (bk.card_paid_at) return { error: "This booking has been paid by card, so changes and cancellations go through us - call +61 481 437 772.", code: 409 };
      const iso = bk.pickup_date instanceof Date ? bk.pickup_date.toISOString().slice(0, 10) : String(bk.pickup_date);
      const h = hoursUntil(iso, bk.pickup_time);
      if (h == null || h < cutoffFor(req.agent)) return { error: closedFor(req.agent), code: 400 };
    }
    return { booking: bk };
  }

  app.post("/agent/booking/cancel", requireAgent, async (req, res) => {
    try {
      const ref = String(req.body?.ref || "");
      if (onCard(req.agent)) {
        const any = await loadOwnBooking(req, ref, { forChange: false });
        if (any.error) return res.status(any.code).json({ error: any.error });
        const bk0 = any.booking;
        const h0 = hoursUntil(isoOf(bk0.pickup_date), bk0.pickup_time);
        const fee = lateFeePct(h0);
        if (bk0.status === "confirmed" && !bk0.card_paid_at && fee) {
          const feeCents = Math.round(bk0.total_cents * fee / 100);
          if (!req.body || req.body.acceptCharge !== true) {
            return res.status(409).json({ error: `This is inside ${fee === 100 ? 6 : 12} hours of pick-up, so cancelling is charged at ${fee}% of the fare: ${money(feeCents)}.`,
              charge: { pct: fee, amount: feeCents / 100 } });
          }
          await pool.query(
            `UPDATE agent_bookings SET status = 'late_cancel', cancelled_at = now(), changed_by = $2, cancel_fee_pct = $3,
               total_cents = $4, commission_cents = 0 WHERE ref = $1 AND status = 'confirmed'`, [bk0.ref, bookedByOf(req), fee, feeCents]);
          await dropAgentPayLink(bk0, "This booking has been cancelled. Call +61 481 437 772 with any questions.");
          notifyOffice(
            `AGENT LATE CANCELLATION (${req.agent.code}, ${fee}% charged): ${bk0.pickup} -> ${bk0.dropoff} [${bk0.ref}]`,
            `LATE CANCELLATION by ${whoDid(req)} - ${Math.round(h0 * 10) / 10} hours before pick-up\n\n` +
            `Reference: ${bk0.ref}\nRoute: ${bk0.pickup} -> ${bk0.dropoff}\nWas: ${isoOf(bk0.pickup_date)} ${bk0.pickup_time}\n` +
            `Passenger: ${bk0.passenger_name}\nVehicle: ${bk0.vehicle}\n\n` +
            `Rate card policy: ${fee}% of ${money(bk0.total_cents)} = ${money(feeCents)}, stays on their next invoice.\n` +
            `It is off the dispatch board - take it off the driver if one was sent.\n`,
            req.agent
          );
          return res.json({ ok: true, charged: feeCents / 100, pct: fee });
        }
      }
      const found = await loadOwnBooking(req, ref, { forChange: true });
      if (found.error) return res.status(found.code).json({ error: found.error });
      const bk = found.booking;
      await pool.query(
        "UPDATE agent_bookings SET status = 'cancelled', cancelled_at = now(), changed_by = $2 WHERE ref = $1", [bk.ref, bookedByOf(req)]);
      await dropAgentPayLink(bk, "This booking has been cancelled, so there is nothing to pay. Call +61 481 437 772 with any questions.");
      /* The commission goes with it: the wallet only counts confirmed bookings,
         so cancelling reverses the earning automatically. */
      notifyOffice(
        `AGENT CANCELLED (${req.agent.code}): ${bk.pickup} -> ${bk.dropoff} [${bk.ref}]`,
        `CANCELLED by ${whoDid(req)}\n\n` +
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

  /* ---- paying one booking by card (20 Oct 2026) -------------------------
     Agency bookings normally go on the monthly invoice. An agent can instead
     settle a single trip by card at the full fare, no surcharge: the portal
     makes a Stripe payment link the agent pays there and then, or forwards so
     their client pays it - the better way, since the agent never handles the
     client's card. When Stripe reports it paid (the webhook calls
     settleAgentCard) the trip is settled and stays off the invoice. The
     commission is unchanged: it is in the wallet and paid out as usual. */
  async function dropAgentPayLink(bk, message) {
    if (!bk || !bk.pay_link_id) return;
    if (stripe) {
      await stripe.paymentLinks.update(bk.pay_link_id, { active: false, inactive_message: message })
        .catch((e) => console.error("agent pay link off:", e.message));
    }
    await pool.query("UPDATE agent_bookings SET pay_link_id = NULL, pay_link_url = NULL, pay_link_cents = NULL WHERE ref = $1", [bk.ref]);
  }
  async function onIssuedInvoice(ref) {
    const r = await pool.query(
      `SELECT i.number FROM ops_invoice_lines l JOIN ops_invoices i ON i.id = l.invoice_id WHERE l.ref = $1 AND i.status <> 'void'`, [ref])
      .catch(() => ({ rows: [] }));
    return r.rows[0] ? r.rows[0].number : null;
  }
  app.post("/agent/booking/pay-link", requireAgent, async (req, res) => {
    try {
      if (!stripe) return res.status(503).json({ error: "Card payments are not set up on this server - call +61 481 437 772." });
      const found = await loadOwnBooking(req, String(req.body?.ref || ""), { forChange: false });
      if (found.error) return res.status(found.code).json({ error: found.error });
      const bk = found.booking;
      if (bk.status !== "confirmed") return res.status(400).json({ error: "That booking is cancelled, so there is nothing to pay." });
      if (bk.card_paid_at) return res.status(409).json({ error: "That booking is already paid by card." });
      const inv = await onIssuedInvoice(bk.ref);
      if (inv) return res.status(409).json({ error: `That trip is already on invoice ${inv} - pay the invoice instead, from Invoices & statement.` });
      /* the same link while the price has not changed, so it can be shared once */
      if (bk.pay_link_url && Number(bk.pay_link_cents) === Number(bk.total_cents)) return res.json({ ok: true, url: bk.pay_link_url, total: bk.total_cents / 100 });
      await dropAgentPayLink(bk, "This payment link has been replaced - please use the newer link you were sent.");
      const date = bk.pickup_date instanceof Date ? bk.pickup_date.toISOString().slice(0, 10) : String(bk.pickup_date);
      const what = bk.hire_hours ? `${bk.hire_hours} hours from ${bk.pickup}` : `${bk.pickup} to ${bk.dropoff}`;
      /* keyed to the minute: a double click dedupes, but a link made later
         (after a price change and back) is a new one, never a dead old one */
      const price = await stripe.prices.create({
        currency: "aud", unit_amount: bk.total_cents,
        product_data: { name: `Transfer ${bk.ref} - ${what}, ${date} ${bk.pickup_time}` },
      }, { idempotencyKey: `agent-price-${bk.ref}-${bk.total_cents}-${Math.floor(Date.now() / 60000)}` });
      const link = await stripe.paymentLinks.create({
        line_items: [{ price: price.id, quantity: 1 }],
        /* read by the webhook, which settles the booking and stops there -
           it is not a website booking */
        metadata: { agent_booking_for: bk.ref, ref: bk.ref, agent: req.agent.code },
        after_completion: { type: "redirect", redirect: { url: process.env.SUCCESS_URL || "https://www.skytransfers.com.au/?booking=confirmed" } },
        inactive_message: "This booking has already been paid. If you need anything, call or text +61 481 437 772.",
      }, { idempotencyKey: `agent-plink-${bk.ref}-${bk.total_cents}-${Math.floor(Date.now() / 60000)}` });
      await pool.query("UPDATE agent_bookings SET pay_link_id = $2, pay_link_url = $3, pay_link_cents = $4 WHERE ref = $1",
        [bk.ref, link.id, link.url, bk.total_cents]);
      res.json({ ok: true, url: link.url, total: bk.total_cents / 100 });
    } catch (err) {
      console.error("agent pay link:", err);
      res.status(500).json({ error: "Could not make a payment link just now - please call us." });
    }
  });

  /* The Stripe webhook, when a link carrying agent_booking_for is paid. */
  async function settleAgentCard(ref, paidCents, paymentIntent) {
    const { rows } = await pool.query(
      `UPDATE agent_bookings SET card_paid_at = COALESCE(card_paid_at, now()), card_pi = COALESCE(card_pi, $2)
        WHERE ref = $1 RETURNING *`, [ref, paymentIntent || null]);
    const bk = rows[0];
    if (!bk) return null;
    if (stripe && bk.pay_link_id) {
      await stripe.paymentLinks.update(bk.pay_link_id, { active: false, inactive_message: "This booking has already been paid. If you need anything, call or text +61 481 437 772." })
        .catch((e) => console.error("agent pay link off:", e.message));
    }
    const ag = (await pool.query("SELECT code, name, email FROM agents WHERE code = $1", [bk.agent_code])).rows[0] || { code: bk.agent_code, name: bk.agent_code };
    const date = bk.pickup_date instanceof Date ? bk.pickup_date.toISOString().slice(0, 10) : String(bk.pickup_date);
    notifyOffice(`AGENT BOOKING PAID BY CARD (${ag.code}): ${money(paidCents)} [${bk.ref}]`,
      `PAID BY CARD - ${ag.name} (${ag.code})\n\nReference: ${bk.ref}\nRoute: ${bk.pickup} -> ${bk.dropoff}\nDate: ${date} ${bk.pickup_time}\n` +
      `Passenger: ${bk.passenger_name}\nPaid: ${money(paidCents)} (fare ${money(bk.total_cents)})\n\n` +
      `Settled - it will not go on the agency's monthly invoice. Commission is unchanged and stays in their wallet.\n`, ag);
    if (mailer && ag.email) {
      const trip = bk.hire_hours ? `${bk.hire_hours} hours as directed from ${bk.pickup}` : `${bk.pickup} to ${bk.dropoff}`;
      const longDate = (() => { try { const [y, mo, d] = date.split("-").map(Number);
        return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); }
        catch (e) { return date; } })();
      mailer.sendMail({
        from: `"Sky Transfers" <${process.env.GMAIL_USER}>`, to: ag.email, replyTo: BOOKINGS_EMAIL,
        subject: `Payment received — ${bk.ref} · Sky Transfers`,
        text: `Hi ${ag.name},\n\nWe've received ${money(paidCents)} by card for booking ${bk.ref} (${bk.pickup} to ${bk.dropoff}, ${date} ${bk.pickup_time}).\n\n` +
          `It's settled and won't appear on your monthly invoice. Your commission on it stays in your wallet as usual.\n\nSky Transfers`,
        html: brandedAgentEmail({
          heading: "PAYMENT RECEIVED", ref: bk.ref, name: ag.name, pill: "PAID BY CARD",
          intro: `We've received ${money(paidCents)} by card for this booking. It's settled and won't appear on your monthly invoice.`,
          sections: [
            ["Booking", [["Reference", bk.ref], bk.client_ref ? ["Your reference", bk.client_ref] : null, ["Trip", trip],
              ["Date & time", `${longDate} at ${bk.pickup_time}`], ["Vehicle", bk.vehicle], ["Passenger", bk.passenger_name]]],
            ["Payment", [["Paid by card", money(paidCents)], ["Monthly invoice", "Settled - not on your invoice"],
              ["Your commission", `${money(bk.commission_cents)} - in your wallet, paid out as usual`]]],
          ],
        }),
        attachments: guestAttachments(null),
      }).catch((e) => console.error("agent paid email:", e.message));
    }
    return bk;
  }

  /* The guest confirmation's look for an email to an agency: logo header
     with the reference, a status badge, labelled sections, the company
     footer. Tables and inline styles only, for Outlook and Gmail. */
  function brandedAgentEmail({ heading, ref, name, pill, intro, sections }) {
    const esc = (t) => String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const cellL = "padding:9px 14px;font:700 12px/1.45 Arial,sans-serif;color:#141D30;vertical-align:top;width:34%;border-bottom:1px solid #EFE6D0;";
    const cellR = "padding:9px 14px;font:400 14px/1.45 Arial,sans-serif;color:#333B4C;vertical-align:top;border-bottom:1px solid #EFE6D0;";
    const co = COMPANY || { name: "Sky Transfers", ids: "" };
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F7F4ED;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4ED;"><tr><td align="center" style="padding:24px 10px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:10px;overflow:hidden;border:1px solid #E5E0D2;">
    <tr><td style="background:#101828;padding:18px 28px;border-bottom:3px solid #C9A227;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;"><img src="cid:stlogo" alt="SKY TRANSFERS" height="58" style="height:58px;display:block;font:400 20px Georgia,serif;letter-spacing:4px;color:#F6F2E8;"></td>
        <td align="right" style="vertical-align:middle;">
          <div style="font:700 10px Arial,sans-serif;letter-spacing:2.5px;color:#D9B44A;">${esc(heading)}</div>
          <div style="font:700 20px Arial,sans-serif;color:#FFFFFF;padding-top:3px;">${esc(ref)}</div>
        </td></tr></table>
    </td></tr>
    <tr><td style="padding:22px 28px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:top;font:700 22px Arial,sans-serif;color:#141D30;">${esc(name)}</td>
        <td align="right" style="vertical-align:top;"><span style="display:inline-block;padding:6px 14px;border-radius:12px;font:700 10px Arial,sans-serif;letter-spacing:1px;background:#1E7F4F;color:#FFFFFF;">${esc(pill)}</span></td>
      </tr></table>
      <div style="font:400 14.5px/1.6 Arial,sans-serif;color:#333B4C;padding-top:10px;">${esc(intro)}</div>
    </td></tr>
    ${sections.map(([title, rows]) => `
    <tr><td style="padding:14px 28px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-bottom:2px solid #C9A227;">
        <tr><td colspan="2" style="background:#101828;border-radius:5px 5px 0 0;padding:8px 14px;font:700 13px Arial,sans-serif;color:#FFFFFF;">
          <span style="display:inline-block;width:7px;height:7px;background:#C9A227;margin-right:8px;vertical-align:middle;"></span>${esc(title)}</td></tr>
        ${rows.filter(Boolean).map((r) => `<tr><td style="${cellL}">${esc(r[0])}</td><td style="${cellR}">${esc(r[1])}</td></tr>`).join("")}
      </table>
    </td></tr>`).join("")}
    <tr><td style="padding:18px 28px 22px;font:400 13.5px/1.7 Arial,sans-serif;color:#333B4C;">
      Questions? Reply to this email or call us any time on
      <a href="tel:+61481437772" style="color:#8E701C;font-weight:700;text-decoration:none;">+61&nbsp;481&nbsp;437&nbsp;772</a> — we're on 24/7.
    </td></tr>
    <tr><td style="background:#101828;padding:20px 28px;border-top:2px solid #C9A227;">
      <div style="font:700 12.5px Arial,sans-serif;color:#F6F2E8;">${esc(co.name)}</div>
      <div style="font:400 11.5px/1.8 Arial,sans-serif;color:#A9B0BE;padding-top:4px;">
        ${esc(co.ids).replace(/  ·  /g, " &middot; ")}${co.ids ? "<br>" : ""}
        24/7 &middot; +61 481 437 772 &middot; <a href="mailto:info@skytransfers.com.au" style="color:#D9B44A;text-decoration:none;">info@skytransfers.com.au</a> &middot; <a href="https://www.skytransfers.com.au/agent.html" style="color:#D9B44A;text-decoration:none;">Agent portal</a>
      </div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
  }

  app.post("/agent/booking/update", requireAgent, async (req, res) => {
    try {
      const found = await loadOwnBooking(req, String(req.body?.ref || ""), { forChange: true });
      if (found.error) return res.status(found.code).json({ error: found.error });
      const old = found.booking;
      const pct = agentPct(req.agent);
      const b = { ...(req.body || {}), agentEmail: req.agent.email };
      b.ref = old.ref;
      /* a rate card package stays that package unless the page says otherwise */
      if (old.rate_card && card.SERVICE[old.rate_card] && b.service == null) b.service = old.rate_card;
      const p = await priceBooking(b, pct, req.agent);
      if (p.error) return res.status(400).json({ error: p.error });

      await pool.query(
        `UPDATE agent_bookings SET
           pickup=$2, dropoff=$3, vehicle=$4, pickup_date=$5, pickup_time=$6,
           passenger_name=$7, passenger_phone=$8, passenger_email=$9, flight=$10,
           address=$11, notes=$12, pax=$13, child_seats=$14, trailer=$15,
           total_cents=$16, commission_cents=$17, commission_pct=$18, updated_at=now(),
           client_ref=$19, return_date=$20, return_time=$21, return_flight=$22, hire_hours=$23, ends=$24, stops=$25, changed_by=$26,
           rate_card=$27
         WHERE ref = $1`,
        [old.ref, b.pickup, b.dropoff, b.vehicle, b.date, b.time,
         b.name, b.phone, p.email, b.flight || null, b.address || null, b.notes || null,
         p.pax, p.seats, p.trailer, p.totalCents, p.commissionCents, p.pct != null ? p.pct : pct,
         p.clientRef, p.ret ? p.ret.date : null, p.ret ? p.ret.time : null, p.ret ? (p.ret.flight || null) : null, p.hours, p.ends, p.stops, bookedByOf(req),
         p.rateCard || null]
      );

      /* a payment link made for the old price is now wrong */
      if (old.pay_link_id && Number(old.pay_link_cents) !== p.totalCents) {
        await dropAgentPayLink(old, "This booking has been changed, so this payment link no longer applies. Ask your travel agent for the new one.");
      }
      const wasDate = old.pickup_date instanceof Date ? old.pickup_date.toISOString().slice(0, 10) : old.pickup_date;
      notifyOffice(
        `AGENT AMENDED (${req.agent.code}): ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time}) [${old.ref}]`,
        `AMENDED by ${whoDid(req)}\n\n` +
        `WAS: ${old.pickup} -> ${old.dropoff}, ${old.vehicle}, ${wasDate} ${old.pickup_time}, ` +
        `${old.passenger_name}, total ${money(old.total_cents)}\n\n` +
        `NOW:\n${p.summary.text}\n\n` +
        (p.rateCard ? `Invoice the agent the rate card price: ${money(p.totalCents)} (was ${money(old.total_cents)}) - net, no commission\n`
          : `Invoice the agent the full fare: ${money(p.totalCents)} (was ${money(old.total_cents)})\n` +
            `Commission now: ${pct}% = ${money(p.commissionCents)} (was ${money(old.commission_cents)}), to their wallet - paid out separately\n`),
        req.agent
      );
      res.json({ ok: true, ref: old.ref, total: p.summary.total, commission: canMoney(req) ? p.commissionCents / 100 : null });
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
  function pdfBuffer(draw) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 0 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      try { draw(doc); doc.end(); } catch (e) { reject(e); }
    });
  }
  const voucherPdf = (bk, agentName) => pdfBuffer((doc) => drawVoucher(doc, bk, agentName));
  /* A tour: the itinerary first, then one voucher per trip, so the agent can
     hand the group a single file. Like every voucher, no prices anywhere. */
  const tourVoucherPdf = (rows, agentName) => pdfBuffer((doc) => {
    drawItinerary(doc, rows, agentName);
    rows.forEach((bk) => { doc.addPage({ size: "A4", margin: 0 }); drawVoucher(doc, bk, agentName); });
  });
  const isoOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d) : ""));

  function drawItinerary(doc, rows, agentName) {
    const W = 595.28, H = 841.89, L = 48, R = W - 48, CW = R - L;
    const NAVY = "#101828", INK = "#141D30", GOLD = "#C9A227", GOLD_LT = "#D9B44A", MUTED = "#68707F", LINE = "#E5E0D2", CREAM = "#F6F2E8";
    const first = rows[0] || {};
    const head = () => {
      doc.rect(0, 0, W, 118).fill(NAVY);
      if (HAS_LOGO) { try { doc.image(LOGO, R - 96, 22, { fit: [96, 74] }); } catch (e) {} }
      doc.font("Times-Roman").fontSize(26).fillColor(CREAM).text("SKY TRANSFERS", L, 34, { characterSpacing: 4 });
      doc.font("Helvetica-Bold").fontSize(9).fillColor(GOLD_LT).text("TOUR ITINERARY", L, 70, { characterSpacing: 2.5 });
      doc.font("Helvetica").fontSize(8.5).fillColor("#98A0B0").text("Gold Coast & Brisbane private transfers", L, 86);
      doc.rect(0, 118, W, 3).fill(GOLD);
    };
    const foot = () => {
      const FY = H - 74;
      doc.rect(0, FY, W, 74).fill(NAVY);
      doc.rect(0, FY, W, 2).fill(GOLD);
      doc.font("Times-Roman").fontSize(13).fillColor(CREAM).text("SKY TRANSFERS", L, FY + 16, { characterSpacing: 3, lineBreak: false });
      doc.font("Helvetica").fontSize(8.5).fillColor("#98A0B0")
        .text("24/7  ·  +61 481 437 772  ·  info@skytransfers.com.au  ·  www.skytransfers.com.au", L, FY + 36, { lineBreak: false });
      doc.font("Helvetica").fontSize(8.5).fillColor(GOLD_LT).text(`Tour ${first.tour_ref || ""}`, L, FY + 16, { width: CW, align: "right", lineBreak: false });
    };
    head();
    let y = 146;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("TOUR", L, y, { characterSpacing: 1.5 });
    doc.font("Helvetica-Bold").fontSize(17).fillColor(INK).text(first.tour_name || "Tour", L, y + 12, { width: CW });
    y = doc.y + 6;
    doc.font("Helvetica").fontSize(10).fillColor(MUTED)
      .text(`Tour reference ${first.tour_ref || ""}   ·   ${rows.length} trips   ·   booked by ${agentName}`, L, y, { width: CW });
    y = doc.y + 18;
    const cols = [{ t: "#", w: 22 }, { t: "DATE & TIME", w: 100 }, { t: "TRIP", w: 210 }, { t: "VEHICLE", w: 85 }, { t: "REFERENCE", w: CW - 417 }];
    const header = () => {
      let x = L;
      doc.rect(L, y, CW, 22).fill(NAVY);
      cols.forEach((c) => { doc.font("Helvetica-Bold").fontSize(7.5).fillColor(CREAM).text(c.t, x + 6, y + 7, { width: c.w - 8, characterSpacing: 1, lineBreak: false }); x += c.w; });
      y += 22;
    };
    header();
    rows.forEach((bk, i) => {
      const trip = bk.hire_hours ? `${bk.hire_hours} hours as directed from ${bk.pickup}` : `${bk.pickup}  to  ${bk.dropoff}`;
      let stops = [];
      try { const j = bk.stops ? JSON.parse(bk.stops) : null; stops = j && Array.isArray(j.list) ? j.list : []; } catch (e) { stops = []; }
      const rd = isoOf(bk.return_date);
      const sub = [stops.length ? `via ${stops.map((s) => s.suburb || s.address).join(", ")}` : "",
                   rd ? `return ${rd} at ${bk.return_time || ""}` : "", bk.flight ? `flight ${bk.flight}` : ""].filter(Boolean).join("  ·  ");
      doc.font("Helvetica").fontSize(9.5);
      const h = Math.max(30, doc.heightOfString(trip, { width: 202 }) + (sub ? doc.heightOfString(sub, { width: 202 }) + 4 : 0) + 14);
      if (y + h > H - 74 - 20) { foot(); doc.addPage({ size: "A4", margin: 0 }); head(); y = 146; header(); }
      let x = L;
      const cells = [String(i + 1), `${isoOf(bk.pickup_date)}\n${bk.pickup_time}`, null, bk.vehicle, bk.ref];
      cells.forEach((v, k) => {
        if (k === 2) {
          doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(trip, x + 6, y + 7, { width: 202 });
          if (sub) doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(sub, x + 6, doc.y + 2, { width: 202 });
        } else {
          doc.font(k === 4 ? "Helvetica-Bold" : "Helvetica").fontSize(k === 4 ? 8.5 : 9.5).fillColor(INK).text(v, x + 6, y + 7, { width: cols[k].w - 8 });
        }
        x += cols[k].w;
      });
      y += h;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(LINE).stroke();
    });
    y += 16;
    if (y + 40 < H - 74 - 8) {
      doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED)
        .text("Each trip has its own voucher on the pages that follow. Please show the right one to your chauffeur. Any changes should go through the travel agent who made this booking.", L, y, { width: CW });
    }
    foot();
  }

  function drawVoucher(doc, bk, agentName) {
    {
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
        bk.tour_ref ? ["TOUR", `${bk.tour_name || bk.tour_ref}${bk.tour_seq ? "  ·  trip " + bk.tour_seq : ""}  ·  ${bk.tour_ref}`] : null,
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
    }
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

  app.get("/agent/tour/voucher", requireAgent, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM agent_bookings WHERE tour_ref = $1 AND agent_code = $2 AND status = 'confirmed'
          ORDER BY tour_seq, pickup_date, pickup_time`, [String(req.query.tour || ""), req.agent.code]);
      if (!rows.length) return res.status(404).json({ error: "We can't find that tour, or every trip in it is cancelled." });
      const pdf = await tourVoucherPdf(rows, req.agent.name);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="SkyTransfers-${rows[0].tour_ref}.pdf"`);
      res.send(pdf);
    } catch (err) {
      console.error("tour voucher:", err);
      res.status(500).json({ error: "Could not build that tour voucher." });
    }
  });

  /* ---- the agency's team: staff logins --------------------------------
     The main login and managers add people, choose bookings-only or full
     access, reset a PIN or switch a login off. A PIN is made here, six
     digits, never the same as another login at the agency, and shown once:
     it is not stored anywhere it could be read back. */
  const TEAM_MAX = 25;
  const userRow = (u) => ({ id: u.id, name: u.name, email: u.email || "", role: u.role === "manager" ? "manager" : "staff",
    active: u.active, created: u.created_at, lastLogin: u.last_login_at || null, bookings: Number(u.bookings || 0) });
  function requireManager(req, res, next) {
    requireAgent(req, res, () => {
      if (!canManage(req)) return res.status(403).json({ error: "Only your agency's main login or a manager can change the team." });
      next();
    }).catch((err) => { console.error("agent auth:", err); res.status(500).json({ error: "Could not check your sign-in just now." }); });
  }
  async function freshStaffPin(code) {
    const { rows: a } = await pool.query("SELECT pin_hash FROM agents WHERE code = $1", [code]);
    const { rows: us } = await pool.query("SELECT pin_hash FROM agent_users WHERE agent_code = $1 AND active", [code]);
    const taken = a.concat(us).map((r) => r.pin_hash);
    for (let i = 0; i < 20; i++) {
      const pin = String(crypto.randomInt(100000, 1000000));
      if (!taken.some((h) => pinMatches(pin, h))) return pin;
    }
    throw new Error("could not find a free PIN");
  }
  const cleanRole = (r) => (r === "manager" ? "manager" : r === "staff" ? "staff" : null);

  /* The same team rules for the agency's own "Your team" card and for the
     office in admin.html: one place decides what a valid login is. */
  async function listTeam(code) {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.active, u.created_at, u.last_login_at, COUNT(b.ref) AS bookings
         FROM agent_users u LEFT JOIN agent_bookings b ON b.booked_by_id = u.id
        WHERE u.agent_code = $1
        GROUP BY u.id, u.name, u.email, u.role, u.active, u.created_at, u.last_login_at
        ORDER BY u.active DESC, u.name`, [code]);
    return rows.map(userRow);
  }
  const activeCount = async (code) =>
    Number((await pool.query("SELECT COUNT(*) AS n FROM agent_users WHERE agent_code = $1 AND active", [code])).rows[0].n);
  async function addStaff(code, body) {
    const name = String(body?.name || "").trim().replace(/\s+/g, " ").slice(0, 80);
    const email = String(body?.email || "").trim().slice(0, 120);
    const role = cleanRole(body?.role);
    if (name.length < 2) return { error: "Enter the person's name." };
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "That email doesn't look right." };
    if (!role) return { error: "Choose what they can see: bookings only, or everything." };
    if (await activeCount(code) >= TEAM_MAX) return { error: `There are ${TEAM_MAX} logins already — switch one off first.` };
    const pin = await freshStaffPin(code);
    const { rows } = await pool.query(
      `INSERT INTO agent_users (agent_code, name, email, pin_hash, role) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, role, active, created_at, last_login_at`,
      [code, name, email || null, makePinHash(pin), role]);
    return { user: userRow(rows[0]), pin, name, email, role };
  }
  async function staffOf(code, id) {
    const { rows } = await pool.query("SELECT * FROM agent_users WHERE id = $1 AND agent_code = $2", [parseInt(id, 10) || 0, code]);
    return rows[0] || null;
  }
  async function updateStaff(code, u, body) {
    const role = body?.role != null ? cleanRole(body.role) : (u.role === "manager" ? "manager" : "staff");
    if (!role) return { error: "Choose bookings only, or everything." };
    const active = body?.active != null ? body.active === true || body.active === "true" : u.active;
    if (active && !u.active && await activeCount(code) >= TEAM_MAX) return { error: `There are ${TEAM_MAX} logins already — switch one off first.` };
    /* switching a login back on gives it a new PIN: the old one may have
       been reused by someone else since */
    const pin = active && !u.active ? await freshStaffPin(code) : null;
    await pool.query(
      `UPDATE agent_users SET role = $2, active = $3${pin ? ", pin_hash = $4, pin_ver = pin_ver + 1" : ""} WHERE id = $1`,
      pin ? [u.id, role, active, makePinHash(pin)] : [u.id, role, active]);
    return { pin };
  }
  async function resetStaffPin(code, u) {
    const pin = await freshStaffPin(code);
    await pool.query("UPDATE agent_users SET pin_hash = $2, pin_ver = pin_ver + 1 WHERE id = $1", [u.id, makePinHash(pin)]);
    return pin;
  }

  app.get("/agent/team", requireManager, async (req, res) => {
    try {
      res.json({ you: req.user.id, max: TEAM_MAX, team: await listTeam(req.agent.code) });
    } catch (err) {
      console.error("agent team:", err);
      res.status(500).json({ error: "Could not load your team just now." });
    }
  });

  app.post("/agent/team/add", requireManager, async (req, res) => {
    try {
      const r = await addStaff(req.agent.code, req.body);
      if (r.error) return res.status(400).json({ error: r.error });
      notifyOffice(`AGENT TEAM (${req.agent.code}): ${r.name} added`,
        `${whoDid(req)} added a login for ${r.name}${r.email ? " (" + r.email + ")" : ""}: ${r.role === "manager" ? "manager - everything" : "bookings only"}.\n`, req.agent);
      res.json({ ok: true, user: r.user, pin: r.pin });
    } catch (err) {
      console.error("agent team add:", err);
      res.status(500).json({ error: "Could not add that login just now." });
    }
  });

  app.post("/agent/team/update", requireManager, async (req, res) => {
    try {
      const u = await staffOf(req.agent.code, req.body?.id);
      if (!u) return res.status(404).json({ error: "We can't find that login." });
      if (req.user.id && u.id === req.user.id) return res.status(400).json({ error: "You can't change your own login — ask your agency's main login or another manager." });
      const r = await updateStaff(req.agent.code, u, req.body);
      if (r.error) return res.status(400).json({ error: r.error });
      res.json({ ok: true, pin: r.pin });
    } catch (err) {
      console.error("agent team update:", err);
      res.status(500).json({ error: "Could not save that just now." });
    }
  });

  app.post("/agent/team/pin", requireManager, async (req, res) => {
    try {
      const u = await staffOf(req.agent.code, req.body?.id);
      if (!u || !u.active) return res.status(404).json({ error: "We can't find that login, or it is switched off." });
      res.json({ ok: true, pin: await resetStaffPin(req.agent.code, u) });
    } catch (err) {
      console.error("agent team pin:", err);
      res.status(500).json({ error: "Could not reset that PIN just now." });
    }
  });

  /* ---- the office's view of an agency's staff (admin.html) -------------
     The same actions the agency has, for when the main login is away or a
     staff member leaves on bad terms: see who has a login, switch one off,
     change what they see, issue a new PIN or add someone. A PIN issued here
     is shown once to the office, which passes it on. */
  const adminCode = (v) => String(v || "").trim().toUpperCase();
  async function agentExists(code) {
    return (await pool.query("SELECT code FROM agents WHERE code = $1", [code])).rows.length > 0;
  }
  app.get("/admin/agent/staff", requireAdmin, async (req, res) => {
    try {
      const code = adminCode(req.query.code);
      if (!await agentExists(code)) return res.status(404).json({ error: "No such agent." });
      res.json({ code, max: TEAM_MAX, team: await listTeam(code) });
    } catch (err) {
      console.error("admin staff:", err);
      res.status(500).json({ error: "Could not load that agency's staff." });
    }
  });
  app.post("/admin/agent/staff/add", requireAdmin, async (req, res) => {
    try {
      const code = adminCode(req.body?.code);
      if (!await agentExists(code)) return res.status(404).json({ error: "No such agent." });
      const r = await addStaff(code, req.body);
      if (r.error) return res.status(400).json({ error: r.error });
      res.json({ ok: true, user: r.user, pin: r.pin });
    } catch (err) {
      console.error("admin staff add:", err);
      res.status(500).json({ error: "Could not add that login." });
    }
  });
  app.post("/admin/agent/staff/update", requireAdmin, async (req, res) => {
    try {
      const code = adminCode(req.body?.code);
      const u = await staffOf(code, req.body?.id);
      if (!u) return res.status(404).json({ error: "We can't find that login." });
      const r = await updateStaff(code, u, req.body);
      if (r.error) return res.status(400).json({ error: r.error });
      res.json({ ok: true, pin: r.pin });
    } catch (err) {
      console.error("admin staff update:", err);
      res.status(500).json({ error: "Could not save that." });
    }
  });
  app.post("/admin/agent/staff/pin", requireAdmin, async (req, res) => {
    try {
      const code = adminCode(req.body?.code);
      const u = await staffOf(code, req.body?.id);
      if (!u || !u.active) return res.status(404).json({ error: "We can't find that login, or it is switched off." });
      res.json({ ok: true, pin: await resetStaffPin(code, u) });
    } catch (err) {
      console.error("admin staff pin:", err);
      res.status(500).json({ error: "Could not reset that PIN." });
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
    rateCard: r.rate_card || null,
    rateCardKind: r.rate_card && card.SERVICE[r.rate_card] ? card.SERVICE[r.rate_card].kind : null,
    cancelFeePct: r.cancel_fee_pct || null,
    bookedBy: r.booked_by || "",
    changedBy: r.changed_by || "",
    tourRef: r.tour_ref || null,
    tourName: r.tour_name || "",
    tourSeq: r.tour_seq || null,
    cardPaid: !!r.card_paid_at,
    payUrl: !r.card_paid_at && r.pay_link_url && Number(r.pay_link_cents) === Number(r.total_cents) ? r.pay_link_url : null,
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
      const money_ = canMoney(req);
      /* trips per tour, counting the cancelled ones too, so "2 of 5" stays true */
      const tourCount = {};
      rows.forEach((r) => { if (r.tour_ref) tourCount[r.tour_ref] = (tourCount[r.tour_ref] || 0) + 1; });
      res.json({
        agent: { code: req.agent.code, name: req.agent.name, commissionPct: money_ ? agentPct(req.agent) : null },
        user: { name: req.user.name, role: req.user.role, canMoney: money_, canManage: canManage(req) },
        wallet: money_ ? { earned: earned / 100, paid: paid / 100, balance: (earned - paid) / 100 } : null,
        changeCutoffHours: cutoffFor(req.agent),
        rateCard: onCard(req.agent),
        tourMax: TOUR_MAX,
        bookings: rows.map((r) => {
          const b = bookingRow(r);
          const h = hoursUntil(b.date, b.time);
          b.changeable = r.status === "confirmed" && !r.card_paid_at && h != null && h >= cutoffFor(req.agent);
          /* a card agency can still cancel inside 12 hours, at the card's charge */
          const fee = onCard(req.agent) && r.status === "confirmed" && !r.card_paid_at ? lateFeePct(h) : null;
          if (fee) b.lateCancel = { pct: fee, amount: Math.round(r.total_cents * fee / 100) / 100 };
          b.trip = trips[b.ref] || null;
          if (b.tourRef) b.tourCount = tourCount[b.tourRef];
          if (!money_) { b.commission = null; b.settled = null; }
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
        SELECT a.code, a.name, a.email, a.commission_pct, a.active, a.created_at, a.rate_card,
               COALESCE(SUM(CASE WHEN b.status='confirmed' THEN b.commission_cents END), 0)                        AS earned_cents,
               COALESCE(SUM(CASE WHEN b.status='confirmed' AND b.settled THEN b.commission_cents END), 0)          AS paid_cents,
               COUNT(b.ref) FILTER (WHERE b.status='confirmed')                                                    AS trips,
               COALESCE(SUM(CASE WHEN b.status='confirmed' THEN b.total_cents END), 0)                             AS gross_cents
          FROM agents a
          LEFT JOIN agent_bookings b ON b.agent_code = a.code
         GROUP BY a.code, a.rate_card
         ORDER BY a.name`);
      /* staff logins per agency, counted apart so the bookings join above
         isn't multiplied by them */
      const staff = {};
      (await pool.query("SELECT agent_code, COUNT(*) AS n FROM agent_users WHERE active GROUP BY agent_code")).rows
        .forEach((s) => { staff[s.agent_code] = Number(s.n); });
      res.json({
        agents: rows.map((r) => ({
          code: r.code, name: r.name, email: r.email,
          commissionPct: Number(r.commission_pct), active: r.active, rateCard: !!r.rate_card,
          staff: staff[r.code] || 0,
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
    puAddress: r.pu_address || "", doAddress: r.do_address || "",
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
    depositPct: r.deposit_pct || null, balanceLinkUrl: r.balance_link_url || null,
    paidNote: r.paid_note || "",
  });

  /* ---- deposit bookings (20 Oct 2026) ------------------------------------
     Office-made only. The first link charges a percentage of the total (20%
     unless the office types another); once that is paid the booking is
     'paid' with the rest in balance_cents - the same shape as a paid booking
     amended upwards, so the board, the cancel refund and the amend maths all
     already understand it. The balance link is the office's decision: no
     automatic email, a button on the admin page sends it. */
  const DEPOSIT_MIN = 10, DEPOSIT_MAX = 90;
  const depositPctOf = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= DEPOSIT_MIN && n <= DEPOSIT_MAX ? n : null; };
  /* whole dollars, so the guest sees $56, not $55.80 */
  const depositCents = (totalCents, pct) => Math.round((totalCents || 0) * pct / 10000) * 100;
  function addDeposit(s, r, paid) {
    if (!r || !r.deposit_pct) return s;
    s.deposit = true; s.depositPct = r.deposit_pct;
    const total = Math.round((r.total_cents || 0) / 100);
    if (!paid) {
      s.depositDue = Math.round(depositCents(r.total_cents, r.deposit_pct) / 100);
      s.text = s.text.replace(/TOTAL: \$\d+[^\n]*/, `TOTAL: $${total} (deposit $${s.depositDue} due now, $${total - s.depositDue} balance later)`);
    } else if (s.balance) {
      s.balanceLink = !!r.balance_link_url;
    }
    return s;
  }

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
          payment_intent, hire_hours, stops, pu_address, do_address, confirmed_at, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
               CASE WHEN $17 IN ('confirmed','paid') THEN now() END,
               CASE WHEN $17 = 'paid' THEN now() END)
       ON CONFLICT (ref) DO UPDATE SET
         /* Never walk a booking backwards. The webhook and a later re-save can
            arrive in either order, and paid is the end of the line - as is
            cancelled, which only the office's Cancel button sets. */
         status       = CASE WHEN web_bookings.status IN ('paid', 'cancelled') THEN web_bookings.status
                             ELSE EXCLUDED.status END,
         stops        = COALESCE(web_bookings.stops, EXCLUDED.stops),
         pu_address   = COALESCE(web_bookings.pu_address, EXCLUDED.pu_address),
         do_address   = COALESCE(web_bookings.do_address, EXCLUDED.do_address),
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
       hoursOf(b), stopsJson(b),
       String((b && b.pickupAddress) || "").trim().slice(0, 300) || null,
       String((b && b.dropoffAddress) || "").trim().slice(0, 300) || null]
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
    /* a deposit booking's first link is for the deposit only */
    const dep = r.deposit_pct ? depositCents(r.total_cents, r.deposit_pct) : 0;
    const price = await stripe.prices.create({
      currency: "aud",
      unit_amount: dep || r.total_cents,
      product_data: { name: (dep ? `${r.deposit_pct}% deposit for booking ${r.ref} — ` : "") + (r.hire_hours
        ? `${r.hire_hours > 6 ? "Charter" : "Hourly hire"}, ${r.hire_hours} hours from ${r.pickup}`
        : `Transfer — ${r.pickup} to ${r.dropoff}`) },
    }, { idempotencyKey: "price-" + r.ref + "-" + (r.link_seq || 0) + (dep ? "-dep" + dep : "") });

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
        pu_address: String(r.pu_address || "").slice(0, 300),
        do_address: String(r.do_address || "").slice(0, 300),
        /* read by the webhook, which settles the deposit and stops there */
        ...(dep ? { deposit_for: r.ref, deposit_cents: String(dep) } : {}),
      },
      after_completion: {
        type: "redirect",
        redirect: { url: process.env.SUCCESS_URL || "https://www.skytransfers.com.au/?booking=confirmed" },
      },
      inactive_message: dep ? "This deposit has already been paid. If you need anything, call or text +61 481 437 772."
                            : "This booking has already been paid. If you need anything, call or text +61 481 437 772.",
    }, { idempotencyKey: "plink-" + r.ref + "-" + (r.link_seq || 0) + (dep ? "-dep" + dep : "") });

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
  async function settleBalance(ref, paymentIntent) {
    const r = await getWebBooking(ref);
    if (!r) return null;
    /* The balance is a second card payment, so a later refund may need to
       come off it - its PaymentIntent is kept beside the first one. */
    const pis = String(r.balance_pis || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (paymentIntent && pis.indexOf(paymentIntent) === -1 && paymentIntent !== r.payment_intent) pis.push(paymentIntent);
    await pool.query(`UPDATE web_bookings SET balance_cents = 0, balance_link_id = NULL, balance_link_url = NULL, balance_pis = $2 WHERE ref = $1`,
      [ref, pis.length ? pis.join(",") : null]);
    if (r.balance_link_id && stripe) {
      await stripe.paymentLinks.update(r.balance_link_id, { active: false }).catch((e) => console.error("settle balance link:", e.message));
    }
    return getWebBooking(ref);
  }

  /* The webhook, when a deposit link is paid: the booking becomes 'paid'
     with the rest owing. _fresh is false on a replayed event, so nobody is
     emailed twice. */
  async function settleDeposit(ref, paidCents, paymentIntent) {
    const r = await getWebBooking(ref);
    if (!r) return null;
    if (r.status === "paid" || r.status === "cancelled") return { ...r, _fresh: false };
    await pool.query(
      `UPDATE web_bookings SET status = 'paid', paid_at = COALESCE(paid_at, now()), confirmed_at = COALESCE(confirmed_at, now()),
         payment_intent = COALESCE(payment_intent, $2), balance_cents = GREATEST(total_cents - $3::int, 0),
         balance_link_id = NULL, balance_link_url = NULL
       WHERE ref = $1 AND status NOT IN ('paid', 'cancelled')`, [ref, paymentIntent || null, Math.round(Number(paidCents) || 0)]);
    await deactivatePaymentLink(ref).catch((e) => console.error("deposit link off:", e.message));
    return { ...(await getWebBooking(ref)), _fresh: true };
  }

  /* A refund that may have to come off more than one card payment - the
     deposit and the balance - newest first. With a single payment it is
     exactly the one refund it always was. Returns the refund ids, null when
     no payment can be found, or { short } when Stripe holds less than asked. */
  async function refundAcross(r, cents, metadata, idem) {
    const first = await findPaymentIntent(r);
    /* "manual:<cents>" marks a balance the office took another way (cash,
       bank transfer) - money Stripe never held, so it can't refund it */
    const all = String(r.balance_pis || "").split(",").map((x) => x.trim()).filter(Boolean);
    const extra = all.filter((x) => !/^manual:/.test(x));
    if (all.length === 0) {
      if (!first) return null;
      const p = { payment_intent: first, amount: cents, metadata };
      const rf = idem ? await stripe.refunds.create(p, { idempotencyKey: idem }) : await stripe.refunds.create(p);
      return { ids: [rf.id] };
    }
    const pis = extra.slice().reverse().concat(first ? [first] : []);
    /* everything was paid another way: Stripe holds none of it */
    if (!pis.length) return { short: 0 };
    const left = [];
    for (const pi of pis) {
      const p = await stripe.paymentIntents.retrieve(pi, { expand: ["latest_charge"] });
      const ch = p && p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : null;
      left.push(Math.max(0, ch ? (ch.amount || 0) - (ch.amount_refunded || 0) : (p && p.amount_received) || 0));
    }
    const avail = left.reduce((a, x) => a + x, 0);
    if (avail < cents) return { short: avail };
    const ids = [];
    let want = cents;
    for (let i = 0; i < pis.length && want > 0; i++) {
      const take = Math.min(want, left[i]);
      if (!take) continue;
      const p = { payment_intent: pis[i], amount: take, metadata };
      const rf = idem ? await stripe.refunds.create(p, { idempotencyKey: idem + "-" + i }) : await stripe.refunds.create(p);
      ids.push(rf.id);
      want -= take;
    }
    return { ids };
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
      pickupAddress: r.pu_address || "", dropoffAddress: r.do_address || "",
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
      .replace(/^Fare: \$0 (one-way|for \d+ hours.*)\n/m, "")
      .replace(/^Return fare: .*\n/m, "")
      .replace(/TOTAL: \$\d+/, "TOTAL: $" + total + (b.paid ? " (PAID)" : ""));
    const s = { total, isReturn: !!ret, text };
    /* A paid booking that was amended upwards carries the unpaid difference. */
    if (b.paid && r.balance_cents > 0) {
      s.balance = Math.round(r.balance_cents / 100);
      s.text = s.text.replace(/\(PAID\)/, "(paid $" + (total - s.balance) + ", balance $" + s.balance + " to pay)");
    }
    return addDeposit(s, r, b.paid);
  }

  async function emailGuestConfirmation(b, s, payUrl) {
    const pdf = await bookingPdf(b, s).catch((e) => { console.error("PDF failed:", e.message); return null; });
    /* a deposit booking: deposit due, deposit paid, or its balance link */
    const dep = s.deposit && !s.refund ? (s.depositDue && !b.paid ? "due" : b.paid && s.balance ? (payUrl ? "balance" : "paid") : null) : null;
    const paidSoFar = s.balance ? s.total - s.balance : 0;
    const subject = dep === "due" ? `Booking confirmed — $${s.depositDue} deposit to pay — Sky Transfers · ${b.ref}`
                  : dep === "balance" ? `Balance due — $${s.balance} — Sky Transfers · ${b.ref}`
                  : dep === "paid" ? `Booking confirmed — deposit paid — Sky Transfers · ${b.ref}`
                  : s.balance ? `Booking updated — $${s.balance} balance to pay — Sky Transfers · ${b.ref}`
                  : s.refund ? `Booking updated — $${s.refund} refunded — Sky Transfers · ${b.ref}`
                  : b.paid ? `Booking confirmed & paid — Sky Transfers · ${b.ref}`
                  : b.confirmed ? `Booking confirmed — Sky Transfers · ${b.ref}`
                  : `Booking request received — Sky Transfers · ${b.ref}`;
    const opening = dep === "due"
      ? `Your booking is confirmed. To secure it, please pay the $${s.depositDue} deposit (${s.depositPct}% of the $${s.total} total) here:\n${payUrl || ""}\n\n` +
        `The $${s.total - s.depositDue} balance is paid later - we'll send you a link for it. Your printable confirmation is attached.`
      : dep === "balance"
      ? `Thank you for your deposit. The $${s.balance} balance for your booking can now be paid securely here:\n${payUrl || ""}\n\nYour confirmation is attached.`
      : dep === "paid"
      ? `Your booking is confirmed and your $${paidSoFar} deposit is paid. The $${s.balance} balance is paid later - we'll send you a secure link for it. Your printable confirmation is attached.`
      : s.balance
      ? `Your booking has been updated. Your earlier payment of $${s.total - s.balance} is held against it, and the $${s.balance} difference can be paid securely here:\n${payUrl || ""}\n\nYour updated confirmation is attached.`
      : s.refund
      ? `Your booking has been updated, and $${s.refund} has been refunded to the card you paid with - it usually shows within 5 to 10 business days. Your updated confirmation is attached.`
      : b.paid
      ? `Your ${hoursOf(b) ? "booking" : "transfer"} is confirmed and paid. Your printable confirmation is attached.`
      : b.confirmed
        ? `Your ${hoursOf(b) ? "booking" : "transfer"} is confirmed and your chauffeur is booked. Your printable confirmation is attached` +
          (payUrl ? `, and you can pay securely here to secure it:\n${payUrl}` : ".")
        : "Thanks for your booking request. We'll reply shortly, usually within the hour, to confirm your chauffeur.";
    await mailer.sendMail({
      from: `"Sky Transfers" <${process.env.GMAIL_USER}>`,
      to: b.email, replyTo: BOOKINGS_EMAIL, subject,
      text: `Hi ${b.name},\n\n${opening}\n\n${s.text}\n\n` +
            (hoursOf(b) ? "Your chauffeur will be at the pick-up at the time above. Free changes to 24 hours "
                        : `We track your flight and your chauffeur meets you with a name board. Free changes to 24 hours `) +
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
      /* the two ends' street addresses, when the form sends them separately */
      ...(b0.pickupAddress != null || b0.dropoffAddress != null
        ? { pickupAddress: String(b0.pickupAddress || ""), dropoffAddress: String(b0.dropoffAddress || "") } : {}),
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
    /* By the hour, or a charter (20 Oct 2026): the vehicle is held for N
       hours from the pick-up, as directed - no drop-off, no return leg, no
       stops. 3 to 6 hours has the website's hourly price; anything else is
       charter work and needs the agreed total in the override box. */
    if (b0.tripType === "hourly" || (b0.hourly && b0.hourly.hours)) {
      const hours = parseInt(b0.hours != null ? b0.hours : b0.hourly && b0.hourly.hours, 10);
      b.hourly = { hours };
      if (!hoursOf(b)) return refuse("Choose how many hours the vehicle is booked for (1 to 16).");
      b.dropoff = "As directed";
      b.returnDate = ""; b.returnTime = ""; b.returnFlight = "";
      b.stops = [];
    }
    /* keeps `address` - the dispatch text's single line - in step with them */
    if (typeof normaliseAddresses === "function") normaliseAddresses(b);
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
    if (b.hourly) {
      /* the hourly rate does not depend on where it starts, so any pick-up */
      const fare = hasOverride ? null : await fareForBooking(b);
      if (fare == null && !hasOverride) {
        return refuse(hoursOf(b) > 6 || hoursOf(b) < 3
          ? `${hoursOf(b)} hours is charter work with no online price — type the agreed total in the override box.`
          : "There is no online hourly price for that vehicle — type the agreed total in the override box.");
      }
      return { b, ret: null, fare, override, hasOverride };
    }
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
      const mode = b0.mode === "paid" ? "paid" : b0.mode === "deposit" ? "deposit" : "link";
      if (mode !== "paid" && !stripe) {
        console.log("office booking refused: payments not configured |", b.pickup, "->", b.dropoff);
        return res.status(503).json({ error: "Payments are not configured, so no link can be sent. Choose 'paid elsewhere'." });
      }
      const depPct = mode === "deposit" ? depositPctOf(b0.depositPct == null || b0.depositPct === "" ? 20 : b0.depositPct) : null;
      if (mode === "deposit" && !depPct) {
        console.log("office booking refused: deposit % |", b0.depositPct);
        return res.status(400).json({ error: `The deposit has to be between ${DEPOSIT_MIN}% and ${DEPOSIT_MAX}% of the total.` });
      }
      b.ref = makeRef(b.date);
      b.paid = mode === "paid";
      b.confirmed = true;
      const s = bookingSummary(b, hasOverride ? 0 : fare, b.childSeats, b.trailer, ret);
      if (hasOverride) s.total = override;
      const tag = b.paid ? " (PAID)" : hasOverride ? " (agreed price)" : "";
      s.text = s.text
        .replace(/^Fare: \$0 (one-way|for \d+ hours.*)\n/m, "")
        .replace(/^Return fare: \$0 .*\n/m, "")
        .replace(/TOTAL: \$\d+/, "TOTAL: $" + s.total + tag);

      if (depPct) {
        const dc = depositCents(Math.round(s.total * 100), depPct);
        if (dc <= 0 || dc >= Math.round(s.total * 100)) return res.status(400).json({ error: "That total is too small to split into a deposit - send a normal payment link instead." });
      }
      await saveWebBooking({ ...b, userAgent: "office" }, s, b.paid ? "paid" : "confirmed");
      if (depPct) {
        await pool.query(`UPDATE web_bookings SET deposit_pct = $2 WHERE ref = $1`, [b.ref, depPct]);
        addDeposit(s, { total_cents: Math.round(s.total * 100), deposit_pct: depPct }, false);
      }

      let payUrl = null;
      if (mode !== "paid") {
        const row = await getWebBooking(b.ref);
        payUrl = await paymentUrlFor(row);
      }
      let emailed = null;
      if (b.email) { await emailGuestConfirmation(b, s, payUrl); emailed = b.email; }
      mailer.sendMail({
        from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`,
        to: BOOKINGS_EMAIL, replyTo: b.email || undefined,
        subject: `OFFICE booking${b.paid ? " (paid elsewhere)" : depPct ? `, ${depPct}% deposit link sent ($${s.depositDue})` : ", payment link sent"}: ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time}) [${b.ref}]`,
        text: `OFFICE BOOKING — made from the admin page\n\n${s.text}\n` +
              (payUrl ? `\n${depPct ? `Deposit link ($${s.depositDue}, ${depPct}%)` : "Payment link"}: ${payUrl}\n` : "") +
              (depPct ? `\nThe $${s.total - s.depositDue} balance is NOT requested automatically - send it from the admin page (Web bookings > Send balance link) when you're ready.\n` : ""),
      }).catch((e) => console.error("office booking copy:", e.message));
      console.log("office booking:", b.ref, mode + (depPct ? " " + depPct + "%" : ""), emailed ? "emailed" : "no guest email");
      res.json({ ok: true, ref: b.ref, total: s.total, emailed, payUrl, deposit: s.depositDue || 0, depositPct: depPct || null });
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

  /* ---- the balance of a deposit booking -----------------------------------
     Asking for it is the office's call (Aman, 20 Oct 2026): this sends the
     guest a link for what is owing - the same balance link an upward amend
     makes, so the webhook settles it the same way - and hands the link back
     so it can also go by text or WhatsApp. Pressing it again re-sends the
     same link rather than minting a second one. */
  app.post("/admin/web-booking/balance-link", requireAdmin, async (req, res) => {
    try {
      if (!stripe) return res.status(503).json({ error: "Payments are not configured, so no link can be made." });
      const ref = String((req.body && req.body.ref) || "").trim();
      const r = ref ? await getWebBooking(ref) : null;
      if (!r) return res.status(404).json({ error: "No booking with that reference." });
      if (r.status !== "paid") return res.status(409).json({ error: r.status === "confirmed" ? "The deposit hasn't been paid yet - Resend sends the deposit link." : "That booking has nothing owing." });
      if (!(r.balance_cents > 0)) return res.status(409).json({ error: "Nothing is owing on that booking - it is paid in full." });
      const payUrl = balanceUrlFor(r) || await createBalanceLinkFor(r, r.balance_cents);
      const fresh = await getWebBooking(ref);
      const b = rowToBooking(fresh);
      const to = String((req.body && req.body.to) || "").trim() || fresh.passenger_email || "";
      if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "That doesn't look like an email address." });
      b.email = to;
      const s = summaryForRow(fresh, b);
      let emailed = null;
      if (to && mailer) { await emailGuestConfirmation(b, s, payUrl); emailed = to; }
      if (mailer) mailer.sendMail({
        from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`, to: BOOKINGS_EMAIL, replyTo: to || undefined,
        subject: `BALANCE LINK sent: $${s.balance} on ${ref} - ${r.pickup} -> ${r.dropoff} (${r.pickup_date_text} ${r.pickup_time})`,
        text: `Balance link for ${ref}: $${s.balance} owing of $${s.total}.\n${emailed ? "Emailed to " + emailed : "NOT emailed - no address on the booking"}.\n\nLink: ${payUrl}\n\n${s.text}\n`,
      }).catch((e) => console.error("balance link copy:", e.message));
      console.log("balance link:", ref, "$" + s.balance, emailed ? "emailed" : "not emailed");
      res.json({ ok: true, ref, balance: s.balance, payUrl, emailed });
    } catch (err) {
      console.error("balance link:", err);
      res.status(500).json({ error: "Could not make the balance link." });
    }
  });

  /* The balance was taken another way - cash on the day, a bank transfer.
     The booking becomes paid in full; any open balance link is switched off.
     Marked in balance_pis so a later refund knows Stripe never held it. */
  app.post("/admin/web-booking/balance-paid", requireAdmin, async (req, res) => {
    try {
      const ref = String((req.body && req.body.ref) || "").trim();
      const r = ref ? await getWebBooking(ref) : null;
      if (!r) return res.status(404).json({ error: "No booking with that reference." });
      if (r.status !== "paid" || !(r.balance_cents > 0)) return res.status(409).json({ error: "Nothing is owing on that booking." });
      const how = String((req.body && req.body.how) || "").trim().slice(0, 120) || "settled with the office";
      const pis = String(r.balance_pis || "").split(",").map((x) => x.trim()).filter(Boolean);
      pis.push("manual:" + r.balance_cents);
      await pool.query(`UPDATE web_bookings SET balance_cents = 0, balance_link_id = NULL, balance_link_url = NULL, balance_pis = $2 WHERE ref = $1`, [ref, pis.join(",")]);
      if (r.balance_link_id && stripe) {
        await stripe.paymentLinks.update(r.balance_link_id, { active: false, inactive_message: "This balance has already been settled. If you need anything, call or text +61 481 437 772." })
          .catch((e) => console.error("balance paid: link off:", e.message));
      }
      const owed = Math.round(r.balance_cents / 100);
      const fresh = await getWebBooking(ref);
      const b = rowToBooking(fresh);
      const s = summaryForRow(fresh, b);
      const notify = req.body && (req.body.notifyGuest === true || req.body.notifyGuest === "true");
      let emailed = null;
      if (notify && b.email && mailer) {
        try { await emailGuestConfirmation(b, s, null); emailed = b.email; } catch (e) { console.error("balance paid guest email:", e.message); }
      }
      if (mailer) mailer.sendMail({
        from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`, to: BOOKINGS_EMAIL,
        subject: `BALANCE settled by hand: $${owed} on ${ref} - now paid in full`,
        text: `The $${owed} balance on ${ref} was marked paid from the admin page (${how}). The booking is now paid in full.\n` +
              (emailed ? `Guest sent a paid-in-full confirmation at ${emailed}.\n` : "Guest not emailed.\n") + `\n${s.text}\n`,
      }).catch((e) => console.error("balance paid copy:", e.message));
      console.log("balance settled by hand:", ref, "$" + owed, how);
      res.json({ ok: true, ref, settled: owed, emailed });
    } catch (err) {
      console.error("balance paid:", err);
      res.status(500).json({ error: "Could not mark that balance paid." });
    }
  });

  /* The whole fare came in another way - a bank transfer, cash, a card
     machine (Aman, 23 Oct 2026, for ST-261022-AA3C). A confirmed or
     requested booking becomes paid; its payment link is switched off so the
     guest can't pay twice. Marked "manual:" in balance_pis like a balance
     taken by hand, so a later refund knows Stripe never held the money.
     Refused when Stripe shows the booking was paid by card after all. */
  app.post("/admin/web-booking/paid-elsewhere", requireAdmin, async (req, res) => {
    try {
      const ref = String((req.body && req.body.ref) || "").trim();
      const r = ref ? await getWebBooking(ref) : null;
      if (!r) return res.status(404).json({ error: "No booking with that reference." });
      if (r.status === "paid") return res.status(409).json({ error: "That booking is already marked paid." });
      if (r.status !== "confirmed" && r.status !== "requested") {
        return res.status(409).json({ error: `That booking was ${r.status} - there is nothing to pay.` });
      }
      if (stripe) {
        const pi = await findPaymentIntent(r).catch((e) => { console.error("paid elsewhere: stripe check:", e.message); return undefined; });
        if (pi === undefined) return res.status(503).json({ error: "Couldn't check Stripe just now, so it isn't marked yet - try again in a minute." });
        if (pi) return res.status(409).json({ error: `Stripe shows ${ref} was paid by card (${pi}). Don't mark it paid another way - check the Stripe dashboard.` });
      }
      const how = String((req.body && req.body.how) || "").trim().slice(0, 120) || "paid another way";
      const cents = r.total_cents || 0;
      const pis = String(r.balance_pis || "").split(",").map((x) => x.trim()).filter(Boolean);
      pis.push("manual:" + cents);
      const up = await pool.query(
        `UPDATE web_bookings SET status = 'paid', paid_at = now(), confirmed_at = COALESCE(confirmed_at, now()),
           balance_cents = 0, balance_link_id = NULL, balance_link_url = NULL, balance_pis = $2, paid_note = $3
         WHERE ref = $1 AND status IN ('confirmed', 'requested')`, [ref, pis.join(","), how]);
      if (!up.rowCount) return res.status(409).json({ error: "That booking changed while you were looking at it - reload and check." });
      await deactivatePaymentLink(ref).catch((e) => console.error("paid elsewhere: link off:", e.message));
      const fresh = await getWebBooking(ref);
      const b = rowToBooking(fresh);
      const s = summaryForRow(fresh, b);
      const notify = req.body && (req.body.notifyGuest === true || req.body.notifyGuest === "true");
      let emailed = null;
      if (notify && b.email && mailer) {
        try { await emailGuestConfirmation(b, s, null); emailed = b.email; } catch (e) { console.error("paid elsewhere guest email:", e.message); }
      }
      if (mailer) mailer.sendMail({
        from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`, to: BOOKINGS_EMAIL,
        subject: `PAID another way: $${Math.round(cents / 100)} on ${ref} (${how}) - ${r.pickup} -> ${r.dropoff} (${r.pickup_date_text} ${r.pickup_time})`,
        text: `${ref} was marked paid from the admin page: $${Math.round(cents / 100)}, ${how}. Its payment link is switched off.\n` +
              (emailed ? `Guest sent a paid confirmation at ${emailed}.\n` : "Guest not emailed.\n") + `\n${s.text}\n`,
      }).catch((e) => console.error("paid elsewhere copy:", e.message));
      console.log("paid another way:", ref, "$" + Math.round(cents / 100), how);
      res.json({ ok: true, ref, paid: Math.round(cents / 100), how, emailed });
    } catch (err) {
      console.error("paid elsewhere:", err);
      res.status(500).json({ error: "Could not mark that booking paid." });
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
        .replace(/^Fare: \$0 (one-way|for \d+ hours.*)\n/m, "")
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
        const got = await refundAcross(r, -diff, { ref, reason: "booking amended by office" }).catch((e) => { console.error("amend: refund:", e.message); return null; });
        if (!got || got.short != null) {
          return res.status(409).json({ needsManual: true,
            error: `The card payment for ${ref} could not be ${got ? "fully " : ""}found in Stripe, so the $${Math.round(-diff / 100)} difference cannot be refunded automatically. ` +
                   "Refund it from the Stripe dashboard, then save again with 'settle the money by hand' ticked." });
        }
        refundId = got.ids.join(", ");
        s.refund = Math.round(-diff / 100);
      }
      /* A deposit booking's percentage, which an unpaid one may change. */
      const depPct = r.deposit_pct ? (!wasPaid && b0.depositPct != null && b0.depositPct !== "" ? depositPctOf(b0.depositPct) : r.deposit_pct) : null;
      if (r.deposit_pct && !depPct) return res.status(400).json({ error: `The deposit has to be between ${DEPOSIT_MIN}% and ${DEPOSIT_MAX}% of the total.` });

      await pool.query(
        `UPDATE web_bookings SET
           pickup = $2, dropoff = $3, vehicle = $4, pickup_date = $5, pickup_time = $6,
           passenger_name = $7, passenger_phone = $8, passenger_email = $9, flight = $10,
           address = $11, notes = $12, pax = $13, child_seats = $14, trailer = $15,
           total_cents = $16, return_date = $17, return_time = $18, return_flight = $19,
           stops = $20, hire_hours = $21, pu_address = $22, do_address = $23,
           balance_cents = 0, balance_link_id = NULL, balance_link_url = NULL, deposit_pct = $24` +
        /* An unpaid booking's link is replaced; a paid one keeps its payment history. */
        (wasPaid ? "" : ", payment_link_id = NULL, payment_link_url = NULL, link_seq = link_seq + 1") +
        ` WHERE ref = $1`,
        [ref, b.pickup, b.dropoff, b.vehicle, b.date, b.time, b.name, b.phone, b.email || null,
         b.flight || null, b.address || null, b.notes || null, b.pax, b.childSeats, b.trailer,
         newCents, b.returnDate || null, b.returnTime || null, b.returnFlight || null, stopsJson(b), hoursOf(b),
         b.pickupAddress || null, b.dropoffAddress || null, depPct]);

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
      if (wasPaid && depPct && diff > 0 && !manual && !r.balance_link_id) {
        /* A deposit booking whose balance has not been asked for yet: the new
           balance is recorded, and asking for it stays the office's call. */
        await pool.query(`UPDATE web_bookings SET balance_cents = $2 WHERE ref = $1`, [ref, diff]);
        s.balance = Math.round(diff / 100);
        s.text = s.text.replace(/\(PAID\)/, "(paid $" + Math.round(paidCents / 100) + ", balance $" + s.balance + " to pay)");
      } else if (wasPaid) {
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
      if (depPct) addDeposit(s, { total_cents: newCents, deposit_pct: depPct, balance_link_url: s.balance && payUrl ? payUrl : null }, wasPaid);
      /* A request that is not confirmed yet is not re-sent: confirming it is
         still the dispatch email's job, and that email carries the new figures. */
      let emailed = null;
      if (b.confirmed && b.email) { await emailGuestConfirmation(b, s, payUrl); emailed = b.email; }
      mailer.sendMail({
        from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`,
        to: BOOKINGS_EMAIL, replyTo: b.email || undefined,
        subject: `OFFICE amended: ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time}) [${ref}] now $${s.total}` +
                 (s.refund ? ` ($${s.refund} refunded)` : s.balance && payUrl ? ` ($${s.balance} balance link sent)` : s.balance ? ` ($${s.balance} balance owing)` : ""),
        text: `OFFICE AMENDMENT - changed from the admin page\nWas $${Math.round(wasCents / 100)}, now $${s.total}.\n` +
              (s.refund ? `Refunded $${s.refund} to the guest's card (Stripe ${refundId}).\n` : "") +
              (s.balance && payUrl ? `Guest emailed a link for the $${s.balance} balance.\n`
                : s.balance ? `$${s.balance} balance owing - not asked for yet; send the balance link from the admin page when ready.\n` : "") +
              (wasPaid && manual && diff !== 0 ? `Money settled by hand: ${diff < 0 ? "refund" : "collect"} $${Math.round(Math.abs(diff) / 100)}.\n` : "") +
              `\n${s.text}\n` +
              (payUrl && !s.balance ? `\nNew payment link: ${payUrl}\n` : "") + (oldLink ? "The previous payment link has been switched off.\n" : ""),
      }).catch((e) => console.error("office amend copy:", e.message));
      console.log("office booking amended:", ref, "$" + Math.round(wasCents / 100), "->", "$" + s.total,
        s.refund ? "refunded $" + s.refund : s.balance ? "balance $" + s.balance : wasPaid && manual ? "manual money" : "", emailed ? "emailed" : "no guest email");
      res.json({ ok: true, ref, total: s.total, was: Math.round(wasCents / 100), emailed, payUrl, status: r.status,
                 refunded: s.refund || 0, balance: s.balance || 0, balanceLink: !!(s.balance && payUrl),
                 deposit: s.depositDue || 0, depositPct: depPct || null, manual: wasPaid && manual && diff !== 0 });
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
        const got = await refundAcross(r, refundCents, { ref, reason: "booking cancelled by office" }, "cancel-" + ref + "-" + refundCents)
          .catch((e) => { console.error("cancel: refund:", e.message); return null; });
        if (!got || got.short != null) {
          return res.status(409).json({ needsManual: true,
            error: got && got.short != null
              ? `Only $${Math.round(got.short / 100)} of ${ref} was paid by card through Stripe (the rest was settled another way), so the $${Math.round(refundCents / 100)} refund cannot be made automatically. ` +
                "Refund it by hand, then cancel again with 'settle the money by hand' ticked."
              : `The card payment for ${ref} could not be found in Stripe, so the $${Math.round(refundCents / 100)} refund cannot be made automatically. ` +
                "Refund it from the Stripe dashboard, then cancel again with 'settle the money by hand' ticked." });
        }
        refundId = got.ids.join(", ");
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
        /* a deposit booking with the balance still owing has only paid the deposit */
        const what = r.deposit_pct && r.balance_cents > 0 ? "deposit" : "fare";
        const money = refundCents > 0
          ? (manual
            ? `A refund of $${Math.round(refundCents / 100)} is being arranged - we'll let you know when it has been sent.`
            : `$${Math.round(refundCents / 100)} has been refunded to the card you paid with - it usually shows within 5 to 10 business days.`)
          : paid ? (early ? `The ${what} is not refunded.` : `As the cancellation was within 24 hours of pick-up, the ${what} is not refunded, in line with our booking terms.`)
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
      /* only when the page sends it, so an older admin page can't clear it */
      if (typeof b.rateCard === "boolean") await pool.query("UPDATE agents SET rate_card = $2 WHERE code = $1", [code, b.rateCard]);
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
  return { saveWebBooking, actionLinks, findOpenWebBooking, requireAdmin, getWebBooking, rowToBooking, summaryForRow, settleBalance, settleDeposit, pool, setTripStatus, requireAgent, requireAgentAccounts, settleAgentCard };
};
