/* ---------------------------------------------------------------------------
 * Road distance between two points, from the Google Routes API.
 *
 * This is the only part of point-to-point pricing that needs a paid API, and
 * it is the reason the price has to be computed on the server: a distance the
 * browser supplies is a distance a customer can edit.
 *
 * The key must be its own key, restricted to this service's outbound IPs. The
 * site's existing GMAPS_KEY is a browser key that ships in the page source and
 * is referrer-restricted, and Google refuses referrer-restricted keys on its
 * server-side APIs.
 *
 * Three decisions worth keeping:
 *
 * 1. TRAFFIC_UNAWARE routing. Traffic-aware distance and duration change
 *    through the day, which would quietly put surge back into a price we
 *    promise is the same at any hour - and the same trip would quote
 *    differently on a Tuesday morning and a Friday night. It is also the
 *    cheaper billing tier.
 * 2. A hard timeout. This sits in front of a booking on a 0.5 CPU box. A slow
 *    answer from Google must never hold a customer on a spinner, so the call
 *    is abandoned and the job falls through to a manual quote.
 * 3. Never throws. Every failure comes back as { km: null, reason }. A booking
 *    must not die because a distance lookup did.
 * ------------------------------------------------------------------------ */
const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

/* Coordinates are rounded to this many decimals for the cache key. Three is
   about 110 m, far finer than the bands care about, so two spellings of the
   same address share an answer and cost one call rather than two. */
const COORD_DP = 3;

const DEFAULTS = {
  timeoutMs: 3500,
  cacheMax: 2000,
  cacheTtlMs: 7 * 24 * 3600 * 1000, // roads do not move; a week is conservative
};

const round = (n, dp) => Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp);
const isLat = (n) => n >= -90 && n <= 90;
const isLng = (n) => n >= -180 && n <= 180;

/* Number() is too forgiving to use on a coordinate: null, "" and false all
   become 0, which is a real latitude, so a missing coordinate would sail
   through as a point in the Gulf of Guinea and get priced as a trip. Anything
   that is not actually a number, or a string spelling one, is refused. */
function num(v) {
  if (v === null || v === undefined || typeof v === "boolean") return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function point(p) {
  if (!p || typeof p !== "object") return null;
  const lat = num(p.lat), lng = num(p.lng);
  if (lat === null || lng === null) return null;
  if (!isLat(lat) || !isLng(lng)) return null;
  /* Exactly null island is never a real pick-up; it is what a dropped field
     looks like once something upstream has already coerced it to a number. */
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

module.exports = function makeRouteDistance(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const key = o.key || process.env.GOOGLE_ROUTES_KEY || "";
  /* Injectable so the tests can run without a key and without the network. */
  const doFetch = o.fetchImpl || ((...a) => fetch(...a));
  const now = o.now || (() => Date.now());

  /* Plain Map as an LRU: re-inserting moves a key to the end, so the oldest
     live at the front and the first key is the one to drop. */
  const cache = new Map();

  function cacheGet(k) {
    const hit = cache.get(k);
    if (!hit) return null;
    if (hit.expires <= now()) { cache.delete(k); return null; }
    cache.delete(k); cache.set(k, hit); // touch
    return hit.value;
  }
  function cacheSet(k, value) {
    cache.set(k, { value, expires: now() + o.cacheTtlMs });
    while (cache.size > o.cacheMax) cache.delete(cache.keys().next().value);
  }

  async function distance(origin, destination) {
    const a = point(origin), b = point(destination);
    if (!a || !b) return { km: null, reason: "bad_coordinates" };
    if (!key) return { km: null, reason: "no_key" };

    const ck = [round(a.lat, COORD_DP), round(a.lng, COORD_DP),
                round(b.lat, COORD_DP), round(b.lng, COORD_DP)].join(",");
    const hit = cacheGet(ck);
    if (hit) return Object.assign({}, hit, { cached: true });

    const body = {
      origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } },
      destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
      units: "METRIC",
      regionCode: "AU",
      languageCode: "en-AU",
    };

    const ctrl = new AbortController();
    const bell = setTimeout(() => ctrl.abort(), o.timeoutMs);
    let res;
    try {
      res = await doFetch(ENDPOINT, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          /* Asking for only these two keeps the response on the cheapest SKU.
             Requesting polylines or legs would move it up a tier. */
          "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      clearTimeout(bell);
      const aborted = err && (err.name === "AbortError" || err.code === "ABORT_ERR");
      if (!aborted) console.error("route distance: request failed:", err && err.message);
      return { km: null, reason: aborted ? "timeout" : "network" };
    }
    clearTimeout(bell);

    if (!res || !res.ok) {
      const code = res ? res.status : 0;
      /* 403 here almost always means the key is referrer-restricted or the
         Routes API is not enabled on the project - worth saying plainly once
         rather than leaving a bare status in the log. */
      console.error("route distance: HTTP " + code +
        (code === 403 ? " (key restriction, or the Routes API is not enabled on the project)" : ""));
      return { km: null, reason: "http_" + code };
    }

    let json;
    try { json = await res.json(); }
    catch (err) { return { km: null, reason: "bad_response" }; }

    const route = json && Array.isArray(json.routes) ? json.routes[0] : null;
    const metres = route && Number(route.distanceMeters);
    if (!Number.isFinite(metres) || metres <= 0) return { km: null, reason: "no_route" };

    /* duration arrives as a protobuf string like "1534s". It is advisory here
       - the fare is banded on distance - so a missing one is not a failure. */
    const secs = route.duration ? parseInt(String(route.duration), 10) : NaN;

    const value = {
      km: round(metres / 1000, 1),
      minutes: Number.isFinite(secs) ? Math.round(secs / 60) : null,
    };
    cacheSet(ck, value);
    return Object.assign({}, value, { cached: false });
  }

  return {
    distance,
    enabled: Boolean(key),
    cacheSize: () => cache.size,
    clearCache: () => cache.clear(),
  };
};

module.exports.COORD_DP = COORD_DP;
module.exports.DEFAULTS = DEFAULTS;
module.exports.ENDPOINT = ENDPOINT;
