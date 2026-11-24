/* Office staff logins and the activity log (15 Nov 2026).
 *
 * Aman: "its time we create staff logins for our office staff. so we can track
 * what they are doing right now every one is using main admin login".
 *
 * Until now the office had one login: ADMIN_PIN. This adds a login per person,
 * each with their own PIN, and a log of who did what.
 *
 *   - A staff login can do everything the main login can, except manage staff
 *     logins and read the activity log. Those two stay with the main login.
 *   - Everyone signs in at the same PIN box. The main PIN is tried first, then
 *     each active staff PIN. Staff PINs are eight digits, made here, shown
 *     once, and stored only as a salted scrypt hash.
 *   - requireAdmin (agent-portal.js) is the one gate every office route sits
 *     behind, so the log is written there: every request that is not a plain
 *     read is recorded when it finishes - who, what, which booking, and
 *     whether it went through. A route added later is logged under its own
 *     address until it is given a name in LABELS.
 *   - Never recorded: PINs, API keys, emails, phone numbers, notes, bank
 *     details. Only the fields named in IN_KEYS / OUT_KEYS are kept.
 *   - Changing ADMIN_PIN still signs every device out, staff included.
 */
"use strict";
const crypto = require("crypto");

const OWNER = "Main admin login";
const STAFF_MAX = 15;
const KEEP_DAYS = 400;
const OWNER_ONLY = "Only the main admin login can manage staff logins and read the activity log.";

const LABELS = {
  "/admin/web-booking/create": "Made a booking",
  "/admin/web-booking/amend": "Amended a booking",
  "/admin/web-booking/cancel": "Cancelled a booking",
  "/admin/web-booking/remove": "Removed a booking",
  "/admin/web-booking/resend": "Re-sent a confirmation",
  "/admin/web-booking/deposit": "Confirmed a booking with a deposit",
  "/admin/web-booking/balance-link": "Sent a balance link",
  "/admin/web-booking/balance-paid": "Marked a balance paid",
  "/admin/web-booking/paid-elsewhere": "Marked a booking paid another way",
  "/admin/agent": "Saved an agent",
  "/admin/agent/delete": "Deleted an unused agent",
  "/ops/account/delete": "Deleted an unused account",
  "/admin/settle": "Settled an agent's commission",
  "/admin/agent/staff/add": "Added an agency staff login",
  "/admin/agent/staff/update": "Changed an agency staff login",
  "/admin/agent/staff/pin": "Reset an agency staff PIN",
  /* the office working in the agent portal for an agency (17 Nov 2026) */
  "/admin/agent/act-as": "Opened an agent's booking page",
  "/agent/book": "Booked for an agent",
  "/agent/tour": "Booked a tour for an agent",
  "/agent/booking/update": "Amended an agent's booking",
  "/agent/booking/cancel": "Cancelled an agent's booking",
  "/agent/booking/pay-link": "Made a payment link on an agent's booking",
  "/agent/team/add": "Added an agency staff login",
  "/agent/team/update": "Changed an agency staff login",
  "/agent/team/pin": "Reset an agency staff PIN",
  "/admin/api-key": "Made an API key",
  "/admin/api-key/revoke": "Revoked an API key",
  "/admin/affiliate": "Saved a referral partner",
  "/admin/affiliate-welcome": "Emailed a referral partner their details",
  "/admin/affiliate-flag": "Flagged a referral booking",
  "/admin/affiliate-paid": "Marked referral commission paid",
  "/admin/retention/purge": "Purged old enquiries",
  "/admin/staff/add": "Added a staff login",
  "/admin/staff/update": "Changed a staff login",
  "/admin/staff/pin": "Reset a staff PIN",
  "/gallery/upload": "Added a gallery photo",
  "/gallery/remove": "Removed a gallery photo",
  "/autopilot/settings": "Changed autopilot settings",
  "/autopilot/schedule": "Changed a billing schedule",
  "/autopilot/run": "Ran the autopilot",
  "/guest/sample": "Sent a sample guest update",
  "/review/sample": "Sent a sample review request",
  "/ops/job": "Saved a board job",
  "/ops/job/cancel": "Cancelled a board job",
  "/ops/job-amount": "Changed a job's price",
  "/ops/assign": "Assigned a driver or vehicle",
  "/ops/status": "Changed a job's status",
  "/ops/sent": "Marked a job sent to the driver",
  "/ops/wa-driver": "Sent a job to a driver on WhatsApp",
  "/ops/leg-pay": "Changed driver pay on a job",
  "/ops/pay/mark": "Marked driver pay",
  "/ops/driver": "Saved a driver",
  "/ops/driver/link": "Made a driver's job link",
  "/ops/vehicle": "Saved a vehicle",
  "/ops/account": "Saved an account",
  "/ops/account/view-link": "Made an account's view link",
  "/ops/invoice": "Raised an invoice",
  "/ops/invoice/send": "Sent an invoice",
  "/ops/invoice/paid": "Marked an invoice paid or unpaid",
  "/ops/invoice/void": "Voided an invoice",
  "/ops/invoice/amend": "Voided an invoice to amend it",
  "/ops/invoice/restore": "Put an amended invoice back as it was",
  "/ops/cal/apply": "Applied a calendar change",
  "/ops/cal/keep": "Kept a job as it was (calendar change set aside)",
  "/ops/cal/reread": "Re-read a calendar job",
  "/ops/confirm/send": "Sent a trip confirmation",
  "/ops/import/la": "Imported jobs",
};
/* Posts that change nothing: previews and drafts. */
const NOT_CHANGES = new Set(["/autopilot/inbox-ai/preview", "/ops/confirm/pdf", "/ops/invoice/draft", "/agent/quote"]);
/* What is kept from what was sent, and from what came back. */
const IN_KEYS = ["leg", "status", "code", "id", "driverPay", "amount", "how", "paid", "active", "date", "time",
  "returnDate", "returnTime", "pickup", "dropoff", "vehicle", "account", "partyKey", "from", "to", "cycle", "reset", "action"];
