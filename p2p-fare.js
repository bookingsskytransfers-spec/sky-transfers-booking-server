/* ---------------------------------------------------------------------------
 * Point-to-point fares: neither end is an airport.
 *
 * computeFare() in stripe-server.js prices a leg by looking a suburb up in a
 * zone table, which works because one end is always a hub. Between two
 * ordinary addresses there is no table to look in: 421 localities make about
 * 88,000 ordered pairs, so the price has to be computed instead of stored.
 *
 * It is computed from road distance and then SNAPPED TO A BAND, which is the
 * whole point. A metered price drifts with traffic and the chosen route, so
 * the same trip quoted twice gives two numbers; a banded price does not. The
 * customer is told one figure and that figure holds - the same promise
 * fares.json already makes for airport work ("Surge: None. The same fare
 * applies at any hour, including nights, weekends and public holidays").
 * There is deliberately no time-of-day loading anywhere in this file.
 *
 * The ladders below are not invented. They are the medians of the published
 * airport fares at each distance, so a point-to-point price sits on the same
 * curve the business already charges. Brisbane runs $10-20 dearer than the
 * Gold Coast at matched distance in the existing tables, so it keeps its own
 * ladder rather than being averaged into one.
 *
 * This module holds no suburb data of its own. The zone tables are passed in
 * from stripe-server.js, so there is exactly one copy of them on the server
 * and nothing to keep in sync. Distance comes from the caller, which is the
 * only part needing a paid API - that call stays server-side.
 * ------------------------------------------------------------------------ */

/* Sedan price by road distance, [maxKm, price]. The first row whose maxKm the
   trip is within wins. Past the last row there is no fixed fare. */
const LADDERS = {
  /* Gold Coast. The short end rests on very little evidence: OOL sits down at
     Coolangatta, so the published table holds only a handful of Gold Coast
     legs under 15 km, while most night-out work is 3-10 km through the middle
     of the Coast. Worth revisiting once real bookings exist. */
  gc:  [[8, 80], [15, 85], [20, 95], [30, 110], [40, 125], [50, 145], [65, 165], [85, 225]],
  /* Brisbane, including Logan, Ipswich, Redlands and the bay. */
  bne: [[15, 85], [20, 105], [30, 125], [40, 140], [50, 155], [65, 185], [85, 225]],
};

/* Past this there is no banded price and dispatch quotes the job by hand. The
   ladders stop here too; the constant exists so the caller can say why. */
const MAX_KM = 85;

/* What each class costs over the Sedan. The published tables price a class as
   a near-constant number of dollars rather than a percentage: the SUV is +$10
   to +$15 whether the trip is 1 km or 110 km, while its multiplier swings from
   1.06x to 1.87x. Flat dollars is therefore the honest model.
   Indexed to match VEHICLES, so this order must not be rearranged. */
const CLASS_ADDER = [
  0,    // Sedan
  15,   // SUV
  25,   // People Mover
  35,   // Luxury Sedan
  45,   // Luxury Minivan
  135,  // Mercedes Sprinter 10-Seater
  195,  // Mercedes Sprinter 14-Seater
];

/* Slow or remote ground, where distance alone underprices the job. These are
   zones the rate tables already define rather than a new list to maintain:
   Gold Coast zone H is the hinterland (Tamborine, Springbrook, Natural Bridge
   and the like) and the Brisbane zones are the far west past Ipswich and the
   Bribie corridor. One flat loading, because what costs money is the slow
   road, not the extra kilometre. */
const OUTER_LOADING = 25;
const GC_OUTER_ZONES = new Set(["H"]);
const BM_OUTER_ZONES = new Set(["BW4", "BW5", "BN3", "BN4"]);

