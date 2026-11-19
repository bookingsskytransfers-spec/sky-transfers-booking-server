/* ---------------------------------------------------------------------------
 * The MCP connection (stage 2b of the AI assistant, 19 Nov 2026).
 *
 * The same six actions as the plain door (assist-door.js), offered the way
 * assistants such as Claude and ChatGPT connect to an outside service: the
 * Model Context Protocol, over its "Streamable HTTP" transport.
 *
 *   POST /mcp     one JSON-RPC message per request, one JSON answer back
 *   GET, DELETE   405 - there are no sessions and no open stream to hold
 *
 * It has no rules of its own. A tool call is handed to assist-tools.js exactly
 * as the door hands it over, with the same limits, and is written to the same
 * log (via "mcp").
 *
 * Two generations of the protocol are answered on the one address:
 *   - 2026-07-28 ("modern"): no handshake. Every request names its protocol
 *     version in params._meta and repeats it, with the method (and the tool
 *     name), in HTTP headers; the server checks they agree. server/discover,
 *     tools/list, tools/call.
 *   - 2025-11-25 and earlier ("legacy"): initialize first, then tools/list and
 *     tools/call. No session id is issued - nothing is remembered between
 *     requests, so none is needed.
 * Which one a request is, is read from the request itself.
 *
 * Mounted in a try/catch from stripe-server.js: if it throws on boot one line
 * is logged and bookings, and the plain door, carry on.
 * ------------------------------------------------------------------------ */
