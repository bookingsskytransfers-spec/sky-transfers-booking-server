/**
 * Sky Transfers — billing: account invoices and the driver pay sheet
 * -------------------------------------------------------------------
 * Phase 2 of replacing Limo Anywhere. Mounted after ops.js, whose board it
 * reads for the pay sheet, and sharing the portal's pool and admin login.
 *
 *   ops_accounts       who we invoice for account work, with billing details
 *   ops_invoices       a GST tax invoice: number, who, period, totals, status
 *   ops_invoice_lines  one line per booking on it
 *
 * Two kinds of party are invoiced:
 *   account  an ops_accounts row; its jobs are ops_jobs whose `account` text
 *            matches the account name (case-insensitively)
 *   agent    an agents row; its jobs are its agent_bookings. The invoice is
 *            the GROSS fare - commission is the agent's wallet, settled
 *            separately on the admin page, and never printed here.
 *
 * A booking can sit on only one live invoice: drafts leave out any reference
 * already on an invoice that is not void, and issuing re-checks on the server,
 * so a double click or two office tabs can never bill a job twice. Voiding an
 * invoice releases its jobs to be invoiced again.
 *
 * Fares are GST-inclusive, so GST is one eleventh of the total.
 *
 * The pay sheet is the board for one Monday-to-Sunday week, grouped by
 * driver: their done legs and the pay agreed on each. "Mark paid" stamps
 * ops_dispatch.driver_paid_at; the driver sees the same figures on their page.
 */
