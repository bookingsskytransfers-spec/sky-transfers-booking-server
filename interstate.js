/**
 * Interstate transfers and tours for agents (Aman, 26 Oct 2026) - Sydney,
 * Melbourne and Cairns, from three partner DMCs' net price lists, sold at
 * their price plus 10%.
 *
 *   Sydney     Australian Corporate Cars, inbound rates to 31 March 2027
 *   Melbourne  Yarra Tours, price list 2026
 *   Cairns     Cairns Tours and Transport, tour rate list
 *
 * Aman's choices: every agency sees these; they are NET (no commission, even
 * for a commission agency - 10% leaves no room for one); the supplier's
 * price plus 10% is rounded UP to the next $5, so it is never less than 10%;
 * the supplier's fixed extras (night, public holidays, Christmas / New Year,
 * child seats) are added automatically, plus 10%. Waiting time and event
 * surcharges (Grand Prix, Australian Open) stay with the office.
 *
 * The supplier and its price are office-only: nothing here that reaches an
 * agent names the supplier or shows its net. Prices are worked in cents and
 * each leg is rounded once, on its whole supplier cost (fare + extras).
 *
 * Booked like any other agent booking (agent-portal.js): agent_bookings.
 * rate_card = "ix:<product id>", commission 0. Changes close 24 hours out
 * (Australian Corporate Cars' terms; the office has to re-book the partner);
 * inside 24 hours a cancellation is charged at 100%.
 *
 * Two lists disagree with themselves and the higher figure is used, so the
 * margin is never below 10%: ACC's page 3 sedan rates (89.50 international,
 * 84 domestic, 81 inner city; European sedan 97.50 / 92 / 92) against page 2
 * (85.50 / 82.50 / 75; 95.50 / 92.50 / 83).
 */
const MARKUP_PCT = 10, ROUND_TO = 5;
const CUTOFF_HOURS = 24;
const CLOSED_TEXT = "Interstate bookings close for changes 24 hours before pick-up - inside 24 hours a cancellation " +
  "is charged in full. Call +61 481 437 772 to change anything now.";

/* supplier cents -> agent dollars: +10%, up to the next $5 */
const sell = (cents) => Math.ceil((cents * (100 + MARKUP_PCT)) / (100 * 100 * ROUND_TO)) * ROUND_TO;
const c = (dollars) => Math.round(dollars * 100);
const hhmm = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); return m ? +m[1] * 60 + +m[2] : null; };

