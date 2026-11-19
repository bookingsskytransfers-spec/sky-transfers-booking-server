/* ---------------------------------------------------------------------------
 * Assistant actions - the things an AI assistant may do for a traveller
 * (stage 1 of the AI assistant, 19 Nov 2026).
 *
 * One set of actions, to be used through two doors that are built after this:
 * the chat on our own site (Claude calls them as tools) and a door for other
 * companies' assistants. Each action is described once, in TOOLS, in the
 * JSON-schema shape both doors need, and run through run(name, input, meta).
 *
 * There is no second set of rules here, and no price table:
 *   - a published fare comes from computeFare, the booking form's own function;
 *   - a distance price comes from this server's own /p2p-quote and /km-quote;
 *   - a booking is lodged through this server's own /request-booking, the
 *     route the "Request booking - pay later" button uses, so the reference,
 *     the emails, the PDF, the two-hour rule and the price are exactly the
 *     website's. Those three are called over the loopback address, like any
 *     browser would call them, so nothing about them had to change.
 *
 * What an assistant can NOT do here: take a payment, see or change a booking,
 * give a price that is not ours, or book inside the notice period. A request
 * lodged here is marked as lodged by an assistant, and the office confirms it
 * by hand like every other request.
 *
 * Aman, 19 Nov 2026: outside assistants may lodge a booking request directly
 * (pay-later only, marked, rate-limited); our own chat starts with answers,
 * quotes and booking links only.
 *
 * Mounted in a try/catch from stripe-server.js. It adds no routes.
 * ------------------------------------------------------------------------ */
