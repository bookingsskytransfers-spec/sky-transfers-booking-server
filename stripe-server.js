/**
 * Sky Transfers — booking & payment server
 * ----------------------------------------
 * Companion server for sky-transfers-booking-widget.html. Two jobs:
 *
 *   POST /request-booking   The widget sends the booking here; this server emails
 *                           the details to Sky Transfers AND a confirmation to the
 *                           guest — automatically, nothing opens on their screen.
 *
 *   POST /create-checkout   Optional card payment: RE-COMPUTES the fare from the
 *                           official rate table (so nobody can tamper with the
 *                           price in the browser) and creates a Stripe Checkout
 *                           Session. The customer pays on Stripe's hosted page —
 *                           card details never touch your site.
 *
 * SETUP (one time):
 *   1. npm install express cors nodemailer stripe
 *   2. Set environment variables:
 *      — Email (required for /request-booking):
 *        GMAIL_USER          = bookings.skytransfers@gmail.com
 *        GMAIL_APP_PASSWORD  = 16-character App Password. Get one at
 *                              myaccount.google.com → Security → 2-Step Verification
 *                              → App passwords. (NOT your normal Gmail password.)
 *        BOOKINGS_EMAIL      = where booking requests land (default info@skytransfers.com.au)
 *      — Stripe (optional; skip these and payments stay off, email bookings still work):
 *        STRIPE_SECRET_KEY   = sk_live_...  (dashboard.stripe.com → Developers → API keys.
 *                              Paste it ONLY here in your host's env settings — never into
 *                              chat, the website file, or anywhere public.)
 *        SUCCESS_URL         = https://www.skytransfers.com.au/booking-confirmed
 *        CANCEL_URL          = https://www.skytransfers.com.au/booking
 *      — Dispatch automation (optional):
 *        ZAPIER_HOOK_URL     = your Zapier "Catch Hook" URL. Every confirmed booking is
 *                              POSTed there as JSON; the Zap maps it to Limo Anywhere's
 *                              "Create Reservation" action so dispatch stays in LimoAnywhere.
 *        STRIPE_WEBHOOK_SECRET = whsec_... (Stripe dashboard → Developers → Webhooks →
 *                              add endpoint <server>/stripe-webhook for checkout.session.completed).
 *                              With this set, PAID bookings also email both sides with the
 *                              PDF and flow to Zapier/LimoAnywhere automatically.
 *      — Security:
 *        ALLOWED_ORIGIN      = https://www.skytransfers.com.au
 *   3. node stripe-server.js   (or deploy to Render / Railway / any Node host)
 *   4. Put the deployed base URL (e.g. https://sky-pay.onrender.com) into
 *      SERVER_URL in the widget. That's it — the widget finds both endpoints.
 *
 * IMPORTANT: if you change prices in the rate sheet, update the tables below too
 * (they must match the widget's tables — ask Claude to regenerate both together).
 */

const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const Stripe = require("stripe");
const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const mailer = process.env.GMAIL_USER
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    })
  : null;
const BOOKINGS_EMAIL = process.env.BOOKINGS_EMAIL || "info@skytransfers.com.au";
const LOGO_PATH = path.join(__dirname, "logo.png");
const HAS_LOGO = fs.existsSync(LOGO_PATH);
const REVIEW_URL = "https://www.google.com/maps?cid=9657905201752242057";

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
const ORIGINS = (process.env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: ORIGINS.length ? ORIGINS : true }));

// Health check — open the server URL in a browser to see this
app.get("/", (req, res) => {
  res.send(
    "Sky Transfers booking server is running. " +
    `Email: ${mailer ? "configured" : "NOT configured"} · ` +
    `Payments: ${stripe ? "configured" : "not configured (optional)"}`
  );
});

