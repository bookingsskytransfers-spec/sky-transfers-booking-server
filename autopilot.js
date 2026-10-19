/**
 * Sky Transfers — Autopilot: the office's routine work, done on a timer
 * ---------------------------------------------------------------------
 * Mounted after ops.js and billing.js and using only what they export. It
 * never does anything a person could not undo, and it never sends a driver
 * or a customer anything by itself:
 *
 *   Dispatch   The evening before (18:00 by default) it picks a driver and
 *              car for every unassigned leg tomorrow and emails the office
 *              one list, ready to send. The office still taps Send - the
 *              WhatsApp message goes from the office's phone. A booking that
 *              arrives after that run, or a driver who turns a job down, is
 *              picked again on the next check and the office is told.
 *              A leg the office has touched (any dispatch row that is not a
 *              decline) is the office's: Autopilot leaves it alone.
 *   Close      A job still open three hours after it should have finished is
 *              chased. One the driver had started (on location / passenger
 *              on board) is marked done; one never started is only flagged.
 *   Invoices   Each account or agent can be invoiced weekly, fortnightly or
 *              monthly. When a period ends the invoice is ISSUED and the
 *              office gets an email with an Approve button; nothing reaches
 *              the customer until that button is pressed.
 *   Digest     06:30 every morning: today's jobs and everything that needs a
 *              person - unassigned, unsent, unaccepted, unclosed, invoices
 *              waiting for approval or overdue, papers about to expire.
 *   Intake     Reads the bookings inbox (read-only) for emails from the
 *              addresses each account books from, and puts each booking it
 *              can read on the board marked "Check". Anything it cannot read
 *              with certainty - two bookings in one email, a change or a
 *              cancellation, a missing date - goes to the office instead.
 *
 * Everything is off until switched on in dispatch.html (Autopilot tab).
 * Each run is claimed in ops_runs before it acts, so a restart, a second
 * instance or a double "Run now" can never do the same thing twice.
 */
