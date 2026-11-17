/* ---------------------------------------------------------------------------
 * Outage alarm (18 Nov 2026).
 *
 * On 17 Nov 2026 the Google Cloud free trial ended and Google switched off
 * both keys: the server could not measure a road, the form showed no address
 * suggestions, and nothing told anyone for about 22 hours. This emails the
 * office when that starts, once a day while it lasts, and when it is over.
 *
 * Two things are watched, each with its own alarm:
 *
 *   distance  every real answer route-distance.js gets from Google (never a
 *             cached one). A refused key, a missing key or a spent quota opens
 *             the alarm at the first failure; a timeout or a Google error
 *             needs three in a row inside half an hour.
 *   address   the booking form and the agent portal say, once per page load,
 *             whether Google's address search answered (POST /site-signal -
 *             the status word only, no address, nothing about the guest).
 *             Two refusals with no success between open the alarm.
 *
 * Closing takes two successes in a row. While the distance alarm is open the
 * server asks Google for one fixed route every five minutes, so "working
 * again" arrives soon after the fix and does not wait for a customer. The
 * address search runs in the browser with the website's own key, so the server
 * cannot test it: that alarm closes when visitors' forms report success.
 *
 * The open alarms are kept in the database, so a restart in the middle of an
 * outage does not send the first email again. Without a database it still
 * works, from memory. Nothing here throws into a booking: every send, save
 * and probe is caught.
 * ------------------------------------------------------------------------ */
const MIN = 60 * 1000, HOUR = 60 * MIN;

const RULES = {
  distance: {
    hard: ["http_401", "http_403", "http_429", "no_key"], hardNeed: 1,
    soft: (r) => r === "timeout" || r === "network" || r === "bad_response" || /^http_5\d\d$/.test(r), softNeed: 3,
    window: 30 * MIN,
  },
  address: {
    hard: ["REQUEST_DENIED", "OVER_QUERY_LIMIT"], hardNeed: 2,
    soft: (r) => r === "UNKNOWN_ERROR", softNeed: 4,
    window: 3 * HOUR,
  },
};
const CLOSE_AFTER = 2;            // successes in a row
const REMIND_EVERY = 24 * HOUR;
const JUMPY_FOR = 30 * MIN;       // just after an alarm closes, one failure is not enough to open it again
const PROBE_EVERY = 5 * MIN, CONFIRM_AFTER = 20 * 1000;
/* a short, permanent drive: the airport to the middle of the city */
const PROBE_FROM = { lat: -27.3942, lng: 153.1218 }, PROBE_TO = { lat: -27.4698, lng: 153.0251 };

const when = (ms) => new Date(ms).toLocaleString("en-AU", { timeZone: "Australia/Brisbane", weekday: "short", day: "numeric", month: "short",
  year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).replace(",", "") + " (Brisbane time)";
function howLong(ms) {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return m + " minute" + (m === 1 ? "" : "s");
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 48) return h + " hour" + (h === 1 ? "" : "s") + (r ? " " + r + " minute" + (r === 1 ? "" : "s") : "");
  const d = Math.floor(h / 24), hr = h % 24;
  return d + " days" + (hr ? " " + hr + " hour" + (hr === 1 ? "" : "s") : "");
}