/* ---------------------------------------------------------------- Sydney */
const SYD = {
  id: "syd", name: "Sydney", state: "NSW", validTo: "2027-03-31",
  supplier: { name: "Australian Corporate Cars", phone: "02 9799 2222", email: "sales@australiancorporatecars.com.au" },
  vehicles: [
    { id: "sedan", name: "Standard Sedan", cap: 2, bags: "2 large cases + 2 carry-on" },
    { id: "prem", name: "Premium Sedan (BMW, Audi, Mercedes)", cap: 2, bags: "2 large cases + 2 carry-on" },
    { id: "b7", name: "People Mover", cap: 4, bags: "4 large cases + 4 carry-on" },
    { id: "b10", name: "Mini Coach (8 seats)", cap: 8, bags: "8 large + 8 carry-on, trailer free" },
    { id: "b15", name: "Coach (14 seats)", cap: 14, bags: "12 large + 12 carry-on, trailer free" },
    { id: "b22", name: "Coach (20 seats)", cap: 20, bags: "16 large + 16 carry-on, trailer free" },
  ],
  ends: { intl: "Sydney Airport (T1 International)", dom: "Sydney Airport (T2/T3 Domestic)", city: "Sydney city hotel", tour: "Sydney city (tour start)" },
  seat: c(16.5),
  /* public holidays and midnight to 4 am: +20%, on transfers */
  surcharge(kind, date, time) {
    if (kind !== "transfer") return { pct: 0, add: 0, notes: [] };
    const m = hhmm(time), notes = [];
    let pct = 0;
    if (NSW_HOLIDAYS.indexOf(date) !== -1) { pct = 20; notes.push("public holiday +20%"); }
    else if (m != null && m <= 4 * 60) { pct = 20; notes.push("midnight to 4 am +20%"); }
    return { pct, add: 0, notes };
  },
  products: [
    { id: "syd-intl", group: "Airport transfers", kind: "transfer", a: "intl", b: "city", either: true, label: "Sydney Airport International ⇄ city hotel", net: [89.5, 97.5, 130, 165, 198, 250] },
    { id: "syd-dom", group: "Airport transfers", kind: "transfer", a: "dom", b: "city", either: true, label: "Sydney Airport Domestic ⇄ city hotel", net: [84, 92.5, 125, 160, 190, 245] },
    { id: "syd-inner", group: "Airport transfers", kind: "inner", label: "Sydney inner-city transfer, one way", net: [81, 92, 105, 130, 150, 195] },
    { id: "syd-city-2h", group: "Sydney city tours", kind: "hire", hours: 2, label: "Sydney city tour, 2 hours", net: [150, 175, 210, 220, 240, 300], extra: "city" },
    { id: "syd-city-4h", group: "Sydney city tours", kind: "hire", hours: 4, label: "Sydney city tour, 4 hours", net: [292.5, 380, 395, 425, 480, 600], extra: "city" },
    { id: "syd-city-6h", group: "Sydney city tours", kind: "hire", hours: 6, label: "Sydney city tour, 6 hours", net: [390, 517, 550, 620, 800, 990], extra: "city" },
    { id: "syd-city-8h", group: "Sydney city tours", kind: "hire", hours: 8, label: "Sydney city tour, 8 hours", net: [527.5, 640, 720, 815, 915, 1135], extra: "city" },
    { id: "syd-city-10h", group: "Sydney city tours", kind: "hire", hours: 10, label: "Sydney city tour, 10 hours", net: [620, 770, 825, 960, 1075, 1330], extra: "city" },
    { id: "syd-city-12h", group: "Sydney city tours", kind: "hire", hours: 12, label: "Sydney city tour, 12 hours", net: [720, 880, 990, 1080, 1200, 1500], extra: "city" },
    { id: "syd-reg-8h", group: "Regional day tours (Blue Mountains, Hunter Valley, Port Stephens)", kind: "hire", hours: 8, label: "Regional day tour, 8 hours", net: [600, 660, 765, 815, 915, 1100], extra: "regional" },
    { id: "syd-reg-10h", group: "Regional day tours (Blue Mountains, Hunter Valley, Port Stephens)", kind: "hire", hours: 10, label: "Regional day tour, 10 hours", net: [732, 814, 941, 990, 1020, 1300], extra: "regional" },
    { id: "syd-reg-12h", group: "Regional day tours (Blue Mountains, Hunter Valley, Port Stephens)", kind: "hire", hours: 12, label: "Regional day tour, 12 hours", net: [864, 968, 1020, 1080, 1100, 1400], extra: "regional" },
  ],
  extraHour: { city: [80, 90, 100, 120, 130, 180], regional: [66, 77, 77, 110, 120, 120] },
  notes: ["Regional tours (Blue Mountains, Hunter Valley, Port Stephens) are 8 hours or more; tell us the plan in the notes.",
    "The Mini Coach and both coaches carry a luggage trailer free of charge.",
    "Airport waiting: 60 minutes free after an international landing, 30 after a domestic one."],
};
/* NSW public holidays to the end of 2027 (the ACC rates run to 31 March 2027) */
const NSW_HOLIDAYS = ["2026-12-25", "2026-12-26", "2026-12-28", "2027-01-01", "2027-01-26", "2027-03-26", "2027-03-27",
  "2027-03-28", "2027-03-29", "2027-04-25", "2027-06-14", "2027-10-04", "2027-12-25", "2027-12-26", "2027-12-27", "2027-12-28"];

