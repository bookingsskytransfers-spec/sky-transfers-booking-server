/**
 * Sky Transfers — Phase 4: bring the upcoming Limo Anywhere bookings across
 * --------------------------------------------------------------------------
 * The source is the "LA Bookings" tab of the BOOKINGS 2026 Google Sheet, the
 * Limo Anywhere import layout (Pickup DateTime, Passenger First/Last Name,
 * Phone, Email, Pax, Luggage, Pickup/Dropoff Address, Account Name, Service
 * Type, Vehicle Type, Reference Number, Notes, Price, Added). The office
 * downloads that tab as CSV and drops it on dispatch.html (Import tab); the
 * page sends the rows here, first as a dry run, then for real.
 *
 * Agreed with Aman, 19 Oct 2026: upcoming bookings and accounts only; a
 * switch-over date of Monday 26 Oct 2026 rather than running both systems;
 * and four account names merged (Nexus DMC -> Nexus, Ram Limo -> Ram Limos,
 * HC SOOD -> Sood, IWAY -> i'way).
 *
 * Each row becomes an ops_job (one leg - Limo Anywhere already lists a return
 * as its own row). Never imported twice: every job carries an import_key made
 * from its date, time, passenger and addresses, and a key already on the
 * board is skipped. Also skipped: past dates, unreadable rows, and website
 * bookings that are already in web_bookings (same day, same surname) - the
 * website has recorded its own bookings since September.
 *
 * Marked Check (needs_review) when there is no price, the vehicle isn't one
 * of our classes, or a "Website" row has no matching website booking.
 * Accounts that don't exist yet are created with a note to add the billing
 * email and ABN, which the sheet does not have.
 */