/* What Google said, and what to look at, in plain words. */
function saidDistance(r) {
  if (r === "http_403" || r === "http_401") return ["Google refused the server's key (error " + r.slice(5) + ").", [
    "Google Cloud billing: console.cloud.google.com/billing - the billing account must be active. (This was the cause on 17 Nov 2026, when the free trial ended.)",
    "If billing is fine: the Routes key is locked to the booking server's outbound addresses. Compare them with the list in Render (the booking server, Connect, Outbound).",
  ]];
  if (r === "http_429") return ["Google says the usage limit has been reached (error 429).", [
    "Google Cloud console, APIs & Services, Routes API, Quotas - and any spending cap under Billing, Budgets & caps.",
  ]];
  if (r === "no_key") return ["The booking server has no Google key.", [
    "Render, the booking server, Environment: GOOGLE_ROUTES_KEY must be set.",
  ]];
  return ["Google did not answer (" + r.replace("http_", "error ").replace("_", " ") + ").", [
    "This is usually on Google's side and passes by itself. If the reminder arrives tomorrow, check status.cloud.google.com.",
  ]];
}
function saidAddress(r) {
  if (r === "OVER_QUERY_LIMIT") return ["Google says the usage limit has been reached.", [
    "Google Cloud console, APIs & Services, Places API, Quotas - and any spending cap under Billing, Budgets & caps.",
  ]];
  if (r === "REQUEST_DENIED") return ["Google refused the website's key.", [
    "Google Cloud billing: console.cloud.google.com/billing - the billing account must be active. (This was the cause on 17 Nov 2026, when the free trial ended.)",
    "If billing is fine: the website key (APIs & Services, Credentials) must still allow www.skytransfers.com.au, with Places API and Maps JavaScript API ticked.",
  ]];
  return ["Google's address search returned an error.", [
    "This is usually on Google's side and passes by itself. If the reminder arrives tomorrow, check status.cloud.google.com.",
  ]];
}
const WORDS = {
  distance: {
    what: "distance prices",
    effect: [
      "The booking server could not get a road distance from Google, so the website and the agent portal cannot price these right now:",
      "  - a trip between two addresses, where neither end is an airport",
      "  - an airport trip to a place that is not on the suburb list",
      "  - stops on the way",
      "Trips with a published fare (a listed suburb to or from an airport or the cruise terminal) are not affected.",
    ],
    counted: (n) => n + " price lookup" + (n === 1 ? " has" : "s have") + " failed so far.",
    countedOver: (n) => n + " price lookup" + (n === 1 ? "" : "s") + " failed in that time.",
    after: "The server now tests Google every five minutes and will email again as soon as it is working.",
    said: saidDistance,
  },
  address: {
    what: "address search",
    effect: [
      "Google is not answering the address search on the booking form and the agent portal, so a customer who types a street address or a hotel sees no suggestions.",
      "They can still choose a suburb or an airport from our own list, and those prices still show.",
    ],
    counted: (n) => n + " visit" + (n === 1 ? " has" : "s have") + " hit it so far.",
    countedOver: (n) => n + " visit" + (n === 1 ? "" : "s") + " hit it in that time.",
    after: "This one is tested by real visitors: it clears, and you get an email, once the form reports suggestions twice. Typing an address on the website yourself counts.",
    said: saidAddress,
  },
};