const OUT_KEYS = ["number", "replaces", "was", "now", "total", "balance", "refunded", "settled", "deleted", "imported", "trips", "created", "emailed", "keeper"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const one = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n || 120);
const plain = (v) => (v && typeof v === "object" && !Buffer.isBuffer(v) && !Array.isArray(v) ? v : {});
const simple = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
/* an email address never goes in the log, whatever field it arrives in */
const safe = (v) => simple(v) && v !== "" && !/@/.test(String(v));

module.exports = function officeStaff({ app, pool, pinMatches, makePinHash, adminPin }) {
  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS office_users (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      pin_hash      TEXT NOT NULL,
      pin_ver       INTEGER NOT NULL DEFAULT 1,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS office_activity (
      id       SERIAL PRIMARY KEY,
      at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      user_id  INTEGER,
      who      TEXT NOT NULL,
      action   TEXT NOT NULL,
      path     TEXT,
      ref      TEXT,
      detail   TEXT,
      ok       BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE INDEX IF NOT EXISTS office_activity_at ON office_activity (at DESC);
  `).then(() => pool.query("DELETE FROM office_activity WHERE at < $1", [new Date(Date.now() - KEEP_DAYS * 864e5)]))
    .catch((e) => console.error("Office staff setup failed:", e.message));

  const ownerOf = () => ({ id: null, name: OWNER, owner: true });
  const staffOf = (u) => ({ id: u.id, name: u.name, owner: false, pinVer: Number(u.pin_ver) });

  /* ---- the log -------------------------------------------------------- */
  async function record(staff, action, o) {
    try {
      await ready;
      await pool.query(
        "INSERT INTO office_activity (user_id, who, action, path, ref, detail, ok) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [staff && staff.id ? staff.id : null, one(staff && staff.name, 80) || "Unknown", one(action, 120),
         one(o && o.path, 120) || null, one(o && o.ref, 160) || null, one(o && o.detail, 400) || null, !(o && o.ok === false)]);
    } catch (e) { console.error("office activity:", e.message); }
  }

  async function nameOf(table, col, id) {
    const n = parseInt(id, 10);
    if (!n) return "";
    try { const { rows } = await pool.query(`SELECT ${col} AS n FROM ${table} WHERE id = $1`, [n]); return rows[0] ? one(rows[0].n, 60) : ""; }
    catch { return ""; }
  }

  async function describe(path, body, out, status, extra) {
    const b = plain(body), o = plain(out);
    const ok = status < 400;
    const ref = one(b.ref || o.ref || (Array.isArray(b.refs) ? b.refs.filter(simple).join(", ") : ""), 160);
    const bits = [];
    /* done in the agent portal for an agency: say which */
    if (extra && extra.agent) bits.push("agent: " + one(extra.agent, 30));
    /* what the office did that the agency's own rules would have refused */
    if (extra && Array.isArray(extra.notes) && extra.notes.length && ok) {
      bits.push("OFFICE OVERRIDE: " + extra.notes.filter((n, i, a) => a.indexOf(n) === i).map((n) => one(n, 60)).join(", "));
    }
    if (!ok) bits.push("NOT DONE" + (simple(o.error) ? ": " + one(o.error, 160) : ` (${status})`));
    if (Array.isArray(o.changes) && o.changes.length) bits.push(o.changes.filter(simple).join("; "));
    if (o.priceKept === true) bits.push("price unchanged");
    if (b.driverId != null && b.driverId !== "") bits.push("driver: " + (await nameOf("ops_drivers", "name", b.driverId) || "none"));
    if (b.vehicleId != null && b.vehicleId !== "") bits.push("vehicle: " + (await nameOf("ops_vehicles", "label", b.vehicleId) || "none"));
    /* a name only where there is no booking reference to go by: a driver, an
       account, an agent - not a passenger */
    if (!ref) { const n = one(b.name || b.label || (ok && simple(o.name) ? o.name : ""), 60); if (n) bits.push("name: " + n); }
    for (const k of IN_KEYS) {
      const v = b[k];
      if (!safe(v)) continue;
      if ((k === "from" || k === "to") && !DATE.test(String(v))) continue;
      bits.push(`${k}: ${one(v, 60)}`);
    }
    if (ok) for (const k of OUT_KEYS) {
      const v = o[k];
      /* "emailed" comes back as true or as the address it went to: only that it was sent is kept */
      if (k === "emailed") { if (v) bits.push("guest emailed"); continue; }
      if (safe(v)) bits.push(`${k}: ${one(v, 40)}`);
    }
    if (ok && plain(o.invoice).number) {
      bits.push("invoice: " + one(o.invoice.number, 30) + (o.invoice.replaces ? " (replaces " + one(o.invoice.replaces, 30) + ")" : "") +
        (simple(o.invoice.total) ? ", $" + one(o.invoice.total, 12) : ""));
    }
    if (ok && !ref && simple(o.id) && !("id" in b)) bits.push(`new id: ${one(o.id, 20)}`);
    return { ref, detail: bits.join("; "), ok };
  }

  /* Called by requireAdmin once it knows who is asking. Reads are not
     logged; everything else is, when the response has gone. */
  function track(req, res, extra) {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const path = String(req.baseUrl || "") + String(req.path || "");
    if (NOT_CHANGES.has(path)) return;
    let out = null;
    const json = res.json.bind(res);
    res.json = (d) => { out = d; return json(d); };
    res.on("finish", () => {
      const b = plain(req.body);
      if (b.dryRun === true || b.dryRun === "true") return;
      describe(path, req.body, out, res.statusCode, extra)
        .then((d) => record(req.staff, LABELS[path] || `${req.method} ${path}`, { path, ref: d.ref, detail: d.detail, ok: d.ok }))
        .catch((e) => console.error("office activity:", e.message));
    });
  }

  /* ---- signing in ----------------------------------------------------- */
  async function signIn(pin) {
    await ready;
    const { rows } = await pool.query("SELECT id, name, pin_hash, pin_ver FROM office_users WHERE active ORDER BY id");
    const u = rows.find((r) => pinMatches(pin, r.pin_hash));
    if (!u) return null;
    await pool.query("UPDATE office_users SET last_login_at = now() WHERE id = $1", [u.id]).catch(() => {});
    return { id: u.id, name: u.name, pinVer: Number(u.pin_ver) };
  }
  /* The person behind a staff session, or null once the login is switched
     off or its PIN has been reset. */
  async function userFor(claim) {
    const { rows } = await pool.query("SELECT id, name, active, pin_ver FROM office_users WHERE id = $1", [parseInt(claim.uid, 10) || 0]);
    const u = rows[0];
    return u && u.active && Number(u.pin_ver) === Number(claim.upv) ? staffOf(u) : null;
  }

  /* ---- managing the logins (main login only) -------------------------- */
  async function freshPin() {
    const { rows } = await pool.query("SELECT pin_hash FROM office_users");
    const main = String(adminPin() || "");
    for (let i = 0; i < 20; i++) {
      const pin = String(crypto.randomInt(10000000, 100000000));
      if (pin !== main && !rows.some((r) => pinMatches(pin, r.pin_hash))) return pin;
    }
    throw new Error("could not find a free PIN");
  }
  const cleanName = (v) => String(v == null ? "" : v).trim().replace(/\s+/g, " ").slice(0, 60);
  const pub = (r) => ({ id: r.id, name: r.name, active: !!r.active, createdAt: r.created_at, lastLoginAt: r.last_login_at });
  const activeCount = async () => Number((await pool.query("SELECT COUNT(*) AS n FROM office_users WHERE active")).rows[0].n);

  function routes(requireAdmin) {
    const requireOwner = (req, res, next) => requireAdmin(req, res, () =>
      (req.staff && req.staff.owner ? next() : res.status(403).json({ error: OWNER_ONLY })));
    const fail = (res, what) => (err) => { console.error(what + ":", err); res.status(500).json({ error: "Could not do that just now." }); };

    app.get("/admin/whoami", requireAdmin, (req, res) =>
      res.json({ name: req.staff.name, role: req.staff.owner ? "owner" : "staff" }));

    app.get("/admin/staff", requireOwner, (req, res) => {
      pool.query("SELECT id, name, active, created_at, last_login_at FROM office_users ORDER BY active DESC, name")
        .then(({ rows }) => res.json({ staff: rows.map(pub), max: STAFF_MAX })).catch(fail(res, "staff list"));
    });

    app.post("/admin/staff/add", requireOwner, async (req, res) => {
      try {
        const name = cleanName(req.body && req.body.name);
        if (name.length < 2) return res.status(400).json({ error: "Enter the person's name." });
        if (name.toLowerCase() === OWNER.toLowerCase()) return res.status(400).json({ error: "Use the person's own name." });
        const { rows: same } = await pool.query("SELECT id FROM office_users WHERE lower(name) = lower($1)", [name]);
        if (same.length) return res.status(400).json({ error: "There is already a login with that name. Switch it back on, or use a different name." });
        if (await activeCount() >= STAFF_MAX) return res.status(400).json({ error: `There are ${STAFF_MAX} staff logins already - switch one off first.` });
        const pin = await freshPin();
        const { rows } = await pool.query(
          "INSERT INTO office_users (name, pin_hash) VALUES ($1, $2) RETURNING id, name, active, created_at, last_login_at", [name, makePinHash(pin)]);
        res.json({ ok: true, user: pub(rows[0]), pin, name });
      } catch (err) { fail(res, "staff add")(err); }
    });

    app.post("/admin/staff/pin", requireOwner, async (req, res) => {
      try {
        const { rows } = await pool.query("SELECT id, name, active FROM office_users WHERE id = $1", [parseInt(req.body && req.body.id, 10) || 0]);
        const u = rows[0];
        if (!u) return res.status(404).json({ error: "No such staff login." });
        if (!u.active) return res.status(400).json({ error: "That login is switched off. Switch it on to give it a new PIN." });
        const pin = await freshPin();
        await pool.query("UPDATE office_users SET pin_hash = $2, pin_ver = pin_ver + 1 WHERE id = $1", [u.id, makePinHash(pin)]);
        res.json({ ok: true, pin, name: u.name });
      } catch (err) { fail(res, "staff pin")(err); }
    });

    /* Switching a login off ends its sessions at once (userFor). Switching it
       back on gives it a new PIN: the old one was known to whoever left. */
    app.post("/admin/staff/update", requireOwner, async (req, res) => {
      try {
        const b = req.body || {};
        const { rows } = await pool.query("SELECT id, name, active FROM office_users WHERE id = $1", [parseInt(b.id, 10) || 0]);
        const u = rows[0];
        if (!u) return res.status(404).json({ error: "No such staff login." });
        const active = b.active != null ? b.active === true || b.active === "true" : u.active;
        if (active && !u.active && await activeCount() >= STAFF_MAX) return res.status(400).json({ error: `There are ${STAFF_MAX} staff logins already - switch one off first.` });
        const pin = active && !u.active ? await freshPin() : null;
        await pool.query(
          `UPDATE office_users SET active = $2${pin ? ", pin_hash = $3, pin_ver = pin_ver + 1" : !active && u.active ? ", pin_ver = pin_ver + 1" : ""} WHERE id = $1`,
          pin ? [u.id, active, makePinHash(pin)] : [u.id, active]);
        res.json({ ok: true, pin, name: u.name, active });
      } catch (err) { fail(res, "staff update")(err); }
    });

    /* The log, newest first, a hundred at a time. who: a staff id, "owner",
       or nothing for everyone. from/to are Brisbane dates. q finds a booking
       reference or a word in the action or detail. */
    app.get("/admin/activity", requireOwner, async (req, res) => {
      try {
        const q = req.query || {};
        const where = [], args = [];
        const add = (sql, v) => { args.push(v); where.push(sql.replace("?", "$" + args.length)); };
        if (q.who === "owner") where.push("user_id IS NULL");
        else if (parseInt(q.who, 10)) add("user_id = ?", parseInt(q.who, 10));
        if (DATE.test(String(q.from || ""))) add("at >= ?", new Date(q.from + "T00:00:00+10:00"));
        if (DATE.test(String(q.to || ""))) add("at < ?", new Date(new Date(q.to + "T00:00:00+10:00").getTime() + 864e5));
        if (parseInt(q.before, 10)) add("id < ?", parseInt(q.before, 10));
        const find = one(q.q, 60).toLowerCase();
        if (find) { args.push("%" + find.replace(/[%_\\]/g, "") + "%"); const p = "$" + args.length;
          where.push(`(lower(coalesce(ref, '')) LIKE ${p} OR lower(action) LIKE ${p} OR lower(coalesce(detail, '')) LIKE ${p})`); }
        const LIMIT = 100;
        const { rows } = await pool.query(
          `SELECT id, at, user_id, who, action, ref, detail, ok FROM office_activity
            ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${LIMIT + 1}`, args);
        const { rows: people } = await pool.query("SELECT id, name, active FROM office_users ORDER BY name");
        res.json({
          rows: rows.slice(0, LIMIT).map((r) => ({ id: r.id, at: r.at, who: r.who, owner: r.user_id == null, action: r.action, ref: r.ref || "", detail: r.detail || "", ok: !!r.ok })),
          more: rows.length > LIMIT, people: people.map((p) => ({ id: p.id, name: p.name, active: !!p.active })), ownerName: OWNER });
      } catch (err) { fail(res, "activity")(err); }
    });
  }

  return { OWNER, ready, ownerOf, signIn, userFor, track, record, routes };
};

/* Which staff login created each of these agents, going by the log (newest
   entry first): a successful "Saved an agent" that names the code and says
   "created: true", made by a login that still exists. { CODE: userId }.
   Used once, to hand agents that predate keepers to whoever set them up. */
module.exports.agentCreators = function agentCreators(logRows, codes, loginIds) {
  const out = {};
  for (const code of codes) {
    if (!/^[A-Z0-9]{2,16}$/.test(String(code))) continue;
    const names = new RegExp("(^|; )code: " + code + "(;|$)", "i");
    const hit = (logRows || []).find((l) => l && l.user_id != null && loginIds.has(Number(l.user_id)) &&
      names.test(String(l.detail || "")) && /(^|; )created: true(;|$)/.test(String(l.detail || "")));
    if (hit) out[code] = Number(hit.user_id);
  }
  return out;
};