module.exports = function installAssist(ctx) {
  const {
    VEHICLES, VEHICLE_ALIASES, HOURLY_RATES, HOURLY_MIN_HOURS, HOURLY_MAX_HOURS,
    computeFare, leadTimeShortfall, MIN_LEAD_HOURS, returnTransfer, RETURN_DISCOUNT,
    CHILD_SEAT_PRICE, TRAILER_PRICE, PLACES, HUBS, base,
  } = ctx;
  const now = ctx.now || (() => Date.now());
  const [OOL, BNE, CRUISE] = HUBS;
  const SITE = "https://www.skytransfers.com.au", PHONE = "+61 481 437 772", EMAIL = "info@skytransfers.com.au";
  const CONTACT = `Call or WhatsApp ${PHONE}, or email ${EMAIL} - answered 24/7.`;
  const BASIS = "Per vehicle (not per person), one way, in Australian dollars, GST and road tolls included. The same fare at any hour of any day.";

  /* Seats and bags by vehicle, index-for-index with VEHICLES. The same figures
     as the booking form and fares.json; the server had no copy until now. */
  const SEATS = [3, 4, 7, 3, 6, 10, 14, 18], BAGS = [2, 4, 6, 2, 6, 11, 15, 18];
  if (VEHICLES.length !== SEATS.length) throw new Error("the vehicle list changed - update SEATS and BAGS in assist-tools.js");
  const MAX_SEATS = Math.max.apply(null, SEATS);

  const txt = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n || 200);
  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  const isHub = (p) => p === OOL || p === BNE || p === CRUISE;
  const kindOf = (p) => (p === CRUISE ? "cruise terminal" : isHub(p) ? "airport" : "suburb");
  const whole = (v) => (/^\d{1,3}$/.test(String(v == null ? "" : v).trim()) ? parseInt(v, 10) : (Number.isInteger(v) ? v : NaN));

  /* ---- places ----------------------------------------------------------- */
  const BY_NORM = new Map(PLACES.map((p) => [norm(p), p]));
  /* What people and assistants call the three hubs and the city. Only ever
     points at a name that is on the list. */
  const ALIAS = {};
  [["Brisbane CBD", ["brisbane city", "brisbane", "brisbane cbd", "brisbane city centre"]],
   [OOL, ["ool", "gold coast airport", "coolangatta airport", "coolangatta gold coast airport", "gold coast coolangatta airport"]],
   [BNE, ["bne", "brisbane airport", "brisbane domestic airport", "brisbane international airport", "brisbane domestic terminal", "brisbane international terminal"]],
   [CRUISE, ["cruise terminal", "brisbane cruise terminal", "brisbane international cruise terminal", "pinkenba cruise terminal", "brisbane cruise port"]],
  ].forEach(([to, names]) => { if (BY_NORM.has(norm(to))) names.forEach((n) => { ALIAS[n] = to; }); });
  const resolve = (v) => { const n = norm(v); return n ? (ALIAS[n] || BY_NORM.get(n) || null) : null; };

  function findPlaces(query, limit) {
    const q = norm(query);
    if (!q) return [];
    const scored = [];
    const seen = new Set();
    const add = (p, s) => { if (!seen.has(p)) { seen.add(p); scored.push([s, p]); } };
    if (ALIAS[q]) add(ALIAS[q], 0);
    Object.keys(ALIAS).forEach((a) => { if (a.indexOf(q) === 0) add(ALIAS[a], 1); });
    PLACES.forEach((p) => {
      const n = norm(p);
      if (n === q) add(p, 0);
      else if (n.indexOf(q) === 0) add(p, 1);
      else if ((" " + n).indexOf(" " + q) !== -1) add(p, 2);
      else if (n.indexOf(q) !== -1) add(p, 3);
    });
    if (!scored.length) {
      const inside = (n) => n.length >= 4 && (" " + q + " ").indexOf(" " + n + " ") !== -1;
      PLACES.forEach((p) => { const n = norm(p); if (inside(n)) add(p, 4 - n.length / 100); });
      Object.keys(ALIAS).forEach((a) => { if (inside(a)) add(ALIAS[a], 4 - a.length / 100); });
    }
    const exact = scored.some((x) => x[0] === 0);
    return scored.filter((x) => !(exact && x[0] === 3)).sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, limit).map((x) => ({ name: x[1], kind: kindOf(x[1]) }));
  }
  const unknownPlace = (which, given) => {
    const near = findPlaces(given, 6);
    return {
      ok: false, reason: "unknown_place", field: which,
      message: `"${txt(given, 80)}" is not one of the places we publish a fare for. ` +
        (near.length ? "Did you mean one of the suggestions? Use the name exactly as given. " : "Use find_places to look for the suburb the address is in. ") +
        "If the place really is not listed, the trip is quoted by hand: " + CONTACT,
      suggestions: near,
    };
  };

  /* ---- vehicles --------------------------------------------------------- */
  const VEH_BY_NORM = new Map();
  VEHICLES.forEach((v, i) => {
    VEH_BY_NORM.set(norm(v), i);
    VEH_BY_NORM.set(norm(v.replace(/^Mercedes /, "")), i);
    const m = /Sprinter (\d+)-Seater/.exec(v);
    if (m) { VEH_BY_NORM.set("sprinter " + m[1], i); VEH_BY_NORM.set("mercedes sprinter " + m[1], i); VEH_BY_NORM.set(m[1] + " seater sprinter", i); }
  });
  Object.keys(VEHICLE_ALIASES || {}).forEach((a) => { const i = VEHICLES.indexOf(VEHICLE_ALIASES[a]); if (i !== -1) VEH_BY_NORM.set(norm(a), i); });
  [["v class", "Luxury Minivan"], ["mercedes v class", "Luxury Minivan"], ["minivan", "Luxury Minivan"]].forEach(([a, v]) => { const i = VEHICLES.indexOf(v); if (i !== -1) VEH_BY_NORM.set(a, i); });
  const vehicleIndex = (v) => { const i = VEH_BY_NORM.get(norm(v)); return i == null ? -1 : i; };

  /* ---- time ------------------------------------------------------------- */
  const BNE_MS = 10 * 3600e3;   // Brisbane is UTC+10 all year
  const pad = (n) => String(n).padStart(2, "0");
  const brisbane = (ms) => { const d = new Date(ms + BNE_MS); return { date: d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()), time: pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) }; };
  function when(date, time) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || "").trim());
    const t = /^(\d{1,2}):(\d{2})$/.exec(String(time || "").trim());
    if (!d) return { error: "date", message: "Give the date as YYYY-MM-DD, for example 2026-12-24." };
    if (!t || +t[1] > 23 || +t[2] > 59) return { error: "time", message: "Give the time on the 24-hour clock as HH:MM, for example 06:30 or 17:45, in Brisbane time." };
    const ms = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
    const back = new Date(ms);
    if (back.getUTCMonth() !== +d[2] - 1 || back.getUTCDate() !== +d[3]) return { error: "date", message: "That date does not exist." };
    return { date: d[0], time: pad(+t[1]) + ":" + t[2], ms: ms - BNE_MS };
  }
  function checkTime(date, time) {
    const w = when(date, time);
    if (w.error) return { ok: false, reason: "bad_" + w.error, message: w.message };
    const hours = (w.ms - now()) / 3600e3;
    const nowB = brisbane(now()), earliest = brisbane(now() + MIN_LEAD_HOURS * 3600e3 + 60e3);
    const out = {
      ok: true, date: w.date, time: w.time, timezone: "Australia/Brisbane (UTC+10 all year, no daylight saving)",
      now_in_brisbane: nowB.date + " " + nowB.time, minimum_notice_hours: MIN_LEAD_HOURS,
      hours_until_pickup: Math.round(hours * 10) / 10,
      earliest_online_pickup: earliest.date + " " + earliest.time,
    };
    if (hours < 0) return Object.assign(out, { bookable_online: false, reason: "in_the_past", message: "That pick-up time has already passed in Brisbane. Check the date and that the time is Brisbane time." });
    if (leadTimeShortfall(w.date, w.time) !== null) {
      return Object.assign(out, { bookable_online: false, reason: "too_soon",
        message: `Online bookings need ${MIN_LEAD_HOURS} hours' notice (Brisbane time). For a pick-up sooner than that the traveller should call ${PHONE} - same-day transfers are taken whenever a vehicle is free.` });
    }
    return Object.assign(out, { bookable_online: true, message: "That pick-up time can be booked online." });
  }

  /* ---- the server's own quote routes, over the loopback address ---------- */
  async function loop(path, body) {
    try {
      const r = await fetch(base() + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
      let j = null; try { j = await r.json(); } catch (e) { /* not JSON */ }
      return { status: r.status, json: j || {} };
    } catch (e) {
      console.error("assistant action: " + path + " did not answer (" + e.message + ")");
      return { status: 0, json: {} };
    }
  }
  const MANUAL = "We could not price that one automatically - it is quoted by hand, usually within the hour. " + CONTACT;
  const fullAddress = (addr, suburb) => {
    const a = txt(addr, 200);
    if (!a) return "";
    return norm(a).indexOf(norm(suburb)) !== -1 ? a : a + ", " + suburb + ", Australia";
  };

  /* The one-way fare for every vehicle, by whichever of the three ways the
     booking form would price this trip. `extra` is what a booking of it has to
     carry so /request-booking measures the same road again. */
  async function priceTrip(pu, dro, puAddr, droAddr) {
    if (pu === dro) return { error: { reason: "same_place", message: "The pick-up and drop-off are the same place." } };
    if (isHub(pu) || isHub(dro)) {
      const fares = VEHICLES.map((v) => computeFare(pu, dro, v));
      if (fares.some((f) => f != null)) return { fares, basis: "published", extra: {} };
      if (isHub(pu) && isHub(dro)) return { error: { reason: "needs_manual_quote", message: MANUAL } };
      /* a listed place with no published fare from this airport: road distance */
      const other = isHub(pu) ? dro : pu;
      const place = { suburb: other, address: fullAddress(isHub(pu) ? droAddr : puAddr, other) };
      const r = await loop("/km-quote", { pickup: pu, dropoff: dro, place });
      if (r.status === 200 && Array.isArray(r.json.fares)) return { fares: r.json.fares, basis: "distance", km: r.json.km, minutes: r.json.minutes, extra: { km: { place } } };
      return { error: { reason: r.json.reason || (r.status ? "needs_manual_quote" : "unavailable"), message: r.status ? (r.json.error ? r.json.error + " " + CONTACT : MANUAL) : "Prices by distance are not available right now. " + CONTACT } };
    }
    const p2p = { pickup: { suburb: pu, address: fullAddress(puAddr, pu) }, dropoff: { suburb: dro, address: fullAddress(droAddr, dro) } };
    const r = await loop("/p2p-quote", p2p);
    if (r.status === 200 && Array.isArray(r.json.fares)) return { fares: r.json.fares, basis: "distance", km: r.json.km, minutes: r.json.minutes, extra: { p2p } };
    return { error: { reason: r.json.reason || (r.status ? "needs_manual_quote" : "unavailable"), message: r.status ? (r.json.error ? r.json.error + " " + CONTACT : MANUAL) : "Prices by distance are not available right now. " + CONTACT } };
  }

  const enc = (s) => encodeURIComponent(s).replace(/%28/g, "(").replace(/%29/g, ")");
  const linkFor = (pu, dro) => SITE + "/?pu=" + enc(pu) + (dro ? "&do=" + enc(dro) : "") + "#book";
  const hourlyLink = (hours, pu) => SITE + "/?hours=" + hours + (pu ? "&pu=" + enc(pu) : "") + "#book";
  const LINK_NOTE = "The link fills in the places only. The traveller chooses the vehicle, the date and the time on the form, and can pay there or request the booking without paying.";

  function pax(v) {
    if (v == null || v === "") return { n: null };
    const n = whole(v);
    if (!Number.isInteger(n) || n < 1) return { error: { ok: false, reason: "bad_passengers", message: "Give the number of passengers as a whole number, 1 or more." } };
    return { n };
  }
  const BIG_GROUP = `More than ${MAX_SEATS} passengers travel in our 53-seat coach or in several vehicles timed together, quoted for the job: ${SITE}/charters.html. ` + CONTACT;

  /* ---- limits ----------------------------------------------------------- */
  /* In memory, like the booking API's. A restart forgets them, which is fine:
     they exist to stop a runaway assistant, not to count anything. */
  const HITS = new Map();
  function allow(key, max, windowMs) {
    const t = now(), h = (HITS.get(key) || []).filter((x) => t - x < windowMs);
    if (h.length >= max) { HITS.set(key, h); return false; }
    h.push(t); HITS.set(key, h);
    if (HITS.size > 5000) for (const k of HITS.keys()) { if (HITS.size <= 2500) break; HITS.delete(k); }
    return true;
  }
  const LODGED = new Map();   // the same request sent twice returns the same booking
  const DAY = 24 * 3600e3, HOUR = 3600e3;
  const BUSY = { ok: false, reason: "rate_limited", message: "Too many requests from this assistant just now. Wait a while and try again, or the traveller can book on " + SITE + " or " + CONTACT };

  /* ---- the actions ------------------------------------------------------ */
  async function quoteTrip(i, meta) {
    const pu = resolve(i.pickup), dro = resolve(i.dropoff);
    if (!pu) return unknownPlace("pickup", i.pickup);
    if (!dro) return unknownPlace("dropoff", i.dropoff);
    const p = pax(i.passengers); if (p.error) return p.error;
    if (p.n > MAX_SEATS) return { ok: false, reason: "group_too_large_for_one_vehicle", message: BIG_GROUP };
    const cs = i.child_seats == null || i.child_seats === "" ? 0 : whole(i.child_seats);
    if (!Number.isInteger(cs) || cs < 0 || cs > 3) return { ok: false, reason: "bad_child_seats", message: "Up to 3 child seats can be booked online; more than that, " + CONTACT };
    const withTrailer = i.trailer === true, isReturnTrip = i.return_trip === true;
    const extrasAud = (cs * CHILD_SEAT_PRICE + (withTrailer ? TRAILER_PRICE : 0)) * (isReturnTrip ? 2 : 1);
    const totalFor = (f) => (isReturnTrip ? returnTransfer(f) : f) + extrasAud;
    const byRoad = !isHub(pu) && !isHub(dro);
    if (byRoad && !allow("q:" + meta.caller, 40, HOUR)) return BUSY;
    const t = await priceTrip(pu, dro, i.pickup_address, i.dropoff_address);
    if (t.error) return Object.assign({ ok: false, pickup: pu, dropoff: dro }, t.error);
    const vehicles = VEHICLES.map((v, k) => {
      const f = t.fares[k];
      const row = { vehicle: v, seats: SEATS[k], bags: BAGS[k], one_way_aud: f == null ? null : f, return_aud: f == null ? null : returnTransfer(f), total_aud: f == null ? null : totalFor(f) };
      if (p.n) row.fits_the_group = SEATS[k] >= p.n;
      if (f == null) row.note = "quoted by hand for this trip";
      return row;
    });
    const best = p.n ? vehicles.filter((r) => r.fits_the_group && r.one_way_aud != null).sort((a, b) => a.one_way_aud - b.one_way_aud)[0] : null;
    const out = {
      ok: true, pickup: pu, dropoff: dro, currency: "AUD", basis: BASIS,
      priced_from: t.basis === "published" ? "the published fare table" : "the measured road distance, snapped to a fixed band",
      vehicles,
      return_trip: `Both legs booked together are ${Math.round(RETURN_DISCOUNT * 100)}% off the pair (return_aud is the total for both legs).`,
      extras: { child_seat_aud_each_per_leg: CHILD_SEAT_PRICE, luggage_trailer_aud_per_leg: TRAILER_PRICE },
      total_aud_is_for: (isReturnTrip ? "both legs of a return trip" : "one way") + (cs ? ", " + cs + " child seat" + (cs > 1 ? "s" : "") : "") + (withTrailer ? ", luggage trailer" : "") + ". This is the figure to tell the traveller and to send as quoted_total_aud.",
      luggage: "fits_the_group counts seats only. Compare the group's bags with each vehicle's bags; a luggage trailer is $" + TRAILER_PRICE + " per leg.",
      booking_link: linkFor(pu, dro),
      book: "The traveller can book on booking_link (the form opens with both places filled in). Online bookings need " + MIN_LEAD_HOURS + " hours' notice.",
    };
    if (t.km != null) { out.road_km = t.km; if (t.minutes != null) out.typical_minutes = t.minutes; }
    if (best) out.smallest_vehicle_that_fits = { vehicle: best.vehicle, one_way_aud: best.one_way_aud, return_aud: best.return_aud, total_aud: best.total_aud };
    else if (p.n) out.note = "No single vehicle with an online price seats " + p.n + ". " + CONTACT;
    return out;
  }

  function quoteHourly(i) {
    const h = whole(i.hours);
    if (!Number.isInteger(h) || h < 1) return { ok: false, reason: "bad_hours", message: "Give the number of hours as a whole number." };
    const p = pax(i.passengers); if (p.error) return p.error;
    if (p.n > MAX_SEATS) return { ok: false, reason: "group_too_large_for_one_vehicle", message: BIG_GROUP };
    if (h < HOURLY_MIN_HOURS) return { ok: false, reason: "under_minimum_hours", message: `Hire by the hour starts at ${HOURLY_MIN_HOURS} hours. For less than that, two one-way transfers are usually the better price - use quote_trip.` };
    if (h > HOURLY_MAX_HOURS) return { ok: false, reason: "charter", message: `More than ${HOURLY_MAX_HOURS} hours is a charter, with half-day and full-day rates quoted for the job: ${SITE}/charters.html. ` + CONTACT };
    let pu = null;
    if (i.pickup != null && i.pickup !== "") { pu = resolve(i.pickup); if (!pu) return unknownPlace("pickup", i.pickup); }
    const vehicles = VEHICLES.map((v, k) => {
      const r = HOURLY_RATES[k];
      const row = { vehicle: v, seats: SEATS[k], bags: BAGS[k], per_hour_aud: r == null ? null : r, total_aud: r == null ? null : r * h };
      if (p.n) row.fits_the_group = SEATS[k] >= p.n;
      if (r == null) row.note = "quoted by hand";
      return row;
    });
    return {
      ok: true, hours: h, currency: "AUD",
      basis: "A chauffeur and vehicle at the traveller's disposal, as directed, per vehicle, GST included. The same rate at any hour.",
      vehicles, booking_link: hourlyLink(h, pu),
      book: "The traveller can book on booking_link, choosing \"By the hour\". Online bookings need " + MIN_LEAD_HOURS + " hours' notice.",
    };
  }

  function bookingLink(i) {
    const pu = resolve(i.pickup);
    if (!pu) return unknownPlace("pickup", i.pickup);
    if (i.hours != null && i.hours !== "") {
      const h = whole(i.hours);
      if (!Number.isInteger(h) || h < HOURLY_MIN_HOURS || h > HOURLY_MAX_HOURS) return { ok: false, reason: "bad_hours", message: `Hire by the hour can be booked online for ${HOURLY_MIN_HOURS} to ${HOURLY_MAX_HOURS} hours.` };
      return { ok: true, booking_link: hourlyLink(h, pu), opens: "the booking form set to " + h + " hours by the hour from " + pu, note: LINK_NOTE };
    }
    let dro = null;
    if (i.dropoff != null && i.dropoff !== "") { dro = resolve(i.dropoff); if (!dro) return unknownPlace("dropoff", i.dropoff); }
    return { ok: true, booking_link: linkFor(pu, dro), opens: "the booking form with " + pu + (dro ? " to " + dro : "") + " filled in", note: LINK_NOTE };
  }

  async function requestBooking(i, meta) {
    const need = (reason, message, field) => ({ ok: false, reason, field, message });
    const assistant = txt(i.assistant, 60).replace(/[^A-Za-z0-9 ._()\-]/g, "").trim();
    if (assistant.length < 2) return need("missing_assistant", "Say which assistant is lodging this (its product name), in \"assistant\".", "assistant");
    if (i.traveller_confirmed !== true) return need("needs_traveller_confirmation", "Lodge a request only after the traveller has seen the price and the details and said yes. Then send traveller_confirmed: true.", "traveller_confirmed");
    const name = txt(i.name, 80), phone = txt(i.phone, 30), email = txt(i.email, 120).toLowerCase();
    if (name.length < 2) return need("missing_name", "The traveller's full name is needed.", "name");
    if ((phone.match(/\d/g) || []).length < 8 || !/^[+0-9 ()\-]+$/.test(phone)) return need("bad_phone", "A phone number the chauffeur can reach the traveller on is needed, with the country code if it is not Australian.", "phone");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return need("bad_email", "The traveller's own email address is needed - the confirmation and the tax invoice go there.", "email");

    const hourly = i.hours != null && i.hours !== "";
    const pu = resolve(i.pickup);
    if (!pu) return unknownPlace("pickup", i.pickup);
    let dro = null, hours = null;
    if (hourly) {
      hours = whole(i.hours);
      if (!Number.isInteger(hours) || hours < HOURLY_MIN_HOURS || hours > HOURLY_MAX_HOURS) return need("bad_hours", `Hire by the hour can be booked online for ${HOURLY_MIN_HOURS} to ${HOURLY_MAX_HOURS} hours. Longer is a charter: ` + CONTACT, "hours");
    } else {
      dro = resolve(i.dropoff);
      if (!dro) return unknownPlace("dropoff", i.dropoff);
    }
    const vi = vehicleIndex(i.vehicle);
    if (vi === -1) return Object.assign(need("unknown_vehicle", "Choose one of our vehicles by name.", "vehicle"), { vehicles: VEHICLES.slice() });
    const p = pax(i.passengers); if (p.error) return p.error;
    if (!p.n) return need("missing_passengers", "The number of passengers is needed.", "passengers");
    if (p.n > SEATS[vi]) return need("too_many_for_vehicle", `The ${VEHICLES[vi]} seats ${SEATS[vi]}. Choose a larger vehicle for ${p.n} passengers` + (p.n > MAX_SEATS ? " - " + BIG_GROUP : "."), "vehicle");

    const tm = checkTime(i.date, i.time);
    if (!tm.ok || !tm.bookable_online) return Object.assign({}, tm, { ok: false });
    const puAddr = txt(i.pickup_address, 300), droAddr = txt(i.dropoff_address, 300);
    if (!isHub(pu) && puAddr.length < 5) return need("missing_address", "The exact pick-up address (street and number, or the hotel's name) is needed for " + pu + ".", "pickup_address");
    if (!hourly && !isHub(dro) && droAddr.length < 5) return need("missing_address", "The exact drop-off address (street and number, or the hotel's name) is needed for " + dro + ".", "dropoff_address");
    const seats = i.child_seats == null || i.child_seats === "" ? 0 : whole(i.child_seats);
    if (!Number.isInteger(seats) || seats < 0 || seats > 3) return need("bad_child_seats", "Up to 3 child seats can be booked online; more than that, " + CONTACT, "child_seats");
    const trailer = i.trailer === true;
    const rDate = txt(i.return_date, 10), rTime = txt(i.return_time, 5);
    let ret = null;
    if (rDate || rTime) {
      if (hourly) return need("no_return_on_hourly", "A hire by the hour has no return leg.", "return_date");
      ret = when(rDate, rTime);
      if (ret.error) return need("bad_return", "Give both a date (YYYY-MM-DD) and a time (HH:MM) for the return trip.", "return_date");
      if (ret.ms <= tm_ms(tm)) return need("bad_return", "The return trip has to be after the outbound one.", "return_date");
      if (leadTimeShortfall(ret.date, ret.time) !== null) return need("too_soon", `The return trip also needs ${MIN_LEAD_HOURS} hours' notice.`, "return_date");
    }

    /* the price, the booking form's way */
    let fare, extra = {};
    if (hourly) {
      const rate = HOURLY_RATES[vi];
      if (rate == null) return need("needs_manual_quote", `The ${VEHICLES[vi]} is quoted by hand for hire by the hour. ` + CONTACT, "vehicle");
      fare = rate * hours;
    } else {
      if (!isHub(pu) && !isHub(dro) && !allow("q:" + meta.caller, 40, HOUR)) return BUSY;
      const t = await priceTrip(pu, dro, puAddr, droAddr);
      if (t.error) return Object.assign({ ok: false }, t.error);
      fare = t.fares[vi];
      if (fare == null) return need("needs_manual_quote", `The ${VEHICLES[vi]} is quoted by hand for this trip. ` + CONTACT, "vehicle");
      extra = t.extra;
    }
    const legs = ret ? 2 : 1;
    const total = (ret ? returnTransfer(fare) : fare) + (seats * CHILD_SEAT_PRICE + (trailer ? TRAILER_PRICE : 0)) * legs;
    if (i.quoted_total_aud != null && i.quoted_total_aud !== "") {
      const quoted = Math.round(Number(i.quoted_total_aud));
      if (!Number.isFinite(quoted) || quoted !== total) {
        return { ok: false, reason: "price_differs", correct_total_aud: total,
          message: `The total for this booking is $${total} AUD, not $${Number.isFinite(quoted) ? quoted : "?"}. Tell the traveller the correct total and ask again before lodging it.` };
      }
    }

    /* the same request twice (assistants retry) is the same booking */
    const key = [email, pu, dro || "hourly" + hours, VEHICLES[vi], tm.date, tm.time, ret ? ret.date + ret.time : ""].join("|");
    const again = LODGED.get(key);
    if (again && now() - again.at < DAY) return Object.assign({}, again.out, { already_lodged: true });
    if (!allow("b:" + meta.caller, 4, HOUR) || !allow("bd:" + meta.caller, 12, DAY) || !allow("be:" + email, 3, DAY) || !allow("ball", 60, DAY)) return BUSY;

    const body = Object.assign({
      pickup: pu, dropoff: hourly ? "As directed" : dro, vehicle: VEHICLES[vi],
      hourly: hourly ? { hours } : undefined,
      date: tm.date, time: tm.time, pax: String(p.n), flight: txt(i.flight, 40),
      childSeats: String(seats), trailer, quotedTotal: total,
      returnDate: ret ? ret.date : "", returnTime: ret ? ret.time : "", returnFlight: ret ? txt(i.return_flight, 40) : "",
      name, phone, email,
      pickupAddress: isHub(pu) ? "" : puAddr, dropoffAddress: hourly || isHub(dro) ? "" : droAddr,
      notes: txt(i.notes, 600),
      userAgent: "AI assistant: " + assistant + (meta.via ? " (" + meta.via + ")" : ""),
      viaAssistant: assistant,
    }, extra);
    const r = await loop("/request-booking", body);
    if (r.status !== 200 || !r.json.ref) {
      return { ok: false, reason: r.status ? "not_accepted" : "unavailable",
        message: (r.json.error ? r.json.error + " " : "The booking request could not be lodged just now. ") + "The traveller can book on " + (hourly ? hourlyLink(hours, pu) : linkFor(pu, dro)) + " or " + CONTACT };
    }
    const out = {
      ok: true, reference: r.json.ref, total_aud: r.json.total, currency: "AUD",
      status: "requested - NOT yet confirmed",
      what_happens_next: "Sky Transfers replies to the traveller's email to confirm, usually within the hour. Nothing has been paid: the traveller then pays by card on a secure link we send, or pays the chauffeur. A confirmation with the details has been emailed to " + email + ", and it says an AI assistant lodged the request for them.",
      tell_the_traveller: "Quote the reference " + r.json.ref + ", say it is a request awaiting our confirmation, and that changes or cancellation are free up to 24 hours before pick-up.",
      contact: CONTACT,
    };
    LODGED.set(key, { at: now(), out });
    if (LODGED.size > 2000) for (const k of LODGED.keys()) { if (LODGED.size <= 1000) break; LODGED.delete(k); }
    console.log("assistant action: booking request " + r.json.ref + " lodged by " + assistant);
    return out;
  }
  const tm_ms = (tm) => when(tm.date, tm.time).ms;

  /* ---- described once, for both doors ----------------------------------- */
  const PLACE = (which) => ({ type: "string", description: `The ${which} place: one of our listed place names exactly (a suburb such as "Surfers Paradise", or "Gold Coast Airport (OOL)", "Brisbane Airport (BNE)", "Brisbane Cruise Terminal (Pinkenba)"). Use find_places first if unsure of the name. Not a street address - that goes in ${which === "pick-up" ? "pickup_address" : "dropoff_address"}.` });
  const TOOLS = [
    { name: "find_places",
      description: "Look up the place names Sky Transfers prices: 420+ suburbs across the Gold Coast, Brisbane, Sunshine Coast, Toowoomba and Byron Bay, the two airports and the Brisbane cruise terminal. Call this first whenever the traveller gives a suburb, hotel area or airport in their own words, then use the returned name exactly in the other actions. A street address or hotel belongs to the suburb it is in.",
      input_schema: { type: "object", properties: { query: { type: "string", description: "A suburb or airport name, or part of one, e.g. \"surfers\", \"brisbane city\", \"OOL\"." }, limit: { type: "integer", minimum: 1, maximum: 20, description: "How many matches to return (default 8)." } }, required: ["query"], additionalProperties: false } },
    { name: "quote_trip",
      description: "The fixed price of a private transfer between two places, for every vehicle we run. Prices are per vehicle, not per person, in AUD, with GST and tolls included, and do not change with the time of day. Airport and cruise-terminal trips come from the published fare table; trips between two suburbs are priced on the road distance. Always quote from this action - never estimate or adjust a price. If it answers ok:false, say what its message says rather than guessing a figure. Give child_seats, trailer and return_trip to get the exact total (total_aud) rather than adding extras up yourself.",
      input_schema: { type: "object", properties: {
        pickup: PLACE("pick-up"), dropoff: PLACE("drop-off"),
        passengers: { type: "integer", minimum: 1, description: "How many people are travelling, to show which vehicles fit." },
        pickup_address: { type: "string", description: "Optional street address or hotel at the pick-up, used only to measure a suburb-to-suburb trip more exactly." },
        dropoff_address: { type: "string", description: "Optional street address or hotel at the drop-off, used the same way." },
        child_seats: { type: "integer", minimum: 0, maximum: 3, description: "Child or baby seats wanted, to include them in total_aud." },
        trailer: { type: "boolean", description: "true to include a luggage trailer in total_aud." },
        return_trip: { type: "boolean", description: "true to make total_aud the price of both legs booked together." },
      }, required: ["pickup", "dropoff"], additionalProperties: false } },
    { name: "quote_hourly_hire",
      description: "The price of a chauffeur and vehicle by the hour, as directed (a night out, a day of meetings, a winery visit), for " + HOURLY_MIN_HOURS + " to " + HOURLY_MAX_HOURS + " hours. Longer hire is a charter and is quoted by the office.",
      input_schema: { type: "object", properties: {
        hours: { type: "integer", minimum: 1, description: "Whole hours wanted." },
        pickup: { type: "string", description: "Optional: the listed place the hire starts from, to pre-fill the booking link." },
        passengers: { type: "integer", minimum: 1, description: "How many people, to show which vehicles fit." },
      }, required: ["hours"], additionalProperties: false } },
    { name: "check_pickup_time",
      description: "Whether a pick-up date and time can still be booked online. Online bookings need " + MIN_LEAD_HOURS + " hours' notice, judged in Brisbane time (UTC+10 all year). Call this before promising a time, and always before request_booking. The answer also gives the current date and time in Brisbane (now_in_brisbane).",
      input_schema: { type: "object", properties: { date: { type: "string", description: "Pick-up date, YYYY-MM-DD." }, time: { type: "string", description: "Pick-up time, 24-hour HH:MM, in Queensland time (UTC+10 all year - the time Brisbane and Gold Coast airports run on). For an airport pick-up give the flight's scheduled arrival time and the flight number; the flight is tracked." } }, required: ["date", "time"], additionalProperties: false } },
    { name: "booking_link",
      description: "A link to our booking form with the places already filled in, for the traveller to finish and pay or request themselves. This is the right way to hand a traveller over when they are ready to book.",
      input_schema: { type: "object", properties: { pickup: PLACE("pick-up"), dropoff: { type: "string", description: "The drop-off place name (leave out for hire by the hour)." }, hours: { type: "integer", description: "For hire by the hour: " + HOURLY_MIN_HOURS + " to " + HOURLY_MAX_HOURS + "." } }, required: ["pickup"], additionalProperties: false } },
    { name: "request_booking",
      description: "Lodge a booking REQUEST for a traveller, with no payment. Use it only after the traveller has seen the exact total from quote_trip (or quote_hourly_hire) and every detail below, and has clearly said yes. It is a request, not a confirmed booking: Sky Transfers confirms by email, usually within the hour, and the traveller pays afterwards by a secure link or to the chauffeur. Never enter or ask for card details. The traveller's own name, phone and email are required - do not invent them. Agree the vehicle with the traveller (smallest_vehicle_that_fits in the quote is the cheapest that seats the group). If the traveller names a price that is not the one we quoted, tell them our total and get their yes again before lodging. A standing instruction with a limit (\"book it if it is under $200\") counts as their yes when our total is within it - say so in notes.",
      input_schema: { type: "object", properties: {
        assistant: { type: "string", description: "The product name of the assistant lodging this (e.g. \"ChatGPT\", \"Claude\"). The office sees it." },
        traveller_confirmed: { type: "boolean", description: "true only when the traveller has agreed to this exact trip and total." },
        pickup: PLACE("pick-up"), dropoff: { type: "string", description: "The drop-off place name (leave out for hire by the hour)." },
        hours: { type: "integer", description: "For hire by the hour instead of a transfer: " + HOURLY_MIN_HOURS + " to " + HOURLY_MAX_HOURS + "." },
        vehicle: { type: "string", description: "The vehicle, by the name quote_trip returned." },
        date: { type: "string", description: "Pick-up date, YYYY-MM-DD." }, time: { type: "string", description: "Pick-up time, 24-hour HH:MM, in Queensland time (UTC+10 all year - the time Brisbane and Gold Coast airports run on). For an airport pick-up give the flight's scheduled arrival time and the flight number; the flight is tracked." },
        passengers: { type: "integer", minimum: 1 },
        name: { type: "string", description: "The traveller's full name." }, phone: { type: "string", description: "The traveller's mobile, with country code if not Australian." }, email: { type: "string", description: "The traveller's own email." },
        pickup_address: { type: "string", description: "Street and number or hotel name at the pick-up. Required unless the pick-up is an airport or the cruise terminal." },
        dropoff_address: { type: "string", description: "Street and number or hotel name at the drop-off. Required unless the drop-off is an airport or the cruise terminal." },
        flight: { type: "string", description: "Flight number for an airport pick-up, so the flight is tracked." },
        child_seats: { type: "integer", minimum: 0, maximum: 3, description: "Child or baby seats, $" + CHILD_SEAT_PRICE + " each per leg." },
        trailer: { type: "boolean", description: "Luggage trailer, $" + TRAILER_PRICE + " per leg." },
        return_date: { type: "string", description: "For a return trip: the return date, YYYY-MM-DD." }, return_time: { type: "string", description: "The return pick-up time, HH:MM." }, return_flight: { type: "string" },
        notes: { type: "string", description: "Anything the chauffeur should know: bags, surfboards, the children's ages for child seats, how the traveller will pay." },
        quoted_total_aud: { type: "number", description: "Always send this: the total_aud the traveller agreed to. If it is not our total, nothing is lodged and the correct total is returned." },
      }, required: ["assistant", "traveller_confirmed", "pickup", "vehicle", "date", "time", "passengers", "name", "phone", "email"], additionalProperties: false } },
  ];

  const ACTIONS = {
    find_places: (i) => { const lim = Math.min(Math.max(whole(i.limit) || 8, 1), 20); const m = findPlaces(i.query, lim); return { ok: true, matches: m, note: m.length ? "Use a name exactly as written here." : "Nothing matched. This looks up suburbs and airports, not hotels or street addresses - search for the suburb the address is in. A suburb we do not list is quoted by hand: " + CONTACT }; },
    quote_trip: quoteTrip,
    quote_hourly_hire: quoteHourly,
    check_pickup_time: (i) => checkTime(i.date, i.time),
    booking_link: bookingLink,
    request_booking: requestBooking,
  };

  /* Never throws: an assistant gets an answer it can read out either way. */
  async function run(name, input, meta) {
    const fn = ACTIONS[name];
    if (!fn) return { ok: false, reason: "unknown_action", message: "There is no action called " + txt(name, 40) + ".", actions: TOOLS.map((t) => t.name) };
    const m = { caller: txt(meta && meta.caller, 80) || "internal", via: txt(meta && meta.via, 30) };
    try {
      if (!allow("a:" + m.caller, 240, HOUR)) return BUSY;
      return await fn(input && typeof input === "object" ? input : {}, m);
    } catch (e) {
      console.error("assistant action " + name + ":", e);
      return { ok: false, reason: "error", message: "That did not work just now. " + CONTACT };
    }
  }

  console.log("Assistant actions ready: " + TOOLS.map((t) => t.name).join(", "));
  return { on: true, TOOLS, run };
};
