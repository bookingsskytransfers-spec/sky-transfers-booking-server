/* ---------------------------------------------------------------------------
 * Tests for route-distance.js.   Run:  node route-distance.test.js
 *
 * Nothing here touches the network or needs a key: fetch is injected, so every
 * path including the timeout and the 403 is exercised against a stub. That
 * matters more than usual - the live failures this module has to survive are
 * exactly the ones that are awkward to reproduce on purpose.
 * ------------------------------------------------------------------------ */
const makeRouteDistance = require("./route-distance.js");

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; } else { fail++; console.log("  FAIL: " + what); } };
const eq = (got, want, what) =>
  ok(got === want, what + "  (got " + JSON.stringify(got) + ", wanted " + JSON.stringify(want) + ")");
const section = (t) => console.log("\n== " + t + " ==");

const GC = { lat: -28.0330, lng: 153.4300 };   // Broadbeach
const SP = { lat: -27.9990, lng: 153.4290 };   // Surfers Paradise

/* A stub standing in for Google. Records what it was asked. */
function stub(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    if (typeof reply === "function") return reply(calls.length);
    return reply;
  };
  return { fetchImpl, calls };
}
const okReply = (metres, durationSecs) => ({
  ok: true, status: 200,
  json: async () => ({ routes: [{ distanceMeters: metres, duration: durationSecs + "s" }] }),
});

