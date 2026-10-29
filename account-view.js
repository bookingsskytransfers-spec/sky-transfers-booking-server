/**
 * Sky Transfers — read-only job view for an account
 * -------------------------------------------------
 * Rallys, a DMC, any company in ops_accounts gets one link
 * (account.html#t=...) that lists the jobs we hold for them and how each one
 * is going - the same idea as a driver's link (Aman, 29 Oct 2026). The token
 * carries the account id and a link version: no expiry, so it can sit in a
 * bookmark at their office, and "Reset link" in dispatch bumps the version so
 * every old copy stops working.
 *
 * It shows their own jobs from a week ago to 60 days ahead: when, where,
 * the guest's name, pax, vehicle class, and - only once the office has SENT
 * the job to a driver - the driver's name, mobile and car, with the progress
 * steps. Never a fare, the guest's phone or email, office notes, driver pay,
 * a rego or the arrival location. Nothing on it can change anything.
 *
 * The jobs are the account's ops_jobs (the `account` text matched to the
 * account name, capitals ignored - the same rule invoicing uses).
 */
module.exports = function installAccountView(ctx, ops) {
  const { app, pool, requireAdmin } = ctx;
  const crypto = require("crypto");
  const SECRET = process.env.AGENT_SECRET || "";
  /* A key of its own, so this link can never stand in for a driver link,
     a guest tracking link or an admin session. */
  const KEY = crypto.createHmac("sha256", SECRET).update("sky-account-view-v1").digest();
  const SITE = String(process.env.PUBLIC_SITE_URL || "https://www.skytransfers.com.au").replace(/\/+$/, "");
  const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };
  const inList = (n) => Array.from({ length: n }, (_, i) => "$" + (i + 1)).join(", ");

  async function initSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ops_view_links (
        account_id   INTEGER PRIMARY KEY,
        version      INTEGER NOT NULL DEFAULT 1,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  function tokenFor(accountId, version) {
    const body = Buffer.from(JSON.stringify({ k: "acv", a: accountId, v: version })).toString("base64url");
    return body + "." + crypto.createHmac("sha256", KEY).update(body).digest("base64url");
  }
  const linkFor = (accountId, version) => SITE + "/account.html#t=" + tokenFor(accountId, version);

  async function versionOf(accountId) {
    const { rows } = await pool.query(`SELECT version FROM ops_view_links WHERE account_id = $1`, [accountId]);
    if (rows[0]) return rows[0].version;
    await pool.query(`INSERT INTO ops_view_links (account_id, version) VALUES ($1, 1)`, [accountId])
      .catch((e) => { if (e.code !== "23505") throw e; });
    return 1;
  }

  async function accountFromToken(t) {
    const [body, sig] = String(t || "").split(".");
    if (!body || !sig || !SECRET) return null;
    const want = crypto.createHmac("sha256", KEY).update(body).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let c; try { c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (e) { return null; }
    if (!c || c.k !== "acv" || !Number.isInteger(c.a)) return null;
    const { rows } = await pool.query(
      `SELECT a.id, a.name, a.active, l.version FROM ops_accounts a LEFT JOIN ops_view_links l ON l.account_id = a.id WHERE a.id = $1`, [c.a]);
    const acc = rows[0];
    if (!acc || !acc.active || (acc.version || 1) !== c.v) return null;
    return acc;
  }

  /* The office: make (or remake) an account's link. */
  app.post("/ops/account/view-link", requireAdmin, async (req, res) => {
    try {
      const id = int((req.body || {}).id);
      const { rows } = await pool.query(`SELECT id, name, active FROM ops_accounts WHERE id = $1`, [id]);
      if (!rows[0]) return res.status(404).json({ error: "No such account." });
      if (!rows[0].active) return res.status(409).json({ error: "That account is inactive - set it to Active first." });
      let v = await versionOf(id);
      if ((req.body || {}).reset) {
        await pool.query(`UPDATE ops_view_links SET version = version + 1 WHERE account_id = $1`, [id]);
        v = await versionOf(id);
        console.log("account view link reset:", id, rows[0].name, "v" + v);
      }
      res.json({ ok: true, name: rows[0].name, url: linkFor(id, v) });
    } catch (err) {
      console.error("account view link:", err);
      res.status(500).json({ error: "Could not make that link." });
    }
  });

  /* A job counts as handed to a driver once the office has sent it, or the
     driver has started on it - before that the driver may still change. */
  const STARTED = ["accepted", "on_way", "on_location", "pob", "done"];
  const PUBLIC_STATUS = { assigned: "driver_assigned", accepted: "driver_assigned", on_way: "on_way", on_location: "on_location", pob: "pob", done: "done" };

  /* POST, token in the body - account.html keeps it in the URL fragment. */
  app.post("/account/jobs", async (req, res) => {
    try {
      const acc = await accountFromToken((req.body || {}).t);
      if (!acc) return res.status(401).json({ error: "This link has expired or been replaced. Ask Sky Transfers for your new one." });
      const today = ops.bneToday(0), from = ops.addDays(today, -7), to = ops.addDays(today, 60);
      const name = String(acc.name).trim().toLowerCase();
      const legs = (await ops.sourceRows(from, to))
        .filter((l) => l.source === "account" && String(l.account || "").trim().toLowerCase() === name && l.date >= from && l.date <= to);
      const refs = [...new Set(legs.map((l) => l.ref))];
      const disp = refs.length ? (await pool.query(`SELECT * FROM ops_dispatch WHERE ref IN (${inList(refs.length)})`, refs)).rows : [];
      const drivers = await ops.allDrivers(), vehicles = await ops.allVehicles();
      ops.attachDispatch(legs, disp, drivers, vehicles);
      legs.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")) || a.ref.localeCompare(b.ref));
      const t = (x) => (x ? new Date(x).toISOString() : null);
      res.json({
        account: { name: acc.name }, today,
        jobs: legs.map((l) => {
          /* a driver who turned it down is not their driver any more */
          const handed = !!l.driverId && l.status !== "declined" && l.status !== "unassigned" && (!!l.sentAt || STARTED.includes(l.status));
          const d = handed ? drivers.find((x) => x.id === l.driverId) : null;
          return {
            ref: l.ref, theirRef: l.accountRef || "", leg: l.leg, isReturn: l.isReturn,
            date: l.date, time: l.time, from: l.from, to: l.to, stops: l.stops || [], hours: l.hours,
            flight: l.flight || "", guest: l.guest || "", pax: l.pax, vehicleClass: l.vehicleClass || "",
            childSeats: l.childSeats || 0, trailer: !!l.trailer,
            status: handed ? (PUBLIC_STATUS[l.status] || "driver_assigned") : (l.status === "done" ? "done" : "booked"),
            driver: d ? { name: d.name, phone: d.phone || "", car: l.vehicleLabel || "" } : null,
            steps: handed ? { accepted: t(l.times.accepted), onWay: t(l.times.onWay), onLocation: t(l.times.onLocation),
                              pob: t(l.times.pob), done: t(l.times.done) } : (l.status === "done" ? { done: t(l.times.done) } : {}),
          };
        }),
      });
    } catch (err) {
      console.error("account jobs:", err);
      res.status(500).json({ error: "Could not load the jobs - try again in a moment." });
    }
  });

  initSchema()
    .then(() => console.log("Account view ready (read-only links for accounts)"))
    .catch((e) => console.error("Account view setup failed:", e.message));

  return { linkFor, accountFromToken, tokenFor, initSchema };
};
