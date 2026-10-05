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
  } = ctx;
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

  app.post("/agent/quote", requireAgent, (req, res) => {
    const { pickup, dropoff } = req.body || {};
    const pct = agentPct(req.agent);
    const out = VEHICLES.map((v) => {
      const fare = computeFare(pickup, dropoff, v);
      return fare == null ? null : {
        vehicle: v,
        fare,
        commission: commissionOf(fare * 100, pct) / 100,
      };
    }).filter(Boolean);
    if (!out.length) {
      return res.json({ quotable: false, message: "We don't publish a fixed fare for that route — call +61 481 437 772 and we'll price it for you." });
    }
    res.json({ quotable: true, commissionPct: pct, vehicles: out });
  });

  /* Shared by book and amend: validate, price, and normalise one booking. */
  function priceBooking(b, pct) {
    for (const f of ["pickup", "dropoff", "vehicle", "date", "time", "name", "phone"]) {
      if (!b[f]) return { error: "Please fill in every required field." };
    }
    const fare = computeFare(b.pickup, b.dropoff, b.vehicle);
    if (fare == null) return { error: "That route needs a manual quote — please call us." };
    if (leadTimeShortfall(b.date, b.time) !== null) return { error: LEAD_TIME_ERROR };
    const seats = Math.min(Math.max(parseInt(b.childSeats, 10) || 0, 0), 3);
    const trailer = b.trailer === true || b.trailer === "true";
    const s = bookingSummary({ ...b, email: b.agentEmail || BOOKINGS_EMAIL }, fare, seats, trailer);
    const totalCents = Math.round(s.total * 100);
    return {
      seats, trailer, summary: s, totalCents,
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
      const p = priceBooking(b, pct);
      if (p.error) return res.status(400).json({ error: p.error });
      b.ref = makeRef(b.date);

      await pool.query(
        `INSERT INTO agent_bookings
           (ref, agent_code, pickup, dropoff, vehicle, pickup_date, pickup_time,
            passenger_name, passenger_phone, passenger_email, flight, address, notes,
            pax, child_seats, trailer, total_cents, commission_cents, commission_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [b.ref, req.agent.code, b.pickup, b.dropoff, b.vehicle, b.date, b.time,
         b.name, b.phone, b.email || null, b.flight || null, b.address || null, b.notes || null,
         p.pax, p.seats, p.trailer, p.totalCents, p.commissionCents, pct]
      );

      notifyOffice(
        `AGENT booking (${req.agent.code}): ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time}) [${b.ref}]`,
        `AGENT BOOKING — ${req.agent.name} (${req.agent.code})\n\n${p.summary.text}\n\n` +
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
            `Hi ${req.agent.name},\n\nYour booking is in and we'll confirm the chauffeur shortly.\n\n${p.summary.text}\n\n` +
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
      const p = priceBooking(b, pct);
      if (p.error) return res.status(400).json({ error: p.error });

      await pool.query(
        `UPDATE agent_bookings SET
           pickup=$2, dropoff=$3, vehicle=$4, pickup_date=$5, pickup_time=$6,
           passenger_name=$7, passenger_phone=$8, passenger_email=$9, flight=$10,
           address=$11, notes=$12, pax=$13, child_seats=$14, trailer=$15,
           total_cents=$16, commission_cents=$17, commission_pct=$18, updated_at=now()
         WHERE ref = $1`,
        [old.ref, b.pickup, b.dropoff, b.vehicle, b.date, b.time,
         b.name, b.phone, b.email || null, b.flight || null, b.address || null, b.notes || null,
         p.pax, p.seats, p.trailer, p.totalCents, p.commissionCents, pct]
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
      const rows = [
        ["ROUTE", `${bk.pickup}   →   ${bk.dropoff}`],
        ["DATE & TIME", `${date} at ${bk.pickup_time}`],
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
  });

  app.get("/agent/summary", requireAgent, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM agent_bookings WHERE agent_code = $1 ORDER BY created_at DESC LIMIT 200`,
        [req.agent.code]);
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
  const WEB_STATUSES = ["requested", "confirmed", "declined", "paid"];

  const webRow = (r) => ({
    ref: r.ref, created: r.created_at,
    date: r.pickup_date, time: r.pickup_time,
    pickup: r.pickup, dropoff: r.dropoff, vehicle: r.vehicle,
    name: r.passenger_name, phone: r.passenger_phone, email: r.passenger_email,
    flight: r.flight, address: r.address, notes: r.notes,
    pax: r.pax, childSeats: r.child_seats, trailer: r.trailer,
    total: r.total_cents / 100, status: r.status,
    confirmedAt: r.confirmed_at, declinedAt: r.declined_at, paidAt: r.paid_at,
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
          trailer, total_cents, status, user_agent, confirmed_at, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               CASE WHEN $17 IN ('confirmed','paid') THEN now() END,
               CASE WHEN $17 = 'paid' THEN now() END)
       ON CONFLICT (ref) DO UPDATE SET
         /* Never walk a booking backwards. The webhook and a later re-save can
            arrive in either order, and paid is the end of the line. */
         status       = CASE WHEN web_bookings.status = 'paid' THEN 'paid'
                             ELSE EXCLUDED.status END,
         total_cents  = GREATEST(web_bookings.total_cents, EXCLUDED.total_cents),
         confirmed_at = COALESCE(web_bookings.confirmed_at, EXCLUDED.confirmed_at),
         paid_at      = COALESCE(web_bookings.paid_at, EXCLUDED.paid_at)`,
      [ref, b.pickup || null, b.dropoff || null, b.vehicle || null, date, b.time || null,
       b.name || null, b.phone || null, b.email || null, b.flight || null,
       b.address || null, b.notes || null,
       parseInt(b.pax, 10) || 1, parseInt(b.childSeats, 10) || 0,
       b.trailer === true || b.trailer === "true",
       cents, status, String(b.userAgent || "").slice(0, 300) || null]
    );
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
      `SELECT *, to_char(pickup_date, 'YYYY-MM-DD') AS pickup_date_text
         FROM web_bookings WHERE ref = $1`, [ref]);
    return rows[0] || null;
  }
  async function setWebStatus(ref, status) {
    await pool.query(
      `UPDATE web_bookings SET
         status       = $2,
         confirmed_at = CASE WHEN $2 = 'confirmed' THEN COALESCE(confirmed_at, now()) ELSE confirmed_at END,
         declined_at  = CASE WHEN $2 = 'declined'  THEN COALESCE(declined_at,  now()) ELSE declined_at  END
       WHERE ref = $1 AND status <> 'paid'`, [ref, status]);
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

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: "aud",
            unit_amount: r.total_cents,
            product_data: {
              name: `Airport transfer — ${r.vehicle}`,
              description: `${r.pickup} → ${r.dropoff} · ${r.pickup_date_text || ""} ${r.pickup_time || ""} · Ref ${r.ref}`,
            },
          },
          quantity: 1,
        }],
        customer_email: r.passenger_email || undefined,
        /* The same shape the webhook already reads, and critically the ORIGINAL
           ref - /create-checkout mints a fresh one, which is why a guest's
           payment used to carry a different reference from their confirmation. */
        metadata: {
          ref: r.ref, pickup: String(r.pickup || ""), dropoff: String(r.dropoff || ""),
          vehicle: String(r.vehicle || ""), date: String(r.pickup_date_text || ""),
          time: String(r.pickup_time || ""), pax: String(r.pax || ""),
          flight: String(r.flight || ""), child_seats: String(r.child_seats || 0),
          trailer: r.trailer ? "yes" : "no",
          passenger_name: String(r.passenger_name || ""), phone: String(r.passenger_phone || ""),
          pickup_address: String(r.address || ""), notes: String(r.notes || "").slice(0, 450),
        },
        success_url: process.env.SUCCESS_URL || "https://www.skytransfers.com.au/?booking=confirmed",
        cancel_url: process.env.CANCEL_URL || "https://www.skytransfers.com.au/?booking=cancelled",
      }, {
        /* A double click, or the office opening the link twice, returns the
           very same session rather than a second payment page. */
        idempotencyKey: "approve-" + r.ref,
      });

      await setWebStatus(r.ref, "confirmed");

      if (mailer && r.passenger_email) {
        await mailer.sendMail({
          from: `"Sky Transfers" <${process.env.GMAIL_USER}>`,
          to: r.passenger_email, replyTo: BOOKINGS_EMAIL,
          subject: `Booking confirmed — Sky Transfers · ${r.ref}`,
          text: `Hi ${r.passenger_name},\n\nGood news — your transfer is confirmed. Your chauffeur is booked.\n\n` +
                `${rowLines(r)}\n\nTo secure it, pay here:\n${session.url}\n\n` +
                `We track your flight and your chauffeur meets you with a name board. Free changes up to 24 hours ` +
                `before pick-up — reply to this email or call +61 481 437 772.\n\n` +
                `Sky Transfers — Gold Coast & Brisbane airport transfers\nwww.skytransfers.com.au`,
          html: `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#333B4C;max-width:540px">
<h1 style="font:400 26px/1.3 Georgia,serif;color:#141D30;margin:0 0 14px">Your transfer is confirmed</h1>
<p style="margin:0 0 20px">Hi ${esc(r.passenger_name)}, your chauffeur is booked. Pay below to secure it.</p>
<p style="margin:0 0 24px"><a href="${esc(session.url)}" style="display:inline-block;background:#C9A227;color:#141D30;font-weight:700;text-decoration:none;padding:15px 28px;border-radius:9px">Pay ${esc(rowMoney(r))} now</a></p>
<pre style="font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;background:#F7F4ED;border:1px solid #E5E0D2;border-radius:10px;padding:16px;white-space:pre-wrap;margin:0">${esc(rowLines(r))}</pre>
<p style="margin:18px 0 0;font-size:14px;color:#68707F">Free changes up to 24 hours before pick-up &mdash; reply to this email or call +61 481 437 772.</p></div>`,
        });
      }
      if (mailer) {
        await mailer.sendMail({
          from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`,
          to: BOOKINGS_EMAIL, replyTo: r.passenger_email || undefined,
          subject: `CONFIRMED, awaiting payment: ${r.pickup} -> ${r.dropoff} [${r.ref}]`,
          text: `Confirmed from the dispatch email. The guest has the payment link.\n\n${rowLines(r)}\n\n${session.url}\n`,
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

  app.get("/admin/web-bookings", requireAdmin, async (req, res) => {
    try {
      const status = String(req.query.status || "").trim().toLowerCase();
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
      const filtered = WEB_STATUSES.includes(status);
      const { rows } = await pool.query(
        `SELECT * FROM web_bookings ${filtered ? "WHERE status = $2" : ""}
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

  return initAgentSchema()
    .then(seedAgents)
    .then(() => console.log(
      AGENTS_ON
        ? `Agent portal ready (admin ${ADMIN_PIN ? "on" : "OFF — set ADMIN_PIN"})`
        : "Agent portal off (set DATABASE_URL and AGENT_SECRET)"))
    .catch((e) => console.error("Agent portal setup failed:", e.message));

  /* stripe-server.js records public-site bookings through this. */
  return { saveWebBooking, actionLinks, findOpenWebBooking };
};
