/* node affiliates.test.js - the commission arithmetic and the state rules of
   affiliates.js, plus the rate card's night surcharge being gone. */
"use strict";
const assert = require("assert");
const { commissionCents, commissionBase, stateOf, normCode, samePhone } = require("./affiliates");
const rateCard = require("./rate-card");
const P = { seat: 15, trailer: 30 };
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("plain one-way: 10% of the fare ex GST", () => {
  // $110 fare -> $100 ex GST -> $10.00
  assert.strictEqual(commissionCents({ total_cents: 11000 }, 10, P), 1000);
});
t("child seats and trailer are taken off, per leg", () => {
  // $140 = $95 fare + 1 seat $15 + trailer $30, one-way -> base $95
  assert.strictEqual(commissionBase({ total_cents: 14000, child_seats: 1, trailer: true }, P), 9500);
  // return: 2 seats x 2 legs = $60 off
  assert.strictEqual(commissionBase({ total_cents: 30000, child_seats: 2, return_date: "2026-12-20" }, P), 24000);
});
t("refunds come off before the rate", () => {
  assert.strictEqual(commissionCents({ total_cents: 22000, refunded_cents: 11000 }, 10, P), 1000);
});
t("no rate, no commission; never negative", () => {
  assert.strictEqual(commissionCents({ total_cents: 11000 }, null, P), 0);
  assert.strictEqual(commissionCents({ total_cents: 11000 }, 0, P), 0);
  assert.strictEqual(commissionCents({ total_cents: 1000, child_seats: 3 }, 10, P), 0);
});
t("rounding to the cent", () => {
  // $85 -> 77.2727 ex GST -> 12.5% = 9.659 -> 966 cents
  assert.strictEqual(commissionCents({ total_cents: 8500 }, 12.5, P), 966);
});
t("states: unpaid shows nothing, paid is pending, every leg done is earned", () => {
  const r = { aff_code: "x", status: "requested", paid_at: null };
  assert.strictEqual(stateOf(r, 0), null);
  assert.strictEqual(stateOf({ ...r, status: "paid", paid_at: new Date() }, 0), "pending");
  assert.strictEqual(stateOf({ ...r, status: "paid", paid_at: new Date() }, 1), "earned");
  const ret = { ...r, status: "paid", paid_at: new Date(), return_date: "2026-12-20" };
  assert.strictEqual(stateOf(ret, 1), "pending", "one leg of a return is not completed");
  assert.strictEqual(stateOf(ret, 2), "earned");
});
t("cancelled or declined reverses; voided reverses; a payout stays paid", () => {
  const r = { aff_code: "x", status: "cancelled", paid_at: new Date() };
  assert.strictEqual(stateOf(r, 1), "reversed");
  assert.strictEqual(stateOf({ ...r, status: "declined" }, 0), "reversed");
  assert.strictEqual(stateOf({ aff_code: "x", status: "paid", paid_at: new Date(), aff_flag: "void" }, 1), "reversed");
  assert.strictEqual(stateOf({ aff_code: "x", status: "paid", paid_at: new Date(), aff_paid_at: new Date() }, 1), "paid");
  assert.strictEqual(stateOf({ aff_code: null, status: "paid" }, 1), null, "no code, no commission");
});
t("codes: lower case, letters digits and hyphens, 3-30 long", () => {
  assert.strictEqual(normCode(" PalmBeachHost "), "palmbeachhost");
  assert.strictEqual(normCode("palm beach host!"), "palmbeachhost");
  assert.strictEqual(normCode("ab"), "");
  assert.strictEqual(normCode("-abc"), "");
  assert.strictEqual(normCode("TESTAFF"), "testaff");
  assert.strictEqual(normCode("<script>"), "script");
});
t("self-referral phone match ignores spacing and +61", () => {
  assert.ok(samePhone("+61 481 437 772", "0481437772"));
  assert.ok(!samePhone("0481437772", "0481437773"));
  assert.ok(!samePhone("", ""));
});
t("rate card: a 10:30 pm pick-up costs the same as 10:30 am; Christmas Day is still +25%", () => {
  const rc = rateCard({ OOL: "Gold Coast Airport", BNE: "Brisbane Airport", CRUISE: "Brisbane Cruise Terminal" });
  const cases = [
    { service: "ool-surfers-4h" },                                    // a package
    { pickup: "Gold Coast Airport", dropoff: "Surfers Paradise" },    // a one-way transfer
  ];
  for (const c of cases) {
    const q = (date, time) => rc.quote({ ...c, date, time });
    const day = q("2026-11-20", "10:30"), night = q("2026-11-20", "22:30"), small = q("2026-11-21", "03:15"), xmas = q("2026-12-25", "10:30");
    assert.ok(day && day.vehicles && day.vehicles.length, "the card quotes " + JSON.stringify(c));
    for (let i = 0; i < day.vehicles.length; i++) {
      assert.strictEqual(night.vehicles[i].total, day.vehicles[i].total, "no night surcharge at 10:30 pm");
      assert.strictEqual(small.vehicles[i].total, day.vehicles[i].total, "no night surcharge at 3:15 am");
      assert.strictEqual(xmas.vehicles[i].total, Math.round(day.vehicles[i].total * 125 / 100), "festive +25% kept");
    }
    assert.ok(!/night/i.test(JSON.stringify(night)), "no night note");
  }
  assert.ok(!rc.publicCard().surcharges.some((x) => /night/i.test(x)), "the card no longer lists a night surcharge");
});
console.log(`\n${n} tests passed`);
