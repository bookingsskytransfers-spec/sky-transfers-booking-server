/* ---------------------------------------------------------------------------
 * WhatsApp Business Platform (Cloud API) sender - template messages only.
 *
 * OFF until both Render env vars are set:
 *   WA_TOKEN            a permanent System User access token
 *   WA_PHONE_NUMBER_ID  the Cloud API phone number id (not the number itself)
 * Optional: WA_API_VERSION (default v23.0), WA_TEMPLATE_LANG (default en).
 *
 * Aman chose (19 Oct 2026) to send from the existing +61 481 437 772 using
 * Meta's coexistence onboarding, so the WhatsApp Business app on his phone
 * keeps working. Meta business verification and template approval are his;
 * nothing here creates accounts. Until a template is approved under exactly
 * the name below, Meta refuses the send and the email still goes.
 *
 * Templates to submit in WhatsApp Manager (category: Utility, language
 * English). Meta does not allow a variable at the very start or end.
 * ------------------------------------------------------------------------ */
const TEMPLATES = {
  /* to the DRIVER, from "WhatsApp to driver" on the board (ops.js). Never the
     account or agency name. */
  sky_driver_job: {
    params: ["job reference", "date", "pick-up time", "from", "to", "details", "driver's job link"],
    body: "New Sky Transfers job {{1}} on {{2}} at {{3}}. From: {{4}}. To: {{5}}. Details: {{6}}. Accept and update the job here: {{7}} - reply here if you can't do it.",
  },
  sky_driver_assigned: {
    params: ["guest first name", "date and time", "driver first name", "car", "tracking link"],
    body: "Hi {{1}}, your Sky Transfers driver for {{2}} is {{3}}, in a {{4}}. Track your driver here: {{5}} - reply or call +61 481 437 772 to change anything.",
  },
  sky_driver_on_way: {
    params: ["guest first name", "driver first name", "pick-up place", "pick-up time", "tracking link"],
    body: "Hi {{1}}, {{2}} is on the way to {{3}} for your {{4}} pick-up. Track your driver here: {{5}} - Sky Transfers.",
  },
  sky_driver_arrived: {
    params: ["guest first name", "driver first name", "where to meet"],
    body: "Hi {{1}}, {{2}} has arrived. {{3}} Questions? Call +61 481 437 772 - Sky Transfers.",
  },
};

/* Australian mobile to the digits-only international form WhatsApp wants. */
function e164(phone) {
  let d = String(phone || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("0") && d.length === 10) d = "61" + d.slice(1);
  else if (d.startsWith("4") && d.length === 9) d = "61" + d;
  return /^\d{10,15}$/.test(d) ? d : null;
}

module.exports = function makeWhatsApp(opts) {
  const o = opts || {};
  const token = o.token != null ? o.token : process.env.WA_TOKEN;
  const phoneId = o.phoneId != null ? o.phoneId : process.env.WA_PHONE_NUMBER_ID;
  const ver = process.env.WA_API_VERSION || "v23.0";
  const lang = process.env.WA_TEMPLATE_LANG || "en";
  const doFetch = o.fetch || ((...a) => fetch(...a));
  const enabled = !!(token && phoneId);

  /* Never throws. {ok, id} or {ok:false, reason}. */
  async function sendTemplate(phone, name, params) {
    if (!enabled) return { ok: false, reason: "not_connected" };
    if (!TEMPLATES[name]) return { ok: false, reason: "unknown_template" };
    const to = e164(phone);
    if (!to) return { ok: false, reason: "bad_number" };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await doFetch(`https://graph.facebook.com/${ver}/${phoneId}/messages`, {
        method: "POST", signal: ctl.signal,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp", to, type: "template",
          template: { name, language: { code: lang },
            components: [{ type: "body", /* Meta refuses a parameter with a new line, a tab or 4+ spaces in a row */
            parameters: (params || []).map((t) => ({ type: "text", text: String(t == null ? "" : t).replace(/\s+/g, " ").trim().slice(0, 400) || "-" })) }] },
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, reason: "http_" + r.status + (j && j.error && j.error.code ? "_" + j.error.code : "") };
      return { ok: true, id: j && j.messages && j.messages[0] && j.messages[0].id };
    } catch (e) {
      return { ok: false, reason: e && e.name === "AbortError" ? "timeout" : "network" };
    } finally { clearTimeout(timer); }
  }

  return { enabled, sendTemplate, TEMPLATES, e164 };
};
module.exports.TEMPLATES = TEMPLATES;
module.exports.e164 = e164;
