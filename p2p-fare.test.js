/* ---------------------------------------------------------------------------
 * Tests for p2p-fare.js.   Run:  node p2p-fare.test.js
 *
 * No test framework and no dependencies, so this runs anywhere node does,
 * including on a box with nothing installed. Exits non-zero on failure.
 *
 * The zone tables are read out of stripe-server.js as text rather than copied
 * in here. Copying them would mean the tests could pass against data the
 * server no longer uses, which is the exact failure the two repositories have
 * already had once with the airport fares.
 * ------------------------------------------------------------------------ */
const fs = require("fs");
const path = require("path");
const makeP2PFare = require("./p2p-fare.js");

const SRC = fs.readFileSync(path.join(__dirname, "stripe-server.js"), "utf8");

/* Each of these is declared as a single-line `const NAME = {...};` literal at
   the top of stripe-server.js. Pulling them out by name keeps the tests honest
   without having to load the server, which would start listening on a port. */
function table(name) {
  const m = new RegExp("^const " + name + " = (\\{.*\\});\\s*$", "m").exec(SRC);
  if (!m) throw new Error("could not find table " + name + " in stripe-server.js");
  return JSON.parse(m[1]);
}
function arrayOf(name) {
  const m = new RegExp("^const " + name + " = (\\[[\\s\\S]*?\\]);", "m").exec(SRC);
  if (!m) throw new Error("could not find array " + name + " in stripe-server.js");
  return JSON.parse(m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/,\s*\]$/, "]"));
}

const SUBURBS = table("SUBURBS");
const BM_ZONE = table("BM_ZONE");
const LD_ZONE = table("LD_ZONE");
const BM_SUBURB = {}; for (const z of Object.keys(BM_ZONE)) for (const s of BM_ZONE[z]) BM_SUBURB[s] = z;
const LD_SUBURB = {}; for (const z of Object.keys(LD_ZONE)) for (const s of LD_ZONE[z]) LD_SUBURB[s] = z;
const VEHICLES = arrayOf("VEHICLES");

const OOL = "Gold Coast Airport (OOL)";
const BNE = "Brisbane Airport (BNE)";
const CRUISE = "Brisbane Cruise Terminal (Pinkenba)";

const p2p = makeP2PFare({
  VEHICLES,
  VEHICLE_ALIASES: {
    "Mercedes Sprinter 15-Seater": "Mercedes Sprinter 14-Seater",
    "Mini Coach 18-Seater": "Mercedes Sprinter 18-Seater",
  },
  QUOTE_ONLY: new Set(["Mercedes Sprinter 18-Seater"]),
  SUBURBS, BM_SUBURB, LD_SUBURB,
  HUB_NAMES: [OOL, BNE, CRUISE],
});

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; } else { fail++; console.log("  FAIL: " + what); } };
const eq = (got, want, what) =>
  ok(got === want, what + "  (got " + JSON.stringify(got) + ", wanted " + JSON.stringify(want) + ")");
const section = (t) => console.log("\n== " + t + " ==");

/* ---------------------------------------------------------------- the basics */
section("prices a plain trip");
eq(p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Surfers Paradise", km: 4.2, vehicle: "Sedan" }), 80,
  "4.2 km Broadbeach -> Surfers, Sedan = the $80 floor");
eq(p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Surfers Paradise", km: 4.2, vehicle: "SUV" }), 95,
  "same trip in an SUV = 80 + 15");
eq(p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Surfers Paradise", km: 4.2, vehicle: "Mercedes Sprinter 14-Seater" }), 275,
  "same trip in the Sprinter 14 = 80 + 195");
eq(p2p.fare({ pickupSuburb: "Brisbane CBD", dropoffSuburb: "Bulimba", km: 6, vehicle: "Sedan" }), 85,
  "6 km inside Brisbane = the Brisbane floor of 85, not 80");

section("direction makes no difference");
for (const [a, b, km] of [["Southport", "Robina", 22.5], ["Brisbane CBD", "Chermside", 12], ["Nerang", "Burleigh Heads", 18]]) {
  for (const v of VEHICLES.slice(0, 7)) {
    const there = p2p.fare({ pickupSuburb: a, dropoffSuburb: b, km, vehicle: v });
    const back = p2p.fare({ pickupSuburb: b, dropoffSuburb: a, km, vehicle: v });
    ok(there === back, a + " <-> " + b + " in a " + v + " prices the same both ways");
  }
}

