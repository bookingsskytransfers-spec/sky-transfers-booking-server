/* ---------------------------------------------------------------------------
 * Stops along the way (Aman, 19 Oct 2026): up to three, added by the office
 * or on the website form, priced by the EXTRA road distance they add.
 *
 *   extra km   = (pick-up -> stop 1 -> ... -> drop-off) - (pick-up -> drop-off)
 *   extra fare = extra km x the vehicle's per-km rate, rounded to $5
 *
 * The per-km rate is the slope of the km table in km-fare.js across 0-300 km
 * (Sedan about $2.28/km, Sprinter 14 about $3.64/km), so a stop costs what the
 * same distance costs on any other trip. A stop that adds less than half a
 * kilometre costs nothing. Stops are on the outbound journey only; the extra is
 * added once, after the return discount, never discounted or doubled.
 *
 * Every leg is measured by route-distance.js (cached), so the quote the page
 * shows and the price the server charges come from the same numbers. If any
 * leg cannot be measured the booking is not priced (null) - never guessed.
 * ------------------------------------------------------------------------ */
module.exports = function makeStops(ctx) {
  const { VEHICLES, VEHICLE_ALIASES, QUOTE_ONLY, HUB_ADDRESS } = ctx;
  const { KM_RATES, MAX_KM } = require("./km-fare");
  const roads = ctx.roads || require("./route-distance")({});
  const MAX_STOPS = 3;
  const last = KM_RATES[KM_RATES.length - 1];
  const PER_KM = KM_RATES[0].map((first, v) => (last[v] - first) / (MAX_KM - 10));
  const r5 = (x) => Math.round(x / 5) * 5;

  /* A stop as sent by the page or the office form. */
  function clean(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, MAX_STOPS).map((s) => {
      if (typeof s === "string") s = { address: s };
      s = s || {};
      const lat = s.lat != null && s.lat !== "" && Number.isFinite(+s.lat) ? +s.lat : null;
      const lng = s.lng != null && s.lng !== "" && Number.isFinite(+s.lng) ? +s.lng : null;
      return { address: String(s.address || s.suburb || "").trim().slice(0, 200), suburb: String(s.suburb || "").trim().slice(0, 120), lat, lng };
    }).filter((s) => s.address.length >= 3);
  }
  /* An end of the trip: a hub by its terminal address, a pick from Google by
     its coordinates, anything else by its name. */
  function wp(name, place) {
    if (HUB_ADDRESS && HUB_ADDRESS[name]) return { address: HUB_ADDRESS[name] };
    if (place && place.lat != null && place.lng != null) return { lat: +place.lat, lng: +place.lng };
    const a = (place && (place.address || place.suburb)) || name;
    return { address: /australia/i.test(a) ? a : a + ", QLD, Australia" };
  }
  const stopWp = (s) => (s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : { address: /australia/i.test(s.address) ? s.address : s.address + ", QLD, Australia" });

  /* {km, legs} for the stops, or {error}. pickup/dropoff are the trip's names;
     pu/dro optionally carry the page's coordinates for those ends. */
  async function measure({ pickup, dropoff, pu, dro, stops }) {
    const list = clean(stops);
    if (!list.length) return { km: 0, stops: [] };
    const A = wp(pickup, pu), B = wp(dropoff, dro);
    const points = [A].concat(list.map(stopWp), [B]);
    const direct = await roads.distance(A, B);
    if (direct.km == null) return { error: "no_distance", reason: direct.reason };
    let via = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const d = await roads.distance(points[i], points[i + 1]);
      if (d.km == null) return { error: "no_distance", reason: d.reason };
      via += d.km;
    }
    const km = Math.max(0, Math.round((via - direct.km) * 10) / 10);
    return { km, stops: list };
  }
  const priceFor = (km, vehicle) => {
    const name = VEHICLE_ALIASES[vehicle] || vehicle;
    if (QUOTE_ONLY.has(name)) return null;
    const vi = VEHICLES.indexOf(name);
    if (vi === -1 || PER_KM[vi] == null) return null;
    return km < 0.5 ? 0 : r5(km * PER_KM[vi]);
  };

  /* For a booking: sets b.stops (cleaned), b.stopsKm and b.stopsExtra, and
     returns true; false when the stops could not be priced. */
  async function applyTo(b) {
    const list = clean(b.stops);
    if (!list.length) { b.stops = undefined; b.stopsExtra = 0; return true; }
    const ends = b.stopsEnds || {};
    const m = await measure({ pickup: b.pickup, dropoff: b.dropoff, pu: ends.pickup, dro: ends.dropoff, stops: list });
    if (m.error) { console.error("stops: no distance (" + m.reason + ") for " + b.pickup + " -> " + b.dropoff); return false; }
    const extra = priceFor(m.km, b.vehicle);
    if (extra == null) return false;
    b.stops = m.stops; b.stopsKm = m.km; b.stopsExtra = extra;
    return true;
  }

  function mount(app) {
    app.post("/stops-quote", async (req, res) => {
      try {
        const q = req.body || {};
        const pu = q.pickup || {}, dro = q.dropoff || {};
        const pickup = String(pu.name || pu.suburb || "").trim(), dropoff = String(dro.name || dro.suburb || "").trim();
        if (!pickup || !dropoff) return res.status(400).json({ error: "Choose the pick-up and drop-off first." });
        if (clean(q.stops).length !== (Array.isArray(q.stops) ? q.stops.filter((s) => s && String(s.address || s.suburb || s).trim()).length : 0)) {
          return res.status(400).json({ error: "Please choose each stop from the suggestions." });
        }
        const m = await measure({ pickup, dropoff, pu, dro, stops: q.stops });
        if (m.error) return res.status(503).json({ error: "We could not measure the route through those stops just now. Send the booking and we will price it, usually within the hour.", reason: m.reason });
        res.json({ km: m.km, stops: m.stops.length, extras: VEHICLES.map((v) => priceFor(m.km, v)) });
      } catch (err) {
        console.error("stops quote:", err);
        res.status(500).json({ error: "We could not price those stops just now." });
      }
    });
  }

  return { MAX_STOPS, PER_KM, clean, measure, priceFor, applyTo, mount };
};