/* --------------------------------------------------------------- the happy path */
section("a normal lookup");
(async () => {
  const s = stub(okReply(4210, 480));
  const rd = makeRouteDistance({ key: "test-key", fetchImpl: s.fetchImpl });
  const r = await rd.distance(GC, SP);
  eq(r.km, 4.2, "4210 m comes back as 4.2 km");
  eq(r.minutes, 8, "480 s comes back as 8 minutes");
  eq(r.cached, false, "the first call is not from cache");
  eq(r.reason, undefined, "a success carries no reason");
  eq(s.calls.length, 1, "it made exactly one request");

  const sent = s.calls[0].body;
  eq(sent.travelMode, "DRIVE", "it asks for driving");
  eq(sent.routingPreference, "TRAFFIC_UNAWARE", "routing is traffic-unaware, so the answer does not move through the day");
  eq(sent.units, "METRIC", "metric units");
  eq(sent.regionCode, "AU", "region AU");
  eq(sent.origin.location.latLng.latitude, GC.lat, "origin latitude is passed through");
  eq(sent.destination.location.latLng.longitude, SP.lng, "destination longitude is passed through");
  const hdr = s.calls[0].init.headers;
  eq(hdr["X-Goog-Api-Key"], "test-key", "the key goes in the header, not the URL");
  eq(hdr["X-Goog-FieldMask"], "routes.distanceMeters,routes.duration",
    "the field mask asks for only distance and duration, keeping it on the cheapest tier");
  ok(!String(s.calls[0].url).includes("test-key"), "the key never appears in the URL");

  eq(rd.enabled, true, "it reports itself enabled when a key is present");

  /* ----------------------------------------------------------------- caching */
  section("caching");
  const r2 = await rd.distance(GC, SP);
  eq(r2.cached, true, "the same trip comes from cache");
  eq(r2.km, 4.2, "and gives the same distance");
  eq(s.calls.length, 1, "with no second request");

  const r3 = await rd.distance({ lat: GC.lat + 0.0001, lng: GC.lng }, SP);
  eq(r3.cached, true, "a 10 m difference rounds onto the same cache key");
  eq(s.calls.length, 1, "still one request");

  const r4 = await rd.distance({ lat: GC.lat + 0.01, lng: GC.lng }, SP);
  eq(r4.cached, false, "a 1 km difference is a different trip");
  eq(s.calls.length, 2, "so it asks again");

  /* Reversing the trip is a separate cache entry. Road distance is not always
     symmetric - one-way streets and the M1 ramps - so it must not be assumed. */
  const r5 = await rd.distance(SP, GC);
  eq(r5.cached, false, "the reverse direction is looked up separately, not assumed symmetric");

  section("cache eviction and expiry");
  let clock = 1000;
  const s2 = stub(okReply(1000, 60));
  const rd2 = makeRouteDistance({ key: "k", fetchImpl: s2.fetchImpl, cacheMax: 3, now: () => clock });
  for (let i = 0; i < 5; i++) await rd2.distance({ lat: -28 - i / 100, lng: 153 }, SP);
  ok(rd2.cacheSize() <= 3, "the cache honours cacheMax (" + rd2.cacheSize() + " <= 3)");

  const s3 = stub(okReply(2000, 120));
  const rd3 = makeRouteDistance({ key: "k", fetchImpl: s3.fetchImpl, cacheTtlMs: 100, now: () => clock });
  await rd3.distance(GC, SP);
  eq((await rd3.distance(GC, SP)).cached, true, "inside the TTL it is cached");
  clock += 101;
  eq((await rd3.distance(GC, SP)).cached, false, "past the TTL it is looked up again");

  /* ------------------------------------------------------------- the failures */
  section("every failure comes back as km:null with a reason, never a throw");

  const noKey = makeRouteDistance({ key: "", fetchImpl: stub(okReply(1, 1)).fetchImpl });
  const nk = await noKey.distance(GC, SP);
  eq(nk.km, null, "with no key there is no distance");
  eq(nk.reason, "no_key", "and the reason is no_key");
  eq(noKey.enabled, false, "it reports itself disabled");

  const forbidden = makeRouteDistance({ key: "k", fetchImpl: stub({ ok: false, status: 403 }).fetchImpl });
  const fb = await forbidden.distance(GC, SP);
  eq(fb.km, null, "a 403 yields no distance");
  eq(fb.reason, "http_403", "and names the status");

  for (const status of [400, 429, 500, 503]) {
    const r = await makeRouteDistance({ key: "k", fetchImpl: stub({ ok: false, status }).fetchImpl }).distance(GC, SP);
    eq(r.reason, "http_" + status, "HTTP " + status + " is reported as such");
  }

  const empty = makeRouteDistance({ key: "k", fetchImpl: stub({ ok: true, status: 200, json: async () => ({ routes: [] }) }).fetchImpl });
  eq((await empty.distance(GC, SP)).reason, "no_route", "an empty routes array is no_route");

  const noRoutes = makeRouteDistance({ key: "k", fetchImpl: stub({ ok: true, status: 200, json: async () => ({}) }).fetchImpl });
  eq((await noRoutes.distance(GC, SP)).reason, "no_route", "a response with no routes key is no_route");

  const zero = makeRouteDistance({ key: "k", fetchImpl: stub(okReply(0, 0)).fetchImpl });
  eq((await zero.distance(GC, SP)).reason, "no_route", "zero metres is treated as no route");

  const junk = makeRouteDistance({ key: "k", fetchImpl: stub({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }).fetchImpl });
  eq((await junk.distance(GC, SP)).reason, "bad_response", "unparseable JSON is bad_response");

  const broken = makeRouteDistance({ key: "k", fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  eq((await broken.distance(GC, SP)).reason, "network", "a dead socket is network");

  /* A real abort, not a simulated one: the stub never resolves, so the
     AbortController inside the module is what ends the call. */
  const hang = makeRouteDistance({
    key: "k", timeoutMs: 40,
    fetchImpl: (url, init) => new Promise((_res, rej) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("aborted"); e.name = "AbortError"; rej(e);
      });
    }),
  });
  const t0 = Date.now();
  const to = await hang.distance(GC, SP);
  eq(to.km, null, "a request that never answers yields no distance");
  eq(to.reason, "timeout", "and the reason is timeout");
  ok(Date.now() - t0 < 1500, "and it gave up quickly rather than holding the booking (" + (Date.now() - t0) + " ms)");

  const missing = makeRouteDistance({ key: "k", fetchImpl: stub({ ok: true, status: 200, json: async () => ({ routes: [{ distanceMeters: 5000 }] }) }).fetchImpl });
  const md = await missing.distance(GC, SP);
  eq(md.km, 5, "a missing duration still gives a distance");
  eq(md.minutes, null, "with minutes reported as null rather than guessed");

  section("bad coordinates are refused before any request is made");
  const guard = stub(okReply(1000, 60));
  const rdg = makeRouteDistance({ key: "k", fetchImpl: guard.fetchImpl });
  for (const [a, b, why] of [
    [null, SP, "null origin"],
    [GC, null, "null destination"],
    [{}, SP, "origin with no fields"],
    [{ lat: 999, lng: 153 }, SP, "latitude out of range"],
    [{ lat: -28, lng: 999 }, SP, "longitude out of range"],
    [{ lat: "abc", lng: 153 }, SP, "non-numeric latitude"],
    [{ lat: NaN, lng: 153 }, SP, "NaN latitude"],
    /* Number(null) is 0, which is a real latitude, so without an explicit
       check a dropped coordinate becomes a point off west Africa and gets
       priced as a trip. */
    [GC, { lat: null, lng: null }, "null coordinates on the destination"],
    [{ lat: null, lng: null }, SP, "null coordinates on the origin"],
    [{ lat: "", lng: "" }, SP, "empty-string coordinates"],
    [{ lat: false, lng: false }, SP, "boolean coordinates"],
    [{ lat: 0, lng: 0 }, SP, "exactly null island"],
    [GC, 42, "a destination that is not an object"],
    [GC, "Surfers Paradise", "a destination given as a string instead of coordinates"],
  ]) {
    const r = await rdg.distance(a, b);
    eq(r.km, null, why + " is refused");
    eq(r.reason, "bad_coordinates", why + " reports bad_coordinates");
  }
  eq(guard.calls.length, 0, "and none of those spent a request");

  section("rounding");
  for (const [metres, km] of [[1049, 1], [1050, 1.1], [4210, 4.2], [4249, 4.2], [4250, 4.3], [84949, 84.9], [100, 0.1]]) {
    const r = await makeRouteDistance({ key: "k", fetchImpl: stub(okReply(metres, 60)).fetchImpl }).distance(GC, SP);
    eq(r.km, km, metres + " m -> " + km + " km");
  }

  console.log("\n" + (fail === 0 ? "ALL PASS" : "FAILURES") + ": " + pass + " passed, " + fail + " failed");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("the suite itself threw:", e); process.exit(1); });