// ---- Official rates (AUD, one-way, GST incl.) — keep in sync with the widget ----
const SUBURBS = {"Advancetown":["H","H"],"Arundel":["N1","N1"],"Ashmore":["C2","C2"],"Austinville":["H","H"],"Beechmont":["H","H"],"Benowa":["C2","C2"],"Biggera Waters":["N1","N1"],"Bilinga":["S1","S1"],"Bonogin":["C1","C1"],"Broadbeach":["C1","C1"],"Broadbeach Waters":["C1","C1"],"Bundall":["C2","C2"],"Burleigh Heads":["S3","S3"],"Burleigh Waters":["S3","S3"],"Carrara":["C2","C2"],"Clagiraba":["H","H"],"Clear Island Waters":["C1","C1"],"Coolangatta":["S1","S1"],"Coombabah":["N2","N1"],"Coomera":["N4","N3"],"Currumbin":["S1","S1"],"Currumbin Valley":["S2","S2"],"Currumbin Waters":["S1","S1"],"Elanora":["S2","S2"],"Gaven":["N3","N2"],"Gilston":["C2","C2"],"Guanaba":["H","H"],"Helensvale":["N3","N2"],"Highland Park":["C2","C2"],"Hollywell":["N2","N1"],"Hope Island":["N3","N2"],"Jacobs Well":["N5","N3"],"Kingsholme":["N5","N3"],"Kirra":["S1","S1"],"Labrador":["N1","N1"],"Lower Beechmont":["H","H"],"Main Beach":["C2","C2"],"Maudsland":["N3","N2"],"Mermaid Beach":["C1","C1"],"Mermaid Waters":["C1","C1"],"Merrimac":["C1","C1"],"Miami":["S3","S3"],"Molendinar":["N1","N1"],"Mudgeeraba":["C1","C1"],"Natural Bridge":["H","H"],"Nerang":["C2","C2"],"Numinbah Valley":["H","H"],"Ormeau":["N5","N3"],"Ormeau Hills":["N5","N3"],"Oxenford":["N3","N2"],"Pacific Pines":["N3","N2"],"Palm Beach":["S2","S2"],"Paradise Point":["N2","N1"],"Parkwood":["N1","N1"],"Pimpama":["N5","N3"],"Reedy Creek":["S3","S3"],"Robina":["C1","C1"],"Runaway Bay":["N2","N1"],"Sanctuary Cove":["N3","N2"],"Southport":["N1","N1"],"Springbrook":["H","H"],"Stapylton":["N5","N3"],"Surfers Paradise":["C2","C2"],"Tallai":["C1","C1"],"Tallebudgera":["S2","S2"],"Tallebudgera Valley":["S2","S2"],"Tamborine Mountain":["H","H"],"Tugun":["S1","S1"],"Upper Coomera":["N4","N3"],"Varsity Lakes":["S3","S3"],"Willow Vale":["N4","N3"],"Wongawallan":["H","H"],"Worongary":["C1","C1"],"Yatala":["N5","N3"]};
const OOL_RATES = {"S1":[80,90,105,150,220],"S2":[90,100,110,160,230],"S3":[95,105,120,170,240],"C1":[110,120,130,180,250],"C2":[125,135,145,205,275],"N1":[125,135,150,205,275],"N2":[140,150,170,215,275],"N3":[145,155,175,220,275],"N4":[155,165,185,230,285],"N5":[165,175,195,240,295],"H":[175,190,210,275,300]};
const BNE_RATES = {"S1":[280,295,325,410,480],"S2":[265,280,310,395,460],"S3":[255,270,295,380,440],"C1":[245,260,280,365,440],"C2":[245,260,280,365,440],"N1":[235,245,265,350,400],"N2":[210,225,240,330,380],"N3":[195,210,225,300,350],"H":[300,320,350,400,480]};
const BM_ZONE = {"CBD":["Brisbane CBD","Spring Hill","Fortitude Valley","New Farm","Newstead","Teneriffe","Bowen Hills","Herston","Kelvin Grove","Paddington","Milton","Auchenflower","South Brisbane","West End","Highgate Hill","Kangaroo Point","East Brisbane","Woolloongabba","Dutton Park"],"BN1":["Hamilton","Ascot","Clayfield","Hendra","Albion","Nundah","Northgate","Banyo","Virginia","Wavell Heights","Kedron","Chermside","Stafford","Aspley","Geebung","Zillmere","Boondall","Taigum"],"BN2":["Sandgate","Brighton","Bracken Ridge","Bald Hills","Albany Creek","Eatons Hill","Strathpine","Brendale","Petrie","Kallangur","Murrumba Downs","Mango Hill","North Lakes","Deception Bay","Redcliffe","Scarborough","Margate","Clontarf"],"BE1":["Eagle Farm","Pinkenba","Murarrie","Cannon Hill","Morningside","Bulimba","Hawthorne","Balmoral","Tingalpa","Hemmant","Wynnum","Wynnum West","Manly","Lota","Carina"],"BE2":["Belmont","Gumdale","Wakerley","Capalaba","Birkdale","Thorneside","Alexandra Hills","Wellington Point","Ormiston","Cleveland","Thornlands","Victoria Point","Redland Bay"],"BS1":["Coorparoo","Camp Hill","Carina Heights","Carindale","Greenslopes","Holland Park","Mount Gravatt","Wishart","Mansfield","Annerley","Yeronga","Fairfield","Tarragindi","Moorooka","Salisbury"],"BS2":["Sunnybank","Sunnybank Hills","Robertson","Macgregor","Eight Mile Plains","Rochedale","Acacia Ridge","Calamvale","Parkinson","Browns Plains","Springwood","Underwood","Slacks Creek","Daisy Hill","Shailer Park","Logan Central","Woodridge"],"BW1":["Toowong","St Lucia","Taringa","Indooroopilly","Chapel Hill","Kenmore","Fig Tree Pocket","Graceville","Sherwood","Corinda","Oxley","Ashgrove","Bardon","Red Hill","The Gap","Enoggera","Mitchelton","Keperra","Ferny Grove"],"BW2":["Jindalee","Mount Ommaney","Sinnamon Park","Seventeen Mile Rocks","Darra","Richlands","Inala","Forest Lake","Wacol"],"BW3":["Springfield","Springfield Lakes","Brookwater","Augustine Heights","Goodna","Redbank","Redbank Plains","Moggill","Bellbowrie"],"BW4":["Ipswich","Booval","Bundamba","Ripley","Brassall","Karana Downs","Karalee"]};
const BM_RATES = {"CBD":[95,105,115,165,230],"BN1":[85,95,105,155,220],"BN2":[125,135,150,195,255],"BE1":[85,95,105,155,220],"BE2":[130,140,155,200,260],"BS1":[105,115,125,175,235],"BS2":[140,150,165,215,270],"BW1":[115,125,140,185,245],"BW2":[135,145,160,205,265],"BW3":[155,170,185,230,285],"BW4":[185,200,220,265,315]};
const BM_SUBURB = {}; Object.keys(BM_ZONE).forEach((z) => { BM_ZONE[z].forEach((s) => { BM_SUBURB[s] = z; }); });
/* Long-distance regional routes — Sunshine Coast, Toowoomba and Byron Bay.
   These MUST stay identical to LD_ZONE / LD_BNE_RATES / LD_OOL_RATES in the
   page, or the widget will quote a fare the Pay button then refuses. Priced
   per hub because OOL→Byron and BNE→Byron are not the same drive.
   Held with the page's LD_LIVE flag off: until that flips, the booking form
   never offers these destinations, so these tables are simply unreachable. */
