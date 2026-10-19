/**
 * Sky Transfers — guest updates (Phase 3, 19 Oct 2026)
 * ----------------------------------------------------
 * Three messages to the guest, by email now and by WhatsApp once Aman has
 * connected the Business Platform (whatsapp.js):
 *
 *   Driver assigned  the evening before (guestNoticeAt, 19:00 by default),
 *                    once the office has SENT the job to the driver - never
 *                    on Autopilot's pick alone. A later change of driver
 *                    sends a "change of driver" note. A job dispatched late
 *                    for today is told on the next check.
 *   On the way       when the driver (or the office) moves the leg to on_way
 *   Arrived          on on_location: where to meet (arrivals hall with a name
 *                    board at an airport, outside the address otherwise)
 *
 * Each message carries a "track your driver" link: track.html#t=<token>,
 * an HMAC from AGENT_SECRET ("sky-guest-track-v1") naming one leg, valid to
 * three days after the pick-up. The page shows the trip, the step it is at,
 * the driver's first name and the car - never the fare, the driver's phone,
 * or a registration (the number-plate rule).
 *
 * Off until switched on (Autopilot tab -> Guest updates). Website guests
 * only by default: agent and account guests are someone else's customers,
 * and are told only if guestAgentAccount is on. Every message sent is
 * logged in ops_events, and sent once: the dispatch row remembers it.
 */