/* ------------------------------------------------------------- Melbourne */
const MEL = {
  id: "mel", name: "Melbourne", state: "VIC", validTo: null,
  supplier: { name: "Yarra Tours", phone: "", email: "" },
  vehicles: [
    { id: "exec", name: "Executive Sedan", cap: 3 },
    { id: "prem", name: "Premium Sedan", cap: 3 },
    { id: "suv", name: "SUV", cap: 4 },
    { id: "van", name: "Van", cap: 7 },
    { id: "mvan", name: "Mercedes Van", cap: 7 },
    { id: "mb11", name: "Minibus (up to 11)", cap: 11 },
    { id: "sp11", name: "Mercedes Sprinter (up to 11)", cap: 11 },
    { id: "sp14", name: "Mercedes Sprinter (up to 14)", cap: 14 },
    { id: "mb21", name: "Minibus (up to 21)", cap: 21 },
  ],
  ends: { intl: "Melbourne Airport (international arrival)", dom: "Melbourne Airport (domestic arrival)", mel: "Melbourne Airport",
          avalon: "Avalon Airport", city: "Melbourne city hotel", tour: "Melbourne city (tour start)" },
  seat: c(10),
  /* 10 pm to 5 am +$15 ($30 the 21-seat minibus); 1-7 November and
     15-30 December +$20 a transfer / +$50 a tour; Christmas Day, New Year's
     Eve and New Year's Day +$50 / +$150 instead */
  surcharge(kind, date, time, vehicleId) {
    let add = 0; const notes = [];
    const m = hhmm(time);
    if (m != null && (m >= 22 * 60 || m < 5 * 60)) { const n = vehicleId === "mb21" ? 30 : 15; add += c(n); notes.push(`night +$${n} (partner)`); }
    const md = String(date || "").slice(5), tour = kind === "hire";
    if (["12-25", "12-31", "01-01"].indexOf(md) !== -1) { add += c(tour ? 150 : 50); notes.push(md === "12-25" ? "Christmas Day" : md === "12-31" ? "New Year's Eve" : "New Year's Day"); }
    else if ((md >= "11-01" && md <= "11-07") || (md >= "12-15" && md <= "12-30")) { add += c(tour ? 50 : 20); notes.push("peak dates"); }
    return { pct: 0, add, notes };
  },
  products: [
    { id: "mel-intl", group: "Airport transfers", kind: "transfer", a: "intl", b: "city", label: "Melbourne Airport → city hotel (international arrival)", net: [105, 125, 115, 135, 135, 220, 235, 280, 330] },
    { id: "mel-dom", group: "Airport transfers", kind: "transfer", a: "dom", b: "city", label: "Melbourne Airport → city hotel (domestic arrival)", net: [100, 120, 115, 130, 130, 220, 235, 280, 300] },
    { id: "mel-dep", group: "Airport transfers", kind: "transfer", a: "city", b: "mel", label: "City hotel → Melbourne Airport", net: [100, 120, 115, 130, 130, 220, 235, 280, 300] },
    { id: "mel-avalon", group: "Airport transfers", kind: "transfer", a: "avalon", b: "city", either: true, label: "Avalon Airport ⇄ city hotel", net: [175, 200, 185, 210, 210, 380, 400, 425, 470] },
    { id: "mel-inner", group: "City and dinner transfers", kind: "inner", label: "Inner-city or dinner transfer, one way", net: [85, 115, 95, 120, 120, 175, 200, 210, 250] },
    { id: "mel-dinner-rt", group: "City and dinner transfers", kind: "roundtrip", hours: 2, label: "Dinner transfer, there and back (up to 2 hours)", net: [170, 230, 190, 220, 220, 350, 400, 380, 400] },
    { id: "mel-city-4h", group: "Melbourne city tours", kind: "hire", hours: 4, label: "Melbourne city tour, 4 hours", net: [380, 480, 400, 440, 440, 550, 600, 650, 600], extra: "all" },
    { id: "mel-city-5h", group: "Melbourne city tours", kind: "hire", hours: 5, label: "Melbourne city tour, 5 hours", net: [475, 600, 495, 550, 550, 650, 700, 725, 700], extra: "all" },
    { id: "mel-city-6h", group: "Melbourne city tours", kind: "hire", hours: 6, label: "Melbourne city tour, 6 hours", net: [570, 720, 580, 650, 675, 780, 800, 830, 850], extra: "all" },
    { id: "mel-city-8h", group: "Melbourne city tours", kind: "hire", hours: 8, label: "Melbourne city tour, 8 hours", net: [740, 900, 760, 880, 880, 1040, 1150, 1170, 980], extra: "all" },
    { id: "mel-yarra-8h", group: "Day tours from Melbourne", kind: "hire", hours: 8, label: "Yarra Valley day tour, 8 hours", net: [740, 900, 760, 880, 880, 1040, 1150, 1170, 980], extra: "all" },
    { id: "mel-ballarat-8h", group: "Day tours from Melbourne", kind: "hire", hours: 8, label: "Ballarat day tour, 8 hours", net: [740, 900, 760, 880, 880, 1040, 1150, 1170, 980], extra: "all" },
    { id: "mel-mornington-8h", group: "Day tours from Melbourne", kind: "hire", hours: 8, label: "Mornington Peninsula day tour, 8 hours", net: [740, 900, 760, 880, 880, 1040, 1150, 1170, 980], extra: "all" },
    { id: "mel-phillip-10h", group: "Day tours from Melbourne", kind: "hire", hours: 10, label: "Phillip Island, 10 hours", net: [875, 1100, 900, 950, 1100, 1100, 1200, 1250, 1330], extra: "all" },
    { id: "mel-gor-12h", group: "Day tours from Melbourne", kind: "hire", hours: 12, label: "Great Ocean Road, 12 hours", net: [980, 1320, 1000, 1050, 1200, 1150, 1440, 1500, 1550], extra: "all" },
    { id: "mel-city-phillip-12h", group: "Day tours from Melbourne", kind: "hire", hours: 12, label: "City tour + Phillip Island, 12 hours", net: [980, 1320, 1000, 1050, 1200, 1150, 1440, 1500, 1550], extra: "all" },
  ],
  extraHour: { all: [85, 120, 95, 100, 110, 110, 120, 125, 120] },
  notes: ["International arrivals: the first 60 minutes' waiting is free.",
    "Grand Prix and Australian Open days can carry a partner surcharge - we'll tell you before the day if one applies."],
};

