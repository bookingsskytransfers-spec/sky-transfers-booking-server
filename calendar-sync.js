/**
 * The Google Calendar -> the dispatch board (Aman, 20 Oct 2026).
 *
 * The calendar on bookings.skytransfers@gmail.com is the diary every job
 * already goes into - by hand, and by the twice-daily bookings sweep. This
 * reads it through its private iCal address (Render env GCAL_ICS_URL, which
 * Aman pastes in; it is never shown or logged) on every Autopilot pass, and
 * keeps the board in step. It only ever reads: nothing is written back.
 *
 *  - A new event becomes an account job. It is marked Check only when
 *    something is unclear (no price, no phone, two vehicles, time TBC...);
 *    a clean event goes straight on the board.
 *  - An event for a booking already in the system is linked, not copied: an
 *    ST- reference of a website or agent booking, or a job on the same day
 *    and time for the same passenger (a Limo Anywhere import, a return leg).
 *  - A change to an event never changes the job (Aman's choice). The job is
 *    marked "Calendar changed" with what changed, and the office applies it
 *    or keeps the job as it is.
 *  - A deleted or cancelled event marks its job "Removed from the calendar".
 *    Cancelling it is the office's call.
 *
 * Only the calendar's own fields are read - the time, the location's
 * "A -> B", and labelled lines in the description ("Pax: 3"). Nothing is
 * guessed: what is not there is listed on the job for the office.
 */
const crypto = require("crypto");
const { parseVehicle, KEYS } = require("./intake-parse");

