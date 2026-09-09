/**
 * Sky Transfers — checkout value lookup
 * -------------------------------------
 * One read-only endpoint so the confirmation page can report what a booking
 * was actually worth to Google Ads, instead of the conversion action's $1
 * default. Without it every sale — a $95 city run and a $735 Sprinter to
 * Byron alike — lands in Ads as one dollar, which makes the value column
 * meaningless and rules out value-based bidding entirely.
 *
 * The amount is fetched from Stripe rather than passed through the URL, so a
 * curious customer editing the address bar cannot inflate the reported value
 * and quietly poison the campaign's own training data.
 *
 * It returns only the amount and currency: nothing that is not already on the
 * customer's own Stripe receipt, and nothing identifying. Session ids are long
 * random strings and only the buyer has theirs.
 */
module.exports = function installCheckoutLookup({ app }) {
  const stripe = process.env.STRIPE_SECRET_KEY
    ? require("stripe")(process.env.STRIPE_SECRET_KEY)
    : null;

  app.get("/checkout-value", async (req, res) => {
    try {
      if (!stripe) return res.status(503).json({ error: "Payments are not configured." });
      const id = String(req.query.session_id || "");
      /* Stripe session ids are cs_live_… / cs_test_…; anything else is not
         worth a round trip to the API. */
      if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) {
        return res.status(400).json({ error: "Not a checkout session id." });
      }
      const s = await stripe.checkout.sessions.retrieve(id);
      if (!s || s.payment_status !== "paid") return res.json({ paid: false });
      res.json({
        paid: true,
        value: (s.amount_total || 0) / 100,
        currency: (s.currency || "aud").toUpperCase(),
      });
    } catch (err) {
      console.error("checkout-value:", err.message);
      res.status(404).json({ error: "No such checkout session." });
    }
  });
};
