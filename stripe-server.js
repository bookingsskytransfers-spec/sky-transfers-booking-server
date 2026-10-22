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
/* Sign in to Gmail once at start-up and say so in the log - nothing is sent.
   Every booking email depends on this connection, so a library upgrade or a
   revoked app password shows up in the deploy log, not in a lost booking. */
if (mailer && typeof mailer.verify === "function" && !process.env.SKIP_MAIL_VERIFY) {
  /* A check, never a crash: anything odd here is logged and start-up goes on. */
  try {
    const check = mailer.verify();
    if (check && typeof check.then === "function") {
      check
        .then(() => console.log("mail: Gmail sign-in OK (nodemailer " + require("nodemailer/package.json").version + ")"))
        .catch((e) => console.error("mail: Gmail sign-in FAILED - booking emails will not send:", (e && e.code) || "", (e && e.message) || e));
    }
  } catch (e) { console.error("mail: could not run the Gmail sign-in check:", e && e.message); }
}
const BOOKINGS_EMAIL = process.env.BOOKINGS_EMAIL || "info@skytransfers.com.au";
/* Filled in at the bottom of this file, where the agent portal is installed.
   The routes below run long after that, so reading it at request time is safe;
   it stays null when the portal is switched off and the saves become no-ops. */
let portal = null;
/* ops.js (dispatch) and billing.js (invoices, pay sheet), mounted at the end. */
let ops = null, billing = null;
const recordBooking = (b, s, status) => {
  if (!portal || !portal.saveWebBooking) return Promise.resolve();
  /* Always resolves. Callers may await it for ordering, but a database
     problem must never stop the emails the business actually runs on. */
  return portal.saveWebBooking(b, s, status)
    .catch((e) => console.error("web_bookings save failed:", e.message));
};
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
const OOL_RATES = {"S1":[80,90,100,105,115,165,240],"S2":[90,100,105,115,120,175,255],"S3":[95,105,115,120,130,185,265],"C1":[110,120,125,135,140,200,275],"C2":[125,135,140,150,155,225,305],"N1":[125,135,145,150,160,225,305],"N2":[140,150,160,170,180,235,305],"N3":[145,155,165,175,185,240,305],"N4":[155,165,175,185,195,255,315],"N5":[165,175,185,195,205,265,325],"H":[175,190,200,210,220,305,330]};
const BNE_RATES = {"S1":[280,295,310,320,335,450,530],"S2":[265,280,295,305,320,435,505],"S3":[255,270,280,295,305,420,485],"C1":[245,260,270,280,290,400,485],"C2":[245,260,270,280,290,400,485],"N1":[235,245,255,265,275,385,440],"N2":[210,225,235,240,250,365,420],"N3":[195,210,220,225,235,330,385],"H":[300,320,335,345,360,440,530]};
const BM_ZONE = {"CBD":["Brisbane CBD","Spring Hill","Fortitude Valley","New Farm","Newstead","Teneriffe","Bowen Hills","Herston","Kelvin Grove","Paddington","Milton","Auchenflower","South Brisbane","West End","Highgate Hill","Kangaroo Point","East Brisbane","Woolloongabba","Dutton Park"],"BN1":["Hamilton","Ascot","Clayfield","Hendra","Albion","Nundah","Northgate","Banyo","Virginia","Wavell Heights","Kedron","Chermside","Stafford","Aspley","Geebung","Zillmere","Boondall","Taigum"],"BN2":["Sandgate","Brighton","Bracken Ridge","Bald Hills","Albany Creek","Eatons Hill","Strathpine","Brendale","Petrie","Kallangur","Murrumba Downs","Mango Hill","North Lakes","Deception Bay","Redcliffe","Scarborough","Margate","Clontarf"],"BE1":["Eagle Farm","Pinkenba","Murarrie","Cannon Hill","Morningside","Bulimba","Hawthorne","Balmoral","Tingalpa","Hemmant","Wynnum","Wynnum West","Manly","Lota","Carina"],"BE2":["Belmont","Gumdale","Wakerley","Capalaba","Birkdale","Thorneside","Alexandra Hills","Wellington Point","Ormiston","Cleveland","Thornlands","Victoria Point","Redland Bay"],"BS1":["Coorparoo","Camp Hill","Carina Heights","Carindale","Greenslopes","Holland Park","Mount Gravatt","Wishart","Mansfield","Annerley","Yeronga","Fairfield","Tarragindi","Moorooka","Salisbury"],"BS2":["Sunnybank","Sunnybank Hills","Robertson","Macgregor","Eight Mile Plains","Rochedale","Acacia Ridge","Calamvale","Parkinson","Browns Plains","Springwood","Underwood","Slacks Creek","Daisy Hill","Shailer Park","Logan Central","Woodridge","Rochedale South","Priestdale","Kingston","Loganlea","Meadowbrook","Marsden","Crestmead","Berrinba","Heritage Park","Regents Park","Hillcrest","Forestdale","Boronia Heights","Loganholme","Tanah Merah","Cornubia"],"BS3":["Carbrook","Waterford","Waterford West","Bethania","Edens Landing","Holmview","Beenleigh","Eagleby","Mount Warren Park","Windaroo","Bannockburn","Bahrs Scrub","Belivah","Park Ridge","Park Ridge South","Munruben","Logan Reserve","Chambers Flat","Buccan"],"BS4":["Greenbank","Logan Village","Yarrabilba","Wolffdene","Lyons","Jimboomba","Flagstone","New Beith","North Maclean","South Maclean","Stockleigh","Cedar Grove","Cedar Creek","Cedar Vale","Woodhill","Undullah"],"BW1":["Toowong","St Lucia","Taringa","Indooroopilly","Chapel Hill","Kenmore","Fig Tree Pocket","Graceville","Sherwood","Corinda","Oxley","Ashgrove","Bardon","Red Hill","The Gap","Enoggera","Mitchelton","Keperra","Ferny Grove"],"BW2":["Jindalee","Mount Ommaney","Sinnamon Park","Seventeen Mile Rocks","Darra","Richlands","Inala","Forest Lake","Wacol"],"BW3":["Springfield","Springfield Lakes","Springfield Central","Spring Mountain","Brookwater","Augustine Heights","Goodna","Gailes","Camira","Carole Park","Bellbird Park","Collingwood Park","Riverview","Redbank","Redbank Plains","Moggill","Bellbowrie"],"BW4":["Ipswich","North Ipswich","East Ipswich","West Ipswich","Booval","Bundamba","Blackstone","Silkstone","Eastern Heights","Raceview","Yamanto","Flinders View","Deebing Heights","Churchill","One Mile","Leichhardt","Wulkuraka","Coalfalls","Sadliers Crossing","Woodend","Tivoli","Dinmore","Swanbank","White Rock","Ripley","South Ripley","Brassall","Karana Downs","Karalee","Chuwar","Barellan Point"],"BW5":["Rosewood","Walloon","Marburg","Karrabin","Thagoona","Haigslea","Grandchester","Amberley","Willowbank","Muirlea","Pine Mountain"],"BN3":["Narangba","Burpengary","Burpengary East","Morayfield","Caboolture","Caboolture South","Upper Caboolture","Elimbah","Wamuran","Beachmere"],"BN4":["Bribie Island","Bongaree","Bellara","Banksia Beach","White Patch","Woorim","Ningi","Sandstone Point","Godwin Beach","Toorbul","Donnybrook"]};
const BM_RATES = {"CBD":[95,105,110,120,125,180,255],"BN1":[85,95,100,110,115,170,240],"BN2":[125,135,145,150,160,215,280],"BE1":[85,95,100,110,115,170,240],"BE2":[130,140,150,155,165,220,285],"BS1":[105,115,120,130,135,195,260],"BS2":[140,150,160,165,175,235,295],"BS3":[155,170,180,185,195,255,315],"BS4":[185,200,210,220,230,290,345],"BW1":[115,125,135,140,150,205,270],"BW2":[135,145,155,160,170,225,290],"BW3":[155,170,180,185,195,255,315],"BW4":[185,200,210,220,230,290,345],"BW5":[225,240,250,265,275,340,395],"BN3":[165,180,190,195,205,265,325],"BN4":[225,240,250,265,275,340,395]};
const BM_SUBURB = {}; Object.keys(BM_ZONE).forEach((z) => { BM_ZONE[z].forEach((s) => { BM_SUBURB[s] = z; }); });
/* Brisbane metro -> Gold Coast Airport. A SEPARATE band map on purpose: the
   BM_ZONE bands are drawn around distance to Brisbane Airport and say nothing
   about distance to OOL. BS4 alone spans 68-133 km to the Gold Coast, which is
   ~$112 of real cost that reusing its band would have charged as one fare.
   These five bands are measured road distance to OOL and stop at ~140 km —
   beyond that (Caboolture, Bribie Island, Grandchester) stays quoted by hand,
   as OOL->Sunshine Coast already is. Fares sit on the same curve the live
   GC-suburb->BNE table follows ($1.73/km + $93), which independently predicts
   $275 for the 105 km BNE<->OOL run this file already charges $280 for.
   MUST stay identical to BM_OOL_ZONE / BM_OOL_RATES in the page. */