module.exports = function installBilling(ctx) {
  const { app, pool, requireAdmin, ops, stripe, mailer, BOOKINGS_EMAIL } = ctx;
  if (!app || !pool || typeof requireAdmin !== "function" || !ops || !ops.on) {
    console.log("Billing off (needs ops.js and the portal database)");
    return { on: false };
  }
  const path = require("path");
  const fs = require("fs");
  const PDFDocument = require("pdfkit");
  const LOGO = path.join(__dirname, "logo.png");
  const HAS_LOGO = fs.existsSync(LOGO);

  /* The legal name was confirmed by Aman on 9 Sept 2026; "Australia Wide Cars
     Pty Ltd", on some earlier hand-made invoices, is not it. The operator
     accreditation and booking entity authorisation are Queensland TMR's. BEA
     279338 confirmed by Aman on 19 Oct 2026 (an old invoice said 279339 -
     that was the typo). INVOICE_BEA on Render overrides it if it ever changes. */
  const SELLER = {
    name: "Australia Wide Car Services Pty Ltd",
    trading: "trading as Sky Transfers",
    short: "Australia Wide Car Services Pty Ltd T/A Sky Transfers",
    abn: "22 680 932 003",
    oa: "900595993",
    bea: String(process.env.INVOICE_BEA || "279338").trim(),
    contact: "Aman",   /* Aman's choice: first name only, never the full name */
    email: "info@skytransfers.com.au",
    phone: "+61 481 437 772",
    web: "www.skytransfers.com.au",
    address: "43 Riversdale Rd, Oxenford QLD 4210",
  };
  /* Bank details are the office's to set (Render env var), never guessed.
     One per line on the invoice: typed on one line in Render with " · ", "|"
     or ";" between the parts, or with real line breaks. */
  const BANK = String(process.env.INVOICE_BANK_DETAILS || "").trim();
  const BANK_LINES = BANK.replace(/\\n/g, "\n").split(/\r?\n|\s+[·|]\s+|\s*;\s*/).map((s) => s.trim()).filter(Boolean);
  const SITE = String(process.env.PUBLIC_SITE_URL || "https://www.skytransfers.com.au").replace(/\/+$/, "");

  const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const txt = (v, n) => String(v == null ? "" : v).trim().slice(0, n || 200);
  const int = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt; };
  const today = () => ops.bneToday(0);
  const addDays = ops.addDays;
  const inList = (n, start) => Array.from({ length: n }, (_, i) => "$" + (i + (start || 1))).join(", ");
  const gstOf = (cents) => Math.round(cents / 11);
  const dollars = (c) => "$" + (c / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const nice = (d) => { if (!d) return ""; const x = new Date(d + "T00:00:00Z"); return x.getUTCDate() + " " + MONTHS[x.getUTCMonth()] + " " + x.getUTCFullYear(); };
  /* Monday of the week a date falls in. */
  const mondayOf = (d) => { const x = new Date(d + "T00:00:00Z"); const dow = (x.getUTCDay() + 6) % 7; return addDays(d, -dow); };

  /* ---- schema ------------------------------------------------------------ */
  async function initBillingSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ops_accounts (
        id            SERIAL PRIMARY KEY,
        name          TEXT NOT NULL,
        billing_email TEXT,
        contact       TEXT,
        abn           TEXT,
        address       TEXT,
        terms_days    INTEGER NOT NULL DEFAULT 14,
        notes         TEXT,
        active        BOOLEAN NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ops_invoices (
        id            SERIAL PRIMARY KEY,
        number        TEXT UNIQUE,
        party_type    TEXT NOT NULL,
        party_key     TEXT NOT NULL,
        party_name    TEXT NOT NULL,
        bill_email    TEXT,
        bill_contact  TEXT,
        bill_abn      TEXT,
        bill_address  TEXT,
        period_from   DATE,
        period_to     DATE,
        issued_on     DATE NOT NULL,
        due_on        DATE NOT NULL,
        total_cents   INTEGER NOT NULL,
        gst_cents     INTEGER NOT NULL,
        status        TEXT NOT NULL DEFAULT 'issued',
        paid_at       TIMESTAMPTZ,
        paid_note     TEXT,
        pay_link_id   TEXT,
        pay_link_url  TEXT,
        sent_at       TIMESTAMPTZ,
        sent_to       TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ops_invoice_lines (
        id            SERIAL PRIMARY KEY,
        invoice_id    INTEGER NOT NULL REFERENCES ops_invoices(id),
        ref           TEXT NOT NULL,
        service_date  DATE,
        description   TEXT NOT NULL,
        amount_cents  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ops_invoice_lines_ref ON ops_invoice_lines (ref);
      CREATE INDEX IF NOT EXISTS ops_invoice_lines_inv ON ops_invoice_lines (invoice_id);
      -- Autopilot: the addresses or domains this account emails bookings from.
      ALTER TABLE ops_accounts ADD COLUMN IF NOT EXISTS intake_from TEXT;
      -- The client's phone on the invoice, and each line's trip detail (JSON:
      -- time, passenger, references, both ends, flight, service, stops, the
      -- return leg and the times the driver recorded). Lines from before this
      -- have no detail and print their description as they always did.
      ALTER TABLE ops_accounts ADD COLUMN IF NOT EXISTS phone TEXT;
      ALTER TABLE ops_invoices ADD COLUMN IF NOT EXISTS bill_phone TEXT;
      ALTER TABLE ops_invoice_lines ADD COLUMN IF NOT EXISTS detail TEXT;
    `);
  }

  /* ---- what can be billed ---------------------------------------------- */
  async function billedRefs() {
    const { rows } = await pool.query(
      `SELECT l.ref FROM ops_invoice_lines l JOIN ops_invoices i ON i.id = l.invoice_id WHERE i.status <> 'void'`);
    return new Set(rows.map((r) => r.ref));
  }
  async function getAccount(id) {
    const { rows } = await pool.query(`SELECT * FROM ops_accounts WHERE id = $1`, [id]);
    return rows[0] || null;
  }
  async function getAgent(code) {
    const { rows } = await pool.query(`SELECT code, name, email, active FROM agents WHERE code = $1`, [code]);
    return rows[0] || null;
  }

  function describeJob(r) {
    const hourly = r.hire_hours && (!r.dropoff || r.dropoff === "As directed");
    const route = hourly ? `${r.hire_hours} h as directed from ${r.pickup}` : `${r.pickup} to ${r.dropoff}`;
    const parts = [route + (r.rd ? `, return ${nice(r.rd)} ${r.rt || ""}`.trimEnd() : "")];
    if (r.vehicle) parts.push(r.vehicle);
    if (r.pax) parts.push(r.pax + " pax");
    if (r.passenger_name) parts.push(r.passenger_name);
    if (r.account_ref) parts.push("their ref " + r.account_ref);
    return parts.join("; ");
  }

  /* "Private airport chauffeur transfer (Sedan)" and the like - what the
     client's accounts team needs to see the job was. */
  const HUB_RE = /airport|cruise terminal/i;
  function serviceOf(r) {
    const v = r.vehicle ? ` (${r.vehicle})` : "";
    if (r.hire_hours && (!r.dropoff || r.dropoff === "As directed")) return `${r.hire_hours} hours as directed${v}`;
    if (HUB_RE.test(r.pickup || "") || HUB_RE.test(r.dropoff || "")) return `Private airport chauffeur transfer${v}`;
    return `Private chauffeur transfer${v}`;
  }
  /* HH:MM in Brisbane (UTC+10, no daylight saving) from a timestamp. */
  function bneTime(ts) {
    if (!ts) return null;
    const t = ts instanceof Date ? ts.getTime() : Date.parse(ts);
    return Number.isFinite(t) ? new Date(t + 10 * 3600e3).toISOString().slice(11, 16) : null;
  }
  function stopList(v) {
    try {
      const j = v ? JSON.parse(v) : null;
      const list = Array.isArray(j) ? j : j && Array.isArray(j.list) ? j.list : [];
      return list.map((x) => (typeof x === "string" ? x : x && (x.address || x.suburb) || "")).filter(Boolean).slice(0, 3);
    } catch (e) { return []; }
  }
  /* What one invoice line shows, frozen when the invoice is issued. The times
     the driver recorded (on board, and done) are the actual pick-up and
     drop-off times - government and corporate clients ask for both. */
  function detailOf(r, disp) {
    const leg = (l) => disp.find((x) => x.ref === r.ref && x.leg === l) || null;
    const times = (d) => (d ? { pu: bneTime(d.pob_at), do: bneTime(d.done_at) } : {});
    const hourly = !!(r.hire_hours && (!r.dropoff || r.dropoff === "As directed"));
    const det = {
      time: r.t || "", passenger: r.passenger_name || "", pax: r.pax || null,
      clientRef: r.account_ref || "", pickup: r.pickup || "", dropoff: hourly ? "As directed" : (r.dropoff || ""),
      address: r.address || "", addressEnd: HUB_RE.test(r.pickup || "") ? "dropoff" : "pickup",
      flight: r.flight || "", service: serviceOf(r), stops: stopList(r.stops),
      childSeats: r.child_seats || 0, trailer: !!r.trailer, actual: times(leg("out")),
    };
    if (r.rd) det.ret = { date: r.rd, time: r.rt || "", flight: r.rflight || "", actual: times(leg("ret")) };
    return det;
  }

  /* The jobs a party has in a date window that are not yet on a live
     invoice, as invoice lines. */
  async function draftLines(partyType, partyKey, from, to) {
    let rows = [];
    if (partyType === "account") {
      const acc = await getAccount(int(partyKey, 1, 1e9, 0));
      if (!acc) return { error: "No such account." };
      rows = (await pool.query(
        `SELECT ref, account_ref, pickup, dropoff, vehicle, to_char(pickup_date, 'YYYY-MM-DD') AS d, pickup_time AS t,
                to_char(return_date, 'YYYY-MM-DD') AS rd, return_time AS rt, return_flight AS rflight, hire_hours,
                passenger_name, pax, flight, address, stops, child_seats, trailer, price_cents AS cents
           FROM ops_jobs WHERE status <> 'cancelled' AND lower(account) = lower($1) AND pickup_date >= $2 AND pickup_date <= $3`,
        [acc.name, from, to])).rows;
      var party = { type: "account", key: String(acc.id), name: acc.name, email: acc.billing_email, contact: acc.contact,
                    abn: acc.abn, address: acc.address, phone: acc.phone, terms: acc.terms_days || 14 };
    } else if (partyType === "agent") {
      const ag = await getAgent(txt(partyKey, 40));
      if (!ag) return { error: "No such agent." };
      rows = (await pool.query(
        `SELECT ref, client_ref AS account_ref, pickup, dropoff, vehicle, to_char(pickup_date, 'YYYY-MM-DD') AS d, pickup_time AS t,
                to_char(return_date, 'YYYY-MM-DD') AS rd, return_time AS rt, return_flight AS rflight, hire_hours,
                passenger_name, pax, flight, address, stops, child_seats, trailer, total_cents AS cents
           FROM agent_bookings WHERE status <> 'cancelled' AND agent_code = $1 AND pickup_date >= $2 AND pickup_date <= $3`,
        [ag.code, from, to])).rows;
      party = { type: "agent", key: ag.code, name: ag.name, email: ag.email, contact: null, abn: null, address: null, phone: null, terms: 14 };
    } else return { error: "Unknown kind of account." };
    const billed = await billedRefs();
    const refs = rows.map((r) => r.ref);
    const disp = refs.length
      ? (await pool.query(`SELECT ref, leg, status, pob_at, done_at FROM ops_dispatch WHERE ref IN (${inList(refs.length)})`, refs)).rows : [];
    const statusOf = (ref) => { const d = disp.find((x) => x.ref === ref && x.leg === "out"); return d ? d.status : "unassigned"; };
    const lines = rows.filter((r) => !billed.has(r.ref))
      .sort((a, b) => (a.d + a.t).localeCompare(b.d + b.t))
      .map((r) => ({
        ref: r.ref, date: r.d, time: r.t, description: describeJob(r), amountCents: r.cents || 0,
        status: statusOf(r.ref), future: r.d > today(), detail: detailOf(r, disp),
      }));
    return { party, lines };
  }

  /* ---- Stripe payment link for an invoice ---------------------------------
     The webhook sees invoice_for and marks the invoice paid - see
     paidByStripe below. Optional: an invoice without one is still valid. */
  async function payLinkFor(inv) {
    if (!stripe || inv.total_cents <= 0) return null;
    const price = await stripe.prices.create({
      currency: "aud", unit_amount: inv.total_cents,
      product_data: { name: `Sky Transfers tax invoice ${inv.number} - ${inv.party_name}` },
    }, { idempotencyKey: "invprice-" + inv.number });
    const link = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: { invoice_for: inv.number, ref: inv.number },
      after_completion: { type: "hosted_confirmation", hosted_confirmation: { custom_message: `Thank you - invoice ${inv.number} is paid. A receipt is on its way.` } },
      inactive_message: `Invoice ${inv.number} has been paid or replaced. Questions: ${SELLER.phone}.`,
    }, { idempotencyKey: "invlink-" + inv.number });
    await pool.query(`UPDATE ops_invoices SET pay_link_id = $2, pay_link_url = $3 WHERE id = $1`, [inv.id, link.id, link.url]);
    return link.url;
  }
  async function killPayLink(inv) {
    if (stripe && inv.pay_link_id) {
      await stripe.paymentLinks.update(inv.pay_link_id, { active: false }).catch((e) => console.error("invoice link off:", e.message));
    }
  }

  async function invoiceWithLines(id) {
    const { rows } = await pool.query(
      `SELECT *, to_char(issued_on, 'YYYY-MM-DD') AS issued, to_char(due_on, 'YYYY-MM-DD') AS due,
              to_char(period_from, 'YYYY-MM-DD') AS pfrom, to_char(period_to, 'YYYY-MM-DD') AS pto
         FROM ops_invoices WHERE id = $1`, [id]);
    const inv = rows[0];
    if (!inv) return null;
    inv.lines = (await pool.query(
      `SELECT ref, to_char(service_date, 'YYYY-MM-DD') AS date, description, amount_cents, detail
         FROM ops_invoice_lines WHERE invoice_id = $1 ORDER BY service_date, id`, [id])).rows;
    for (const l of inv.lines) { try { l.detail = l.detail ? JSON.parse(l.detail) : null; } catch (e) { l.detail = null; } }
    return inv;
  }
  const publicInvoice = (inv) => ({
    id: inv.id, number: inv.number, partyType: inv.party_type, partyKey: inv.party_key, partyName: inv.party_name,
    billEmail: inv.bill_email, issued: inv.issued, due: inv.due, from: inv.pfrom, to: inv.pto,
    total: inv.total_cents / 100, gst: inv.gst_cents / 100, status: inv.status,
    overdue: inv.status === "issued" && inv.due < today(),
    daysOverdue: inv.status === "issued" && inv.due < today() ? Math.round((Date.parse(today()) - Date.parse(inv.due)) / 864e5) : 0,
    paidAt: inv.paid_at, paidNote: inv.paid_note, sentAt: inv.sent_at, sentTo: inv.sent_to, payUrl: inv.pay_link_url,
    lineCount: inv.line_count != null ? +inv.line_count : (inv.lines ? inv.lines.length : null),
  });

  /* ---- the PDF --------------------------------------------------------------
     A4 landscape, laid out like the invoices the office made by hand: seller
     with accreditation, bill-to, a row per trip (date and time, passenger,
     references, both ends with flights, service, price), GST split out, and
     how to pay. Built to the list COMCAR (and any corporate accounts team)
     rejects invoices against: "Tax Invoice", ABN, contact, phone, current bank
     details, client's name, trip date, pick-up AND drop-off times, their trip
     reference, extra charges, total with GST.
     pdfkit's built-in fonts are WinAnsi only: no arrows, routes say "to". */
  const ddmmyy = (d) => (d ? d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(2, 4) : "");
  const ddmmyyyy = (d) => (d ? d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4) : "");
  function termsText(inv) {
    const days = Math.round((Date.parse(inv.due) - Date.parse(inv.issued)) / 864e5);
    return days > 0 ? days + " days" : "Due on receipt";
  }
  function paidMethod(note) {
    const n = String(note || "");
    if (/^card via stripe/i.test(n)) return "Card (online, via Stripe)";
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : "Recorded by the office";
  }

  function invoicePdf(inv) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", layout: "landscape", margins: { top: 34, bottom: 20, left: 40, right: 40 }, bufferPages: true });
      const bufs = []; doc.on("data", (b) => bufs.push(b)); doc.on("end", () => resolve(Buffer.concat(bufs))); doc.on("error", reject);
      const INK = "#141D30", MUTED = "#68707F", GOLD = "#C9A227", LINE = "#E5E0D2", SOFT = "#F4F1EA", ZEBRA = "#FBF9F4", OK = "#1E8A4C";
      const PW = doc.page.width, PH = doc.page.height, L = 40, R = PW - 40, W = R - L;
      const paid = inv.status === "paid";

      /* ---- seller ---- */
      doc.font("Helvetica-Bold").fontSize(26).fillColor(INK).text("TAX INVOICE", L, 36);
      doc.font("Helvetica").fontSize(9).fillColor(MUTED).text("CHAUFFEUR & TRANSFER SERVICES", L, 68, { characterSpacing: 1 });
      if (paid) {
        doc.save().rotate(-8, { origin: [L + 330, 58] });
        doc.roundedRect(L + 260, 38, 140, 40, 8).lineWidth(2.5).strokeColor(OK).stroke();
        doc.font("Helvetica-Bold").fontSize(24).fillColor(OK).text("PAID", L + 260, 47, { width: 140, align: "center", characterSpacing: 2 });
        doc.restore();
      }
      let sy = 34;
      if (HAS_LOGO) { try { doc.image(LOGO, R - 120, 30, { fit: [120, 44], align: "right" }); sy = 78; } catch (e) {} }
      const sellerLines = [
        [SELLER.short, true],
        [`ABN ${SELLER.abn}`],
        [`Operator accreditation OA ${SELLER.oa}` + (SELLER.bea ? `  ·  BEA ${SELLER.bea}` : "")],
        [`Contact: ${SELLER.contact}  ·  ${SELLER.phone}`],
        [`${SELLER.email}  ·  ${SELLER.web}`],
        [SELLER.address],
      ];
      sellerLines.forEach(([t, bold]) => {
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 9.5 : 8.8).fillColor(bold ? INK : MUTED)
          .text(t, L + W / 2, sy, { width: W / 2, align: "right" });
        sy = doc.y + 1;
      });
      let y = Math.max(sy, 96) + 8;
      doc.rect(L, y, W, 1.5).fill(GOLD);
      y += 12;

      /* ---- bill to / invoice details ---- */
      const half = (W - 14) / 2;
      const billRows = [["Client", inv.party_name, true], ["Attn", inv.bill_contact], ["Address", inv.bill_address],
        ["ABN", inv.bill_abn], ["Email", inv.bill_email], ["Phone", inv.bill_phone]].filter((r) => r[1]);
      const detRows = [["Invoice no.", inv.number, true], ["Date of issue", ddmmyyyy(inv.issued)],
        ["Payment terms", paid ? "Paid" : termsText(inv)], ["Due date", ddmmyyyy(inv.due)],
        ["Period", inv.pfrom && inv.pto ? `${ddmmyyyy(inv.pfrom)} to ${ddmmyyyy(inv.pto)}` : ""],
        ["Amount due", paid ? dollars(0) : dollars(inv.total_cents), true]].filter((r) => r[1]);
      const boxH = Math.max(billRows.length, detRows.length) * 14 + 34;
      doc.rect(L, y, half, boxH).fill(SOFT);
      doc.rect(L + half + 14, y, half, boxH).fill(SOFT);
      const box = (x, title, rows) => {
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text(title, x + 14, y + 10);
        let ry = y + 26;
        rows.forEach(([k, v, bold]) => {
          doc.font("Helvetica").fontSize(8.8).fillColor(MUTED).text(k, x + 14, ry, { width: 80 });
          doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.8).fillColor(INK).text(String(v), x + 100, ry, { width: half - 114, height: 13, ellipsis: true });
          ry += 14;
        });
      };
      box(L, "BILL TO", billRows);
      box(L + half + 14, "INVOICE DETAILS", detRows);
      y += boxH + 16;

      /* ---- the trips ---- */
      doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text("TRANSFER / BOOKING DETAILS", L, y);
      y += 15;
      const COLS = [["DATE & TIME", 80], ["PASSENGER", 112], ["BOOKING REF", 86], ["PICK UP", 150], ["DROP OFF", 150], ["SERVICE TYPE", 104], ["PRICE (INC GST)", 80]];
      const X = []; COLS.reduce((x, c) => { X.push(x); return x + c[1]; }, L);
      const head = () => {
        doc.rect(L, y, W, 20).fill(INK);
        COLS.forEach(([t, w], i) => doc.font("Helvetica-Bold").fontSize(7.2).fillColor("#F6F2E8")
          .text(t, X[i] + 5, y + 7, { width: w - 10, align: i === 6 ? "right" : "left", characterSpacing: 0.2, lineBreak: false }));
        y += 22;
      };
      /* A cell is a list of [text, style]: "" body, "m" muted small, "b" bold. */
      const FONT = { "": ["Helvetica", 8.4, INK], m: ["Helvetica", 7.4, MUTED], b: ["Helvetica-Bold", 8.4, INK] };
      const cellH = (parts, w) => parts.reduce((h, [t, s]) => { const f = FONT[s || ""]; doc.font(f[0]).fontSize(f[1]); return h + doc.heightOfString(t, { width: w - 10 }) + 1; }, 0);
      const drawCell = (parts, x, w, top, right) => {
        let cy = top;
        parts.forEach(([t, s]) => { const f = FONT[s || ""]; doc.font(f[0]).fontSize(f[1]).fillColor(f[2]).text(t, x + 5, cy, { width: w - 10, align: right ? "right" : "left" }); cy = doc.y + 1; });
      };
      const rowsOf = (ln) => {
        const d = ln.detail;
        if (!d) return [[[[ln.date ? ddmmyy(ln.date) : ""]], [], [[ln.ref]], [[ln.description]], null, null, [[dollars(ln.amount_cents), "b"]]]];
        const timesOf = (a) => [a && a.pu ? [`Picked up ${a.pu}`, "m"] : null, a && a.do ? [`Dropped off ${a.do}`, "m"] : null].filter(Boolean);
        const pax = d.pax ? ` (${d.pax} pax)` : "";
        const refCell = d.clientRef ? [[d.clientRef, "b"], [`Our ref ${ln.ref}`, "m"]] : [[ln.ref]];
        /* the flight sits under the airport end - arriving or departing */
        const flightEnd = HUB_RE.test(d.pickup) ? "pickup" : HUB_RE.test(d.dropoff) ? "dropoff" : "pickup";
        const pu = [[d.pickup]], dr = [[d.dropoff]];
        if (d.flight) (flightEnd === "pickup" ? pu : dr).push([`Flight ${d.flight}`, "m"]);
        if (d.address) (d.addressEnd === "dropoff" ? dr : pu).push([d.address, "m"]);
        if (d.stops && d.stops.length) dr.push([`Stops on the way: ${d.stops.join("; ")}`, "m"]);
        const svc = [[d.service]];
        if (d.childSeats) svc.push([`${d.childSeats} child seat${d.childSeats === 1 ? "" : "s"}`, "m"]);
        if (d.trailer) svc.push(["Luggage trailer", "m"]);
        if (d.ret) svc.push(["Return trip - both legs", "m"]);
        const out = [[[`${ddmmyy(ln.date)} ${d.time}`.trim()]].concat(timesOf(d.actual)), [[d.passenger + pax]], refCell, pu, dr, svc, [[dollars(ln.amount_cents), "b"]]];
        const rows = [out];
        if (d.ret) {
          const rpu = [[d.dropoff]], rdr = [[d.pickup]];
          if (d.ret.flight) (HUB_RE.test(d.pickup) ? rdr : rpu).push([`Flight ${d.ret.flight}`, "m"]);
          if (d.address) (d.addressEnd === "dropoff" ? rpu : rdr).push([d.address, "m"]);
          rows.push([[[`${ddmmyy(d.ret.date)} ${d.ret.time}`.trim()]].concat(timesOf(d.ret.actual)), [[d.passenger + pax]], [["Return leg", "m"]],
            rpu, rdr, [["Return leg of the trip above", "m"]], [["Incl.", "m"]]]);
        }
        return rows;
      };
      head();
      let zebra = false;
      inv.lines.forEach((ln) => {
        const rows = rowsOf(ln);
        rows.forEach((cells, ri) => {
          /* the old free-text description spans the route and service columns */
          const merged = cells[4] === null;
          const widthOf = (i) => (merged && i === 3 ? COLS[3][1] + COLS[4][1] + COLS[5][1] : COLS[i][1]);
          const h = Math.max(18, ...cells.map((c, i) => (c ? cellH(c, widthOf(i)) : 0))) + 8;
          if (y + h > PH - 54) { doc.addPage(); y = 40; head(); }
          if (ri === 0) zebra = !zebra;
          if (zebra) doc.rect(L, y - 2, W, h).fill(ZEBRA);
          cells.forEach((c, i) => { if (c) drawCell(c, X[i], widthOf(i), y + 3, i === 6); });
          y += h;
        });
        doc.moveTo(L, y - 1).lineTo(R, y - 1).lineWidth(0.5).strokeColor(LINE).stroke();
      });
      y += 12;

      /* ---- totals (right) and how to pay / payment received (left) ---- */
      const payLines = [];
      if (!paid) {
        if (BANK_LINES.length) {
          payLines.push(["Direct bank deposit", "b"]);
          BANK_LINES.forEach((t) => payLines.push([t, ""]));
          payLines.push([`Reference: ${inv.number}`, ""]);
          payLines.push(["", ""]);
        }
        payLines.push(["Credit card / online payment", "b"]);
        payLines.push(inv.pay_link_url ? [inv.pay_link_url, "link"] : ["Ask us for a secure card payment link.", ""]);
        payLines.push(["", ""]);
        payLines.push([`Please quote ${inv.number} with your payment. Payment due by ${ddmmyyyy(inv.due)}.`, ""]);
      } else {
        payLines.push(["Status: PAID IN FULL", "b"]);
        if (inv.paid_at) payLines.push([`Date paid: ${ddmmyyyy(new Date(new Date(inv.paid_at).getTime() + 10 * 3600e3).toISOString().slice(0, 10))}`, ""]);
        payLines.push([`Method: ${paidMethod(inv.paid_note)}`, ""]);
        payLines.push([`Reference: ${inv.number}`, ""]);
      }
      const leftW = W - 300;
      const payH = 18 + payLines.reduce((h, [t]) => { doc.font("Helvetica").fontSize(8.8); return h + (t ? doc.heightOfString(t, { width: leftW }) + 2 : 6); }, 0);
      if (y + Math.max(payH, 110) > PH - 60) { doc.addPage(); y = 40; }
      const top = y;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(paid ? "PAYMENT RECEIVED" : "PAYMENT METHODS", L, y);
      let py = y + 16;
      payLines.forEach(([t, s]) => {
        if (!t) { py += 6; return; }
        if (s === "link") doc.font("Helvetica").fontSize(8.8).fillColor("#1F5FA8").text(t, L, py, { width: leftW, link: t, underline: true });
        else doc.font(s === "b" ? "Helvetica-Bold" : "Helvetica").fontSize(8.8).fillColor(INK).text(t, L, py, { width: leftW });
        py = doc.y + 2;
      });
      const TX = R - 270, TW = 270;
      let ty = top;
      const gst = inv.gst_cents;
      [["Subtotal (ex GST)", dollars(inv.total_cents - gst)], ["GST (10%)", dollars(gst)]].forEach(([k, v]) => {
        doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(k, TX + 10, ty, { width: 150 });
        doc.fillColor(INK).text(v, TX + 160, ty, { width: TW - 170, align: "right" });
        ty += 17;
      });
      doc.rect(TX, ty, TW, 26).fill(INK);
      doc.font("Helvetica-Bold").fontSize(11.5).fillColor("#FFFFFF").text("Total (AUD)", TX + 10, ty + 8, { width: 150 })
        .text(dollars(inv.total_cents), TX + 160, ty + 8, { width: TW - 170, align: "right" });
      ty += 34;
      if (paid) {
        doc.font("Helvetica").fontSize(9.5).fillColor(MUTED)
          .text(`Less: paid${inv.paid_at ? " " + ddmmyyyy(new Date(new Date(inv.paid_at).getTime() + 10 * 3600e3).toISOString().slice(0, 10)) : ""}`, TX + 10, ty, { width: 150 });
        doc.fillColor(INK).text("-" + dollars(inv.total_cents), TX + 160, ty, { width: TW - 170, align: "right" });
        ty += 17;
        doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text("Balance due", TX + 10, ty, { width: 150 })
          .text(dollars(0), TX + 160, ty, { width: TW - 170, align: "right" });
      } else {
        doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text("Amount due", TX + 10, ty, { width: 150 })
          .text(dollars(inv.total_cents), TX + 160, ty, { width: TW - 170, align: "right" });
      }

      /* ---- footer on every page ---- */
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        if (i > 0) doc.font("Helvetica").fontSize(7.8).fillColor(MUTED)
          .text(`Tax invoice ${inv.number}  ·  ${inv.party_name}  ·  continued`, L, 18, { width: W, lineBreak: false });
        doc.moveTo(L, PH - 44).lineTo(R, PH - 44).lineWidth(0.8).strokeColor(GOLD).stroke();
        doc.font("Helvetica-Oblique").fontSize(8.5).fillColor(GOLD).text("Thank you for your business.", L, PH - 36, { width: 200, lineBreak: false });
        doc.font("Helvetica").fontSize(7.8).fillColor(MUTED)
          .text(`${SELLER.short}  |  ABN ${SELLER.abn}  |  ${SELLER.address}  |  Page ${i + 1} of ${range.count}`, L + 200, PH - 36, { width: W - 200, align: "right", lineBreak: false });
      }
      doc.end();
    });
  }

  /* ================= office routes: accounts ================= */
  app.get("/ops/billing", requireAdmin, async (req, res) => {
    try {
      const t = today();
      const accounts = (await pool.query(`SELECT * FROM ops_accounts ORDER BY active DESC, name`)).rows;
      const agents = (await pool.query(`SELECT code, name, email, active FROM agents ORDER BY active DESC, name`)).rows;
      const jobs = (await pool.query(
        `SELECT ref, account, price_cents FROM ops_jobs WHERE status <> 'cancelled' AND pickup_date <= $1`, [t])).rows;
      const ajobs = (await pool.query(
        `SELECT ref, agent_code, total_cents FROM agent_bookings WHERE status <> 'cancelled' AND pickup_date <= $1`, [t])).rows;
      const invs = (await pool.query(
        `SELECT party_type, party_key, total_cents, status, to_char(due_on, 'YYYY-MM-DD') AS due FROM ops_invoices WHERE status = 'issued'`)).rows;
      const billed = await billedRefs();
      const unbilled = (list, keyOf, centsOf) => {
        const m = new Map();
        for (const j of list) if (!billed.has(j.ref)) {
          const k = keyOf(j); const v = m.get(k) || { count: 0, cents: 0 };
          v.count++; v.cents += centsOf(j) || 0; m.set(k, v);
        }
        return m;
      };
      const ub = unbilled(jobs, (j) => String(j.account || "").toLowerCase(), (j) => j.price_cents);
      const ubA = unbilled(ajobs, (j) => j.agent_code, (j) => j.total_cents);
      const open = (type, key) => invs.filter((i) => i.party_type === type && i.party_key === key)
        .reduce((a, i) => { a.open += i.total_cents; if (i.due < t) a.overdue += i.total_cents; return a; }, { open: 0, overdue: 0 });
      const known = new Set(accounts.map((a) => a.name.toLowerCase()));
      const out = accounts.map((a) => {
        const u = ub.get(a.name.toLowerCase()) || { count: 0, cents: 0 }, o = open("account", String(a.id));
        return { type: "account", key: String(a.id), id: a.id, name: a.name, email: a.billing_email, contact: a.contact, abn: a.abn,
                 address: a.address, phone: a.phone || "", terms: a.terms_days, notes: a.notes, active: a.active, intakeFrom: a.intake_from || "",
                 unbilledCount: u.count, unbilled: u.cents / 100, open: o.open / 100, overdue: o.overdue / 100 };
      }).concat(agents.map((g) => {
        const u = ubA.get(g.code) || { count: 0, cents: 0 }, o = open("agent", g.code);
        return { type: "agent", key: g.code, name: g.name, email: g.email, active: g.active, terms: 14,
                 unbilledCount: u.count, unbilled: u.cents / 100, open: o.open / 100, overdue: o.overdue / 100 };
      }));
      /* Names typed on account jobs that have no account set up yet - so a
         month of Krishiv work cannot sit unbilled just because of spelling. */
      const unknown = [];
      for (const [k, v] of ub) if (k && !known.has(k)) {
        const name = (jobs.find((j) => String(j.account || "").toLowerCase() === k) || {}).account;
        unknown.push({ name, unbilledCount: v.count, unbilled: v.cents / 100 });
      }
      res.json({ today: t, parties: out, unknown, bankDetailsSet: !!BANK, cardLinks: !!stripe });
    } catch (err) {
      console.error("billing overview:", err);
      res.status(500).json({ error: "Could not load accounts." });
    }
  });

  app.post("/ops/account", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const name = txt(b.name, 120);
      if (!name) return res.status(400).json({ error: "An account needs a name - the same one typed on its jobs." });
      const id = b.id ? int(b.id, 1, 1e9, null) : null;
      const clash = (await pool.query(`SELECT id FROM ops_accounts WHERE lower(name) = lower($1)`, [name])).rows
        .find((r) => r.id !== id);
      if (clash) return res.status(409).json({ error: `There is already an account called ${name}.` });
      const vals = [name, txt(b.email, 200) || null, txt(b.contact, 120) || null, txt(b.abn, 20) || null,
        txt(b.address, 300) || null, int(b.terms, 0, 120, 14), txt(b.notes, 1000) || null,
        b.active === false || b.active === "false" ? false : true,
        /* lower-case, comma separated, addresses or @domains only */
        String(b.intakeFrom || "").toLowerCase().split(/[\s,;]+/).filter((x) => /^[^\s@]*@[^\s@]+\.[^\s@]+$/.test(x)).join(",") || null,
        txt(b.phone, 60) || null];
      if (id) {
        const r = await pool.query(
          `UPDATE ops_accounts SET name=$1, billing_email=$2, contact=$3, abn=$4, address=$5, terms_days=$6, notes=$7, active=$8, intake_from=$9, phone=$10 WHERE id=$11`,
          vals.concat([id]));
        if (!r.rowCount) return res.status(404).json({ error: "No such account." });
        return res.json({ ok: true, id });
      }
      const { rows } = await pool.query(
        `INSERT INTO ops_accounts (name, billing_email, contact, abn, address, terms_days, notes, active, intake_from, phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, vals);
      res.json({ ok: true, id: rows[0].id });
    } catch (err) {
      console.error("billing account:", err);
      res.status(500).json({ error: "Could not save that account." });
    }
  });

  /* ================= office routes: invoices ================= */
  app.post("/ops/invoice/draft", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const from = isoDate(b.from), to = isoDate(b.to);
      if (!from || !to || to < from) return res.status(400).json({ error: "Choose the period to invoice." });
      const d = await draftLines(b.partyType, b.partyKey, from, to);
      if (d.error) return res.status(404).json({ error: d.error });
      const total = d.lines.reduce((a, l) => a + l.amountCents, 0);
      res.json({ party: d.party, from, to, lines: d.lines.map((l) => ({ ...l, amount: l.amountCents / 100 })),
                 total: total / 100, gst: gstOf(total) / 100 });
    } catch (err) {
      console.error("invoice draft:", err);
      res.status(500).json({ error: "Could not build that invoice." });
    }
  });

  /* Issues an invoice for the given refs of one party's draft. Throws
     {code, message}. Used by the office route and by autopilot.js. */
  async function issueInvoice({ partyType, partyKey, from, to, refs, issuedOn }) {
    from = isoDate(from); to = isoDate(to);
    if (!from || !to || to < from) throw { code: 400, message: "Choose the period to invoice." };
    const want = new Set((Array.isArray(refs) ? refs : []).map((r) => txt(r, 40)));
    /* Built again here, never taken from the caller: only jobs that really
       belong to this party, in this period, not yet billed. */
    const d = await draftLines(partyType, partyKey, from, to);
    if (d.error) throw { code: 404, message: d.error };
    const lines = d.lines.filter((l) => want.has(l.ref));
    if (!lines.length) throw { code: 400, message: "Nothing left to invoice - those jobs may already be on another invoice." };
    const total = lines.reduce((a, l) => a + l.amountCents, 0);
    const issued = isoDate(issuedOn) || today();
    const due = addDays(issued, d.party.terms != null ? d.party.terms : 14);
    const { rows } = await pool.query(
      `INSERT INTO ops_invoices (party_type, party_key, party_name, bill_email, bill_contact, bill_abn, bill_address,
         period_from, period_to, issued_on, due_on, total_cents, gst_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [d.party.type, d.party.key, d.party.name, d.party.email || null, d.party.contact || null, d.party.abn || null,
       d.party.address || null, from, to, issued, due, total, gstOf(total)]);
    const id = rows[0].id;
    const number = "SKY-" + issued.slice(0, 4) + "-" + String(id).padStart(4, "0");
    await pool.query(`UPDATE ops_invoices SET number = $2, bill_phone = $3 WHERE id = $1`, [id, number, d.party.phone || null]);
    for (const l of lines) {
      await pool.query(`INSERT INTO ops_invoice_lines (invoice_id, ref, service_date, description, amount_cents, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, l.ref, l.date, l.description, l.amountCents, l.detail ? JSON.stringify(l.detail) : null]);
    }
    /* The race the draft check cannot see: two issues at the same moment.
       If any line is now on two live invoices, this one stands down. */
    const rs = lines.map((l) => l.ref);
    const dup = (await pool.query(
      `SELECT l.ref FROM ops_invoice_lines l JOIN ops_invoices i ON i.id = l.invoice_id
        WHERE i.status <> 'void' AND i.id <> $1 AND l.ref IN (${inList(rs.length, 2)})`, [id].concat(rs))).rows;
    if (dup.length) {
      await pool.query(`UPDATE ops_invoices SET status = 'void', paid_note = 'auto-voided: jobs already invoiced' WHERE id = $1`, [id]);
      throw { code: 409, message: "Some of those jobs were invoiced a moment ago from somewhere else - nothing new was issued." };
    }
    let inv = await invoiceWithLines(id);
    await payLinkFor(inv).catch((e) => console.error("invoice pay link:", e.message));
    inv = await invoiceWithLines(id);
    console.log("invoice issued:", number, d.party.name, dollars(total), lines.length, "lines");
    return inv;
  }

  app.post("/ops/invoice", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const inv = await issueInvoice({ partyType: b.partyType, partyKey: b.partyKey, from: b.from, to: b.to, refs: b.refs, issuedOn: b.issuedOn });
      res.json({ ok: true, invoice: publicInvoice(inv) });
    } catch (err) {
      if (err && err.code) return res.status(err.code).json({ error: err.message });
      console.error("invoice issue:", err);
      res.status(500).json({ error: "Could not issue that invoice." });
    }
  });

  app.get("/ops/invoices", requireAdmin, async (req, res) => {
    try {
      const st = ["issued", "paid", "void"].includes(req.query.status) ? req.query.status : null;
      const { rows } = await pool.query(
        `SELECT i.*, to_char(i.issued_on, 'YYYY-MM-DD') AS issued, to_char(i.due_on, 'YYYY-MM-DD') AS due,
                to_char(i.period_from, 'YYYY-MM-DD') AS pfrom, to_char(i.period_to, 'YYYY-MM-DD') AS pto
           FROM ops_invoices i ${st ? "WHERE i.status = $1" : ""} ORDER BY i.id DESC LIMIT 300`, st ? [st] : []);
      const counts = (await pool.query(`SELECT invoice_id, count(*)::int AS n FROM ops_invoice_lines GROUP BY invoice_id`)).rows;
      const byId = new Map(counts.map((c) => [c.invoice_id, c.n]));
      res.json({ today: today(), invoices: rows.map((r) => publicInvoice({ ...r, line_count: byId.get(r.id) || 0 })) });
    } catch (err) {
      console.error("invoices list:", err);
      res.status(500).json({ error: "Could not load invoices." });
    }
  });

  /* ================= the agency's own view (agent.html) =================
     An agency sees only the invoices issued to it - party_type 'agent' and
     its own code - never another agency's and never a void one. Read only:
     paying is the Stripe link already on each invoice. The statement adds
     what is not invoiced yet (its past trips not on a live invoice), so
     nothing it owes is hidden from it. */
  if (typeof ctx.requireAgent === "function") {
    const requireAgent = ctx.requireAgent;
    app.get("/agent/invoices", requireAgent, async (req, res) => {
      try {
        const code = req.agent.code, t = today();
        const { rows } = await pool.query(
          `SELECT i.*, to_char(i.issued_on, 'YYYY-MM-DD') AS issued, to_char(i.due_on, 'YYYY-MM-DD') AS due,
                  to_char(i.period_from, 'YYYY-MM-DD') AS pfrom, to_char(i.period_to, 'YYYY-MM-DD') AS pto
             FROM ops_invoices i WHERE i.party_type = 'agent' AND i.party_key = $1 AND i.status <> 'void'
            ORDER BY i.id DESC LIMIT 200`, [code]);
        const ids = rows.map((r) => r.id);
        const counts = ids.length
          ? (await pool.query(`SELECT invoice_id, count(*)::int AS n FROM ops_invoice_lines WHERE invoice_id IN (${inList(ids.length)}) GROUP BY invoice_id`, ids)).rows : [];
        const byId = new Map(counts.map((c) => [c.invoice_id, c.n]));
        const invoices = rows.map((r) => {
          const p = publicInvoice({ ...r, line_count: byId.get(r.id) || 0 });
          return { id: p.id, number: p.number, issued: p.issued, due: p.due, from: p.from, to: p.to, total: p.total, gst: p.gst,
                   status: p.status, overdue: p.overdue, daysOverdue: p.daysOverdue, paidAt: p.paidAt, trips: p.lineCount,
                   payUrl: p.status === "issued" ? p.payUrl || null : null };
        });
        const open = invoices.filter((i) => i.status === "issued");
        const late = open.filter((i) => i.overdue);
        const billed = await billedRefs();
        const unbilled = (await pool.query(
          `SELECT ref, total_cents FROM agent_bookings WHERE agent_code = $1 AND status = 'confirmed' AND pickup_date <= $2`, [code, t]))
          .rows.filter((r) => !billed.has(r.ref));
        const sum = (list, f) => Math.round(list.reduce((a, x) => a + f(x), 0) * 100) / 100;
        res.json({
          today: t, invoices,
          statement: {
            owing: sum(open, (i) => i.total), owingCount: open.length,
            overdue: sum(late, (i) => i.total), overdueCount: late.length,
            uninvoiced: sum(unbilled, (r) => r.total_cents / 100), uninvoicedCount: unbilled.length,
          },
        });
      } catch (err) {
        console.error("agent invoices:", err);
        res.status(500).json({ error: "Could not load your invoices just now." });
      }
    });
    app.get("/agent/invoice/pdf", requireAgent, async (req, res) => {
      try {
        const inv = await invoiceWithLines(int(req.query.id, 1, 1e9, 0));
        if (!inv || inv.party_type !== "agent" || inv.party_key !== req.agent.code || inv.status === "void") {
          return res.status(404).json({ error: "We can't find that invoice." });
        }
        const pdf = await invoicePdf(inv);
        res.set("Content-Type", "application/pdf");
        res.set("Content-Disposition", `attachment; filename="${inv.number}.pdf"`);
        res.set("Cache-Control", "no-store");
        res.end(pdf);
      } catch (err) {
        console.error("agent invoice pdf:", err);
        res.status(500).json({ error: "Could not make that PDF." });
      }
    });
  }

  app.get("/ops/invoice/pdf", requireAdmin, async (req, res) => {
    try {
      const inv = await invoiceWithLines(int(req.query.id, 1, 1e9, 0));
      if (!inv) return res.status(404).json({ error: "No such invoice." });
      const pdf = await invoicePdf(inv);
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `attachment; filename="${inv.number}.pdf"`);
      res.set("Cache-Control", "no-store");
      res.end(pdf);
    } catch (err) {
      console.error("invoice pdf:", err);
      res.status(500).json({ error: "Could not make that PDF." });
    }
  });

  /* Emails an invoice with its PDF. Throws {code, message}. */
  async function sendInvoice(id, toOverride) {
    if (!mailer) throw { code: 500, message: "Email is not configured on the server." };
    const inv = await invoiceWithLines(int(id, 1, 1e9, 0));
    if (!inv) throw { code: 404, message: "No such invoice." };
    if (inv.status === "void") throw { code: 409, message: "That invoice is void." };
    const to = txt(toOverride, 200) || inv.bill_email;
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw { code: 400, message: "Give an email address to send it to." };
    if (inv.status === "issued" && !inv.pay_link_url) { await payLinkFor(inv).catch(() => null); }
    const fresh = await invoiceWithLines(inv.id);
    const pdf = await invoicePdf(fresh);
    const paid = fresh.status === "paid";
    await mailer.sendMail({
      from: `"Sky Transfers Accounts" <${process.env.GMAIL_USER}>`, to, replyTo: BOOKINGS_EMAIL, bcc: BOOKINGS_EMAIL,
      subject: paid ? `Paid tax invoice ${fresh.number} - Sky Transfers`
                    : `Tax invoice ${fresh.number} from Sky Transfers - ${dollars(fresh.total_cents)} due ${nice(fresh.due)}`,
      text: `Hello${fresh.bill_contact ? " " + fresh.bill_contact.split(" ")[0] : ""},\n\n` +
        (paid ? `Attached is your paid tax invoice ${fresh.number} for ${fresh.party_name}. Thank you.\n`
              : `Attached is tax invoice ${fresh.number} for ${fresh.party_name}: ${fresh.lines.length} transfer${fresh.lines.length === 1 ? "" : "s"}` +
                (fresh.pfrom ? ` from ${nice(fresh.pfrom)} to ${nice(fresh.pto)}` : "") + `.\n\n` +
                `Amount due: ${dollars(fresh.total_cents)} (GST inclusive), by ${nice(fresh.due)}.\n` +
                (fresh.pay_link_url ? `\nPay by card: ${fresh.pay_link_url}\n` : "") +
                (BANK_LINES.length ? `\nDirect bank deposit:\n${BANK_LINES.join("\n")}\nReference: ${fresh.number}\n` : "")) +
        `\nAny questions, reply to this email or call ${SELLER.phone}.\n\nKind regards,\n${SELLER.contact}\nSky Transfers\n` +
        `${SELLER.short}\nABN ${SELLER.abn}  ·  Operator accreditation OA ${SELLER.oa}${SELLER.bea ? "  ·  BEA " + SELLER.bea : ""}\n` +
        `${SELLER.address}\n${SELLER.phone}  ·  ${SELLER.email}  ·  ${SELLER.web}`,
      attachments: [{ filename: fresh.number + ".pdf", content: pdf, contentType: "application/pdf" }],
    });
    await pool.query(`UPDATE ops_invoices SET sent_at = now(), sent_to = $2 WHERE id = $1`, [fresh.id, to]);
    console.log("invoice sent:", fresh.number, "->", to);
    return { to, invoice: fresh };
  }

  app.post("/ops/invoice/send", requireAdmin, async (req, res) => {
    try {
      const r = await sendInvoice((req.body || {}).id, (req.body || {}).to);
      res.json({ ok: true, to: r.to });
    } catch (err) {
      if (err && err.code) return res.status(err.code).json({ error: err.message });
      console.error("invoice send:", err);
      res.status(500).json({ error: "Could not send that invoice." });
    }
  });

  app.post("/ops/invoice/paid", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const inv = await invoiceWithLines(int(b.id, 1, 1e9, 0));
      if (!inv) return res.status(404).json({ error: "No such invoice." });
      if (inv.status === "void") return res.status(409).json({ error: "That invoice is void." });
      const unpay = b.paid === false;
      await pool.query(
        `UPDATE ops_invoices SET status = $2, paid_at = ${unpay ? "NULL" : "COALESCE(paid_at, now())"}, paid_note = $3 WHERE id = $1`,
        [inv.id, unpay ? "issued" : "paid", unpay ? null : (txt(b.note, 200) || "marked paid in the office")]);
      if (!unpay) await killPayLink(inv);
      console.log("invoice", unpay ? "re-opened:" : "paid (office):", inv.number);
      res.json({ ok: true });
    } catch (err) {
      console.error("invoice paid:", err);
      res.status(500).json({ error: "Could not update that invoice." });
    }
  });

  app.post("/ops/invoice/void", requireAdmin, async (req, res) => {
    try {
      const inv = await invoiceWithLines(int((req.body || {}).id, 1, 1e9, 0));
      if (!inv) return res.status(404).json({ error: "No such invoice." });
      if (inv.status === "paid") return res.status(409).json({ error: "A paid invoice can't be voided - re-open it first if the payment was a mistake." });
      await pool.query(`UPDATE ops_invoices SET status = 'void' WHERE id = $1`, [inv.id]);
      await killPayLink(inv);
      console.log("invoice voided:", inv.number);
      res.json({ ok: true });
    } catch (err) {
      console.error("invoice void:", err);
      res.status(500).json({ error: "Could not void that invoice." });
    }
  });

  /* Called by the Stripe webhook when a payment carries invoice_for. A part
     payment is recorded as a note and leaves the invoice open. */
  async function paidByStripe(number, amountCents, paymentIntent) {
    const { rows } = await pool.query(`SELECT id, number, status, total_cents, party_name, pay_link_id FROM ops_invoices WHERE number = $1`, [number]);
    const inv = rows[0];
    if (!inv) { console.error("invoice payment for unknown invoice:", number); return null; }
    const full = amountCents >= inv.total_cents;
    await pool.query(
      `UPDATE ops_invoices SET status = CASE WHEN $2 THEN 'paid' ELSE status END,
         paid_at = CASE WHEN $2 THEN COALESCE(paid_at, now()) ELSE paid_at END, paid_note = $3 WHERE id = $1`,
      [inv.id, full, `card via Stripe ${dollars(amountCents)}${paymentIntent ? " (" + paymentIntent + ")" : ""}`]);
    if (full) await killPayLink(inv);
    console.log("invoice paid (Stripe):", number, dollars(amountCents), full ? "in full" : "PART PAYMENT");
    if (mailer) mailer.sendMail({
      from: `"Sky Transfers Accounts" <${process.env.GMAIL_USER}>`, to: BOOKINGS_EMAIL,
      subject: `INVOICE PAID${full ? "" : " (PART)"}: ${number} - ${inv.party_name} - ${dollars(amountCents)}`,
      text: `${inv.party_name} paid ${dollars(amountCents)} by card against ${number} (total ${dollars(inv.total_cents)}).` +
            (full ? "\nThe invoice is marked paid on the dispatch page." : "\nThis is LESS than the total - the invoice is still open."),
    }).catch((e) => console.error("invoice paid alert:", e.message));
    return { full };
  }

  /* ================= driver pay sheet ================= */
  async function payWeek(from) {
    const start = mondayOf(from), end = addDays(start, 6);
    const b = await ops.boardFor(start, end);
    const drivers = b.drivers;
    const byDriver = new Map();
    for (const l of b.legs) if (l.driverId) {
      if (!byDriver.has(l.driverId)) byDriver.set(l.driverId, []);
      byDriver.get(l.driverId).push(l);
    }
    const out = [];
    for (const [id, legs] of byDriver) {
      const d = drivers.find((x) => x.id === id) || { id, name: "Driver " + id };
      const done = legs.filter((l) => l.status === "done");
      const rows = legs.map((l) => ({ ref: l.ref, leg: l.leg, date: l.date, time: l.time, from: l.from, to: l.to,
        hours: l.hours, status: l.status, pay: l.driverPay, paidAt: l.driverPaidAt }));
      out.push({
        id, name: d.name, phone: d.phone, kind: d.kind,
        jobs: rows, doneCount: done.length,
        total: done.reduce((a, l) => a + (l.driverPay || 0), 0),
        unpaid: done.filter((l) => !l.driverPaidAt).reduce((a, l) => a + (l.driverPay || 0), 0),
        missingPay: done.filter((l) => l.driverPay == null).length,
        notDone: legs.filter((l) => l.status !== "done" && l.status !== "declined").length,
        allPaid: done.length > 0 && done.every((l) => l.driverPaidAt),
      });
    }
    out.sort((a, b2) => a.name.localeCompare(b2.name));
    return { from: start, to: end, drivers: out };
  }

  app.get("/ops/pay", requireAdmin, async (req, res) => {
    try { res.json(await payWeek(isoDate(req.query.from) || today())); }
    catch (err) { console.error("pay sheet:", err); res.status(500).json({ error: "Could not build the pay sheet." }); }
  });

  /* Marks (or unmarks) a driver's DONE legs for one week as paid. Legs not
     done are never marked - they are not owed yet. */
  app.post("/ops/pay/mark", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const id = int(b.driverId, 1, 1e9, 0);
      const week = await payWeek(isoDate(b.from) || today());
      const d = week.drivers.find((x) => x.id === id);
      if (!d) return res.status(404).json({ error: "That driver has no jobs that week." });
      const paid = b.paid !== false;
      let n = 0;
      for (const j of d.jobs) if (j.status === "done") {
        await pool.query(`UPDATE ops_dispatch SET driver_paid_at = ${paid ? "COALESCE(driver_paid_at, now())" : "NULL"} WHERE ref = $1 AND leg = $2 AND driver_id = $3`,
          [j.ref, j.leg, id]);
        n++;
      }
      console.log("pay sheet:", d.name, week.from, paid ? "marked paid" : "unmarked", n, "legs");
      res.json({ ok: true, legs: n });
    } catch (err) {
      console.error("pay mark:", err);
      res.status(500).json({ error: "Could not update that." });
    }
  });

  /* The driver's own view: this week and the four before it. */
  app.post("/driver/pay", async (req, res) => {
    try {
      const drv = await ops.driverFromToken((req.body || {}).t);
      if (!drv) return res.status(401).json({ error: "This link has expired or been replaced. Ask the office for your new one." });
      const weeks = [];
      let start = mondayOf(today());
      for (let i = 0; i < 5; i++) {
        const w = await payWeek(start);
        const d = w.drivers.find((x) => x.id === drv.id);
        weeks.push({
          from: w.from, to: w.to,
          jobs: d ? d.jobs.filter((j) => j.status === "done").map((j) => ({ ref: j.ref, leg: j.leg, date: j.date, time: j.time,
            from: j.from, to: j.to, hours: j.hours, pay: j.pay, paid: !!j.paidAt })) : [],
          total: d ? d.total : 0, unpaid: d ? d.unpaid : 0, allPaid: d ? d.allPaid : false,
        });
        start = addDays(start, -7);
      }
      res.json({ driver: { name: drv.name }, weeks });
    } catch (err) {
      console.error("driver pay:", err);
      res.status(500).json({ error: "Could not load your pay - try again in a moment." });
    }
  });

  initBillingSchema()
    .then(() => console.log("Billing ready (invoices, accounts, pay sheet)" + (BANK ? "" : " - INVOICE_BANK_DETAILS not set, invoices show card payment only")))
    .catch((e) => console.error("Billing setup failed:", e.message));

  return { on: true, paidByStripe, invoicePdf, invoiceWithLines, draftLines, payWeek, initBillingSchema,
           issueInvoice, sendInvoice, publicInvoice, dollars, nice, getAccount, getAgent };
};
