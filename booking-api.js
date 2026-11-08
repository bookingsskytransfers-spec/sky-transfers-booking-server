/**
 * Sky Transfers - booking API for travel partners (8 Nov 2026)
 * ------------------------------------------------------------
 * Lets a DMC's own system send us bookings without anyone typing them into
 * the agent portal. One way: they send, we answer at once with our reference
 * and price. There is no second set of rules here - every request is handed
 * to the agent portal's own quote / book / cancel routes, signed in as that
 * agency, so prices (rate card or not), notice periods, cancellation charges,
 * the office email and the agency's copy are exactly the portal's.
 *
 *   Auth      Authorization: Bearer sky_...   (or X-Api-Key: sky_...)
 *             One key per agency, made in admin.html (Agents tab), shown once,
 *             stored only as a SHA-256 hash, switched off with Revoke.
 *   GET    /api/v1/vehicles              vehicle names to send
 *   POST   /api/v1/quote                 prices for a trip, nothing booked
 *   POST   /api/v1/bookings              book; "reference" (theirs) is required
 *                                         and makes a resend safe: the same
 *                                         reference returns the same booking
 *   GET    /api/v1/bookings/:ref         status of one of their bookings
 *   POST   /api/v1/bookings/:ref/cancel  cancel (inside the charge window it
 *                                         needs "acceptCharge": true)
 *
 * Places: { "airport": "OOL" | "BNE" | "CRUISE" } or { "address": "...",
 * "suburb": "..." , "lat": .., "lng": .. }. The suburb (given, or read from
 * the address) picks the zone fare; an address outside our zones needs lat
 * and lng to be measured, or it gets "needs a manual quote".
 */
const crypto = require("crypto");