const BM_OOL_ZONE = {"OM1":["Bahrs Scrub","Bannockburn","Beenleigh","Belivah","Bethania","Buccan","Carbrook","Cedar Creek","Cornubia","Crestmead","Daisy Hill","Eagleby","Edens Landing","Holmview","Jimboomba","Kingston","Logan Central","Logan Village","Loganholme","Loganlea","Marsden","Meadowbrook","Mount Warren Park","Priestdale","Shailer Park","Slacks Creek","Springwood","Tanah Merah","Underwood","Waterford","Waterford West","Windaroo","Wolffdene","Woodridge"],"OM2":["Acacia Ridge","Alexandra Hills","Annerley","Belmont","Berrinba","Boronia Heights","Browns Plains","Calamvale","Camp Hill","Capalaba","Carina Heights","Carindale","Cedar Grove","Cedar Vale","Chambers Flat","Cleveland","Dutton Park","Eight Mile Plains","Fairfield","Forest Lake","Forestdale","Greenslopes","Gumdale","Heritage Park","Hillcrest","Holland Park","Logan Reserve","Macgregor","Mansfield","Moorooka","Mount Gravatt","Ormiston","Park Ridge","Park Ridge South","Parkinson","Redland Bay","Regents Park","Robertson","Rochedale","Rochedale South","Salisbury","Stockleigh","Sunnybank","Sunnybank Hills","Tarragindi","Thornlands","Tingalpa","Victoria Point","Wakerley","Wishart","Woodhill","Woolloongabba","Yarrabilba"],"OM3":["Albion","Ascot","Ashgrove","Auchenflower","Augustine Heights","Balmoral","Bardon","Bellbird Park","Birkdale","Bowen Hills","Brisbane CBD","Brookwater","Bulimba","Camira","Cannon Hill","Carina","Carole Park","Chermside","Clayfield","Collingwood Park","Coorparoo","Corinda","Darra","Dinmore","Eagle Farm","East Brisbane","Enoggera","Fortitude Valley","Gailes","Goodna","Graceville","Greenbank","Hamilton","Hawthorne","Hemmant","Hendra","Herston","Highgate Hill","Inala","Indooroopilly","Jindalee","Kangaroo Point","Kedron","Kelvin Grove","Lota","Manly","Milton","Mitchelton","Morningside","Mount Ommaney","Munruben","Murarrie","New Beith","New Farm","Newstead","North Maclean","Northgate","Nundah","Oxley","Paddington","Pinkenba","Red Hill","Redbank","Richlands","Riverview","Seventeen Mile Rocks","Sherwood","Sinnamon Park","South Brisbane","South Maclean","Spring Hill","Spring Mountain","Springfield","Springfield Central","Springfield Lakes","St Lucia","Stafford","Taringa","Teneriffe","Thorneside","Toowong","Wacol","Wavell Heights","Wellington Point","West End","Wynnum","Wynnum West","Yeronga"],"OM4":["Albany Creek","Aspley","Banyo","Barellan Point","Bellbowrie","Blackstone","Boondall","Booval","Bracken Ridge","Brassall","Brighton","Bundamba","Chapel Hill","Churchill","Chuwar","Coalfalls","Deebing Heights","East Ipswich","Eastern Heights","Eatons Hill","Ferny Grove","Fig Tree Pocket","Flagstone","Flinders View","Geebung","Ipswich","Karalee","Karana Downs","Kenmore","Keperra","Muirlea","North Ipswich","Raceview","Redbank Plains","Ripley","Sadliers Crossing","Sandgate","Silkstone","South Ripley","Swanbank","Taigum","The Gap","Tivoli","Virginia","West Ipswich","White Rock","Woodend","Yamanto","Zillmere"],"OM5":["Amberley","Bald Hills","Brendale","Clontarf","Deception Bay","Haigslea","Kallangur","Karrabin","Leichhardt","Lyons","Mango Hill","Marburg","Margate","Moggill","Murrumba Downs","North Lakes","One Mile","Petrie","Pine Mountain","Redcliffe","Rosewood","Scarborough","Strathpine","Thagoona","Undullah","Walloon","Willowbank","Wulkuraka"]};
const BM_OOL_RATES = {"OM1":[225,235,245,255,265,360,420],"OM2":[255,270,280,290,300,410,475],"OM3":[275,290,300,315,325,440,515],"OM4":[300,315,330,345,355,480,560],"OM5":[320,335,350,365,380,515,600]};
const BM_OOL_SUBURB = {}; Object.keys(BM_OOL_ZONE).forEach((z) => { BM_OOL_ZONE[z].forEach((s) => { BM_OOL_SUBURB[s] = z; }); });
/* Long-distance regional routes — Sunshine Coast, Toowoomba and Byron Bay.
   These MUST stay identical to LD_ZONE / LD_BNE_RATES / LD_OOL_RATES in the
   page, or the widget will quote a fare the Pay button then refuses. Priced
   per hub because OOL→Byron and BNE→Byron are not the same drive.
   Held with the page's LD_LIVE flag off: until that flips, the booking form
   never offers these destinations, so these tables are simply unreachable. */
const LD_ZONE = {"SC1":["Caloundra","Golden Beach","Pelican Waters","Currimundi","Wurtulla","Warana","Buddina","Minyama"],"SC2":["Mooloolaba","Alexandra Headland","Maroochydore","Cotton Tree","Sunshine Coast Airport (MCY)","Buderim","Sippy Downs","Mountain Creek","Kuluin"],"SC3":["Coolum Beach","Peregian Beach","Peregian Springs","Marcoola","Mudjimba","Twin Waters","Yaroomba"],"SC4":["Noosa Heads","Noosaville","Noosa Junction","Sunshine Beach","Sunrise Beach","Tewantin","Doonan","Eumundi"],"TWB":["Toowoomba","East Toowoomba","North Toowoomba","South Toowoomba","Harristown","Darling Heights","Centenary Heights","Rangeville","Middle Ridge","Kearneys Spring","Wilsonton","Wilsonton Heights","Rockville","Harlaxton","Mount Lofty","Mount Kynoch","Prince Henry Heights","Redwood","Cranley","Glenvale","Torrington","Drayton","Cotswold Hills","Top Camp","Athol","Charlton","Wellcamp","Westbrook","Highfields","Blue Mountain Heights","Kleinton","Gowrie Junction","Meringandan West","Hodgson Vale","Vale View","Preston"],"BYR":["Byron Bay","Suffolk Park","Ewingsdale","Bangalow","Broken Head"]};
const LD_BNE_RATES = {"SC1":[280,295,305,320,330,430,495],"SC2":[305,320,335,345,360,470,545],"SC3":[330,345,360,375,390,505,590],"SC4":[375,395,410,425,440,580,675],"TWB":[395,415,430,450,465,605,705],"BYR":[450,475,495,510,530,695,810]};
const LD_OOL_RATES = {"BYR":[220,235,245,260,270,365,425]};
const LD_SUBURB = {}; Object.keys(LD_ZONE).forEach((z) => { LD_ZONE[z].forEach((s) => { LD_SUBURB[s] = z; }); });
const OOL = "Gold Coast Airport (OOL)", BNE = "Brisbane Airport (BNE)";
const CRUISE = "Brisbane Cruise Terminal (Pinkenba)", CRUISE_EXTRA = 25;
const VEHICLES = [
  "Sedan", "SUV", "People Mover", "Luxury Sedan", "Luxury Minivan",
  "Mercedes Sprinter 10-Seater", "Mercedes Sprinter 14-Seater", "Mercedes Sprinter 18-Seater"
];
/* The 18-seater is priced by hand for each job, so it has no column in the
   rate tables and must never reach Stripe with a computed fare. */
const QUOTE_ONLY = new Set(["Mercedes Sprinter 18-Seater"]);
/* Names that were live before 20 Sept 2026. A booking made seconds before the
   rename still has to price, so these stay here permanently. The fare comes
   from the current table, never the old one — the server price always wins. */
const VEHICLE_ALIASES = {
  "Mercedes Sprinter 15-Seater": "Mercedes Sprinter 14-Seater",
  /* Renamed 8 Oct 2026. It was never a coach - it is an 18-seat Sprinter. */
  "Mini Coach 18-Seater": "Mercedes Sprinter 18-Seater",
};
/* Hourly hire - a chauffeur and vehicle at the guest's disposal, booked from
   the homepage form like a transfer. Per hour by vehicle class, index-for-index
   with VEHICLES; the 18-seater stays quote-only. Three hours is the floor -
   below that two one-ways are the better product - and past six hours it is
   charter work with its own half-day and full-day rates. No evening loading:
   the product exists for nights out, so the same rate applies at any hour.
   MUST match HOURLY_RATES / HOURLY_HOURS in index.html. */
const HOURLY_RATES = [90, 100, 115, 125, 135, 160, 185, null];
const HOURLY_MIN_HOURS = 3, HOURLY_MAX_HOURS = 6;
/* A booking can be held for 1 to 16 hours, but only 3 to 6 has an online
   price (baseFareForBooking). Longer - or shorter - is charter work the office
   books from admin.html at an agreed total; past six hours it is worded as a
   charter on everything the guest sees (20 Oct 2026). */
const HIRE_MIN_HOURS = 1, HIRE_MAX_HOURS = 16;
function hourlyHours(b) {
  const h = b && b.hourly && parseInt(b.hourly.hours, 10);
  return Number.isInteger(h) && h >= HIRE_MIN_HOURS && h <= HIRE_MAX_HOURS ? h : null;
}
const isCharterHire = (b) => (hourlyHours(b) || 0) > HOURLY_MAX_HOURS;
/* "Charter — 8 hours as directed" / "By the hour — 4 hours as directed" */
const hireLabel = (b) => `${isCharterHire(b) ? "Charter" : "By the hour"} — ${hourlyHours(b)} hours as directed`;
/* What a hire includes - not the airport list (name board at arrivals,
   flight tracking), which is meaningless for a vehicle held by the hour.
   HTML-escaped for the email; the PDF unescapes &amp;. */
const includedForHire = (b) => [
  `Your own chauffeur and vehicle for the ${hourlyHours(b)} hours booked — never shared`,
  "Stops and changes of plan along the way, as you direct",
  "Free changes &amp; cancellation to 24 hours before pick-up",
  isCharterHire(b) ? "The agreed price above is final" : "No surge pricing — the fare above is final",
];
const CHILD_SEAT_PRICE = 15; // per seat, AUD
const TRAILER_PRICE = 30;    // luggage trailer, AUD

/* The fare for a booking of either kind. A point-to-point booking carries
   b.p2p with the two endpoints the page had priced; the module that prices
   them is mounted at the bottom of this file and assigned to `p2p` there,
   which is fine because this only ever runs inside a request. Without it, or
   without b.p2p, this is exactly computeFare. */
let p2p = null;
/* Airport transfers to an address with no zone fare, priced on road distance
   (km-routes.js). A booking priced that way carries b.km. */
let kmq = null;
/* Stops along the way (stops.js), priced by the extra distance they add. */
let stopsMod = null;
async function baseFareForBooking(b) {
  if (b && b.hourly) {
    const h = hourlyHours(b);
    const vi = VEHICLES.indexOf(VEHICLE_ALIASES[b.vehicle] || b.vehicle);
    const rate = vi === -1 ? null : HOURLY_RATES[vi];
    return h && h >= HOURLY_MIN_HOURS && h <= HOURLY_MAX_HOURS && rate ? rate * h : null;
  }
  if (b && b.p2p && p2p && typeof p2p.fareFor === "function") return p2p.fareFor(b);
  if (b && b.km && kmq && typeof kmq.fareFor === "function") return kmq.fareFor(b);
  return computeFare(b.pickup, b.dropoff, b.vehicle);
}
/* The fare, and - when the booking has stops - b.stopsExtra set for
   bookingSummary to add once on top. Stops that cannot be priced make the
   whole booking unpriceable, exactly like an unknown route: never guessed.
   Hourly hire is "as directed" already, so it has no stops. */
async function fareForBooking(b) {
  const fare = await baseFareForBooking(b);
  if (b) b.stopsExtra = 0;
  if (fare == null || !b || b.hourly || !Array.isArray(b.stops) || !b.stops.length) {
    if (b && b.hourly) b.stops = undefined;
    return fare;
  }
  if (!stopsMod) return null;
  return (await stopsMod.applyTo(b)) ? fare : null;
}