/* ---------------------------------------------------------------- Cairns */
const CNS = {
  id: "cns", name: "Cairns", state: "QLD", validTo: null,
  supplier: { name: "Cairns Tours and Transport", phone: "+61 406 960 180", email: "cainstransport@yahoo.com" },
  vehicles: [
    { id: "s2", name: "Car (up to 2)", cap: 2 },
    { id: "s4", name: "Up to 4 passengers", cap: 4 },
    { id: "s7", name: "Up to 7 passengers", cap: 7 },
    { id: "s11", name: "Minibus (up to 11)", cap: 11 },
    { id: "s20", name: "Minibus (up to 20)", cap: 20 },
    { id: "glc", name: "Mercedes GLC 200 (up to 2)", cap: 2 },
    { id: "valente", name: "Mercedes Valente (up to 5)", cap: 5 },
    { id: "vito", name: "Mercedes Vito (up to 7)", cap: 7 },
  ],
  ends: { ap: "Cairns Airport", city: "Cairns city hotel", sky: "Skyrail / Freshwater", kur: "Kuranda", nb: "Cairns Northern Beaches", pd: "Port Douglas", tour: "Cairns city (charter start)" },
  seat: null,
  surcharge() { return { pct: 0, add: 0, notes: [] }; },
  products: [
    { id: "cns-ap-city", group: "From Cairns city", kind: "transfer", a: "ap", b: "city", either: true, label: "Cairns Airport ⇄ city hotel", net: [100, 120, 130, 160, 240, 140, 160, 200] },
    { id: "cns-inner", group: "From Cairns city", kind: "inner", label: "Cairns inner-city transfer, one way", net: [85, 85, 95, 110, 150, 110, 130, 150] },
    { id: "cns-city-sky", group: "From Cairns city", kind: "transfer", a: "city", b: "sky", either: true, label: "City hotel ⇄ Skyrail / Freshwater", net: [115, 125, 145, 180, 250, 130, 150, 170] },
    { id: "cns-city-kur", group: "From Cairns city", kind: "transfer", a: "city", b: "kur", either: true, label: "City hotel ⇄ Kuranda", net: [170, 180, 195, 240, 280, 190, 210, 220] },
    { id: "cns-nb-ap", group: "From the Northern Beaches", kind: "transfer", a: "nb", b: "ap", either: true, label: "Northern Beaches ⇄ Cairns Airport", net: [160, 170, 190, 225, 270, 200, 240, 270] },
    { id: "cns-nb-city", group: "From the Northern Beaches", kind: "transfer", a: "nb", b: "city", either: true, label: "Northern Beaches ⇄ Cairns city", net: [160, 170, 190, 225, 270, 200, 240, 270] },
    { id: "cns-nb-sky", group: "From the Northern Beaches", kind: "transfer", a: "nb", b: "sky", either: true, label: "Northern Beaches ⇄ Skyrail / Freshwater", net: [160, 170, 190, 225, 270, 200, 240, 270] },
    { id: "cns-nb-kur", group: "From the Northern Beaches", kind: "transfer", a: "nb", b: "kur", either: true, label: "Northern Beaches ⇄ Kuranda", net: [210, 230, 250, 270, 340, 270, 320, 350] },
    { id: "cns-pd-ap", group: "From Port Douglas", kind: "transfer", a: "pd", b: "ap", either: true, label: "Port Douglas ⇄ Cairns Airport", net: [260, 270, 310, 450, 650, 325, 450, 680] },
    { id: "cns-pd-city", group: "From Port Douglas", kind: "transfer", a: "pd", b: "city", either: true, label: "Port Douglas ⇄ Cairns city", net: [270, 280, 320, 460, 700, 325, 450, 680] },
    { id: "cns-pd-sky", group: "From Port Douglas", kind: "transfer", a: "pd", b: "sky", either: true, label: "Port Douglas ⇄ Skyrail / Freshwater", net: [270, 280, 320, 490, 680, 325, 450, 680] },
    { id: "cns-pd-kur", group: "From Port Douglas", kind: "transfer", a: "pd", b: "kur", either: true, label: "Port Douglas ⇄ Kuranda", net: [330, 350, 400, 550, 700, 425, 560, 740] },
    { id: "cns-charter", group: "Charters from Cairns city", kind: "charter", hoursFrom: 3, hoursTo: 12, label: "Cairns charter, 3 to 12 hours" },
  ],
  /* charter by hours 3..12; no 1-2 seat car on a charter */
  charter: {
    3: [null, 300, 335, 355, 450, 340, 400, 480], 4: [null, 380, 410, 430, 530, 410, 490, 600], 5: [null, 460, 480, 520, 620, 490, 580, 710],
    6: [null, 530, 550, 590, 690, 580, 670, 810], 7: [null, 600, 610, 660, 750, 650, 760, 900], 8: [null, 650, 670, 700, 820, 710, 850, 970],
    9: [null, 710, 730, 750, 890, 770, 920, 1040], 10: [null, 760, 780, 820, 940, 820, 980, 1090], 11: [null, 810, 830, 880, 1020, 890, 1040, 1140],
    12: [null, 860, 880, 940, 1090, 950, 1100, 1200],
  },
  notes: ["Child seats aren't priced online for Cairns - tell us in the notes and we'll confirm."],
};