module.exports = function installOutageAlarm(ctx) {
  const { app, pool, requireAdmin, mailer, BOOKINGS_EMAIL } = ctx;
  const now = ctx.now || (() => Date.now());
  const from = ctx.from || undefined;
  const fresh = () => ({ open: false, since: 0, lastMail: 0, reason: "", fails: 0, n: 0, hard: 0, start: 0, firstFail: 0, good: 0, closedAt: 0 });
  const S = { distance: fresh(), address: fresh() };

  /* ---- email ---- */
  const sent = [];
  function mail(subject, lines) {
    sent.push(subject);
    if (!mailer || !BOOKINGS_EMAIL) { console.error("outage alarm (no mailer): " + subject); return; }
    Promise.resolve().then(() => mailer.sendMail({ from, to: BOOKINGS_EMAIL, subject, text: lines.join("\n") }))
      .catch((err) => console.error("outage alarm: email not sent:", err && err.message));
  }
  function body(kind, s, extra) {
    const W = WORDS[kind], said = W.said(s.reason);
    return [].concat(extra || [], W.effect, "",
      "Started: " + when(s.since),
      "What Google said: " + said[0], "",
      "What to check:", said[1].map((x, i) => "  " + (i + 1) + ". " + x), "",
      W.after, "Until then you get one reminder a day.");
  }
  const flat = (a) => a.reduce((o, x) => o.concat(x), []);

  /* ---- the database copy of an open alarm ---- */
  let dbReady = false, saving = Promise.resolve();
  /* One save at a time, each writing the state as it is when its turn comes,
     so two failures arriving together cannot trip over each other. */
  function save(kind) {
    if (!pool || !dbReady) return;
    saving = saving.then(async () => {
      const s = S[kind];
      await pool.query("DELETE FROM outage_alarms WHERE kind = $1", [kind]);
      if (s.open) await pool.query("INSERT INTO outage_alarms (kind, since_ms, last_mail_ms, reason, fails) VALUES ($1, $2, $3, $4, $5)", [kind, s.since, s.lastMail, s.reason, s.fails]);
    }).catch((err) => console.error("outage alarm: not saved:", err && err.message));
  }
  const ready = !pool ? Promise.resolve() : Promise.resolve()
    .then(() => pool.query("CREATE TABLE IF NOT EXISTS outage_alarms (kind TEXT PRIMARY KEY, since_ms BIGINT NOT NULL, last_mail_ms BIGINT NOT NULL, reason TEXT NOT NULL, fails INTEGER NOT NULL DEFAULT 0)")
      .catch(() => { /* already there, or the read below says why not */ }))
    .then(() => pool.query("SELECT kind, since_ms, last_mail_ms, reason, fails FROM outage_alarms"))
    .then((r) => {
      r.rows.forEach((x) => {
        const s = S[x.kind];
        if (!s || s.open) return;          /* one that opened since start-up wins */
        Object.assign(s, { open: true, since: Number(x.since_ms), lastMail: Number(x.last_mail_ms), reason: x.reason, fails: Number(x.fails) });
      });
      dbReady = true;
      Object.keys(S).forEach((k) => { if (S[k].open) save(k); });
    })
    .catch((err) => console.error("outage alarm: database not used (alarm still works):", err && err.message));

  /* ---- the rules ---- */
  function signal(kind, reason, opts) {
    const s = S[kind], R = RULES[kind], W = WORDS[kind];
    if (!s) return;
    const t = now(), quiet = !!(opts && opts.probe);
    if (!reason) {                                   /* Google answered */
      s.n = 0; s.hard = 0;
      if (!s.open) return;
      if (++s.good < CLOSE_AFTER) return;
      const ran = t - s.since;
      mail("Website alert over: " + W.what + (kind === "address" ? " is" : " are") + " working again", [
        "Working again: " + when(t),
        "It was down for " + howLong(ran) + ", from " + when(s.since) + ".",
        W.countedOver(s.fails),
      ]);
      Object.assign(s, fresh(), { closedAt: t });
      save(kind);
      return;
    }
    const hard = R.hard.indexOf(reason) !== -1, soft = !hard && R.soft(reason);
    if (!hard && !soft) return;                      /* one bad address is not an outage */
    s.good = 0;
    if (s.open) {
      if (quiet) { remind(kind); return; }
      s.fails++; s.reason = reason;
      remind(kind);
      save(kind);
      return;
    }
    if (quiet) return;
    if (!s.n || t - s.start > R.window) { s.n = 0; s.hard = 0; s.start = t; }
    s.n++; if (hard) s.hard++;
    const jumpy = s.closedAt && t - s.closedAt < JUMPY_FOR ? 1 : 0;
    if (s.hard < R.hardNeed + jumpy && s.n < R.softNeed + jumpy) return;
    Object.assign(s, { open: true, since: s.start, lastMail: t, reason, fails: s.n, good: 0 });
    mail("Website alert: " + W.what + (kind === "address" ? " has" : " have") + " stopped working", flat(body(kind, s)));
    save(kind);
  }
  function remind(kind) {
    const s = S[kind], W = WORDS[kind], t = now();
    if (!s.open || t - s.lastMail < REMIND_EVERY) return;
    s.lastMail = t;
    mail("Website alert (still down): " + W.what + (kind === "address" ? " has" : " have") + " not worked since " + when(s.since),
      flat(body(kind, s, ["Still not working after " + howLong(t - s.since) + ". " + W.counted(s.fails), ""])));
    save(kind);
  }

  /* ---- distance: every real answer, from every copy of route-distance ---- */
  let probing = false;
  let rd = null;
  try { rd = require("./route-distance"); } catch (err) { rd = null; }
  if (rd && typeof rd.watch === "function") rd.watch((reason) => signal("distance", reason, { probe: probing }));

  /* While the alarm is open, ask Google for one fixed route; a success is
     confirmed with a second, then the alarm closes itself. */
  let roads = null;
  async function probe() {
    const s = S.distance;
    if (!s.open) return "closed";
    try {
      if (!roads) roads = (ctx.makeRoads || rd)({});
      if (!roads || !roads.enabled) { remind("distance"); return "no key"; }
      for (let i = 0; i < CLOSE_AFTER && s.open; i++) {
        if (i) await new Promise((r) => setTimeout(r, ctx.confirmAfterMs != null ? ctx.confirmAfterMs : CONFIRM_AFTER));
        if (roads.clearCache) roads.clearCache();
        probing = true;
        let r;
        try { r = await roads.distance(PROBE_FROM, PROBE_TO); } finally { probing = false; }
        if (!r || r.km == null) break;
      }
      if (s.open) remind("distance");
      return s.open ? "still down" : "recovered";
    } catch (err) {
      probing = false;
      console.error("outage alarm: probe failed:", err && err.message);
      return "error";
    }
  }
  const timer = setInterval(() => { probe(); }, ctx.probeEveryMs || PROBE_EVERY);
  if (timer.unref) timer.unref();

  /* ---- address search: what the forms report ---- */
  const STATUSES = { OK: null, ZERO_RESULTS: null, REQUEST_DENIED: "REQUEST_DENIED", OVER_QUERY_LIMIT: "OVER_QUERY_LIMIT", UNKNOWN_ERROR: "UNKNOWN_ERROR" };
  const seen = new Map();          /* visitor -> { n, from, lastFault } */
  const PER_HOUR = 12, FAULT_GAP = 10 * MIN;
  if (app) app.post("/site-signal", (req, res) => {
    res.status(204).end();
    try {
      const b = req.body || {};
      if (b.k !== "address" || !Object.prototype.hasOwnProperty.call(STATUSES, b.s)) return;
      const t = now(), ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim() || "?";
      if (seen.size > 5000) seen.clear();
      let v = seen.get(ip);
      if (!v || t - v.from > HOUR) { v = { n: 0, from: t, lastFault: 0 }; seen.set(ip, v); }
      if (++v.n > PER_HOUR) return;
      const reason = STATUSES[b.s];
      if (reason) {
        if (v.lastFault && t - v.lastFault < FAULT_GAP) return;   /* one visitor, one report */
        v.lastFault = t;
      }
      signal("address", reason);
    } catch (err) { /* a report must never matter to the page that sent it */ }
  });

  const view = (s) => (s.open ? { working: false, since: new Date(s.since).toISOString(), sinceText: when(s.since), reason: s.reason, failed: s.fails } : { working: true });
  if (app && typeof requireAdmin === "function") {
    app.get("/admin/outage-status", requireAdmin, (req, res) => res.json({ distance: view(S.distance), address: view(S.address) }));
  }

  console.log("Outage alarm ready (distance prices and address search" + (mailer ? "" : "; no mailer, so alerts go to the log only") + ")");
  return { signal, probe, ready, sent, status: () => ({ distance: view(S.distance), address: view(S.address) }), stop: () => clearInterval(timer) };
};
