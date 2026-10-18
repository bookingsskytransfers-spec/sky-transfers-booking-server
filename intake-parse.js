/**
 * Reads one booking out of an account's email: the labelled lines accounts
 * send ("Date: 25/10/2026", "Pick up: Hilton Surfers Paradise", "Pax: 3").
 * The same labels as the paste-to-fill box on dispatch.html.
 *
 * It returns only what it is sure of. Anything it cannot read is reported,
 * not guessed: an email with two dates (two bookings), a change or a
 * cancellation, or a booking missing its date, time or addresses is handed
 * to the office instead of going on the board.
 */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const KEYS = [
  ["account", /^(account|supplier|agent|client|company|agency)$/],
  ["accref", /^(ref|reference|booking ref|booking reference|booking no|booking number|confirmation|conf|job no|job number|res|reservation|reservation no)$/],
  ["date", /^(date|pick ?up date|pickup date|travel date|service date|transfer date|arrival date|departure date)$/],
  ["time", /^(time|pick ?up time|pickup time|p\/?u time|start time|arrival time|departure time)$/],
  ["pax", /^(pax|passengers|no of pax|number of passengers|guests|adults|no\. of pax)$/],
  ["vehicle", /^(vehicle|car|vehicle type|car type|service type)$/],
  ["pickup", /^(pick ?up|pickup|from|pick ?up location|pickup location|pick ?up address|collect from)$/],
  ["dropoff", /^(drop ?off|dropoff|to|destination|drop ?off location|drop ?off address|drop to)$/],
  ["flight", /^(flight|flight no|flight number|flight #|arrival flight|departure flight)$/],
  ["name", /^(name|passenger|passenger name|guest|guest name|lead|lead passenger|lead name|client name|pax name)$/],
  ["phone", /^(phone|mobile|contact|contact number|phone number|mobile number|tel|cell)$/],
  ["price", /^(price|rate|cost|amount|fare|total|charge|quote)$/],
  ["notes", /^(notes|note|remarks|comments|special requests|instructions)$/],
  ["address", /^(address|hotel|accommodation)$/],
  ["hours", /^(hours|duration)$/],
];

function parseDate(s) {
  s = String(s || "").trim(); let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  /* Australian order: day first. */
  if ((m = /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/.exec(s))) {
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    if (+m[2] < 1 || +m[2] > 12 || +m[1] < 1 || +m[1] > 31) return "";
    return y + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
  }
  if ((m = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/.exec(s))) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi !== -1) return m[3] + "-" + String(mi + 1).padStart(2, "0") + "-" + m[1].padStart(2, "0");
  }
  return "";
}

