/* ---------------------------------------------------------------------------
 * The point-to-point quote endpoint, and a self-test for the Google key.
 *
 * Joins the two halves: route-distance.js finds the road distance, p2p-fare.js
 * turns it into a banded fixed price. Neither knows about HTTP; this file is
 * the only part that does.
 *
 * Mounted in a try/catch from stripe-server.js, like blog-feed.js, so if it
 * throws on boot one line is logged and the site carries on taking bookings.
 * It adds no middleware of its own - stripe-server.js already parses JSON
 * globally - and it touches nothing on the payment path.
 *
 * Trust model, worth being explicit about: the browser sends the two places it
 * resolved through Google Places, each with coordinates and the priced suburb
 * that suburbFromComponents() matched. The server does not take a price from
 * the browser - it recomputes the distance from those coordinates and prices
 * it here. A customer could still nominate a different suburb than they mean,
 * but that is the same trust the airport booking form already places in the
 * suburb a customer picks, and dispatch sees the real address either way.
 *
 * What this file does NOT do yet: /create-checkout still has to recompute the
 * fare before charging, exactly as it does with computeFare today. A quote
 * from here is a quote, not a price anyone can pay.
 * ------------------------------------------------------------------------ */
module.exports = function installP2P(ctx) {
  const {
    app, requireAdmin,
    VEHICLES, VEHICLE_ALIASES, QUOTE_ONLY,
    SUBURBS, BM_SUBURB, LD_SUBURB, HUB_NAMES,
  } = ctx;

  const fares = require("./p2p-fare")({
    VEHICLES, VEHICLE_ALIASES, QUOTE_ONLY,
    SUBURBS, BM_SUBURB, LD_SUBURB, HUB_NAMES,
  });
  /* Injectable so the tests can drive every answer Google can give without a
     key and without the network. */
  const roads = ctx.roads || require("./route-distance")({});

  /* Why a quote could not be given, in words a customer should see. Anything
     not listed here falls back to the generic line: these strings end up in
     front of people, so a reason we did not anticipate must not leak out. */
  const SPOKEN = {
    over_max_km: "That trip is longer than we price online — send it to us and we will quote it, usually within the hour.",
    outside_banded_area: "One of those addresses is outside the area we price online. Send us the details and we will quote it by hand.",
    airport_leg_use_computeFare: "That is an airport transfer — please use the airport booking form, which has a fixed published fare.",
    vehicle_quoted_by_hand: "The 18-seater is priced for each job. Send us the details and we will come back with a fixed quote.",
    same_place: "The pick-up and drop-off look like the same place.",
  };
  const FALLBACK = "We could not price that one automatically. Send us the details and we will quote it, usually within the hour.";

  /* Distance failures are ours, not the customer's, and they all mean the same
     thing from the outside: ask us. They are separated in the log, not here. */
  const NO_DISTANCE = "We could not work out the distance just now. Send us the details and we will quote it, usually within the hour.";

  const place = (p) => ({
    lat: p && p.lat, lng: p && p.lng,
    suburb: String((p && (p.suburb || p.locality)) || "").trim(),
    address: String((p && p.address) || "").trim(),
  });

  app.post("/p2p-quote", async (req, res) => {
    try {
      const b = req.body || {};
      const from = place(b.pickup), to = place(b.dropoff);
      const vehicle = String(b.vehicle || "").trim();

      if (!from.suburb || !to.suburb) {
        return res.status(400).json({ error: "Please choose both addresses from the suggestions so we can price the trip." });
      }

      /* Price the trip before spending a Routes call on it. Everything that
         can be refused from the names alone - an airport at either end, the
         18-seater, an unknown vehicle, a region we do not band - is refused
         here for nothing. The distance is only worth buying once the trip is
         one we could actually price. */
      const dry = fares.quote({ pickupSuburb: from.suburb, dropoffSuburb: to.suburb, km: 1, vehicle });
      if (dry.fare == null && dry.reason !== "no_distance") {
        return res.status(422).json({ error: SPOKEN[dry.reason] || FALLBACK, reason: dry.reason });
      }

      const road = await roads.distance(from, to);
      if (road.km == null) {
        console.error("p2p quote: no distance (" + road.reason + ") for " +
          from.suburb + " -> " + to.suburb);
        return res.status(503).json({ error: NO_DISTANCE, reason: road.reason });
      }

      const q = fares.quote({ pickupSuburb: from.suburb, dropoffSuburb: to.suburb, km: road.km, vehicle });
      if (q.fare == null) {
        return res.status(422).json({ error: SPOKEN[q.reason] || FALLBACK, reason: q.reason });
      }

      res.json({
        fare: q.fare,
        km: road.km,
        minutes: road.minutes,
        vehicle,
        pickup: from.suburb,
        dropoff: to.suburb,
        /* The same 10% the airport form gives, applied by the caller that
           builds the booking - published here so the page can show it. */
        returnTotal: Math.round(q.fare * 2 * 0.9),
        basis: "Per vehicle, one way, GST and road tolls included. The same fare at any hour.",
      });
    } catch (err) {
      console.error("p2p quote:", err);
      res.status(500).json({ error: FALLBACK });
    }
  });

  /* ---- self-test ---------------------------------------------------------
     Admin only. Runs one real lookup end to end so the Google key, its IP
     restriction, the Routes API and billing can all be confirmed in a single
     request - rather than discovering which of the four is wrong by watching
     the booking form misbehave. Uses a fixed, short, well-known pair. */
  if (typeof requireAdmin === "function") {
    app.get("/admin/p2p-selftest", requireAdmin, async (req, res) => {
      const from = { lat: -28.0330, lng: 153.4300, suburb: "Broadbeach" };
      const to   = { lat: -27.9990, lng: 153.4290, suburb: "Surfers Paradise" };
      const started = Date.now();
      const road = await roads.distance(from, to);
      const ms = Date.now() - started;
      const q = road.km == null ? null
        : fares.quote({ pickupSuburb: from.suburb, dropoffSuburb: to.suburb, km: road.km, vehicle: "Sedan" });
      res.json({
        keyConfigured: roads.enabled,
        trip: "Broadbeach -> Surfers Paradise, Sedan",
        km: road.km,
        minutes: road.minutes,
        cached: road.cached === true,
        reason: road.reason || null,
        fare: q ? q.fare : null,
        tookMs: ms,
        /* What to do about the most common answers, so the result is
           actionable without going back to the documentation. */
        hint: road.km != null ? "Working."
          : road.reason === "no_key" ? "GOOGLE_ROUTES_KEY is not set on this service."
          : road.reason === "http_403" ? "The key is refused: it is probably restricted to HTTP referrers rather than this service's outbound IPs, or the Routes API is not enabled on the project."
          : road.reason === "http_400" ? "Google rejected the request itself - the key may be fine; check the server log."
          : road.reason === "timeout" ? "Google did not answer in time. Try again; if it persists the service may have no outbound route."
          : "See the server log for the full error.",
      });
    });
  }

  console.log("p2p: quote endpoint ready" +
    (roads.enabled ? "" : " (distance OFF — set GOOGLE_ROUTES_KEY)"));
  return { on: true, distanceEnabled: roads.enabled };
};