const LD_ZONE = {"SC1":["Caloundra","Golden Beach","Pelican Waters","Currimundi","Wurtulla","Warana","Buddina","Minyama"],"SC2":["Mooloolaba","Alexandra Headland","Maroochydore","Cotton Tree","Sunshine Coast Airport (MCY)","Buderim","Sippy Downs","Mountain Creek","Kuluin"],"SC3":["Coolum Beach","Peregian Beach","Peregian Springs","Marcoola","Mudjimba","Twin Waters","Yaroomba"],"SC4":["Noosa Heads","Noosaville","Noosa Junction","Sunshine Beach","Sunrise Beach","Tewantin","Doonan","Eumundi"],"TWB":["Toowoomba","Highfields","Middle Ridge","Rangeville","Wilsonton","Kearneys Spring","Westbrook"],"BYR":["Byron Bay","Suffolk Park","Ewingsdale","Bangalow","Broken Head"]};
const LD_BNE_RATES = {"SC1":[280,295,320,390,450],"SC2":[305,320,350,425,495],"SC3":[330,345,380,460,535],"SC4":[375,395,430,525,615],"TWB":[395,415,455,550,640],"BYR":[450,475,520,630,735]};
const LD_OOL_RATES = {"BYR":[220,235,260,330,385]};
const LD_SUBURB = {}; Object.keys(LD_ZONE).forEach((z) => { LD_ZONE[z].forEach((s) => { LD_SUBURB[s] = z; }); });
const OOL = "Gold Coast Airport (OOL)", BNE = "Brisbane Airport (BNE)";
const CRUISE = "Brisbane Cruise Terminal (Pinkenba)", CRUISE_EXTRA = 25;
const VEHICLES = ["Sedan", "SUV", "Luxury Minivan", "Mercedes Sprinter 10-Seater", "Mercedes Sprinter 15-Seater"];
const CHILD_SEAT_PRICE = 15; // per seat, AUD
const TRAILER_PRICE = 30;    // luggage trailer, AUD

function computeFare(pickup, dropoff, vehicle) {
  const vi = VEHICLES.indexOf(vehicle);
  if (vi === -1) return null;
  if (pickup === dropoff) return null;
  const isHub = (p) => p === OOL || p === BNE || p === CRUISE;
  const bump = pickup === CRUISE || dropoff === CRUISE ? CRUISE_EXTRA : 0;
  if (isHub(pickup) && isHub(dropoff)) {
    if ((pickup === BNE && dropoff === CRUISE) || (pickup === CRUISE && dropoff === BNE)) return BM_RATES["CBD"][vi]; // same as BNE <-> Brisbane CBD
    return BNE_RATES["S1"][vi] + bump; // OOL <-> BNE / cruise terminal
  }
  const hub = isHub(pickup) ? pickup : isHub(dropoff) ? dropoff : null;
  const suburb = isHub(pickup) ? dropoff : pickup;
  if (!hub) return null; // point-to-point → quoted manually, not payable here
  const bneLike = hub === BNE || hub === CRUISE;
  if (SUBURBS[suburb]) {
    const [zOol, zBne] = SUBURBS[suburb];
    return bneLike ? BNE_RATES[zBne][vi] + bump : OOL_RATES[zOol][vi];
  }
  if (BM_SUBURB[suburb] && bneLike) return BM_RATES[BM_SUBURB[suburb]][vi] + bump;
  if (LD_SUBURB[suburb]) {
    const ld = (bneLike ? LD_BNE_RATES : LD_OOL_RATES)[LD_SUBURB[suburb]];
    if (ld) return ld[vi] + bump;
    return null; // regional run with no fixed fare from this hub → quoted by hand
  }
  return null;
}