module.exports = function installAssistMcp(ctx) {
  const { app, assist, door } = ctx;
  if (!app || !assist || !assist.on || typeof assist.run !== "function") { console.log("MCP connection off (the actions are not mounted)"); return { on: false }; }
  const PATH = "/mcp";
  const HERE = String(ctx.publicBase || process.env.PUBLIC_SERVER_URL || "https://sky-transfers-booking-server.onrender.com").replace(/\/+$/, "");
  const SITE = "https://www.skytransfers.com.au", PHONE = "+61 481 437 772", EMAIL = "info@skytransfers.com.au";
  const NS = "io.modelcontextprotocol/";
  const MODERN = ["2026-07-28"];
  const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
  const SUPPORTED = MODERN.concat(LEGACY);
  const SERVER = { name: "sky-transfers", title: "Sky Transfers", version: "1.0.0",
    description: "Fixed-price private transfers and chauffeur hire on the Gold Coast and across South East Queensland: quote a trip and lodge a pay-later booking request.",
    websiteUrl: SITE };

  /* ---- the six actions, described the MCP way --------------------------- */
  const TITLES = { find_places: "Find a place", quote_trip: "Quote a transfer", quote_hourly_hire: "Quote hire by the hour",
    check_pickup_time: "Check a pick-up time", booking_link: "Make a booking link", request_booking: "Lodge a booking request" };
  const TOOLS = assist.TOOLS.map((t) => {
    const reads = t.name !== "request_booking", title = TITLES[t.name] || t.name;
    /* request_booking changes something (it emails the office and the traveller) and never destroys
       anything. It is NOT marked safe to repeat: the same request sent twice is normally one booking,
       but that memory does not survive a restart, so a program must not retry it on its own. */
    return { name: t.name, title, description: t.description, inputSchema: t.input_schema,
      annotations: { title, readOnlyHint: reads, destructiveHint: false, idempotentHint: reads, openWorldHint: !reads } };
  });
  const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

  /* the notice period is the actions' to state; read it from the description they give */
  const tCheck = assist.TOOLS.find((t) => t.name === "check_pickup_time");
  const NOTICE = (/need (\d+) hours' notice/.exec((tCheck && tCheck.description) || "") || [0, "2"])[1];
  /* Kept short on purpose: some assistants cut long instructions off, and the detail is in each tool's description. */
  const INSTRUCTIONS = [
    "Sky Transfers: pre-booked private transfers and chauffeur hire on the Gold Coast, Brisbane, Sunshine Coast, Toowoomba and Byron Bay - airport, cruise and point-to-point - in our own vehicles from a sedan to an 18-seat Mercedes Sprinter.",
    "Order of use: find_places (our exact place name) -> quote_trip or quote_hourly_hire (the fixed price for every vehicle) -> check_pickup_time (" + NOTICE + " hours' notice, Brisbane time, UTC+10 all year) -> booking_link for the traveller to finish it themselves, or request_booking once they have clearly agreed to the exact total and details.",
    "Prices are per vehicle, not per person, in Australian dollars with GST and tolls included, the same at any hour. Quote only what the tools return - never estimate, round or add extras up yourself: pass child_seats, trailer and return_trip and use total_aud.",
    "When a result says ok:false, tell the traveller what its message says and do not work around it.",
    "request_booking lodges a request, not a confirmed booking: nothing is paid, we confirm by email (usually within the hour), and the traveller should be given the reference. Never ask for or send card details. Use the traveller's own name, phone and email.",
    "For an airport pick-up give the flight's scheduled arrival time and the flight number; the flight is tracked. To change or cancel, the traveller replies to our email or calls.",
    "Not covered here, so send the traveller to us: a suburb we do not list, stops on the way, groups of more than 18, charters and day tours. Phone or WhatsApp " + PHONE + ", " + EMAIL + ", 24 hours a day.",
  ].join("\n");

  /* ---- small helpers ---------------------------------------------------- */
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const head = (req, n) => { const v = req.headers[n]; return v == null ? undefined : String(Array.isArray(v) ? v[0] : v).trim(); };
  const ipOf = (door && door.ipOf) || ((req) => String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim() || "?");
  /* text from a caller, made safe to print: anything that is not text or a number becomes "" */
  const plain = (s, n) => (typeof s === "string" || typeof s === "number" ? String(s) : "").replace(/[^\x20-\x7E]/g, "").trim().slice(0, n);
  function rpcError(id, code, message, data) {
    const e = { jsonrpc: "2.0", error: { code, message } };
    if (id !== undefined) e.id = id;
    if (data !== undefined) e.error.data = data;
    return e;
  }
  function send(res, status, body) {
    res.status(status); res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Robots-Tag", "noindex");
    if (body === undefined) return res.end();
    res.json(body);
  }
  /* A header value may be carried as =?base64?...?= when it is not plain ASCII */
  function unwrap(v) {
    const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
    if (!m) return v;
    try { return Buffer.from(m[1], "base64").toString("utf8"); } catch (e) { return v; }
  }

  /* A browser page says where it came from. Pages served securely, and tools on this
     computer, may call; anything else that names an origin may not. A program that is
     not a browser (which is how assistants connect) sends no Origin at all. */
  const EXTRA_ORIGINS = String(process.env.MCP_ALLOW_ORIGINS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  function originOk(o) {
    if (o == null || o === "") return true;
    const s = String(o).trim().toLowerCase();
    if (EXTRA_ORIGINS.indexOf("*") !== -1 || EXTRA_ORIGINS.indexOf(s) !== -1) return true;
    let u; try { u = new URL(s); } catch (e) { return false; }
    if (u.origin !== s) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  }
  let refusedOrigins = 0;

  /* "connected" and "listed the tools" are noted for the usage summary, but one caller cannot fill the log with them */
  const noted = new Map();
  function mayNote(req) {
    const now = Date.now(), k = ipOf(req), e = noted.get(k);
    if (!e || now - e.t > 3600e3) { if (noted.size > 5000) noted.clear(); noted.set(k, { t: now, n: 1 }); return true; }
    return ++e.n <= 30;
  }
  function log(action, out, req, input, agent) {
    if (action.charAt(0) === "(" && !mayNote(req)) return;
    if (door && typeof door.record === "function") { try { door.record("mcp", action, out, req, input, agent); if (door.prune) door.prune(); } catch (e) { /* the log never stops an answer */ } }
  }
  function agentOf(req, info) {
    const n = isObj(info) ? plain(info.name, 80) : "";
    if (!n) return undefined;
    const v = plain(info.version, 30);
    return n + (v ? "/" + v : "");
  }

  /* ---- what each method answers ----------------------------------------- */
  const stamp = (modern, result) => modern ? Object.assign({ resultType: "complete" }, result, { _meta: { [NS + "serverInfo"]: SERVER } }) : result;
  const cached = (modern, result) => modern ? Object.assign(result, { ttlMs: 3600000, cacheScope: "public" }) : result;

  function listTools(id, params, modern) {
    if (params.cursor != null && params.cursor !== "") return { status: 200, body: rpcError(id, -32602, "Invalid cursor: the tool list is a single page.") };
    return { status: 200, body: { jsonrpc: "2.0", id, result: stamp(modern, cached(modern, { tools: TOOLS })) } };
  }
  async function callTool(id, params, modern, req, agent) {
    const name = params.name;
    if (typeof name !== "string" || !BY_NAME.has(name)) return { status: 200, body: rpcError(id, -32602, "Unknown tool: " + plain(name, 60)) };
    const args = params.arguments == null ? {} : params.arguments;
    if (!isObj(args)) return { status: 200, body: rpcError(id, -32602, "Invalid params: arguments must be an object.") };
    const out = await assist.run(name, args, { caller: ipOf(req), via: "mcp" });
    log(name, out, req, args, agent);
    /* A refusal ("that pick-up is too soon, please call") is marked isError so the assistant
       reads the message and corrects itself; the message is what it should tell the traveller. */
    return { status: 200, body: { jsonrpc: "2.0", id, result: stamp(modern, {
      content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: !(out && out.ok === true) }) } };
  }

  async function handle(req, res) {
    if (!originOk(req.headers.origin)) {
      if (refusedOrigins++ < 20) console.log("MCP: refused a request from origin " + plain(req.headers.origin, 100));
      return send(res, 403, rpcError(undefined, -32600, "Origin not allowed."));
    }
    const m = req.body;
    if (Array.isArray(m)) return send(res, 400, rpcError(undefined, -32600, "Invalid Request: send one JSON-RPC message per POST (batches are not supported)."));
    if (!isObj(m) || m.jsonrpc !== "2.0") return send(res, 400, rpcError(undefined, -32600, "Invalid Request: the body must be one JSON-RPC 2.0 message sent as application/json."));
    if (typeof m.method !== "string") {
      /* a reply to something we never asked: accepted and ignored, as the older revisions expect */
      if (has(m, "result") || has(m, "error")) return send(res, 202);
      return send(res, 400, rpcError(undefined, -32600, "Invalid Request: no method."));
    }
    if (!has(m, "id")) return send(res, 202);                      /* a notification: nothing to answer */
    const id = m.id, method = m.method;
    if (!(typeof id === "string" || (typeof id === "number" && Number.isFinite(id)))) return send(res, 400, rpcError(undefined, -32600, "Invalid Request: id must be a string or a number."));
    if (m.params != null && !isObj(m.params)) return send(res, 400, rpcError(id, -32602, "Invalid params: params must be an object."));
    const params = m.params || {};
    const meta = isObj(params._meta) ? params._meta : {};
    const hv = head(req, "mcp-protocol-version");
    const KEY = NS + "protocolVersion";
    if (has(meta, KEY) && typeof meta[KEY] !== "string") return send(res, 400, rpcError(id, -32602, "Invalid params: _meta." + KEY + " must be a string."));
    const bv = meta[KEY];
    const unsupported = (v) => send(res, 400, rpcError(id, -32022, "Unsupported protocol version", { supported: SUPPORTED, requested: plain(v, 40) }));
    const newer = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= MODERN[MODERN.length - 1];

    /* ---- which generation is this request? ---- */
    let modern;
    if (method === "initialize") modern = false;
    else if (bv !== undefined && hv !== undefined && hv !== bv) return send(res, 400, rpcError(id, -32020, "Header mismatch: MCP-Protocol-Version header value '" + plain(hv, 40) + "' does not match body value '" + plain(bv, 40) + "'"));
    else if (bv !== undefined && LEGACY.indexOf(bv) === -1) modern = true;
    else if (bv === undefined && hv !== undefined && newer(hv)) return send(res, 400, rpcError(id, -32602, "Invalid params: every request must carry _meta." + KEY + " (and _meta." + NS + "clientCapabilities)."));
    else if (hv === undefined || LEGACY.indexOf(hv) !== -1) modern = false;
    else return unsupported(hv);

    if (modern) {
      if (hv === undefined) return send(res, 400, rpcError(id, -32020, "Header mismatch: the MCP-Protocol-Version header is required."));
      if (hv !== bv) return send(res, 400, rpcError(id, -32020, "Header mismatch: MCP-Protocol-Version header value '" + plain(hv, 40) + "' does not match body value '" + plain(bv, 40) + "'"));
      if (MODERN.indexOf(bv) === -1) return unsupported(bv);
      const hm = head(req, "mcp-method");
      if (hm === undefined) return send(res, 400, rpcError(id, -32020, "Header mismatch: the Mcp-Method header is required."));
      if (hm !== method) return send(res, 400, rpcError(id, -32020, "Header mismatch: Mcp-Method header value '" + plain(hm, 60) + "' does not match body value '" + plain(method, 60) + "'"));
      if (!isObj(meta[NS + "clientCapabilities"])) return send(res, 400, rpcError(id, -32602, "Invalid params: every request must carry _meta." + NS + "clientCapabilities (an object, which may be empty)."));
      const agent = agentOf(req, meta[NS + "clientInfo"]);
      if (method === "server/discover") {
        log("(connect)", { ok: true }, req, null, agent);
        return send(res, 200, { jsonrpc: "2.0", id, result: stamp(true, cached(true, { supportedVersions: SUPPORTED, capabilities: { tools: {} }, instructions: INSTRUCTIONS })) });
      }
      if (method === "tools/list") { log("(list)", { ok: true }, req, null, agent); const a = listTools(id, params, true); return send(res, a.status, a.body); }
      if (method === "tools/call") {
        const hn = head(req, "mcp-name");
        if (hn === undefined) return send(res, 400, rpcError(id, -32020, "Header mismatch: the Mcp-Name header is required for tools/call."));
        if (typeof params.name !== "string") return send(res, 400, rpcError(id, -32602, "Invalid params: name (the tool to call) is required."));
        if (unwrap(hn) !== params.name) return send(res, 400, rpcError(id, -32020, "Header mismatch: Mcp-Name header value '" + plain(unwrap(hn), 60) + "' does not match body value '" + plain(params.name, 60) + "'"));
        const a = await callTool(id, params, true, req, agent); return send(res, a.status, a.body);
      }
      return send(res, 404, rpcError(id, -32601, "Method not found: " + plain(method, 60)));
    }

    /* ---- the handshake generation ---- */
    if (method === "initialize") {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      log("(connect)", { ok: true }, req, null, agentOf(req, params.clientInfo));
      return send(res, 200, { jsonrpc: "2.0", id, result: {
        protocolVersion: LEGACY.indexOf(asked) !== -1 ? asked : LEGACY[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS } });
    }
    if (method === "ping") return send(res, 200, { jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") { log("(list)", { ok: true }, req, null); const a = listTools(id, params, false); return send(res, a.status, a.body); }
    if (method === "tools/call") { const a = await callTool(id, params, false, req); return send(res, a.status, a.body); }
    return send(res, 200, rpcError(id, -32601, "Method not found: " + plain(method, 60)));
  }

  /* ---- the routes ------------------------------------------------------- */
  app.post(PATH, (req, res) => {
    handle(req, res).catch((e) => {
      console.error("MCP:", e);
      if (!res.headersSent) send(res, 500, rpcError(isObj(req.body) && (typeof req.body.id === "string" || typeof req.body.id === "number") ? req.body.id : undefined, -32603, "Internal error. Call or WhatsApp " + PHONE + "."));
    });
  });
  app.all(PATH, (req, res) => {
    res.setHeader("Allow", "POST");
    send(res, 405, rpcError(undefined, -32600, "This is the Sky Transfers MCP endpoint. It answers POST only: one JSON-RPC message per request, no sessions and no event stream. A plain description of the same actions is at " + HERE + "/assist/v1"));
  });
  /* a body that is not JSON never reaches the route: answer it in kind */
  app.use((err, req, res, next) => {
    if (!/^\/mcp\/?$/i.test(req.path) || res.headersSent) return next(err);
    const type = String((err && err.type) || "");
    if (type === "entity.too.large") return send(res, 413, rpcError(undefined, -32600, "Invalid Request: the body is too large."));
    if (type === "entity.parse.failed") return send(res, 400, rpcError(undefined, -32700, "Parse error: the body is not valid JSON."));
    const st = err && err.status >= 400 && err.status < 500 ? err.status : 400;
    send(res, st, rpcError(undefined, -32600, "Invalid Request: the body could not be read (send UTF-8 JSON, not compressed)."));
  });

  /* the plain door's index says where this is */
  if (door && door.index) {
    door.index.mcp = { url: HERE + PATH, transport: "Streamable HTTP: POST one JSON-RPC message per request, JSON answers, no sessions, no key.",
      protocol_versions: SUPPORTED, note: "The same six actions, as tools, for assistants that connect over the Model Context Protocol." };
  }

  console.log("MCP connection open at " + PATH + " (" + TOOLS.length + " tools; protocol " + SUPPORTED.join(", ") + ")");
  return { on: true, path: PATH, tools: TOOLS, supported: SUPPORTED, instructions: INSTRUCTIONS };
};
