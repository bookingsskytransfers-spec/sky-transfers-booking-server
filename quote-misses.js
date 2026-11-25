/* ---------------------------------------------------------------------------
 * Why a price could not be given (26 Nov 2026).
 *
 * Analytics showed about one point-to-point quote in four being refused, but
 * not why: the website's "quote failed" event carried the sentence shown to
 * the visitor in a field Analytics was never set up to report on, and the
 * server said nothing at all when it refused a trip by rule. So nobody could
 * tell an out-of-area trip from a long one from a fault.
 *
 * This watches the two distance-priced quote endpoints from the outside - it
 * wraps the reply, it does not touch how a price is worked out - and keeps:
 *   - a count per day of quotes priced and quotes refused, and
 *   - for each refusal: which endpoint, the reason code, the two SUBURBS, and
 *     the distance when the server had measured one.
 * No street address, no coordinates, nothing about the visitor. Rows older
 * than KEEP_DAYS are dropped at start-up.
 *
 *   GET /admin/quote-misses?days=30    the summary, behind the office login
 *
 * Mounted in a try/catch like the other optional modules: if this throws,
 * quotes and bookings carry on exactly as before.
 * ------------------------------------------------------------------------ */
module.exports = function installQuoteMisses({ app, pool, requireAdmin }) {
  if (!app || !pool) { console.log("Quote record: off (no database)"); return { on: false }; }

  const KEEP_DAYS = 180;
  const DAILY_CAP = 1000;   /* refusals kept per day; the counts carry on past it */
  const KIND = { "/p2p-quote": "p2p", "/km-quote": "km" };

  /* In words, for the admin page. Anything not listed shows its code. */
  const LABEL = {
    outside_banded_area: "Outside the area priced online (Sunshine Coast, Toowoomba, Byron and northern NSW, or a suburb not on the list)",
    over_max_km: "Longer than the online limit",
    same_place: "Both ends in the same suburb",
    airport_leg_use_computeFare: "An airport or the cruise terminal at one end, sent as a non-airport trip",
    vehicle_quoted_by_hand: "The 18-seater, which is quoted by hand",
    unknown_vehicle: "A vehicle the server does not know",
    incomplete: "An address was missing or not chosen from the suggestions",
    need_address: "An address was missing or not chosen from the suggestions",
    listed: "A place that has a published fare, asked for by distance",
    not_airport: "Not an airport trip, asked for on the airport distance price",
    server_error: "A fault on the server",
    refused: "Refused, no reason given",
  };
  /* What route-distance.js answers when Google could not give a distance. */
  const labelOf = (reason, status) => LABEL[reason] || (status === 503 ? "The distance could not be measured (Google): " + reason : reason);

  const bneDay = () => new Date(Date.now() + 10 * 3600e3).toISOString().slice(0, 10);
  const nameOf = (x) => String(typeof x === "string" ? x : (x && (x.suburb || x.locality)) || "").trim().slice(0, 80);

  let ready = false;
  pool.query(`
    CREATE TABLE IF NOT EXISTS quote_misses (
      id      SERIAL PRIMARY KEY,
      at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      kind    TEXT NOT NULL,
      reason  TEXT NOT NULL,
      status  INTEGER,
      pickup  TEXT,
      dropoff TEXT,
      km      REAL
    );
    CREATE INDEX IF NOT EXISTS quote_misses_at ON quote_misses (at);
    CREATE TABLE IF NOT EXISTS quote_counts (
      day    TEXT NOT NULL,
      kind   TEXT NOT NULL,
      priced INTEGER NOT NULL DEFAULT 0,
      missed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS quote_counts_day ON quote_counts (day);
  `).then(() => pool.query(`DELETE FROM quote_misses WHERE at < $1`, [new Date(Date.now() - KEEP_DAYS * 864e5)]))
    .then(() => { ready = true; console.log("Quote record ready (why a price could not be given)"); })
    .catch((e) => console.error("Quote record setup failed:", e.message));

  /* One row per day and endpoint. Update first; the first quote of a day
     inserts. Two first quotes landing together could make two rows for the
     day, which is why the summary adds them up rather than assuming one. */
  async function bump(kind, priced) {
    const day = bneDay(), col = priced ? "priced" : "missed";
    const up = await pool.query(`UPDATE quote_counts SET ${col} = ${col} + 1 WHERE day = $1 AND kind = $2`, [day, kind]);
    if (!up.rowCount) await pool.query(`INSERT INTO quote_counts (day, kind, priced, missed) VALUES ($1, $2, $3, $4)`, [day, kind, priced ? 1 : 0, priced ? 0 : 1]);
  }

  let capDay = "", capN = 0;
  function record(kind, asked, answer, status) {
    if (!ready) return;
    const priced = status < 400;
    bump(kind, priced).catch((e) => console.error("quote record count:", e.message));
    if (priced) return;
    const day = bneDay();
    if (day !== capDay) { capDay = day; capN = 0; }
    if (++capN > DAILY_CAP) return;
    const reason = String(answer.reason || (status === 400 ? "incomplete" : status >= 500 ? "server_error" : "refused")).slice(0, 60);
    const km = Number(answer.km);
    pool.query(`INSERT INTO quote_misses (kind, reason, status, pickup, dropoff, km) VALUES ($1, $2, $3, $4, $5, $6)`,
      [kind, reason, status, nameOf(asked.pickup) || null, nameOf(asked.dropoff) || null, Number.isFinite(km) && km > 0 ? Math.round(km * 10) / 10 : null])
      .catch((e) => console.error("quote record:", e.message));
  }

  /* Before the quote routes are mounted, so it sees their replies. */
  app.use((req, res, next) => {
    const kind = req.method === "POST" ? KIND[req.path] : null;
    if (!kind) return next();
    const send = res.json.bind(res);
    res.json = (body) => {
      try { record(kind, req.body || {}, body || {}, res.statusCode); } catch (e) { /* never in the way of the reply */ }
      return send(body);
    };
    next();
  });

  if (typeof requireAdmin === "function") {
    app.get("/admin/quote-misses", requireAdmin, async (req, res) => {
      try {
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), KEEP_DAYS);
        const since = new Date(Date.now() - days * 864e5);
        const sinceDay = new Date(since.getTime() + 10 * 3600e3).toISOString().slice(0, 10);
        const counts = { p2p: { priced: 0, missed: 0 }, km: { priced: 0, missed: 0 } };
        let firstDay = null;
        for (const r of (await pool.query(`SELECT day, kind, priced, missed FROM quote_counts WHERE day >= $1`, [sinceDay])).rows) {
          if (!counts[r.kind]) counts[r.kind] = { priced: 0, missed: 0 };
          counts[r.kind].priced += Number(r.priced) || 0; counts[r.kind].missed += Number(r.missed) || 0;
          if (!firstDay || r.day < firstDay) firstDay = r.day;
        }
        const rows = (await pool.query(
          `SELECT kind, reason, status, pickup, dropoff, km, at FROM quote_misses WHERE at >= $1 ORDER BY at DESC LIMIT 5000`, [since])).rows;
        const why = new Map(), trips = new Map();
        for (const r of rows) {
          const k = r.kind + "|" + r.reason;
          const w = why.get(k) || { kind: r.kind, reason: r.reason, label: labelOf(r.reason, r.status), n: 0 };
          w.n++; why.set(k, w);
          const tk = k + "|" + (r.pickup || "") + "|" + (r.dropoff || "");
          const t = trips.get(tk) || { kind: r.kind, reason: r.reason, label: labelOf(r.reason, r.status), pickup: r.pickup || "", dropoff: r.dropoff || "", n: 0, km: null, last: r.at };
          t.n++; if (r.km != null && (t.km == null || r.km > t.km)) t.km = Number(r.km);
          trips.set(tk, t);
        }
        res.json({
          days, since: sinceDay, recordingSince: firstDay, counts,
          byReason: Array.from(why.values()).sort((a, b) => b.n - a.n),
          trips: Array.from(trips.values()).sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : -1)).slice(0, 60),
        });
      } catch (err) {
        console.error("quote misses:", err);
        res.status(500).json({ error: "Could not read the quote record just now." });
      }
    });
  }

  return { on: true };
};
