/* ---------------------------------------------------------------------------
 * Airport transfers to places the zone tables do not price: road distance to
 * the airport, priced from km-fare.js. The quote endpoint for the page, and
 * fareFor() for /request-booking and /create-checkout, which measure again
 * rather than trust a price from the browser.
 *
 * When it applies: exactly one end is an airport or the cruise terminal, and
 * computeFare has no fare for the trip - the other end is not on the suburb
 * list, or it is but has no fare from that hub. If computeFare does have a
 * fare, this refuses, so the published table can never be undercut by asking
 * for the distance price instead.
 *
 * Trust model, the same as point-to-point: the page sends the address it
 * resolved through Google with its coordinates, and the server measures the
 * road from those. A place that is not on our list must come with
 * coordinates; a listed place without a fare from this hub may come as its
 * name alone, which Google geocodes. Dispatch sees the exact address, and the
 * office email says "Priced by distance" on every booking priced this way.
 *
 * Mounted in a try/catch from stripe-server.js like p2p-routes.js: if it
 * throws on boot, one line is logged and the zone-priced bookings carry on.
 * ------------------------------------------------------------------------ */
module.exports = function installKm(ctx) {
  const {
    app, VEHICLES, VEHICLE_ALIASES, QUOTE_ONLY, computeFare,
    SUBURBS, BM_SUBURB, LD_SUBURB, OOL, BNE, CRUISE, CRUISE_EXTRA,
  } = ctx;
  const { kmFare, MAX_KM } = require("./km-fare");
  const roads = ctx.roads || require("./route-distance")({});

  /* Named places, which Google geocodes reliably: the passenger terminals,
     not the airport suburbs, so the distance is to the kerb we pull up at. */
  const HUB_ADDRESS = {
    [OOL]: "Gold Coast Airport terminal, Eastern Ave, Bilinga QLD 4225, Australia",
    [BNE]: "Brisbane Airport Domestic Terminal, Brisbane Airport QLD 4008, Australia",
    [CRUISE]: "Brisbane International Cruise Terminal, Pinkenba QLD 4008, Australia",
  };
  const isHub = (p) => Object.prototype.hasOwnProperty.call(HUB_ADDRESS, p);
  const listed = (p) => !!(SUBURBS[p] || BM_SUBURB[p] || LD_SUBURB[p]);

  const SPOKEN = {
    over_max_km: `That address is more than ${MAX_KM} km from the airport, which is longer than we price online. Send us the booking and we will quote it, usually within the hour.`,
    vehicle_quoted_by_hand: "The 18-seater is priced for each job. Send us the details and we will come back with a fixed quote.",
    listed: "That place has a fixed published fare - please choose it from the list.",
    need_address: "Please choose the address from the suggestions so we can measure the trip.",
    not_airport: "This price is for trips to or from an airport or the cruise terminal.",
  };
  const FALLBACK = "We could not price that one automatically. Send us the details and we will quote it, usually within the hour.";
  const NO_DISTANCE = "We could not work out the distance just now. Send us the details and we will quote it, usually within the hour.";

  const place = (p) => ({
    lat: p && Number.isFinite(+p.lat) && p.lat !== "" && p.lat != null ? +p.lat : null,
    lng: p && Number.isFinite(+p.lng) && p.lng !== "" && p.lng != null ? +p.lng : null,
    suburb: String((p && p.suburb) || "").trim().slice(0, 120),
    address: String((p && p.address) || "").trim().slice(0, 200),
  });
  const waypoint = (pl) => (pl.lat != null && pl.lng != null ? { lat: pl.lat, lng: pl.lng } : { address: pl.address || pl.suburb + ", QLD, Australia" });

  /* Everything that can be refused without spending a Routes call. */
  function check(pickup, dropoff, pl) {
    if (isHub(pickup) === isHub(dropoff)) return { reason: "not_airport" };
    const hub = isHub(pickup) ? pickup : dropoff, other = isHub(pickup) ? dropoff : pickup;
    if (!other || other !== pl.suburb) return { reason: "need_address" };
    if (computeFare(other, hub, "Sedan") != null) return { reason: "listed" };
    if (!listed(other) && (pl.lat == null || pl.lng == null)) return { reason: "need_address" };
    return { hub, other, fromHub: isHub(pickup) };
  }
  async function measure(c, pl) {
    const hubWp = { address: HUB_ADDRESS[c.hub] };
    return c.fromHub ? roads.distance(hubWp, waypoint(pl)) : roads.distance(waypoint(pl), hubWp);
  }
  const fareAt = (km, hub, vehicle) => {
    const name = VEHICLE_ALIASES[vehicle] || vehicle;
    if (QUOTE_ONLY.has(name)) return null;
    const vi = VEHICLES.indexOf(name);
    if (vi === -1) return null;
    const f = kmFare(km, vi);
    return f == null ? null : f + (hub === CRUISE ? CRUISE_EXTRA : 0);
  };

  /* The page sends {pickup, dropoff, place}; no vehicle gives the whole row. */
  app.post("/km-quote", async (req, res) => {
    try {
      const b = req.body || {};
      const pickup = String(b.pickup || "").trim(), dropoff = String(b.dropoff || "").trim();
      const pl = place(b.place);
      const c = check(pickup, dropoff, pl);
      if (c.reason) return res.status(422).json({ error: SPOKEN[c.reason] || FALLBACK, reason: c.reason });
      const road = await measure(c, pl);
      if (road.km == null) {
        console.error("km quote: no distance (" + road.reason + ") for " + c.other + " <-> " + c.hub);
        return res.status(503).json({ error: NO_DISTANCE, reason: road.reason });
      }
      if (road.km > MAX_KM) return res.status(422).json({ error: SPOKEN.over_max_km, reason: "over_max_km", km: road.km });
      res.json({
        km: road.km, minutes: road.minutes, hub: c.hub, place: c.other,
        fares: VEHICLES.map((v) => fareAt(road.km, c.hub, v)),
        vehicles: VEHICLES.slice(),
        basis: "Per vehicle, one way, GST and road tolls included. Priced on the road distance to the airport - the same fare at any hour.",
      });
    } catch (err) {
      console.error("km quote:", err);
      res.status(500).json({ error: FALLBACK });
    }
  });

  /* The one-way fare for a booking that carries b.km = { place }, or null.
     The measured distance is left on the booking as b.kmRoad so the office
     email can show it. Cached by route-distance.js, so the second measure for
     a booking already quoted costs nothing. */
  async function fareFor(b) {
    const k = b && b.km;
    if (!k || typeof k !== "object") return null;
    const pl = place(k.place);
    const c = check(String(b.pickup || "").trim(), String(b.dropoff || "").trim(), pl);
    if (c.reason) return null;
    const road = await measure(c, pl);
    if (road.km == null) {
      console.error("km fare: no distance (" + road.reason + ") for " + c.other + " <-> " + c.hub);
      return null;
    }
    const f = fareAt(road.km, c.hub, b.vehicle);
    if (f != null) b.kmRoad = Math.round(road.km);
    return f;
  }

  console.log("km fares: quote endpoint ready (to " + MAX_KM + " km)" + (roads.enabled ? "" : " (distance OFF - set GOOGLE_ROUTES_KEY)"));
  return { on: true, fareFor, hubAddress: HUB_ADDRESS };
};
