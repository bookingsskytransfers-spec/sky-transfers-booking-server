/**
 * The office dashboard (admin.html, Aman 22 Oct 2026): revenue by day and
 * week, own fleet against subcontractors, what drivers are paid, and the
 * money and jobs that need someone.
 *
 * It reads the dispatch board (ops.boardFor) - every website, agent and
 * account job, leg by leg, with its driver, car and driver pay - so it adds
 * up exactly what the board shows. Nothing here writes anything.
 *
 *  - Revenue is the value of the trips by TRAVEL date, GST included, the same
 *    per-leg price the board shows (a return is two legs, half each). It is
 *    not cash received. Late-cancellation charges are counted on their own.
 *  - Own fleet: a leg driven by an employee in one of our cars. Subcontracted:
 *    a subcontractor driver, or any driver in a subcontractor's own car.
 *  - Margin is revenue less driver pay - before fuel, tolls, insurance and
 *    the rest, which the system doesn't hold.
 */
module.exports = function installDashboard(ctx) {
  const { app, pool, requireAdmin, ops } = ctx;
  if (!app || !pool || typeof requireAdmin !== "function" || !ops || !ops.on) {
    console.log("Dashboard off (needs ops.js and the portal database)");
    return { on: false };
  }
  const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !isNaN(Date.parse(v + "T00:00:00Z")) ? String(v) : null);
  const today = () => ops.bneToday(0);
  const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
  const cents = (x) => Math.round((Number(x) || 0) * 100);
  const dollars = (c) => Math.round(c) / 100;
  const blank = () => ({ jobs: 0, revenue: 0, driverPay: 0 });
  const add = (o, l) => { o.jobs++; o.revenue += cents(l.price); o.driverPay += cents(l.driverPay); };
  const out = (o) => ({ jobs: o.jobs, revenue: dollars(o.revenue), driverPay: dollars(o.driverPay), margin: dollars(o.revenue - o.driverPay) });

  async function build(from, to) {
    const b = await ops.boardFor(from, to);
    const drivers = new Map(b.drivers.map((d) => [d.id, d]));
    const vehicles = new Map(b.vehicles.map((v) => [v.id, v]));
    const t = today();
    const kindOf = (l) => {
      const d = drivers.get(l.driverId);
      if (!d) return "unassigned";
      const v = vehicles.get(l.vehicleId);
      return d.kind === "subcontractor" || (v && v.owner_driver_id) ? "sub" : "own";
    };

    const days = new Map();
    for (let d = from; d <= to; d = addDays(d, 1)) days.set(d, { date: d, revenue: 0, jobs: 0, own: 0, sub: 0, unassigned: 0, driverPay: 0 });
    const tot = blank(), split = { own: blank(), sub: blank(), unassigned: blank() };
    const src = { web: blank(), agent: blank(), account: blank() };
    const byDriver = new Map(), byVehicle = new Map(), byCustomer = new Map(), byClass = new Map();
    let done = 0, notClosed = 0, payPaid = 0;

    for (const l of b.legs) {
      const k = kindOf(l), p = cents(l.price);
      add(tot, l); add(split[k], l); add(src[l.source] || (src[l.source] = blank()), l);
      const day = days.get(l.date);
      if (day) { day.revenue += p; day.jobs++; day[k] += p; day.driverPay += cents(l.driverPay); }
      if (l.status === "done") done++;
      else if (l.date < t) notClosed++;
      if (l.driverId) {
        const d = drivers.get(l.driverId) || {};
        const r = byDriver.get(l.driverId) || { id: l.driverId, name: d.name || "Driver " + l.driverId, kind: d.kind || "employee", jobs: 0, revenue: 0, pay: 0, paid: 0, owed: 0 };
        r.jobs++; r.revenue += p; r.pay += cents(l.driverPay);
        if (l.driverPaidAt) { r.paid += cents(l.driverPay); payPaid += cents(l.driverPay); }
        else if (l.status === "done") r.owed += cents(l.driverPay);
        byDriver.set(l.driverId, r);
      }
      if (l.vehicleId) {
        const v = vehicles.get(l.vehicleId) || {};
        const r = byVehicle.get(l.vehicleId) || { id: l.vehicleId, label: v.label || "Vehicle " + l.vehicleId, class: v.class || "", own: !v.owner_driver_id, jobs: 0, revenue: 0 };
        r.jobs++; r.revenue += p; byVehicle.set(l.vehicleId, r);
      }
      const who = l.source === "web" ? "Website customers" : (l.account || "Direct");
      const ck = l.source + "|" + who;
      const c = byCustomer.get(ck) || { name: who, source: l.source, jobs: 0, revenue: 0 };
      c.jobs++; c.revenue += p; byCustomer.set(ck, c);
      const vc = l.vehicleClass || "Not given";
      const cl = byClass.get(vc) || { vehicle: vc, jobs: 0, revenue: 0 };
      cl.jobs++; cl.revenue += p; byClass.set(vc, cl);
    }

    /* charges for agencies' late cancellations (rate card), and how many
       trips were cancelled in the period */
    const lateFees = (await pool.query(
      `SELECT COALESCE(SUM(total_cents), 0) AS c, COUNT(*) AS n FROM agent_bookings WHERE status = 'late_cancel' AND pickup_date >= $1 AND pickup_date <= $2`, [from, to])
      .catch(() => ({ rows: [{ c: 0, n: 0 }] }))).rows[0];
    let cancelled = 0;
    for (const [tbl, st] of [["web_bookings", "status IN ('cancelled','declined')"], ["agent_bookings", "status IN ('cancelled','late_cancel')"], ["ops_jobs", "status = 'cancelled'"]]) {
      cancelled += Number((await pool.query(`SELECT COUNT(*) AS n FROM ${tbl} WHERE ${st} AND pickup_date >= $1 AND pickup_date <= $2`, [from, to])
        .catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n) || 0;
    }

    const cents2 = (list) => list.map((x) => ({ ...x, revenue: dollars(x.revenue), pay: x.pay != null ? dollars(x.pay) : undefined,
      paid: x.paid != null ? dollars(x.paid) : undefined, owed: x.owed != null ? dollars(x.owed) : undefined }));
    const byRev = (a, b2) => b2.revenue - a.revenue;
    return {
      from, to, today: t,
      totals: { ...out(tot), revenueExGst: dollars(tot.revenue / 1.1), avgFare: tot.jobs ? dollars(tot.revenue / tot.jobs) : 0,
        done, notClosed, driverPaid: dollars(payPaid), lateFees: dollars(Number(lateFees.c) || 0), lateFeeCount: Number(lateFees.n) || 0, cancelled },
      split: { own: out(split.own), sub: out(split.sub), unassigned: out(split.unassigned) },
      sources: { web: out(src.web), agent: out(src.agent), account: out(src.account) },
      days: [...days.values()].map((d) => ({ ...d, revenue: dollars(d.revenue), own: dollars(d.own), sub: dollars(d.sub), unassigned: dollars(d.unassigned), driverPay: dollars(d.driverPay) })),
      drivers: cents2([...byDriver.values()].sort(byRev)),
      vehicles: cents2([...byVehicle.values()].sort(byRev)),
      customers: cents2([...byCustomer.values()].sort(byRev).slice(0, 12)),
      classes: cents2([...byClass.values()].sort(byRev)),
    };
  }

  /* what needs someone today, whatever the period */
  async function snapshot() {
    const t = today(), q = (sql, p) => pool.query(sql, p).then((r) => r.rows).catch(() => []);
    const inv = await q(`SELECT total_cents, to_char(due_on, 'YYYY-MM-DD') AS due FROM ops_invoices WHERE status = 'issued'`);
    const overdue = inv.filter((i) => i.due < t);
    const comm = (await q(`SELECT COALESCE(SUM(commission_cents), 0) AS c FROM agent_bookings WHERE status = 'confirmed' AND NOT settled`))[0] || { c: 0 };
    const dep = (await q(`SELECT COUNT(*) AS n, COALESCE(SUM(balance_cents), 0) AS c FROM web_bookings WHERE balance_cents > 0 AND status NOT IN ('declined','cancelled')`))[0] || { n: 0, c: 0 };
    const requested = (await q(`SELECT COUNT(*) AS n FROM web_bookings WHERE status = 'requested' AND pickup_date >= $1`, [t]))[0] || { n: 0 };
    const owed = (await q(`SELECT COALESCE(SUM(driver_pay_cents), 0) AS c, COUNT(*) AS n FROM ops_dispatch WHERE status = 'done' AND driver_paid_at IS NULL AND driver_pay_cents > 0`))[0] || { c: 0, n: 0 };
    const next = await ops.boardFor(t, addDays(t, 7));
    const live = next.legs.filter((l) => l.status !== "done");
    const soon = addDays(t, 30), papers = [];
    for (const d of next.drivers.filter((x) => x.active)) {
      for (const [k, what] of [["licence_expiry", "driver licence"], ["authority_expiry", "driver authority"]]) if (d[k] && d[k] <= soon) papers.push({ who: d.name, what, date: d[k], overdue: d[k] < t });
    }
    for (const v of next.vehicles.filter((x) => x.active)) {
      for (const [k, what] of [["rego_expiry", "rego"], ["insurance_expiry", "insurance"], ["service_due", "service"]]) if (v[k] && v[k] <= soon) papers.push({ who: v.label, what, date: v[k], overdue: v[k] < t });
    }
    papers.sort((a, b) => a.date.localeCompare(b.date));
    return {
      invoicesOpen: { count: inv.length, amount: dollars(inv.reduce((n, i) => n + i.total_cents, 0)) },
      invoicesOverdue: { count: overdue.length, amount: dollars(overdue.reduce((n, i) => n + i.total_cents, 0)) },
      commissionOwed: dollars(Number(comm.c) || 0),
      balancesOwing: { count: Number(dep.n) || 0, amount: dollars(Number(dep.c) || 0) },
      requestsWaiting: Number(requested.n) || 0,
      driverPayOwed: { count: Number(owed.n) || 0, amount: dollars(Number(owed.c) || 0) },
      next7: { legs: live.length, unassigned: live.filter((l) => !l.driverId).length, unsent: live.filter((l) => l.driverId && !l.sentAt).length,
        revenue: dollars(live.reduce((n, l) => n + cents(l.price), 0)) },
      papers,
    };
  }

  app.get("/admin/dashboard", requireAdmin, async (req, res) => {
    try {
      const t = today();
      let from = isoDate(req.query.from) || addDays(t, -6), to = isoDate(req.query.to) || t;
      if (to < from) [from, to] = [to, from];
      if (Date.parse(to) - Date.parse(from) > 400 * 864e5) return res.status(400).json({ error: "Choose a period of up to 13 months." });
      const [period, snap] = await Promise.all([build(from, to), snapshot()]);
      res.json({ ...period, snapshot: snap });
    } catch (err) {
      console.error("dashboard:", err);
      res.status(500).json({ error: "Could not build the dashboard." });
    }
  });

  console.log("Dashboard ready");
  return { on: true, build, snapshot };
};
