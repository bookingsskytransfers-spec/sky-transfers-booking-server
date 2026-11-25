/* ---------------------------------------------------------------------------
 * Affiliates - the referral programme (Aman's brief, 2 Nov 2026).
 *
 * Hosts, small hotels, planners and bloggers share a link (?ref=code) or a
 * code; the guest books and pays on the ordinary website; the affiliate earns
 * a commission on the completed trip. Agents book FOR a client in the portal -
 * affiliates never book, so they get none of that: no booking, no customer
 * phone or email, just a first name, date, route and fare.
 *
 * Built the same way as the agent wallet:
 *   - the commission lives on the booking row (web_bookings.aff_*), and only
 *     website bookings carry one, so an agent-portal booking or an account job
 *     (Rallys, Nexus...) can never earn affiliate commission, by construction;
 *   - the wallet is DERIVED every time it is read, never stored. Pending,
 *     earned and reversed are worked out from the booking's own state and the
 *     dispatch board, so a cancellation reverses the commission with nothing
 *     to remember. The one thing written down is a payout ("Mark paid"), which
 *     freezes the amount paid on each row it covered.
 *
 *   commission = rate x (fare paid - refunds - child seats - trailer) ex GST
 *
 * pending  - the booking is paid, the trip has not finished
 * earned   - every leg is marked done on the dispatch board
 * paid     - included in a "Mark paid" payout
 * reversed - cancelled or declined before it was paid out
 * A booking the guest has not paid for yet earns nothing and is not shown.
 *
 * Self-referral (the guest's email or phone is the affiliate's own) is flagged
 * for Aman and kept out of what is owed until he allows it.
 * ------------------------------------------------------------------------ */
"use strict";

const GST_DIVISOR = 1.1;
const CODE_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/* "Palm Beach Host!" -> "palmbeachhost". Codes are case-insensitive and stored
   in lower case, because they are typed into a URL by people, not machines. */
