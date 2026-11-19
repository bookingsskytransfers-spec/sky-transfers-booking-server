/* ---------------------------------------------------------------------------
 * The door for other companies' AI assistants (stage 2a of the AI assistant,
 * 19 Nov 2026).
 *
 * A plain web address any assistant can call, with no key and no browser:
 *
 *   GET  /assist/v1                 what this is, the actions and the rules
 *   GET  /assist/v1/openapi.json    the same, as an OpenAPI 3.1 description
 *   POST /assist/v1/<action>        run an action; the body is its input (JSON)
 *   GET  /assist/v1/<action>?...    the read-only actions also answer a plain
 *                                   link, for assistants that can only open URLs
 *   GET  /admin/assist-stats        (admin) who used it, and for what
 *
 * It has no rules of its own. Every call is handed to assist-tools.js, which
 * holds the actions, their limits and what an assistant may and may not do;
 * this file only speaks HTTP, describes the actions, and keeps a log.
 *
 * Answers: when an action ran, the status is 200 and the body says ok true or
 * false with a message an assistant can read out. That is deliberate - many
 * assistants' web tools show nothing but "error" for a 4xx, and a refusal
 * ("that pick-up is too soon, please call") is an answer, not a fault. 404 is
 * an action that does not exist, 405 the wrong method, 429 too many requests.
 *
 * request_booking is POST only: a traveller's name, phone and email must not
 * travel in a URL.
 *
 * The log (assist_calls) keeps the action, whether it was accepted, the
 * caller's user-agent and a short one-way fingerprint of its address - never
 * the address itself, and never a traveller's details.
 *
 * Mounted in a try/catch from stripe-server.js: if it throws on boot one line
 * is logged and bookings carry on.
 * ------------------------------------------------------------------------ */
const crypto = require("crypto");

