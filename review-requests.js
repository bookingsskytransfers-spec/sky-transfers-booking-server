/**
 * Sky Transfers - Google review requests (31 Oct 2026)
 * ----------------------------------------------------
 * One short email after the trip, asking the passenger for a Google review.
 * Competitors in the map pack have 100-2,700 reviews to our 31; a review
 * from every finished trip is the one thing that moves that.
 *
 *   When     reviewDelayH hours (2 by default) after the driver presses
 *            Done, between 08:00 and 20:00 Brisbane - a trip finished at
 *            11 pm is asked the next morning. Never more than 3 days late.
 *   Who      direct passengers only: website bookings and office jobs with
 *            no account. Agent and account passengers are someone else's
 *            customers. A return trip is asked after the return, not the
 *            outbound. Each email address is asked once, ever.
 *   What     the same link for everyone (asking only happy passengers is
 *            "review gating", which Google forbids), no discount or reward
 *            for a review (also forbidden), and a line inviting a reply if
 *            anything wasn't right.
 *
 * Off until switched on (Autopilot tab -> Google review request). Only trips
 * finished after it is switched on are asked, so the first run doesn't email
 * last week's passengers. Every request sent is logged in ops_events.
 */
module.exports = function installReviewRequests(ctx) {
  const { app, pool, ops, autopilot, mailer, BOOKINGS_EMAIL, REVIEW_URL } = ctx;
  if (!app || !pool || !ops || !ops.on || !autopilot || !autopilot.on || !REVIEW_URL) {
    console.log("Review requests off (needs ops.js, autopilot.js and a review link)");
    return { on: false };
  }
  const nowMs = typeof ctx.now === "function" ? ctx.now : () => Date.now();
  const PHONE = "+61 481 437 772";
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const niceDay = (d) => { const x = new Date(d + "T00:00:00Z"); return DAYS[x.getUTCDay()] + " " + x.getUTCDate() + " " + MONTHS[x.getUTCMonth()]; };
  const bne = () => { const t = nowMs() + 10 * 3600e3, iso = new Date(t).toISOString(); return { date: iso.slice(0, 10), min: +iso.slice(11, 13) * 60 + +iso.slice(14, 16) }; };
  const first = (n) => String(n || "").trim().split(/\s+/)[0] || "";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const emailOf = (l) => { const e = String(l.email || "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : ""; };
  /* Website bookings, and office jobs with no account ("Direct"). */
  const direct = (l) => l.source === "web" || (l.source === "account" && (!l.account || l.account === "Direct"));
  const SEND_FROM = 8 * 60, SEND_TO = 20 * 60;

  pool.query(`CREATE TABLE IF NOT EXISTS ops_review_asks (
      email   TEXT PRIMARY KEY,
      ref     TEXT,
      leg     TEXT,
      sent_at TIMESTAMPTZ DEFAULT now())`).catch((e) => console.error("review asks table:", e.message));

  async function logEvent(message, l) {
    await pool.query(`INSERT INTO ops_events (kind, ref, leg, message) VALUES ('review', $1, $2, $3)`,
      [l ? l.ref : null, l ? l.leg : null, String(message).slice(0, 1000)]).catch((e) => console.error("review event:", e.message));
    console.log("review request:", l ? l.ref + " " + l.leg : "", String(message).slice(0, 140));
  }

  function compose(l) {
    const g = first(l.guest) || "there";
    const subject = `How was your trip with Sky Transfers? [${l.ref}]`;
    const lines = [`Hi ${g},`, "",
      `Thank you for travelling with us on ${niceDay(l.date)}, ${l.from} to ${l.to}.`, "",
      "We're a small local business, and reviews from passengers are how other travellers find us. If you have a minute, would you leave us a Google review?", "",
      `Leave a Google review: ${REVIEW_URL}`, "",
      "If anything wasn't right, please reply to this email and tell us - we read every one.", "",
      "Thank you,", "Aman", "Sky Transfers", PHONE, "www.skytransfers.com.au", "",
      "We only ask once - you won't get this email again."];
    const text = lines.join("\n");
    const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#333B4C;max-width:560px;line-height:1.5">` +
      lines.map((ln) => {
        if (ln.startsWith("Leave a Google review: ")) return `<p style="margin:18px 0"><a href="${esc(REVIEW_URL)}" style="display:inline-block;background:#C9A227;color:#141D30;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:9px">&#9733; Leave a Google review</a></p>`;
        if (!ln) return "";
        if (ln.startsWith("We only ask once")) return `<p style="margin:16px 0 0;font-size:12px;color:#7A8294">${esc(ln)}</p>`;
        return `<p style="margin:0 0 ${/^(Thank you,|Aman|Sky Transfers|\+61)/.test(ln) ? 2 : 10}px">${esc(ln)}</p>`;
      }).join("") + `</div>`;
    return { subject, text, html };
  }

  /* ---- the pass: finished trips due a request -------------------------------- */
  async function reviewPass(s) {
    const n = bne();
    if (n.min < SEND_FROM || n.min >= SEND_TO) return { sent: 0, quiet: true };
    const since = s.reviewSince ? new Date(s.reviewSince).getTime() : nowMs();
    const delay = (s.reviewDelayH || 2) * 3600e3;
    const board = await ops.boardFor(ops.addDays(n.date, -3), n.date);
    const due = board.legs.filter((l) => {
      const done = l.status === "done" && l.times && l.times.done ? new Date(l.times.done).getTime() : NaN;
      return done >= since && nowMs() - done >= delay && nowMs() - done <= 3 * 864e5 &&
        direct(l) && !!emailOf(l) && !(l.isReturn && l.leg === "out");
    });
    let sent = 0;
    for (const l of due) {
      const email = emailOf(l);
      /* Claim the address before sending, so two passes (or two legs) send one. */
      try { await pool.query(`INSERT INTO ops_review_asks (email, ref, leg) VALUES ($1, $2, $3)`, [email, l.ref, l.leg]); }
      catch (e) { continue; }
      const m = compose(l);
      try {
        await mailer.sendMail({ from: `"Sky Transfers" <${process.env.GMAIL_USER}>`, to: l.email, replyTo: BOOKINGS_EMAIL, subject: m.subject, text: m.text, html: m.html });
        await logEvent(`Google review request emailed to ${l.guest || "the passenger"} (${l.from} to ${l.to}).`, l);
        sent++;
      } catch (e) {
        /* Not sent: free the address so the next pass can try again. */
        await pool.query(`DELETE FROM ops_review_asks WHERE email = $1 AND ref = $2`, [email, l.ref]).catch(() => {});
        console.error("review email:", e.message);
      }
    }
    return { sent };
  }
  let running = false;
  async function tick() {
    if (running) return; running = true;
    try { const s = await autopilot.getSettings(); if (s.reviewOn && mailer) await reviewPass(s); }
    catch (e) { console.error("review pass:", e.message); }
    finally { running = false; }
  }

  /* ---- office: a sample -------------------------------------------------------- */
  const { requireAdmin } = ctx;
  if (typeof requireAdmin === "function") {
    app.post("/review/sample", requireAdmin, async (req, res) => {
      try {
        if (!mailer) return res.status(500).json({ error: "Email is not configured on the server." });
        const s = await autopilot.getSettings();
        const to = s.alertTo || BOOKINGS_EMAIL;
        const m = compose({ ref: "ST-SAMPLE", leg: "out", date: bne().date, from: "Gold Coast Airport (OOL)", to: "Broadbeach", guest: "Sample Guest" });
        await mailer.sendMail({ from: `"Sky Transfers" <${process.env.GMAIL_USER}>`, to, subject: "[SAMPLE] " + m.subject, text: m.text, html: m.html });
        res.json({ ok: true, to });
      } catch (err) { console.error("review sample:", err); res.status(500).json({ error: "Could not send the sample." }); }
    });
  }

  if (!ctx.noTimer) {
    setTimeout(() => tick(), 150e3).unref();
    setInterval(() => tick(), 10 * 60e3).unref();
  }
  console.log("Review requests ready (off until switched on)");
  return { on: true, tick, reviewPass, compose };
};
