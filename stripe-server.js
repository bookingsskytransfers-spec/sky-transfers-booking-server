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

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const mailer = process.env.GMAIL_USER
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    })
  : null;
const BOOKINGS_EMAIL = process.env.BOOKINGS_EMAIL || "info@skytransfers.com.au";

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || true }));

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
    if ((pickup === BNE && dropoff === CRUISE) || (pickup === CRUISE && dropoff === BNE)) return null; // short hop, manual quote
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
  return null;
}


// ---- Printable PDF confirmation ----
function bookingPdf(b, s) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fillColor("#101828").fontSize(24).font("Times-Roman").text("SKY TRANSFERS", { characterSpacing: 3 });
    doc.moveDown(0.2).fontSize(10).fillColor("#8E701C").font("Helvetica-Bold")
      .text("BOOKING CONFIRMATION", { characterSpacing: 2 });
    doc.moveTo(56, doc.y + 8).lineTo(539, doc.y + 8).lineWidth(1.5).strokeColor("#C9A227").stroke();
    doc.moveDown(1.2);
    const row = (label, value) => {
      if (!value) return;
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#68707F").text(label, { continued: true, width: 480 });
      doc.font("Helvetica").fillColor("#141D30").text("  " + value);
      doc.moveDown(0.35);
    };
    row("Route", `${b.pickup}  →  ${b.dropoff}`);
    row("Date & time", `${b.date} at ${b.time}`);
    row("Vehicle", b.vehicle);
    row("Passengers", String(b.pax || ""));
    row("Flight", b.flight);
    row("Exact address", b.address);
    row("Passenger", `${b.name} · ${b.phone}`);
    row("Extras", [b.childSeats > 0 ? `${b.childSeats} child seat(s)` : "", b.trailer ? "luggage trailer" : ""].filter(Boolean).join(", ") || "None");
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#141D30").text(`Total: $${s.total} AUD (GST incl.)${b.paid ? " — PAID" : " — payment on confirmation"}`);
    doc.moveDown(1.2).font("Helvetica").fontSize(9).fillColor("#68707F")
      .text("Your chauffeur meets you with a name board. Airport pick-ups include 30 min free waiting after landing (60 min international). Free changes and cancellation to 24 hours before pick-up.")
      .moveDown(0.5)
      .text("Sky Transfers · 24/7 · +61 481 437 772 · info@skytransfers.com.au · www.skytransfers.com.au");
    doc.end();
  });
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
    const seats = Math.min(Math.max(parseInt(b.childSeats, 10) || 0, 0), 3);
    const trailer = b.trailer === true || b.trailer === "true";
    const s = bookingSummary(b, fare, seats, trailer);
    const subject = `Booking request: ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time})`;
    const pdf = await bookingPdf({ ...b, childSeats: seats, trailer, paid: false }, s).catch(() => null);
    const attachments = pdf ? [{ filename: "SkyTransfers-Booking.pdf", content: pdf }] : [];

    // 1) to Sky Transfers
    await mailer.sendMail({
      from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`,
      to: BOOKINGS_EMAIL,
      replyTo: b.email,
      subject: `NEW ${subject}`,
      text: `NEW BOOKING REQUEST — Sky Transfers website\n\n${s.text}`,
      attachments,
    });
    // 2) confirmation to the guest
    await mailer.sendMail({
      from: `"Sky Transfers" <${process.env.GMAIL_USER}>`,
      to: b.email,
      replyTo: BOOKINGS_EMAIL,
      subject: `We received your booking request — Sky Transfers (${b.date})`,
      text:
        `Hi ${b.name},\n\n` +
        `Thanks for your booking request with Sky Transfers. Here's what we received:\n\n${s.text}\n\n` +
        `This is a request, not a confirmed booking yet — we'll reply shortly (usually within the hour) to confirm your chauffeur.\n\n` +
        `Need anything in the meantime? Call or text +61 481 437 772.\n\n` +
        `Enjoyed the ride? A quick Google review helps other travellers find us:\nhttps://www.google.com/maps?cid=9657905201752242057\n\n` +
        `Sky Transfers — Gold Coast & Brisbane airport transfers\nwww.skytransfers.com.au`,
      attachments,
    });
    postToZapier({ ...b, childSeats: seats, trailer, paid: false }, s);
    res.json({ ok: true, total: s.total });
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
    const seats = Math.min(Math.max(parseInt(b.childSeats, 10) || 0, 0), 3);
    const lineItems = [{
      price_data: {
        currency: "aud",
        unit_amount: fare * 100,
        product_data: {
          name: `Airport transfer — ${b.vehicle}`,
          description: `${b.pickup} → ${b.dropoff} · ${b.date} ${b.time}`,
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
      line_items: lineItems,
      customer_email: b.email || undefined,
      metadata: {
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
        pickup: m.pickup, dropoff: m.dropoff, vehicle: m.vehicle, date: m.date, time: m.time,
        pax: m.pax, flight: m.flight, childSeats: parseInt(m.child_seats, 10) || 0,
        trailer: m.trailer === "yes", name: m.passenger_name, phone: m.phone,
        email: sess.customer_email || sess.customer_details?.email || "", address: m.pickup_address,
        notes: m.notes, paid: true,
      };
      const s = { total: Math.round((sess.amount_total || 0) / 100), text: bookingSummary(b, 0, b.childSeats, b.trailer).text.replace(/Fare: \$0 one-way\n/, "").replace(/TOTAL: \$\d+/, `TOTAL: $${Math.round((sess.amount_total || 0) / 100)} (PAID)`) };
      const pdf = await bookingPdf(b, s).catch(() => null);
      const attachments = pdf ? [{ filename: "SkyTransfers-Booking.pdf", content: pdf }] : [];
      if (mailer) {
        await mailer.sendMail({
          from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`,
          to: BOOKINGS_EMAIL, replyTo: b.email,
          subject: `PAID booking: ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time})`,
          text: `PAID BOOKING — Sky Transfers website (Stripe)\n\n${s.text}`, attachments,
        });
        if (b.email) await mailer.sendMail({
          from: `"Sky Transfers" <${process.env.GMAIL_USER}>`,
          to: b.email, replyTo: BOOKINGS_EMAIL,
          subject: `Booking confirmed & paid — Sky Transfers (${b.date})`,
          text: `Hi ${b.name},\n\nPayment received — your transfer is confirmed. Your printable confirmation is attached.\n\n${s.text}\n\nWe track your flight and your chauffeur meets you with a name board. Free changes to 24 hours before pick-up: reply to this email or call +61 481 437 772.\n\nEnjoyed the ride? A quick Google review helps other travellers find us:\nhttps://www.google.com/maps?cid=9657905201752242057\n\nSky Transfers — Gold Coast & Brisbane airport transfers\nwww.skytransfers.com.au`,
          attachments,
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
