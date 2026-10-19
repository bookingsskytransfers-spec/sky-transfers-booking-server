/**
 * Sky Transfers — operations: the jobs board, drivers, vehicles, dispatch
 * ----------------------------------------------------------------------
 * Phase 1 of replacing Limo Anywhere. Mounted by stripe-server.js after the
 * agent portal, whose database pool and admin login it borrows.
 *
 * The jobs board holds NO copy of a booking. Website bookings, agent
 * bookings and office/account jobs each live in their own table, and every
 * read here goes back to that table - so an amendment, a refund or a
 * cancellation made anywhere else shows on the board immediately and a
 * driver can never be sent yesterday's address. What this module owns is
 * only what those tables do not have: who is driving, in what, for how much,
 * and how far through the job they are.
 *
 *   ops_drivers    drivers and subcontractors, with their pay rule
 *   ops_vehicles   the fleet, including subcontractors' own cars
 *   ops_jobs       jobs that exist nowhere else - account work emailed or
 *                  phoned in (Rallys, Krishiv, Phoenix ...), priced by hand
 *   ops_dispatch   one row per leg: driver, car, driver pay, progress
 *
 * A return booking is two legs ('out' and 'ret') because the two halves are
 * usually driven by different people on different days.
 *
 * Drivers reach their own jobs through a signed link (driver.html#t=...).
 * The token carries a driver id and a link version: no expiry, because a
 * driver keeps the link on their phone, but "Reset link" in the office bumps
 * the version and every old copy stops working. A driver sees their own
 * legs only, and never what the guest paid.
 */