const CITIES = [SYD, MEL, CNS];
const CITY = Object.fromEntries(CITIES.map((x) => [x.id, x]));
const PRODUCT = {};
CITIES.forEach((city) => city.products.forEach((p) => { PRODUCT[p.id] = { ...p, city }; }));

/* The trip as asked, in travel order: {pickup, dropoff, hours} as text */
function endsOf(p, dir, hours) {
  const E = p.city.ends;
  if (p.kind === "transfer") { const [x, y] = dir ? [p.b, p.a] : [p.a, p.b]; return { pickup: E[x], dropoff: E[y], hours: null, airport: /Airport/.test(E[x] + E[y]), fromAirport: /Airport/.test(E[x]) }; }
  if (p.kind === "inner") return { pickup: `${p.city.name} city`, dropoff: `${p.city.name} city`, hours: null };
  if (p.kind === "roundtrip") return { pickup: `${p.city.name} city`, dropoff: `${p.city.name} city (and back)`, hours: p.hours };
  return { pickup: E.tour, dropoff: "As directed", hours: p.kind === "charter" ? hours : p.hours };
}
/* supplier price (cents) of the product for one vehicle, before extras */
function netOf(p, vi, hours, city) {
  if (p.kind === "charter") { const row = (city || p.city).charter[hours]; return row && row[vi] != null ? c(row[vi]) : null; }
  return p.net[vi] != null ? c(p.net[vi]) : null;
}