/* ---- minimum notice ----------------------------------------------------
   Six hours, matching the booking form and the FAQ. Enforced here as well as
   in the page because the page can be bypassed and because a fare quoted for
   a trip we cannot staff is worse than no quote at all.
   This box runs in Singapore, so local time is useless: Brisbane is UTC+10
   all year, so the pick-up is turned into an absolute instant arithmetically.
   A missing or unparseable date is left alone — the form marks both fields
   required, and rejecting a booking over a date format is worse than taking
   it and letting dispatch see it. */
const MIN_LEAD_HOURS = 6;
const BNE_OFFSET_MS = 10 * 3600 * 1000;
function leadTimeShortfall(dateStr, timeStr) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  const t = /^(\d{1,2}):(\d{2})/.exec(timeStr || "");
  if (!d || !t) return null;
  const when = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]) - BNE_OFFSET_MS;
  const hours = (when - Date.now()) / 3600000;
  return hours >= MIN_LEAD_HOURS ? null : hours;
}
const LEAD_TIME_ERROR =
  `Online bookings need ${MIN_LEAD_HOURS} hours' notice (Brisbane time). ` +
  "For a pick-up sooner than that please call +61 481 437 772 — we take same-day transfers whenever a vehicle is free.";

// ---- Booking reference: ST-YYMMDD-XXXX (no confusable characters) ----
function makeRef(dateStr) {
  const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") ? dateStr.slice(2).replace(/-/g, "") : new Date().toISOString().slice(2, 10).replace(/-/g, "");
  return `ST-${d}-${code}`;
}

function niceDate(dateStr) {
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  } catch (e) { return dateStr; }
}

function extrasLabel(b) {
  return [b.childSeats > 0 ? `${b.childSeats} child seat${b.childSeats > 1 ? "s" : ""}` : "", b.trailer ? "Luggage trailer" : ""].filter(Boolean).join(", ") || "None";
}

// ---- Printable PDF confirmation (A4, Midnight & Champagne) ----
function bookingPdf(b, s) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = 595.28, L = 48, R = W - 48, CW = R - L;
    const NAVY = "#101828", INK = "#141D30", GOLD = "#C9A227", GOLD_D = "#8E701C",
          GOLD_LT = "#D9B44A", MUTED = "#68707F", LINE = "#E5E0D2", SOFT = "#F6EED9", CREAM = "#F6F2E8";

    // ---------- Header band ----------
    doc.rect(0, 0, W, 118).fill(NAVY);
    if (HAS_LOGO) { try { doc.image(LOGO_PATH, R - 96, 22, { fit: [96, 74] }); } catch (e) {} }
    doc.font("Times-Roman").fontSize(26).fillColor(CREAM).text("SKY TRANSFERS", L, 34, { characterSpacing: 4 });
    doc.font("Helvetica-Bold").fontSize(9).fillColor(GOLD_LT)
      .text(b.paid ? "BOOKING CONFIRMED — PAID" : "BOOKING CONFIRMATION", L, 70, { characterSpacing: 2.5 });
    doc.font("Helvetica").fontSize(8.5).fillColor("#98A0B0")
      .text("Gold Coast & Brisbane private airport transfers", L, 86);
    doc.rect(0, 118, W, 3).fill(GOLD);

    // ---------- Reference / status ----------
    let y = 146;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("BOOKING REFERENCE", L, y, { characterSpacing: 1.5 });
    doc.font("Helvetica-Bold").fontSize(17).fillColor(INK).text(b.ref || "—", L, y + 12);
    const pill = b.paid ? "PAID IN FULL" : "AWAITING CONFIRMATION";
    doc.font("Helvetica-Bold").fontSize(8);
    const pillW = doc.widthOfString(pill) + 24;
    doc.roundedRect(R - pillW, y + 8, pillW, 20, 10).fill(b.paid ? "#1E7F4F" : SOFT);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(b.paid ? "#FFFFFF" : GOLD_D)
      .text(pill, R - pillW, y + 14, { width: pillW, align: "center", characterSpacing: 1 });

    // ---------- Trip card ----------
    y += 48;
    const rows = [
      ["ROUTE", `${b.pickup}   →   ${b.dropoff}`],
      ["DATE", `${niceDate(b.date)} at ${b.time}`],
      ["VEHICLE", b.vehicle],
      ["PASSENGERS", String(b.pax || "—")],
      b.flight ? ["FLIGHT", b.flight] : null,
      b.address ? ["PICK-UP / DROP-OFF ADDRESS", b.address] : null,
      ["LEAD PASSENGER", `${b.name}   ·   ${b.phone}`],
      ["EXTRAS", extrasLabel(b)],
    ].filter(Boolean);

    doc.font("Helvetica").fontSize(10.5);
    const rowH = [];
    rows.forEach(([lab, val]) => {
      const h = doc.heightOfString(val, { width: CW - 190 });
      rowH.push(Math.max(30, h + 18));
    });
    const cardH = rowH.reduce((a, c) => a + c, 0) + 8;
    doc.roundedRect(L, y, CW, cardH, 8).lineWidth(1).strokeColor(LINE).stroke();
    let ry = y + 4;
    rows.forEach(([lab, val], i) => {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED).text(lab, L + 18, ry + 10, { characterSpacing: 1.2, width: 150 });
      doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(val, L + 172, ry + 8, { width: CW - 190 });
      ry += rowH[i];
      if (i < rows.length - 1) doc.moveTo(L + 18, ry).lineTo(R - 18, ry).lineWidth(0.5).strokeColor(LINE).stroke();
    });

    // ---------- Total band ----------
    y += cardH + 16;
    doc.roundedRect(L, y, CW, 46, 8).fill(SOFT);
    doc.rect(L, y + 4, 3, 38).fill(GOLD);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(GOLD_D).text("TOTAL · AUD, GST INCLUSIVE", L + 20, y + 18, { characterSpacing: 1.2 });
    doc.font("Times-Roman").fontSize(24).fillColor(INK)
      .text(`$${s.total}`, L, y + 10, { width: CW - 20, align: "right" });
    doc.font("Helvetica").fontSize(8).fillColor(MUTED)
      .text(b.paid ? "Paid by card via Stripe" : "Payment taken on confirmation", L, y + 34, { width: CW - 20, align: "right" });

    // ---------- Included ----------
    y += 66;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("INCLUDED WITH EVERY TRANSFER", L, y, { characterSpacing: 1.5 });
    y += 14;
    const inc = [
      "Meet & greet — your chauffeur waits at arrivals with a name board",
      "Flight tracking with 30 minutes' free airport waiting (60 min international at BNE)",
      "Free changes and cancellation up to 24 hours before pick-up",
      "No surge pricing — the fare above is final",
    ];
    inc.forEach((t) => {
      doc.circle(L + 4, y + 5, 1.8).fill(GOLD);
      doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(t, L + 14, y, { width: CW - 14 });
      y += 16;
    });

    // ---------- Note ----------
    y += 8;
    if (!b.paid) {
      doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED)
        .text("This is a booking request. We confirm your chauffeur by email, usually within the hour, and send driver details before pick-up.", L, y, { width: CW });
      y += 28;
    }

    // ---------- Footer band ----------
    const FY = 841.89 - 74;
    doc.rect(0, FY, W, 74).fill(NAVY);
    doc.rect(0, FY, W, 2).fill(GOLD);
    doc.font("Times-Roman").fontSize(13).fillColor(CREAM).text("SKY TRANSFERS", L, FY + 16, { characterSpacing: 3 });
    doc.font("Helvetica").fontSize(8.5).fillColor("#98A0B0")
      .text("24/7  ·  +61 481 437 772  ·  info@skytransfers.com.au  ·  www.skytransfers.com.au", L, FY + 36);
    doc.font("Helvetica").fontSize(8.5).fillColor(GOLD_LT)
      .text(`Ref ${b.ref || ""}`, L, FY + 16, { width: CW, align: "right" });

    doc.end();
  });
}