function computeFare(pickup, dropoff, vehicle) {
  const name = VEHICLE_ALIASES[vehicle] || vehicle;
  if (QUOTE_ONLY.has(name)) return null;
  const vi = VEHICLES.indexOf(name);
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
  if (BM_SUBURB[suburb]) {
    if (bneLike) return BM_RATES[BM_SUBURB[suburb]][vi] + bump;
    const om = BM_OOL_SUBURB[suburb];
    return om ? BM_OOL_RATES[om][vi] : null; // past ~140 km from OOL -> quoted by hand
  }
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

// ---- The two street addresses --------------------------------------------
/* From 20 Oct 2026 the booking forms ask for a pick-up address and a drop-off
   address separately (pickupAddress / dropoffAddress). Older pages, stored
   rows and payment links only have `address`: the street address of
   whichever end is not an airport, or both run together on a point-to-point
   trip. `address` is still sent and still printed in the dispatch text, so
   that text keeps its shape for the automation that reads it. */
const isHubPlace = (p) => p === OOL || p === BNE || p === CRUISE;
const cleanAddr = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, 300);
function tripAddresses(b) {
  let pu = cleanAddr(b && b.pickupAddress), dro = cleanAddr(b && b.dropoffAddress);
  const legacy = cleanAddr(b && b.address);
  if (!pu && !dro && legacy) {
    if (hourlyHours(b)) pu = legacy;
    else if (isHubPlace(b.pickup) && !isHubPlace(b.dropoff)) dro = legacy;
    else if (isHubPlace(b.dropoff) && !isHubPlace(b.pickup)) pu = legacy;
    else return { pu: "", dro: "", either: legacy };
  }
  return { pu, dro, either: "" };
}
/* The single line the dispatch text and older readers expect. */
function combinedAddress(b) {
  const a = tripAddresses(b);
  if (a.either) return a.either;
  return [a.pu && !isHubPlace(b.pickup) ? a.pu : "",
          a.dro && !hourlyHours(b) && !isHubPlace(b.dropoff) ? a.dro : ""].filter(Boolean).join(" to ");
}
/* Called on every way a booking comes in: tidies the two new fields and
   keeps `address` in step with them. */
function normaliseAddresses(b) {
  if (!b || typeof b !== "object") return b;
  if (b.pickupAddress != null || b.dropoffAddress != null) {
    b.pickupAddress = cleanAddr(b.pickupAddress);
    b.dropoffAddress = hourlyHours(b) ? "" : cleanAddr(b.dropoffAddress);
    const c = combinedAddress(b);
    if (c) b.address = c;
  }
  return b;
}

/* A charter's itinerary, typed into Notes as "2:30 pm Collect ... approx
   3:15 pm Arrive ...", as one line per time. Only splits where a time is
   followed by a capitalised word, and never after "approx" or inside a
   "9:15 - 9:30 pm" range, so a time mentioned mid-sentence stays put. */
function itineraryLines(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const parts = t.split(/(?<!approx\.?|[-–])\s(?=(?:approx\.?\s)?\d{1,2}(?::\d{2})?\s?(?:[-–]\s?\d{1,2}(?::\d{2})?\s?)?[ap]m\s[A-Z])/i);
  return parts.map((p) => {
    const m = /^((?:approx\.?\s)?\d{1,2}(?::\d{2})?\s?(?:[-–]\s?\d{1,2}(?::\d{2})?\s?)?[ap]m)\s(.*)$/i.exec(p);
    return m ? { when: m[1], what: m[2] } : { when: "", what: p };
  });
}

const COMPANY = {
  name: "Australia Wide Car Services Pty Ltd T/A Sky Transfers",
  ids: "ABN 22 680 932 003  ·  Operator accreditation OA 900595993  ·  BEA 279338",
};

/* Everything the PDF and the email both say, worked out once so the two can
   never disagree. */
function confirmationContent(b, s) {
  const ret = returnLeg(b);
  const hrs = hourlyHours(b);
  const charter = isCharterHire(b);
  const addr = tripAddresses(b);
  const seats = Math.max(0, parseInt(b.childSeats, 10) || 0);
  const trailer = b.trailer === true || b.trailer === "true";
  const legs = ret ? 2 : 1;
  const stops = Array.isArray(b.stops) ? b.stops.filter((x) => x && (x.address || x.suburb)) : [];
  /* deposit_due / deposit_paid: an office booking taking a deposit first */
  const state = b.paid && s.balance ? (s.deposit ? "deposit_paid" : "balance") : b.paid ? "paid"
    : b.confirmed ? (s.depositDue ? "deposit_due" : "confirmed") : "request";
  const pill = { balance: "PAID  ·  BALANCE DUE", paid: "CONFIRMED  ·  PAID", confirmed: "CONFIRMED  ·  PAYMENT DUE", request: "REQUEST RECEIVED",
                 deposit_due: "CONFIRMED  ·  DEPOSIT DUE", deposit_paid: "DEPOSIT PAID  ·  BALANCE DUE" }[state];
  const intro = {
    deposit_due: "Thank you for booking with Sky Transfers. Your booking is confirmed - a deposit secures it.",
    deposit_paid: "Thank you for booking with Sky Transfers. Your booking is confirmed and your deposit is paid.",
    balance: "Your booking has been updated. A balance is due - see below.",
    paid: "Thank you for booking with Sky Transfers. Your booking is confirmed and paid.",
    confirmed: "Thank you for booking with Sky Transfers. Your booking is confirmed.",
    request: "Thank you for booking with Sky Transfers. We'll confirm your chauffeur shortly, usually within the hour.",
  }[state];

  const service = hrs ? hireLabel(b)
    : ret ? "Return transfer - both legs on one booking"
    : (isHubPlace(b.pickup) || isHubPlace(b.dropoff)) ? "One-way airport transfer" : "One-way private transfer";
  const when = (d, t) => `${niceDate(d)} at ${t}`;
  const booking = [
    ["Service", service],
    ret ? ["Outbound", when(b.date, b.time)] : ["Date", niceDate(b.date)],
    ret ? ["Return", when(ret.date, ret.time)] : [hrs ? "Start time" : "Pick-up time", b.time],
    hrs ? ["Duration", `${hrs} hours, as directed`] : null,
    ["Vehicle", b.vehicle],
    ["Passengers", String(b.pax || "-")],
    b.flight ? [ret ? "Outbound flight" : "Flight", b.flight] : null,
    ret && ret.flight ? ["Return flight", ret.flight] : null,
  ].filter(Boolean);
  const passenger = [
    ["Lead passenger", b.name],
    ["Contact number", b.phone],
    b.email ? ["Email", b.email] : null,
  ].filter(Boolean);

  const endLine = (place, street) => street ? (isHubPlace(place) && street.indexOf(place) === -1 ? `${place} - ${street}` : street) : place;
  const trip = [
    ["Pick-up", endLine(b.pickup, addr.pu)],
    ...stops.map((x, i) => [`Stop ${i + 1}${ret ? " (outbound)" : ""}`, x.address || x.suburb]),
    hrs ? ["Finishes", addr.dro || "As directed"] : ["Drop-off", endLine(b.dropoff, addr.dro)],
    ret ? ["Return journey", `${addr.dro || b.dropoff} back to ${b.pickup}`] : null,
    addr.either ? ["Address", addr.either] : null,
    hrs && b.notes ? ["Plan for the day", { timeline: itineraryLines(b.notes) }] : null,
    !hrs && b.notes ? ["Notes", String(b.notes)] : null,
  ].filter(Boolean);

  /* The breakdown only when the figures are ours to state. On the paid path
     the total is what Stripe charged (a promotion code may be in it) and the
     fare is not passed in, so it is described in words instead. */
  const pay = [];
  const known = (s.transfer || 0) > 0;
  if (known) {
    if (hrs) pay.push([charter ? `Charter, ${hrs} hours` : `Hourly hire, ${hrs} hours`, `$${s.transfer}`]);
    else if (ret) pay.push(["Return transfer", `$${s.transfer}  (2 x $${Math.round((s.transfer + (s.saved || 0)) / 2)}, less ${Math.round(RETURN_DISCOUNT * 100)}% for the return)`]);
    else pay.push(["Transfer", `$${s.transfer}`]);
    if (s.stopsExtra > 0) pay.push(["Stops on the way", `$${s.stopsExtra}`]);
    if (seats) pay.push([`Child seat${seats > 1 ? "s" : ""} x ${seats}`, `$${seats * CHILD_SEAT_PRICE * legs}` +
      (seats > 1 || ret ? `  ($${CHILD_SEAT_PRICE} each${ret ? ", each leg" : ""})` : "")]);
    if (trailer) pay.push(["Luggage trailer", `$${TRAILER_PRICE * legs}${ret ? "  (each leg)" : ""}`]);
  } else {
    if (hrs) pay.push([charter ? `Charter, ${hrs} hours` : `Hourly hire, ${hrs} hours`, "Agreed price"]);
    else if (ret) pay.push(["Return transfer", `Both legs${seats || trailer ? ", extras each leg" : ""}, ${Math.round(RETURN_DISCOUNT * 100)}% return discount included`]);
    const ex = extrasLabel(b);
    if (!hrs && ex !== "None") pay.push(["Extras", ex + (ret ? " (each leg)" : "")]);
  }
  if (state === "deposit_due") {
    pay.push([`Deposit due now (${s.depositPct}%)`, `$${s.depositDue}`]);
    pay.push(["Balance, paid later", `$${s.total - s.depositDue}`]);
  } else if (state === "deposit_paid") {
    pay.push(["Paid so far", `$${s.total - s.balance} by card`]);
    pay.push(["Balance to pay", `$${s.balance}`]);
  }
  const status = state === "deposit_due" ? `Deposit of $${s.depositDue} due now - pay with the link in your confirmation email. The $${s.total - s.depositDue} balance is paid later; we'll send you a link.`
    : state === "deposit_paid" ? (s.balanceLink ? `Deposit paid. $${s.balance} balance to pay with the link in your email.`
                                                : `Deposit paid. $${s.balance} balance to pay - we'll send you a secure link for it.`)
    : state === "balance" ? `Paid $${s.total - s.balance} by card. $${s.balance} balance to pay with the link in your email.`
    : state === "paid" && s.refund ? `Paid by card. $${s.refund} refunded to your card.`
    : state === "paid" ? "Paid in full. Nothing to pay the chauffeur."
    : state === "confirmed" ? "Payment due. Pay securely with the link in your confirmation email."
    : "No payment taken yet. We confirm your chauffeur first.";

  const good = hrs ? [
    `Your own chauffeur and vehicle for the ${hrs} hours booked - never shared.`,
    "Your chauffeur stays with the vehicle and follows your plan; changes on the day are fine.",
    "Free changes and cancellation up to 24 hours before the start time.",
  ] : (isHubPlace(b.pickup) || isHubPlace(b.dropoff)) ? [
    "Meet & greet: at the airport your chauffeur waits in arrivals with a name board.",
    "We track your flight. 30 minutes' free waiting after landing (60 minutes international at BNE).",
    "Free changes and cancellation up to 24 hours before pick-up.",
  ] : [
    "A private car and chauffeur - never shared, never a shuttle.",
    "A fixed fare: no surge pricing, the same price at any hour.",
    "Free changes and cancellation up to 24 hours before pick-up.",
  ];
  return { state, pill, intro, booking, passenger, trip, tripTitle: hrs ? "Itinerary" : "Trip details", pay, status, good, total: s.total };
}