module.exports = function installBookingApi(ctx) {
  const { app, pool, auth, requireAdmin, VEHICLES, PLACES, HUBS } = ctx;
  if (!app || !pool || !auth || typeof auth.signToken !== "function" || !requireAdmin) {
    console.log("Booking API off (needs the agent portal)");
    return { on: false };
  }
  const [OOL, BNE, CRUISE] = HUBS;
  const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
  const txt = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

  pool.query(`CREATE TABLE IF NOT EXISTS agent_api_keys (
      id           SERIAL PRIMARY KEY,
      agent_code   TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      key_hint     TEXT,
      label        TEXT,
      created_at   TIMESTAMPTZ DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      revoked_at   TIMESTAMPTZ)`).catch((e) => console.error("api keys table:", e.message));

  /* ---- places ------------------------------------------------------------ */
  const AIRPORTS = { ool: OOL, "gold coast airport": OOL, coolangatta: OOL, "coolangatta airport": OOL,
    bne: BNE, "brisbane airport": BNE, "brisbane international airport": BNE, "brisbane domestic airport": BNE,
    cruise: CRUISE, "brisbane cruise terminal": CRUISE, "brisbane international cruise terminal": CRUISE, pinkenba: CRUISE };
  for (const h of HUBS) AIRPORTS[h.toLowerCase()] = h;
  const PLACE_BY_LC = new Map((PLACES || []).map((p) => [p.toLowerCase(), p]));
  const NAMES = [...PLACE_BY_LC.keys()].filter((p) => !AIRPORTS[p]);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /* The suburb in an Australian address comes after the street, so the LAST
     place name found wins ("1 Nerang St, Southport" is Southport); a tie at
     the same spot goes to the longer name ("Broadbeach Waters"). */
  function suburbIn(address) {
    const a = " " + String(address).toLowerCase().replace(/[,]/g, " ") + " ";
    let best = null;
    for (const n of NAMES) {
      const re = new RegExp("[^a-z]" + esc(n) + "(?=[^a-z])", "g");
      let m; while ((m = re.exec(a))) {
        if (!best || m.index > best.at || (m.index === best.at && n.length > best.n.length)) best = { at: m.index, n };
      }
    }
    return best ? PLACE_BY_LC.get(best.n) : null;
  }
  /* -> { name, end } for the portal, or { error } */
  function placeOf(v, which) {
    const o = typeof v === "string" ? { address: v } : v && typeof v === "object" ? v : null;
    if (!o) return { error: `"${which}" is required.` };
    const ap = o.airport != null ? AIRPORTS[String(o.airport).trim().toLowerCase()] : null;
    if (o.airport != null && !ap) return { error: `"${which}.airport" must be OOL, BNE or CRUISE.` };
    if (ap) return { name: ap, end: { suburb: ap } };
    const address = txt(o.address, 300), sub = txt(o.suburb, 120);
    const asHub = AIRPORTS[(address || sub).toLowerCase()];
    if (asHub) return { name: asHub, end: { suburb: asHub } };
    if (!address && !sub) return { error: `"${which}" needs an airport, or an address.` };
    const known = (sub && PLACE_BY_LC.get(sub.toLowerCase())) || suburbIn(address || sub);
    const end = { suburb: known || sub || address, address: address || undefined };
    if (Number.isFinite(+o.lat) && Number.isFinite(+o.lng) && o.lat !== "" && o.lng !== "" && o.lat != null && o.lng != null) { end.lat = +o.lat; end.lng = +o.lng; }
    return { name: known || address || sub, end };
  }
  const dateOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d), timeOk = (t) => /^\d{2}:\d{2}$/.test(t);

  /* API body -> the agent portal's body, or { error } */
  function portalBody(b, forBooking) {
    const pu = placeOf(b.pickup, "pickup"); if (pu.error) return pu;
    const hours = b.hours != null ? parseInt(b.hours, 10) : null;
    const dr = hours ? { name: "", end: null } : placeOf(b.dropoff, "dropoff"); if (dr.error) return dr;
    const date = txt(b.date, 10), time = txt(b.time, 5);
    if (!dateOk(date) || !timeOk(time)) return { error: `"date" (YYYY-MM-DD) and "time" (HH:MM, 24-hour, Brisbane time) are required.` };
    const out = { pickup: pu.name, dropoff: dr.name, date, time, ends: { pickup: pu.end }, pax: parseInt(b.pax, 10) || 1,
      childSeats: parseInt(b.childSeats, 10) || 0 };
    if (dr.end) out.ends.dropoff = dr.end;
    if (hours) out.hourly = { hours };
    const r = b.return && typeof b.return === "object" ? b.return : null;
    if (r) {
      if (!dateOk(txt(r.date, 10)) || !timeOk(txt(r.time, 5))) return { error: `"return.date" and "return.time" are both required for a return trip.` };
      Object.assign(out, { returnTrip: true, returnDate: txt(r.date, 10), returnTime: txt(r.time, 5), returnFlight: txt(r.flight, 20) });
    }
    if (b.interstate) out.interstate = b.interstate;
    if (b.service) out.service = txt(b.service, 40);
    if (forBooking) {
      const p = b.passenger && typeof b.passenger === "object" ? b.passenger : {};
      Object.assign(out, { vehicle: txt(b.vehicle, 60), name: txt(p.name, 120), phone: txt(p.phone, 40), email: txt(p.email, 200),
        flight: txt(b.flight, 20), notes: txt(b.notes, 1000), clientRef: txt(b.reference, 60) });
      if (!out.clientRef) return { error: `"reference" (your own booking reference) is required.` };
      if (!out.vehicle) return { error: `"vehicle" is required - GET /api/v1/vehicles lists the names.` };
      if (!out.name || !out.phone) return { error: `"passenger.name" and "passenger.phone" are required.` };
    }
    return { body: out };
  }

  /* ---- auth -------------------------------------------------------------- */
  const HITS = new Map(); // key id -> [timestamps], 120 requests a minute
  async function requireKey(req, res, next) {
    try {
      const key = (req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "")).trim();
      if (!/^sky_[A-Za-z0-9_-]{20,}$/.test(key)) return res.status(401).json({ error: "Missing or malformed API key." });
      const { rows } = await pool.query(
        `SELECT k.id, k.agent_code FROM agent_api_keys k JOIN agents a ON a.code = k.agent_code
          WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND a.active`, [sha(key)]);
      if (!rows.length) return res.status(401).json({ error: "That API key isn't valid or has been switched off." });
      const now = Date.now(), h = (HITS.get(rows[0].id) || []).filter((t) => now - t < 60e3);
      if (h.length >= 120) return res.status(429).json({ error: "Too many requests - slow down to 120 a minute." });
      h.push(now); HITS.set(rows[0].id, h);
      req.apiKey = rows[0];
      pool.query(`UPDATE agent_api_keys SET last_used_at = now() WHERE id = $1`, [rows[0].id]).catch(() => {});
      next();
    } catch (e) { console.error("api auth:", e.message); res.status(500).json({ error: "Could not check that key just now." }); }
  }

  /* Hand the request to one of the agent portal's own routes, signed in as
     the key's agency (marked "API" so the office email and changed_by say
     where it came from), and shape the answer on the way back. */
  function forward(req, res, method, url, body, shape) {
    req.method = method; req.url = url; req.body = body;
    req.headers.authorization = "Bearer " + auth.signToken(req.apiKey.agent_code, "agent", 5 * 60e3, { via: "API" });
    delete req.headers["x-api-key"];
    const json = res.json.bind(res);
    res.json = (out) => json(shape ? shape(res.statusCode, out) : out);
    app.handle(req, res, () => { if (!res.headersSent) res.status(404).json({ error: "Not found." }); });
  }

  app.get("/api/v1/vehicles", requireKey, (req, res) => res.json({ vehicles: VEHICLES }));

  app.post("/api/v1/quote", requireKey, (req, res) => {
    const p = portalBody(req.body || {}, false);
    if (p.error) return res.status(400).json({ error: p.error });
    forward(req, res, "POST", "/agent/quote", p.body, (code, out) => code !== 200 ? out : out.quotable
      ? { quotable: true, kind: out.kind, hours: out.hours || null,
          vehicles: out.vehicles.map((v) => ({ vehicle: v.vehicle, price: v.total, currency: "AUD" })) }
      : { quotable: false, message: out.message });
  });

  app.post("/api/v1/bookings", requireKey, async (req, res) => {
    try {
      const p = portalBody(req.body || {}, true);
      if (p.error) return res.status(400).json({ error: p.error });
      /* Sent twice (a timeout, a retry): the booking already made, not a second car. */
      const { rows } = await pool.query(
        `SELECT ref, total_cents, status FROM agent_bookings WHERE agent_code = $1 AND client_ref = $2 AND status = 'confirmed'
          ORDER BY created_at DESC LIMIT 1`, [req.apiKey.agent_code, p.body.clientRef]);
      if (rows.length) return res.json({ ok: true, duplicate: true, ref: rows[0].ref, reference: p.body.clientRef, price: rows[0].total_cents / 100, currency: "AUD", status: "confirmed" });
      forward(req, res, "POST", "/agent/book", p.body, (code, out) => code !== 200 || !out.ok ? out
        : { ok: true, ref: out.ref, reference: p.body.clientRef, price: out.total, currency: "AUD", status: "confirmed" });
    } catch (e) { console.error("api book:", e.message); res.status(500).json({ error: "Could not save that booking - please email or call us so it isn't lost." }); }
  });

  app.get("/api/v1/bookings/:ref", requireKey, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ref, client_ref, status, pickup, dropoff, pickup_date, pickup_time, vehicle, pax, total_cents, return_date, return_time
           FROM agent_bookings WHERE agent_code = $1 AND (ref = $2 OR client_ref = $2) ORDER BY created_at DESC LIMIT 1`,
        [req.apiKey.agent_code, txt(req.params.ref, 60)]);
      if (!rows.length) return res.status(404).json({ error: "No booking with that reference." });
      const r = rows[0], d = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : x || null);
      res.json({ ref: r.ref, reference: r.client_ref, status: r.status, pickup: r.pickup, dropoff: r.dropoff, date: d(r.pickup_date), time: r.pickup_time,
        vehicle: r.vehicle, pax: r.pax, price: r.total_cents / 100, currency: "AUD",
        return: r.return_date ? { date: d(r.return_date), time: r.return_time } : null });
    } catch (e) { console.error("api get:", e.message); res.status(500).json({ error: "Could not look that up just now." }); }
  });

  app.post("/api/v1/bookings/:ref/cancel", requireKey, async (req, res) => {
    try {
      const want = txt(req.params.ref, 60);
      const { rows } = await pool.query(`SELECT ref FROM agent_bookings WHERE agent_code = $1 AND (ref = $2 OR client_ref = $2) ORDER BY created_at DESC LIMIT 1`,
        [req.apiKey.agent_code, want]);
      if (!rows.length) return res.status(404).json({ error: "No booking with that reference." });
      forward(req, res, "POST", "/agent/booking/cancel", { ref: rows[0].ref, acceptCharge: (req.body || {}).acceptCharge === true },
        (code, out) => code === 200 && out.ok ? { ok: true, ref: rows[0].ref, status: "cancelled", charged: out.charged || 0, currency: "AUD" } : out);
    } catch (e) { console.error("api cancel:", e.message); res.status(500).json({ error: "Could not cancel just now - please call us." }); }
  });

  /* ---- office: keys -------------------------------------------------------- */
  app.post("/admin/api-key", requireAdmin, async (req, res) => {
    try {
      const code = txt((req.body || {}).code, 16).toUpperCase();
      const { rows } = await pool.query(`SELECT code FROM agents WHERE code = $1`, [code]);
      if (!rows.length) return res.status(404).json({ error: "No agency with that code." });
      const key = "sky_" + crypto.randomBytes(24).toString("base64url");
      await pool.query(`INSERT INTO agent_api_keys (agent_code, key_hash, key_hint, label) VALUES ($1, $2, $3, $4)`,
        [code, sha(key), key.slice(0, 8) + "..." + key.slice(-4), txt((req.body || {}).label, 80) || null]);
      res.json({ ok: true, key, note: "Shown once - copy it now. Only a fingerprint is kept." });
    } catch (e) { console.error("api key create:", e.message); res.status(500).json({ error: "Could not make a key." }); }
  });
  app.get("/admin/api-keys", requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT id, agent_code, key_hint, label, created_at, last_used_at, revoked_at FROM agent_api_keys ORDER BY created_at DESC LIMIT 200`);
      res.json({ keys: rows });
    } catch (e) { console.error("api keys:", e.message); res.status(500).json({ error: "Could not load the keys." }); }
  });
  app.post("/admin/api-key/revoke", requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(`UPDATE agent_api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [parseInt((req.body || {}).id, 10) || 0]);
      res.json({ ok: r.rowCount === 1 });
    } catch (e) { console.error("api key revoke:", e.message); res.status(500).json({ error: "Could not switch that key off." }); }
  });

  console.log("Booking API ready (/api/v1)");
  return { on: true, placeOf, suburbIn, portalBody };
};