// ---- Branded HTML email (guest-facing) ----
function esc(t) { return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function bookingEmailHtml(b, s) {
  const row = (label, value) => value ? `
    <tr>
      <td style="padding:10px 0 2px;font:700 10px/1.4 Arial,sans-serif;letter-spacing:1.5px;color:#68707F;">${label}</td>
    </tr>
    <tr>
      <td style="padding:0 0 10px;font:400 15px/1.5 Georgia,serif;color:#141D30;border-bottom:1px solid #EDE8DA;">${esc(value)}</td>
    </tr>` : "";
  const paid = !!b.paid;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F7F4ED;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4ED;padding:0;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:10px;overflow:hidden;border:1px solid #E5E0D2;">

    <!-- Header -->
    <tr><td style="background:#101828;padding:30px 36px 24px;border-bottom:3px solid #C9A227;" align="center">
      <img src="cid:stlogo" alt="SKY TRANSFERS" height="76" style="height:76px;display:block;margin:0 auto 4px;font:400 22px Georgia,serif;letter-spacing:5px;color:#F6F2E8;">
      <div style="font:700 10px Arial,sans-serif;letter-spacing:3px;color:#D9B44A;padding-top:10px;">
        ${paid ? "BOOKING CONFIRMED &amp; PAID" : "BOOKING REQUEST RECEIVED"}</div>
    </td></tr>

    <!-- Reference -->
    <tr><td style="padding:26px 36px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td>
          <div style="font:700 10px Arial,sans-serif;letter-spacing:1.5px;color:#68707F;">BOOKING REFERENCE</div>
          <div style="font:700 20px Arial,sans-serif;color:#141D30;padding-top:2px;">${esc(b.ref)}</div>
        </td>
        <td align="right" style="vertical-align:middle;">
          <span style="display:inline-block;padding:6px 14px;border-radius:12px;font:700 10px Arial,sans-serif;letter-spacing:1px;${paid ? "background:#1E7F4F;color:#FFFFFF;" : "background:#F6EED9;color:#8E701C;"}">${paid ? "PAID IN FULL" : "AWAITING CONFIRMATION"}</span>
        </td>
      </tr></table>
    </td></tr>

    <!-- Greeting -->
    <tr><td style="padding:18px 36px 6px;font:400 15px/1.6 Georgia,serif;color:#333B4C;">
      Hi ${esc(b.name)},<br><br>
      ${paid
        ? "Payment received — your transfer is confirmed. Your printable confirmation is attached, and we'll send your chauffeur's name and mobile number before pick-up."
        : "Thank you for booking with Sky Transfers. Here are your trip details — we'll confirm your chauffeur by email, usually within the hour."}
    </td></tr>

    <!-- Details -->
    <tr><td style="padding:10px 36px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${row("ROUTE", `${b.pickup}  →  ${b.dropoff}`)}
        ${row("DATE &amp; TIME", `${niceDate(b.date)} at ${b.time}`)}
        ${row("VEHICLE", b.vehicle)}
        ${row("PASSENGERS", b.pax)}
        ${row("FLIGHT", b.flight)}
        ${row("PICK-UP / DROP-OFF ADDRESS", b.address)}
        ${row("EXTRAS", extrasLabel(b))}
      </table>
    </td></tr>

    <!-- Total -->
    <tr><td style="padding:18px 36px 6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6EED9;border-radius:8px;border-left:4px solid #C9A227;">
        <tr>
          <td style="padding:16px 20px;font:700 11px Arial,sans-serif;letter-spacing:1.5px;color:#8E701C;">TOTAL &middot; AUD, GST INCL.</td>
          <td align="right" style="padding:16px 20px;font:400 26px Georgia,serif;color:#141D30;">$${s.total}</td>
        </tr>
      </table>
      <div style="font:400 12px Arial,sans-serif;color:#68707F;padding-top:8px;text-align:right;">
        ${paid ? "Paid securely by card via Stripe." : "No payment taken yet — we take payment when your booking is confirmed."}</div>
    </td></tr>

    <!-- What's included -->
    <tr><td style="padding:14px 36px 4px;">
      <div style="font:700 10px Arial,sans-serif;letter-spacing:1.5px;color:#68707F;padding-bottom:8px;">INCLUDED WITH EVERY TRANSFER</div>
      <div style="font:400 13.5px/1.9 Arial,sans-serif;color:#333B4C;">
        <span style="color:#C9A227;">&#9679;</span>&nbsp; Meet &amp; greet with a name board at arrivals<br>
        <span style="color:#C9A227;">&#9679;</span>&nbsp; Flight tracking &middot; 30 min free waiting (60 min international at BNE)<br>
        <span style="color:#C9A227;">&#9679;</span>&nbsp; Free changes &amp; cancellation to 24 hours before pick-up<br>
        <span style="color:#C9A227;">&#9679;</span>&nbsp; Fixed fare — no surge pricing, ever
      </div>
    </td></tr>

    <!-- Contact -->
    <tr><td style="padding:20px 36px 8px;font:400 13.5px/1.7 Arial,sans-serif;color:#333B4C;">
      Questions or changes? Reply to this email or call/text us any time on
      <a href="tel:+61481437772" style="color:#8E701C;font-weight:700;text-decoration:none;">+61&nbsp;481&nbsp;437&nbsp;772</a> — we're on 24/7.
    </td></tr>

    <!-- Review CTA -->
    <tr><td align="center" style="padding:16px 36px 28px;">
      <a href="${REVIEW_URL}" style="display:inline-block;background:#C9A227;color:#141D30;font:700 14px Arial,sans-serif;padding:12px 26px;border-radius:8px;text-decoration:none;">&#9733; Enjoyed the ride? Leave us a Google review</a>
    </td></tr>

    <!-- Footer -->
    <tr><td style="background:#101828;padding:22px 36px;border-top:2px solid #C9A227;" align="center">
      <div style="font:400 15px Georgia,serif;letter-spacing:3px;color:#F6F2E8;">SKY TRANSFERS</div>
      <div style="font:400 11.5px/1.8 Arial,sans-serif;color:#98A0B0;padding-top:6px;">
        Gold Coast &amp; Brisbane private airport transfers<br>
        24/7 &middot; +61 481 437 772 &middot; <a href="mailto:info@skytransfers.com.au" style="color:#D9B44A;text-decoration:none;">info@skytransfers.com.au</a> &middot; <a href="https://www.skytransfers.com.au" style="color:#D9B44A;text-decoration:none;">skytransfers.com.au</a>
      </div>
    </td></tr>

  </table>
</td></tr>
</table>
</body></html>`;
}

function guestAttachments(pdf) {
  const a = [];
  if (pdf) a.push({ filename: "SkyTransfers-Booking.pdf", content: pdf });
  if (HAS_LOGO) a.push({ filename: "logo.png", path: LOGO_PATH, cid: "stlogo", contentDisposition: "inline" });
  return a;
}

// ---- Zapier -> Limo Anywhere dispatch hand-off ----
function postToZapier(b, s) {
  if (!process.env.ZAPIER_HOOK_URL) return Promise.resolve();
  return fetch(process.env.ZAPIER_HOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...b, total: s.total, summary: s.text, source: "skytransfers.com.au" }),
  }).catch((e) => console.error("Zapier post failed:", e.message));
}

function bookingSummary(b, fare, seats, trailer) {
  const total = fare + seats * CHILD_SEAT_PRICE + (trailer ? TRAILER_PRICE : 0);
  return {
    total,
    text: [
      `Booking reference: ${b.ref || "-"}`,
      `Route: ${b.pickup} -> ${b.dropoff}`,
      `Vehicle: ${b.vehicle}`,
      `Fare: $${fare} one-way`,
      `Baby/child seats: ${seats} ($${CHILD_SEAT_PRICE} each)`,
      `Luggage trailer: ${trailer ? `YES (+$${TRAILER_PRICE})` : "No"}`,
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

app.post("/request-booking", async (req, res) => {
  try {
    if (!mailer) return res.status(500).json({ error: "Email is not configured on the server" });
    const b = req.body || {};
    if (!b.pickup || !b.dropoff || !b.vehicle || !b.date || !b.name || !b.phone || !b.email) {
      return res.status(400).json({ error: "Missing booking details" });
    }
    const fare = computeFare(b.pickup, b.dropoff, b.vehicle);
    if (fare == null) return res.status(400).json({ error: "This route needs a manual quote — please email or call us." });
    if (leadTimeShortfall(b.date, b.time) !== null) return res.status(400).json({ error: LEAD_TIME_ERROR });
    const seats = Math.min(Math.max(parseInt(b.childSeats, 10) || 0, 0), 3);
    const trailer = b.trailer === true || b.trailer === "true";
    b.ref = makeRef(b.date);
    const s = bookingSummary(b, fare, seats, trailer);
    const full = { ...b, childSeats: seats, trailer, paid: false };
    const pdf = await bookingPdf(full, s).catch((e) => { console.error("PDF failed:", e.message); return null; });

    // 1) to Sky Transfers (plain text — the dispatch automation reads this format)
    await mailer.sendMail({
      from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`,
      to: BOOKINGS_EMAIL,
      replyTo: b.email,
      subject: `NEW Booking request: ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time}) [${b.ref}]`,
      text: `NEW BOOKING REQUEST — Sky Transfers website\n\n${s.text}`,
      attachments: pdf ? [{ filename: "SkyTransfers-Booking.pdf", content: pdf }] : [],
    });
    // 2) branded confirmation to the guest
    await mailer.sendMail({
      from: `"Sky Transfers" <${process.env.GMAIL_USER}>`,
      to: b.email,
      replyTo: BOOKINGS_EMAIL,
      subject: `Booking request received — Sky Transfers · ${b.ref}`,
      text:
        `Hi ${b.name},\n\nThanks for your booking request with Sky Transfers.\n\n${s.text}\n\n` +
        `This is a request, not a confirmed booking yet — we'll reply shortly (usually within the hour) to confirm your chauffeur.\n\n` +
        `Need anything in the meantime? Call or text +61 481 437 772.\n\n` +
        `Sky Transfers — Gold Coast & Brisbane airport transfers\nwww.skytransfers.com.au`,
      html: bookingEmailHtml(full, s),
      attachments: guestAttachments(pdf),
    });
    postToZapier(full, s);
    res.json({ ok: true, total: s.total, ref: b.ref });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send the booking request" });
  }
});