/* The price of one product for every vehicle that can carry the party.
   q: {product, dir, hours, extra, date, time, ret:{date,time}, isReturn, seats, pax}
   Returns {error} or {product, label, kind, hours, legsCount, ends, vehicles:[{vehicle, vehicleId, cap, total, fare, net, legs, notes}]} */
function quote(q) {
  const p = PRODUCT[String(q.product || "")];
  if (!p) return { error: "That interstate trip isn't on our list any more - choose another, or call us." };
  const city = p.city;
  let hours = null;
  if (p.kind === "charter") {
    hours = parseInt(q.hours, 10);
    if (!(hours >= p.hoursFrom && hours <= p.hoursTo)) return { error: `Choose ${p.hoursFrom} to ${p.hoursTo} hours for a charter.` };
  }
  const extra = p.extra ? Math.min(Math.max(parseInt(q.extra, 10) || 0, 0), 4) : 0;
  const dir = p.kind === "transfer" && p.either && (q.dir === 1 || q.dir === "1") ? 1 : 0;
  const seats = Math.min(Math.max(parseInt(q.seats, 10) || 0, 0), 3);
  if (seats && city.seat == null) return { error: `Child seats can't be booked online in ${city.name} - leave them at none, put them in the notes, and we'll confirm.` };
  if (city.validTo && q.date && q.date > city.validTo) return { error: `Our ${city.name} prices run to ${city.validTo.split("-").reverse().join("/")} - call +61 481 437 772 for a later date.` };
  const isReturn = p.kind === "transfer" && !!q.isReturn;
  const e = endsOf(p, dir, hours);
  const legDates = [[q.date, q.time]];
  if (isReturn) legDates.push([q.ret && q.ret.date, q.ret && q.ret.time]);
  const surchargeKind = p.kind === "hire" || p.kind === "charter" ? "hire" : "transfer";
  const vehicles = city.vehicles.map((v, vi) => {
    const base = netOf(p, vi, hours);
    if (base == null) return null;
    const extraCents = extra ? c(city.extraHour[p.extra][vi]) * extra : 0;
    const legs = legDates.map(([d, t]) => {
      const s = city.surcharge(surchargeKind, d, t, v.id);
      const net = Math.round((base + extraCents) * (100 + s.pct) / 100) + s.add + seats * (city.seat || 0);
      return { amount: sell(net), net, notes: s.notes, date: d, time: t };
    });
    const total = legs.reduce((n, l) => n + l.amount, 0);
    return { vehicle: `${city.name}: ${v.name}`, vehicleId: v.id, name: v.name, cap: v.cap, bags: v.bags || "", total, fare: legs[0].amount,
             net: legs.reduce((n, l) => n + l.net, 0), legs, notes: [...new Set(legs.flatMap((l) => l.notes))] };
  }).filter(Boolean);
  if (!vehicles.length) return { error: "No vehicle is priced for that - call us." };
  return { product: p.id, city: city.id, cityName: city.name, state: city.state, label: p.label + (extra ? ` + ${extra} extra hour${extra > 1 ? "s" : ""}` : ""),
           kind: p.kind, hours: e.hours != null ? (e.hours || 0) + extra || null : null, extra, dir, seats, legsCount: legDates.length,
           ends: e, vehicles, supplier: city.supplier };
}