function parseTime(s) {
  const m = /(\d{1,2})[:.]?(\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?/i.exec(String(s || "").trim()); if (!m) return "";
  let h = +m[1]; const min = m[2] ? +m[2] : 0; const ap = (m[3] || "").toLowerCase().replace(/\./g, "");
  if (!m[2] && !ap) return "";
  if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return "";
  return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
}

function parseVehicle(s, classes) {
  const t = String(s || "").toLowerCase();
  const map = [[/sprinter.*18|18.?seat|mini ?coach/, "Mercedes Sprinter 18-Seater"], [/sprinter.*14|14.?seat|1[2-4] ?seat/, "Mercedes Sprinter 14-Seater"],
    [/sprinter.*10|10.?seat|1[01] ?seat/, "Mercedes Sprinter 10-Seater"], [/v.?class|luxury (mini)?van|lux(ury)? people/, "Luxury Minivan"],
    [/lux(ury)? sedan|lexus|executive|prestige/, "Luxury Sedan"], [/people ?mover|minivan|carnival|van|7 ?seat/, "People Mover"],
    [/suv/, "SUV"], [/sedan|car\b|standard/, "Sedan"]];
  for (const [re, cls] of map) if (re.test(t) && (!classes || classes.includes(cls))) return cls;
  return "";
}

/* A change to something already booked is the office's to make. */
const CHANGE_WORDS = /\b(amend(ed|ment)?|chang(e|ed|es)|updat(e|ed)|revis(ed|ion)|cancel(led|lation)?|correction|re-?schedul(e|ed))\b/i;

function parseBookingEmail({ subject, text, classes }) {
  const problems = [];
  if (CHANGE_WORDS.test(subject || "")) {
    return { ok: false, kind: "change", problems: ["The subject looks like a change or cancellation (\"" + String(subject).slice(0, 80) + "\")."] };
  }
  /* Stop at the quoted thread or the signature's legal text. */
  const body = String(text || "").split(/\r?\n(?:-{2,}\s*Original Message|On .{5,80} wrote:|From: .+\r?\nSent: )/i)[0];
  const got = {}, seen = {};
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*[*\-•>]?\s*([A-Za-z][A-Za-z .\/#'-]{0,30}?)\s*[:\-–]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase().replace(/\s+/g, " ").trim(), v = m[2];
    for (const [key, re] of KEYS) {
      if (re.test(k)) {
        seen[key] = (seen[key] || 0) + 1;
        if (!got[key]) got[key] = v;
        break;
      }
    }
  }
  if ((seen.date || 0) > 1 || (seen.pickup || 0) > 1) {
    return { ok: false, kind: "several", problems: ["This email seems to hold more than one booking - enter them by hand."] };
  }
  const j = {
    accountRef: got.accref ? String(got.accref).slice(0, 60) : null,
    date: got.date ? parseDate(got.date) : "",
    time: got.time ? parseTime(got.time) : "",
    pax: got.pax ? +(String(got.pax).match(/\d+/) || [1])[0] : 1,
    vehicle: got.vehicle ? parseVehicle(got.vehicle, classes) : "",
    pickup: got.pickup ? String(got.pickup).slice(0, 200) : "",
    dropoff: got.dropoff ? String(got.dropoff).slice(0, 200) : "",
    flight: got.flight ? String(got.flight).toUpperCase().replace(/\s+/g, "").slice(0, 40) : null,
    name: got.name ? String(got.name).slice(0, 120) : "",
    phone: got.phone ? String(got.phone).slice(0, 40) : "",
    address: got.address ? String(got.address).slice(0, 300) : null,
    notes: got.notes ? String(got.notes).slice(0, 1000) : null,
    hours: got.hours ? +(String(got.hours).match(/\d+/) || [0])[0] || null : null,
    priceCents: null,
  };
  if (got.price) {
    const p = String(got.price).replace(/,/g, "").match(/\d+(\.\d{1,2})?/);
    if (p) j.priceCents = Math.round(+p[0] * 100);
  }
  if (j.hours && !j.dropoff) j.dropoff = "As directed";
  const missing = [];
  if (!j.date) missing.push(got.date ? "a date it could read (\"" + String(got.date).slice(0, 30) + "\")" : "the date");
  if (!j.time) missing.push(got.time ? "a time it could read (\"" + String(got.time).slice(0, 30) + "\")" : "the pick-up time");
  if (!j.pickup) missing.push("the pick-up address");
  if (!j.dropoff) missing.push("the drop-off");
  if (missing.length) return { ok: false, kind: "missing", problems: ["Couldn't find " + missing.join(", ") + "."], partial: j };
  /* Things the office must look at, but which don't stop the job going on the board. */
  const checks = [];
  if (!j.vehicle) checks.push(got.vehicle ? "vehicle not recognised (\"" + String(got.vehicle).slice(0, 40) + "\")" : "no vehicle given");
  if (j.priceCents == null) checks.push("no price in the email");
  if (!j.name) checks.push("no passenger name");
  if (!j.phone) checks.push("no passenger phone");
  return { ok: true, job: j, checks };
}

module.exports = { parseBookingEmail, parseDate, parseTime, parseVehicle };