module.exports = function makeP2PFare(tables) {
  const {
    VEHICLES, VEHICLE_ALIASES, QUOTE_ONLY,
    SUBURBS, BM_SUBURB, LD_SUBURB, HUB_NAMES,
  } = tables;

  const hubs = new Set(HUB_NAMES);

  /* Which ladder a trip is on. A trip that straddles the two cities takes
     Brisbane's, the dearer of the two at every band to 65 km - erring towards
     the higher price is the safe direction when a job spans both. */
  function regionOf(a, b) {
    /* Sunshine Coast, Toowoomba and Byron are long-haul runs on their own
       hand-set rates. They do not belong on a metropolitan ladder. */
    if (LD_SUBURB[a] || LD_SUBURB[b]) return null;
    if (BM_SUBURB[a] || BM_SUBURB[b]) return "bne";
    if (SUBURBS[a] && SUBURBS[b]) return "gc";
    return null; // at least one end is somewhere we hold no zone for
  }

  function outerLoading(a, b) {
    for (const s of [a, b]) {
      if (SUBURBS[s] && GC_OUTER_ZONES.has(SUBURBS[s][0])) return OUTER_LOADING;
      if (BM_SUBURB[s] && BM_OUTER_ZONES.has(BM_SUBURB[s])) return OUTER_LOADING;
    }
    return 0;
  }

  /* Returns { fare, reason, ... }. fare is a whole number of AUD, or null when
     there is no fixed price and the job has to be quoted by hand. reason is
     always set when fare is null, so the caller can say something useful
     rather than fail blankly. */
  function quote({ pickupSuburb, dropoffSuburb, km, vehicle }) {
    const name = (VEHICLE_ALIASES && VEHICLE_ALIASES[vehicle]) || vehicle;
    if (QUOTE_ONLY.has(name)) return { fare: null, reason: "vehicle_quoted_by_hand" };
    const vi = VEHICLES.indexOf(name);
    if (vi === -1) return { fare: null, reason: "unknown_vehicle" };
    const adder = CLASS_ADDER[vi];
    if (adder == null) return { fare: null, reason: "vehicle_has_no_band_price" };

    const a = String(pickupSuburb == null ? "" : pickupSuburb).trim();
    const b = String(dropoffSuburb == null ? "" : dropoffSuburb).trim();
    if (!a || !b) return { fare: null, reason: "missing_endpoint" };
    if (a === b) return { fare: null, reason: "same_place" };

    /* An airport or the cruise terminal at either end makes this an airport
       transfer, and it must price from the published table, never from here.
       Without this a hinterland run to a street beside the terminal would come
       out cheaper than the same run to the terminal itself, and the published
       suburb pages would show customers the difference. The caller is expected
       to resolve a coordinate within a few km of a terminal to that hub name,
       since this check can only see the name it is given. */
    if (hubs.has(a) || hubs.has(b)) return { fare: null, reason: "airport_leg_use_computeFare" };

    const region = regionOf(a, b);
    if (!region) return { fare: null, reason: "outside_banded_area" };

    const d = Number(km);
    if (!Number.isFinite(d) || d <= 0) return { fare: null, reason: "no_distance" };
    /* One decimal place, matching how fares.json records distance, so which
       band a trip lands in never turns on floating point noise. */
    const dist = Math.round(d * 10) / 10;
    if (dist > MAX_KM) return { fare: null, reason: "over_max_km" };

    const row = LADDERS[region].find(([max]) => dist <= max);
    if (!row) return { fare: null, reason: "over_max_km" };

    const loading = outerLoading(a, b);
    return {
      fare: row[1] + adder + loading,
      reason: null,
      region, band: row[0], base: row[1], adder, loading, km: dist,
    };
  }

  /* The same answer shaped like computeFare, for callers wanting just a number. */
  const fare = (args) => quote(args).fare;

  return { quote, fare, LADDERS, CLASS_ADDER, MAX_KM, OUTER_LOADING };
};

module.exports.LADDERS = LADDERS;
module.exports.CLASS_ADDER = CLASS_ADDER;
module.exports.MAX_KM = MAX_KM;
module.exports.OUTER_LOADING = OUTER_LOADING;