module.exports = function installLaImport(ctx) {
  const { app, pool, requireAdmin, ops, VEHICLES, makeRef } = ctx;
  if (!app || !pool || typeof requireAdmin !== "function" || !ops || !ops.on) {
    console.log("LA import off (needs ops.js and the portal database)");
    return { on: false };
  }
  const crypto = require("crypto");
  const nowMs = typeof ctx.now === "function" ? ctx.now : () => Date.now();
  const today = () => new Date(nowMs() + 10 * 3600e3).toISOString().slice(0, 10);
  const txt = (v, n) => String(v == null ? "" : v).trim().slice(0, n || 200);

  /* Aman's merges, then anything equal ignoring case and punctuation. */
  const MERGE = { nexusdmc: "Nexus", ramlimo: "Ram Limos", hcsood: "Sood", iway: "i'way" };
  const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const NO_ACCOUNT = /^(direct|private\b|agent - name tbc|tbc)/i;
  const WEBSITE = /^website/i;

  /* Limo Anywhere's vehicle words -> our classes, only where it is the same car. */
  function vehicleClass(v) {
    const t = String(v || "").toLowerCase().trim();
    if (!t) return "";
    const exact = (VEHICLES || []).find((c) => c.toLowerCase() === t);
    if (exact) return exact;
    if (/^(business|first) class sedan$|^luxury sedan$/.test(t)) return "Luxury Sedan";
    if (/v-?class|^luxury minivan$/.test(t)) return "Luxury Minivan";
    if (/^people mover$|^6 seater van$|^private 7 seater$/.test(t)) return "People Mover";
    if (/^standard( sedan)?$/.test(t)) return "Sedan";
    if (/^(mercedes )?sprinter 10[- ]seater$|^sprinter 10 seater$|^11-seat sprinter$/.test(t)) return "Mercedes Sprinter 10-Seater";
    if (/^(mercedes )?sprinter 14[- ]seater$/.test(t)) return "Mercedes Sprinter 14-Seater";
    if (/^(mercedes )?sprinter 18[- ]seater$/.test(t)) return "Mercedes Sprinter 18-Seater";
    if (/^sedan$/.test(t)) return "Sedan";
    if (/^suv$/.test(t)) return "SUV";
    return null;          // a coach, a minibus, "TBC": keep their words, office assigns by hand
  }
  function when(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(String(s || "").trim());
    if (!m || +m[4] > 23 || +m[5] > 59) return null;
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4].padStart(2, "0") + ":" + m[5] };
  }
  const flightIn = (s) => { const m = /\(([A-Z0-9]{2}\s?\d{1,4})\s+(arr|dep|arriving|departing)\b/i.exec(String(s || "")); return m ? m[1].replace(/\s/g, "").toUpperCase() : null; };
  const pick = (r, ...names) => { for (const n of names) { const k = Object.keys(r).find((x) => x.trim().toLowerCase() === n); if (k && String(r[k]).trim()) return String(r[k]).trim(); } return ""; };

  async function plan(rows) {
    const t = today();
    const accounts = (await pool.query(`SELECT id, name FROM ops_accounts`)).rows;
    const accountByKey = new Map(accounts.map((a) => [squash(a.name), a.name]));
    const seenKeys = new Set();
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const w = when(pick(r, "pickup datetime", "pick-up date/time", "pickup date time"));
      const pickup = txt(pick(r, "pickup address", "pick-up address"), 200);
      const dropoff0 = txt(pick(r, "dropoff address", "drop-off address"), 200);
      const service = pick(r, "service type");
      const first = pick(r, "passenger first name"), last = pick(r, "passenger last name");
      const name = txt([first, last].filter(Boolean).join(" "), 120);
      const row = { row: parseInt(r.__row, 10) || i + 2, date: w && w.date, time: w && w.time, name, pickup, service };
      if (!w || !pickup) { out.push(Object.assign(row, { status: "unreadable", why: !w ? "no pick-up date and time it can read" : "no pick-up address" })); continue; }
      if (w.date < t) { out.push(Object.assign(row, { status: "past" })); continue; }
      const dropoff = dropoff0 || (/hour|directed/i.test(service) ? "As directed" : "");
      if (!dropoff) { out.push(Object.assign(row, { status: "unreadable", why: "no drop-off address" })); continue; }
      const key = crypto.createHash("sha1").update([w.date, w.time, name.toLowerCase(), pickup.toLowerCase(), dropoff.toLowerCase()].join("|")).digest("hex").slice(0, 24);
      if (seenKeys.has(key)) { out.push(Object.assign(row, { status: "duplicate", why: "the same trip appears twice in the file" })); continue; }
      seenKeys.add(key);
      const rawAccount = pick(r, "account name", "account");
      const checks = [];
      let account = null;
      if (WEBSITE.test(rawAccount)) {
        const surname = (last || name.split(" ").pop() || "").toLowerCase();
        const web = surname ? (await pool.query(
          `SELECT ref FROM web_bookings WHERE pickup_date = $1 AND lower(passenger_name) LIKE $2 AND status <> 'declined'`,
          [w.date, "%" + surname + "%"])).rows[0] : null;
        if (web) { out.push(Object.assign(row, { status: "website", why: "already on the board as website booking " + web.ref })); continue; }
        checks.push("marked Website in Limo Anywhere but no matching website booking was found");
      } else if (rawAccount && !NO_ACCOUNT.test(rawAccount)) {
        const k = squash(rawAccount);
        account = MERGE[k] || accountByKey.get(k) || rawAccount;
        if (!accountByKey.has(squash(account))) accountByKey.set(squash(account), account);
      }
      const rawVehicle = pick(r, "vehicle type", "vehicle");
      const cls = vehicleClass(rawVehicle);
      /* A coach or minibus is assigned by hand anyway ("Needs a driver" on the
         board), so it is noted, not flagged - Check is kept for what is
         actually missing. */
      if (!rawVehicle) checks.push("no vehicle given");
      const priceTxt = pick(r, "price").replace(/[$,\s]/g, "");
      const price = /^\d+(\.\d{1,2})?$/.test(priceTxt) ? Math.round(+priceTxt * 100) : null;
      if (price == null) checks.push("no price");
      const accountRef = txt(pick(r, "reference number", "reference", "ref"), 60) || null;
      const dupe = (await pool.query(`SELECT ref FROM ops_jobs WHERE import_key = $1`, [key])).rows[0]
        || (accountRef && account ? (await pool.query(
          `SELECT ref FROM ops_jobs WHERE lower(account) = lower($1) AND account_ref = $2 AND pickup_date = $3 AND pickup_time = $4 AND status <> 'cancelled'`,
          [account, accountRef, w.date, w.time])).rows[0] : null);
      if (dupe) { out.push(Object.assign(row, { status: "exists", why: "already on the board as " + dupe.ref })); continue; }
      const luggage = pick(r, "luggage count", "luggage");
      const notes = [pick(r, "notes"), luggage && luggage !== "0" ? `Luggage: ${luggage}.` : "",
        /charter|tour/i.test(service) ? `Service: ${service}.` : "", cls === null && rawVehicle ? `Vehicle booked: ${rawVehicle}.` : ""].filter(Boolean).join(" ");
      out.push(Object.assign(row, {
        status: "import", key, account, accountRef, dropoff, vehicle: cls || txt(rawVehicle, 80),
        flight: flightIn(pickup) || flightIn(dropoff), phone: txt(pick(r, "passenger phone", "phone"), 40),
        email: txt(pick(r, "passenger email", "email"), 200) || null,
        pax: Math.min(Math.max(parseInt(pick(r, "pax count", "pax"), 10) || 1, 1), 60),
        price, notes: txt(notes, 1000) || null, hours: null, checks,
      }));
    }
    const newAccounts = [...new Set(out.filter((x) => x.status === "import" && x.account).map((x) => x.account))]
      .filter((n) => !accounts.some((a) => squash(a.name) === squash(n))).sort();
    const counts = {};
    out.forEach((x) => { counts[x.status] = (counts[x.status] || 0) + 1; });
    return { rows: out, counts, newAccounts };
  }

  app.post("/ops/import/la", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const rows = Array.isArray(b.rows) ? b.rows.slice(0, 3000) : [];
      if (!rows.length) return res.status(400).json({ error: "That file has no rows." });
      const p = await plan(rows);
      const view = (x) => ({ row: x.row, status: x.status, why: x.why || (x.checks && x.checks.length ? "Check: " + x.checks.join("; ") : ""),
        date: x.date, time: x.time, account: x.account || null, name: x.name, from: x.pickup, to: x.dropoff, vehicle: x.vehicle, price: x.price != null ? x.price / 100 : null });
      if (b.dryRun !== false) return res.json({ dryRun: true, counts: p.counts, newAccounts: p.newAccounts, rows: p.rows.map(view) });

      for (const name of p.newAccounts) {
        await pool.query(`INSERT INTO ops_accounts (name, notes, active) VALUES ($1, $2, TRUE)`,
          [name, "Created from the Limo Anywhere sheet on " + today() + " - add the billing email, contact and ABN."]);
      }
      const made = [];
      for (const x of p.rows.filter((y) => y.status === "import")) {
        const note = `Imported from Limo Anywhere (LA Bookings sheet, row ${x.row}) on ${today()}.` + (x.checks.length ? " Check: " + x.checks.join("; ") + "." : "");
        let ref = null;
        for (let i = 0; i < 5 && !ref; i++) {
          const tryRef = makeRef(x.date);
          try {
            await pool.query(
              `INSERT INTO ops_jobs (ref, account, account_ref, pickup, dropoff, vehicle, pickup_date, pickup_time, hire_hours,
                 passenger_name, passenger_phone, passenger_email, flight, notes, pax, price_cents, needs_review, source_note, import_key)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
              [tryRef, x.account, x.accountRef, x.pickup, x.dropoff, x.vehicle || "", x.date, x.time, x.hours,
               x.name, x.phone || "", x.email, x.flight, x.notes, x.pax, x.price || 0, x.checks.length > 0, note, x.key]);
            ref = tryRef;
          } catch (e) { if (!(e && e.code === "23505")) throw e; }
        }
        if (ref) made.push(ref);
      }
      console.log("LA import:", made.length, "jobs,", p.newAccounts.length, "new accounts");
      await pool.query(`INSERT INTO ops_events (kind, message) VALUES ('import', $1)`,
        [`Imported ${made.length} bookings from the Limo Anywhere sheet` + (p.newAccounts.length ? `, and created ${p.newAccounts.length} accounts (${p.newAccounts.join(", ")})` : "") + "."]).catch(() => {});
      res.json({ ok: true, imported: made.length, accountsCreated: p.newAccounts, counts: p.counts,
        checks: p.rows.filter((y) => y.status === "import" && y.checks.length).length });
    } catch (err) {
      console.error("LA import:", err);
      res.status(500).json({ error: "Could not import that file - nothing was changed if this was the first error." });
    }
  });

  /* ops_jobs.import_key is added by ops.js's own schema run. */
  console.log("LA import ready");
  return { on: true, plan, vehicleClass };
};