module.exports = function installAssistDoor(ctx) {
  const { app, assist, pool, requireAdmin } = ctx;
  if (!app || !assist || !assist.on || typeof assist.run !== "function") { console.log("Assistant door off (the actions are not mounted)"); return { on: false }; }
  const BASE = "/assist/v1";
  const HERE = String(ctx.publicBase || process.env.PUBLIC_SERVER_URL || "https://sky-transfers-booking-server.onrender.com").replace(/\/+$/, "");
  const SITE = "https://www.skytransfers.com.au", PHONE = "+61 481 437 772", EMAIL = "info@skytransfers.com.au";
  const TOOLS = assist.TOOLS, BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
  /* request_booking is the only action that changes anything */
  const READ_ONLY = new Set(TOOLS.map((t) => t.name).filter((n) => n !== "request_booking"));
  const url = (n) => HERE + BASE + "/" + n;
  const firstSentence = (s) => { const m = /^(.*?[.!?])(\s|$)/.exec(String(s)); return (m ? m[1] : String(s)).slice(0, 200); };

  /* ---- the description every assistant starts from ---------------------- */
  const INDEX = {
    service: "Sky Transfers - assistant actions",
    about: "Sky Transfers is a private ground transport operator on the Gold Coast, Australia: pre-booked airport, cruise and point-to-point transfers and chauffeur hire by the hour across the Gold Coast, Brisbane, Sunshine Coast, Toowoomba and Byron Bay, in our own vehicles from a sedan to an 18-seat Mercedes Sprinter. These actions let an AI assistant quote our fixed prices and lodge a booking request for a traveller without opening a browser.",
    how_to_use: [
      "1. find_places - turn the traveller's words (\"surfers\", \"Brisbane city\", \"OOL\") into our exact place name. A street address or hotel belongs to the suburb it is in.",
      "2. quote_trip (or quote_hourly_hire) - the fixed price for every vehicle. Tell the traveller the total and which vehicle it is for.",
      "3. check_pickup_time - online bookings need 2 hours' notice, in Brisbane time (UTC+10 all year). Its answer also tells you the time in Brisbane now.",
      "4. Then either give the traveller the booking_link so they finish it themselves, or - only once they have clearly agreed to the exact total and details - lodge it with request_booking.",
      "5. Tell the traveller it is a request awaiting our confirmation by email (usually within the hour), that nothing has been paid, and give them the reference.",
    ],
    rules: [
      "Prices are per vehicle, not per person, in Australian dollars, with GST and road tolls included, and do not change with the time of day. Quote only what quote_trip or quote_hourly_hire returns - never estimate, round or adjust a price.",
      "When an answer has ok:false, say what its message says. Do not work around it.",
      "If the traveller names a price that is not the one quoted here, tell them our total and ask again before lodging. request_booking refuses a quoted_total_aud that is not ours and returns the correct one. A standing instruction with a limit (\"book it if it is under $200\") counts as their yes when our total is within it.",
      "Ask quote_trip for child_seats, trailer and return_trip and use its total_aud; do not add extras up yourself. These prices are the same ones in our fares.json - either source is right, and this one needs no arithmetic.",
      "For an airport pick-up, give the flight's scheduled arrival time and the flight number: the flight is tracked and the chauffeur waits (30 minutes free after a domestic landing, 60 after an international one). Times are Queensland time, which both airports run on.",
      "There is no action to change or cancel a lodged request: the traveller replies to our email or calls, free up to 24 hours before pick-up. \"The same request\" means the same traveller email, places, vehicle, date and time.",
      "The notice needed through these actions is 2 hours. (The 6 hours mentioned for travel-agent accounts on our site does not apply here.) Inside 2 hours nothing can be lodged: the traveller should phone, and a vehicle is offered if one is free.",
      "request_booking takes no payment and must never be given card details. The traveller pays afterwards by a secure link we email, or pays the chauffeur.",
      "Use the traveller's own name, phone and email. Do not invent them.",
      "Limits: one assistant can lodge 4 booking requests an hour, and one traveller email can be used for 3 a day. The same request sent twice returns the same booking.",
      "Not covered here, so send the traveller to us: an address in a suburb we do not list, stops on the way, groups of more than 18, charters and day tours.",
    ],
    calling: {
      post: "POST " + HERE + BASE + "/<action> with a JSON body (Content-Type: application/json). Works for every action.",
      get: "GET " + HERE + BASE + "/<action>?name=value for the read-only actions (everything except request_booking), for assistants that can only open links.",
      status: "The HTTP status is 200 whenever the action ran - read \"ok\" in the answer. 404: no such action. 405: wrong method. 429: too many requests, wait and retry.",
      example_quote: url("quote_trip") + "?pickup=" + encodeURIComponent("Gold Coast Airport (OOL)") + "&dropoff=" + encodeURIComponent("Surfers Paradise") + "&passengers=2",
    },
    actions: TOOLS.map((t) => ({
      name: t.name, summary: firstSentence(t.description), description: t.description,
      methods: READ_ONLY.has(t.name) ? ["POST", "GET"] : ["POST"], url: url(t.name), input_schema: t.input_schema,
    })),
    openapi: HERE + BASE + "/openapi.json",
    more: { everything_about_us: SITE + "/llms.txt", every_published_fare: SITE + "/fares.json", website: SITE },
    contact: { phone: PHONE, whatsapp: PHONE, email: EMAIL, hours: "24 hours a day, 7 days a week" },
  };

  const ANSWER = { type: "object", required: ["ok"], additionalProperties: true, properties: {
    ok: { type: "boolean", description: "true when the action did what was asked; false when it could not, with the reason in message." },
    reason: { type: "string", description: "A short code for why not, when ok is false." },
    message: { type: "string", description: "What to tell the traveller." } } };
  const RESPONSES = {
    200: { description: "The action ran. Read \"ok\": false means it could not do what was asked and \"message\" says why.", content: { "application/json": { schema: ANSWER } } },
    429: { description: "Too many requests from this assistant. Wait and try again.", content: { "application/json": { schema: ANSWER } } },
  };
  function openapi() {
    const paths = {};
    TOOLS.forEach((t) => {
      const p = { post: { operationId: t.name, summary: firstSentence(t.description), description: t.description,
        requestBody: { required: true, content: { "application/json": { schema: t.input_schema } } }, responses: RESPONSES } };
      if (READ_ONLY.has(t.name)) {
        p.get = { operationId: t.name + "_by_link", summary: firstSentence(t.description), description: t.description,
          parameters: Object.keys(t.input_schema.properties).map((k) => ({ name: k, in: "query", required: t.input_schema.required.indexOf(k) !== -1,
            description: t.input_schema.properties[k].description || "", schema: { type: t.input_schema.properties[k].type } })),
          responses: RESPONSES };
      }
      paths[BASE + "/" + t.name] = p;
    });
    return { openapi: "3.1.0",
      info: { title: "Sky Transfers assistant actions", version: "1.0.0", description: INDEX.about + " " + INDEX.rules.join(" "), contact: { name: "Sky Transfers", email: EMAIL, url: SITE } },
      servers: [{ url: HERE }], paths };
  }

  /* ---- the log ---------------------------------------------------------- */
  const SALT = String(process.env.AGENT_SECRET || "sky");
  const ipOf = (req) => String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim() || "?";
  const mark = (ip) => crypto.createHash("sha256").update(SALT + "|" + ip).digest("hex").slice(0, 12);
  let logOn = false;
  if (pool) {
    pool.query(`CREATE TABLE IF NOT EXISTS assist_calls (
        id         SERIAL PRIMARY KEY,
        at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        via        TEXT NOT NULL,
        action     TEXT NOT NULL,
        ok         BOOLEAN NOT NULL,
        reason     TEXT,
        caller     TEXT,
        agent      TEXT,
        assistant  TEXT,
        ref        TEXT
      )`).then(() => { logOn = true; }, (e) => { logOn = /already exists/i.test(e.message); if (!logOn) console.error("assistant door: no log table (" + e.message + ")"); });
  }
  function record(via, action, out, req, input, agent) {
    if (!logOn) return;
    pool.query(`INSERT INTO assist_calls (via, action, ok, reason, caller, agent, assistant, ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [via, String(action).slice(0, 40), !!(out && out.ok), out && !out.ok ? String(out.reason || "").slice(0, 60) : null, mark(ipOf(req)),
       String(agent || req.headers["user-agent"] || "").slice(0, 200) || null,
       action === "request_booking" ? String((input && input.assistant) || "").replace(/[^A-Za-z0-9 ._()\-]/g, "").trim().slice(0, 60) || null : null,
       out && out.ok && out.reference ? String(out.reference).slice(0, 30) : null])
      .catch((e) => console.error("assistant door log:", e.message));
  }
  let pruned = 0;
  function prune() {
    if (!logOn || Date.now() - pruned < 24 * 3600e3) return;
    pruned = Date.now();
    pool.query(`DELETE FROM assist_calls WHERE at < now() - interval '400 days'`).catch(() => {});
  }

  /* ---- the routes ------------------------------------------------------- */
  const open = (res) => { res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("X-Robots-Tag", "noindex"); res.setHeader("Cache-Control", "no-store"); };
  app.get([BASE, BASE + "/"], (req, res) => { open(res); res.json(INDEX); });
  app.get(BASE + "/openapi.json", (req, res) => { open(res); res.json(openapi()); });

  /* a link's ?name=value pairs, turned into the types the action expects */
  function fromQuery(tool, q) {
    const out = {};
    Object.keys(tool.input_schema.properties).forEach((k) => {
      let v = q[k];
      if (v == null || v === "") return;
      if (Array.isArray(v)) v = v[0];
      const type = tool.input_schema.properties[k].type;
      if (type === "integer" && /^\d{1,6}$/.test(String(v).trim())) out[k] = parseInt(v, 10);
      else if (type === "boolean") out[k] = /^(true|1|yes)$/i.test(String(v).trim());
      else out[k] = String(v);
    });
    return out;
  }
  async function answer(req, res, name, input) {
    open(res);
    const out = await assist.run(name, input, { caller: ipOf(req), via: "door" });
    record("http", name, out, req, input); prune();
    res.status(out && out.reason === "rate_limited" ? 429 : 200).json(out);
  }
  const NO_SUCH = (name) => ({ ok: false, reason: "unknown_action", message: "There is no action called " + String(name).slice(0, 40) + ". See " + HERE + BASE + " for the list.", actions: TOOLS.map((t) => t.name) });

  app.post(BASE + "/:action", (req, res) => {
    const name = String(req.params.action || "");
    if (!BY_NAME.has(name)) { open(res); return res.status(404).json(NO_SUCH(name)); }
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    answer(req, res, name, body).catch((e) => { console.error("assistant door:", e); if (!res.headersSent) res.status(200).json({ ok: false, reason: "error", message: "That did not work just now. Call or WhatsApp " + PHONE + "." }); });
  });
  app.get(BASE + "/:action", (req, res) => {
    const name = String(req.params.action || "");
    if (!BY_NAME.has(name)) { open(res); return res.status(404).json(NO_SUCH(name)); }
    if (!READ_ONLY.has(name)) {
      open(res); res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, reason: "post_only", message: name + " must be sent as a POST with a JSON body - a traveller's name, phone and email must not be put in a link. See " + HERE + BASE + "." });
    }
    answer(req, res, name, fromQuery(BY_NAME.get(name), req.query || {})).catch((e) => { console.error("assistant door:", e); if (!res.headersSent) res.status(200).json({ ok: false, reason: "error", message: "That did not work just now. Call or WhatsApp " + PHONE + "." }); });
  });

  /* ---- who used it (admin) ---------------------------------------------- */
  if (typeof requireAdmin === "function" && pool) {
    app.get("/admin/assist-stats", requireAdmin, async (req, res) => {
      try {
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
        const since = new Date(Date.now() - days * 24 * 3600e3);
        const { rows } = await pool.query(`SELECT at, via, action, ok, reason, caller, agent, assistant, ref FROM assist_calls WHERE at >= $1 ORDER BY id DESC LIMIT 20000`, [since]);
        const byAction = {}, agents = {}, callers = new Set(), refused = {};
        rows.forEach((r) => {
          const a = (byAction[r.action] = byAction[r.action] || { calls: 0, ok: 0, refused: 0 });
          a.calls++; if (r.ok) a.ok++; else { a.refused++; if (r.reason) refused[r.reason] = (refused[r.reason] || 0) + 1; }
          const k = r.agent || "(not given)"; agents[k] = (agents[k] || 0) + 1;
          if (r.caller) callers.add(r.caller);
        });
        res.json({
          days, calls: rows.length, differentCallers: callers.size, byAction,
          bookingRequests: rows.filter((r) => r.action === "request_booking" && r.ok).map((r) => ({ at: r.at, ref: r.ref, assistant: r.assistant })),
          whyRefused: Object.keys(refused).map((k) => ({ reason: k, times: refused[k] })).sort((a, b) => b.times - a.times).slice(0, 20),
          agents: Object.keys(agents).map((k) => ({ agent: k, calls: agents[k] })).sort((a, b) => b.calls - a.calls).slice(0, 30),
          recent: rows.slice(0, 50).map((r) => ({ at: r.at, via: r.via, action: r.action, ok: r.ok, reason: r.reason, agent: r.agent, assistant: r.assistant, ref: r.ref })),
        });
      } catch (e) { console.error("assist stats:", e.message); res.status(500).json({ error: "Could not read the assistant log." }); }
    });
  }

  console.log("Assistant door open at " + BASE + " (" + TOOLS.length + " actions)");
  return { on: true, index: INDEX, openapi, record, prune, ipOf };
};