module.exports = function installAutopilot(ctx) {
  const { app, pool, requireAdmin, ops, billing, mailer, BOOKINGS_EMAIL, VEHICLES, makeRef } = ctx;
  if (!app || !pool || typeof requireAdmin !== "function" || !ops || !ops.on) {
    console.log("Autopilot off (needs ops.js and the portal database)");
    return { on: false };
  }
  const crypto = require("crypto");
  const express = require("express");
  const { parseBookingEmail } = require("./intake-parse");
  const nowMs = typeof ctx.now === "function" ? ctx.now : () => Date.now();
  const SECRET = process.env.AGENT_SECRET || "";
  const KEY = crypto.createHmac("sha256", SECRET).update("sky-autopilot-approve-v1").digest();
  const SITE = String(process.env.PUBLIC_SITE_URL || "https://www.skytransfers.com.au").replace(/\/+$/, "");
  const SERVER = String(process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_SERVER_URL || "https://sky-transfers-booking-server.onrender.com").replace(/\/+$/, "");
  const BOARD = SITE + "/dispatch.html";

  const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const hhmm = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "")); return m && +m[1] < 24 && +m[2] < 60 ? m[1].padStart(2, "0") + ":" + m[2] : null; };
  const minutesOf = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); return m ? +m[1] * 60 + +m[2] : null; };
  const addDays = ops.addDays;
  const inList = (n, start) => Array.from({ length: n }, (_, i) => "$" + (i + (start || 1))).join(", ");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (c) => "$" + (c / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const niceDay = (d) => { const x = new Date(d + "T00:00:00Z"); return DAYS[x.getUTCDay()] + " " + x.getUTCDate() + " " + MONTHS[x.getUTCMonth()]; };

  /* Brisbane is UTC+10 all year. abs is minutes on the same scale as a leg's
     date + time, so "is it past pick-up" is a subtraction. */
  function bne() {
    const t = nowMs() + 10 * 3600e3;
    const iso = new Date(t).toISOString();
    return { date: iso.slice(0, 10), min: +iso.slice(11, 13) * 60 + +iso.slice(14, 16), abs: Math.floor(t / 60000), hm: iso.slice(11, 16) };
  }
  const legAbs = (l) => Date.parse(l.date + "T00:00:00Z") / 60000 + (minutesOf(l.time) || 0);
  const legSpan = (l) => { const s = legAbs(l); return [s, s + (l.hours ? l.hours * 60 + 30 : 120)]; };
  const legName = (l) => l.ref + (l.leg === "ret" ? " (return)" : "");
  const legLine = (l) => `${l.time}  ${legName(l)}  ${l.from} -> ${l.to}  | ${l.vehicleClass || "no vehicle given"}, ${l.pax} pax` +
    (l.hours ? `, ${l.hours} h` : "") + (l.account ? `  [${l.account}]` : "");

  /* ---- schema --------------------------------------------------------------- */
  async function initSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ops_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ops_runs (
        key TEXT PRIMARY KEY,
        at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ops_events (
        id      SERIAL PRIMARY KEY,
        at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        kind    TEXT NOT NULL,
        ref     TEXT,
        leg     TEXT,
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ops_events_at ON ops_events (at);
      CREATE TABLE IF NOT EXISTS ops_bill_schedules (
        party_type   TEXT NOT NULL,
        party_key    TEXT NOT NULL,
        cycle        TEXT NOT NULL DEFAULT 'none',
        anchor       DATE,
        last_through DATE,
        last_run     TIMESTAMPTZ,
        last_invoice TEXT,
        active       BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY (party_type, party_key)
      );
      CREATE TABLE IF NOT EXISTS ops_intake (
        message_id TEXT PRIMARY KEY,
        seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        from_addr  TEXT,
        subject    TEXT,
        account    TEXT,
        status     TEXT NOT NULL,
        ref        TEXT,
        detail     TEXT
      );
    `);
  }

  /* ---- settings ------------------------------------------------------------- */
  const DEFAULTS = {
    dispatchOn: false, dispatchAt: "18:00",
    closeOn: false, closeAfterHours: 3, autoCloseStarted: true,
    invoicesOn: false, invoiceAt: "07:00",
    digestOn: false, digestAt: "06:30",
    intakeOn: false, intakeSince: null,
    alertTo: "",
    /* Phase 3, guest-updates.js: emails (and later WhatsApp) to the guest -
       driver assigned the evening before, on the way, arrived. */
    guestOn: false, guestNoticeAt: "19:00", guestAgentAccount: false, guestWhatsApp: false,
  };
  async function getSettings() {
    const { rows } = await pool.query(`SELECT value FROM ops_settings WHERE key = 'autopilot'`);
    let saved = {}; try { saved = rows[0] ? JSON.parse(rows[0].value) : {}; } catch (e) { saved = {}; }
    return Object.assign({}, DEFAULTS, saved);
  }
  async function saveSettings(patch) {
    const cur = await getSettings();
    const b = patch || {}, next = Object.assign({}, cur);
    const bool = (k) => { if (k in b) next[k] = b[k] === true || b[k] === "true"; };
    ["dispatchOn", "closeOn", "autoCloseStarted", "invoicesOn", "digestOn", "intakeOn",
     "guestOn", "guestAgentAccount", "guestWhatsApp"].forEach(bool);
    for (const k of ["dispatchAt", "invoiceAt", "digestAt", "guestNoticeAt"]) if (k in b) { const t = hhmm(b[k]); if (!t) throw { code: 400, message: "Times are 24-hour, like 18:00." }; next[k] = t; }
    if ("closeAfterHours" in b) {
      const h = parseInt(b.closeAfterHours, 10);
      if (!(h >= 1 && h <= 12)) throw { code: 400, message: "Chase unclosed jobs after 1 to 12 hours." };
      next.closeAfterHours = h;
    }
    if ("alertTo" in b) {
      const a = String(b.alertTo || "").trim().slice(0, 200);
      if (a && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) throw { code: 400, message: "That alert address doesn't look like an email." };
      next.alertTo = a;
    }
    /* Only mail that arrives after intake is switched on is read, so the
       first run can't re-enter a week of bookings already typed in. */
    if (next.intakeOn && !cur.intakeOn) next.intakeSince = new Date(nowMs()).toISOString();
    await pool.query(
      `INSERT INTO ops_settings (key, value, updated_at) VALUES ('autopilot', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(next)]);
    return next;
  }

  /* ---- bookkeeping ------------------------------------------------------------ */
  /* A plain INSERT whose duplicate-key error means "someone already did it",
     rather than ON CONFLICT DO NOTHING and its row count - the one answer
     every Postgres and every test double agrees on. Looked up first, so the
     ordinary "already done today" case never raises an error at all. */
  async function insertOnce(sql, params) {
    try { await pool.query(sql, params); return true; }
    catch (e) { if (e && e.code === "23505") return false; throw e; }
  }
  async function claim(key) {
    if (await hasRun(key)) return false;
    return insertOnce(`INSERT INTO ops_runs (key) VALUES ($1)`, [key]);
  }
  async function hasRun(key) {
    return (await pool.query(`SELECT 1 FROM ops_runs WHERE key = $1`, [key])).rows.length > 0;
  }
  async function logEvent(kind, message, ref, leg) {
    await pool.query(`INSERT INTO ops_events (kind, ref, leg, message) VALUES ($1, $2, $3, $4)`,
      [kind, ref || null, leg || null, String(message).slice(0, 1000)]).catch((e) => console.error("autopilot event:", e.message));
    console.log("autopilot:", kind, ref || "", leg || "", String(message).slice(0, 160));
  }
  async function alert(s, subject, text) {
    if (!mailer) return false;
    await mailer.sendMail({
      from: `"Sky Transfers Autopilot" <${process.env.GMAIL_USER}>`, to: s.alertTo || BOOKINGS_EMAIL,
      subject, text: text + `\n\n-- \nSky Transfers Autopilot. Settings: ${BOARD} (Autopilot tab).`,
    });
    return true;
  }

  /* ---- choosing a driver ---------------------------------------------------------
     Eligible: active, has not turned this leg down, licence and driver
     authorisation not expired on the day, free for the whole job, and with a
     car of the class booked that is also free (their own car if they bring
     one; a fleet car if not). Until any vehicle is on file the car check is
     skipped and the office is told to check it. Employees are offered work
     before subcontractors; within each, whoever has the fewest jobs that day. */
  function pickDriver(leg, legs, drivers, vehicles) {
    const okOn = (date, ...exp) => exp.every((e) => !e || e >= date);
    const [s0, e0] = legSpan(leg);
    const busy = (field, id) => legs.some((o) => o !== leg && o[field] === id && o.status !== "declined" &&
      (() => { const [s, e] = legSpan(o); return s < e0 && s0 < e; })());
    const fleet = vehicles.filter((v) => v.active);
    const classCars = fleet.filter((v) => v.class && v.class === leg.vehicleClass && okOn(leg.date, v.rego_expiry, v.insurance_expiry));
    const active = drivers.filter((d) => d.active);
    if (!active.length) return { reason: "there are no active drivers on file" };
    if (fleet.length && !classCars.length) return { reason: `there is no ${leg.vehicleClass || "matching"} vehicle on file` };
    const options = [];
    for (const d of active) {
      if ((leg.declinedIds || []).includes(d.id)) continue;
      if (!okOn(leg.date, d.licence_expiry, d.authority_expiry)) continue;
      if (busy("driverId", d.id)) continue;
      let car = null;
      if (fleet.length) {
        car = classCars.find((v) => (d.own_vehicle ? v.owner_driver_id === d.id : !v.owner_driver_id) && !busy("vehicleId", v.id));
        if (!car) continue;
      }
      const load = legs.filter((o) => o.date === leg.date && o.driverId === d.id && o.status !== "declined").length;
      options.push({ d, car, load });
    }
    if (!options.length) return { reason: "every suitable driver is busy then, has turned it down, or has papers expired" };
    options.sort((a, b) => (a.d.kind === "employee" ? 0 : 1) - (b.d.kind === "employee" ? 0 : 1) || a.load - b.load || a.d.id - b.d.id);
    const { d, car } = options[0];
    const payCents = d.pay_type === "percent"
      ? (leg.price ? Math.round(leg.price * d.pay_value / 100) * 100 : null)
      : (d.pay_value ? Math.round(d.pay_value * 100) : null);
    return { driver: d, vehicle: car, payCents, checkCar: !fleet.length };
  }

  /* ---- dispatch ------------------------------------------------------------------ */
  async function dispatchPass(s, opts) {
    const n = bne(), force = !!(opts && opts.force);
    const eveningKey = "evening:" + n.date;
    /* "Run now" does tomorrow straight away and sends the list, but does not
       use up the evening run: the 18:00 list still comes, with whatever has
       been booked since. */
    let evening = false;
    if (force) evening = true;
    else if (n.min >= minutesOf(s.dispatchAt)) evening = await claim(eveningKey);
    const eveningDone = evening || (await hasRun(eveningKey));
    const last = eveningDone ? addDays(n.date, 1) : n.date;
    const board = await ops.boardFor(addDays(n.date, -1), addDays(last, 1));
    const scope = board.legs.filter((l) => l.date >= n.date && l.date <= last);
    const refs = [...new Set(scope.map((l) => l.ref))];
    const rows = refs.length ? (await pool.query(`SELECT ref, leg, status FROM ops_dispatch WHERE ref IN (${inList(refs.length)})`, refs)).rows : [];
    const rowOf = (l) => rows.find((r) => r.ref === l.ref && r.leg === l.leg);
    const todo = scope.filter((l) => {
      const r = rowOf(l);
      if (r && r.status !== "declined") return false;
      if (l.source === "web" && l.payState === "requested") return false;   // not accepted yet
      return legAbs(l) > n.abs;
    }).sort((a, b) => legAbs(a) - legAbs(b));
    const picked = [], missed = [];
    for (const l of todo) {
      const wasDeclined = l.status === "declined";
      const declinedBy = wasDeclined ? l.driverName : null;
      const p = pickDriver(l, board.legs, board.drivers, board.vehicles);
      if (!p.driver) {
        if (await claim(`nodriver:${l.ref}:${l.leg}:${n.date}${wasDeclined ? ":d" + (l.declinedIds || []).length : ""}`)) {
          missed.push({ l, reason: p.reason, declinedBy });
          await logEvent("no-driver", `No driver found for ${legName(l)} on ${l.date} ${l.time}: ${p.reason}.`, l.ref, l.leg);
        }
        continue;
      }
      try {
        await ops.assignLeg({ ref: l.ref, leg: l.leg, driverId: p.driver.id, vehicleId: p.vehicle ? p.vehicle.id : null,
          payCents: p.payCents, note: l.officeNote || null, auto: true });
      } catch (e) {
        await logEvent("error", `Could not assign ${legName(l)}: ${e.message || e}`, l.ref, l.leg);
        continue;
      }
      Object.assign(l, { driverId: p.driver.id, driverName: p.driver.name, vehicleId: p.vehicle ? p.vehicle.id : null,
        vehicleLabel: p.vehicle ? p.vehicle.label : null, status: "assigned", auto: true, sentAt: null,
        driverPay: p.payCents != null ? p.payCents / 100 : null });
      picked.push({ l, declinedBy, checkCar: p.checkCar });
      await logEvent("assigned", `${legName(l)} ${l.date} ${l.time} -> ${p.driver.name}${p.vehicle ? " in " + p.vehicle.label : ""}` +
        (declinedBy ? ` (after ${declinedBy} turned it down)` : ""), l.ref, l.leg);
    }
    const pickedLine = (x) => "  " + legLine(x.l) + `\n      -> ${x.l.driverName}` + (x.l.vehicleLabel ? `, ${x.l.vehicleLabel}` : "") +
      (x.l.driverPay != null ? `, pay $${x.l.driverPay}` : ", pay not set") + (x.declinedBy ? `  (${x.declinedBy} turned it down)` : "") +
      (x.checkCar ? "  - check the car, no vehicles are on file" : "") + (x.l.needsReview ? "  - CHECK: read from an email" : "");
    const missedLine = (x) => "  " + legLine(x.l) + `\n      NO DRIVER: ${x.reason}` + (x.declinedBy ? ` (${x.declinedBy} turned it down)` : "");
    if (evening) {
      const tomorrow = addDays(n.date, 1);
      const day = board.legs.filter((l) => l.date === tomorrow);
      const ready = day.filter((l) => l.driverId && l.status === "assigned" && !l.sentAt);
      const sent = day.filter((l) => l.driverId && (l.sentAt || l.status !== "assigned") && l.status !== "declined");
      const none = day.filter((l) => !l.driverId || l.status === "declined" || l.status === "unassigned");
      const lines = [];
      lines.push(`Tomorrow, ${niceDay(tomorrow)}: ${day.length} job${day.length === 1 ? "" : "s"}.`);
      lines.push("");
      if (ready.length) {
        lines.push(`READY TO SEND (${ready.length}) - open the board and tap Send on each:`);
        for (const l of ready) lines.push(pickedLine({ l, declinedBy: null, checkCar: !board.vehicles.some((v) => v.active) && l.auto }));
        lines.push("");
      }
      if (none.length) {
        lines.push(`STILL NEED A DRIVER (${none.length}):`);
        for (const l of none) { const m = missed.find((x) => x.l === l); lines.push("  " + legLine(l) + (m ? `\n      ${m.reason}` : "\n      left unassigned on the board")); }
        lines.push("");
      }
      if (sent.length) {
        lines.push(`ALREADY SENT OR UNDER WAY (${sent.length}):`);
        for (const l of sent) lines.push("  " + legLine(l) + `\n      ${l.driverName || "?"} - ${l.status.replace("_", " ")}`);
        lines.push("");
      }
      lines.push(`Board: ${BOARD}?date=${tomorrow}`);
      await alert(s, `Tomorrow's jobs: ${ready.length} ready to send` + (none.length ? `, ${none.length} need a driver` : ""), lines.join("\n"));
      await logEvent("evening", `Evening run for ${tomorrow}: ${picked.length} assigned, ${ready.length} ready to send, ${none.length} without a driver.`);
    } else if (picked.length || missed.length) {
      const lines = [];
      if (picked.length) { lines.push(`READY TO SEND (${picked.length}):`); picked.forEach((x) => lines.push(pickedLine(x))); lines.push(""); }
      if (missed.length) { lines.push(`NEED A DRIVER (${missed.length}):`); missed.forEach((x) => lines.push(missedLine(x))); lines.push(""); }
      lines.push(`Board: ${BOARD}?date=${n.date}`);
      const soonest = picked.concat(missed).map((x) => x.l).sort((a, b) => legAbs(a) - legAbs(b))[0];
      await alert(s, (missed.length ? `NEEDS A DRIVER: ` : `Send now: `) + `${legName(soonest)} ${niceDay(soonest.date)} ${soonest.time}` +
        (picked.length + missed.length > 1 ? ` and ${picked.length + missed.length - 1} more` : ""), lines.join("\n"));
    }
    return { evening, picked: picked.map((x) => legName(x.l) + " " + x.l.driverName), missed: missed.map((x) => legName(x.l)) };
  }

  /* ---- closing finished jobs ---------------------------------------------------- */
  async function closePass(s) {
    const n = bne();
    const board = await ops.boardFor(addDays(n.date, -2), n.date);
    const closed = [], chase = [];
    for (const l of board.legs) {
      if (!l.driverId || !["assigned", "accepted", "on_way", "on_location", "pob"].includes(l.status)) continue;
      const due = legAbs(l) + (l.hours ? l.hours * 60 : 0) + s.closeAfterHours * 60;
      if (n.abs < due) continue;
      if (s.autoCloseStarted && (l.status === "on_location" || l.status === "pob")) {
        const r = await pool.query(
          `UPDATE ops_dispatch SET status = 'done', done_at = COALESCE(done_at, now()), updated_at = now()
            WHERE ref = $1 AND leg = $2 AND status = $3`, [l.ref, l.leg, l.status]);
        if (r.rowCount) { closed.push(l); await logEvent("closed", `${legName(l)} marked done - ${l.driverName} had reached "${l.status.replace("_", " ")}" and never pressed Done.`, l.ref, l.leg); }
      } else if (await claim(`chase:${l.ref}:${l.leg}`)) {
        chase.push(l);
        await logEvent("unclosed", `${legName(l)} ${l.date} ${l.time} is still "${l.status.replace("_", " ")}" with ${l.driverName}.`, l.ref, l.leg);
      }
    }
    if (chase.length || closed.length) {
      const lines = [];
      if (chase.length) {
        lines.push(`NOT CLOSED (${chase.length}) - ask the driver, then mark it Done on the board (or fix it):`);
        chase.forEach((l) => lines.push("  " + legLine(l) + `\n      ${l.driverName} - last step: ${l.status.replace("_", " ")}`));
        lines.push("");
      }
      if (closed.length) {
        lines.push(`MARKED DONE FOR YOU (${closed.length}) - the driver had started but never pressed Done:`);
        closed.forEach((l) => lines.push("  " + legLine(l) + `\n      ${l.driverName}`));
        lines.push("");
      }
      lines.push(`Board: ${BOARD}`);
      await alert(s, chase.length ? `Not closed: ${chase.map(legName).slice(0, 3).join(", ")}${chase.length > 3 ? " and more" : ""}` : `Closed ${closed.length} finished job${closed.length === 1 ? "" : "s"}`, lines.join("\n"));
    }
    return { closed: closed.map(legName), chased: chase.map(legName) };
  }

  /* ---- scheduled invoices -----------------------------------------------------
     The last complete period before today. Weekly runs Monday to Sunday;
     fortnightly counts fortnights from the schedule's anchor Monday; monthly
     is the calendar month. A missed run (the server was down, the schedule
     was paused) is caught up from the day after the last one invoiced, up to
     two months back - and a booking already on an invoice is never billed
     again whatever the dates say. */
  function periodFor(sc, today) {
    const day = (d) => Math.round(Date.parse(d + "T00:00:00Z") / 864e5);
    let from, to;
    if (sc.cycle === "weekly") {
      const dow = (new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7;      // Monday 0
      to = addDays(today, -dow - 1); from = addDays(to, -6);
    } else if (sc.cycle === "fortnightly") {
      const a = isoDate(sc.anchor); if (!a) return null;
      const k = Math.floor((day(today) - day(a)) / 14);
      if (k < 1) return null;
      to = addDays(a, 14 * k - 1); from = addDays(to, -13);
    } else if (sc.cycle === "monthly") {
      to = addDays(today.slice(0, 8) + "01", -1); from = to.slice(0, 8) + "01";
    } else return null;
    const lt = isoDate(sc.last_through);
    if (lt) {
      if (lt >= to) return null;
      const next = addDays(lt, 1);
      if (next >= addDays(from, -62)) from = next;
    }
    return from <= to ? { from, to } : null;
  }
  function approveToken(id) {
    const body = Buffer.from(JSON.stringify({ k: "inv", i: id, x: nowMs() + 30 * 864e5 })).toString("base64url");
    return body + "." + crypto.createHmac("sha256", KEY).update(body).digest("base64url");
  }
  function approvedId(t) {
    const [body, sig] = String(t || "").split(".");
    if (!body || !sig || !SECRET) return null;
    const want = crypto.createHmac("sha256", KEY).update(body).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let c; try { c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (e) { return null; }
    if (!c || c.k !== "inv" || !Number.isInteger(c.i) || !(c.x > nowMs())) return null;
    return c.i;
  }
  const approveUrl = (id) => SERVER + "/autopilot/invoice?t=" + approveToken(id);

  async function invoicePass(s, opts) {
    if (!billing || !billing.on || !billing.issueInvoice) return { skipped: "billing off" };
    const n = bne(), force = !!(opts && opts.force);
    if (!force && n.min < minutesOf(s.invoiceAt)) return { skipped: "not yet" };
    const { rows: scheds } = await pool.query(
      `SELECT party_type, party_key, cycle, to_char(anchor, 'YYYY-MM-DD') AS anchor,
              to_char(last_through, 'YYYY-MM-DD') AS last_through
         FROM ops_bill_schedules WHERE active AND cycle <> 'none'`);
    const issued = [];
    for (const sc of scheds) {
      const p = periodFor(sc, n.date);
      if (!p) continue;
      if (!(await claim(`inv:${sc.party_type}:${sc.party_key}:${p.to}`))) continue;
      const markThrough = () => pool.query(
        `UPDATE ops_bill_schedules SET last_through = $3, last_run = now() WHERE party_type = $1 AND party_key = $2`,
        [sc.party_type, sc.party_key, p.to]);
      try {
        const d = await billing.draftLines(sc.party_type, sc.party_key, p.from, p.to);
        if (d.error) { await logEvent("invoice", `Scheduled invoice skipped for ${sc.party_type} ${sc.party_key}: ${d.error}`); continue; }
        if (!d.lines.length) { await markThrough(); await logEvent("invoice", `${d.party.name}: nothing to invoice for ${p.from} to ${p.to}.`); continue; }
        const inv = await billing.issueInvoice({ partyType: sc.party_type, partyKey: sc.party_key, from: p.from, to: p.to,
          refs: d.lines.map((l) => l.ref), issuedOn: n.date });
        await markThrough();
        await pool.query(`UPDATE ops_bill_schedules SET last_invoice = $3 WHERE party_type = $1 AND party_key = $2`,
          [sc.party_type, sc.party_key, inv.number]);
        const notDone = d.lines.filter((l) => l.status !== "done").length;
        const refs = d.lines.map((l) => l.ref);
        const review = sc.party_type === "account"
          ? (await pool.query(`SELECT ref FROM ops_jobs WHERE needs_review AND ref IN (${inList(refs.length)})`, refs)).rows.length : 0;
        const lines = [
          `Invoice ${inv.number} for ${inv.party_name} is ready, for ${niceDay(p.from)} to ${niceDay(p.to)} ${p.to.slice(0, 4)}.`,
          "", `${inv.lines.length} job${inv.lines.length === 1 ? "" : "s"}, ${money(inv.total_cents)} including GST, due ${inv.due}.`,
          `It will go to: ${inv.bill_email || "NO BILLING EMAIL ON FILE - type one in on the approval page"}`, "",
        ];
        for (const l of inv.lines) lines.push(`  ${l.date}  ${l.ref}  ${l.description}  ${money(l.amount_cents)}`);
        lines.push("");
        if (notDone) lines.push(`Note: ${notDone} of these ${notDone === 1 ? "was" : "were"} never marked done on the board.`);
        if (review) lines.push(`Note: ${review} came from an email and ${review === 1 ? "has" : "have"} not been checked yet.`);
        if (notDone || review) lines.push("");
        lines.push("Nothing has been sent to the customer. To check it and send it:", approveUrl(inv.id), "",
          `Or open the Invoices tab on the board: ${BOARD}. To change it, void it there and issue it again.`);
        await alert(s, `Approve invoice ${inv.number}: ${inv.party_name}, ${money(inv.total_cents)}`, lines.join("\n"));
        await logEvent("invoice", `Issued ${inv.number} for ${inv.party_name} (${money(inv.total_cents)}, ${inv.lines.length} jobs) - waiting for approval.`);
        issued.push(inv.number);
      } catch (e) {
        await logEvent("error", `Scheduled invoice for ${sc.party_type} ${sc.party_key} failed: ${e.message || e}`);
        await alert(s, `Scheduled invoice failed: ${sc.party_type} ${sc.party_key}`, `Autopilot could not issue the ${sc.cycle} invoice for ${p.from} to ${p.to}:\n${e.message || e}\n\nIssue it by hand on the Invoices tab: ${BOARD}`).catch(() => {});
      }
    }
    return { issued };
  }

  /* ---- the morning digest ---------------------------------------------------------- */
  async function digestPass(s, opts) {
    const n = bne(), force = !!(opts && opts.force);
    if (!force && (n.min < minutesOf(s.digestAt) || !(await claim("digest:" + n.date)))) return { skipped: true };
    const yesterday = addDays(n.date, -1), tomorrow = addDays(n.date, 1);
    const board = await ops.boardFor(yesterday, tomorrow);
    const today = board.legs.filter((l) => l.date === n.date);
    const L = [];
    const section = (title, list, fn) => { if (!list.length) return; L.push(`${title} (${list.length}):`); list.forEach((x) => L.push(fn(x))); L.push(""); };
    const who = (l) => l.driverName ? `${l.driverName} - ${l.status.replace("_", " ")}${l.driverId && !l.sentAt && l.status === "assigned" ? ", NOT SENT" : ""}` : "NO DRIVER";
    L.push(`Good morning. ${niceDay(n.date)}: ${today.length} job${today.length === 1 ? "" : "s"} today.`, "");
    section("TODAY", today, (l) => "  " + legLine(l) + `\n      ${who(l)}`);
    const soon = board.legs.filter((l) => l.date >= n.date);
    section("NO DRIVER YET, today or tomorrow", soon.filter((l) => !l.driverId || l.status === "declined" || l.status === "unassigned"), (l) => `  ${l.date} ` + legLine(l));
    section("ASSIGNED BUT NOT SENT", soon.filter((l) => l.driverId && l.status === "assigned" && !l.sentAt), (l) => `  ${l.date} ` + legLine(l) + `\n      ${l.driverName}`);
    section("SENT, NOT ACCEPTED YET (today)", today.filter((l) => l.driverId && l.status === "assigned" && l.sentAt), (l) => "  " + legLine(l) + `\n      ${l.driverName}`);
    section("NOT CLOSED FROM YESTERDAY", board.legs.filter((l) => l.date === yesterday && l.status !== "done"), (l) => "  " + legLine(l) + `\n      ${who(l)}`);
    const review = (await pool.query(
      `SELECT ref, account, to_char(pickup_date, 'YYYY-MM-DD') AS d, pickup_time AS t FROM ops_jobs
        WHERE needs_review AND status <> 'cancelled' AND pickup_date >= $1 ORDER BY pickup_date, pickup_time`, [yesterday])).rows;
    section("READ FROM EMAIL - NOT CHECKED YET", review, (r) => `  ${r.d} ${r.t}  ${r.ref}  [${r.account || "?"}]`);
    const failed = (await pool.query(
      `SELECT from_addr, subject, detail, status FROM ops_intake WHERE status <> 'created' AND seen_at > $1 ORDER BY seen_at`,
      [new Date(nowMs() - 864e5)])).rows;
    section("BOOKING EMAILS IT COULDN'T READ (last 24 h)", failed, (r) => `  ${r.from_addr}: "${r.subject}"\n      ${r.detail || r.status}`);
    const invs = (await pool.query(
      `SELECT id, number, party_name, total_cents, to_char(due_on, 'YYYY-MM-DD') AS due, sent_at FROM ops_invoices WHERE status = 'issued' ORDER BY id`)).rows;
    section("INVOICES WAITING FOR YOUR APPROVAL", invs.filter((i) => !i.sent_at), (i) => `  ${i.number}  ${i.party_name}  ${money(i.total_cents)}\n      ${approveUrl(i.id)}`);
    section("INVOICES OVERDUE", invs.filter((i) => i.sent_at && i.due < n.date), (i) => `  ${i.number}  ${i.party_name}  ${money(i.total_cents)}, due ${i.due}`);
    const soonDate = addDays(n.date, 30), papers = [];
    for (const d of board.drivers.filter((x) => x.active)) {
      if (d.licence_expiry && d.licence_expiry <= soonDate) papers.push(`  ${d.name}: driver licence ${d.licence_expiry < n.date ? "EXPIRED" : "expires"} ${d.licence_expiry}`);
      if (d.authority_expiry && d.authority_expiry <= soonDate) papers.push(`  ${d.name}: driver authorisation ${d.authority_expiry < n.date ? "EXPIRED" : "expires"} ${d.authority_expiry}`);
    }
    for (const v of board.vehicles.filter((x) => x.active)) {
      for (const [k, label] of [["rego_expiry", "rego"], ["insurance_expiry", "insurance"], ["service_due", "service"]]) {
        if (v[k] && v[k] <= soonDate) papers.push(`  ${v.label}: ${label} ${v[k] < n.date ? "OVERDUE" : "due"} ${v[k]}`);
      }
    }
    section("PAPERS DUE IN THE NEXT 30 DAYS", papers, (x) => x);
    if (L.length <= 3) L.push("Nothing needs you this morning.", "");
    L.push(`Board: ${BOARD}`);
    await alert(s, `Today: ${today.length} job${today.length === 1 ? "" : "s"}` +
      (soon.some((l) => !l.driverId) ? " - some need a driver" : ""), L.join("\n"));
    await logEvent("digest", `Morning digest sent (${today.length} jobs today).`);
    return { sent: true, jobs: today.length };
  }

  /* ---- reading the bookings inbox ---------------------------------------------------
     Read-only (the mailbox is opened with EXAMINE: nothing is marked read,
     moved or deleted). Only mail from an address listed on an account, only
     mail that arrived after intake was switched on, and only a sender that
     passed Gmail's SPF, DKIM or DMARC check - a forged From line goes to the
     office, not the board. */
  async function imapFetch({ since, accept, max }) {
    const { ImapFlow } = require("imapflow");
    const { simpleParser } = require("mailparser");
    const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, logger: false,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
    await client.connect();
    const out = [];
    try {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const uids = (await client.search({ since }, { uid: true })) || [];
        const wanted = [];
        if (uids.length) {
          for await (const m of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
            const f = m.envelope && m.envelope.from && m.envelope.from[0];
            if (f && f.address && accept(f.address.toLowerCase())) wanted.push(m.uid);
          }
        }
        for (const uid of wanted.slice(-(max || 25))) {
          const m = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
          if (!m || !m.source) continue;
          const p = await simpleParser(m.source);
          const auth = [].concat(p.headers.get("authentication-results") || []).join(" ");
          const from = (p.from && p.from.value && p.from.value[0] && p.from.value[0].address || "").toLowerCase();
          out.push({ messageId: p.messageId || ("uid-" + uid + "-" + from), from, subject: p.subject || "", date: p.date || null,
            text: p.text || String(p.html || "").replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "),
            auth });
        }
      } finally { lock.release(); }
    } finally { await client.logout().catch(() => {}); }
    return out;
  }
  const fetchMail = typeof ctx.fetchMail === "function" ? ctx.fetchMail : imapFetch;
  /* Gmail's own verdict, and it has to be about the sender's domain: DMARC
     passing, or a DKIM signature / SPF pass for that domain. A DKIM pass for
     some other domain proves nothing about who wrote the From line. */
  function senderVerified(auth, from) {
    const a = String(auth || "").toLowerCase(), dom = String(from || "").split("@")[1] || "";
    if (!dom) return false;
    if (/\bdmarc=pass\b/.test(a)) return true;
    const same = (d) => d === dom || d.endsWith("." + dom) || dom.endsWith("." + d);
    for (const m of a.matchAll(/\bdkim=pass\b[^;]*?header\.(?:i|d)=@?([a-z0-9.-]+)/g)) if (same(m[1])) return true;
    for (const m of a.matchAll(/\bspf=pass\b[^;]*?smtp\.mailfrom=(?:[^@\s;]*@)?([a-z0-9.-]+)/g)) if (same(m[1])) return true;
    return false;
  }
  let lastIntake = 0;
  function intakeReady() {
    if (typeof ctx.fetchMail === "function") return { ok: true };
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return { ok: false, why: "the Gmail login is not set on the server" };
    try { require.resolve("imapflow"); require.resolve("mailparser"); } catch (e) { return { ok: false, why: "the mail-reading libraries are not installed" }; }
    return { ok: true };
  }
  async function intakePass(s, opts) {
    const force = !!(opts && opts.force);
    if (!force && nowMs() - lastIntake < 10 * 60e3) return { skipped: "too soon" };
    lastIntake = nowMs();
    const ready = intakeReady();
    if (!ready.ok) { if (await claim("intake-off:" + bne().date)) await logEvent("intake", `Can't read the inbox: ${ready.why}.`); return { skipped: ready.why }; }
    const { rows: accts } = await pool.query(`SELECT id, name, intake_from FROM ops_accounts WHERE active AND intake_from IS NOT NULL`);
    const rules = [];
    for (const a of accts) for (const x of String(a.intake_from).split(",").filter(Boolean)) rules.push({ x, a });
    if (!rules.length) return { skipped: "no senders listed" };
    const accountFor = (addr) => { const r = rules.find((r) => r.x.startsWith("@") ? addr.endsWith(r.x) : addr === r.x); return r ? r.a : null; };
    const sinceMs = Math.max(nowMs() - 3 * 864e5, s.intakeSince ? Date.parse(s.intakeSince) : 0);
    const mail = await fetchMail({ since: new Date(sinceMs - 864e5), accept: (addr) => !!accountFor(addr), max: 25 });
    const made = [], handed = [];
    const n = bne();
    for (const m of mail) {
      if (m.date && new Date(m.date).getTime() < sinceMs) continue;
      const acct = accountFor(m.from); if (!acct) continue;
      const id = String(m.messageId).slice(0, 300);
      if ((await pool.query(`SELECT 1 FROM ops_intake WHERE message_id = $1`, [id])).rows.length) continue;
      if (!(await insertOnce(`INSERT INTO ops_intake (message_id, from_addr, subject, account, status) VALUES ($1, $2, $3, $4, 'reading')`,
        [id, m.from, String(m.subject).slice(0, 300), acct.name]))) continue;
      const done = (status, detail, ref) => pool.query(`UPDATE ops_intake SET status = $2, detail = $3, ref = $4 WHERE message_id = $1`, [id, status, detail || null, ref || null]);
      if (!senderVerified(m.auth, m.from)) {
        await done("unverified", "Gmail could not confirm it really came from " + m.from);
        handed.push({ m, acct, why: "Gmail could not confirm this really came from " + m.from + " - check it is genuine before entering it." });
        continue;
      }
      const p = parseBookingEmail({ subject: m.subject, text: m.text, classes: VEHICLES });
      if (!p.ok) { await done(p.kind, p.problems.join(" ")); handed.push({ m, acct, why: p.problems.join(" ") }); continue; }
      const j = p.job;
      if (j.date < n.date) { await done("past", "The date (" + j.date + ") has already gone."); handed.push({ m, acct, why: `The date it gives (${j.date}) has already gone.` }); continue; }
      if (j.accountRef) {
        const dup = (await pool.query(`SELECT ref FROM ops_jobs WHERE lower(account) = lower($1) AND account_ref = $2 AND status <> 'cancelled'`, [acct.name, j.accountRef])).rows[0];
        if (dup) { await done("duplicate", "Already on the board as " + dup.ref); handed.push({ m, acct, why: `Their reference ${j.accountRef} is already on the board as ${dup.ref} - if this is a change, update that job by hand.` }); continue; }
      }
      const note = `Read from an email from ${m.from}` + (m.date ? ` on ${new Date(new Date(m.date).getTime() + 10 * 3600e3).toISOString().slice(0, 16).replace("T", " ")} Brisbane time` : "") +
        `, subject "${String(m.subject).slice(0, 120)}".` + (p.checks.length ? " Check: " + p.checks.join("; ") + "." : "");
      let ref = null;
      for (let i = 0; i < 5 && !ref; i++) {
        const tryRef = makeRef(j.date);
        const made1 = await insertOnce(
          `INSERT INTO ops_jobs (ref, account, account_ref, pickup, dropoff, vehicle, pickup_date, pickup_time, hire_hours,
             passenger_name, passenger_phone, flight, address, notes, pax, price_cents, needs_review, source_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,TRUE,$17)`,
          [tryRef, acct.name, j.accountRef, j.pickup, j.dropoff, j.vehicle || "", j.date, j.time, j.hours,
           j.name || "", j.phone || "", j.flight, j.address, j.notes, Math.min(Math.max(j.pax || 1, 1), 60), j.priceCents || 0, note]);
        if (made1) ref = tryRef;
      }
      if (!ref) { await done("error", "Could not make a reference."); handed.push({ m, acct, why: "Could not make a reference - enter it by hand." }); continue; }
      await done("created", p.checks.join("; "), ref);
      made.push({ ref, acct, j, checks: p.checks, m });
      await logEvent("intake", `${acct.name} email "${String(m.subject).slice(0, 60)}" -> ${ref} on ${j.date} ${j.time}` + (p.checks.length ? ` (check: ${p.checks.join("; ")})` : ""), ref, "out");
    }
    for (const h of handed) await logEvent("intake", `${h.acct.name} email "${String(h.m.subject).slice(0, 60)}" handed to the office: ${h.why}`);
    if (made.length || handed.length) {
      const L = [];
      if (made.length) {
        L.push(`ON THE BOARD, PLEASE CHECK (${made.length}):`);
        for (const x of made) {
          L.push(`  ${x.ref}  [${x.acct.name}${x.j.accountRef ? " " + x.j.accountRef : ""}]  ${x.j.date} ${x.j.time}  ${x.j.pickup} -> ${x.j.dropoff}`,
            `      ${x.j.vehicle || "vehicle?"}, ${x.j.pax} pax, ${x.j.name || "name?"} ${x.j.phone || ""}, ${x.j.priceCents != null ? money(x.j.priceCents) : "price?"}`);
          if (x.checks.length) L.push(`      CHECK: ${x.checks.join("; ")}`);
        }
        L.push("", "Open each on the Account job tab and save it once it's right - that clears the Check flag.", "");
      }
      if (handed.length) {
        L.push(`COULDN'T PUT ON THE BOARD (${handed.length}) - enter these by hand:`);
        for (const h of handed) L.push(`  ${h.acct.name}, from ${h.m.from}: "${String(h.m.subject).slice(0, 100)}"`, `      ${h.why}`);
        L.push("");
      }
      L.push(`Board: ${BOARD}`);
      await alert(s, (handed.length ? `Booking email needs you` : `Read ${made.length} booking${made.length === 1 ? "" : "s"} from email`) +
        (made.length && handed.length ? ` (+${made.length} on the board)` : ""), L.join("\n"));
    }
    return { created: made.map((x) => x.ref), handed: handed.length };
  }

  /* ---- the timer --------------------------------------------------------------------- */
  let running = false;
  async function tick() {
    if (running) return { skipped: "already running" };
    running = true;
    const ran = {};
    try {
      const s = await getSettings();
      const step = async (name, on, fn) => {
        if (!on) return;
        try { ran[name] = await fn(); } catch (e) { ran[name] = { error: e.message || String(e) }; await logEvent("error", `${name}: ${e.message || e}`); }
      };
      await step("intake", s.intakeOn, () => intakePass(s));
      await step("dispatch", s.dispatchOn, () => dispatchPass(s));
      await step("close", s.closeOn, () => closePass(s));
      await step("invoices", s.invoicesOn, () => invoicePass(s));
      await step("digest", s.digestOn, () => digestPass(s));
      if (await claim("prune:" + bne().date)) {
        const old = (d) => new Date(nowMs() - d * 864e5);
        await pool.query(`DELETE FROM ops_events WHERE at < $1`, [old(180)]);
        await pool.query(`DELETE FROM ops_intake WHERE seen_at < $1`, [old(180)]);
        await pool.query(`DELETE FROM ops_runs WHERE at < $1`, [old(120)]);
      }
    } finally { running = false; }
    return ran;
  }

  /* ---- office routes -------------------------------------------------------------- */
  const fail = (res, err, what) => {
    if (err && err.code) return res.status(err.code).json({ error: err.message });
    console.error("autopilot " + what + ":", err);
    res.status(500).json({ error: "Could not " + what + "." });
  };
  app.get("/autopilot/state", requireAdmin, async (req, res) => {
    try {
      const s = await getSettings();
      const accounts = (await pool.query(`SELECT id, name, billing_email, intake_from FROM ops_accounts WHERE active ORDER BY name`)).rows;
      const agents = (await pool.query(`SELECT code, name, email FROM agents WHERE active ORDER BY name`).catch(() => ({ rows: [] }))).rows;
      const sched = (await pool.query(
        `SELECT party_type, party_key, cycle, to_char(anchor, 'YYYY-MM-DD') AS anchor, to_char(last_through, 'YYYY-MM-DD') AS last_through,
                last_invoice, active FROM ops_bill_schedules`)).rows;
      const sOf = (t, k) => sched.find((x) => x.party_type === t && x.party_key === String(k)) || null;
      const parties = accounts.map((a) => ({ type: "account", key: String(a.id), name: a.name, email: a.billing_email, intakeFrom: a.intake_from || "", schedule: sOf("account", a.id) }))
        .concat(agents.map((g) => ({ type: "agent", key: g.code, name: g.name, email: g.email, schedule: sOf("agent", g.code) })));
      const events = (await pool.query(`SELECT id, at, kind, ref, leg, message FROM ops_events ORDER BY id DESC LIMIT 100`)).rows;
      const n = bne();
      res.json({ settings: s, parties, events, now: { date: n.date, time: n.hm }, intake: intakeReady(), mailer: !!mailer,
        alertDefault: BOOKINGS_EMAIL });
    } catch (err) { fail(res, err, "load the autopilot"); }
  });
  app.post("/autopilot/settings", requireAdmin, async (req, res) => {
    try { const s = await saveSettings(req.body || {}); await logEvent("settings", "Settings changed in the office."); res.json({ ok: true, settings: s }); }
    catch (err) { fail(res, err, "save those settings"); }
  });
  app.post("/autopilot/schedule", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const type = b.partyType === "agent" ? "agent" : b.partyType === "account" ? "account" : null;
      const key = String(b.partyKey || "").trim().slice(0, 40);
      if (!type || !key) throw { code: 400, message: "Choose who to invoice." };
      const cycle = ["none", "weekly", "fortnightly", "monthly"].includes(b.cycle) ? b.cycle : null;
      if (!cycle) throw { code: 400, message: "Choose weekly, fortnightly, monthly or none." };
      let anchor = isoDate(b.anchor);
      if (cycle === "fortnightly") {
        if (!anchor) { const t = bne().date; anchor = addDays(t, -((new Date(t + "T00:00:00Z").getUTCDay() + 6) % 7)); }
        if (new Date(anchor + "T00:00:00Z").getUTCDay() !== 1) throw { code: 400, message: "A fortnight starts on a Monday - pick a Monday." };
      }
      const exists = type === "account"
        ? (await pool.query(`SELECT 1 FROM ops_accounts WHERE id = $1`, [parseInt(key, 10) || 0])).rows.length
        : (await pool.query(`SELECT 1 FROM agents WHERE code = $1`, [key])).rows.length;
      if (!exists) throw { code: 404, message: "No such account or agent." };
      await pool.query(
        `INSERT INTO ops_bill_schedules (party_type, party_key, cycle, anchor, active) VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (party_type, party_key) DO UPDATE SET cycle = EXCLUDED.cycle, anchor = EXCLUDED.anchor, active = TRUE`,
        [type, key, cycle, anchor]);
      await logEvent("settings", `Invoice schedule for ${type} ${key}: ${cycle}${anchor && cycle === "fortnightly" ? " from " + anchor : ""}.`);
      res.json({ ok: true });
    } catch (err) { fail(res, err, "save that schedule"); }
  });
  /* "Run now" - the same passes, without waiting for their time of day. */
  app.post("/autopilot/run", requireAdmin, async (req, res) => {
    try {
      const what = String((req.body || {}).what || "");
      const s = await getSettings();
      const fns = { dispatch: () => dispatchPass(s, { force: true }), close: () => closePass(s), invoices: () => invoicePass(s, { force: true }),
                    digest: () => digestPass(s, { force: true }), intake: () => intakePass(s, { force: true }) };
      if (!fns[what]) throw { code: 400, message: "Unknown job." };
      const r = await fns[what]();
      await logEvent("run", `"${what}" run from the office.`);
      res.json({ ok: true, result: r });
    } catch (err) { fail(res, err, "run that"); }
  });

  /* ---- the approval page (linked from the email; the link is the key) ------------------ */
  const page = (title, body) => `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>
body{margin:0;background:#F6F3EA;color:#141D30;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px 48px}h1{font-size:1.4rem;margin:0 0 4px}.muted{color:#68707F}
.card{background:#fff;border:1px solid #E5E0D2;border-radius:12px;padding:16px;margin:16px 0}
table{width:100%;border-collapse:collapse;font-size:.92rem}td{padding:6px 4px;border-top:1px solid #EEE9DB;vertical-align:top}td.r{text-align:right;white-space:nowrap}
label{display:block;font-weight:600;margin:0 0 6px}input{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #CFC8B4;border-radius:8px}
button{margin-top:12px;font:inherit;font-weight:700;background:#141D30;color:#fff;border:0;border-radius:10px;padding:12px 18px;cursor:pointer;width:100%}
.ok{background:#E7F4EA;border-color:#B9DEC2}.warn{background:#FFF4E0;border-color:#F0D49B}a{color:#8A6B12}
</style></head><body><main>${body}</main></body></html>`;
  const sendHeaders = (res) => { res.set("Cache-Control", "no-store"); res.set("Referrer-Policy", "no-referrer"); res.set("X-Robots-Tag", "noindex"); res.type("html"); };
  async function invoiceFromToken(t) {
    const id = approvedId(t);
    if (!id || !billing || !billing.invoiceWithLines) return null;
    return billing.invoiceWithLines(id);
  }
  function invoiceCard(inv) {
    const rows = inv.lines.map((l) => `<tr><td>${esc(niceDay(l.date))}</td><td>${esc(l.ref)}<br><span class="muted">${esc(l.description)}</span></td><td class="r">${esc(money(l.amount_cents))}</td></tr>`).join("");
    return `<div class="card"><table>${rows}<tr><td></td><td><strong>Total (incl. GST ${esc(money(inv.gst_cents))})</strong></td><td class="r"><strong>${esc(money(inv.total_cents))}</strong></td></tr></table></div>`;
  }
  app.get("/autopilot/invoice", async (req, res) => {
    sendHeaders(res);
    try {
      const inv = await invoiceFromToken(req.query.t);
      if (!inv) return res.status(404).send(page("Link expired", `<h1>This link has expired</h1><p>Open the Invoices tab on the <a href="${esc(BOARD)}">board</a> instead.</p>`));
      const head = `<h1>Invoice ${esc(inv.number)}</h1><p class="muted">${esc(inv.party_name)} &middot; ${esc(niceDay(inv.pfrom))} to ${esc(niceDay(inv.pto))} ${esc(inv.pto.slice(0, 4))} &middot; due ${esc(niceDay(inv.due))}</p>`;
      const pdf = `<p><a href="/autopilot/invoice/pdf?t=${esc(req.query.t)}">See the PDF exactly as they will get it</a></p>`;
      if (inv.status === "void") return res.send(page(inv.number, head + `<div class="card warn">This invoice was voided. Nothing was sent.</div>`));
      if (inv.sent_at) return res.send(page(inv.number, head + `<div class="card ok">Already sent to ${esc(inv.sent_to)} on ${esc(new Date(inv.sent_at).toISOString().slice(0, 10))}.</div>` + invoiceCard(inv) + pdf));
      res.send(page("Approve " + inv.number, head + invoiceCard(inv) + pdf +
        `<form method="post" action="/autopilot/invoice"><input type="hidden" name="t" value="${esc(req.query.t)}">
         <label for="to">Send it to</label><input id="to" name="to" type="email" required value="${esc(inv.bill_email || "")}" placeholder="accounts@example.com">
         <button type="submit">Approve and email it</button></form>
         <p class="muted">Something wrong? Don't approve - void it on the Invoices tab and issue it again.</p>`));
    } catch (err) { console.error("autopilot approve page:", err); res.status(500).send(page("Error", "<h1>Something went wrong</h1><p>Try again, or use the board.</p>")); }
  });
  const sending = new Set();
  app.post("/autopilot/invoice", express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    sendHeaders(res);
    const b = req.body || {};
    try {
      const inv = await invoiceFromToken(b.t);
      if (!inv) return res.status(404).send(page("Link expired", `<h1>This link has expired</h1><p>Use the Invoices tab on the <a href="${esc(BOARD)}">board</a>.</p>`));
      if (inv.sent_at) return res.send(page(inv.number, `<h1>Already sent</h1><div class="card ok">${esc(inv.number)} went to ${esc(inv.sent_to)}.</div>`));
      if (sending.has(inv.id)) return res.send(page(inv.number, `<h1>Sending...</h1><p>That one is already on its way.</p>`));
      sending.add(inv.id);
      try {
        const r = await billing.sendInvoice(inv.id, String(b.to || "").trim());
        await logEvent("invoice", `${inv.number} approved and sent to ${r.to}.`);
        res.send(page("Sent " + inv.number, `<h1>Sent</h1><div class="card ok">${esc(inv.number)} for ${esc(inv.party_name)} (${esc(money(inv.total_cents))}) went to <strong>${esc(r.to)}</strong>, with a copy to the bookings inbox.</div><p><a href="${esc(BOARD)}">Back to the board</a></p>`));
      } finally { sending.delete(inv.id); }
    } catch (err) {
      if (err && err.code) return res.status(err.code).send(page("Not sent", `<h1>Not sent</h1><div class="card warn">${esc(err.message)}</div><p><a href="javascript:history.back()">Go back</a></p>`));
      console.error("autopilot approve:", err);
      res.status(500).send(page("Not sent", "<h1>Not sent</h1><p>Something went wrong - nothing was emailed. Try again, or send it from the board.</p>"));
    }
  });
  app.get("/autopilot/invoice/pdf", async (req, res) => {
    try {
      const inv = await invoiceFromToken(req.query.t);
      if (!inv) return res.status(404).type("text").send("This link has expired.");
      const pdf = await billing.invoicePdf(inv);
      res.set("Cache-Control", "no-store"); res.set("Referrer-Policy", "no-referrer");
      res.type("application/pdf").set("Content-Disposition", `inline; filename="${inv.number}.pdf"`).send(pdf);
    } catch (err) { console.error("autopilot pdf:", err); res.status(500).type("text").send("Could not make the PDF."); }
  });

  let timer = null;
  initSchema()
    .then(() => {
      console.log("Autopilot ready (checks every 5 minutes; each job is off until switched on)");
      if (!ctx.noTimer) {
        setTimeout(() => tick().catch((e) => console.error("autopilot tick:", e.message)), 90e3).unref();
        timer = setInterval(() => tick().catch((e) => console.error("autopilot tick:", e.message)), 5 * 60e3);
        timer.unref();
      }
    })
    .catch((e) => console.error("Autopilot setup failed:", e.message));

  return { on: true, tick, dispatchPass, closePass, invoicePass, digestPass, intakePass, getSettings, saveSettings,
           pickDriver, periodFor, approveToken, approvedId, initSchema, stop: () => timer && clearInterval(timer) };
};