app.post("/create-checkout", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Payments are not configured on the server" });
    const b = req.body || {};
    const fare = computeFare(b.pickup, b.dropoff, b.vehicle);
    if (fare == null) {
      return res.status(400).json({ error: "This route needs a manual quote — please email or call us." });
    }
    if (leadTimeShortfall(b.date, b.time) !== null) {
      return res.status(400).json({ error: LEAD_TIME_ERROR });
    }
    const seats = Math.min(Math.max(parseInt(b.childSeats, 10) || 0, 0), 3);
    const ref = makeRef(b.date);
    const lineItems = [{
      price_data: {
        currency: "aud",
        unit_amount: fare * 100,
        product_data: {
          name: `Airport transfer — ${b.vehicle}`,
          description: `${b.pickup} → ${b.dropoff} · ${b.date} ${b.time} · Ref ${ref}`,
        },
      },
      quantity: 1,
    }];
    if (seats > 0) {
      lineItems.push({
        price_data: {
          currency: "aud",
          unit_amount: CHILD_SEAT_PRICE * 100,
          product_data: { name: "Baby / child seat" },
        },
        quantity: seats,
      });
    }
    if (b.trailer === true || b.trailer === "true") {
      lineItems.push({
        price_data: {
          currency: "aud",
          unit_amount: TRAILER_PRICE * 100,
          product_data: { name: "Luggage trailer" },
        },
        quantity: 1,
      });
    }
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // Card only, on purpose. Left unset, Stripe falls back to automatic
      // payment methods and offers everything enabled on the account — which
      // put Link first, asking the guest for a phone number and an SMS code
      // before they could simply type a card. Naming "card" also keeps Apple
      // Pay and Google Pay (both ride on the card method), which is exactly
      // what the site's FAQ promises. To offer Afterpay/Zip later, add them
      // here deliberately rather than reverting to automatic.
      payment_method_types: ["card"],
      line_items: lineItems,
      customer_email: b.email || undefined,
      metadata: {
        ref,
        pickup: String(b.pickup || ""), dropoff: String(b.dropoff || ""),
        vehicle: String(b.vehicle || ""), date: String(b.date || ""),
        time: String(b.time || ""), pax: String(b.pax || ""),
        flight: String(b.flight || ""), child_seats: String(seats),
        trailer: b.trailer === true || b.trailer === "true" ? "yes" : "no",
        passenger_name: String(b.name || ""), phone: String(b.phone || ""),
        pickup_address: String(b.address || ""),
        notes: String(b.notes || "").slice(0, 450),
      },
      success_url: process.env.SUCCESS_URL || "https://www.skytransfers.com.au/?booking=confirmed",
      cancel_url: process.env.CANCEL_URL || "https://www.skytransfers.com.au/?booking=cancelled",
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not start payment" });
  }
});


