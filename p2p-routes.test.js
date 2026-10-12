/* ---------------------------------------------------------------------------
 * Tests for p2p-routes.js.   Run:  node p2p-routes.test.js
 *
 * No express and no network: a stub app collects the handlers, a stub
 * route-distance gives whatever answer the case needs, and the zone tables
 * come out of stripe-server.js the same way the fare engine's tests take them.
 *
 * The thing most worth proving here is the order of operations. A trip that
 * cannot be priced must be refused BEFORE a Routes call is spent on it -
 * otherwise every bot poking the endpoint costs real money.
 * ------------------------------------------------------------------------ */
const fs = require("fs");
const path = require("path");
const install = require("./p2p-routes.js");

const SRC = fs.readFileSync(path.join(__dirname, "stripe-server.js"), "utf8");
const table = (name) => JSON.parse(new RegExp("^const " + name + " = (\\{.*\\});\\s*$", "m").exec(SRC)[1]);
const SUBURBS = table("SUBURBS");
const BM_ZONE = table("BM_ZONE"), LD_ZONE = table("LD_ZONE");
const BM_SUBURB = {}; for (const z of Object.keys(BM_ZONE)) for (const s of BM_ZONE[z]) BM_SUBURB[s] = z;
const LD_SUBURB = {}; for (const z of Object.keys(LD_ZONE)) for (const s of LD_ZONE[z]) LD_SUBURB[s] = z;
const VEHICLES = ["Sedan", "SUV", "People Mover", "Luxury Sedan", "Luxury Minivan",
  "Mercedes Sprinter 10-Seater", "Mercedes Sprinter 14-Seater", "Mercedes Sprinter 18-Seater"];
const OOL = "Gold Coast Airport (OOL)", BNE = "Brisbane Airport (BNE)",
      CRUISE = "Brisbane Cruise Terminal (Pinkenba)";

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) pass++; else { fail++; console.log("  FAIL: " + w); } };
const eq = (g, w, what) => ok(g === w, what + "  (got " + JSON.stringify(g) + ", wanted " + JSON.stringify(w) + ")");
const section = (t) => console.log("\n== " + t + " ==");

/* A stub express app that just remembers what was mounted. */
function stubApp() {
  const routes = {};
  const add = (method) => (p, ...rest) => {
    routes[method + " " + p] = { handler: rest[rest.length - 1], middleware: rest.slice(0, -1) };
  };
  return { post: add("POST"), get: add("GET"), routes };
}
/* A stub response that captures what the handler sent. */
function stubRes() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
/* A stub route-distance returning a fixed answer, counting its calls. */
function stubRoads(answer, enabled) {
  const s = { calls: 0, enabled: enabled !== false };
  s.distance = async () => { s.calls++; return answer; };
  return s;
}

function mount(roads, withAdmin) {
  const app = stubApp();
  const api = install({
    app, roads,
    requireAdmin: withAdmin ? (req, res, next) => next() : undefined,
    VEHICLES,
    VEHICLE_ALIASES: { "Mercedes Sprinter 15-Seater": "Mercedes Sprinter 14-Seater", "Mini Coach 18-Seater": "Mercedes Sprinter 18-Seater" },
    QUOTE_ONLY: new Set(["Mercedes Sprinter 18-Seater"]),
    SUBURBS, BM_SUBURB, LD_SUBURB, HUB_NAMES: [OOL, BNE, CRUISE],
  });
  return { app, api };
}
const call = async (app, route, body) => {
  const res = stubRes();
  await app.routes[route].handler({ body }, res);
  return res;
};
const GC = { lat: -28.0330, lng: 153.4300, suburb: "Broadbeach" };
const SP = { lat: -27.9990, lng: 153.4290, suburb: "Surfers Paradise" };