// ---- Printable PDF confirmation (A4) ----
/* Redesigned 20 Oct 2026 after Aman compared ours with the Hughes (Equity
   Transport Group) confirmation: the guest's name first, labelled sections
   with a navy bar, label on the left and the detail on the right, pick-up
   and drop-off on their own lines, and the company's legal details in the
   footer. Base-14 Helvetica only - it covers WinAnsi, so no arrows. */
function bookingPdf(b, s) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      const c = confirmationContent(b, s);
      const W = 595.28, H = 841.89, L = 40, R = W - 40, CW = R - L, LABEL_W = 150, FY = H - 66;
      const NAVY = "#101828", INK = "#141D30", TEXT = "#333B4C", MUTED = "#68707F", GOLD = "#C9A227", GOLD_D = "#8E701C",
            GOLD_LT = "#D9B44A", LINE = "#E9DFC6", SOFT = "#F6EED9", CREAM = "#F6F2E8", OK = "#1E7F4F", WARN = "#9C6A0E";
      const pillColour = { paid: OK, balance: WARN, confirmed: WARN, request: GOLD_D, deposit_due: WARN, deposit_paid: WARN }[c.state];

      const header = (first) => {
        doc.rect(0, 0, W, first ? 92 : 56).fill(NAVY);
        if (HAS_LOGO) { try { doc.image(LOGO_PATH, L, first ? 14 : 8, { fit: first ? [92, 64] : [60, 40] }); } catch (e) {} }
        doc.font("Helvetica-Bold").fontSize(9).fillColor(GOLD_LT)
          .text(c.state === "request" ? "BOOKING REQUEST" : "BOOKING CONFIRMATION", L, first ? 30 : 14, { width: CW, align: "right", characterSpacing: 2.2, lineBreak: false });
        doc.font("Helvetica-Bold").fontSize(first ? 18 : 12).fillColor("#FFFFFF").text(b.ref || "-", L, first ? 44 : 28, { width: CW, align: "right", lineBreak: false });
        doc.rect(0, first ? 92 : 56, W, 3).fill(GOLD);
      };
      header(true);
      let y = 112;
      doc.font("Helvetica-Bold").fontSize(19).fillColor(INK).text(b.name || "", L, y, { width: CW - 190 });
      doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(c.intro, L, doc.y + 2, { width: CW - 190 });
      const introEnd = doc.y;
      doc.font("Helvetica-Bold").fontSize(8.5);
      const pw = doc.widthOfString(c.pill, { characterSpacing: 1 }) + 26;
      doc.roundedRect(R - pw, y + 4, pw, 22, 11).fill(pillColour);
      doc.fillColor("#FFFFFF").text(c.pill, R - pw, y + 11, { width: pw, align: "center", characterSpacing: 1, lineBreak: false });
      y = Math.max(introEnd, y + 30) + 14;

      /* a section that does not fit starts on a new page, under a short header */
      const fit = (h) => { if (y + h > FY - 12) { doc.addPage({ size: "A4", margin: 0 }); header(false); y = 76; } };
      const vw = CW - LABEL_W - 24;
      const rowHeight = (r) => {
        if (r.timeline) {
          doc.font("Helvetica").fontSize(9.5);
          return r.timeline.reduce((a, l) => a + doc.heightOfString(l.what, { width: vw - 92 }) + 4, 0) + 9;
        }
        doc.font(r.bold ? "Helvetica-Bold" : "Helvetica").fontSize(r.big ? 15 : 9.5);
        return Math.max(19, doc.heightOfString(String(r.value), { width: vw }) + 9);
      };
      const section = (title, rows) => {
        rows = rows.map((r) => (Array.isArray(r) ? (r[1] && r[1].timeline ? { label: r[0], timeline: r[1].timeline } : { label: r[0], value: r[1] }) : r))
          .filter((r) => r && (r.timeline ? r.timeline.length : r.value != null && String(r.value) !== ""));
        if (!rows.length) return;
        const hs = rows.map(rowHeight);
        fit(20 + hs.reduce((a, h) => a + h, 0) + 11);
        doc.roundedRect(L, y, CW, 20, 5).fill(NAVY);
        doc.rect(L + 12, y + 7, 6, 6).fill(GOLD);
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#FFFFFF").text(title, L + 26, y + 5.5, { characterSpacing: 0.4, lineBreak: false });
        y += 20;
        rows.forEach((r, i) => {
          const h = hs[i];
          if (r.shade) doc.rect(L, y, CW, h).fill(SOFT);
          doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK).text(r.label, L + 12, y + (r.big ? 9 : 6), { width: LABEL_W - 12 });
          if (r.timeline) {
            let ty = y + 5;
            r.timeline.forEach((l) => {
              doc.font("Helvetica-Bold").fontSize(9.5).fillColor(GOLD_D).text(l.when, L + LABEL_W, ty, { width: 88 });
              doc.font("Helvetica").fontSize(9.5).fillColor(TEXT).text(l.what, L + LABEL_W + 92, ty, { width: vw - 92 });
              ty = Math.max(doc.y, ty + 11) + 4;
            });
          } else {
            doc.font(r.bold ? "Helvetica-Bold" : "Helvetica").fontSize(r.big ? 15 : 9.5).fillColor(r.color || TEXT)
              .text(String(r.value), L + LABEL_W, y + (r.big ? 4 : 5), { width: vw });
          }
          y += h;
          if (i < rows.length - 1) doc.moveTo(L, y).lineTo(R, y).lineWidth(0.7).strokeColor(LINE).stroke();
        });
        doc.roundedRect(L, y - 2, CW, 2, 1).fill(GOLD);
        y += 9;
      };

      section("Booking details", c.booking);
      section("Passenger details", c.passenger);
      section(c.tripTitle, c.trip);
      section("Payment", [
        ...c.pay,
        { label: "Total (AUD, GST incl.)", value: `$${c.total}`, big: true, bold: true, color: INK, shade: true },
        { label: "Status", value: c.status, bold: true, color: c.state === "paid" ? OK : c.state === "request" ? MUTED : WARN },
      ]);

      doc.font("Helvetica").fontSize(8.8);
      fit(16 + c.good.reduce((a, t) => a + doc.heightOfString(t, { width: CW - 11 }) + 3, 0));
      doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("GOOD TO KNOW", L, y, { characterSpacing: 1.5 });
      y += 13;
      c.good.forEach((t) => {
        doc.circle(L + 3, y + 4.5, 1.7).fill(GOLD);
        doc.font("Helvetica").fontSize(8.8).fillColor(TEXT).text(t, L + 11, y, { width: CW - 11 });
        y = doc.y + 3;
      });

      /* the footer on every page: who we are */
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.rect(0, FY, W, 66).fill(NAVY);
        doc.rect(0, FY, W, 2).fill(GOLD);
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(CREAM).text(COMPANY.name, L, FY + 14, { lineBreak: false });
        doc.font("Helvetica").fontSize(7.8).fillColor("#A9B0BE").text(COMPANY.ids, L, FY + 27, { lineBreak: false });
        doc.text("Changes, cancellations and full terms: www.skytransfers.com.au/terms.html", L, FY + 39, { lineBreak: false });
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(GOLD_LT).text("24/7  +61 481 437 772", L, FY + 14, { width: CW, align: "right", lineBreak: false });
        doc.font("Helvetica").fontSize(7.8).fillColor("#A9B0BE").text("info@skytransfers.com.au", L, FY + 27, { width: CW, align: "right", lineBreak: false });
        doc.text(range.count > 1 ? `www.skytransfers.com.au  ·  page ${i + 1} of ${range.count}` : "www.skytransfers.com.au", L, FY + 39, { width: CW, align: "right", lineBreak: false });
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

