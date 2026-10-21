/**
 * The DMC / agent rate card (Aman, 21 Oct 2026) - "Sky Transfer pricing.xlsx",
 * Transfer & Touring Rate Card, valid 1 Jul 2026 to 30 June 2027.
 *
 * Only for agencies ticked "Rate card" in admin.html (agents.rate_card). For
 * them a trip the card covers is priced from the card, as a NET rate: no
 * commission builds in the wallet. Everything the card doesn't cover is
 * priced as for every other agency (the website fare + their commission).
 * The public website is not touched by any of this.
 *
 *  - The 53-seat coach is NOT here: it stays quote only (Aman).
 *  - Vehicles: the card's Sedan / 6 / 10 / 14 / 21 seat columns. SUV takes the
 *    Sedan price, People Mover the 6-seater, the Sprinters the 10 and 14
 *    seaters, and the two luxury classes the Sedan / 6-seater price plus the
 *    card's 10% luxury surcharge. The 21-seat mini bus is bookable on the
 *    card only (Aman: "also make 21 Seater bookable"); the 18-seat Sprinter
 *    has no card price and stays quote only.
 *  - Surcharges (Aman: added automatically): +15% for a pick-up from 10 pm to
 *    5 am, +25% on 25 and 26 December and 1 January, each leg on its own time.
 *    The night one is the card's "Night transfers": it isn't added to hire by
 *    the hour or a charter. Sundays and public holidays: nothing.
 *  - Cancellation (Aman: the card's policy): free 12 hours or more before;
 *    50% within 12 hours; 100% within 6 hours. See agent-portal.js.
 *  - "Holt Street Wharf" is the cruise terminal place (Pinkenba) - the place
 *    the portal already resolves any Pinkenba address to.
 *
 * Prices are whole dollars, each leg rounded on its own. A return transfer is
 * two legs at the card price - the website's 10% return discount is not on
 * the card. A theme-park "return" is one card price for both legs.
 */
const MINIBUS = "21 Seat Mini Bus";
/* vehicle -> [card column, percent of the card price]; columns: Sedan, 6, 10,
   14, 21 seater. Whole-number percentages throughout, so 110 at +15% is
   126.5 and rounds to 127 - floating point would make it 126.4999... */
const VEH = {
  "Sedan": [0, 100], "SUV": [0, 100], "People Mover": [1, 100], "Luxury Sedan": [0, 110], "Luxury Minivan": [1, 110],
  "Mercedes Sprinter 10-Seater": [2, 100], "Mercedes Sprinter 14-Seater": [3, 100], [MINIBUS]: [4, 100],
};
const VEHICLES = Object.keys(VEH);
const NIGHT = 15, FESTIVE = 25;
const FESTIVE_DAYS = ["12-25", "12-26", "01-01"];
const CANCEL = { freeHours: 12, halfHours: 6 };
const CLOSED_TEXT = "Changes close 12 hours before pick-up. Inside 12 hours a cancellation is charged at 50% of the fare, " +
  "and inside 6 hours (or a no-show) at 100%. Call +61 481 437 772 to change anything now.";