/* The booking text, in bookingSummary's line format (the office and the
   dispatch automation read these). */
function summary(b, q, v, ret) {
  const legs = v.legs.length;
  const total = v.total;
  const hrs = q.hours;
  const fareLine = legs > 1 ? `Fare: $${v.legs[0].amount} one-way` : hrs ? `Fare: $${v.total} for ${hrs} hours` : `Fare: $${v.total} one-way`;
  return {
    total, isReturn: legs > 1, transfer: v.total, stopsExtra: 0,
    text: [
      `Booking reference: ${b.ref || "-"}`,
      `Route: ${b.pickup} -> ${b.dropoff}`,
      ...(hrs ? [`Hire: ${q.kind === "roundtrip" ? "DINNER RETURN" : hrs > 6 ? "CHARTER" : "BY THE HOUR"} — ${hrs} hours as directed from ${b.time}`] : []),
      `Vehicle: ${b.vehicle}`,
      `Interstate: ${q.cityName} - ${q.label} (agency net rate, no commission)`,
      fareLine,
      ...(v.notes.length ? [`Surcharge: ${v.notes.join(", ")} (included above)`] : []),
      `Baby/child seats: ${q.seats}${q.seats ? " (included above)" : ""}`,
      `Luggage trailer: No`,
      ...(ret ? [`Trip: RETURN`, `Return date: ${ret.date}`, `Return pick-up time: ${ret.time}`, `Return flight: ${ret.flight || "-"}`,
        `Return fare: $${v.legs[1].amount} ($${v.total} for both legs)`] : []),
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
      `Exact pick-up/drop-off address: ${b.address || "-"}`,
      `Notes: ${b.notes || "-"}`,
    ].join("\n"),
  };
}

/* What an agent sees: no supplier, no net - the cities, the products and
   each vehicle's starting price. */
function publicList() {
  return {
    cutoffHours: CUTOFF_HOURS,
    cities: CITIES.map((city) => ({
      id: city.id, name: city.name, validTo: city.validTo, seatPrice: city.seat == null ? null : sell(city.seat),
      vehicles: city.vehicles.map((v) => ({ id: v.id, name: v.name, cap: v.cap, bags: v.bags || "" })),
      ends: city.ends, notes: city.notes,
      products: city.products.map((p) => {
        const prices = p.kind === "charter"
          ? city.vehicles.map((v, vi) => { const n = netOf(p, vi, p.hoursFrom, city); return n == null ? null : sell(n); })
          : p.net.map((n) => (n == null ? null : sell(c(n))));
        const from = Math.min.apply(null, prices.filter((x) => x != null));
        return { id: p.id, group: p.group, kind: p.kind, label: p.label, a: p.a || null, b: p.b || null, either: !!p.either,
                 hours: p.hours || null, hoursFrom: p.hoursFrom || null, hoursTo: p.hoursTo || null, extra: !!p.extra, from, prices };
      }),
    })),
    rules: ["Prices are your net rate - no commission - and include GST.",
      "Book at least 24 hours ahead. Changes close 24 hours before pick-up; inside 24 hours a cancellation is charged in full.",
      "Night and public-holiday surcharges are added to the price automatically."],
  };
}

const isIx = (rateCard) => /^ix:/.test(String(rateCard || ""));
const lateFeePct = (h) => (h == null || h <= 0 ? null : h < CUTOFF_HOURS ? 100 : 0);

module.exports = { quote, summary, publicList, PRODUCT, CITY, CITIES, isIx, lateFeePct, sell, CUTOFF_HOURS, CLOSED_TEXT, NSW_HOLIDAYS };
