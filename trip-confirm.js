/**
 * Sky Transfers — one confirmation for several account trips (25 Oct 2026)
 * -------------------------------------------------------------------------
 * A website booking confirms itself; an account job (dispatch.html, Account
 * job tab) never emailed anyone. When one guest has several trips - Laura's
 * three, Graeme's three - the office wants ONE email listing them all, not a
 * hand-written Outlook message.
 *
 *   GET  /ops/confirm/trips?ref=   the job, and the same guest's other
 *                                  upcoming account trips (same phone, email
 *                                  or name), each with when it was last sent
 *   POST /ops/confirm/pdf          {refs, payment} -> the PDF, to look at first
 *   POST /ops/confirm/send         {refs, to, payment} -> emails it
 *
 * Only ever sent by the office pressing Send. Laid out like the website's
 * confirmation (same navy/gold sections, same footer), one section per trip.
 * It never shows a price, the account's name or the notes for the driver:
 * the trips may be an agency's work, and the money is the invoice's job.
 * Base-14 Helvetica in the PDF covers WinAnsi only - "to", never arrows.
 */
module.exports = function installTripConfirm(ctx) {
  const { app, pool, requireAdmin, mailer, BOOKINGS_EMAIL, PDFDocument, COMPANY, HAS_LOGO, LOGO_PATH,
          REVIEW_URL, niceDate, guestAttachments } = ctx;
  if (!app || !pool || typeof requireAdmin !== "function" || !PDFDocument) {
    console.log("Trip confirmations off (needs the portal database and admin login)");
    return { on: false };
  }
  const MAX_TRIPS = 12;
  const PAYMENT = {
    invoice: "Your tax invoice is sent separately.",
    paid: "Paid in full. Nothing to pay the chauffeur.",
    agent: "Arranged through your travel company. Nothing to pay the chauffeur.",
    none: null,
  };

  const txt = (v, n) => String(v == null ? "" : v).trim().slice(0, n || 200);
  const bneToday = () => new Date(Date.now() + 10 * 3600e3).toISOString().slice(0, 10);
  const digits = (v) => String(v || "").replace(/\D/g, "").slice(-9);
  const lower = (v) => String(v || "").trim().toLowerCase();
  const okEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  const esc = (t) => String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  pool.query(`ALTER TABLE ops_jobs ADD COLUMN IF NOT EXISTS confirm_sent_at TIMESTAMPTZ;
              ALTER TABLE ops_jobs ADD COLUMN IF NOT EXISTS confirm_sent_to TEXT;`)
    .catch((e) => console.error("trip-confirm schema:", e.message));

  const COLS = `ref, account, pickup, dropoff, vehicle, to_char(pickup_date, 'YYYY-MM-DD') AS d, pickup_time AS t,
    to_char(return_date, 'YYYY-MM-DD') AS rd, return_time AS rt, return_flight AS rf, hire_hours,
    passenger_name, passenger_phone, passenger_email, flight, address, pax, child_seats, trailer, stops, status,
    confirm_sent_at, confirm_sent_to`;

  /* "15:20" -> "3:20 pm" */
  function niceTime(t) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ""));
    if (!m) return String(t || "");
    const h = +m[1];
    return `${h % 12 || 12}:${m[2]} ${h < 12 ? "am" : "pm"}`;
  }
  function stopList(v) {
    try {
      const j = v ? JSON.parse(v) : null;
      const list = Array.isArray(j) ? j : j && Array.isArray(j.list) ? j.list : [];
      return list.map((x) => (typeof x === "string" ? x : x && (x.address || x.suburb) || "")).filter(Boolean).slice(0, 3);
    } catch (e) { return []; }
  }
  /* The PDF's built-in fonts are WinAnsi: an arrow typed into a job (the
     calendar sync writes them) would print as junk, so it becomes "to". */
  const ansi = (v) => String(v == null ? "" : v).replace(/\s*[←-⇿➔➡]\s*/g, " to ").replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•…\n]/g, "");
  const isAirport = (p) => /airport|\b(bne|ool)\b/i.test(String(p || ""));
  const isCruise = (p) => /cruise terminal/i.test(String(p || ""));

  /* The rows one trip prints - the same in the PDF and the email. */
  function tripRows(j) {
    const ret = j.rd && j.rt ? { date: j.rd, time: j.rt, flight: j.rf } : null;
    const hrs = j.hire_hours ? +j.hire_hours : 0;
    const seats = +j.child_seats || 0;
    const extras = [seats ? `${seats} child seat${seats > 1 ? "s" : ""}` : "", j.trailer ? "Luggage trailer" : ""].filter(Boolean).join(", ");
    return [
      ["Date", niceDate(j.d)],
      [hrs ? "Start time" : "Pick-up time", niceTime(j.t)],
      ret ? ["Return", `${niceDate(ret.date)} at ${niceTime(ret.time)}`] : null,
      hrs ? ["Duration", `${hrs} hours, as directed`] : null,
      ["Vehicle", j.vehicle || ""],
      ["Passengers", String(j.pax || "")],
      j.flight ? [ret ? "Outbound flight" : "Flight", j.flight] : null,
      ret && ret.flight ? ["Return flight", ret.flight] : null,
      ["Pick-up", j.pickup],
      ...stopList(j.stops).map((s, i) => [`Stop ${i + 1}`, s]),
      [hrs ? "Finishes" : "Drop-off", j.dropoff || "As directed"],
      ret ? ["Return journey", `${j.dropoff} back to ${j.pickup}`] : null,
      j.address ? ["Address / hotel", j.address] : null,
      extras ? ["Extras" + (ret ? " (each leg)" : ""), extras] : null,
    ].filter((r) => r && r[1] != null && String(r[1]) !== "");
  }

  function content(jobs, to, payment) {
    const lead = jobs[0];
    const n = jobs.length;
    const dates = jobs.map((j) => j.d).sort();
    /* meet & greet is about being collected, so only a pick-up there counts */
    const air = jobs.some((j) => isAirport(j.pickup) || (j.rd && isAirport(j.dropoff)));
    const cruise = jobs.some((j) => isCruise(j.pickup) || (j.rd && isCruise(j.dropoff)));
    const good = [
      air ? "Meet & greet: at the airport your chauffeur waits in arrivals with a name board." : null,
      air ? "We track your flight, so a delay never leaves you without a car." : null,
      cruise ? "At the cruise terminal your chauffeur meets you at the passenger pick-up area." : null,
      "A private vehicle and chauffeur for each trip - never shared, never a shuttle.",
      "Anything changes? Call or message us and we'll update your booking.",
    ].filter(Boolean);
    return {
      name: lead.passenger_name || "",
      heading: n === 1 ? lead.ref : `${n} trips`,
      pill: "CONFIRMED",
      intro: n === 1 ? "Thank you for booking with Sky Transfers. Your trip is confirmed."
                     : `Thank you for booking with Sky Transfers. Your ${n} trips are confirmed - each one is set out below.`,
      passenger: [["Lead passenger", lead.passenger_name], ["Contact number", lead.passenger_phone], ["Email", to]]
        .filter((r) => r[1]),
      trips: jobs.map((j, i) => ({ title: n === 1 ? "Trip details" : `Trip ${i + 1} of ${n}  ·  ${j.ref}`, rows: tripRows(j) })),
      status: PAYMENT[payment] || null,
      good,
      first: dates[0], last: dates[dates.length - 1],
    };
  }

  function pdf(c) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true });
      const chunks = [];
      doc.on("data", (x) => chunks.push(x));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      try {
        const W = 595.28, H = 841.89, L = 40, R = W - 40, CW = R - L, LABEL_W = 150, FY = H - 66;
        const NAVY = "#101828", INK = "#141D30", TEXT = "#333B4C", MUTED = "#68707F", GOLD = "#C9A227",
              GOLD_LT = "#D9B44A", LINE = "#E9DFC6", SOFT = "#F6EED9", CREAM = "#F6F2E8", OK = "#1E7F4F";
        const header = (first) => {
          doc.rect(0, 0, W, first ? 92 : 56).fill(NAVY);
          if (HAS_LOGO) { try { doc.image(LOGO_PATH, L, first ? 14 : 8, { fit: first ? [92, 64] : [60, 40] }); } catch (e) {} }
          doc.font("Helvetica-Bold").fontSize(9).fillColor(GOLD_LT)
            .text("BOOKING CONFIRMATION", L, first ? 30 : 14, { width: CW, align: "right", characterSpacing: 2.2, lineBreak: false });
          doc.font("Helvetica-Bold").fontSize(first ? 18 : 12).fillColor("#FFFFFF").text(c.heading, L, first ? 44 : 28, { width: CW, align: "right", lineBreak: false });
          doc.rect(0, first ? 92 : 56, W, 3).fill(GOLD);
        };
        header(true);
        let y = 112;
        doc.font("Helvetica-Bold").fontSize(19).fillColor(INK).text(ansi(c.name), L, y, { width: CW - 190 });
        doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(c.intro, L, doc.y + 2, { width: CW - 190 });
        const introEnd = doc.y;
        doc.font("Helvetica-Bold").fontSize(8.5);
        const pw = doc.widthOfString(c.pill, { characterSpacing: 1 }) + 26;
        doc.roundedRect(R - pw, y + 4, pw, 22, 11).fill(OK);
        doc.fillColor("#FFFFFF").text(c.pill, R - pw, y + 11, { width: pw, align: "center", characterSpacing: 1, lineBreak: false });
        y = Math.max(introEnd, y + 30) + 14;

        const fit = (h) => { if (y + h > FY - 12) { doc.addPage({ size: "A4", margin: 0 }); header(false); y = 76; } };
        const vw = CW - LABEL_W - 24;
        /* three or more trips: tighter rows, so the usual three-trip stay fits one page */
        const ROW = c.trips.length >= 3 ? 16.5 : 19;
        const rowHeight = (r) => { doc.font(r.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5); return Math.max(ROW, doc.heightOfString(ansi(r.value), { width: vw }) + ROW - 10); };
        const section = (title, rows) => {
          rows = rows.map((r) => (Array.isArray(r) ? { label: r[0], value: r[1] } : r)).filter((r) => r.value != null && String(r.value) !== "");
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
            doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK).text(r.label, L + 12, y + 6, { width: LABEL_W - 12 });
            doc.font(r.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).fillColor(r.color || TEXT).text(ansi(r.value), L + LABEL_W, y + 5, { width: vw });
            y += h;
            if (i < rows.length - 1) doc.moveTo(L, y).lineTo(R, y).lineWidth(0.7).strokeColor(LINE).stroke();
          });
          doc.roundedRect(L, y - 2, CW, 2, 1).fill(GOLD);
          y += 9;
        };

        section("Passenger details", c.passenger);
        c.trips.forEach((t) => section(t.title, t.rows));
        if (c.status) section("Payment", [{ label: "Status", value: c.status, bold: true, color: OK }]);

        doc.font("Helvetica").fontSize(8.8);
        fit(16 + c.good.reduce((a, t) => a + doc.heightOfString(t, { width: CW - 11 }) + 3, 0));
        doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("GOOD TO KNOW", L, y, { characterSpacing: 1.5 });
        y += 13;
        c.good.forEach((t) => {
          doc.circle(L + 3, y + 4.5, 1.7).fill(GOLD);
          doc.font("Helvetica").fontSize(8.8).fillColor(TEXT).text(t, L + 11, y, { width: CW - 11 });
          y = doc.y + 3;
        });

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

  function emailHtml(c) {
    const cellL = "padding:9px 14px;font:700 12px/1.45 Arial,sans-serif;color:#141D30;vertical-align:top;width:34%;border-bottom:1px solid #EFE6D0;";
    const cellR = "padding:9px 14px;font:400 14px/1.45 Arial,sans-serif;color:#333B4C;vertical-align:top;border-bottom:1px solid #EFE6D0;";
    const section = (title, rows) => !rows.length ? "" : `
    <tr><td style="padding:14px 28px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-bottom:2px solid #C9A227;">
        <tr><td colspan="2" style="background:#101828;border-radius:5px 5px 0 0;padding:8px 14px;font:700 13px Arial,sans-serif;color:#FFFFFF;">
          <span style="display:inline-block;width:7px;height:7px;background:#C9A227;margin-right:8px;vertical-align:middle;"></span>${esc(title).replace(/  ·  /g, " &middot; ")}</td></tr>
        ${rows.map((r) => `<tr><td style="${cellL}">${esc(r[0])}</td><td style="${cellR}${r[2] || ""}">${esc(r[1]).replace(/\n/g, "<br>")}</td></tr>`).join("")}
      </table>
    </td></tr>`;
    const first = String(c.name || "").split(" ")[0];
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F7F4ED;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4ED;padding:0;">
<tr><td align="center" style="padding:24px 10px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:10px;overflow:hidden;border:1px solid #E5E0D2;">
    <tr><td style="background:#101828;padding:18px 28px;border-bottom:3px solid #C9A227;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;"><img src="cid:stlogo" alt="SKY TRANSFERS" height="58" style="height:58px;display:block;font:400 20px Georgia,serif;letter-spacing:4px;color:#F6F2E8;"></td>
        <td align="right" style="vertical-align:middle;">
          <div style="font:700 10px Arial,sans-serif;letter-spacing:2.5px;color:#D9B44A;">BOOKING CONFIRMATION</div>
          <div style="font:700 20px Arial,sans-serif;color:#FFFFFF;padding-top:3px;">${esc(c.heading)}</div>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:22px 28px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:top;font:700 22px Arial,sans-serif;color:#141D30;">${esc(c.name)}</td>
        <td align="right" style="vertical-align:top;"><span style="display:inline-block;padding:6px 14px;border-radius:12px;font:700 10px Arial,sans-serif;letter-spacing:1px;background:#1E7F4F;color:#FFFFFF;">${c.pill}</span></td>
      </tr></table>
      <div style="font:400 14.5px/1.6 Arial,sans-serif;color:#333B4C;padding-top:10px;">Hi ${esc(first)}, ${c.trips.length === 1 ? "your trip is confirmed." : `your ${c.trips.length} trips are confirmed.`} The details are below, and a printable copy is attached.</div>
    </td></tr>
    ${section("Passenger details", c.passenger)}
    ${c.trips.map((t) => section(t.title, t.rows)).join("")}
    ${c.status ? section("Payment", [["Status", c.status, "font-weight:700;color:#1E7F4F;"]]) : ""}
    <tr><td style="padding:16px 28px 4px;">
      <div style="font:700 10px Arial,sans-serif;letter-spacing:1.5px;color:#68707F;padding-bottom:6px;">GOOD TO KNOW</div>
      <div style="font:400 13.5px/1.8 Arial,sans-serif;color:#333B4C;">
        ${c.good.map((t) => `<span style="color:#C9A227;">&#9679;</span>&nbsp; ${esc(t)}`).join("<br>\n        ")}
      </div>
    </td></tr>
    <tr><td style="padding:16px 28px 6px;font:400 13.5px/1.7 Arial,sans-serif;color:#333B4C;">
      Questions or changes? Reply to this email or call/text us any time on
      <a href="tel:+61481437772" style="color:#8E701C;font-weight:700;text-decoration:none;">+61&nbsp;481&nbsp;437&nbsp;772</a> — we're on 24/7.
    </td></tr>
    ${REVIEW_URL ? `<tr><td align="center" style="padding:14px 28px 26px;">
      <a href="${REVIEW_URL}" style="display:inline-block;background:#C9A227;color:#141D30;font:700 14px Arial,sans-serif;padding:12px 26px;border-radius:8px;text-decoration:none;">&#9733; Enjoyed the ride? Leave us a Google review</a>
    </td></tr>` : ""}
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

  /* The trips asked for, in date order. Throws {code, message}. */
  async function load(refs) {
    const want = [...new Set((Array.isArray(refs) ? refs : []).map((r) => txt(r, 40)).filter(Boolean))];
    if (!want.length) throw { code: 400, message: "Tick at least one trip." };
    if (want.length > MAX_TRIPS) throw { code: 400, message: `At most ${MAX_TRIPS} trips in one confirmation.` };
    const { rows } = await pool.query(`SELECT ${COLS} FROM ops_jobs WHERE ref IN (${want.map((_, i) => "$" + (i + 1)).join(",")})`, want);
    const missing = want.filter((r) => !rows.some((x) => x.ref === r));
    if (missing.length) throw { code: 404, message: "Not an account job: " + missing.join(", ") + "." };
    const off = rows.filter((x) => x.status === "cancelled").map((x) => x.ref);
    if (off.length) throw { code: 409, message: "Cancelled, so left out of a confirmation: " + off.join(", ") + "." };
    return rows.sort((a, b) => (a.d + a.t).localeCompare(b.d + b.t));
  }
  const payOf = (v) => (Object.prototype.hasOwnProperty.call(PAYMENT, v) ? v : "invoice");

  app.get("/ops/confirm/trips", requireAdmin, async (req, res) => {
    try {
      const ref = txt(req.query.ref, 40);
      const me = (await pool.query(`SELECT ${COLS} FROM ops_jobs WHERE ref = $1`, [ref])).rows[0];
      if (!me) return res.status(404).json({ error: "No such account job." });
      const p = digits(me.passenger_phone), e = lower(me.passenger_email), n = lower(me.passenger_name);
      const from = me.d < bneToday() ? me.d : bneToday();
      const { rows } = await pool.query(`SELECT ${COLS} FROM ops_jobs WHERE status <> 'cancelled' AND pickup_date >= $1 ORDER BY pickup_date, pickup_time LIMIT 1000`, [from]);
      const same = (x) => x.ref === me.ref || (p.length >= 8 && digits(x.passenger_phone) === p) || (e && lower(x.passenger_email) === e) || (n.length >= 3 && lower(x.passenger_name) === n);
      const trips = rows.filter(same);
      if (!trips.some((x) => x.ref === me.ref)) trips.unshift(me);
      res.json({
        guest: { name: me.passenger_name, phone: me.passenger_phone, email: me.passenger_email || "" },
        trips: trips.map((x) => ({ ref: x.ref, date: x.d, time: x.t, pickup: x.pickup, dropoff: x.dropoff, vehicle: x.vehicle,
          pax: x.pax, returnDate: x.rd, returnTime: x.rt, hours: x.hire_hours, account: x.account || "Direct",
          name: x.passenger_name, email: x.passenger_email || "", status: x.status,
          sentAt: x.confirm_sent_at, sentTo: x.confirm_sent_to, self: x.ref === me.ref })),
      });
    } catch (err) {
      console.error("confirm trips:", err);
      res.status(500).json({ error: "Could not load that guest's trips." });
    }
  });

  app.post("/ops/confirm/pdf", requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const jobs = await load(b.refs);
      const out = await pdf(content(jobs, txt(b.to, 200), payOf(b.payment)));
      res.set("Content-Type", "application/pdf").set("Content-Disposition", "inline; filename=\"SkyTransfers-Confirmation.pdf\"").send(out);
    } catch (err) {
      if (err && err.code) return res.status(err.code).json({ error: err.message });
      console.error("confirm pdf:", err);
      res.status(500).json({ error: "Could not make that PDF." });
    }
  });

  app.post("/ops/confirm/send", requireAdmin, async (req, res) => {
    try {
      if (!mailer) return res.status(500).json({ error: "Email is not configured on the server." });
      const b = req.body || {};
      const to = txt(b.to, 200);
      if (!okEmail(to)) return res.status(400).json({ error: "Type the email address to send it to." });
      const jobs = await load(b.refs);
      const c = content(jobs, to, payOf(b.payment));
      const file = await pdf(c);
      const span = c.first === c.last ? niceDate(c.first) : `${niceDate(c.first)} to ${niceDate(c.last)}`;
      const atts = typeof guestAttachments === "function" ? guestAttachments(null) : [];
      atts.unshift({ filename: "SkyTransfers-Confirmation.pdf", content: file, contentType: "application/pdf" });
      await mailer.sendMail({
        from: `"Sky Transfers" <${process.env.GMAIL_USER}>`, to, replyTo: BOOKINGS_EMAIL, bcc: BOOKINGS_EMAIL,
        subject: jobs.length === 1 ? `Booking confirmed - ${jobs[0].ref} - Sky Transfers`
                                   : `Booking confirmed - your ${jobs.length} trips with Sky Transfers`,
        text: `Hi ${String(c.name || "").split(" ")[0]},\n\n${c.intro}\n\n` +
          c.trips.map((t) => t.title + "\n" + t.rows.map((r) => `  ${r[0]}: ${r[1]}`).join("\n")).join("\n\n") +
          (c.status ? `\n\nPayment: ${c.status}` : "") +
          `\n\nDates: ${span}\nQuestions or changes? Reply to this email or call +61 481 437 772 (24/7).\n\nSky Transfers\n${COMPANY.name}\n${COMPANY.ids}`,
        html: emailHtml(c),
        attachments: atts,
      });
      const refs = jobs.map((j) => j.ref);
      const list = refs.map((_, i) => "$" + (i + 2)).join(",");
      await pool.query(`UPDATE ops_jobs SET confirm_sent_at = now(), confirm_sent_to = $1 WHERE ref IN (${list})`, [to].concat(refs));
      /* The guest's email goes on any trip that had none, so the driver
         updates (assigned / on the way / arrived) can reach them too. */
      const filled = (await pool.query(
        `UPDATE ops_jobs SET passenger_email = $1 WHERE (passenger_email IS NULL OR passenger_email = '') AND ref IN (${list})`,
        [to].concat(refs))).rowCount || 0;
      try {
        await pool.query(`INSERT INTO ops_events (kind, ref, leg, message) VALUES ('guest', $1, 'out', $2)`,
          [refs[0], `Confirmation for ${refs.length} trip${refs.length === 1 ? "" : "s"} (${refs.join(", ")}) emailed to ${to}`]);
      } catch (e) { /* the events table belongs to autopilot.js; a log line is enough without it */ }
      console.log("trip confirmation sent:", refs.join(","), "->", to);
      res.json({ ok: true, to, refs, emailFilled: filled });
    } catch (err) {
      if (err && err.code) return res.status(err.code).json({ error: err.message });
      console.error("confirm send:", err);
      res.status(500).json({ error: "Could not send that confirmation." });
    }
  });

  console.log("Trip confirmations ready");
  return { on: true, content, pdf, emailHtml };
};