// ---- Branded HTML email (guest-facing) ----
function esc(t) { return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/* The same sections as the PDF (20 Oct 2026), built from the same
   confirmationContent so the two always agree. Tables and inline styles only,
   for Outlook and Gmail. */
function bookingEmailHtml(b, s) {
  const c = confirmationContent(b, s);
  const paid = !!b.paid;
  const confirmed = !paid && !!b.confirmed;
  const pillBg = { paid: "#1E7F4F", balance: "#9C6A0E", confirmed: "#9C6A0E", request: "#8E701C", deposit_due: "#9C6A0E", deposit_paid: "#9C6A0E" }[c.state];
  const cellL = "padding:9px 14px;font:700 12px/1.45 Arial,sans-serif;color:#141D30;vertical-align:top;width:34%;border-bottom:1px solid #EFE6D0;";
  const cellR = "padding:9px 14px;font:400 14px/1.45 Arial,sans-serif;color:#333B4C;vertical-align:top;border-bottom:1px solid #EFE6D0;";
  const value = (v) => (v && v.timeline)
    ? v.timeline.map((l) => `<div style="padding:0 0 6px;"><span style="font-weight:700;color:#8E701C;">${esc(l.when)}</span>${l.when ? " &nbsp;" : ""}${esc(l.what)}</div>`).join("")
    : esc(v).replace(/\n/g, "<br>");
  const section = (title, rows, extra) => {
    rows = rows.filter((r) => r && r[1] != null && (r[1].timeline ? r[1].timeline.length : String(r[1]) !== ""));
    if (!rows.length && !extra) return "";
    return `
    <tr><td style="padding:14px 28px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-bottom:2px solid #C9A227;">
        <tr><td colspan="2" style="background:#101828;border-radius:5px 5px 0 0;padding:8px 14px;font:700 13px Arial,sans-serif;color:#FFFFFF;">
          <span style="display:inline-block;width:7px;height:7px;background:#C9A227;margin-right:8px;vertical-align:middle;"></span>${title}</td></tr>
        ${rows.map((r) => `<tr><td style="${cellL}">${esc(r[0])}</td><td style="${cellR}">${value(r[1])}</td></tr>`).join("")}
        ${extra || ""}
      </table>
    </td></tr>`;
  };
  const totalRows = `
        <tr><td style="${cellL}background:#F6EED9;padding-top:12px;padding-bottom:12px;">Total (AUD, GST incl.)</td>
            <td style="${cellR}background:#F6EED9;font:700 22px Arial,sans-serif;color:#141D30;">$${c.total}</td></tr>
        <tr><td style="${cellL}">Status</td><td style="${cellR}font-weight:700;color:${c.state === "paid" ? "#1E7F4F" : c.state === "request" ? "#68707F" : "#9C6A0E"};">${esc(c.status)}</td></tr>`;
  const greeting = c.state === "deposit_due"
    ? `Your booking is confirmed. Pay the $${s.depositDue} deposit below to secure it — the $${s.total - s.depositDue} balance is paid later, and we'll send you a link for it. Your printable confirmation is attached.`
    : c.state === "deposit_paid"
    ? (s.payUrl ? `Thank you for your deposit. The $${s.balance} balance for your booking can now be paid below. Your confirmation is attached.`
                : `Your booking is confirmed and your $${s.total - s.balance} deposit is paid. The $${s.balance} balance is paid later — we'll send you a secure link for it. Your printable confirmation is attached.`)
    : paid && s.balance
    ? `Your booking has been updated. Your earlier payment of $${s.total - s.balance} is held against it — the $${s.balance} difference can be paid below. Your updated confirmation is attached.`
    : paid && s.refund
    ? `Your booking has been updated, and $${s.refund} has been refunded to the card you paid with — it usually shows within 5 to 10 business days. Your updated confirmation is attached.`
    : paid
    ? "Payment received — your booking is confirmed. Your printable confirmation is attached, and we'll send your chauffeur's name and mobile number before pick-up."
    : confirmed
      ? "Your booking is confirmed and your chauffeur is booked. Your printable confirmation is attached" + (s.payUrl ? " — pay below to secure it, and we'll send your chauffeur's details before pick-up." : ", and we'll send your chauffeur's details before pick-up.")
      : "Thank you for booking with Sky Transfers. Here are your trip details — we'll confirm your chauffeur by email, usually within the hour.";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F7F4ED;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4ED;padding:0;">
<tr><td align="center" style="padding:24px 10px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:10px;overflow:hidden;border:1px solid #E5E0D2;">

    <!-- Header: logo, and the reference -->
    <tr><td style="background:#101828;padding:18px 28px;border-bottom:3px solid #C9A227;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;"><img src="cid:stlogo" alt="SKY TRANSFERS" height="58" style="height:58px;display:block;font:400 20px Georgia,serif;letter-spacing:4px;color:#F6F2E8;"></td>
        <td align="right" style="vertical-align:middle;">
          <div style="font:700 10px Arial,sans-serif;letter-spacing:2.5px;color:#D9B44A;">${c.state === "request" ? "BOOKING REQUEST" : "BOOKING CONFIRMATION"}</div>
          <div style="font:700 20px Arial,sans-serif;color:#FFFFFF;padding-top:3px;">${esc(b.ref)}</div>
        </td>
      </tr></table>
    </td></tr>

    <!-- Who it is for, and where it stands -->
    <tr><td style="padding:22px 28px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:top;font:700 22px Arial,sans-serif;color:#141D30;">${esc(b.name)}</td>
        <td align="right" style="vertical-align:top;"><span style="display:inline-block;padding:6px 14px;border-radius:12px;font:700 10px Arial,sans-serif;letter-spacing:1px;background:${pillBg};color:#FFFFFF;">${c.pill.replace(/  ·  /g, " &middot; ")}</span></td>
      </tr></table>
      <div style="font:400 14.5px/1.6 Arial,sans-serif;color:#333B4C;padding-top:10px;">Hi ${esc(String(b.name || "").split(" ")[0])}, ${greeting}</div>
    </td></tr>

    ${s.payUrl ? `<!-- Pay button: only a confirmation the office sent with a payment link -->
    <tr><td align="center" style="padding:16px 28px 2px;">
      <a href="${esc(s.payUrl)}" style="display:inline-block;background:#C9A227;color:#141D30;font:700 15px Arial,sans-serif;padding:14px 30px;border-radius:9px;text-decoration:none;">${s.balance ? `Pay the $${s.balance} balance now` : s.depositDue ? `Pay the $${s.depositDue} deposit now` : `Pay $${s.total} now to secure your booking`}</a>
      <div style="font:400 12.5px Arial,sans-serif;color:#68707F;padding-top:8px;">Secure card payment by Stripe &mdash; card details never touch our website.</div>
    </td></tr>` : ""}
    ${section("Booking details", c.booking)}
    ${section("Passenger details", c.passenger)}
    ${section(c.tripTitle, c.trip)}
    ${section("Payment", c.pay, totalRows)}

    <!-- Good to know -->
    <tr><td style="padding:16px 28px 4px;">
      <div style="font:700 10px Arial,sans-serif;letter-spacing:1.5px;color:#68707F;padding-bottom:6px;">GOOD TO KNOW</div>
      <div style="font:400 13.5px/1.8 Arial,sans-serif;color:#333B4C;">
        ${c.good.map((t) => `<span style="color:#C9A227;">&#9679;</span>&nbsp; ${esc(t)}`).join("<br>\n        ")}
      </div>
    </td></tr>

    <!-- Contact -->
    <tr><td style="padding:16px 28px 6px;font:400 13.5px/1.7 Arial,sans-serif;color:#333B4C;">
      Questions or changes? Reply to this email or call/text us any time on
      <a href="tel:+61481437772" style="color:#8E701C;font-weight:700;text-decoration:none;">+61&nbsp;481&nbsp;437&nbsp;772</a> — we're on 24/7.
    </td></tr>

    <!-- Review CTA -->
    <tr><td align="center" style="padding:14px 28px 26px;">
      <a href="${REVIEW_URL}" style="display:inline-block;background:#C9A227;color:#141D30;font:700 14px Arial,sans-serif;padding:12px 26px;border-radius:8px;text-decoration:none;">&#9733; Enjoyed the ride? Leave us a Google review</a>
    </td></tr>

    <!-- Footer: who we are -->
    <tr><td style="background:#101828;padding:20px 28px;border-top:2px solid #C9A227;">
      <div style="font:700 12.5px Arial,sans-serif;color:#F6F2E8;">${esc(COMPANY.name)}</div>
      <div style="font:400 11.5px/1.8 Arial,sans-serif;color:#A9B0BE;padding-top:4px;">
        ${esc(COMPANY.ids).replace(/  ·  /g, " &middot; ")}<br>
        24/7 &middot; +61 481 437 772 &middot; <a href="mailto:info@skytransfers.com.au" style="color:#D9B44A;text-decoration:none;">info@skytransfers.com.au</a> &middot; <a href="https://www.skytransfers.com.au" style="color:#D9B44A;text-decoration:none;">skytransfers.com.au</a><br>
        <a href="https://www.skytransfers.com.au/terms.html" style="color:#A9B0BE;">Changes, cancellations and full terms</a>
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

/* ---- Return trips ---------------------------------------------------------
   computeFare works out which end is the hub, so it is direction-symmetric:
   the second leg always costs exactly what the first did. Aman's call,
   9 Oct 2026 — 10% off the combined transfer fare. Child seats and a trailer
   are charged per leg, because the seat is genuinely needed on both journeys
   and discounting a $15 hire is noise.

   This formula is duplicated in index.html on purpose: the page has to show a
   price long before it ever talks to this server. If you change it here,
   change it there in the same commit — quoteCheck compares the two and a
   mismatch makes it refuse the payment outright. */
const RETURN_DISCOUNT = 0.10;
function returnTransfer(fare) { return Math.round(fare * 2 * (1 - RETURN_DISCOUNT)); }

/* A booking is only a return when it carries its own return date. */
function returnLeg(b) {
  const date = String((b && b.returnDate) || "").trim();
  if (!date) return null;
  return {
    date,
    time: String((b && b.returnTime) || "").trim(),
    /* The flight for the leg where we collect the guest at the terminal. It is
       a different flight from the outbound one, and it is the one dispatch
       needs to track. Optional; bounded because it lands in Stripe metadata. */
    flight: String((b && b.returnFlight) || "").trim().slice(0, 40),
  };
}

/* Dates are ISO, so a string compare is a date compare. */
function returnProblem(b, ret) {
  if (!ret) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ret.date) || !/^\d{1,2}:\d{2}/.test(ret.time)) {
    return "Please give both a date and a time for the return trip.";
  }
  if (ret.date < b.date || (ret.date === b.date && ret.time <= b.time)) {
    return "The return trip has to be after the outbound one.";
  }
  if (leadTimeShortfall(ret.date, ret.time) !== null) return LEAD_TIME_ERROR;
  return null;
}

/* "1) Hilton Surfers Paradise  2) ..." for the PDF and the guest email, with
   the stop charge when there is one; "" when the booking has no stops. */
function stopsText(b, sep) {
  const list = Array.isArray(b && b.stops) ? b.stops.filter((s) => s && (s.address || s.suburb)) : [];
  if (!list.length) return "";
  return list.map((s, i) => `${i + 1}) ${s.address || s.suburb}`).join(sep) +
    (b.stopsExtra > 0 ? `${sep}(+$${Math.round(b.stopsExtra)} for the extra distance)` : "");
}

