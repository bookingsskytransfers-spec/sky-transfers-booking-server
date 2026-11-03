/**
 * Keeps the board's "Check" flag meaning something (Aman, 3 Nov 2026).
 *
 * A calendar job is marked Check with a list of reasons when it lands on
 * the board. Most reasons stop mattering soon after - a driver and car are
 * put on it, the vehicle is read properly - but the flag stayed, so by
 * November 74 jobs carried it, 52 of them already in the past, and the
 * flag no longer told the office anything.
 *
 *  - recheck(refs): drops the reasons that have since been answered and
 *    rewrites the note to the ones still open; a job with none left is no
 *    longer Check. A job whose every leg is done is no longer Check either.
 *    Only calendar reasons are judged here - "Calendar changed", "Removed
 *    from the calendar", email intake and imports are the office's to clear.
 *  - vehicles(): a job whose vehicle isn't one of our classes (blank,
 *    "Sprinter", "Sprinter 16 Seater") gets the class its calendar note or
 *    its pax gives, or - when blank - the class of the car it was sent in.
 *    A coach or a bigger bus stays as written: it isn't one of ours.
 *
 * Both only ever narrow a Check or fill a blank; neither invents a job,
 * changes a price or touches a website or agent booking.
 */
const { parseVehicle } = require("./intake-parse");