// ---- Stripe webhook: fires when a card payment succeeds ----
app.post("/stripe-webhook", async (req, res) => {
  try {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(400).send("not configured");
    const event = stripe.webhooks.constructEvent(req.rawBody, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
    if (event.type === "checkout.session.completed") {
      const sess = event.data.object;
      const m = sess.metadata || {};
      const b = {
        ref: m.ref || makeRef(m.date),
        pickup: m.pickup, dropoff: m.dropoff, vehicle: m.vehicle, date: m.date, time: m.time,
        pax: m.pax, flight: m.flight, childSeats: parseInt(m.child_seats, 10) || 0,
        trailer: m.trailer === "yes", name: m.passenger_name, phone: m.phone,
        email: sess.customer_email || sess.customer_details?.email || "", address: m.pickup_address,
        notes: m.notes, paid: true,
      };
      const total = Math.round((sess.amount_total || 0) / 100);
      const s = { total, text: bookingSummary(b, 0, b.childSeats, b.trailer).text.replace(/Fare: \$0 one-way\n/, "").replace(/TOTAL: \$\d+/, `TOTAL: $${total} (PAID)`) };
      const pdf = await bookingPdf(b, s).catch((e) => { console.error("PDF failed:", e.message); return null; });
      if (mailer) {
        await mailer.sendMail({
          from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`,
          to: BOOKINGS_EMAIL, replyTo: b.email,
          subject: `PAID booking: ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time}) [${b.ref}]`,
          text: `PAID BOOKING — Sky Transfers website (Stripe)\n\n${s.text}`,
          attachments: pdf ? [{ filename: "SkyTransfers-Booking.pdf", content: pdf }] : [],
        });
        if (b.email) await mailer.sendMail({
          from: `"Sky Transfers" <${process.env.GMAIL_USER}>`,
          to: b.email, replyTo: BOOKINGS_EMAIL,
          subject: `Booking confirmed & paid — Sky Transfers · ${b.ref}`,
          text: `Hi ${b.name},\n\nPayment received — your transfer is confirmed. Your printable confirmation is attached.\n\n${s.text}\n\nWe track your flight and your chauffeur meets you with a name board. Free changes to 24 hours before pick-up: reply to this email or call +61 481 437 772.\n\nSky Transfers — Gold Coast & Brisbane airport transfers\nwww.skytransfers.com.au`,
          html: bookingEmailHtml(b, s),
          attachments: guestAttachments(pdf),
        });
      }
      postToZapier(b, s);
    }
    res.json({ received: true });
  } catch (err) {
    console.error("webhook error:", err.message);
    res.status(400).send("webhook error");
  }
});

const port = process.env.PORT || 4242;
app.listen(port, () => console.log(`Sky Transfers payment server on :${port}`));
/* ---------------------------------------------------------------------
   The agent portal. It lives in agent-portal.js and is handed the pieces
   this file already owns — the fare table, the lead-time rule, the mailer
   and the booking formatter — so agent bookings are priced by exactly the
   same code as public ones. Express accepts routes after listen(), so this
   sits at the end of the file. Needs DATABASE_URL and AGENT_SECRET; without
   them it switches itself off and everything above carries on unchanged.
   --------------------------------------------------------------------- */
require("./agent-portal")({
  app, computeFare, VEHICLES, leadTimeShortfall, LEAD_TIME_ERROR,
  makeRef, bookingSummary, mailer, BOOKINGS_EMAIL,
  PLACES_FOR_AGENTS: [OOL, BNE, CRUISE]
    .concat(Object.keys(SUBURBS).sort())
    .concat(Object.keys(BM_SUBURB).sort())
    .concat(Object.keys(LD_SUBURB).sort()),
});
/* The real fare for the Google Ads purchase conversion. Without it every
   booking reports as the conversion action's $1 default. */
require("./checkout-lookup")({ app });