module.exports = function installOps(ctx) {
  const { app, pool, requireAdmin, VEHICLES, makeRef, mailer, BOOKINGS_EMAIL } = ctx;
  if (!app || !pool || typeof requireAdmin !== "function") {
    console.log("Ops off (needs the agent portal's database and admin login)");
    return { on: false };
  }
  const crypto = require("crypto");
  const SECRET = process.env.AGENT_SECRET || "";
  /* A key of its own, derived from the portal secret, so a driver link and an
     admin session can never be mistaken for one another even in principle. */
  const KEY = crypto.createHmac("sha256", SECRET).update("sky-driver-link-v1").digest();
  const SITE = String(process.env.PUBLIC_SITE_URL || "https://www.skytransfers.com.au").replace(/\/+$/, "");

  /* Filled in by modules mounted later: hooks.step({ref, leg, status}) runs
     after a driver (or the office) moves a leg on, and must not throw. */
  const hooks = {};

  const STATUSES = ["unassigned", "assigned", "accepted", "on_way", "on_location", "pob", "done", "declined"];
  /* What a driver may press, and the order they come in. */
  const DRIVER_STEPS = { accepted: "accepted_at", on_way: "on_way_at", on_location: "on_location_at", pob: "pob_at", done: "done_at" };
  const DRIVER_FROM = {
    accepted: ["assigned", "declined"],
    on_way: ["assigned", "accepted"],
    on_location: ["accepted", "on_way"],
    pob: ["on_way", "on_location"],
    done: ["on_location", "pob"],
    declined: ["assigned", "accepted"],
  };

  const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const hhmm = (v) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(v || "")); return m && +m[1] < 24 && +m[2] < 60 ? m[1].padStart(2, "0") + ":" + m[2] : null; };
  const txt = (v, n) => String(v == null ? "" : v).trim().slice(0, n || 200);
  const int = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt; };
  const cents = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
  /* Brisbane is UTC+10 all year, so "today" is arithmetic, not a locale. */
  const bneToday = (offsetDays) => new Date(Date.now() + 10 * 3600e3 + (offsetDays || 0) * 86400e3).toISOString().slice(0, 10);
  const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
  /* An explicit IN ($1, $2, ...) list rather than an array parameter: plain
     SQL that every Postgres and every test double reads the same way. */
  const inList = (n) => Array.from({ length: n }, (_, i) => "$" + (i + 1)).join(", ");
  const minutesOf = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); return m ? +m[1] * 60 + +m[2] : null; };

  /* ---- schema ------------------------------------------------------------ */
  async function initOpsSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ops_drivers (
        id               SERIAL PRIMARY KEY,
        name             TEXT NOT NULL,
        phone            TEXT NOT NULL DEFAULT '',
        email            TEXT,
        kind             TEXT NOT NULL DEFAULT 'employee',
        pay_type         TEXT NOT NULL DEFAULT 'fixed',
        pay_value        NUMERIC(10,2) NOT NULL DEFAULT 0,
        licence_expiry   DATE,
        authority_expiry DATE,
        own_vehicle      BOOLEAN NOT NULL DEFAULT FALSE,
        notes            TEXT,
        active           BOOLEAN NOT NULL DEFAULT TRUE,
        link_version     INTEGER NOT NULL DEFAULT 1,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ops_vehicles (
        id               SERIAL PRIMARY KEY,
        label            TEXT NOT NULL,
        class            TEXT NOT NULL DEFAULT '',
        rego             TEXT,
        seats            INTEGER,
        owner_driver_id  INTEGER REFERENCES ops_drivers(id),
        rego_expiry      DATE,
        insurance_expiry DATE,
        service_due      DATE,
        notes            TEXT,
        active           BOOLEAN NOT NULL DEFAULT TRUE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ops_jobs (
        ref              TEXT PRIMARY KEY,
        account          TEXT,
        account_ref      TEXT,
        pickup           TEXT NOT NULL,
        dropoff          TEXT NOT NULL,
        vehicle          TEXT NOT NULL DEFAULT '',
        pickup_date      DATE NOT NULL,
        pickup_time      TEXT NOT NULL,
        return_date      DATE,
        return_time      TEXT,
        return_flight    TEXT,
        hire_hours       INTEGER,
        passenger_name   TEXT NOT NULL DEFAULT '',
        passenger_phone  TEXT NOT NULL DEFAULT '',
        passenger_email  TEXT,
        flight           TEXT,
        address          TEXT,
        notes            TEXT,
        pax              INTEGER NOT NULL DEFAULT 1,
        child_seats      INTEGER NOT NULL DEFAULT 0,
        trailer          BOOLEAN NOT NULL DEFAULT FALSE,
        price_cents      INTEGER NOT NULL DEFAULT 0,
        status           TEXT NOT NULL DEFAULT 'confirmed',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS ops_jobs_date ON ops_jobs (pickup_date);
      CREATE TABLE IF NOT EXISTS ops_dispatch (
        ref              TEXT NOT NULL,
        leg              TEXT NOT NULL DEFAULT 'out',
        driver_id        INTEGER REFERENCES ops_drivers(id),
        vehicle_id       INTEGER REFERENCES ops_vehicles(id),
        driver_pay_cents INTEGER,
        status           TEXT NOT NULL DEFAULT 'unassigned',
        office_note      TEXT,
        sent_at          TIMESTAMPTZ,
        assigned_at      TIMESTAMPTZ,
        accepted_at      TIMESTAMPTZ,
        on_way_at        TIMESTAMPTZ,
        on_location_at   TIMESTAMPTZ,
        pob_at           TIMESTAMPTZ,
        done_at          TIMESTAMPTZ,
        declined_at      TIMESTAMPTZ,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (ref, leg)
      );
      CREATE INDEX IF NOT EXISTS ops_dispatch_driver ON ops_dispatch (driver_id);
      /* Phase 2: when the driver was paid for this leg (billing.js pay sheet). */
      ALTER TABLE ops_dispatch ADD COLUMN IF NOT EXISTS driver_paid_at TIMESTAMPTZ;
      /* Autopilot: chosen by the system rather than the office, and every
         driver who has turned this leg down, so it is never offered back. */
      ALTER TABLE ops_dispatch ADD COLUMN IF NOT EXISTS auto_assigned BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE ops_dispatch ADD COLUMN IF NOT EXISTS declined_ids TEXT;
      /* An account job read from an email needs a human glance. */
      ALTER TABLE ops_jobs ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE ops_jobs ADD COLUMN IF NOT EXISTS source_note TEXT;
      -- Phase 3 guest updates (guest-updates.js): the driver the guest was told
      -- about, and when the on-the-way and arrived messages went.
      ALTER TABLE ops_dispatch ADD COLUMN IF NOT EXISTS guest_assigned_for INTEGER;
      ALTER TABLE ops_dispatch ADD COLUMN IF NOT EXISTS guest_onway_at TIMESTAMPTZ;
      ALTER TABLE ops_dispatch ADD COLUMN IF NOT EXISTS guest_arrived_at TIMESTAMPTZ;
      -- Phase 4 (la-import.js): the key that stops a Limo Anywhere row being
      -- imported twice.
      ALTER TABLE ops_jobs ADD COLUMN IF NOT EXISTS import_key TEXT;
      -- Stops along the way on an account job: a JSON list of addresses.
      ALTER TABLE ops_jobs ADD COLUMN IF NOT EXISTS stops TEXT;
      CREATE INDEX IF NOT EXISTS ops_jobs_import_key ON ops_jobs (import_key);
    `);
    /* The board reads web_bookings.stops. agent-portal.js adds that column
       too, but this must not depend on which module's setup ran first. A
       separate statement, so a missing web_bookings table can't stop the
       schema above. */
    await pool.query(`ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS stops TEXT`)
      .catch((e) => console.error("ops: web_bookings.stops:", e.message));
    /* Agent bookings gained a return leg, hours and the agency's own
       reference (agent-portal.js adds them too); same reasoning. */
    await pool.query(`
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS client_ref    TEXT;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS return_date   DATE;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS return_time   TEXT;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS return_flight TEXT;
      ALTER TABLE agent_bookings ADD COLUMN IF NOT EXISTS hire_hours    INTEGER;
    `).catch((e) => console.error("ops: agent_bookings v2 columns:", e.message));
  }

  /* ---- reading every booking source as legs ------------------------------
     Three plain SELECTs merged here rather than one UNION in SQL: each source
     has its own column names and status words, and this keeps every one of
     them readable and individually testable. */
  const WEB_COLS = `ref, pickup, dropoff, vehicle,
    to_char(pickup_date, 'YYYY-MM-DD') AS d, pickup_time AS t,
    to_char(return_date, 'YYYY-MM-DD') AS rd, return_time AS rt, return_flight AS rf,
    hire_hours, passenger_name, passenger_phone, passenger_email, flight, address, notes,
    pax, child_seats, trailer, total_cents, status, balance_cents, stops`;
  const AGENT_COLS = `a.ref, a.pickup, a.dropoff, a.vehicle,
    to_char(a.pickup_date, 'YYYY-MM-DD') AS d, a.pickup_time AS t,
    a.passenger_name, a.passenger_phone, a.passenger_email, a.flight, a.address, a.notes,
    a.pax, a.child_seats, a.trailer, a.total_cents, a.status, a.agent_code, g.name AS agent_name,
    a.client_ref AS account_ref, to_char(a.return_date, 'YYYY-MM-DD') AS rd, a.return_time AS rt,
    a.return_flight AS rf, a.hire_hours`;
  const JOB_COLS = `ref, account, account_ref, pickup, dropoff, vehicle,
    to_char(pickup_date, 'YYYY-MM-DD') AS d, pickup_time AS t,
    to_char(return_date, 'YYYY-MM-DD') AS rd, return_time AS rt, return_flight AS rf,
    hire_hours, passenger_name, passenger_phone, passenger_email, flight, address, notes,
    pax, child_seats, trailer, price_cents, status, needs_review, source_note, stops`;

  /* Stops are on the outbound journey only. A website booking stores
     {list:[{address}]}; an account job a plain list of addresses. */
  function stopList(v) {
    try {
      const j = v ? JSON.parse(v) : null;
      const list = Array.isArray(j) ? j : j && Array.isArray(j.list) ? j.list : [];
      return list.map((x) => (typeof x === "string" ? x : x && (x.address || x.suburb) || "")).filter(Boolean).slice(0, 3);
    } catch (e) { return []; }
  }

  function legsOf(r, source) {
    const total = source === "account" ? (r.price_cents || 0) : (r.total_cents || 0);
    const hasRet = !!(r.rd && r.rt);
    const base = {
      ref: r.ref, source,
      account: source === "agent" ? (r.agent_name || r.agent_code || "Agent")
             : source === "account" ? (r.account || "Direct") : null,
      accountRef: r.account_ref || null,
      payState: source === "web" ? r.status : source === "agent" ? "account" : "account",
      vehicleClass: r.vehicle || "", pax: r.pax || 1,
      childSeats: r.child_seats || 0, trailer: !!r.trailer,
      guest: r.passenger_name || "", phone: r.passenger_phone || "", email: r.passenger_email || "",
      address: r.address || "", notes: r.notes || "",
      hours: r.hire_hours || null,
      price: Math.round(total / (hasRet ? 2 : 1)) / 100,
      balance: r.balance_cents ? r.balance_cents / 100 : 0,
      isReturn: hasRet,
      needsReview: !!r.needs_review, sourceNote: r.source_note || "",
    };
    const out = [{ ...base, leg: "out", date: r.d, time: r.t, from: r.pickup, to: r.dropoff, flight: r.flight || "", stops: stopList(r.stops) }];
    if (hasRet) out.push({ ...base, stops: [], leg: "ret", date: r.rd, time: r.rt, from: r.dropoff, to: r.pickup, flight: r.rf || "" });
    return out;
  }

  async function sourceRows(from, to, refs) {
    /* Either a date window or an explicit list of references. */
    const byRef = Array.isArray(refs);
    if (byRef && !refs.length) return [];
    const web = await pool.query(
      `SELECT ${WEB_COLS} FROM web_bookings WHERE status NOT IN ('declined', 'cancelled') AND ` +
      (byRef ? `ref IN (${inList(refs.length)})` : `((pickup_date >= $1 AND pickup_date <= $2) OR (return_date >= $1 AND return_date <= $2))`),
      byRef ? refs : [from, to]);
    const agent = await pool.query(
      `SELECT ${AGENT_COLS} FROM agent_bookings a LEFT JOIN agents g ON g.code = a.agent_code
        WHERE a.status <> 'cancelled' AND ` + (byRef ? `a.ref IN (${inList(refs.length)})`
          : `((a.pickup_date >= $1 AND a.pickup_date <= $2) OR (a.return_date >= $1 AND a.return_date <= $2))`),
      byRef ? refs : [from, to]);
    const jobs = await pool.query(
      `SELECT ${JOB_COLS} FROM ops_jobs WHERE status <> 'cancelled' AND ` +
      (byRef ? `ref IN (${inList(refs.length)})` : `((pickup_date >= $1 AND pickup_date <= $2) OR (return_date >= $1 AND return_date <= $2))`),
      byRef ? refs : [from, to]);
    return [].concat(
      web.rows.flatMap((r) => legsOf(r, "web")),
      agent.rows.flatMap((r) => legsOf(r, "agent")),
      jobs.rows.flatMap((r) => legsOf(r, "account")));
  }

  function attachDispatch(legs, dispatchRows, drivers, vehicles) {
    const key = (ref, leg) => ref + "|" + leg;
    const byKey = new Map(dispatchRows.map((d) => [key(d.ref, d.leg), d]));
    const dById = new Map(drivers.map((d) => [d.id, d]));
    const vById = new Map(vehicles.map((v) => [v.id, v]));
    for (const l of legs) {
      const d = byKey.get(key(l.ref, l.leg));
      l.status = d ? d.status : "unassigned";
      l.driverId = d && d.driver_id || null;
      l.vehicleId = d && d.vehicle_id || null;
      l.driverPay = d && d.driver_pay_cents != null ? d.driver_pay_cents / 100 : null;
      l.officeNote = d && d.office_note || "";
      l.sentAt = d && d.sent_at || null;
      l.driverPaidAt = d && d.driver_paid_at || null;
      l.auto = !!(d && d.auto_assigned);
      l.declinedIds = d && d.declined_ids ? String(d.declined_ids).split(",").filter(Boolean).map(Number) : [];
      l.driverName = l.driverId && dById.get(l.driverId) ? dById.get(l.driverId).name : null;
      l.vehicleLabel = l.vehicleId && vById.get(l.vehicleId) ? vById.get(l.vehicleId).label : null;
      l.times = d ? { assigned: d.assigned_at, accepted: d.accepted_at, onWay: d.on_way_at,
                      onLocation: d.on_location_at, pob: d.pob_at, done: d.done_at, declined: d.declined_at } : {};
    }
    return legs;
  }

  /* A warning, never a block: the office knows things the board does not,
     like a short CBD hop that genuinely fits before an airport run. A
     transfer is assumed to hold the car for two hours; hourly hire for its
     hours plus half an hour either side. */
  function markConflicts(legs) {
    const span = (l) => {
      const s = Date.parse(l.date + "T00:00:00Z") / 60000 + (minutesOf(l.time) || 0);
      return [s, s + (l.hours ? l.hours * 60 + 30 : 120)];
    };
    for (const l of legs) l.conflicts = [];
    for (const field of ["driverId", "vehicleId"]) {
      const groups = new Map();
      for (const l of legs) if (l[field] && l.status !== "declined") {
        if (!groups.has(l[field])) groups.set(l[field], []);
        groups.get(l[field]).push(l);
      }
      for (const list of groups.values()) {
        list.sort((a, b) => span(a)[0] - span(b)[0]);
        for (let i = 1; i < list.length; i++) {
          const prev = list[i - 1], cur = list[i];
          if (span(cur)[0] < span(prev)[1]) {
            const what = field === "driverId" ? "Driver" : "Vehicle";
            cur.conflicts.push(`${what} also on ${prev.ref} at ${prev.time}`);
            prev.conflicts.push(`${what} also on ${cur.ref} at ${cur.time}`);
          }
        }
      }
    }
    return legs;
  }

  async function allDrivers() {
    const { rows } = await pool.query(
      `SELECT id, name, phone, email, kind, pay_type, pay_value::float AS pay_value,
              to_char(licence_expiry, 'YYYY-MM-DD') AS licence_expiry,
              to_char(authority_expiry, 'YYYY-MM-DD') AS authority_expiry,
              own_vehicle, notes, active, link_version
         FROM ops_drivers ORDER BY active DESC, name`);
    return rows;
  }
  async function allVehicles() {
    const { rows } = await pool.query(
      `SELECT id, label, class, rego, seats, owner_driver_id,
              to_char(rego_expiry, 'YYYY-MM-DD') AS rego_expiry,
              to_char(insurance_expiry, 'YYYY-MM-DD') AS insurance_expiry,
              to_char(service_due, 'YYYY-MM-DD') AS service_due,
              notes, active
         FROM ops_vehicles ORDER BY active DESC, label`);
    return rows;
  }

  async function boardFor(from, to) {
    const legs = (await sourceRows(from, to)).filter((l) => l.date >= from && l.date <= to);
    const refs = [...new Set(legs.map((l) => l.ref))];
    const disp = refs.length ? (await pool.query(`SELECT * FROM ops_dispatch WHERE ref IN (${inList(refs.length)})`, refs)).rows : [];
    const drivers = await allDrivers(), vehicles = await allVehicles();
    attachDispatch(legs, disp, drivers, vehicles);
    markConflicts(legs);
    legs.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")) || a.ref.localeCompare(b.ref));
    return { legs, drivers, vehicles };
  }

  /* ---- driver links --------------------------------------------------------- */
  function driverToken(d) {
    const body = Buffer.from(JSON.stringify({ k: "drv", d: d.id, v: d.link_version })).toString("base64url");
    return body + "." + crypto.createHmac("sha256", KEY).update(body).digest("base64url");
  }
  async function driverFromToken(t) {
    const [body, sig] = String(t || "").split(".");
    if (!body || !sig || !SECRET) return null;
    const want = crypto.createHmac("sha256", KEY).update(body).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let c; try { c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (e) { return null; }
    if (!c || c.k !== "drv" || !Number.isInteger(c.d)) return null;
    const { rows } = await pool.query(`SELECT id, name, phone, active, link_version FROM ops_drivers WHERE id = $1`, [c.d]);
    const d = rows[0];
    if (!d || !d.active || d.link_version !== c.v) return null;
    return d;
  }
  const linkFor = (d) => SITE + "/driver.html#t=" + driverToken(d);

  /* ---- office: the board ---------------------------------------------------- */
  app.get("/ops/jobs", requireAdmin, async (req, res) => {
    try {
      const from = isoDate(req.query.from) || bneToday(0);
      let to = isoDate(req.query.to) || from;
      if (to < from) to = from;
      if (to > addDays(from, 31)) to = addDays(from, 31);
      const b = await boardFor(from, to);
      res.json({ from, to, today: bneToday(0), jobs: b.legs, drivers: b.drivers, vehicles: b.vehicles, vehicleClasses: VEHICLES || [] });
    } catch (err) {
      console.error("ops jobs:", err);
      res.status(500).json({ error: "Could not load the jobs." });
    }
  });

  /* The leg has to exist in a booking table - no dispatch row for a typo. */
  async function legExists(ref, leg) {
    const legs = await sourceRows(null, null, [ref]);
    return legs.some((l) => l.ref === ref && l.leg === leg) ? legs.find((l) => l.ref === ref && l.leg === leg) : null;
  }

  /* Shared by the office route and autopilot.js. Throws {code, message}. */
  async function assignLeg({ ref, leg, driverId, vehicleId, payCents, note, auto }) {
    const job = ref ? await legExists(ref, leg) : null;
    if (!job) throw { code: 404, message: "No such job." };
    if (driverId) {
      const { rows } = await pool.query(`SELECT id FROM ops_drivers WHERE id = $1 AND active`, [driverId]);
      if (!rows.length) throw { code: 400, message: "That driver is not active." };
    }
    if (vehicleId) {
      const { rows } = await pool.query(`SELECT id FROM ops_vehicles WHERE id = $1 AND active`, [vehicleId]);
      if (!rows.length) throw { code: 400, message: "That vehicle is not active." };
    }
    const pay = payCents == null ? null : payCents;
    note = note || null;
    {
      const { rows: prevRows } = await pool.query(`SELECT * FROM ops_dispatch WHERE ref = $1 AND leg = $2`, [ref, leg]);
      const prev = prevRows[0];
      const changedDriver = !prev || prev.driver_id !== driverId;
      /* A new driver starts the job again from "assigned"; keeping the same
         driver keeps their progress. No driver means unassigned. */
      const status = !driverId ? "unassigned" : changedDriver ? "assigned" : (prev.status === "unassigned" ? "assigned" : prev.status);
      await pool.query(
        `INSERT INTO ops_dispatch (ref, leg, driver_id, vehicle_id, driver_pay_cents, status, office_note, assigned_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $3::int IS NULL THEN NULL ELSE now() END, now())
         ON CONFLICT (ref, leg) DO UPDATE SET
           driver_id = EXCLUDED.driver_id, vehicle_id = EXCLUDED.vehicle_id,
           driver_pay_cents = EXCLUDED.driver_pay_cents, status = EXCLUDED.status,
           office_note = EXCLUDED.office_note, updated_at = now(),
           assigned_at = CASE WHEN $8 THEN EXCLUDED.assigned_at ELSE ops_dispatch.assigned_at END,
           sent_at = CASE WHEN $8 THEN NULL ELSE ops_dispatch.sent_at END,
           accepted_at = CASE WHEN $8 THEN NULL ELSE ops_dispatch.accepted_at END,
           on_way_at = CASE WHEN $8 THEN NULL ELSE ops_dispatch.on_way_at END,
           on_location_at = CASE WHEN $8 THEN NULL ELSE ops_dispatch.on_location_at END,
           pob_at = CASE WHEN $8 THEN NULL ELSE ops_dispatch.pob_at END,
           done_at = CASE WHEN $8 THEN NULL ELSE ops_dispatch.done_at END,
           declined_at = CASE WHEN $8 THEN NULL ELSE ops_dispatch.declined_at END,
           driver_paid_at = CASE WHEN $8 THEN NULL ELSE ops_dispatch.driver_paid_at END,
           guest_onway_at = CASE WHEN $8 THEN NULL ELSE ops_dispatch.guest_onway_at END,
           guest_arrived_at = CASE WHEN $8 THEN NULL ELSE ops_dispatch.guest_arrived_at END`,
        [ref, leg, driverId, vehicleId, pay, status, note, changedDriver]);
      await pool.query(`UPDATE ops_dispatch SET auto_assigned = $3 WHERE ref = $1 AND leg = $2`, [ref, leg, !!(auto && driverId)]);
      console.log("ops assign:", auto ? "(auto)" : "", ref, leg, "driver", driverId || "-", "vehicle", vehicleId || "-", status);
      return { status, job };
    }
  }

  app.post("/ops/assign", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const r = await assignLeg({ ref: txt(b.ref, 40), leg: b.leg === "ret" ? "ret" : "out",
        driverId: b.driverId ? int(b.driverId, 1, 1e9, null) : null, vehicleId: b.vehicleId ? int(b.vehicleId, 1, 1e9, null) : null,
        payCents: b.driverPay === "" || b.driverPay == null ? null : cents(b.driverPay), note: txt(b.officeNote, 500) || null, auto: false });
      res.json({ ok: true, status: r.status });
    } catch (err) {
      if (err && err.code) return res.status(err.code).json({ error: err.message });
      console.error("ops assign:", err);
      res.status(500).json({ error: "Could not save that assignment." });
    }
  });

  /* The office can set any status - a job finished without the driver
     pressing Done, or one reset after a mistake. */
  app.post("/ops/status", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const ref = txt(b.ref, 40), leg = b.leg === "ret" ? "ret" : "out";
      const status = STATUSES.includes(b.status) ? b.status : null;
      if (!status) return res.status(400).json({ error: "Unknown status." });
      if (!(await legExists(ref, leg))) return res.status(404).json({ error: "No such job." });
      const col = DRIVER_STEPS[status] || (status === "declined" ? "declined_at" : null);
      /* The step time is written on both branches: a leg marked done that was
         never assigned has no row yet, and must still say when it finished. */
      await pool.query(
        `INSERT INTO ops_dispatch (ref, leg, status, updated_at${col ? ", " + col : ""})
           VALUES ($1, $2, $3, now()${col ? ", now()" : ""})
         ON CONFLICT (ref, leg) DO UPDATE SET status = EXCLUDED.status, updated_at = now()` +
        (col ? `, ${col} = COALESCE(ops_dispatch.${col}, now())` : ""),
        [ref, leg, status]);
      console.log("ops status (office):", ref, leg, status);
      if (hooks.step) hooks.step({ ref, leg, status }).catch((e) => console.error("guest update:", e.message));
      res.json({ ok: true });
    } catch (err) {
      console.error("ops status:", err);
      res.status(500).json({ error: "Could not change that status." });
    }
  });

  /* Pressed when the office opens WhatsApp with the job sheet, so the board
     can show which jobs have actually been sent. */
  app.post("/ops/sent", requireAdmin, async (req, res) => {
    try {
      const ref = txt((req.body || {}).ref, 40), leg = (req.body || {}).leg === "ret" ? "ret" : "out";
      await pool.query(`UPDATE ops_dispatch SET sent_at = now(), updated_at = now() WHERE ref = $1 AND leg = $2`, [ref, leg]);
      res.json({ ok: true });
    } catch (err) {
      console.error("ops sent:", err);
      res.status(500).json({ error: "Could not record that." });
    }
  });

  /* ---- office: drivers ------------------------------------------------------- */
  app.get("/ops/drivers", requireAdmin, async (req, res) => {
    try { res.json({ drivers: await allDrivers() }); }
    catch (err) { console.error("ops drivers:", err); res.status(500).json({ error: "Could not load drivers." }); }
  });

  app.post("/ops/driver", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const name = txt(b.name, 120);
      if (!name) return res.status(400).json({ error: "A driver needs a name." });
      const phone = txt(b.phone, 40);
      if (!phone) return res.status(400).json({ error: "A driver needs a mobile number - it is where jobs are sent." });
      const kind = b.kind === "subcontractor" ? "subcontractor" : "employee";
      const payType = b.payType === "percent" ? "percent" : "fixed";
      const payValue = Math.max(0, Math.min(Number(b.payValue) || 0, payType === "percent" ? 100 : 100000));
      const vals = [name, phone, txt(b.email, 200) || null, kind, payType, payValue,
        isoDate(b.licenceExpiry), isoDate(b.authorityExpiry), b.ownVehicle === true || b.ownVehicle === "true",
        txt(b.notes, 1000) || null, b.active === false || b.active === "false" ? false : true];
      const id = b.id ? int(b.id, 1, 1e9, null) : null;
      if (id) {
        const r = await pool.query(
          `UPDATE ops_drivers SET name=$1, phone=$2, email=$3, kind=$4, pay_type=$5, pay_value=$6,
             licence_expiry=$7, authority_expiry=$8, own_vehicle=$9, notes=$10, active=$11 WHERE id=$12`, vals.concat([id]));
        if (!r.rowCount) return res.status(404).json({ error: "No such driver." });
        return res.json({ ok: true, id });
      }
      const { rows } = await pool.query(
        `INSERT INTO ops_drivers (name, phone, email, kind, pay_type, pay_value, licence_expiry, authority_expiry, own_vehicle, notes, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, vals);
      res.json({ ok: true, id: rows[0].id });
    } catch (err) {
      console.error("ops driver:", err);
      res.status(500).json({ error: "Could not save that driver." });
    }
  });

  /* The driver's own link. reset:true bumps the version so every earlier copy
     stops working - for a lost phone or a driver who has left. */
  app.post("/ops/driver/link", requireAdmin, async (req, res) => {
    try {
      const id = int((req.body || {}).id, 1, 1e9, null);
      if ((req.body || {}).reset) await pool.query(`UPDATE ops_drivers SET link_version = link_version + 1 WHERE id = $1`, [id]);
      const { rows } = await pool.query(`SELECT id, name, phone, active, link_version FROM ops_drivers WHERE id = $1`, [id]);
      if (!rows[0]) return res.status(404).json({ error: "No such driver." });
      if (!rows[0].active) return res.status(409).json({ error: "That driver is inactive - reactivate them first." });
      res.json({ ok: true, url: linkFor(rows[0]) });
    } catch (err) {
      console.error("ops driver link:", err);
      res.status(500).json({ error: "Could not make that link." });
    }
  });

  /* ---- office: vehicles -------------------------------------------------------- */
  app.post("/ops/vehicle", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const label = txt(b.label, 120);
      if (!label) return res.status(400).json({ error: "Give the vehicle a name, e.g. \"Kia Carnival - white\"." });
      const cls = (VEHICLES || []).includes(b.class) ? b.class : "";
      const vals = [label, cls, txt(b.rego, 20) || null, b.seats ? int(b.seats, 1, 60, null) : null,
        b.ownerDriverId ? int(b.ownerDriverId, 1, 1e9, null) : null,
        isoDate(b.regoExpiry), isoDate(b.insuranceExpiry), isoDate(b.serviceDue),
        txt(b.notes, 1000) || null, b.active === false || b.active === "false" ? false : true];
      const id = b.id ? int(b.id, 1, 1e9, null) : null;
      if (id) {
        const r = await pool.query(
          `UPDATE ops_vehicles SET label=$1, class=$2, rego=$3, seats=$4, owner_driver_id=$5, rego_expiry=$6,
             insurance_expiry=$7, service_due=$8, notes=$9, active=$10 WHERE id=$11`, vals.concat([id]));
        if (!r.rowCount) return res.status(404).json({ error: "No such vehicle." });
        return res.json({ ok: true, id });
      }
      const { rows } = await pool.query(
        `INSERT INTO ops_vehicles (label, class, rego, seats, owner_driver_id, rego_expiry, insurance_expiry, service_due, notes, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, vals);
      res.json({ ok: true, id: rows[0].id });
    } catch (err) {
      console.error("ops vehicle:", err);
      res.status(500).json({ error: "Could not save that vehicle." });
    }
  });

  /* ---- office: account jobs ----------------------------------------------------
     Work that arrives by email or phone from an account and is priced by
     their own agreement. No confirmation goes to anyone from here - the
     account books for its own guest, the same way it does in Limo Anywhere. */
  app.post("/ops/job", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const j = {
        account: txt(b.account, 120) || null, accountRef: txt(b.accountRef, 60) || null,
        pickup: txt(b.pickup, 200), dropoff: txt(b.dropoff, 200), vehicle: txt(b.vehicle, 80),
        date: isoDate(b.date), time: hhmm(b.time),
        returnDate: isoDate(b.returnDate), returnTime: hhmm(b.returnTime), returnFlight: txt(b.returnFlight, 40) || null,
        hours: b.hours ? int(b.hours, 1, 24, null) : null,
        name: txt(b.name, 120), phone: txt(b.phone, 40), email: txt(b.email, 200) || null,
        flight: txt(b.flight, 40) || null, address: txt(b.address, 300) || null, notes: txt(b.notes, 1000) || null,
        pax: int(b.pax, 1, 60, 1), seats: int(b.childSeats, 0, 6, 0), trailer: b.trailer === true || b.trailer === "true",
        price: cents(b.price),
        stops: (Array.isArray(b.stops) ? b.stops : String(b.stops || "").split(/\r?\n/))
          .map((x) => txt(x, 200)).filter((x) => x.length >= 3).slice(0, 3),
      };
      const missing = [["pickup", j.pickup], ["drop-off", j.dropoff || (j.hours ? "As directed" : "")], ["date", j.date], ["time", j.time]]
        .filter((x) => !x[1]).map((x) => x[0]);
      if (missing.length) return res.status(400).json({ error: "Please fill in: " + missing.join(", ") + "." });
      if (!j.dropoff && j.hours) j.dropoff = "As directed";
      if ((j.returnDate && !j.returnTime) || (!j.returnDate && j.returnTime)) {
        return res.status(400).json({ error: "Give both a date and a time for the return, or neither." });
      }
      if (j.returnDate && (j.returnDate < j.date || (j.returnDate === j.date && j.returnTime <= j.time))) {
        return res.status(400).json({ error: "The return has to be after the outbound trip." });
      }
      const vals = [j.account, j.accountRef, j.pickup, j.dropoff, j.vehicle, j.date, j.time, j.returnDate, j.returnTime,
        j.returnFlight, j.hours, j.name, j.phone, j.email, j.flight, j.address, j.notes, j.pax, j.seats, j.trailer, j.price || 0];
      const editRef = txt(b.ref, 40);
      if (editRef) {
        const r = await pool.query(
          `UPDATE ops_jobs SET account=$1, account_ref=$2, pickup=$3, dropoff=$4, vehicle=$5, pickup_date=$6, pickup_time=$7,
             return_date=$8, return_time=$9, return_flight=$10, hire_hours=$11, passenger_name=$12, passenger_phone=$13,
             passenger_email=$14, flight=$15, address=$16, notes=$17, pax=$18, child_seats=$19, trailer=$20, price_cents=$21,
             needs_review=FALSE, updated_at=now() WHERE ref=$22`, vals.concat([editRef]));
        if (!r.rowCount) return res.status(404).json({ error: "No such account job." });
        /* A return that has been taken away leaves no leg to drive. */
        if (!j.returnDate) await pool.query(`DELETE FROM ops_dispatch WHERE ref = $1 AND leg = 'ret'`, [editRef]);
        await pool.query(`UPDATE ops_jobs SET stops = $2 WHERE ref = $1`, [editRef, j.stops.length ? JSON.stringify(j.stops) : null]);
        console.log("ops job updated:", editRef);
        return res.json({ ok: true, ref: editRef });
      }
      let ref = null;
      for (let i = 0; i < 5 && !ref; i++) {
        const tryRef = makeRef(j.date);
        const r = await pool.query(
          `INSERT INTO ops_jobs (ref, account, account_ref, pickup, dropoff, vehicle, pickup_date, pickup_time, return_date,
             return_time, return_flight, hire_hours, passenger_name, passenger_phone, passenger_email, flight, address, notes,
             pax, child_seats, trailer, price_cents)
           VALUES ($22,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           ON CONFLICT (ref) DO NOTHING`, vals.concat([tryRef]));
        if (r.rowCount) ref = tryRef;
      }
      if (!ref) return res.status(500).json({ error: "Could not make a reference - try again." });
      if (j.stops.length) await pool.query(`UPDATE ops_jobs SET stops = $2 WHERE ref = $1`, [ref, JSON.stringify(j.stops)]);
      console.log("ops job created:", ref, j.account || "-", j.date, j.time);
      res.json({ ok: true, ref });
    } catch (err) {
      console.error("ops job:", err);
      res.status(500).json({ error: "Could not save that job." });
    }
  });

  app.post("/ops/job/cancel", requireAdmin, async (req, res) => {
    try {
      const ref = txt((req.body || {}).ref, 40);
      const r = await pool.query(`UPDATE ops_jobs SET status = 'cancelled', updated_at = now() WHERE ref = $1`, [ref]);
      if (!r.rowCount) return res.status(404).json({ error: "Only account jobs are cancelled here - website and agent bookings are cancelled where they were made." });
      console.log("ops job cancelled:", ref);
      res.json({ ok: true });
    } catch (err) {
      console.error("ops job cancel:", err);
      res.status(500).json({ error: "Could not cancel that job." });
    }
  });

  app.get("/ops/job", requireAdmin, async (req, res) => {
    try {
      const ref = txt(req.query.ref, 40);
      const { rows } = await pool.query(`SELECT ${JOB_COLS} FROM ops_jobs WHERE ref = $1`, [ref]);
      if (!rows[0]) return res.status(404).json({ error: "No such account job." });
      res.json({ job: rows[0] });
    } catch (err) {
      console.error("ops job get:", err);
      res.status(500).json({ error: "Could not load that job." });
    }
  });

  /* ---- the driver's page ----------------------------------------------------------
     POST, not GET, with the token in the body: driver.html keeps it in the URL
     fragment, which browsers never send to a server or put in a Referer, and
     WhatsApp's link preview fetches only the static page. */
  app.post("/driver/jobs", async (req, res) => {
    try {
      const d = await driverFromToken((req.body || {}).t);
      if (!d) return res.status(401).json({ error: "This link has expired or been replaced. Ask the office for your new one." });
      const from = bneToday(-1), to = bneToday(14);
      const { rows: disp } = await pool.query(`SELECT * FROM ops_dispatch WHERE driver_id = $1`, [d.id]);
      if (!disp.length) return res.json({ driver: { name: d.name }, today: bneToday(0), jobs: [] });
      const refs = [...new Set(disp.map((x) => x.ref))];
      const legs = (await sourceRows(null, null, refs)).filter((l) => l.date >= from && l.date <= to);
      const vehicles = await allVehicles();
      attachDispatch(legs, disp, [{ id: d.id, name: d.name }], vehicles);
      const mine = legs.filter((l) => l.driverId === d.id)
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      /* What a driver needs, and nothing about what the guest paid. */
      res.json({
        driver: { name: d.name }, today: bneToday(0),
        jobs: mine.map((l) => ({
          ref: l.ref, leg: l.leg, isReturn: l.isReturn, date: l.date, time: l.time, from: l.from, to: l.to,
          flight: l.flight, hours: l.hours, guest: l.guest, phone: l.phone, pax: l.pax,
          childSeats: l.childSeats, trailer: l.trailer, address: l.address, notes: l.notes,
          vehicleClass: l.vehicleClass, vehicleLabel: l.vehicleLabel, officeNote: l.officeNote, stops: l.stops || [],
          account: l.source === "web" ? null : l.account, pay: l.driverPay, status: l.status,
        })),
      });
    } catch (err) {
      console.error("driver jobs:", err);
      res.status(500).json({ error: "Could not load your jobs - try again in a moment." });
    }
  });

  app.post("/driver/status", async (req, res) => {
    try {
      const b = req.body || {};
      const d = await driverFromToken(b.t);
      if (!d) return res.status(401).json({ error: "This link has expired or been replaced. Ask the office for your new one." });
      const ref = txt(b.ref, 40), leg = b.leg === "ret" ? "ret" : "out";
      const want = Object.prototype.hasOwnProperty.call(DRIVER_FROM, b.status) ? b.status : null;
      if (!want) return res.status(400).json({ error: "Unknown step." });
      const { rows } = await pool.query(`SELECT status, driver_id FROM ops_dispatch WHERE ref = $1 AND leg = $2`, [ref, leg]);
      const cur = rows[0];
      if (!cur || cur.driver_id !== d.id) return res.status(403).json({ error: "That job is not assigned to you any more." });
      if (cur.status === want) return res.json({ ok: true, status: want });
      if (!DRIVER_FROM[want].includes(cur.status)) {
        return res.status(409).json({ error: "That step doesn't follow from where the job is (" + cur.status.replace("_", " ") + ")." });
      }
      const col = want === "declined" ? "declined_at" : DRIVER_STEPS[want];
      await pool.query(
        `UPDATE ops_dispatch SET status = $3, ${col} = now(), updated_at = now() WHERE ref = $1 AND leg = $2 AND driver_id = $4`,
        [ref, leg, want, d.id]);
      if (want === "declined") {
        const { rows: dr } = await pool.query(`SELECT declined_ids FROM ops_dispatch WHERE ref = $1 AND leg = $2`, [ref, leg]);
        const ids = new Set(String((dr[0] && dr[0].declined_ids) || "").split(",").filter(Boolean));
        ids.add(String(d.id));
        await pool.query(`UPDATE ops_dispatch SET declined_ids = $3 WHERE ref = $1 AND leg = $2`, [ref, leg, [...ids].join(",")]);
      }
      console.log("driver status:", d.name, ref, leg, cur.status, "->", want);
      if (hooks.step) hooks.step({ ref, leg, status: want }).catch((e) => console.error("guest update:", e.message));
      /* A driver turning a job down needs a human straight away. */
      if (want === "declined" && mailer) {
        const job = await legExists(ref, leg);
        mailer.sendMail({
          from: `"Sky Transfers Dispatch" <${process.env.GMAIL_USER}>`, to: BOOKINGS_EMAIL,
          subject: `DRIVER CAN'T DO IT: ${ref}${leg === "ret" ? " (return)" : ""} - ${d.name}`,
          text: `${d.name} has turned down ${ref}${leg === "ret" ? " (return leg)" : ""}.\n\n` +
                (job ? `${job.date} ${job.time}\n${job.from} -> ${job.to}\n${job.vehicleClass} · ${job.pax} pax\nGuest: ${job.guest} ${job.phone}\n\n` : "") +
                `Reassign it on the dispatch board: ${SITE}/dispatch.html`,
        }).catch((e) => console.error("decline alert:", e.message));
      }
      res.json({ ok: true, status: want });
    } catch (err) {
      console.error("driver status:", err);
      res.status(500).json({ error: "Could not save that - try again." });
    }
  });

  initOpsSchema()
    .then(() => console.log("Ops ready (dispatch board, drivers, vehicles)"))
    .catch((e) => console.error("Ops setup failed:", e.message));

  return { on: true, boardFor, linkFor, initOpsSchema, legsOf, markConflicts, driverFromToken, allDrivers, allVehicles, bneToday, addDays,
           assignLeg, legExists, sourceRows, hooks };
};