module.exports = function installGuestUpdates(ctx) {
  const { app, pool, ops, autopilot, mailer, BOOKINGS_EMAIL, HUBS } = ctx;
  if (!app || !pool || !ops || !ops.on || !autopilot || !autopilot.on) {
    console.log("Guest updates off (needs ops.js and autopilot.js)");
    return { on: false };
  }
  const crypto = require("crypto");
  const wa = ctx.wa || require("./whatsapp")();
  const nowMs = typeof ctx.now === "function" ? ctx.now : () => Date.now();
  const SECRET = process.env.AGENT_SECRET || "";
  const KEY = crypto.createHmac("sha256", SECRET).update("sky-guest-track-v1").digest();
  const SITE = String(process.env.PUBLIC_SITE_URL || "https://www.skytransfers.com.au").replace(/\/+$/, "");
  const PHONE = "+61 481 437 772";
  const hubs = new Set(HUBS || []);
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const niceDay = (d) => { const x = new Date(d + "T00:00:00Z"); return DAYS[x.getUTCDay()] + " " + x.getUTCDate() + " " + MONTHS[x.getUTCMonth()]; };
  const minutesOf = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); return m ? +m[1] * 60 + +m[2] : null; };
  const bne = () => { const t = nowMs() + 10 * 3600e3, iso = new Date(t).toISOString(); return { date: iso.slice(0, 10), min: +iso.slice(11, 13) * 60 + +iso.slice(14, 16), abs: Math.floor(t / 60000) }; };
  const legAbs = (l) => Date.parse(l.date + "T00:00:00Z") / 60000 + (minutesOf(l.time) || 0);
  const first = (n) => String(n || "").trim().split(/\s+/)[0] || "";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---- tracking links -------------------------------------------------- */
  function token(l) {
    const x = Date.parse(l.date + "T00:00:00Z") + 4 * 864e5 - 10 * 3600e3;     // end of pick-up day + 3 days, Brisbane
    const body = Buffer.from(JSON.stringify({ k: "trk", r: l.ref, l: l.leg, x })).toString("base64url");
    return body + "." + crypto.createHmac("sha256", KEY).update(body).digest("base64url");
  }
  function fromToken(t) {
    const [body, sig] = String(t || "").split(".");
    if (!body || !sig || !SECRET) return null;
    const want = crypto.createHmac("sha256", KEY).update(body).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let c; try { c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (e) { return null; }
    if (!c || c.k !== "trk" || !c.r || (c.l !== "out" && c.l !== "ret") || !(c.x > nowMs())) return null;
    return { ref: String(c.r), leg: c.l };
  }
  const trackUrl = (l) => SITE + "/track.html#t=" + token(l);

  /* ---- one leg, with who is driving it ------------------------------------ */
  async function fullLeg(ref, leg) {
    const l = await ops.legExists(ref, leg);
    if (!l) return null;
    const d = (await pool.query(
      `SELECT d.*, r.name AS driver_name, v.label AS vehicle_label FROM ops_dispatch d
         LEFT JOIN ops_drivers r ON r.id = d.driver_id LEFT JOIN ops_vehicles v ON v.id = d.vehicle_id
        WHERE d.ref = $1 AND d.leg = $2`, [ref, leg])).rows[0] || null;
    return Object.assign(l, {
      status: d ? d.status : "unassigned", driverId: d && d.driver_id || null, driverName: d && d.driver_name || null,
      vehicleLabel: d && d.vehicle_label || null, sentAt: d && d.sent_at || null,
      guestAssignedFor: d && d.guest_assigned_for || null, guestOnwayAt: d && d.guest_onway_at || null, guestArrivedAt: d && d.guest_arrived_at || null,
    });
  }
  const car = (l) => l.vehicleLabel || l.vehicleClass || "our car";
  const atHub = (l) => hubs.has(l.from);
  const pickupPlace = (l) => (atHub(l) ? l.from : (l.leg === "out" && l.address) || l.from);
  const meetText = (l) => (atHub(l)
    ? `Your driver will meet you in the arrivals hall at ${l.from} with a name board. Take your time with your bags.`
    : `Your driver will be outside ${pickupPlace(l)} at ${l.time}.`);
  const eligible = (l, s) => (l.source === "web" || s.guestAgentAccount) && (!!l.email || (s.guestWhatsApp && wa.enabled && !!l.phone));

  async function logEvent(message, l) {
    await pool.query(`INSERT INTO ops_events (kind, ref, leg, message) VALUES ('guest', $1, $2, $3)`,
      [l ? l.ref : null, l ? l.leg : null, String(message).slice(0, 1000)]).catch((e) => console.error("guest event:", e.message));
    console.log("guest update:", l ? l.ref + " " + l.leg : "", String(message).slice(0, 140));
  }

  /* ---- the three messages -------------------------------------------------------- */
  function compose(kind, l, extra) {
    const g = first(l.guest) || "there", dr = first(l.driverName) || "Your driver", when = `${niceDay(l.date)} at ${l.time}`, url = trackUrl(l);
    const route = `${l.from} -> ${l.to}`;
    let subject, lines, wap;
    if (kind === "assigned") {
      subject = (extra && extra.changed ? `Change of driver for ${when}` : `Your driver for ${when}`) + `: ${dr} - Sky Transfers [${l.ref}]`;
      lines = [`Hi ${g},`, "",
        extra && extra.changed ? `Your driver has changed - ${dr} will now look after you.` : "Your transfer is all set.", "",
        `  ${when}`, `  ${route}`, `  Driver: ${dr}`, `  Car: ${car(l)}`, l.flight ? `  Flight: ${l.flight}` : null, "",
        meetText(l), "", `Track your driver: ${url}`];
      wap = ["sky_driver_assigned", [g, when, dr, car(l), url]];
    } else if (kind === "on_way") {
      subject = `Your driver is on the way - Sky Transfers [${l.ref}]`;
      lines = [`Hi ${g},`, "", `${dr} is on the way to ${pickupPlace(l)} for your ${l.time} pick-up, in ${/^(a|an|the|our) /i.test(car(l)) ? car(l) : "a " + car(l)}.`, "",
        meetText(l), "", `Track your driver: ${url}`];
      wap = ["sky_driver_on_way", [g, dr, pickupPlace(l), l.time, url]];
    } else {
      subject = `Your driver has arrived - Sky Transfers [${l.ref}]`;
      const meet = atHub(l)
        ? `${dr} is at ${l.from} and will meet you in the arrivals hall with a name board. Take your time with your bags.`
        : `${dr} is outside ${pickupPlace(l)} in ${/^(a|an|the|our) /i.test(car(l)) ? car(l) : "a " + car(l)}.`;
      lines = [`Hi ${g},`, "", meet, "", `Track your driver: ${url}`];
      wap = ["sky_driver_arrived", [g, dr, atHub(l)
        ? "They'll meet you in the arrivals hall with a name board."
        : `They're outside ${pickupPlace(l)}.`]];
    }
    lines.push("", `Need to change anything? Reply to this email or call ${PHONE}.`, "", "Sky Transfers", "www.skytransfers.com.au");
    const text = lines.filter((x) => x !== null).join("\n");
    const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#333B4C;max-width:560px;line-height:1.5">` +
      text.split("\n").map((ln) => {
        if (ln.startsWith("Track your driver: ")) return `<p style="margin:18px 0"><a href="${esc(url)}" style="display:inline-block;background:#C9A227;color:#141D30;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:9px">Track your driver</a></p>`;
        if (!ln) return "";
        return `<p style="margin:0 0 ${ln.startsWith("  ") ? 2 : 10}px${ln.startsWith("  ") ? ";padding-left:12px;color:#141D30" : ""}">${esc(ln.trim())}</p>`;
      }).join("") + `</div>`;
    return { subject, text, html, wap };
  }
  async function deliver(kind, l, s, extra) {
    const m = compose(kind, l, extra);
    const sent = [];
    if (l.email && mailer) {
      try {
        await mailer.sendMail({ from: `"Sky Transfers" <${process.env.GMAIL_USER}>`, to: l.email, replyTo: BOOKINGS_EMAIL, subject: m.subject, text: m.text, html: m.html });
        sent.push("email");
      } catch (e) { console.error("guest email:", e.message); }
    }
    if (s.guestWhatsApp && wa.enabled && l.phone) {
      const r = await wa.sendTemplate(l.phone, m.wap[0], m.wap[1]);
      if (r.ok) sent.push("WhatsApp"); else console.error("guest WhatsApp:", r.reason);
    }
    return sent;
  }

  /* ---- on the way / arrived: from the driver's tap ------------------------------- */
  ops.hooks.step = async ({ ref, leg, status }) => {
    if (status !== "on_way" && status !== "on_location") return;
    const s = await autopilot.getSettings();
    if (!s.guestOn) return;
    const l = await fullLeg(ref, leg);
    if (!l || !l.driverId || !eligible(l, s)) return;
    /* A mis-tap on a job days away must not message anyone. */
    if (Math.abs(legAbs(l) - bne().abs) > 6 * 60) return;
    const col = status === "on_way" ? "guest_onway_at" : "guest_arrived_at";
    if (status === "on_way" ? l.guestOnwayAt : l.guestArrivedAt) return;
    /* Claim before sending, so two quick taps send one message. */
    const r = await pool.query(`UPDATE ops_dispatch SET ${col} = now() WHERE ref = $1 AND leg = $2 AND ${col} IS NULL`, [ref, leg]);
    if (!r.rowCount) return;
    const sent = await deliver(status, l, s);
    await logEvent(`${status === "on_way" ? "On the way" : "Arrived"} message to ${l.guest || "the guest"}: ${sent.join(" + ") || "nothing sent (no email or number)"}.`, l);
  };

  /* ---- driver assigned: the evening before ------------------------------------- */
  async function noticePass(s) {
    const n = bne();
    const last = n.min >= minutesOf(s.guestNoticeAt) ? ops.addDays(n.date, 1) : n.date;
    const board = await ops.boardFor(n.date, last);
    const legs = board.legs.filter((l) => l.driverId && legAbs(l) > n.abs &&
      (l.status === "accepted" || l.status === "on_way" || (l.status === "assigned" && l.sentAt)));
    if (!legs.length) return { sent: 0 };
    const refs = [...new Set(legs.map((l) => l.ref))];
    const rows = (await pool.query(`SELECT ref, leg, guest_assigned_for FROM ops_dispatch WHERE ref IN (${refs.map((_, i) => "$" + (i + 1)).join(", ")})`, refs)).rows;
    let sent = 0;
    for (const l of legs) {
      const row = rows.find((r) => r.ref === l.ref && r.leg === l.leg);
      const told = row && row.guest_assigned_for;
      if (told === l.driverId || !eligible(l, s)) continue;
      const r = told
        ? await pool.query(`UPDATE ops_dispatch SET guest_assigned_for = $3 WHERE ref = $1 AND leg = $2 AND guest_assigned_for = $4`, [l.ref, l.leg, l.driverId, told])
        : await pool.query(`UPDATE ops_dispatch SET guest_assigned_for = $3 WHERE ref = $1 AND leg = $2 AND guest_assigned_for IS NULL`, [l.ref, l.leg, l.driverId]);
      if (!r.rowCount) continue;
      const via = await deliver("assigned", l, s, { changed: !!told });
      await logEvent(`${told ? "Change of driver" : "Driver assigned"} message to ${l.guest || "the guest"} (${first(l.driverName)}): ${via.join(" + ") || "nothing sent"}.`, l);
      sent++;
    }
    return { sent };
  }
  let running = false;
  async function tick() {
    if (running) return; running = true;
    try { const s = await autopilot.getSettings(); if (s.guestOn) await noticePass(s); }
    catch (e) { console.error("guest notice:", e.message); }
    finally { running = false; }
  }

  /* ---- the tracking page's data -------------------------------------------------- */
  const WORDS = {
    unassigned: ["booked", "Booked - your driver is confirmed the evening before."],
    declined: ["booked", "Booked - your driver is confirmed the evening before."],
    assigned: ["confirmed", "Your driver is confirmed."],
    accepted: ["confirmed", "Your driver is confirmed."],
    on_way: ["on_way", "Your driver is on the way."],
    on_location: ["arrived", "Your driver has arrived."],
    pob: ["on_board", "On the road - enjoy the ride."],
    done: ["done", "Completed. Thank you for travelling with Sky Transfers."],
  };
  app.post("/track", async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      const t = fromToken((req.body || {}).t);
      if (!t) return res.status(401).json({ error: `This tracking link has expired. Questions? Call ${PHONE}.` });
      const l = await fullLeg(t.ref, t.leg);
      if (!l) return res.status(404).json({ error: `We couldn't find that booking. Please call ${PHONE}.` });
      /* The driver is named once the office has sent them the job. */
      const told = l.driverId && (l.sentAt || ["accepted", "on_way", "on_location", "pob", "done"].includes(l.status));
      const st = told ? (WORDS[l.status] || WORDS.assigned) : WORDS.unassigned;
      res.json({
        ref: l.ref, leg: l.leg, isReturn: l.isReturn, date: l.date, day: niceDay(l.date), time: l.time,
        from: l.from, to: l.to, hours: l.hours || null, flight: l.flight || "",
        step: st[0], status: st[1], driver: told ? first(l.driverName) : null, car: told ? car(l) : l.vehicleClass || null,
        meet: meetText(l), phone: PHONE, guest: first(l.guest),
      });
    } catch (err) {
      console.error("track:", err);
      res.status(500).json({ error: `Something went wrong. Please call ${PHONE}.` });
    }
  });

  /* ---- office: WhatsApp status, and a sample of each email --------------------------------- */
  const { requireAdmin } = ctx;
  if (typeof requireAdmin === "function") {
    app.get("/guest/state", requireAdmin, (req, res) => res.json({
      whatsapp: { connected: wa.enabled, templates: Object.entries(wa.TEMPLATES).map(([name, t]) => ({ name, body: t.body, params: t.params })) },
    }));
    app.post("/guest/sample", requireAdmin, async (req, res) => {
      try {
        if (!mailer) return res.status(500).json({ error: "Email is not configured on the server." });
        const s = await autopilot.getSettings();
        const to = s.alertTo || BOOKINGS_EMAIL;
        const day = bne().date;
        const sample = { ref: "ST-SAMPLE", leg: "out", source: "web", date: day, time: "14:30", from: [...hubs][0] || "Gold Coast Airport (OOL)",
          to: "Broadbeach", address: "", flight: "JQ123", guest: "Sample Guest", email: to, phone: "", driverName: "Raj Example", vehicleLabel: "Kia Carnival - white", vehicleClass: "People Mover" };
        for (const k of ["assigned", "on_way", "on_location"]) {
          const m = compose(k, sample, {});
          await mailer.sendMail({ from: `"Sky Transfers" <${process.env.GMAIL_USER}>`, to, subject: "[SAMPLE] " + m.subject, text: m.text, html: m.html });
        }
        res.json({ ok: true, to });
      } catch (err) { console.error("guest sample:", err); res.status(500).json({ error: "Could not send the samples." }); }
    });
  }

  if (!ctx.noTimer) {
    setTimeout(() => tick(), 120e3).unref();
    setInterval(() => tick(), 5 * 60e3).unref();
  }
  console.log("Guest updates ready (" + (wa.enabled ? "email + WhatsApp" : "email; WhatsApp not connected") + "; off until switched on)");
  return { on: true, tick, noticePass, token, fromToken, compose };
};