module.exports = function rateCard(opts) {
  const { OOL, BNE, CRUISE } = opts;
  /* "Surfers hotel" and "Brisbane hotel / city", as Aman confirmed them -
     the portal's place names, plus what Google calls the CBD */
  const GROUPS = {
    ool: [OOL], bne: [BNE], wharf: [CRUISE],
    surfers: ["Surfers Paradise", "Main Beach", "Broadbeach"],
    city: ["Brisbane CBD", "Brisbane City", "Brisbane", "Spring Hill", "Fortitude Valley", "South Brisbane", "Kangaroo Point"],
  };
  const NAMES = { ool: "Gold Coast Airport", bne: "Brisbane Airport", wharf: "Holt Street Wharf / cruise terminal", surfers: "Surfers hotel", city: "Brisbane city hotel" };
  const inGroup = (g, place) => GROUPS[g].some((x) => x.toLowerCase() === String(place || "").trim().toLowerCase());

  /* one-way transfers, either direction */
  const ROUTES = [
    { id: "ool-surfers", a: "ool", b: "surfers", p: [110, 130, 180, 250, 345] },
    { id: "bne-city", a: "bne", b: "city", p: [85, 110, 150, 200, 350] },
    { id: "bne-surfers", a: "bne", b: "surfers", p: [230, 260, 330, 440, 480] },
    { id: "surfers-city", a: "surfers", b: "city", p: [230, 260, 330, 440, 480] },
    { id: "wharf-bne", a: "wharf", b: "bne", p: [85, 110, 150, 200, 350] },
    { id: "wharf-surfers", a: "wharf", b: "surfers", p: [230, 260, 330, 440, 550] },
    { id: "wharf-city", a: "wharf", b: "city", p: [85, 110, 150, 200, 350] },
  ].map((r) => ({ ...r, label: `${NAMES[r.a]} ↔ ${NAMES[r.b]}` }));

  /* the card's packages, picked from a list on the agent page */
  const SERVICES = [
    { id: "ool-surfers-4h", group: "Airport to Surfers, hours included", kind: "pkg", from: OOL, hours: 4, label: "Gold Coast Airport → Surfers hotel, 4 hours included", p: [350, 420, 460, 560, 600] },
    { id: "ool-surfers-8h", group: "Airport to Surfers, hours included", kind: "pkg", from: OOL, hours: 8, label: "Gold Coast Airport → Surfers hotel, 8 hours included", p: [690, 810, 890, 1050, 1100] },
    { id: "bne-surfers-4h", group: "Airport to Surfers, hours included", kind: "pkg", from: BNE, hours: 4, label: "Brisbane Airport → Surfers hotel, 4 hours included", p: [450, 500, 600, 720, 720] },
    { id: "bne-surfers-8h", group: "Airport to Surfers, hours included", kind: "pkg", from: BNE, hours: 8, label: "Brisbane Airport → Surfers hotel, 8 hours included", p: [780, 850, 960, 1000, 1040] },
    { id: "park-seaworld", group: "Theme parks, return from a Surfers hotel", kind: "park", park: "Sea World, Main Beach", label: "Surfers hotel ⇄ Sea World, return", p: [150, 180, 200, 270, 480] },
    { id: "park-movieworld", group: "Theme parks, return from a Surfers hotel", kind: "park", park: "Warner Bros. Movie World, Oxenford", label: "Surfers hotel ⇄ Movie World, return", p: [190, 200, 260, 340, 580] },
    { id: "park-wetnwild", group: "Theme parks, return from a Surfers hotel", kind: "park", park: "Wet'n'Wild Gold Coast, Oxenford", label: "Surfers hotel ⇄ Wet'n'Wild, return", p: [190, 200, 260, 340, 580] },
    { id: "park-dreamworld", group: "Theme parks, return from a Surfers hotel", kind: "park", park: "Dreamworld, Coomera", label: "Surfers hotel ⇄ Dreamworld, return", p: [220, 240, 330, 400, 600] },
    { id: "park-currumbin", group: "Theme parks, return from a Surfers hotel", kind: "park", park: "Currumbin Wildlife Sanctuary, Currumbin", label: "Surfers hotel ⇄ Currumbin Wildlife Sanctuary, return", p: [195, 240, 310, 410, 580] },
    { id: "gc-charter-2h", group: "Gold Coast charters", kind: "charter", hours: 2, label: "Gold Coast charter or dinner, 2 hours", p: [170, 200, 220, 250, 360] },
    { id: "gc-charter-4h", group: "Gold Coast charters", kind: "charter", hours: 4, label: "Gold Coast charter, 4 hours", p: [340, 400, 440, 500, 650] },
    { id: "gc-charter-8h", group: "Gold Coast charters", kind: "charter", hours: 8, label: "Gold Coast charter, 8 hours", p: [680, 800, 880, 1200, 960] },
    { id: "gc-charter-10h", group: "Gold Coast charters", kind: "charter", hours: 10, label: "Gold Coast charter, 10 hours", p: [850, 1000, 1100, 1250, 1100] },
  ];
  const SERVICE = Object.fromEntries(SERVICES.map((s) => [s.id, s]));
  /* "Fleet, capacity & hourly rates": by the hour, for any other hire */
  const HOURLY = [85, 100, 110, 125, 135];

  const base = (p, vehicle) => { const v = VEH[vehicle]; return v && p[v[0]] != null ? Math.round(p[v[0]] * v[1] / 100) : null; };
  function surchargeOf(date, time, night) {
    let pct = 0; const notes = [];
    const m = /^(\d{1,2}):(\d{2})/.exec(String(time || ""));
    if (night && m) { const min = +m[1] * 60 + +m[2]; if (min >= 22 * 60 || min < 5 * 60) { pct += NIGHT; notes.push("night +15%"); } }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) && FESTIVE_DAYS.indexOf(String(date).slice(5)) !== -1) { pct += FESTIVE; notes.push("festive +25%"); }
    return { pct, notes };
  }
  const leg = (amount, date, time, night) => { const s = surchargeOf(date, time, night); return { amount: Math.round(amount * (100 + s.pct) / 100), notes: s.notes, date, time }; };
  function routeOf(pickup, dropoff) {
    return ROUTES.find((r) => (inGroup(r.a, pickup) && inGroup(r.b, dropoff)) || (inGroup(r.b, pickup) && inGroup(r.a, dropoff))) || null;
  }

  /* What the card says for one trip. null: the card doesn't cover it (price
     it the normal way). {error}: it is a card service but can't be booked as
     asked. Otherwise {id, label, kind, legsCount, hours, vehicles:[...]}, each
     vehicle {vehicle, total, fare, legs:[{amount, notes}]}.
     q: {service, pickup, dropoff, hours, isReturn, date, time, ret:{date,time}} */
  function quote(q) {
    const out = (id, label, kind, legsCount, hours, priceOf, extra) => {
      const vehicles = VEHICLES.map((v) => { const legs = priceOf(v); return legs ? { vehicle: v, legs, total: legs.reduce((n, l) => n + l.amount, 0), fare: legs[0].amount } : null; }).filter(Boolean);
      return vehicles.length ? Object.assign({ id, label, kind, legsCount, hours, vehicles }, extra || {}) : null;
    };
    const retDate = q.ret && q.ret.date, retTime = q.ret && q.ret.time;
    if (q.service) {
      const s = SERVICE[q.service];
      if (!s) return { error: "That rate card service isn't on the card any more - choose another, or call us." };
      if (s.kind === "pkg") {
        if (q.dropoff && !inGroup("surfers", q.dropoff)) return { error: "That package ends at a Surfers Paradise, Main Beach or Broadbeach hotel - pick the hotel as the drop-off, or call us." };
        return out(s.id, s.label, s.kind, 1, s.hours, (v) => { const b = base(s.p, v); return b == null ? null : [leg(b, q.date, q.time, true)]; }, { pickup: s.from });
      }
      if (s.kind === "park") {
        if (q.pickup && !inGroup("surfers", q.pickup)) return { error: "Theme park returns on the rate card start from a Surfers Paradise, Main Beach or Broadbeach hotel - pick the hotel as the pick-up, or call us." };
        /* one price for both legs: half on each (adding back to the card
           price exactly), each with its own surcharge */
        return out(s.id, s.label, s.kind, 2, null, (v) => { const b = base(s.p, v); if (b == null) return null; const h = Math.floor(b / 2);
          return [leg(h, q.date, q.time, true), leg(b - h, retDate || q.date, retTime || q.time, true)]; },
          { dropoff: s.park, needsReturn: true });
      }
      return out(s.id, s.label, s.kind, 1, s.hours, (v) => { const b = base(s.p, v); return b == null ? null : [leg(b, q.date, q.time, false)]; }, { dropoff: "As directed" });
    }
    if (q.hours) {
      return out("hourly", `By the hour at the card's hourly rate`, "hourly", 1, q.hours,
        (v) => { const b = base(HOURLY, v); return b == null ? null : [leg(b * q.hours, q.date, q.time, false)]; });
    }
    const r = routeOf(q.pickup, q.dropoff);
    if (!r) return null;
    return out(r.id, r.label, q.isReturn ? "return" : "oneway", q.isReturn ? 2 : 1, null, (v) => {
      const b = base(r.p, v); if (b == null) return null;
      const legs = [leg(b, q.date, q.time, true)];
      if (q.isReturn) legs.push(leg(b, retDate || q.date, retTime || q.time, true));
      return legs;
    });
  }

  /* The booking text, in exactly the line format bookingSummary writes (the
     office reads these, and so does the dispatch automation). */
  function summary(b, c, v, seats, trailer, ret, stops) {
    const legs = v.legs.length, extras = (seats * 15 + (trailer ? 30 : 0)) * legs;
    const stopsExtra = stops && stops.list.length ? Math.max(0, Math.round(stops.extra || 0)) : 0;
    const total = v.total + extras + stopsExtra;
    const notes = [...new Set(v.legs.flatMap((l) => l.notes))];
    const hrs = c.hours;
    const fareLine = c.kind === "park" ? `Fare: $${v.total} return, both legs (rate card)`
      : c.kind === "return" ? `Fare: $${v.legs[0].amount} one-way`
      : hrs ? `Fare: $${v.total} for ${hrs} hours${c.kind === "pkg" ? " incl. the transfer" : ""}` : `Fare: $${v.total} one-way`;
    return {
      total, isReturn: legs > 1, transfer: v.total, stopsExtra,
      text: [
        `Booking reference: ${b.ref || "-"}`,
        `Route: ${b.pickup} -> ${b.dropoff}`,
        ...(stopsExtra ? [`Stops on the way${legs > 1 ? " (outbound)" : ""}: ` + stops.list.map((s, i) => `${i + 1}) ${s.address || s.suburb}`).join("; ")] : []),
        ...(hrs ? [`Hire: ${c.kind === "pkg" ? "PACKAGE" : hrs > 6 ? "CHARTER" : "BY THE HOUR"} — ${hrs} hours${c.kind === "pkg" ? ", transfer included," : " as directed"} from ${b.time}`] : []),
        `Vehicle: ${b.vehicle}`,
        `Rate card: ${c.label} (agency net rate, no commission)`,
        fareLine,
        ...(notes.length ? [`Surcharge: ${notes.join(", ")} (included above)`] : []),
        ...(stopsExtra ? [`Stops: +$${stopsExtra} (adds ${stops.km != null ? stops.km : "?"} km)`] : []),
        `Baby/child seats: ${seats} ($15 each${legs > 1 ? ", each leg" : ""})`,
        `Luggage trailer: ${trailer ? `YES (+$30${legs > 1 ? " each leg" : ""})` : "No"}`,
        ...(ret ? [`Trip: RETURN`, `Return date: ${ret.date}`, `Return pick-up time: ${ret.time}`, `Return flight: ${ret.flight || "-"}`,
          c.kind === "park" ? `Return fare: included in the $${v.total} above` : `Return fare: $${v.legs[1] ? v.legs[1].amount : v.legs[0].amount} (rate card - no return discount; $${v.total} for both legs)`] : []),
        `TOTAL: $${total} AUD (GST incl.)`,
        ``,
        `Date: ${b.date}`,
        `Pick-up time: ${b.time}`,
        `Passengers: ${b.pax}`,
        `Flight: ${b.flight || "-"}`,
        ``,
        `Name: ${b.name}`,
        `Phone: ${b.phone}`,
        `Email: ${b.email}`,
        `Exact pick-up/drop-off address: ${b.address}`,
        `Notes: ${b.notes || "-"}`,
      ].join("\n"),
    };
  }

  /* What the agent page shows: the card itself, for the agency to read. */
  function publicCard() {
    return {
      validTo: "2027-06-30", vehicles: VEHICLES, minibus: MINIBUS,
      columns: ["Sedan / SUV", "People Mover", "Sprinter 10", "Sprinter 14", "21 seat"],
      routes: ROUTES.map((r) => ({ id: r.id, label: r.label, p: r.p })),
      services: SERVICES.map((s) => ({ id: s.id, group: s.group, kind: s.kind, label: s.label, hours: s.hours || null, from: s.from || null, park: s.park || null, p: s.p })),
      hourly: HOURLY,
      surcharges: ["Night transfers +15% (pick-ups 10 pm to 5 am)", "25 & 26 December and 1 January +25%", "Luxury Sedan and Luxury Minivan +10%"],
      cancel: ["Free 12 hours or more before pick-up", "50% within 12 hours", "100% within 6 hours or a no-show"],
    };
  }

  return { quote, summary, publicCard, routeOf, surchargeOf, SERVICE, VEHICLES, MINIBUS, CANCEL, CLOSED_TEXT };
};
module.exports.MINIBUS = MINIBUS;
module.exports.CANCEL = CANCEL;