section("band edges");
eq(p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Robina", km: 8, vehicle: "Sedan" }), 80, "exactly 8 km is still the first band");
eq(p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Robina", km: 8.1, vehicle: "Sedan" }), 85, "8.1 km moves up a band");
eq(p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Robina", km: 8.04, vehicle: "Sedan" }), 80, "8.04 km rounds to 8.0 and stays put");
eq(p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Robina", km: 8.05, vehicle: "Sedan" }), 85, "8.05 km rounds to 8.1 and moves up");
eq(p2p.fare({ pickupSuburb: "Southport", dropoffSuburb: "Robina", km: 85, vehicle: "Sedan" }), 225, "85 km is the last priced band");
eq(p2p.fare({ pickupSuburb: "Southport", dropoffSuburb: "Robina", km: 85.1, vehicle: "Sedan" }), null, "past 85 km there is no fixed fare");
eq(p2p.quote({ pickupSuburb: "Southport", dropoffSuburb: "Robina", km: 120, vehicle: "Sedan" }).reason, "over_max_km",
  "and it says why");

section("the ladder only ever goes up with distance");
for (const region of ["gc", "bne"]) {
  const rungs = p2p.LADDERS[region].map(([, price]) => price);
  for (let i = 1; i < rungs.length; i++) {
    ok(rungs[i] >= rungs[i - 1], region + " ladder does not go backwards at band " + i);
  }
}

/* ------------------------------------------------- airports must not get in */
section("an airport at either end is refused");
const hubCases = [
  [OOL, "Broadbeach"], ["Broadbeach", OOL],
  [BNE, "Brisbane CBD"], ["Brisbane CBD", BNE],
  [CRUISE, "Brisbane CBD"], ["Brisbane CBD", CRUISE],
  [OOL, BNE], [BNE, CRUISE],
];
for (const [a, b] of hubCases) {
  const q = p2p.quote({ pickupSuburb: a, dropoffSuburb: b, km: 30, vehicle: "Sedan" });
  eq(q.fare, null, a + " -> " + b + " is not priced here");
  eq(q.reason, "airport_leg_use_computeFare", a + " -> " + b + " says to use computeFare");
}
/* The undercut this guard exists to stop. Tamborine -> BNE is $530 in the
   Sprinter 14 from the published table; the band price for 80 km is $420. */
eq(p2p.fare({ pickupSuburb: "Tamborine Mountain", dropoffSuburb: BNE, km: 79.8, vehicle: "Mercedes Sprinter 14-Seater" }), null,
  "the hinterland-to-airport undercut cannot be bought here");

/* ------------------------------------------------------------- the vehicles */
section("vehicles");
eq(p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", km: 20, vehicle: "Mercedes Sprinter 18-Seater" }), null,
  "the 18-seater is never given a computed fare");
eq(p2p.quote({ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", km: 20, vehicle: "Mercedes Sprinter 18-Seater" }).reason,
  "vehicle_quoted_by_hand", "and it says the 18-seater is quoted by hand");
eq(p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", km: 20, vehicle: "Mini Coach 18-Seater" }), null,
  "the retired Mini Coach name also lands on the 18-seater and is refused");
eq(p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", km: 20, vehicle: "Mercedes Sprinter 15-Seater" }),
  p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", km: 20, vehicle: "Mercedes Sprinter 14-Seater" }),
  "the retired 15-Seater name prices as the 14-Seater");
eq(p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", km: 20, vehicle: "Limousine" }), null,
  "a vehicle that does not exist is refused");
eq(p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", km: 20, vehicle: "" }), null,
  "so is an empty vehicle");
ok(p2p.CLASS_ADDER.length === VEHICLES.length - 1,
  "there is one class adder per priceable vehicle (" + p2p.CLASS_ADDER.length + " adders, " + VEHICLES.length + " vehicles incl. the quote-only one)");

/* ----------------------------------------------------------------- the edges */
section("rubbish in");
for (const [args, why] of [
  [{ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", km: 0, vehicle: "Sedan" }, "zero distance"],
  [{ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", km: -5, vehicle: "Sedan" }, "negative distance"],
  [{ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", km: NaN, vehicle: "Sedan" }, "NaN distance"],
  [{ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", vehicle: "Sedan" }, "missing distance"],
  [{ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", km: "abc", vehicle: "Sedan" }, "non-numeric distance"],
  [{ pickupSuburb: "", dropoffSuburb: "Southport", km: 10, vehicle: "Sedan" }, "empty pickup"],
  [{ pickupSuburb: "Broadbeach", dropoffSuburb: null, km: 10, vehicle: "Sedan" }, "null dropoff"],
  [{ pickupSuburb: "Broadbeach", dropoffSuburb: "Broadbeach", km: 3, vehicle: "Sedan" }, "same place both ends"],
  [{ pickupSuburb: "Nowhereville", dropoffSuburb: "Southport", km: 10, vehicle: "Sedan" }, "a suburb we hold no zone for"],
  [{ pickupSuburb: "Noosa Heads", dropoffSuburb: "Southport", km: 60, vehicle: "Sedan" }, "a long-haul region (Noosa)"],
  [{ pickupSuburb: "Toowoomba", dropoffSuburb: "Brisbane CBD", km: 80, vehicle: "Sedan" }, "a long-haul region (Toowoomba)"],
  [{ pickupSuburb: "Byron Bay", dropoffSuburb: "Broadbeach", km: 80, vehicle: "Sedan" }, "a long-haul region (Byron)"],
]) {
  const q = p2p.quote(args);
  eq(q.fare, null, why + " is refused");
  ok(typeof q.reason === "string" && q.reason.length > 0, why + " comes with a reason");
}
ok(p2p.quote({}).fare === null, "an empty request is refused rather than throwing");
eq(p2p.fare({ pickupSuburb: "  Broadbeach  ", dropoffSuburb: "Southport", km: 20, vehicle: "Sedan" }),
  p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", km: 20, vehicle: "Sedan" }),
  "surrounding whitespace on a suburb name does not change the price");

/* -------------------------------------------------------------- the regions */
section("which ladder applies");
eq(p2p.quote({ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", km: 18, vehicle: "Sedan" }).region, "gc",
  "both ends on the Coast uses the Gold Coast ladder");
eq(p2p.quote({ pickupSuburb: "Brisbane CBD", dropoffSuburb: "Bulimba", km: 18, vehicle: "Sedan" }).region, "bne",
  "both ends in Brisbane uses the Brisbane ladder");
eq(p2p.quote({ pickupSuburb: "Southport", dropoffSuburb: "Beenleigh", km: 40, vehicle: "Sedan" }).region, "bne",
  "a trip straddling the two cities takes Brisbane's dearer ladder");
ok(p2p.fare({ pickupSuburb: "Brisbane CBD", dropoffSuburb: "Bulimba", km: 18, vehicle: "Sedan" }) >
   p2p.fare({ pickupSuburb: "Broadbeach", dropoffSuburb: "Southport", km: 18, vehicle: "Sedan" }),
  "at matched distance Brisbane is dearer than the Gold Coast, as the published tables are");

section("the hinterland loading");
const flat = p2p.quote({ pickupSuburb: "Nerang", dropoffSuburb: "Southport", km: 20, vehicle: "Sedan" });
const hill = p2p.quote({ pickupSuburb: "Tamborine Mountain", dropoffSuburb: "Nerang", km: 20, vehicle: "Sedan" });
eq(flat.loading, 0, "an ordinary Gold Coast trip carries no loading");
eq(hill.loading, p2p.OUTER_LOADING, "a hinterland trip carries the loading");
eq(hill.fare - flat.fare, p2p.OUTER_LOADING, "and the loading is the only difference at equal distance");
for (const s of ["Springbrook", "Natural Bridge", "Numinbah Valley", "Beechmont", "Advancetown"]) {
  eq(p2p.quote({ pickupSuburb: s, dropoffSuburb: "Nerang", km: 25, vehicle: "Sedan" }).loading, p2p.OUTER_LOADING,
    s + " is treated as hinterland");
}
for (const s of ["Ipswich", "Rosewood", "Caboolture", "Bongaree"]) {
  eq(p2p.quote({ pickupSuburb: s, dropoffSuburb: "Brisbane CBD", km: 45, vehicle: "Sedan" }).loading, p2p.OUTER_LOADING,
    s + " is treated as outer Brisbane");
}
eq(p2p.quote({ pickupSuburb: "Chermside", dropoffSuburb: "Brisbane CBD", km: 12, vehicle: "Sedan" }).loading, 0,
  "an inner Brisbane suburb carries no loading");
eq(p2p.quote({ pickupSuburb: "Tamborine Mountain", dropoffSuburb: "Springbrook", km: 30, vehicle: "Sedan" }).loading,
  p2p.OUTER_LOADING, "hinterland at both ends is still charged the loading once, not twice");

/* --------------------------------------------------- the arithmetic is sane */
section("every priceable combination holds together");
const suburbPairs = [
  ["Broadbeach", "Southport"], ["Nerang", "Robina"], ["Brisbane CBD", "Chermside"],
  ["Bulimba", "Sunnybank"], ["Southport", "Beenleigh"], ["Tamborine Mountain", "Nerang"],
];
const distances = [1, 3.5, 8, 8.1, 12, 15, 15.1, 19, 20, 24, 30, 31, 39, 40, 48, 50, 60, 65, 70, 85];
let checked = 0;
for (const [a, b] of suburbPairs) {
  for (const km of distances) {
    let prevFare = null;
    for (let i = 0; i < 7; i++) {
      const v = VEHICLES[i];
      const q = p2p.quote({ pickupSuburb: a, dropoffSuburb: b, km, vehicle: v });
      if (q.fare == null) continue;
      checked++;
      ok(Number.isInteger(q.fare), "the fare is a whole number of dollars (" + a + "->" + b + " " + km + "km " + v + ")");
      ok(q.fare > 0, "the fare is positive");
      ok(q.fare === q.base + q.adder + q.loading, "fare = base + class adder + loading");
      if (prevFare != null) ok(q.fare > prevFare, "a bigger vehicle never costs less (" + v + " at " + km + "km)");
      prevFare = q.fare;
    }
  }
}
ok(checked > 700, "the sweep actually checked a useful number of combinations (" + checked + ")");

/* A longer trip never costs less than a shorter one in the same vehicle. */
for (const [a, b] of suburbPairs) {
  for (const v of VEHICLES.slice(0, 7)) {
    let last = null;
    for (const km of distances) {
      const f = p2p.fare({ pickupSuburb: a, dropoffSuburb: b, km, vehicle: v });
      if (f == null) continue;
      if (last != null) ok(f >= last, "further is never cheaper (" + a + "->" + b + ", " + v + ", " + km + "km)");
      last = f;
    }
  }
}

/* ------------------------------------------------------ the published curve */
section("the ladder sits on the published airport curve");
/* Cross-check only. Airport legs never price here - the guard above refuses
   them - but if the bands sat well below the published fares at matched
   distance, the business would be quoting point-to-point work under what it
   already charges to drive the same road. fares.json is fetched when it is
   available; the check is skipped offline rather than failing the suite. */
const faresPath = path.join(__dirname, "fares.json");
if (fs.existsSync(faresPath)) {
  const f = JSON.parse(fs.readFileSync(faresPath, "utf8"));
  let n = 0, under = 0, worst = 0, worstAt = null, sum = 0;
  for (const d of f.destinations || []) {
    for (const leg of ["ool", "bne"]) {
      const km = d.km && d.km[leg], fa = d.fares && d.fares[leg];
      if (!km || !fa || km > p2p.MAX_KM) continue;
      /* Price it as though it were an ordinary trip, by naming a second
         suburb in the same region instead of the hub. */
      const partner = SUBURBS[d.name] ? "Nerang" : BM_SUBURB[d.name] ? "Brisbane CBD" : null;
      if (!partner || partner === d.name) continue;
      for (let i = 0; i < 7; i++) {
        const band = p2p.fare({ pickupSuburb: d.name, dropoffSuburb: partner, km, vehicle: VEHICLES[i] });
        if (band == null) continue;
        n++;
        const diff = band - fa[i];
        sum += diff;
        if (diff < 0) { under++; if (diff < worst) { worst = diff; worstAt = d.name + " " + leg + " " + km + "km " + VEHICLES[i] + ": published $" + fa[i] + ", band $" + band; } }
      }
    }
  }
  console.log("  compared " + n + " published legs against the band price");
  console.log("  band price below the published fare: " + under + " (" + (100 * under / n).toFixed(1) + "%)");
  console.log("  mean difference: $" + (sum / n).toFixed(1));
  if (worstAt) console.log("  furthest below: $" + Math.abs(worst) + "  " + worstAt);
  ok(sum / n > 0, "on average the band price is at or above the published airport fare");
  ok(100 * under / n < 25, "fewer than a quarter of legs come out under the published fare");
} else {
  /* fares.json is generated by the website repo, so it is not checked in here.
     To run this cross-check:
       curl -O https://www.skytransfers.com.au/fares.json                     */
  console.log("  (skipped - no fares.json beside the tests; see the note in the source)");
}

console.log("\n" + (fail === 0 ? "ALL PASS" : "FAILURES") + ": " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