module.exports = function calendarSync(ctx) {
  const { app, pool, requireAdmin, makeRef, VEHICLES, logEvent, alert, nowMs, BOARD } = ctx;
  const fetchIcs = typeof ctx.fetchIcs === "function" ? ctx.fetchIcs : async () => {
    const r = await fetch(process.env.GCAL_ICS_URL, { headers: { "user-agent": "SkyTransfers-dispatch/1" } });
    if (!r.ok) throw new Error("the calendar address answered " + r.status);
    return r.text();
  };
  const url = () => (typeof ctx.fetchIcs === "function" ? "test" : String(process.env.GCAL_ICS_URL || "").trim());
  function ready() {
    const u = url();
    if (!u) return { ok: false, why: "the calendar's private address (GCAL_ICS_URL) is not on the server yet" };
    if (u !== "test" && !/^https:\/\/calendar\.google\.com\/calendar\/ical\/.+\.ics$/.test(u)) return { ok: false, why: "GCAL_ICS_URL doesn't look like a Google Calendar iCal address" };
    return { ok: true };
  }

  async function initSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ops_cal (
        uid          TEXT PRIMARY KEY,
        ref          TEXT,
        leg          TEXT NOT NULL DEFAULT 'out',
        status       TEXT NOT NULL,
        raw_fp       TEXT,
        fields       TEXT,
        pending      TEXT,
        pending_fp   TEXT,
        note         TEXT,
        removed_at   TIMESTAMPTZ,
        first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen    TIMESTAMPTZ
      );
    `);
  }

  /* ---- reading iCal ------------------------------------------------------- */
  const unesc = (s) => String(s || "").replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
  const ent = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  const stripTags = (s) => ent(String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, ""));
  /* Wall-clock time in Brisbane (UTC+10, no daylight saving). */
  function tzOffsetMin(tz, utcMs) {
    if (!tz || /Brisbane/i.test(tz)) return 600;
    try {
      const p = new Intl.DateTimeFormat("en-AU", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        .formatToParts(new Date(utcMs)).reduce((a, x) => (a[x.type] = x.value, a), {});
      return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - utcMs) / 60000);
    } catch (e) { return 600; }
  }
  function when(prop) {
    if (!prop) return null;
    const v = prop.value, tz = prop.params.TZID;
    let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (m || prop.params.VALUE === "DATE") { m = m || /^(\d{4})(\d{2})(\d{2})/.exec(v); return m ? { allDay: true, date: `${m[1]}-${m[2]}-${m[3]}`, ms: Date.UTC(+m[1], +m[2] - 1, +m[3]) - 600 * 60000 } : null; }
    m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/.exec(v);
    if (!m) return null;
    const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const utc = m[7] === "Z" ? asUtc : asUtc - tzOffsetMin(tz, asUtc) * 60000;
    const b = new Date(utc + 600 * 60000).toISOString();
    return { allDay: false, date: b.slice(0, 10), time: b.slice(11, 16), ms: utc };
  }
  function parseIcs(text) {
    const lines = String(text || "").replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
    const out = []; let ev = null;
    for (const line of lines) {
      if (line === "BEGIN:VEVENT") { ev = {}; continue; }
      if (line === "END:VEVENT") { if (ev) out.push(ev); ev = null; continue; }
      if (!ev) continue;
      const i = line.indexOf(":"); if (i < 1) continue;
      const head = line.slice(0, i).split(";"), name = head[0].toUpperCase(), params = {};
      for (const p of head.slice(1)) { const j = p.indexOf("="); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, ""); }
      if (!(name in ev)) ev[name] = { value: line.slice(i + 1), params };
    }
    return out.map((e) => ({
      uid: e.UID && e.UID.value,
      recurrenceId: e["RECURRENCE-ID"] ? e["RECURRENCE-ID"].value : null,
      rrule: !!e.RRULE,
      status: e.STATUS ? e.STATUS.value.toUpperCase() : "CONFIRMED",
      start: when(e.DTSTART), end: when(e.DTEND),
      summary: ent(unesc(e.SUMMARY && e.SUMMARY.value)).trim(),
      location: ent(unesc(e.LOCATION && e.LOCATION.value)).trim(),
      description: stripTags(unesc(e.DESCRIPTION && e.DESCRIPTION.value)).trim(),
    })).filter((e) => e.uid && e.start);
  }

  /* ---- an event as a job ---------------------------------------------------- */
  const sha = (s) => crypto.createHash("sha1").update(s).digest("hex");
  const squash = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
  const NOT_GIVEN = /\b(not (supplied|stated|given|quoted|provided|specified)|tbc|tba|to be (confirmed|advised)|unknown)\b/i;
  const ARROW = /\s*(?:→|->|=>|➔)\s*/;
  const PHONE = /(\+?\d[\d ()-]{7,}\d)/;
  function labels(text) {
    const got = {};
    for (const line of String(text || "").split(/\r?\n/)) {
      const m = /^\s*[*\-•>]?\s*([A-Za-z][A-Za-z .\/#'&-]{0,30}?)\s*[:–]\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      /* "Pick-up" and "Drop-off" are the same labels as "Pick up" */
      const k = m[1].toLowerCase().replace(/(\w)-(\w)/g, "$1 $2").replace(/\s+/g, " ").trim();
      let key = null;
      if (/^(passenger|guest|lead) (number|phone|mobile|contact)$/.test(k)) key = "phone";
      if (!key) for (const [kk, re] of KEYS) if (re.test(k)) { key = kk; break; }
      if (!key && /^(booking id|tour ref(erence)?|res ?#|booking reference)$/.test(k)) key = "accref";
      if (!key && /^(client contact|contact person|customer|customer \/ contact|lead pax)$/.test(k)) key = "name";
      if (!key && /^(e-?mail|passenger email|guest email)$/.test(k)) key = "email";
      if (!key) continue;
      (got[key] = got[key] || []).push(m[2]);
    }
    return got;
  }
  const first = (arr, ok) => (arr || []).find((v) => v && !NOT_GIVEN.test(v) && (!ok || ok(v))) || "";
  const cleanName = (s) => String(s || "").replace(/\(.*?\)/g, "").split(/\s+[—–-]\s+|,|;/)[0].replace(PHONE, "").trim().slice(0, 120);

  function mapEvent(ev, known) {
    const d = ev.description, L = labels(d), checks = [];
    /* "07:15 KIFF & Culture - ...", "06:00-14:30 BusCharter ...": the time
       at the front is the office's note, not part of the name */
    const tm = /^\s*(\d{1,2})[:.](\d{2})(?:\s*[-–]\s*\d{1,2}[:.]\d{2})?\s+/.exec(ev.summary);
    const s = tm ? ev.summary.slice(tm[0].length) : ev.summary;
    const segs = s.split(/\s+[-–—]\s+/).map((x) => x.trim()).filter(Boolean);
    const warn = segs.filter((x) => /^⚠|^(time tbc|tbc)$|\bvehicles?\b/i.test(x));
    const body = segs.filter((x) => warn.indexOf(x) === -1);
    const j = { date: ev.start.date, time: ev.start.time };
    if (tm) {
      const tt = tm[1].padStart(2, "0") + ":" + tm[2];
      if (tt !== j.time) checks.push(`the title says ${tt} but the event starts at ${j.time} - check which is right`);
    }

    /* where: the location's "A -> B" first, then labelled lines */
    const loc = ev.location.split(ARROW);
    const noTime = (x) => String(x || "").replace(/^\d{1,2}:\d{2}\s*(am|pm)?\s*(from\s+)?/i, "").replace(/\s*[-–]\s*\d{1,2}[:.]\d{2}\s*(am|pm)?\s*$/i, "").trim().slice(0, 200);
    j.pickup = noTime(loc.length >= 2 ? loc[0] : first(L.pickup) || (loc.length === 1 ? loc[0] : ""));
    j.dropoff = noTime(loc.length >= 2 ? loc.slice(1).join(" -> ") : first(L.dropoff));

    /* who books it: a labelled supplier, or the first part of a title that
       has the supplier, the passenger and the trip ("Yarra Tours - Ms X
       (3 Pax) - A -> B"). A two-part title ("Colleen Nieves - A -> B") is a
       passenger booking direct, unless the name is a known account. */
    const isAcct = (k, n) => { const q = squash(n); return q && (q === k || (q.length >= 4 && k.indexOf(q) !== -1) || (k.length >= 4 && q.indexOf(k) !== -1)); };
    const knownHit = (x) => { const k = squash(x); return k ? known.find((n) => isAcct(k, n)) : null; };
    const person = (x) => /^(mr|mrs|ms|miss|dr|mx)\b\.?/i.test(x) || /\bpax\b|\d{3,}/i.test(x) || ARROW.test(x);
    const head = (body[0] || "").replace(/\s+(res#?|ref\.?|booking)\s*[#:]?\s*\S+.*$/i, "").replace(/\s*[\/|].*$/, "").trim();
    let acct = cleanName(first(L.account));
    if (!acct && head && !/^(web|website|private|direct)\b/i.test(head) && !parseVehicle(head, VEHICLES) && !person(head)) {
      if (body.length >= 3 || knownHit(head)) acct = cleanName(head);
    }
    /* A name not yet on the Invoices tab is kept as written; the invoice
       screen already lists such names as "Not set up". */
    j.account = acct ? (knownHit(acct) || acct) : null;
    j.web = /^(web|website)\b/i.test(segs[0] || "");
    const refSeg = body.find((x) => /^(res#?\s*\S+|#?\d{5,}|[A-Z]{2,}[A-Z0-9]*\d{4,}[A-Z0-9]*)$/i.test(x));
    /* "TOUR REFERENCE: AKWT181026 GROUP NAME" - the reference is the code */
    const refLab = first(L.accref), refTok = refLab.trim().split(/\s+/)[0] || "";
    j.accountRef = ((/\d/.test(refTok) ? refTok : refLab) || refSeg || "").replace(/^res#?\s*|^#/i, "").trim().slice(0, 60) || null;

    /* the passenger */
    const PAXRE = /\(?\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*pax\b[^)]*\)?/i;
    const paxSeg = body.find((x) => PAXRE.test(x) && !ARROW.test(x) && !/^(web|private)\b/i.test(x));
    const nameLab = first(L.name, (v) => !/^\d+\s*(adults?|pax)/i.test(v));
    j.name = cleanName(nameLab) || (paxSeg ? cleanName(paxSeg.replace(PAXRE, "")) : "");
    j.name = j.name.split(/\.\s/)[0].replace(/\.$/, "").trim();
    if (j.account && squash(j.name) === squash(j.account)) j.name = "";
    const phoneSrc = [first(L.phone)].concat(L.name || []).find((v) => v && PHONE.test(v)) || "";
    j.phone = phoneSrc ? (PHONE.exec(phoneSrc) || [""])[0].trim().slice(0, 40) : "";
    const em = first(L.email); const emm = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i.exec(em || (/\(email:\s*([^)\s]+)\)/i.exec(d) || [])[1] || "");
    j.email = emm ? emm[0].toLowerCase() : null;
    /* "(3 Pax)", "(10-11 pax, ...)" - the larger number of a range */
    const paxM = /\b(\d+)(?:\s*[-–]\s*(\d+))?\s*pax\b/i.exec(s) || /(\d+)/.exec(first(L.pax, (v) => /\d/.test(v)) || "");
    j.pax = paxM ? Math.min(Math.max(+(paxM[2] || paxM[1]), 1), 60) : 1;
    if (!paxM) checks.push("number of passengers not given");

    /* the vehicle */
    const vLab = first(L.vehicle);
    const vParen = (/\(([^()]*)\)\s*$/.exec(s) || [])[1] || "";
    /* A vehicle line that isn't one of our classes is kept as written only
       when it names a vehicle ("21 Seat Mini Bus"); "Airport transfer", "P2P"
       or a sentence about which coach is free is not a vehicle. */
    const vRaw = (vLab || "").replace(/\(.*?\)/g, "").trim();
    const vWords = /seat|coach|bus|van|sprinter|limo|sedan|suv|v-?class|wagon|minivan|car\b/i.test(vRaw) && vRaw.length <= 40;
    /* BusCharter always books the 21-seat minibus (Aman, 21 Oct 2026). */
    const busCharter = /bus\s*charter/i.test((j.account || "") + " " + s + " " + first(L.account));
    j.vehicle = busCharter ? "21 Seat Mini Bus"
      : parseVehicle(vLab, VEHICLES) || parseVehicle(vParen, VEHICLES) || parseVehicle(body.join(" "), VEHICLES) || (vWords ? vRaw.slice(0, 80) : "");
    if (busCharter) { /* known, assigned by hand as always */ }
    else if (!j.vehicle) checks.push(vRaw ? "vehicle unclear - see the calendar notes" : "no vehicle given");
    else if (VEHICLES.indexOf(j.vehicle) === -1) checks.push(`vehicle "${j.vehicle}" isn't one of our classes - assign it by hand`);
    const many = /\b(\d+)\s*x\s+[a-z]/i.exec(vLab + " " + s) || /\b(\d+)\s+vehicles\b/i.exec(s + " " + d);
    if (many && +many[1] > 1) checks.push(`needs ${many[1]} vehicles - the board holds it as one job; add the others by hand`);

    /* money, flight, extras */
    const priceTxt = first(L.price, (v) => /\d/.test(v)) || (/\(\s*\$\s?([\d,]+(?:\.\d{1,2})?)\s*\)/.exec(s) || [])[1] || "";
    const pm = /([\d,]+(?:\.\d{1,2})?)/.exec(String(priceTxt).replace(/^[^\d]*/, ""));
    j.priceCents = pm ? Math.round(+pm[1].replace(/,/g, "") * 100) : null;
    /* "$895.50 per run", even inside "($895.50 per run)" after a total, is
       the price of this one */
    const per = /\$\s?([\d,]+(?:\.\d{1,2})?)\s*(?:aud\s*)?(?:per|a|each)\s+(run|trip|day|leg|transfer|way|movement)\b/i.exec(String(priceTxt));
    const MANY = /\b(runs|trips|legs|days|nights|transfers|movements|assignment)\b/i;
    if (j.priceCents == null) checks.push("no price");
    else if (per) {
      const one = Math.round(+per[1].replace(/,/g, "") * 100);
      if (one !== j.priceCents) checks.push(`the calendar gives a total and $${(one / 100).toFixed(2)} per ${per[2].toLowerCase()} - the per-${per[2].toLowerCase()} price is used`);
      j.priceCents = one;
    } else if (/\btotal\b/i.test(String(priceTxt).split("(")[0]) && MANY.test(String(priceTxt))) {
      checks.push("the price may be a total for several trips - check it's this one's");
    }
    const fl = first(L.flight) || (/\(([A-Z0-9]{2})-?\s?(\d{1,4})\b[^)]*\)/.exec(s) || []).slice(1, 3).join("");
    j.flight = (/\b([A-Z0-9]{2})-?\s?(\d{1,4})\b/.exec(String(fl).toUpperCase()) || []).slice(1, 3).join("") || null;
    const seatM = /(\d+)\s*x?\s*(baby|child|booster|infant)\s*seats?/i.exec(d) || /(baby|child|booster)\s*seats?\s*:?\s*(\d+)/i.exec(d);
    j.childSeats = seatM ? Math.min(+(seatM[1].match(/\d/) ? seatM[1] : seatM[2]) || 0, 6) : 0;
    j.trailer = /\btrailer( is)? required\b|\btrailer:\s*(yes|required)/i.test(d);
    const mins = ev.end && !ev.end.allDay ? Math.round((ev.end.ms - ev.start.ms) / 60000) : 0;
    j.hours = mins >= 180 && /\b(hours?|shuttle|charter|as directed|hire)\b/i.test(s + " " + d) ? Math.min(Math.ceil(mins / 60), 24) : null;
    /* The hours are still set; BusCharter's shuttles are always by the
       hour, so for them it is not worth a Check (Aman, 21 Oct 2026). */
    if (j.hours && !/bus\s*charter/i.test((j.account || "") + " " + s)) checks.push(`by the hour: ${j.hours} h, from the calendar's ${Math.round(mins / 6) / 10} h`);

    if (/\b(time )?tbc\b|\bto be confirmed\b/i.test(s)) checks.push("the calendar says something is still TBC");
    if (!j.name) checks.push("no passenger name");
    /* Agencies often don't pass on the guest's mobile, and the agency itself
       is the contact (Aman, 21 Oct 2026) - so only a direct booking with no
       phone is worth a Check. */
    if (!j.phone && !j.account) checks.push("no passenger phone");
    const st = /\bST-\d{6}-[A-Z0-9]{4}\b/.exec(s + " " + d + " " + ev.location);
    j.stRef = st ? st[0] : null;
    return { job: j, checks };
  }
  /* The fields the office sees change on, in a fixed order. */
  const FIELDS = [["date", "date"], ["time", "time"], ["pickup", "pick-up"], ["dropoff", "drop-off"], ["vehicle", "vehicle"], ["pax", "pax"],
    ["name", "passenger"], ["phone", "phone"], ["flight", "flight"], ["priceCents", "price"], ["account", "account"], ["accountRef", "their ref"], ["hours", "hours"]];
  const pickFields = (j) => FIELDS.reduce((a, [k]) => (a[k] = j[k] == null ? null : j[k], a), {});
  const show = (k, v) => (v == null || v === "" ? "(blank)" : k === "priceCents" ? "$" + (v / 100).toFixed(2) : String(v));
  function diff(a, b) {
    return FIELDS.filter(([k]) => String(a[k] == null ? "" : a[k]) !== String(b[k] == null ? "" : b[k]))
      .map(([k, label]) => `${label} ${show(k, a[k])} -> ${show(k, b[k])}`);
  }

  /* ---- matching what is already in the system --------------------------------- */
  const surnameOf = (n) => String(n || "").replace(/\b(mr|mrs|ms|miss|dr)\.?\s+/gi, "").trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z'-]/g, "");
  async function existing(j) {
    if (j.stRef) {
      for (const t of ["web_bookings", "agent_bookings", "ops_jobs"]) {
        const r = await pool.query(`SELECT ref FROM ${t} WHERE ref = $1`, [j.stRef]).catch(() => ({ rows: [] }));
        if (r.rows[0]) return { ref: j.stRef, table: t, leg: "out" };
      }
    }
    const sur = surnameOf(j.name);
    const like = sur && sur.length >= 3 ? "%" + sur + "%" : null;
    const taken = async (ref, leg) => (await pool.query(`SELECT 1 FROM ops_cal WHERE ref = $1 AND leg = $2 AND removed_at IS NULL`, [ref, leg])).rows.length > 0;
    const tries = [
      ["ops_jobs", "out", `pickup_date = $1 AND pickup_time = $2`], ["ops_jobs", "ret", `return_date = $1 AND return_time = $2`],
      ["web_bookings", "out", `pickup_date = $1 AND pickup_time = $2`], ["web_bookings", "ret", `return_date = $1 AND return_time = $2`],
      ["agent_bookings", "out", `pickup_date = $1 AND pickup_time = $2`], ["agent_bookings", "ret", `return_date = $1 AND return_time = $2`],
    ];
    for (const [t, leg, where] of tries) {
      const live = t === "web_bookings" ? `status NOT IN ('declined','cancelled')` : `status <> 'cancelled'`;
      const byName = like ? (await pool.query(`SELECT ref FROM ${t} WHERE ${where} AND ${live} AND lower(passenger_name) LIKE $3`, [j.date, j.time, like]).catch(() => ({ rows: [] }))).rows : [];
      const byRef = t === "ops_jobs" && j.accountRef ? (await pool.query(`SELECT ref FROM ops_jobs WHERE ${where} AND ${live} AND account_ref = $3`, [j.date, j.time, j.accountRef]).catch(() => ({ rows: [] }))).rows : [];
      for (const r of byName.concat(byRef)) if (!(await taken(r.ref, leg))) return { ref: r.ref, table: t, leg };
    }
    return null;
  }

  /* ---- one pass ------------------------------------------------------------------- */
  const bneToday = () => new Date(nowMs() + 600 * 60000).toISOString().slice(0, 10);
  const plusDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
  async function knownAccounts() {
    const a = (await pool.query(`SELECT name FROM ops_accounts WHERE active`).catch(() => ({ rows: [] }))).rows.map((r) => r.name);
    const g = (await pool.query(`SELECT name FROM agents`).catch(() => ({ rows: [] }))).rows.map((r) => r.name);
    return a.concat(g).filter(Boolean);
  }
  async function flagJob(ref, note) {
    await pool.query(`UPDATE ops_jobs SET needs_review = TRUE, source_note = $2, updated_at = now() WHERE ref = $1`, [ref, String(note).slice(0, 2000)]);
  }
  async function wasSent(ref, leg) {
    const r = (await pool.query(`SELECT d.sent_at, d.status, v.name FROM ops_dispatch d LEFT JOIN ops_drivers v ON v.id = d.driver_id WHERE d.ref = $1 AND d.leg = $2`, [ref, leg]).catch(() => ({ rows: [] }))).rows[0];
    return r && (r.sent_at || ["accepted", "on_way", "on_location", "pob"].indexOf(r.status) !== -1) ? (r.name || "the driver") : null;
  }

  async function pass(s, opts) {
    const r0 = ready();
    if (!r0.ok) return { skipped: r0.why };
    const today = bneToday(), until = plusDays(today, 180);
    const all = parseIcs(await fetchIcs());
    const known = await knownAccounts();
    const out = { created: [], linked: [], changed: [], removed: [], skipped: [] };
    const seen = new Set();
    for (const ev of all) {
      seen.add(ev.uid);
      if (ev.start.date < today || ev.start.date > until) continue;
      const rawFp = sha([ev.start.date, ev.start.time || "", ev.end ? ev.end.ms : "", ev.summary, ev.location, ev.description, ev.status].join("\n"));
      const row = (await pool.query(`SELECT * FROM ops_cal WHERE uid = $1`, [ev.uid])).rows[0];
      const title = ev.summary.slice(0, 90) || "(no title)";

      if (!row) {
        /* not a job we can put on the board: say so once */
        const skip = async (why) => {
          await pool.query(`INSERT INTO ops_cal (uid, status, raw_fp, note, last_seen) VALUES ($1, 'skipped', $2, $3, now())`, [ev.uid, rawFp, why]);
          out.skipped.push({ title, date: ev.start.date, why });
        };
        if (ev.status === "CANCELLED") { await pool.query(`INSERT INTO ops_cal (uid, status, raw_fp, note, last_seen) VALUES ($1, 'skipped', $2, 'cancelled', now())`, [ev.uid, rawFp]); continue; }
        if (ev.rrule || ev.recurrenceId) { await skip("a repeating event - enter repeating work by hand"); continue; }
        if (ev.start.allDay) { await skip("an all-day event with no pick-up time"); continue; }
        const m = mapEvent(ev, known);
        const j = m.job;
        if (!j.pickup || !j.dropoff) {
          /* no "A -> B" and no pick-up/drop-off lines: a meeting, a reminder */
          await pool.query(`INSERT INTO ops_cal (uid, status, raw_fp, note, last_seen) VALUES ($1, 'ignored', $2, 'no pick-up and drop-off', now())`, [ev.uid, rawFp]);
          continue;
        }
        const fields = JSON.stringify(pickFields(j));
        const hit = await existing(j);
        if (hit) {
          await pool.query(`INSERT INTO ops_cal (uid, ref, leg, status, raw_fp, fields, note, last_seen) VALUES ($1,$2,$3,'linked',$4,$5,$6,now())`,
            [ev.uid, hit.ref, hit.leg, rawFp, fields, hit.table]);
          out.linked.push({ ref: hit.ref, title });
          continue;
        }
        if (j.stRef) m.checks.unshift(`the event names ${j.stRef}, which isn't in the system`);
        if (j.web) m.checks.unshift("marked WEB in the calendar but no matching website booking was found");
        const note = `From the Google Calendar: "${title}".` + (m.checks.length ? " Check: " + m.checks.join("; ") + "." : "") +
          (ev.description ? "\n\n" + ev.description.slice(0, 1500) : "");
        let ref = null;
        for (let i = 0; i < 5 && !ref; i++) {
          const tryRef = makeRef(j.date);
          try {
            await pool.query(
              `INSERT INTO ops_jobs (ref, account, account_ref, pickup, dropoff, vehicle, pickup_date, pickup_time, hire_hours,
                 passenger_name, passenger_phone, passenger_email, flight, pax, child_seats, trailer, price_cents, needs_review, source_note)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
              [tryRef, j.account, j.accountRef, j.pickup, j.dropoff, j.vehicle || "", j.date, j.time, j.hours,
               j.name || "", j.phone || "", j.email, j.flight, j.pax, j.childSeats, j.trailer, j.priceCents || 0, m.checks.length > 0, note]);
            ref = tryRef;
          } catch (e) { if (!(e && e.code === "23505")) throw e; }
        }
        if (!ref) { await skip("could not make a reference"); continue; }
        await pool.query(`INSERT INTO ops_cal (uid, ref, leg, status, raw_fp, fields, last_seen) VALUES ($1,$2,'out','created',$3,$4,now())`, [ev.uid, ref, rawFp, fields]);
        out.created.push({ ref, title, date: j.date, time: j.time, checks: m.checks });
        await logEvent("calendar", `"${title}" -> ${ref} on ${j.date} ${j.time}` + (m.checks.length ? ` (check: ${m.checks.join("; ")})` : ""), ref, "out");
        continue;
      }

      await pool.query(`UPDATE ops_cal SET last_seen = now() WHERE uid = $1`, [ev.uid]);
      if (row.status !== "created" && row.status !== "linked") {
        if (row.raw_fp !== rawFp && row.status !== "ignored") {
          /* a skipped event that has since been given a time is looked at again */
          await pool.query(`DELETE FROM ops_cal WHERE uid = $1`, [ev.uid]);
        }
        continue;
      }
      if (row.removed_at) {
        await pool.query(`UPDATE ops_cal SET removed_at = NULL WHERE uid = $1`, [ev.uid]);
        if (row.ref) await logEvent("calendar", `"${title}" is back in the calendar (${row.ref}).`, row.ref, row.leg);
      }
      if (row.raw_fp === rawFp) continue;
      if (ev.status === "CANCELLED") { await removed(row, title, "cancelled in the calendar", out); await pool.query(`UPDATE ops_cal SET raw_fp = $2 WHERE uid = $1`, [ev.uid, rawFp]); continue; }
      const now = pickFields(mapEvent(ev, known).job);
      let was = {}; try { was = JSON.parse(row.fields || "{}"); } catch (e) { was = {}; }
      const fp = sha(JSON.stringify(now));
      const changes = diff(was, now);
      if (!changes.length || fp === row.pending_fp) { await pool.query(`UPDATE ops_cal SET raw_fp = $2 WHERE uid = $1`, [ev.uid, rawFp]); continue; }
      const isJob = (await pool.query(`SELECT 1 FROM ops_jobs WHERE ref = $1`, [row.ref])).rows.length > 0;
      const sent = await wasSent(row.ref, row.leg);
      const note = `Calendar changed: ${changes.join("; ")}.` + (sent ? ` It had already been sent to ${sent} - tell them if you apply it.` : "") +
        (isJob ? " Apply the change, or keep the job as it is." : " This booking was made on the website or the agent portal - change it there if it's right.");
      await pool.query(`UPDATE ops_cal SET raw_fp = $2, pending = $3, pending_fp = $4 WHERE uid = $1`, [ev.uid, rawFp, JSON.stringify(now), fp]);
      if (isJob) await flagJob(row.ref, note);
      out.changed.push({ ref: row.ref, leg: row.leg, title, changes, sent, isJob });
      await logEvent("calendar", `"${title}" changed in the calendar (${row.ref}): ${changes.join("; ")}`, row.ref, row.leg);
    }

    /* Gone from the calendar. Only when the read clearly worked, and never a
       mass flag: a calendar that suddenly lost a third of its jobs is a
       broken read, not a wave of cancellations. */
    const live = (await pool.query(
      `SELECT c.* FROM ops_cal c WHERE c.status IN ('created','linked') AND c.removed_at IS NULL`)).rows;
    const gone = [];
    for (const r of live) {
      if (seen.has(r.uid)) continue;
      let f = {}; try { f = JSON.parse(r.fields || "{}"); } catch (e) { f = {}; }
      if (f.date && f.date >= today) gone.push(r);
    }
    if (all.length && (gone.length <= 3 || gone.length <= live.length * 0.3)) {
      for (const r of gone) { await pool.query(`UPDATE ops_cal SET removed_at = now() WHERE uid = $1`, [r.uid]); await removed(r, null, "deleted from the calendar", out); }
    } else if (gone.length) {
      await logEvent("error", `The calendar read is missing ${gone.length} upcoming jobs at once - nothing was flagged. If they really were deleted, look at them on the board.`);
    }

    if (mailer() && (out.created.length || out.changed.length || out.removed.length || out.skipped.length)) {
      const L = [];
      const flagged = out.created.filter((x) => x.checks.length), clean = out.created.filter((x) => !x.checks.length);
      if (clean.length) { L.push(`ON THE BOARD (${clean.length}):`); clean.forEach((x) => L.push(`  ${x.ref}  ${x.date} ${x.time}  ${x.title}`)); L.push(""); }
      if (flagged.length) { L.push(`ON THE BOARD, PLEASE CHECK (${flagged.length}):`); flagged.forEach((x) => L.push(`  ${x.ref}  ${x.date} ${x.time}  ${x.title}`, `      CHECK: ${x.checks.join("; ")}`)); L.push(""); }
      if (out.changed.length) {
        L.push(`CHANGED IN THE CALENDAR - NOT APPLIED (${out.changed.length}):`);
        out.changed.forEach((x) => L.push(...[`  ${x.ref}${x.leg === "ret" ? " (return)" : ""}  ${x.title}`, `      ${x.changes.join("; ")}`,
          x.sent ? `      ALREADY SENT TO ${String(x.sent).toUpperCase()}` : "", x.isJob ? "      Apply it or keep the job, on the board." : "      Website/agent booking - change it where it was made."].filter(Boolean)));
        L.push("");
      }
      if (out.removed.length) { L.push(`REMOVED FROM THE CALENDAR (${out.removed.length}) - still on the board:`); out.removed.forEach((x) => L.push(`  ${x.ref}  ${x.why}` + (x.sent ? `  - ALREADY SENT TO ${String(x.sent).toUpperCase()}` : ""))); L.push("  If the trip is off, cancel it on the board.", ""); }
      if (out.skipped.length) { L.push(`NOT PUT ON THE BOARD (${out.skipped.length}):`); out.skipped.forEach((x) => L.push(`  ${x.date}  ${x.title}  - ${x.why}`)); L.push(""); }
      L.push(`Board: ${BOARD}`);
      const n = out.changed.length + out.removed.length;
      await alert(s, (n ? `Calendar: ${n} change${n === 1 ? "" : "s"} need you` : `Calendar: ${out.created.length} new job${out.created.length === 1 ? "" : "s"} on the board`) +
        (n && out.created.length ? ` (+${out.created.length} new)` : ""), L.join("\n")).catch((e) => console.error("calendar alert:", e.message));
    }
    return { created: out.created.map((x) => x.ref), linked: out.linked.length, changed: out.changed.map((x) => x.ref), removed: out.removed.map((x) => x.ref), skipped: out.skipped.length, events: all.length };
  }
  const mailer = () => typeof alert === "function";

  async function removed(row, title, why, out) {
    if (!row.ref) return;
    const isJob = (await pool.query(`SELECT 1 FROM ops_jobs WHERE ref = $1 AND status <> 'cancelled'`, [row.ref])).rows.length > 0;
    const sent = await wasSent(row.ref, row.leg);
    if (isJob) await flagJob(row.ref, `Removed from the calendar: the event was ${why}.` + (sent ? ` It had been sent to ${sent}.` : "") + " If the trip is off, cancel it here; if not, save it to clear this.");
    out.removed.push({ ref: row.ref, why: (title ? `"${title}" ` : "") + why, sent });
    await logEvent("calendar", `${row.ref}${row.leg === "ret" ? " (return)" : ""}: event ${why}.`, row.ref, row.leg);
  }

  /* What a read would do, without doing any of it - for a look before the
     first switch-on. Events already handled are left out. */
  async function preview() {
    const r0 = ready();
    if (!r0.ok) return { skipped: r0.why };
    const today = bneToday(), until = plusDays(today, 180);
    const all = parseIcs(await fetchIcs());
    const known = await knownAccounts();
    const rows = [];
    for (const ev of all) {
      if (ev.start.date < today || ev.start.date > until) continue;
      if ((await pool.query(`SELECT 1 FROM ops_cal WHERE uid = $1`, [ev.uid])).rows.length) continue;
      const title = ev.summary.slice(0, 90) || "(no title)";
      const base = { title, date: ev.start.date, time: ev.start.time || "" };
      if (ev.status === "CANCELLED") continue;
      if (ev.rrule || ev.recurrenceId) { rows.push(Object.assign(base, { action: "skip", why: "repeating event" })); continue; }
      if (ev.start.allDay) { rows.push(Object.assign(base, { action: "skip", why: "all-day, no time" })); continue; }
      const m = mapEvent(ev, known), j = m.job;
      if (!j.pickup || !j.dropoff) continue;
      const hit = await existing(j);
      if (hit) { rows.push(Object.assign(base, { action: "link", ref: hit.ref })); continue; }
      if (j.stRef) m.checks.unshift(`names ${j.stRef}, not in the system`);
      rows.push(Object.assign(base, { action: "create", account: j.account, from: j.pickup, to: j.dropoff, vehicle: j.vehicle, pax: j.pax,
        name: j.name, phone: j.phone, price: j.priceCents != null ? j.priceCents / 100 : null, checks: m.checks }));
    }
    rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    return { events: all.length, rows };
  }
  /* Read the calendar's jobs again with the current reading, for jobs that
     nobody has touched since they were put on the board: never saved by the
     office, never flagged for a change, no driver or dispatch row. Each is
     updated in place - same reference - so nothing is lost or doubled. */
  async function reread() {
    const r0 = ready();
    if (!r0.ok) return { skipped: r0.why };
    const byUid = new Map(parseIcs(await fetchIcs()).map((e) => [e.uid, e]));
    const known = await knownAccounts();
    const rows = (await pool.query(
      `SELECT c.uid, c.ref FROM ops_cal c JOIN ops_jobs j ON j.ref = c.ref
        WHERE c.status = 'created' AND c.pending IS NULL AND c.removed_at IS NULL AND j.updated_at IS NULL AND j.status <> 'cancelled'`)).rows;
    let updated = 0, left = 0;
    for (const r of rows) {
      const ev = byUid.get(r.uid);
      const busy = (await pool.query(`SELECT 1 FROM ops_dispatch WHERE ref = $1`, [r.ref])).rows.length > 0;
      if (!ev || busy || ev.start.allDay) { left++; continue; }
      const m = mapEvent(ev, known), j = m.job;
      if (!j.pickup || !j.dropoff) { left++; continue; }
      const title = ev.summary.slice(0, 90) || "(no title)";
      if (j.stRef) m.checks.unshift(`the event names ${j.stRef}, which isn't in the system`);
      if (j.web) m.checks.unshift("marked WEB in the calendar but no matching website booking was found");
      const note = `From the Google Calendar: "${title}".` + (m.checks.length ? " Check: " + m.checks.join("; ") + "." : "") +
        (ev.description ? "\n\n" + ev.description.slice(0, 1500) : "");
      await pool.query(
        `UPDATE ops_jobs SET account = $2, account_ref = $3, pickup = $4, dropoff = $5, vehicle = $6, pickup_date = $7, pickup_time = $8,
           hire_hours = $9, passenger_name = $10, passenger_phone = $11, passenger_email = $12, flight = $13, pax = $14, child_seats = $15,
           trailer = $16, price_cents = $17, needs_review = $18, source_note = $19
         WHERE ref = $1 AND updated_at IS NULL`,
        [r.ref, j.account, j.accountRef, j.pickup, j.dropoff, j.vehicle || "", j.date, j.time, j.hours, j.name || "", j.phone || "", j.email,
         j.flight, j.pax, j.childSeats, j.trailer, j.priceCents || 0, m.checks.length > 0, note]);
      await pool.query(`UPDATE ops_cal SET fields = $2 WHERE uid = $1`, [r.uid, JSON.stringify(pickFields(j))]);
      updated++;
    }
    await logEvent("calendar", `Re-read ${updated} calendar job${updated === 1 ? "" : "s"} nobody had touched` + (left ? `; ${left} left as they were` : "") + ".");
    return { updated, left };
  }
  if (app && requireAdmin) {
    app.get("/ops/cal/preview", requireAdmin, async (req, res) => {
      try { res.json(await preview()); } catch (err) { console.error("cal preview:", err); res.status(500).json({ error: "Could not read the calendar: " + (err.message || err) }); }
    });
    app.post("/ops/cal/reread", requireAdmin, async (req, res) => {
      try { res.json(await reread()); } catch (err) { console.error("cal reread:", err); res.status(500).json({ error: "Could not re-read the calendar: " + (err.message || err) }); }
    });
  }

  /* ---- the office applies a change, or keeps the job -------------------------------- */
  async function pendingFor(ref) {
    return (await pool.query(`SELECT * FROM ops_cal WHERE ref = $1 AND pending IS NOT NULL ORDER BY last_seen DESC LIMIT 1`, [ref])).rows[0] || null;
  }
  if (app && requireAdmin) {
    app.post("/ops/cal/apply", requireAdmin, async (req, res) => {
      try {
        const ref = String((req.body || {}).ref || "").slice(0, 40);
        const row = await pendingFor(ref);
        if (!row) return res.status(404).json({ error: "There's no calendar change waiting on that job." });
        let p = {}; try { p = JSON.parse(row.pending); } catch (e) { return res.status(500).json({ error: "That change couldn't be read - edit the job by hand." }); }
        if (row.leg === "ret") {
          await pool.query(`UPDATE ops_jobs SET return_date = $2, return_time = $3, return_flight = COALESCE($4, return_flight), needs_review = FALSE, updated_at = now() WHERE ref = $1`,
            [ref, p.date, p.time, p.flight]);
        } else {
          const r = await pool.query(
            `UPDATE ops_jobs SET pickup_date = $2, pickup_time = $3, pickup = $4, dropoff = $5, vehicle = $6, pax = $7,
               passenger_name = $8, passenger_phone = $9, flight = $10, price_cents = COALESCE($11, price_cents),
               account = $12, account_ref = $13, hire_hours = $14, needs_review = FALSE, updated_at = now() WHERE ref = $1`,
            [ref, p.date, p.time, p.pickup, p.dropoff, p.vehicle || "", p.pax || 1, p.name || "", p.phone || "", p.flight, p.priceCents, p.account, p.accountRef, p.hours]);
          if (!r.rowCount) return res.status(404).json({ error: "Only account jobs can take a calendar change here." });
        }
        await pool.query(`UPDATE ops_cal SET fields = pending, pending = NULL, pending_fp = NULL WHERE uid = $1`, [row.uid]);
        const sent = await wasSent(ref, row.leg);
        await logEvent("calendar", `Calendar change applied to ${ref} in the office.`, ref, row.leg);
        res.json({ ok: true, ref, sentTo: sent });
      } catch (err) { console.error("cal apply:", err); res.status(500).json({ error: "Could not apply that change." }); }
    });
    app.post("/ops/cal/keep", requireAdmin, async (req, res) => {
      try {
        const ref = String((req.body || {}).ref || "").slice(0, 40);
        const row = await pendingFor(ref);
        if (!row) return res.status(404).json({ error: "There's no calendar change waiting on that job." });
        /* seen and set aside: the same change won't be raised again */
        await pool.query(`UPDATE ops_cal SET fields = pending, pending = NULL, pending_fp = NULL WHERE uid = $1`, [row.uid]);
        await pool.query(`UPDATE ops_jobs SET needs_review = FALSE, updated_at = now() WHERE ref = $1`, [ref]);
        await logEvent("calendar", `Calendar change on ${ref} set aside in the office - the job was kept as it was.`, ref, row.leg);
        res.json({ ok: true, ref });
      } catch (err) { console.error("cal keep:", err); res.status(500).json({ error: "Could not do that." }); }
    });
  }

  return { ready, initSchema, pass, preview, reread, parseIcs, mapEvent, pendingFor };
};