function normCode(v) {
  const s = String(v || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  return CODE_RE.test(s) ? s : "";
}

const digits = (v) => String(v || "").replace(/\D/g, "").replace(/^61/, "0");
const sameEmail = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const samePhone = (a, b) => { const x = digits(a), y = digits(b); return x.length >= 8 && x === y; };

/* The part of the fare commission is paid on, in cents. Child seats ($15) and
   the trailer ($30) are charged once per leg. Refunds come off first. */
function commissionBase(row, prices) {
  const legs = row.return_date ? 2 : 1;
  const extras = ((parseInt(row.child_seats, 10) || 0) * prices.seat + (row.trailer ? prices.trailer : 0)) * legs * 100;
  const base = (row.total_cents || 0) - (row.refunded_cents || 0) - extras;
  return Math.max(0, base);
}
function commissionCents(row, pct, prices) {
  const p = Number(pct);
  if (!(p > 0)) return 0;
  return Math.round(commissionBase(row, prices) / GST_DIVISOR * p / 100);
}

/* legsDone: how many of the booking's legs are "done" on the dispatch board. */
function stateOf(row, legsDone) {
  if (!row.aff_code) return null;
  if (row.aff_paid_at) return "paid";
  if (row.status === "cancelled" || row.status === "declined" || row.aff_flag === "void") return "reversed";
  if (!row.paid_at && row.status !== "paid") return null;
  const legs = row.return_date ? 2 : 1;
  return legsDone >= legs ? "earned" : "pending";
}

function firstName(n) { return String(n || "").trim().split(/\s+/)[0] || "Guest"; }

module.exports = function mountAffiliates(o) {
  const { app, pool, requireAdmin, mailer, BOOKINGS_EMAIL, prices, auth, SITE } = o;
  if (!pool || !auth) throw new Error("affiliates need the portal database and sign-in");
  const site = String(SITE || "https://www.skytransfers.com.au").replace(/\/+$/, "");
  const money = (c) => `$${(c / 100).toFixed(2)}`;

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS affiliates (
        code           TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        business       TEXT,
        email          TEXT,
        phone          TEXT,
        website        TEXT,
        promote        TEXT,
        bsb            TEXT,
        account_no     TEXT,
        account_name   TEXT,
        commission_pct NUMERIC(5,2),
        active         BOOLEAN NOT NULL DEFAULT FALSE,
        pin_hash       TEXT,
        pin_ver        INTEGER NOT NULL DEFAULT 1,
        source         TEXT NOT NULL DEFAULT 'admin',
        notes          TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        activated_at   TIMESTAMPTZ
      );
      ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS welcomed_at TIMESTAMPTZ;
      ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS pin_own BOOLEAN DEFAULT FALSE;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS aff_code       TEXT;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS aff_pct        NUMERIC(5,2);
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS aff_flag       TEXT;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS aff_paid_at    TIMESTAMPTZ;
      ALTER TABLE web_bookings ADD COLUMN IF NOT EXISTS aff_paid_cents INTEGER;
      CREATE INDEX IF NOT EXISTS web_bookings_aff ON web_bookings (aff_code);
    `);
  }
  const ready = init().then(() => console.log("affiliates: tables ready"))
    .catch((e) => console.error("affiliates: schema:", e.message));

  async function activeAffiliate(code) {
    const c = normCode(code);
    if (!c) return null;
    const { rows } = await pool.query(
      "SELECT code, name, business, email, phone, commission_pct FROM affiliates WHERE code = $1 AND active AND commission_pct > 0", [c]);
    return rows[0] || null;
  }

  /* Which affiliate a booking belongs to: a code the guest typed beats the one
     stored from a link, and an unknown or inactive code is simply ignored -
     the guest is never shown an error for it. */
  async function resolve(typed, stored, guest) {
    await ready;
    const a = (await activeAffiliate(typed).catch(() => null)) || (await activeAffiliate(stored).catch(() => null));
    if (!a) return null;
    return { ...a, self: sameEmail(guest && guest.email, a.email) || samePhone(guest && guest.phone, a.phone) };
  }

  /* Puts the affiliate on a booking that has none yet. The rate is copied onto
     the row, so changing an affiliate's rate later never rewrites a booking
     already made at the old one. Never throws: a referral must not be able to
     stop a booking. Returns the affiliate (for the office email) or null. */
  async function tagBooking(ref, aff, guest) {
    try {
      if (!ref || !aff) return null;
      await ready;
      const self = aff.self != null ? aff.self : sameEmail(guest && guest.email, aff.email) || samePhone(guest && guest.phone, aff.phone);
      const r = await pool.query(
        `UPDATE web_bookings SET aff_code = $2, aff_pct = $3, aff_flag = $4
          WHERE ref = $1 AND aff_code IS NULL`,
        [ref, aff.code, aff.commission_pct, self ? "self" : null]);
      return r.rowCount ? { ...aff, self } : null;
    } catch (e) {
      console.error("affiliate tag:", ref, e.message);
      return null;
    }
  }
  /* The line the office sees in its booking email - never the guest's copy. */
  const officeLine = (a) => a
    ? `Referral: ${a.code} (${a.business || a.name}), ${Number(a.commission_pct)}% commission` +
      (a.self ? " - FLAGGED: the guest's email or phone is the affiliate's own, check before paying" : "") + "\n"
    : "";

  /* The welcome email (24 Nov 2026): the affiliate's own link, code and rate,
     and how the programme works in the words of the referral page. It goes
     out the first time an account is made active, and again when the office
     asks. The PIN is never in it - the office passes that on itself, as the
     admin page has always said. A copy goes to the office. */
  const validEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || "").trim());
  function welcomeMail(a) {
    const link = `${site}/?ref=${a.code}`;
    const hi = firstName(a.name);
    const bank = a.bsb && a.account_no
      ? "Payments go out monthly by bank transfer, to the bank details we have on file for you."
      : "Payments go out monthly by bank transfer. We don't have your bank details yet - when you are ready, send us your account name, BSB and account number.";
    return {
      subject: "Your Sky Transfers referral link and details",
      text:
        `Hi ${hi === "Guest" ? "there" : hi},\n\n` +
        `Welcome to the Sky Transfers referral programme. Your account is active and your link is ready to share.\n\n` +
        `YOUR DETAILS\n` +
        `Your link: ${link}\n` +
        `Your code: ${a.code}\n` +
        `Your commission rate: ${Number(a.commission_pct)}%\n\n` +
        `HOW IT WORKS\n` +
        `- Share your link or your code with your guests. They book and pay on our website at the normal published fare.\n` +
        `- Guests who don't use the link can type your code into "Referral code (optional)" on the booking form.\n` +
        `- You earn commission on every trip that is booked and paid on our website and then completed. A cancelled or refunded booking earns nothing.\n` +
        `- Commission is worked out on the fare, excluding GST and extras such as child seats and the luggage trailer.\n` +
        `- Your link is remembered for 30 days on the guest's device. If they click someone else's link after yours, the last link clicked counts. A code typed into the booking form counts ahead of any link.\n` +
        `- Bookings you make for yourself don't count.\n` +
        `- Please don't run paid search advertising on "Sky Transfers" or our brand name, and no spam.\n\n` +
        `YOUR ACCOUNT\n` +
        `See the bookings you referred and what you have earned at:\n${site}/affiliate.html\n` +
        `Sign in with your code and your PIN. For your security the PIN is not sent by email - Aman will give it to you directly. Once you are signed in you can change it to a PIN of your own.\n\n` +
        `GETTING PAID\n${bank}\n\n` +
        `Questions? Reply to this email, or call or WhatsApp +61 481 437 772.\n\n` +
        `Aman\nSky Transfers\n`,
    };
  }
  /* "sent", or why not: "inactive", "no-email" or "failed". Never throws. */
  async function sendWelcome(a) {
    if (!a || !a.active || !(Number(a.commission_pct) > 0)) return "inactive";
    if (!validEmail(a.email)) return "no-email";
    if (!mailer) return "failed";
    try {
      const m = welcomeMail(a);
      await mailer.sendMail({
        from: `"Sky Transfers" <${process.env.GMAIL_USER}>`, to: String(a.email).trim(), bcc: BOOKINGS_EMAIL, replyTo: BOOKINGS_EMAIL,
        subject: m.subject, text: m.text,
      });
      await pool.query("UPDATE affiliates SET welcomed_at = now() WHERE code = $1", [a.code]).catch(() => {});
      console.log("affiliate welcome: emailed", a.code);
      return "sent";
    } catch (e) {
      console.error("affiliate welcome email:", a.code, e.message);
      return "failed";
    }
  }

  /* Every referred booking of one affiliate (or all of them), with its state.
     The dispatch board's own rows say which legs are done. */
  async function referred(code) {
    await ready;
    const { rows } = await pool.query(
      `SELECT ref, aff_code, aff_pct, aff_flag, aff_paid_at, aff_paid_cents, status, paid_at,
              total_cents, refunded_cents, child_seats, trailer, passenger_name, passenger_email, passenger_phone,
              pickup, dropoff, vehicle, to_char(pickup_date, 'YYYY-MM-DD') AS d,
              to_char(return_date, 'YYYY-MM-DD') AS return_date, created_at
         FROM web_bookings WHERE aff_code IS NOT NULL ${code ? "AND aff_code = $1" : ""}
        ORDER BY pickup_date DESC NULLS LAST, created_at DESC`, code ? [code] : []);
    let done = new Map();
    if (rows.length) {
      try {
        const d = await pool.query(
          `SELECT ref, COUNT(*)::int AS n FROM ops_dispatch WHERE status = 'done' AND ref = ANY($1) GROUP BY ref`,
          [rows.map((r) => r.ref)]);
        done = new Map(d.rows.map((x) => [x.ref, x.n]));
      } catch (e) { /* dispatch tables absent: nothing is completed yet */ }
    }
    return rows.map((r) => {
      const state = stateOf(r, done.get(r.ref) || 0);
      const cents = state === "paid" ? (r.aff_paid_cents || 0) : commissionCents(r, r.aff_pct, prices);
      return { ...r, state, cents };
    }).filter((r) => r.state);
  }
  function totals(list) {
    const t = { pending: 0, earned: 0, paid: 0, flagged: 0 };
    for (const r of list) {
      if (r.aff_flag === "self" && (r.state === "pending" || r.state === "earned")) { t.flagged += r.cents; continue; }
      if (t[r.state] != null) t[r.state] += r.cents;
    }
    return t;
  }

  /* ---- public: apply ----------------------------------------------------- */
  const APPLY_LOG = new Map();
  app.post("/affiliate/apply", async (req, res) => {
    try {
      const b = req.body || {};
      const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
      const hits = (APPLY_LOG.get(ip) || []).filter((t) => Date.now() - t < 3600 * 1000);
      if (hits.length >= 5) return res.status(429).json({ error: "Too many applications from here - please call +61 481 437 772." });
      APPLY_LOG.set(ip, hits.concat(Date.now()));
      const clip = (v, n) => String(v || "").trim().slice(0, n);
      const a = { name: clip(b.name, 120), business: clip(b.business, 160), email: clip(b.email, 160),
                  phone: clip(b.phone, 40), website: clip(b.website, 300), promote: clip(b.promote, 1500) };
      if (!a.name || !a.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email) || !a.phone) {
        return res.status(400).json({ error: "Please give your name, email and phone." });
      }
      await ready;
      /* A suggested code from the business (or person) name; Aman can change
         it in admin before the account goes live. */
      let base = normCode((a.business || a.name).replace(/\s+/g, "")) || "affiliate";
      base = base.slice(0, 24);
      let code = base, n = 1;
      while ((await pool.query("SELECT 1 FROM affiliates WHERE code = $1", [code])).rows.length) code = base + (++n);
      await pool.query(
        `INSERT INTO affiliates (code, name, business, email, phone, website, promote, active, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,'applied')`,
        [code, a.name, a.business || null, a.email, a.phone, a.website || null, a.promote || null]);
      if (mailer) await mailer.sendMail({
        from: `"Sky Transfers Website" <${process.env.GMAIL_USER}>`, to: BOOKINGS_EMAIL, replyTo: a.email,
        subject: `NEW Affiliate application: ${a.business || a.name}`,
        text: `AFFILIATE APPLICATION - Sky Transfers website\n\n` +
          `Name: ${a.name}\nBusiness: ${a.business || "-"}\nEmail: ${a.email}\nPhone: ${a.phone}\n` +
          `Website or listing: ${a.website || "-"}\n\nHow they'll promote us:\n${a.promote || "-"}\n\n` +
          `Saved in admin (Affiliates tab) as "${code}", INACTIVE. To approve: set the commission rate, ` +
          `check the code, tick Active and save - the PIN is shown once, to pass on with their link ${site}/?ref=${code}\n`,
      }).catch((e) => console.error("affiliate apply email:", e.message));
      res.json({ ok: true });
    } catch (err) {
      console.error("affiliate apply:", err);
      res.status(500).json({ error: "Could not send that just now - please call +61 481 437 772." });
    }
  });

  /* ---- affiliate sign-in and their own page ------------------------------- */
  app.post("/affiliate/login", async (req, res) => {
    try {
      await ready;
      const code = normCode(req.body && req.body.code);
      const pin = String((req.body && req.body.pin) || "").trim();
      if (!code || !pin) return res.status(400).json({ error: "Enter your referral code and PIN." });
      const key = "aff:" + code;
      if (auth.loginLocked(key)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes, or call +61 481 437 772." });
      const { rows } = await pool.query("SELECT code, name, pin_hash, pin_ver, active FROM affiliates WHERE code = $1", [code]);
      const a = rows[0];
      if (!a || !a.active || !a.pin_hash || !auth.pinMatches(pin, a.pin_hash)) {
        auth.noteLoginFail(key);
        return res.status(401).json({ error: "That code and PIN do not match." });
      }
      auth.clearFails(key);
      res.json({ token: auth.signToken(a.code, "affiliate", 12 * 3600 * 1000, { pv: Number(a.pin_ver) }), name: a.name, code: a.code });
    } catch (err) {
      console.error("affiliate login:", err);
      res.status(500).json({ error: "Could not sign you in just now." });
    }
  });
  async function requireAffiliate(req, res, next) {
    try {
      const claim = auth.readToken(auth.bearer(req));
      if (!claim || claim.role !== "affiliate") return res.status(401).json({ error: "Your session has expired - please sign in again." });
      const { rows } = await pool.query("SELECT * FROM affiliates WHERE code = $1", [claim.code]);
      const a = rows[0];
      if (!a || !a.active || Number(a.pin_ver) !== Number(claim.pv)) return res.status(401).json({ error: "This account is no longer active, or its PIN changed - please sign in again." });
      req.affiliate = a;
      next();
    } catch (err) {
      console.error("affiliate auth:", err);
      res.status(500).json({ error: "Could not check your sign-in just now." });
    }
  }
  app.get("/affiliate/me", requireAffiliate, async (req, res) => {
    try {
      const a = req.affiliate;
      const list = await referred(a.code);
      const t = totals(list);
      res.json({
        name: a.name, business: a.business, code: a.code, link: `${site}/?ref=${a.code}`,
        commissionPct: Number(a.commission_pct), pinOwn: !!a.pin_own,
        totals: { pending: t.pending / 100, earned: t.earned / 100, paid: t.paid / 100, review: t.flagged / 100 },
        /* first name, date, route and fare only - never a phone or an email */
        bookings: list.map((r) => ({
          date: r.d, firstName: firstName(r.passenger_name), route: `${r.pickup || ""} to ${r.dropoff || ""}`,
          isReturn: !!r.return_date, fare: (r.total_cents - (r.refunded_cents || 0)) / 100,
          commission: r.state === "reversed" ? 0 : r.cents / 100,
          state: r.aff_flag === "self" && (r.state === "pending" || r.state === "earned") ? "review" : r.state,
          paidAt: r.aff_paid_at || null,
        })),
      });
    } catch (err) {
      console.error("affiliate me:", err);
      res.status(500).json({ error: "Could not load your account just now." });
    }
  });

  /* Change your own PIN (26 Nov 2026). The first PIN comes from the office;
     this lets the affiliate replace it with one only they know. The current
     PIN is asked for again, and wrong tries count toward the same
     fifteen-minute lock as sign-in. The new one is 4 to 8 digits and not an
     obvious one. Changing it signs out every other session of theirs; this
     one is handed a fresh token. They are told by email that it changed -
     never what to. A wrong current PIN answers 400, not 401, so their page
     does not take it for an expired session and sign them out. */
  const weakPin = (p) => /^(\d)\1+$/.test(p) || "01234567890123456789".indexOf(p) !== -1 || "98765432109876543210".indexOf(p) !== -1;
  app.post("/affiliate/pin", requireAffiliate, async (req, res) => {
    try {
      const a = req.affiliate, key = "aff:" + a.code;
      const cur = String((req.body && req.body.current) || "").trim(), next = String((req.body && req.body.next) || "").trim();
      if (auth.loginLocked(key)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes, or call +61 481 437 772." });
      if (!cur || !auth.pinMatches(cur, a.pin_hash)) { auth.noteLoginFail(key); return res.status(400).json({ error: "That is not your current PIN." }); }
      if (!/^\d{4,8}$/.test(next)) return res.status(400).json({ error: "A PIN is 4 to 8 digits, numbers only." });
      if (weakPin(next)) return res.status(400).json({ error: "That PIN is too easy to guess. Avoid one repeated digit and runs like 1234." });
      if (auth.pinMatches(next, a.pin_hash)) return res.status(400).json({ error: "That is the PIN you already have. Choose a different one." });
      const r = await pool.query(
        "UPDATE affiliates SET pin_hash = $2, pin_ver = pin_ver + 1, pin_own = TRUE WHERE code = $1 AND pin_ver = $3 RETURNING pin_ver",
        [a.code, auth.makePinHash(next), a.pin_ver]);
      if (!r.rows[0]) return res.status(409).json({ error: "Your PIN was changed a moment ago - please sign in again." });
      auth.clearFails(key);
      console.log("affiliate pin: changed by the affiliate,", a.code);
      if (mailer && validEmail(a.email)) {
        const hi = firstName(a.name);
        mailer.sendMail({
          from: `"Sky Transfers" <${process.env.GMAIL_USER}>`, to: String(a.email).trim(), replyTo: BOOKINGS_EMAIL,
          subject: "Your Sky Transfers referral PIN was changed",
          text: `Hi ${hi === "Guest" ? "there" : hi},\n\n` +
            `The PIN for your Sky Transfers referral account (${a.code}) was changed just now from your account page.\n\n` +
            `If that was you, there is nothing to do. If it was not you, call or WhatsApp +61 481 437 772 straight away and we will reset it.\n\n` +
            `Aman\nSky Transfers\n`,
        }).catch((e) => console.error("affiliate pin email:", a.code, e.message));
      }
      res.json({ ok: true, token: auth.signToken(a.code, "affiliate", 12 * 3600 * 1000, { pv: Number(r.rows[0].pin_ver) }) });
    } catch (err) {
      console.error("affiliate pin:", err);
      res.status(500).json({ error: "Could not change your PIN just now." });
    }
  });

  /* ---- admin -------------------------------------------------------------- */
  /* Check a code (25 Nov 2026): would a website booking carrying this code be
     credited, and to whom? It asks resolve() - the function every booking goes
     through - so the answer cannot differ from what a real booking gets, and
     when the answer is no it says which reason applies. A guest's email or
     phone is optional: with one, it also says whether that booking would be
     held as a self-referral. It reads only; nothing is written. POST, so a
     guest's email or phone never sits in a web address. */
  app.post("/admin/affiliate-check", requireAdmin, async (req, res) => {
    try {
      await ready;
      res.setHeader("Cache-Control", "no-store");
      const b = req.body || {};
      const typed = String(b.code || "").trim().slice(0, 60);
      if (!typed) return res.status(400).json({ error: "Type a referral code to check." });
      const code = normCode(typed);
      if (!code) {
        return res.json({ ok: true, typed, code: null, credited: false, reason: "invalid",
          message: `No. "${typed}" is not a valid code - a code is 3 to 30 letters, digits or hyphens - so a booking carrying it is taken as a normal booking with no referral.` });
      }
      const guest = { email: String(b.email || "").trim().slice(0, 160), phone: String(b.phone || "").trim().slice(0, 40) };
      const hit = await resolve(code, null, guest);
      const row = (await pool.query("SELECT code, name, business, commission_pct, active FROM affiliates WHERE code = $1", [code])).rows[0] || null;
      const who = row ? (row.business || row.name) : null;
      const base = { ok: true, typed, code, link: `${site}/?ref=${code}`, affiliate: who, active: row ? !!row.active : null,
        commissionPct: row && row.commission_pct != null ? Number(row.commission_pct) : null };
      if (hit) {
        return res.json({ ...base, credited: true, selfReferral: !!hit.self, reason: hit.self ? "self" : "ok",
          message: `Yes. A website booking with the code ${code} - typed into the form, or from the link ${site}/?ref=${code} - is credited to ${who} at ${Number(hit.commission_pct)}%.` +
            (hit.self ? " But this guest's email or phone is the affiliate's own, so that booking would be flagged for you to allow or void before any commission counts." : "") });
      }
      if (!row) return res.json({ ...base, credited: false, reason: "unknown",
        message: `No. There is no affiliate with the code ${code}, so a booking carrying it is taken as a normal booking with no referral.` });
      if (!row.active) return res.json({ ...base, credited: false, reason: "inactive",
        message: `No. ${who} (${code}) is not Active, so a booking carrying the code earns nothing. Set the account to Active to switch it on.` });
      return res.json({ ...base, credited: false, reason: "no-rate",
        message: `No. ${who} (${code}) has no commission rate, so a booking carrying the code earns nothing.` });
    } catch (err) {
      console.error("admin affiliate check:", err);
      res.status(500).json({ error: "Could not check that code." });
    }
  });

  app.get("/admin/affiliates", requireAdmin, async (req, res) => {
    try {
      await ready;
      const { rows } = await pool.query("SELECT * FROM affiliates ORDER BY active DESC, created_at DESC");
      const all = await referred(null);
      const by = new Map();
      for (const r of all) { if (!by.has(r.aff_code)) by.set(r.aff_code, []); by.get(r.aff_code).push(r); }
      res.json({
        affiliates: rows.map((a) => {
          const list = by.get(a.code) || [];
          const t = totals(list);
          return {
            code: a.code, name: a.name, business: a.business, email: a.email, phone: a.phone,
            website: a.website, promote: a.promote, bsb: a.bsb, accountNo: a.account_no, accountName: a.account_name,
            commissionPct: a.commission_pct != null ? Number(a.commission_pct) : null, active: a.active,
            source: a.source, notes: a.notes, createdAt: a.created_at, hasPin: !!a.pin_hash, welcomedAt: a.welcomed_at || null,
            link: `${site}/?ref=${a.code}`, bookings: list.length,
            pending: t.pending / 100, owed: t.earned / 100, paid: t.paid / 100, review: t.flagged / 100,
          };
        }),
        /* the monthly statement: what is owed now, trip by trip */
        statement: all.filter((r) => r.state === "earned" || r.aff_flag === "self" && r.state === "pending").map((r) => ({
          ref: r.ref, code: r.aff_code, date: r.d, guest: r.passenger_name, route: `${r.pickup} to ${r.dropoff}`,
          fare: (r.total_cents - (r.refunded_cents || 0)) / 100, pct: Number(r.aff_pct), commission: r.cents / 100,
          state: r.state, flag: r.aff_flag || null,
        })),
      });
    } catch (err) {
      console.error("admin affiliates:", err);
      res.status(500).json({ error: "Could not load the affiliates." });
    }
  });

  /* Create or edit. A rate has to be entered before an account can go live -
     there is no default - and a new or reset PIN is shown once, here. */
  app.post("/admin/affiliate", requireAdmin, async (req, res) => {
    try {
      await ready;
      const b = req.body || {};
      const code = normCode(b.code);
      const was = normCode(b.was);
      if (!code) return res.status(400).json({ error: "The code must be 3-30 lower-case letters, digits or hyphens, like palmbeachhost." });
      if (!String(b.name || "").trim()) return res.status(400).json({ error: "Give the affiliate a name." });
      const pct = b.commissionPct === "" || b.commissionPct == null ? null : Number(b.commissionPct);
      if (pct != null && !(pct > 0 && pct <= 50)) return res.status(400).json({ error: "Commission must be more than 0 and at most 50%." });
      const active = b.active === true;
      if (active && pct == null) return res.status(400).json({ error: "Enter a commission rate before making the account active." });
      const clip = (v, n) => (String(v == null ? "" : v).trim().slice(0, n) || null);
      const bsb = clip(b.bsb, 7), acct = clip(b.accountNo, 12);
      if (bsb && !/^\d{3}-?\d{3}$/.test(bsb)) return res.status(400).json({ error: "BSB is six digits, like 123-456." });
      if (acct && !/^\d{5,10}$/.test(acct)) return res.status(400).json({ error: "Account number is 5 to 10 digits." });

      const target = was || code;
      const { rows: ex } = await pool.query("SELECT code, active, pin_hash, activated_at FROM affiliates WHERE code = $1", [target]);
      if (was && was !== code) {
        if ((await pool.query("SELECT 1 FROM affiliates WHERE code = $1", [code])).rows.length) return res.status(409).json({ error: `The code "${code}" is already taken.` });
        if ((await pool.query("SELECT 1 FROM web_bookings WHERE aff_code = $1 LIMIT 1", [was])).rows.length) {
          return res.status(409).json({ error: "This affiliate already has bookings under its code, so the code can't change any more." });
        }
      }
      let pin = null;
      if ((active && !(ex[0] && ex[0].pin_hash)) || b.resetPin) pin = auth.newPin();
      const vals = [code, String(b.name).trim().slice(0, 120), clip(b.business, 160), clip(b.email, 160), clip(b.phone, 40),
        clip(b.website, 300), bsb, acct, clip(b.accountName, 120), pct, active, clip(b.notes, 1000)];
      if (ex.length) {
        await pool.query(
          `UPDATE affiliates SET code=$1, name=$2, business=$3, email=$4, phone=$5, website=$6, bsb=$7, account_no=$8,
                  account_name=$9, commission_pct=$10, active=$11, notes=$12,
                  activated_at = CASE WHEN $11 THEN COALESCE(activated_at, now()) ELSE activated_at END
                  ${pin ? ", pin_hash=$14, pin_ver = pin_ver + 1, pin_own = FALSE" : ""}
            WHERE code=$13`, pin ? vals.concat(target, auth.makePinHash(pin)) : vals.concat(target));
      } else {
        await pool.query(
          `INSERT INTO affiliates (code, name, business, email, phone, website, bsb, account_no, account_name,
                                   commission_pct, active, notes, pin_hash, activated_at, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $11 THEN now() END, 'admin')`,
          vals.concat(pin ? auth.makePinHash(pin) : null));
      }
      auth.clearFails("aff:" + code);
      /* The first time an account goes active its welcome email goes out. An
         account that was already active before is left alone - the office has
         the button for that. */
      let welcome = null;
      if (active && !(ex[0] && ex[0].activated_at)) {
        const fresh = (await pool.query("SELECT * FROM affiliates WHERE code = $1", [code])).rows[0];
        welcome = await sendWelcome(fresh);
      }
      res.json({ ok: true, code, pin, link: `${site}/?ref=${code}`, created: !ex.length, welcome });
    } catch (err) {
      console.error("admin affiliate:", err);
      res.status(500).json({ error: "Could not save that affiliate." });
    }
  });

  /* The welcome email again, when the office asks for it - and the way to send
     it to an account that was already active before the email existed. */
  app.post("/admin/affiliate-welcome", requireAdmin, async (req, res) => {
    try {
      await ready;
      const code = normCode(req.body && req.body.code);
      const a = code ? (await pool.query("SELECT * FROM affiliates WHERE code = $1", [code])).rows[0] : null;
      if (!a) return res.status(404).json({ error: "No affiliate with that code." });
      if (!a.active || !(Number(a.commission_pct) > 0)) return res.status(400).json({ error: "Make the account Active, with a commission rate, before emailing their details." });
      if (!validEmail(a.email)) return res.status(400).json({ error: "Add their email address and save, then send it." });
      const r = await sendWelcome(a);
      if (r !== "sent") return res.status(502).json({ error: "The email could not be sent just now - please try again." });
      res.json({ ok: true, code: a.code, to: String(a.email).trim() });
    } catch (err) {
      console.error("admin affiliate welcome:", err);
      res.status(500).json({ error: "Could not send that email." });
    }
  });

  /* A self-referral flag: allow it (counts as normal) or void it (no commission). */
  app.post("/admin/affiliate-flag", requireAdmin, async (req, res) => {
    try {
      const ref = String((req.body && req.body.ref) || "").trim();
      const act = req.body && req.body.action;
      if (act !== "allow" && act !== "void") return res.status(400).json({ error: "Choose allow or void." });
      const r = await pool.query(
        `UPDATE web_bookings SET aff_flag = $2 WHERE ref = $1 AND aff_code IS NOT NULL AND aff_paid_at IS NULL`,
        [ref, act === "allow" ? "allowed" : "void"]);
      if (!r.rowCount) return res.status(404).json({ error: "No unpaid referral with that reference." });
      res.json({ ok: true });
    } catch (err) {
      console.error("admin affiliate flag:", err);
      res.status(500).json({ error: "Could not change that." });
    }
  });

  /* Mark paid: the bank transfer has been made by hand. Every EARNED, unpaid,
     unflagged trip of that affiliate is stamped with the amount it paid, so
     later changes can never rewrite a payment that has happened. */
  app.post("/admin/affiliate-paid", requireAdmin, async (req, res) => {
    try {
      const code = normCode(req.body && req.body.code);
      if (!code) return res.status(400).json({ error: "Which affiliate?" });
      const owed = (await referred(code)).filter((r) => r.state === "earned" && r.aff_flag !== "self");
      let cents = 0;
      for (const r of owed) {
        const u = await pool.query(
          `UPDATE web_bookings SET aff_paid_at = now(), aff_paid_cents = $2 WHERE ref = $1 AND aff_paid_at IS NULL`, [r.ref, r.cents]);
        if (u.rowCount) cents += r.cents;
      }
      console.log("affiliate paid:", code, owed.length, "trips", money(cents));
      res.json({ ok: true, trips: owed.length, amount: cents / 100 });
    } catch (err) {
      console.error("admin affiliate paid:", err);
      res.status(500).json({ error: "Could not record that payment." });
    }
  });

  return { resolve, tagBooking, officeLine, normCode };
};

module.exports.commissionCents = commissionCents;
module.exports.commissionBase = commissionBase;
module.exports.stateOf = stateOf;
module.exports.normCode = normCode;
module.exports.samePhone = samePhone;