function bookingSummary(b, fare, seats, trailer, ret) {
  const legs = ret ? 2 : 1;
  const transfer = ret ? returnTransfer(fare) : fare;
  const extras = (seats * CHILD_SEAT_PRICE + (trailer ? TRAILER_PRICE : 0)) * legs;
  /* Stops on the way: outbound only, added once, never discounted. */
  const stops = Array.isArray(b.stops) ? b.stops.filter((s) => s && (s.address || s.suburb)) : [];
  const stopsExtra = stops.length ? Math.max(0, Math.round(Number(b.stopsExtra) || 0)) : 0;
  const total = transfer + extras + stopsExtra;
  const saved = ret ? fare * 2 - transfer : 0;
  const stopLines = stops.length ? [
    `Stops on the way${ret ? " (outbound)" : ""}: ` + stops.map((s, i) => `${i + 1}) ${s.address || s.suburb}`).join("; "),
  ] : [];
  const stopFareLines = stopsExtra ? [
    `Stops: +$${stopsExtra} (adds ${b.stopsKm != null ? b.stopsKm : "?"} km)`,
  ] : [];
  /* A one-way booking must produce exactly the text it produced before this
     feature existed — the dispatch automation parses these lines. The return
     lines are therefore inserted only when there is a return. */
  const hrs = hourlyHours(b);
  const hourlyLines = hrs ? [
    `Hire: ${isCharterHire(b) ? "CHARTER" : "BY THE HOUR"} — ${hrs} hours as directed from ${b.time}`,
  ] : [];
  const returnLines = ret ? [
    `Trip: RETURN`,
    `Return date: ${ret.date}`,
    `Return pick-up time: ${ret.time}`,
    `Return flight: ${ret.flight || "-"}`,
    `Return fare: $${transfer} for both legs (saved $${saved}, ${Math.round(RETURN_DISCOUNT * 100)}% off)`,
  ] : [];
  return {
    total,
    isReturn: !!ret,
    transfer,
    saved,
    stopsExtra,
    text: [
      `Booking reference: ${b.ref || "-"}`,
      `Route: ${b.pickup} -> ${b.dropoff}`,
      ...stopLines,
      ...hourlyLines,
      /* Only on a distance-priced booking, so every other booking's text is
         unchanged for the dispatch automation that reads it. */
      ...(b.kmRoad ? [`Priced by distance: ${b.kmRoad} km by road (no zone fare for this address)`] : []),
      `Vehicle: ${b.vehicle}`,
      hrs ? `Fare: $${fare} for ${hrs} hours ($${Math.round(fare / hrs)}/h)` : `Fare: $${fare} one-way`,
      ...stopFareLines,
      `Baby/child seats: ${seats} ($${CHILD_SEAT_PRICE} each${ret ? ", each leg" : ""})`,
      `Luggage trailer: ${trailer ? `YES (+$${TRAILER_PRICE}${ret ? " each leg" : ""})` : "No"}`,
      ...returnLines,
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

/* The dispatch copy gains two buttons. The plain-text part is left exactly as
   it was, because the dispatch automation reads that format. */
function dispatchHtml(s, links) {
  const e = (v) => String(v == null ? "" : v).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#333B4C;max-width:560px">
<p style="margin:0 0 6px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#6F5510">New booking request</p>
<p style="margin:0 0 18px">Decide it here &mdash; the guest is emailed the moment you do.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px"><tr>
<td style="padding-right:10px"><a href="${e(links.approve)}" style="display:inline-block;background:#C9A227;color:#141D30;font-weight:700;text-decoration:none;padding:14px 22px;border-radius:9px">Confirm &amp; send payment link</a></td>
<td><a href="${e(links.decline)}" style="display:inline-block;background:#141D30;color:#F6F2E8;font-weight:600;text-decoration:none;padding:14px 22px;border-radius:9px">Can&rsquo;t do this one</a></td>
</tr></table>
<pre style="font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;background:#F7F4ED;border:1px solid #E5E0D2;border-radius:10px;padding:16px;white-space:pre-wrap;margin:0">${e(s.text)}</pre>
<p style="margin:18px 0 0;font-size:13px;color:#68707F">Both buttons open a page that asks you to confirm first, so nothing can fire by accident.</p></div>`;
}

/* ---------------------------------------------------------------------------
 * The price the guest was actually shown.
 *
 * index.html sends quotedTotal with every booking, with a comment saying a
 * mismatch would be "visible rather than silent". It was not: nothing here
 * ever read it, so the guard existed on one side only. The fare tables live
 * in two repositories and are kept in step by hand, so drift is a real
 * possibility rather than a theoretical one.
 *
 * The server's figure always wins - it is the one that computes the charge -
 * but a disagreement now says so out loud.
 * ------------------------------------------------------------------------ */
function quoteCheck(b, total) {
  const quoted = Number(b && b.quotedTotal);
  /* Older cached pages do not send it at all. Absent is not a mismatch. */
  if (!Number.isFinite(quoted) || quoted <= 0) return null;
  if (Math.round(quoted) === Math.round(total)) return null;
  const note =
    `PRICE MISMATCH: the page showed $${Math.round(quoted)}, this server calculates $${Math.round(total)}. ` +
    `The fare tables in the two repositories have drifted apart. Check index.html against stripe-server.js.`;
  console.error(note);
  return { quoted: Math.round(quoted), total: Math.round(total), note };
}

app.post("/request-booking", async (req, res) => {
  try {
    if (!mailer) return res.status(500).json({ error: "Email is not configured on the server" });
    const b = normaliseAddresses(req.body || {});
    if (!b.pickup || !b.dropoff || !b.vehicle || !b.date || !b.name || !b.phone || !b.email) {
      return res.status(400).json({ error: "Missing booking details" });
    }
    const fare = await fareForBooking(b);
    if (fare == null) return res.status(400).json({ error: "This route or vehicle needs a manual quote — please email or call us." });
    if (leadTimeShortfall(b.date, b.time) !== null) return res.status(400).json({ error: LEAD_TIME_ERROR });
    const seats = Math.min(Math.max(parseInt(b.childSeats, 10) || 0, 0), 3);
    const trailer = b.trailer === true || b.trailer === "true";
    const ret = returnLeg(b);
    const retErr = returnProblem(b, ret);
    if (retErr) return res.status(400).json({ error: retErr });
    b.ref = makeRef(b.date);
    const s = bookingSummary(b, fare, seats, trailer, ret);
    const mismatch = quoteCheck(b, s.total);
    const full = { ...b, childSeats: seats, trailer, paid: false };
    /* Before the emails, not after: the dispatch copy carries one-click confirm
       links, and the row has to exist by the time anyone presses one. This
       still swallows its own errors. */
    await recordBooking(full, s, "requested");
    const actions = portal && portal.actionLinks ? portal.actionLinks(b.ref) : null;
    const pdf = await bookingPdf(full, s).catch((e) => { console.error("PDF failed:", e.message); return null; });

    // 1) to Sky Transfers (plain text — the dispatch automation reads this format)
    await mailer.sendMail({
      from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`,
      to: BOOKINGS_EMAIL,
      replyTo: b.email,
      subject: `NEW Booking request: ${b.pickup} -> ${b.dropoff} (${b.date} ${b.time}) [${b.ref}]`,
      text: (mismatch ? `!! ${mismatch.note}\n\n` : "") +
        `NEW BOOKING REQUEST — Sky Transfers website\n\n${s.text}`,
      html: actions ? dispatchHtml(s, actions) : undefined,
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

/* ---------------------------------------------------------------------------
 * POST /charter-enquiry
 *
 * Charters are quoted per job rather than priced by suburb, so this is
 * deliberately NOT a copy of /request-booking: there is no fare to compute, no
 * lead-time rule to enforce, nothing to pay, and no PDF worth generating for
 * something that is still a conversation.
 *
 * It exists because charters.html had no server path at all. The form wrote a
 * message and handed it to the visitor's own mail or WhatsApp app, so an
 * enquiry only arrived if they finished the job themselves. On a work desktop
 * with no mail client configured, "Open in email app" does nothing at all, and
 * a coach enquiry worth $2,300 disappeared with nobody aware it had happened.
 * ------------------------------------------------------------------------ */
app.post("/charter-enquiry", async (req, res) => {
  try {
    if (!mailer) return res.status(500).json({ error: "Email is not configured on the server" });
    const b = req.body || {};
    /* Deliberately loose. A charter enquiry is the start of a conversation, and
       a phone number is enough to quote from - rejecting one for a missing
       field would recreate the hole this endpoint was built to close. */
    if (!b.name || !b.phone) {
      return res.status(400).json({ error: "Please give us a name and a phone number" });
    }
    b.ref = makeRef(b.date);

    const row = (k, v) => `${k}: ${v === 0 || v ? v : "-"}`;
    const text = [
      row("Enquiry reference", b.ref),
      row("Occasion", b.occasion),
      row("Vehicle wanted", b.vehicle),
      row("Date", b.date),
      row("Hours", b.hours),
      row("Passengers", b.pax),
      "",
      row("Name", b.name),
      row("Phone", b.phone),
      row("Email", b.email),
      "",
      "Itinerary / notes:",
      b.itinerary || "-",
    ].join("\n");

    /* To Sky Transfers, plain text, same key: value shape the dispatch
       automation already reads on booking requests. */
    await mailer.sendMail({
      from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`,
      to: BOOKINGS_EMAIL,
      replyTo: b.email || undefined,
      subject: `NEW Charter enquiry: ${b.occasion || "charter"} ${b.date || ""} [${b.ref}]`,
      text: `NEW CHARTER ENQUIRY — Sky Transfers website\n\n${text}`,
    });

    /* Acknowledgement only if they gave an address; the charter form does not
       require one. No promise here that is not already on the page. */
    if (b.email) {
      await mailer.sendMail({
        from: `"Sky Transfers" <${process.env.GMAIL_USER}>`,
        to: b.email,
        replyTo: BOOKINGS_EMAIL,
        subject: `Charter enquiry received — Sky Transfers · ${b.ref}`,
        text:
          `Hi ${b.name},\n\nThanks for your charter enquiry — we have it.\n\n${text}\n\n` +
          `We will come back with a written all-inclusive price — driver, fuel, tolls and GST — ` +
          `usually within the hour.\n\nNeed it sooner? Call or text +61 481 437 772.\n\n` +
          `Sky Transfers — Gold Coast & Brisbane charters\nwww.skytransfers.com.au`,
      });
    }

    postToZapier({ ...b, kind: "charter-enquiry" }, { total: null, text });
    res.json({ ok: true, ref: b.ref });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send the charter enquiry" });
  }
});

app.post("/create-checkout", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Payments are not configured on the server" });
    const b = normaliseAddresses(req.body || {});
    const fare = await fareForBooking(b);
    if (fare == null) {
      return res.status(400).json({ error: "This route or vehicle needs a manual quote — please email or call us." });
    }
    if (leadTimeShortfall(b.date, b.time) !== null) {
      return res.status(400).json({ error: LEAD_TIME_ERROR });
    }
    const seats = Math.min(Math.max(parseInt(b.childSeats, 10) || 0, 0), 3);
    const trailer = b.trailer === true || b.trailer === "true";
    const ret = returnLeg(b);
    const retErr = returnProblem(b, ret);
    if (retErr) return res.status(400).json({ error: retErr });
    /* Reuse the reference the guest already holds when this is the same trip
       they asked about earlier. Without it, someone who sends a request and
       then pays on the site ends up with two references for one journey, and
       two rows on the dashboard - one of them stuck at "requested" for ever.
       Falls back to a fresh reference if the lookup is unavailable. */
    let ref = null;
    if (portal && portal.findOpenWebBooking) {
      ref = await portal.findOpenWebBooking({
        email: b.email, pickup: b.pickup, dropoff: b.dropoff, date: b.date, time: b.time,
      }).catch((e) => { console.error("ref reuse lookup failed:", e.message); return null; });
    }
    if (!ref) ref = makeRef(b.date);
    /* Charging more than the page displayed is not something to paper over,
       so this stops rather than quietly taking the larger amount. Charging
       LESS is harmless to the guest, so that proceeds at the lower figure and
       is only reported. */
    /* bookingSummary is the only place the total is worked out, so the figure
       guarded here is the same one the emails and the database will show. */
    const summary = bookingSummary({ ...b, ref }, fare, seats, trailer, ret);
    const quotedGuard = quoteCheck(b, summary.total);
    if (quotedGuard && quotedGuard.total > quotedGuard.quoted) {
      if (mailer) {
        mailer.sendMail({
          from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`,
          to: BOOKINGS_EMAIL,
          subject: `PRICE MISMATCH blocked a payment: ${b.pickup} -> ${b.dropoff}`,
          text: `${quotedGuard.note}\n\nThe guest was NOT charged and has been asked to call.\n` +
                `Route: ${b.pickup} -> ${b.dropoff}\nVehicle: ${b.vehicle}\n` +
                `Date: ${b.date} ${b.time}\nName: ${b.name}\nPhone: ${b.phone}\nEmail: ${b.email}\n`,
        }).catch((e) => console.error("mismatch alert failed:", e.message));
      }
      return res.status(409).json({
        error: "Our price for this trip has just changed and we don't want to charge you more than we showed. " +
               "Call or text +61 481 437 772 and we'll honour the price you saw.",
      });
    }
    /* Stripe line items cannot be negative, so the return discount is baked
       into the single transfer line rather than shown as a credit. The saving
       is named in the description so the guest can see it on the Stripe page. */
    const legs = ret ? 2 : 1;
    const lineItems = [{
      price_data: {
        currency: "aud",
        unit_amount: summary.transfer * 100,
        product_data: {
          name: (hourlyHours(b) ? `Hourly hire, ${hourlyHours(b)} hours`
                  : b.p2p
                  ? (ret ? "Return private transfer" : "Private transfer")
                  : (ret ? "Return airport transfer" : "Airport transfer")) + ` — ${b.vehicle}`,
          description: hourlyHours(b)
            ? `From ${b.pickup}, as directed · ${b.date} ${b.time} · ${hourlyHours(b)} h · Ref ${ref}`
            : ret
            ? `Out ${b.pickup} → ${b.dropoff} · ${b.date} ${b.time}. ` +
              `Back ${b.dropoff} → ${b.pickup} · ${ret.date} ${ret.time}. ` +
              `Includes ${Math.round(RETURN_DISCOUNT * 100)}% return discount ` +
              `(saved $${summary.saved}) · Ref ${ref}`
            : `${b.pickup} → ${b.dropoff} · ${b.date} ${b.time} · Ref ${ref}`,
        },
      },
      quantity: 1,
    }];
    if (seats > 0) {
      lineItems.push({
        price_data: {
          currency: "aud",
          unit_amount: CHILD_SEAT_PRICE * 100,
          product_data: { name: ret ? "Baby / child seat (each leg)" : "Baby / child seat" },
        },
        quantity: seats * legs,
      });
    }
    if (trailer) {
      lineItems.push({
        price_data: {
          currency: "aud",
          unit_amount: TRAILER_PRICE * 100,
          product_data: { name: ret ? "Luggage trailer (each leg)" : "Luggage trailer" },
        },
        quantity: legs,
      });
    }
    if (summary.stopsExtra > 0) {
      lineItems.push({
        price_data: {
          currency: "aud",
          unit_amount: summary.stopsExtra * 100,
          product_data: { name: `Stops on the way (${b.stops.length})`, description: `Adds ${b.stopsKm} km to the route` },
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
      /* Promo codes are Stripe's, not ours. Create and retire them in the
         Stripe dashboard; Stripe enforces expiry and usage limits and applies
         the discount after these line items, which leaves computeFare — and
         so quoteCheck — untouched. A discount worked out in the browser would
         be both forgeable and self-defeating: quoteCheck would see a quoted
         total below the computed one and refuse the payment. */
      allow_promotion_codes: true,
      line_items: lineItems,
      customer_email: b.email || undefined,
      metadata: {
        ref,
        pickup: String(b.pickup || ""), dropoff: String(b.dropoff || ""),
        vehicle: String(b.vehicle || ""), date: String(b.date || ""),
        time: String(b.time || ""), pax: String(b.pax || ""),
        flight: String(b.flight || ""), child_seats: String(seats),
        trailer: trailer ? "yes" : "no",
        trip_type: hourlyHours(b) ? "hourly" : ret ? "return" : "one-way",
        hours: hourlyHours(b) ? String(hourlyHours(b)) : "",
        km_road: b.kmRoad ? String(b.kmRoad) : "",
        /* Stripe metadata values are capped at 500 characters. */
        stops: Array.isArray(b.stops) && b.stops.length ? b.stops.map((x) => x.address || x.suburb).join(" | ").slice(0, 480) : "",
        stops_extra: summary.stopsExtra ? String(summary.stopsExtra) : "",
        stops_km: summary.stopsExtra ? String(b.stopsKm) : "",
        return_date: ret ? ret.date : "",
        return_time: ret ? ret.time : "",
        return_flight: ret ? ret.flight : "",
        passenger_name: String(b.name || ""), phone: String(b.phone || ""),
        pickup_address: String(b.address || ""),
        /* the two ends' street addresses on their own (20 Oct 2026) */
        pu_address: String(b.pickupAddress || "").slice(0, 300),
        do_address: String(b.dropoffAddress || "").slice(0, 300),
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
        pickupAddress: m.pu_address || "", dropoffAddress: m.do_address || "",
        notes: m.notes, paid: true,
        returnDate: m.return_date || "", returnTime: m.return_time || "",
        returnFlight: m.return_flight || "",
        hourly: m.hours ? { hours: parseInt(m.hours, 10) } : undefined,
        kmRoad: parseInt(m.km_road, 10) || undefined,
        stops: m.stops ? String(m.stops).split(" | ").filter(Boolean).map((a) => ({ address: a })) : undefined,
        stopsExtra: parseInt(m.stops_extra, 10) || 0,
        stopsKm: m.stops_km ? Number(m.stops_km) : undefined,
        paymentIntent: typeof sess.payment_intent === "string" ? sess.payment_intent : (sess.payment_intent && sess.payment_intent.id) || "",
      };
      /* An account invoice paid by card. Not a booking: mark the invoice
         paid and stop - nothing below may record it as a transfer. */
      if (m.invoice_for && billing && typeof billing.paidByStripe === "function") {
        await billing.paidByStripe(String(m.invoice_for), sess.amount_total || 0, b.paymentIntent || "")
          .catch((e) => console.error("invoice payment:", e.message));
        return res.json({ received: true });
      }
      /* An agent booking paid by card on its own (the portal's Pay by card).
         Not a website booking either: settle it and stop. */
      if (m.agent_booking_for && portal && typeof portal.settleAgentCard === "function") {
        const row = await portal.settleAgentCard(String(m.agent_booking_for), sess.amount_total || 0, b.paymentIntent || "")
          .catch((e) => { console.error("agent card payment:", e.message); return null; });
        console.log("agent booking paid by card:", m.agent_booking_for, "$" + Math.round((sess.amount_total || 0) / 100), row ? "settled" : "row missing");
        return res.json({ received: true });
      }
      /* A balance link - the difference after a paid booking was amended
         upwards. Not a new booking: settle it and tell both sides. */
      /* A deposit link (an office booking taking 20% or so now). The booking
         becomes paid with the rest owing; asking for the balance is the
         office's call, from the admin page. Not a new booking: stop here. */
      if (m.deposit_for && portal && typeof portal.settleDeposit === "function") {
        const ref = String(m.deposit_for);
        const got = Math.round((sess.amount_total || 0) / 100);
        const row = await portal.settleDeposit(ref, sess.amount_total || 0, b.paymentIntent || "").catch((e) => { console.error("settle deposit:", e.message); return null; });
        console.log("deposit paid:", ref, "$" + got, row ? (row._fresh ? "settled" : "already settled") : "row missing");
        if (row && row._fresh && mailer) {
          const rb = portal.rowToBooking(row);
          rb.email = rb.email || sess.customer_email || sess.customer_details?.email || "";
          const rs = portal.summaryForRow(row, rb);
          const rpdf = await bookingPdf(rb, rs).catch((e) => { console.error("PDF failed:", e.message); return null; });
          await mailer.sendMail({
            from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`, to: BOOKINGS_EMAIL, replyTo: rb.email || undefined,
            subject: `DEPOSIT PAID: $${got} on ${ref} - $${rs.balance || 0} balance owing - ${rb.pickup} -> ${rb.dropoff} (${rb.date} ${rb.time})`,
            text: `DEPOSIT PAID - Sky Transfers (Stripe)\n\n$${got} deposit received for ${ref}. $${rs.balance || 0} balance still owing.\n` +
                  `It is NOT requested automatically - send it from the admin page (Web bookings > Send balance link) when you're ready, ` +
                  `or mark it paid there if the guest pays another way.\n\n${rs.text}`,
            attachments: rpdf ? [{ filename: "SkyTransfers-Booking.pdf", content: rpdf }] : [],
          });
          if (rb.email) await mailer.sendMail({
            from: `"Sky Transfers" <${process.env.GMAIL_USER}>`, to: rb.email, replyTo: BOOKINGS_EMAIL,
            subject: `Deposit received — booking confirmed — Sky Transfers · ${ref}`,
            text: `Hi ${rb.name},\n\nThank you - we've received your $${got} deposit and your booking is confirmed. ` +
                  `The $${rs.balance || 0} balance is paid later; we'll send you a secure link for it. Your printable confirmation is attached.\n\n${rs.text}\n\n` +
                  `Free changes to 24 hours before pick-up: reply to this email or call +61 481 437 772.\n\nSky Transfers — Gold Coast & Brisbane airport transfers\nwww.skytransfers.com.au`,
            html: bookingEmailHtml(rb, rs), attachments: guestAttachments(rpdf),
          });
        }
        return res.json({ received: true });
      }
      if (m.balance_for && portal && typeof portal.settleBalance === "function") {
        const ref = String(m.balance_for);
        const got = Math.round((sess.amount_total || 0) / 100);
        const row = await portal.settleBalance(ref, b.paymentIntent || "").catch((e) => { console.error("settle balance:", e.message); return null; });
        console.log("balance paid:", ref, "$" + got, row ? "settled" : "row missing");
        if (row && mailer) {
          const rb = portal.rowToBooking(row);
          rb.email = rb.email || sess.customer_email || sess.customer_details?.email || "";
          const rs = portal.summaryForRow(row, rb);
          const rpdf = await bookingPdf(rb, rs).catch((e) => { console.error("PDF failed:", e.message); return null; });
          await mailer.sendMail({
            from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`, to: BOOKINGS_EMAIL, replyTo: rb.email || undefined,
            subject: `BALANCE PAID: $${got} on ${ref} - ${rb.pickup} -> ${rb.dropoff} (${rb.date} ${rb.time})`,
            text: `BALANCE PAID - Sky Transfers website (Stripe)\n\n$${got} received for ${row.deposit_pct ? "the balance of" : "the change to"} ${ref}. The booking is now fully paid.\n\n${rs.text}`,
          });
          if (rb.email) await mailer.sendMail({
            from: `"Sky Transfers" <${process.env.GMAIL_USER}>`, to: rb.email, replyTo: BOOKINGS_EMAIL,
            subject: `Balance received — fully paid — Sky Transfers · ${ref}`,
            text: `Hi ${rb.name},\n\nThank you - we've received $${got} and your ${row.deposit_pct ? "" : "updated "}booking is now fully paid. Your confirmation is attached.\n\n${rs.text}\n\nSky Transfers — Gold Coast & Brisbane airport transfers\nwww.skytransfers.com.au`,
            html: bookingEmailHtml(rb, rs), attachments: guestAttachments(rpdf),
          });
        }
        return res.json({ received: true });
      }
      /* A payment with no booking in it: a payment link made by hand in the
         Stripe dashboard. Until 20 Oct 2026 this fell through to the booking
         email below and sent the office AND the payer a "PAID booking" with
         "undefined" in every field and a PDF to match. Now the office is told
         who paid what, and nobody else is emailed. */
      if (!m.pickup && !m.dropoff && !m.date && !m.hours) {
        const paid = Math.round((sess.amount_total || 0)) / 100;
        const who = sess.customer_details || {};
        let items = "";
        try {
          const li = await stripe.checkout.sessions.listLineItems(sess.id, { limit: 10 });
          items = (li.data || []).map((x) => `${x.description || "item"} x${x.quantity || 1}  $${((x.amount_total || 0) / 100).toFixed(2)}`).join("\n");
        } catch (e) { items = ""; }
        console.log("payment without booking details:", sess.id, "$" + paid.toFixed(2), m.ref || "");
        if (mailer) await mailer.sendMail({
          from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`, to: BOOKINGS_EMAIL, replyTo: who.email || undefined,
          subject: `CARD PAYMENT received: $${paid.toFixed(2)} from ${who.name || who.email || "a customer"} (payment link)`,
          text: `CARD PAYMENT - Stripe, through a payment link made outside the booking system\n\n` +
                `Amount: $${paid.toFixed(2)}\nFrom: ${who.name || "-"}${who.email ? " <" + who.email + ">" : ""}${who.phone ? ", " + who.phone : ""}\n` +
                (items ? `For:\n${items}\n` : "") + (sess.payment_link ? `Payment link: ${sess.payment_link}\n` : "") +
                `Stripe payment: ${b.paymentIntent || sess.id}\n\n` +
                `The link carried no booking details, so nothing was put on the board and the customer was not sent a confirmation. ` +
                `Match it to its booking yourself - for a booking already on the admin page, use "Balance paid another way" or mark it paid there.\n`,
        }).catch((e) => console.error("payment-link email:", e.message));
        return res.json({ received: true });
      }
      /* An office payment link made before 13 Oct 2026 carried no return leg
         in its metadata, so a paid return printed as a one-way at the return
         price. The stored row is the authority whenever the metadata is
         silent on the return. */
      if (!b.returnDate && b.ref && portal && typeof portal.getWebBooking === "function") {
        const row = await portal.getWebBooking(b.ref).catch(() => null);
        if (row && row.return_date_text) {
          b.returnDate = row.return_date_text;
          b.returnTime = row.return_time || "";
          b.returnFlight = row.return_flight || "";
        }
        /* the same for the two street addresses on links made before they
           were carried in the metadata */
        if (row && !b.pickupAddress && !b.dropoffAddress) {
          b.pickupAddress = row.pu_address || "";
          b.dropoffAddress = row.do_address || "";
        }
      }
      /* Stripe's amount_total is the figure actually charged, so it already has
         any promotion code taken off. That makes it the only number worth
         printing here, and the reason the fare lines below are stripped out
         rather than recomputed. */
      const total = Math.round((sess.amount_total || 0) / 100);
      const ret = returnLeg(b);
      const s = { total, isReturn: !!ret, text: bookingSummary(b, 0, b.childSeats, b.trailer, ret).text
        .replace(/^Fare: \$0 (one-way|for \d+ hours.*)\n/m, "")
        .replace(/^Return fare: .*\n/m, "")
        .replace(/TOTAL: \$\d+/, `TOTAL: $${total} (PAID)`) };
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
          text: `Hi ${b.name},\n\nPayment received — your ${hourlyHours(b) ? "booking" : "transfer"} is confirmed. Your printable confirmation is attached.\n\n${s.text}\n\n` +
            (hourlyHours(b) ? "Your chauffeur will be at the pick-up at the time above. " : "We track your flight and your chauffeur meets you with a name board. ") +
            `Free changes to 24 hours before pick-up: reply to this email or call +61 481 437 772.\n\nSky Transfers — Gold Coast & Brisbane airport transfers\nwww.skytransfers.com.au`,
          html: bookingEmailHtml(b, s),
          attachments: guestAttachments(pdf),
        });
      }
      recordBooking(b, s, "paid");
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
portal = require("./agent-portal")({
  app, stripe, computeFare, VEHICLES, leadTimeShortfall, LEAD_TIME_ERROR,
  makeRef, bookingSummary, mailer, BOOKINGS_EMAIL,
  /* So the office can book for a guest, or send a confirmation again, with
     the same branded email and PDF the website sends - not a second version
     that drifts. fareForBooking is read at call time, so it sees the
     point-to-point module mounted further down. */
  bookingPdf, bookingEmailHtml, guestAttachments, fareForBooking, returnLeg, hourlyHours, normaliseAddresses, COMPANY,
  HUB_NAMES: [OOL, BNE, CRUISE],
  PLACES_FOR_AGENTS: [OOL, BNE, CRUISE]
    .concat(Object.keys(SUBURBS).sort())
    .concat(Object.keys(BM_SUBURB).sort())
    .concat(Object.keys(LD_SUBURB).sort()),
});
/* Loud on purpose. When the portal handed back the wrong thing, bookings
   stopped being recorded and absolutely nothing said so - no row, no error,
   and emails still going out. A silent recorder is worse than none. */
if (!portal || typeof portal.saveWebBooking !== "function") {
  console.error("FATAL-ISH: agent-portal returned no saveWebBooking - website bookings will NOT be recorded");
} else {
  console.log("Website booking recorder wired up");
}
/* The real fare for the Google Ads purchase conversion. Without it every
   booking reports as the conversion action's $1 default. */
require("./checkout-lookup")({ app });

/* The blog article feed. Wrapped because it is the newest thing here and the
   least important: an outside content service feeding the blog must never be
   able to stop this server taking bookings. */
try {
  require("./blog-feed")({ app });
} catch (err) {
  console.error("Blog feed not mounted (bookings unaffected):", err.message);
}

/* Point-to-point quotes: neither end an airport. Same treatment as the blog
   feed - wrapped, because it is new and nothing on the booking path needs it.
   It is handed the zone tables so it holds no copy of its own, and the admin
   guard so its self-test sits behind the existing admin login. */
try {
  p2p = require("./p2p-routes")({
    app,
    requireAdmin: portal && portal.requireAdmin,
    VEHICLES, VEHICLE_ALIASES, QUOTE_ONLY,
    SUBURBS, BM_SUBURB, LD_SUBURB,
    HUB_NAMES: [OOL, BNE, CRUISE],
  });
} catch (err) {
  console.error("p2p quotes not mounted (bookings unaffected):", err.message);
}

/* Airport transfers by road distance, for an address the zone tables do not
   price (to 300 km). Wrapped the same way; zone-priced bookings never touch it. */
try {
  kmq = require("./km-routes")({
    app, VEHICLES, VEHICLE_ALIASES, QUOTE_ONLY, computeFare,
    SUBURBS, BM_SUBURB, LD_SUBURB, OOL, BNE, CRUISE, CRUISE_EXTRA,
  });
} catch (err) {
  console.error("km fares not mounted (bookings unaffected):", err.message);
}

/* Stops along the way, priced by the extra distance (stops.js). A booking
   with stops cannot be priced if this fails to mount; one without is unaffected. */
try {
  stopsMod = require("./stops")({
    VEHICLES, VEHICLE_ALIASES, QUOTE_ONLY,
    HUB_ADDRESS: (kmq && kmq.hubAddress) || {
      [OOL]: "Gold Coast Airport terminal, Eastern Ave, Bilinga QLD 4225, Australia",
      [BNE]: "Brisbane Airport Domestic Terminal, Brisbane Airport QLD 4008, Australia",
      [CRUISE]: "Brisbane International Cruise Terminal, Pinkenba QLD 4008, Australia",
    },
  });
  stopsMod.mount(app);
  console.log("stops: quote endpoint ready");
} catch (err) {
  stopsMod = null;
  console.error("stops not mounted (bookings without stops unaffected):", err.message);
}

/* Operations - the dispatch board, drivers, vehicles, and the driver job
   links. Phase 1 of replacing Limo Anywhere. It reads the booking tables the
   portal owns rather than copying them, so it borrows the portal pool and
   admin login. Wrapped like the modules above: nothing on the booking path
   depends on it. */
try {
  ops = require("./ops")({
    app, pool: portal && portal.pool, requireAdmin: portal && portal.requireAdmin,
    VEHICLES, makeRef, mailer, BOOKINGS_EMAIL,
  });
} catch (err) {
  console.error("Ops not mounted (bookings unaffected):", err.message);
}

/* Billing - account tax invoices and the weekly driver pay sheet. Phase 2.
   Same treatment: nothing on the booking path depends on it. */
try {
  billing = require("./billing")({
    app, pool: portal && portal.pool, requireAdmin: portal && portal.requireAdmin,
    /* so an agency can read and download its own invoices in the portal -
       the main login and managers, not bookings-only staff */
    requireAgent: portal && (portal.requireAgentAccounts || portal.requireAgent),
    ops, stripe, mailer, BOOKINGS_EMAIL,
  });
} catch (err) {
  console.error("Billing not mounted (bookings unaffected):", err.message);
}

/* The office dashboard in admin.html - revenue, own fleet against
   subcontractors, driver pay. Read only, and wrapped like the rest. */
try {
  require("./dashboard")({ app, pool: portal && portal.pool, requireAdmin: portal && portal.requireAdmin, ops });
} catch (err) {
  console.error("Dashboard not mounted (bookings unaffected):", err.message);
}

/* Autopilot - picks drivers the evening before, chases unclosed jobs,
   prepares scheduled invoices for one-click approval, sends the morning
   digest and reads account booking emails. Every part is off until switched
   on in dispatch.html, and nothing on the booking path depends on it. */
let autopilot = null;
try {
  autopilot = require("./autopilot")({
    app, pool: portal && portal.pool, requireAdmin: portal && portal.requireAdmin,
    ops, billing, mailer, BOOKINGS_EMAIL, VEHICLES, makeRef,
  });
} catch (err) {
  console.error("Autopilot not mounted (bookings unaffected):", err.message);
}

/* Guest updates (Phase 3) - driver assigned / on the way / arrived, by email
   and later WhatsApp, plus the track-your-driver page's data. Off until
   switched on in the Autopilot tab. Wrapped like everything above. */
try {
  const guest = require("./guest-updates")({
    app, pool: portal && portal.pool, requireAdmin: portal && portal.requireAdmin,
    ops, autopilot, mailer, BOOKINGS_EMAIL, HUBS: [OOL, BNE, CRUISE],
  });
  /* The agent portal shows each booking's trip status and tracking link -
     the same facts as the guest's own tracking page. */
  if (guest && guest.on && portal && typeof portal.setTripStatus === "function") portal.setTripStatus(guest.tripStatus);
} catch (err) {
  console.error("Guest updates not mounted (bookings unaffected):", err.message);
}

/* Phase 4 - import the upcoming Limo Anywhere bookings (dispatch.html Import
   tab, admin only). Wrapped like everything above. */
try {
  require("./la-import")({
    app, pool: portal && portal.pool, requireAdmin: portal && portal.requireAdmin, ops, VEHICLES, makeRef,
  });
} catch (err) {
  console.error("LA import not mounted (bookings unaffected):", err.message);
}
