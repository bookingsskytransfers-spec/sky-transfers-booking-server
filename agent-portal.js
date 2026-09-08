/**
 * Sky Transfers — agent portal
 * ----------------------------
 * Mounted by stripe-server.js, which passes in everything it already owns:
 * the fare table, the lead-time rule, the mailer and the booking formatter.
 * Kept in its own file so the portal can change without rewriting the
 * payment server around it.
 */
module.exports = function installAgentPortal(ctx) {
  const {
    app, computeFare, VEHICLES, leadTimeShortfall, LEAD_TIME_ERROR,
    makeRef, bookingSummary, mailer, BOOKINGS_EMAIL, PLACES_FOR_AGENTS,
  } = ctx;
  const { Pool } = require("pg");
  const crypto = require("crypto");

  const AGENT_SECRET = process.env.AGENT_SECRET || "";
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

  /* One idempotent migration at boot. The alternative — a migration tool and a
     deploy step — is more machinery than two tables are worth. */
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
      CREATE INDEX IF NOT EXISTS agent_bookings_by_agent
        ON agent_bookings (agent_code, created_at DESC);
    `);
  }


  /* ---- who the agents are ---------------------------------------------
     Seeded from one environment variable rather than an admin screen, because
     a handful of DMCs does not justify a second application to build, secure
     and maintain. Aman edits AGENT_SEED in the Render dashboard and redeploys.

     AGENT_SEED = [{"code":"NEXUS","name":"Nexus Travel","email":"ops@nexus.com","pct":12.5,"pin":"4821"}]

     Name, email and rate are applied every boot, so changing a commission is an
     edit and a redeploy. The PIN is only ever written when the agent is created
     — otherwise a redeploy would silently reset a PIN the agent had been given,
     and rotating one stays a deliberate act (clear the row, or change the code).
     Remove an agent by setting "active": false, never by deleting the row: the
     bookings that justify their wallet balance point at it. */
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
     payload.signature, no library. Twelve hours, long enough for a working day
     and short enough that a shared office computer forgets by morning. */
  const TOKEN_TTL_MS = 12 * 3600 * 1000;
  function signToken(code) {
    const body = Buffer.from(JSON.stringify({ code, exp: Date.now() + TOKEN_TTL_MS })).toString("base64url");
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

  async function requireAgent(req, res, next) {
    if (!AGENTS_ON) return res.status(503).json({ error: "The agent portal is not configured on this server." });
    const claim = readToken((req.headers.authorization || "").replace(/^Bearer /, ""));
    if (!claim) return res.status(401).json({ error: "Your session has expired — please sign in again." });
    const { rows } = await pool.query(
      "SELECT code, name, email, commission_pct, active FROM agents WHERE code = $1", [claim.code]);
    if (!rows.length || !rows[0].active) return res.status(401).json({ error: "This account is no longer active." });
    req.agent = rows[0];
    next();
  }

  const agentPct = (a) => Number(a.commission_pct);
  const commissionCents = (totalCents, pct) => Math.round(totalCents * pct) / 100;

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
      res.json({ token: signToken(a.code), name: a.name, code: a.code, commissionPct: agentPct(a) });
    } catch (err) {
      console.error("agent login:", err);
      res.status(500).json({ error: "Could not sign you in just now." });
    }
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
        commission: commissionCents(fare * 100, pct) / 100,
      };
    }).filter(Boolean);
    if (!out.length) {
      return res.json({ quotable: false, message: "We don't publish a fixed fare for that route — call +61 481 437 772 and we'll price it for you." });
    }
    res.json({ quotable: true, commissionPct: pct, vehicles: out });
  });

  app.post("/agent/book", requireAgent, async (req, res) => {
    try {
      const b = req.body || {};
      for (const f of ["pickup", "dropoff", "vehicle", "date", "time", "name", "phone"]) {
        if (!b[f]) return res.status(400).json({ error: "Please fill in every required field." });
      }
      const fare = computeFare(b.pickup, b.dropoff, b.vehicle);
      if (fare == null) return res.status(400).json({ error: "That route needs a manual quote — please call us." });
      if (leadTimeShortfall(b.date, b.time) !== null) return res.status(400).json({ error: LEAD_TIME_ERROR });

      const seats = Math.min(Math.max(parseInt(b.childSeats, 10) || 0, 0), 3);
      const trailer = b.trailer === true || b.trailer === "true";
      const pct = agentPct(req.agent);
      b.ref = makeRef(b.date);
      /* The agent's own contact details go on the booking, so the chauffeur and
         dispatch have someone to call, and the guest is not emailed by us — the
         agent owns that relationship. */
      const s = bookingSummary({ ...b, email: req.agent.email || BOOKINGS_EMAIL }, fare, seats, trailer);
      const totalCents = Math.round(s.total * 100);
      const commCents = Math.round(commissionCents(totalCents, pct));

      await pool.query(
        `INSERT INTO agent_bookings
           (ref, agent_code, pickup, dropoff, vehicle, pickup_date, pickup_time,
            passenger_name, passenger_phone, passenger_email, flight, address, notes,
            pax, child_seats, trailer, total_cents, commission_cents, commission_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [b.ref, req.agent.code, b.pickup, b.dropoff, b.vehicle, b.date, b.time,
         b.name, b.phone, b.email || null, b.flight || null, b.address || null, b.notes || null,
         parseInt(b.pax, 10) || 1, seats, trailer, totalCents, commCents, pct]
      );

      if (mailer) {
        const money = (c) => `$${(c / 100).toFixed(2)}`;
        const body =
          `AGENT BOOKING — ${req.agent.name} (${req.agent.code})\n\n${s.text}\n\n` +
          `Agent commission: ${pct}% = ${money(commCents)}\n` +
          `Net to invoice the agent: ${money(totalCents - commCents)}\n`;
        await mailer.sendMail({
          from: `"Sky Transfers Agent Portal" <${process.env.GMAIL_USER}>`,
          to: BOOKINGS_EMAIL,
          replyTo: req.agent.email || BOOKINGS_EMAIL,
          subject: `AGENT booking (${req.agent.code}): ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time}) [${b.ref}]`,
          text: body,
        }).catch((e) => console.error("agent booking email:", e.message));
        if (req.agent.email) {
          await mailer.sendMail({
            from: `"Sky Transfers" <${process.env.GMAIL_USER}>`,
            to: req.agent.email,
            replyTo: BOOKINGS_EMAIL,
            subject: `Booking confirmed — ${b.ref} · Sky Transfers`,
            text:
              `Hi ${req.agent.name},\n\nYour booking is in and we'll confirm the chauffeur shortly.\n\n${s.text}\n\n` +
              `Your commission on this booking: ${money(commCents)} (${pct}%)\n` +
              `This booking will appear on your monthly invoice at ${money(totalCents - commCents)}.\n\n` +
              `Anything urgent, call +61 481 437 772.\n\nSky Transfers`,
          }).catch((e) => console.error("agent copy email:", e.message));
        }
      }

      res.json({ ok: true, ref: b.ref, total: s.total, commission: commCents / 100 });
    } catch (err) {
      console.error("agent book:", err);
      res.status(500).json({ error: "Could not save that booking — please call us so it isn't lost." });
    }
  });

  app.get("/agent/summary", requireAgent, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ref, pickup, dropoff, vehicle, pickup_date, pickup_time, passenger_name,
                total_cents, commission_cents, status, settled, created_at
           FROM agent_bookings
          WHERE agent_code = $1
          ORDER BY created_at DESC
          LIMIT 100`, [req.agent.code]);
      /* The wallet is derived, never stored — a stored balance is one failed
         write away from disagreeing with the bookings that justify it. */
      const live = rows.filter((r) => r.status === "confirmed");
      const earned = live.reduce((n, r) => n + r.commission_cents, 0);
      const paid = live.filter((r) => r.settled).reduce((n, r) => n + r.commission_cents, 0);
      res.json({
        agent: { code: req.agent.code, name: req.agent.name, commissionPct: agentPct(req.agent) },
        wallet: { earned: earned / 100, paid: paid / 100, balance: (earned - paid) / 100 },
        bookings: rows.map((r) => ({
          ref: r.ref,
          route: `${r.pickup} → ${r.dropoff}`,
          vehicle: r.vehicle,
          date: r.pickup_date instanceof Date ? r.pickup_date.toISOString().slice(0, 10) : r.pickup_date,
          time: r.pickup_time,
          passenger: r.passenger_name,
          total: r.total_cents / 100,
          commission: r.commission_cents / 100,
          status: r.status,
          settled: r.settled,
        })),
      });
    } catch (err) {
      console.error("agent summary:", err);
      res.status(500).json({ error: "Could not load your bookings just now." });
    }
  });

  return initAgentSchema()
    .then(seedAgents)
    .then(() => console.log(AGENTS_ON ? "Agent portal ready" : "Agent portal off (set DATABASE_URL and AGENT_SECRET)"))
    .catch((e) => console.error("Agent portal setup failed:", e.message));
};