module.exports = function boardTidy({ pool, VEHICLES, bneToday }) {
  const CLASSES = VEHICLES || [];
  const inList = (n, from) => Array.from({ length: n }, (_, i) => "$" + (i + (from || 1))).join(", ");
  const NOT_GIVEN = /\b(not (supplied|stated|given|quoted|provided|specified)|tbc|tba|to be (confirmed|advised)|unknown)\b/i;
  const CAL = /^From the Google Calendar: /;

  /* 'From the Google Calendar: "T". Check: a; b. To add: c.\n\n<notes>' */
  function splitNote(note) {
    const n = String(note || "");
    const head = n.split("\n\n")[0], rest = n.slice(head.length);
    const ci = head.indexOf(" Check: ");
    if (!CAL.test(head) || ci === -1) return null;
    const ti = head.indexOf(" To add: ", ci);
    const list = head.slice(ci + 8, ti === -1 ? head.length : ti).replace(/\.$/, "");
    const reasons = [];
    /* "needs 2 vehicles - ...; add the others by hand" is one reason */
    for (const r of list.split("; ")) if (/^add the others/.test(r) && reasons.length) reasons[reasons.length - 1] += "; " + r; else reasons.push(r);
    return { title: head.slice(0, ci), reasons, toAdd: ti === -1 ? "" : head.slice(ti), rest };
  }

  async function legsOf(ref) {
    return (await pool.query(`SELECT leg, driver_id, vehicle_id, status FROM ops_dispatch WHERE ref = $1`, [ref])).rows;
  }

  async function recheck(refs) {
    if (Array.isArray(refs) && !refs.length) return { cleared: 0, narrowed: 0 };
    const rows = (await pool.query(
      `SELECT ref, account, vehicle, passenger_name, passenger_phone, source_note, return_date, return_time FROM ops_jobs
        WHERE needs_review AND status <> 'cancelled'` + (Array.isArray(refs) ? ` AND ref IN (${inList(refs.length)})` : ""),
      Array.isArray(refs) ? refs : [])).rows;
    let cleared = 0, narrowed = 0;
    for (const j of rows) {
      const want = j.return_date && j.return_time ? ["out", "ret"] : ["out"];
      const d = new Map((await legsOf(j.ref)).map((x) => [x.leg, x]));
      const every = (f) => want.every((l) => d.has(l) && f(d.get(l)));
      if (every((x) => x.status === "done")) {
        await pool.query(`UPDATE ops_jobs SET needs_review = FALSE WHERE ref = $1`, [j.ref]);
        cleared++; continue;
      }
      const p = splitNote(j.source_note);
      if (!p) continue;
      const driver = every((x) => !!x.driver_id), car = every((x) => !!x.vehicle_id);
      const ours = CLASSES.indexOf(j.vehicle) !== -1;
      const done = (r) =>
        /^no price\b/.test(r) ||                                       /* a reminder since 29 Oct, never a Check */
        (/^number of passengers not given/.test(r) && !!j.vehicle) ||
        (/^(no vehicle given|vehicle unclear)/.test(r) && (ours || car)) ||
        (/^vehicle ".*" isn't one of our classes/.test(r) && (ours || driver)) ||
        (/^no passenger name/.test(r) && !!(j.passenger_name || j.account)) ||
        (/^no passenger phone/.test(r) && !!(j.passenger_phone || j.account)) ||
        (/^by the hour:/.test(r) && driver);
      const keep = p.reasons.filter((r) => !done(r));
      if (keep.length === p.reasons.length) continue;
      const note = p.title + (keep.length ? " Check: " + keep.join("; ") + "." : "") + p.toAdd + p.rest;
      await pool.query(`UPDATE ops_jobs SET needs_review = $2, source_note = $3 WHERE ref = $1`, [j.ref, keep.length > 0, note.slice(0, 4000)]);
      if (keep.length) narrowed++; else cleared++;
    }
    if (cleared || narrowed) console.log(`board tidy: Check cleared on ${cleared} job(s), narrowed on ${narrowed}`);
    return { cleared, narrowed };
  }

  /* The class a job's own words give it, or "" */
  function classFrom(j) {
    const pax = j.pax > 0 ? j.pax : null;
    let cls = parseVehicle(j.vehicle, CLASSES, pax);
    const note = String(j.source_note || "");
    if (!cls && CAL.test(note)) {
      const desc = note.split("\n\n").slice(1).join("\n\n");
      const line = desc.split(/\r?\n/).map((x) => /^\s*[*\-•>]?\s*vehicle(?: type)?\s*[:–]\s*(.+?)\s*$/i.exec(x)).find(Boolean);
      const title = (/^From the Google Calendar: "(.*)"\./.exec(note.split("\n\n")[0]) || [])[1] || "";
      if (line && !NOT_GIVEN.test(line[1])) cls = parseVehicle(line[1], CLASSES, pax);
      if (!cls) cls = parseVehicle(title, CLASSES, pax);
    }
    return cls;
  }

  async function vehicles(refs) {
    if (Array.isArray(refs) && !refs.length) return { vehicles: 0 };
    const since = bneToday ? bneToday(-62) : "1970-01-01";
    const rows = (await pool.query(
      `SELECT ref, vehicle, pax, source_note FROM ops_jobs WHERE status <> 'cancelled' AND pickup_date >= $1` +
        (Array.isArray(refs) ? ` AND ref IN (${inList(refs.length, 2)})` : ""),
      [since].concat(Array.isArray(refs) ? refs : []))).rows
      .filter((j) => CLASSES.indexOf(j.vehicle || "") === -1);
    let n = 0;
    for (const j of rows) {
      let cls = classFrom(j);
      const fromText = !!cls;
      if (!cls && !j.vehicle) {
        /* blank: what it was actually sent in, when every leg agrees */
        const sent = (await pool.query(
          `SELECT v.class FROM ops_dispatch d JOIN ops_vehicles v ON v.id = d.vehicle_id WHERE d.ref = $1`, [j.ref])).rows.map((r) => r.class);
        const one = [...new Set(sent)];
        if (one.length === 1 && CLASSES.indexOf(one[0]) !== -1) cls = one[0];
      }
      if (!cls) continue;
      const r = await pool.query(`UPDATE ops_jobs SET vehicle = $2 WHERE ref = $1 AND vehicle = $3`, [j.ref, cls, j.vehicle || ""]);
      if (!r.rowCount) continue;
      n++;
      /* Read from the event's own words, the calendar reader now reads the
         same - so a later edit of the event mustn't report the tidy as a
         change. A class taken from the car is the board's, not the event's. */
      if (!fromText) continue;
      const cal = (await pool.query(`SELECT uid, fields FROM ops_cal WHERE ref = $1`, [j.ref]).catch(() => ({ rows: [] }))).rows;
      for (const c of cal) {
        let f; try { f = JSON.parse(c.fields || "null"); } catch (e) { f = null; }
        if (f && (f.vehicle || "") === (j.vehicle || "")) { f.vehicle = cls; await pool.query(`UPDATE ops_cal SET fields = $2 WHERE uid = $1`, [c.uid, JSON.stringify(f)]); }
      }
    }
    if (n) console.log(`board tidy: vehicle type filled in on ${n} job(s)`);
    return { vehicles: n };
  }

  return { recheck, vehicles, splitNote, classFrom };
};