(async () => {
  section("it mounts");
  {
    const { app } = mount(stubRoads({ km: 4.2, minutes: 8 }), true);
    ok(app.routes["POST /p2p-quote"], "the quote endpoint is mounted");
    ok(app.routes["GET /admin/p2p-selftest"], "the self-test is mounted when requireAdmin is given");
    eq(app.routes["GET /admin/p2p-selftest"].middleware.length, 1, "and it is behind that middleware");
  }
  {
    const { app } = mount(stubRoads({ km: 4.2 }), false);
    ok(app.routes["POST /p2p-quote"], "the quote endpoint mounts without an admin guard");
    ok(!app.routes["GET /admin/p2p-selftest"], "but the self-test is NOT mounted unguarded");
  }

  section("a normal quote");
  {
    const roads = stubRoads({ km: 4.2, minutes: 8 });
    const { app } = mount(roads, true);
    const r = await call(app, "POST /p2p-quote", { pickup: GC, dropoff: SP, vehicle: "Sedan" });
    eq(r.code, 200, "it answers 200");
    eq(r.body.fare, 80, "a 4.2 km Gold Coast trip is the $80 floor");
    eq(r.body.km, 4.2, "it reports the distance");
    eq(r.body.minutes, 8, "and the duration");
    eq(r.body.returnTotal, 144, "the return total applies the same 10% as the airport form");
    eq(roads.calls, 1, "it spent exactly one Routes call");
    ok(!("reason" in r.body), "a success carries no reason");
    ok(typeof r.body.basis === "string" && /any hour/.test(r.body.basis), "it states the no-surge basis");
  }
  {
    const roads = stubRoads({ km: 12.4, minutes: 18 });
    const { app } = mount(roads, true);
    const r = await call(app, "POST /p2p-quote", {
      pickup: { lat: -27.47, lng: 153.02, suburb: "Brisbane CBD" },
      dropoff: { lat: -27.38, lng: 153.03, suburb: "Chermside" }, vehicle: "SUV" });
    eq(r.body.fare, 100, "12.4 km in Brisbane in an SUV is 85 + 15");
  }

  section("no vehicle named: the whole ladder for the vehicle grid");
  {
    const roads = stubRoads({ km: 4.2, minutes: 8 });
    const { app } = mount(roads, true);
    const r = await call(app, "POST /p2p-quote", { pickup: GC, dropoff: SP });
    eq(r.code, 200, "it answers 200");
    ok(Array.isArray(r.body.fares) && r.body.fares.length === VEHICLES.length, "one entry per vehicle, in VEHICLES order");
    eq(r.body.fares[0], 80, "Sedan is the $80 floor");
    eq(r.body.fares[1], 95, "SUV is 80 + 15");
    eq(r.body.fares[6], 275, "Sprinter 14 is 80 + 195");
    eq(r.body.fares[7], null, "the 18-seater is null - quoted by hand");
    eq(r.body.km, 4.2, "distance comes back too");
    eq(roads.calls, 1, "one Routes call prices all seven");
    ok(!("fare" in r.body), "no single fare when none was asked for");
  }
  {
    const roads = stubRoads({ km: 4.2 });
    const { app } = mount(roads, true);
    const r = await call(app, "POST /p2p-quote", { pickup: { ...GC, suburb: OOL }, dropoff: SP });
    eq(r.code, 422, "an airport end is still refused with no vehicle named");
    eq(roads.calls, 0, "and spends nothing");
  }
  {
    /* A suburb picked from the form's own list arrives with no coordinates. */
    const seen = [];
    const roads = { enabled: true, distance: async (a, b) => { seen.push([a, b]); return { km: 4.2, minutes: 8 }; } };
    const { app } = mount(roads, true);
    const r = await call(app, "POST /p2p-quote", { pickup: { suburb: "Broadbeach", address: "Broadbeach, QLD, Australia" }, dropoff: SP });
    eq(r.code, 200, "an address-only pickup is priced");
    eq(seen[0][0].address, "Broadbeach, QLD, Australia", "the address is what the distance lookup gets");
    ok(!("lat" in seen[0][0]), "and no made-up coordinates");
    eq(seen[0][1].lat, SP.lat, "the coordinate end is passed as coordinates");
  }

  section("fareFor: the price checkout recomputes before charging");
  {
    const roads = stubRoads({ km: 12.4, minutes: 18 });
    const { api } = mount(roads, true);
    ok(typeof api.fareFor === "function", "fareFor is exported");
    const b = { vehicle: "SUV", p2p: { pickup: { lat: -27.47, lng: 153.02, suburb: "Brisbane CBD" }, dropoff: { lat: -27.38, lng: 153.03, suburb: "Chermside" } } };
    eq(await api.fareFor(b), 100, "12.4 km in Brisbane in an SUV is 85 + 15, same as the quote");
    eq(await api.fareFor({ vehicle: "Sedan" }), null, "no p2p block means null - the caller falls back to computeFare");
    eq(await api.fareFor({ vehicle: "Sedan", p2p: { pickup: GC } }), null, "a missing dropoff is null");
    eq(await api.fareFor({ vehicle: "Mercedes Sprinter 18-Seater", p2p: b.p2p }), null, "the 18-seater is null");
    eq(await api.fareFor({ vehicle: "Sedan", p2p: { pickup: { ...GC, suburb: OOL }, dropoff: SP } }), null, "an airport end is null");
    const before = roads.calls;
    await api.fareFor({ vehicle: "Sedan", p2p: { pickup: { ...GC, suburb: OOL }, dropoff: SP } });
    eq(roads.calls, before, "and a refusal costs no Routes call");
    const dead = { enabled: true, distance: async () => ({ km: null, reason: "timeout" }) };
    const { api: api2 } = mount(dead, true);
    eq(await api2.fareFor(b), null, "a distance failure is null, never a guessed price");
  }

  section("the money-saving bit: refuse before paying for a distance");
  for (const [body, why] of [
    [{ pickup: { ...GC, suburb: OOL }, dropoff: SP, vehicle: "Sedan" }, "an airport pick-up"],
    [{ pickup: GC, dropoff: { ...SP, suburb: BNE }, vehicle: "Sedan" }, "an airport drop-off"],
    [{ pickup: GC, dropoff: { ...SP, suburb: CRUISE }, vehicle: "Sedan" }, "the cruise terminal"],
    [{ pickup: GC, dropoff: SP, vehicle: "Mercedes Sprinter 18-Seater" }, "the 18-seater"],
    [{ pickup: GC, dropoff: SP, vehicle: "Hovercraft" }, "a vehicle that does not exist"],
    [{ pickup: { ...GC, suburb: "Noosa Heads" }, dropoff: SP, vehicle: "Sedan" }, "a long-haul region"],
    [{ pickup: { ...GC, suburb: "Nowhereville" }, dropoff: SP, vehicle: "Sedan" }, "an unknown suburb"],
    [{ pickup: GC, dropoff: { ...SP, suburb: "Broadbeach" }, vehicle: "Sedan" }, "the same suburb both ends"],
  ]) {
    const roads = stubRoads({ km: 4.2, minutes: 8 });
    const { app } = mount(roads, true);
    const r = await call(app, "POST /p2p-quote", body);
    eq(r.code, 422, why + " is refused with 422");
    eq(roads.calls, 0, why + " costs no Routes call");
    ok(typeof r.body.error === "string" && r.body.error.length > 10, why + " gets a sentence a customer can read");
    ok(!/computeFare|null|undefined|_/.test(r.body.error.replace(/[.,]/g, "")) || /airport/.test(r.body.error),
      why + " does not leak an internal reason string into the customer message");
  }

  section("missing addresses never reach Google either");
  for (const [body, why] of [
    [{ dropoff: SP, vehicle: "Sedan" }, "no pickup"],
    [{ pickup: GC, vehicle: "Sedan" }, "no dropoff"],
    [{ pickup: { lat: -28, lng: 153 }, dropoff: SP, vehicle: "Sedan" }, "a pickup with no suburb matched"],
    [{}, "an empty body"],
  ]) {
    const roads = stubRoads({ km: 4.2 });
    const { app } = mount(roads, true);
    const r = await call(app, "POST /p2p-quote", body);
    eq(r.code, 400, why + " is a 400");
    eq(roads.calls, 0, why + " costs no Routes call");
    ok(/suggestions/.test(r.body.error), why + " tells them to pick from the suggestions");
  }
  {
    const { app } = mount(stubRoads({ km: 4.2 }), true);
    const res = stubRes();
    await app.routes["POST /p2p-quote"].handler({}, res);   // no body at all
    eq(res.code, 400, "a request with no body at all is a 400, not a crash");
  }

  section("when Google cannot answer");
  for (const reason of ["no_key", "http_403", "timeout", "network", "no_route", "bad_response", "bad_coordinates"]) {
    const { app } = mount(stubRoads({ km: null, reason }), true);
    const r = await call(app, "POST /p2p-quote", { pickup: GC, dropoff: SP, vehicle: "Sedan" });
    eq(r.code, 503, reason + " gives a 503, not a wrong price");
    eq(r.body.fare, undefined, reason + " never returns a fare");
    ok(/quote it/.test(r.body.error), reason + " offers a manual quote instead");
    eq(r.body.reason, reason, reason + " is reported for our own logs");
  }

  section("a distance past the ladder");
  {
    const { app } = mount(stubRoads({ km: 120, minutes: 90 }), true);
    const r = await call(app, "POST /p2p-quote", { pickup: GC, dropoff: SP, vehicle: "Sedan" });
    eq(r.code, 422, "a 120 km trip is refused");
    ok(/longer than we price online/.test(r.body.error), "and says so in words");
    eq(r.body.reason, "over_max_km", "with the reason for us");
  }

  section("the self-test");
  {
    const { app } = mount(stubRoads({ km: 4.2, minutes: 8, cached: false }), true);
    const r = await call(app, "GET /admin/p2p-selftest", {});
    eq(r.body.km, 4.2, "it reports the distance");
    eq(r.body.fare, 80, "and the fare, so the whole chain is proven");
    eq(r.body.keyConfigured, true, "and whether a key is configured");
    eq(r.body.hint, "Working.", "with a plain-words verdict");
    ok(typeof r.body.tookMs === "number", "and how long Google took");
  }
  for (const [reason, needle] of [
    ["no_key", "GOOGLE_ROUTES_KEY is not set"],
    ["http_403", "outbound IPs"],
    ["timeout", "did not answer in time"],
    ["http_400", "check the server log"],
    ["no_route", "server log"],
  ]) {
    const { app } = mount(stubRoads({ km: null, reason }, false), true);
    const r = await call(app, "GET /admin/p2p-selftest", {});
    eq(r.body.km, null, reason + " reports no distance");
    eq(r.body.reason, reason, reason + " is named");
    ok(r.body.hint.includes(needle), reason + " hints at the actual fix (" + r.body.hint.slice(0, 40) + "…)");
  }

  section("a handler that throws is still a clean 500");
  {
    const app = stubApp();
    install({
      app, roads: { enabled: true, distance: async () => { throw new Error("boom"); } },
      VEHICLES, VEHICLE_ALIASES: {}, QUOTE_ONLY: new Set(["Mercedes Sprinter 18-Seater"]),
      SUBURBS, BM_SUBURB, LD_SUBURB, HUB_NAMES: [OOL, BNE, CRUISE],
    });
    const r = await call(app, "POST /p2p-quote", { pickup: GC, dropoff: SP, vehicle: "Sedan" });
    eq(r.code, 500, "an unexpected throw is a 500");
    ok(!/boom/.test(r.body.error), "and the internal message is not shown to the customer");
  }

  console.log("\n" + (fail === 0 ? "ALL PASS" : "FAILURES") + ": " + pass + " passed, " + fail + " failed");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("the suite itself threw:", e); process.exit(1); });
