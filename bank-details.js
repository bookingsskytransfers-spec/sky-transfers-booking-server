/* Bank details on a guest's confirmation (26 Nov 2026, Aman: "it goes with a
   payment link - it should also have bank details if someone wants to do a
   bank transfer").

   The details are the office's to set, never written in code: this reads the
   same Render setting the invoices already use (INVOICE_BANK_DETAILS - one
   line with a middle dot, "|" or ";" between the parts, or real line breaks). With
   it unset nothing is added anywhere.

   They are offered beside a payment link for the WHOLE fare or for a balance,
   because the office can already record both arriving another way (Paid
   another way / Balance paid on the admin page). They are not offered on a
   deposit request: there is no way yet to record a deposit that came by
   transfer while the balance is still owing. */
const RAW = String(process.env.INVOICE_BANK_DETAILS || "").trim();
const DOT = String.fromCharCode(183);   /* the middle dot, kept out of the source so this file stays plain ASCII */
const LINES = RAW.replace(/\\n/g, "\n").split(new RegExp("\\r?\\n|\\s+[" + DOT + "|]\\s+|\\s*;\\s*")).map((s) => s.trim()).filter(Boolean);
const NOTE = "Please reply to this email with your transfer receipt so we can match it to your booking. " +
  "A transfer can take a day or two to reach us, so for travel in the next 2 days please pay by card.";
const escHtml = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* What the guest would transfer, in whole dollars, for a summary that goes out
   with a payment link: the balance if one is owing, otherwise the total.
   0 means "do not offer it" - a deposit request, or nothing to pay. */
function amountFor(s, paid) {
  if (!s || s.depositDue) return 0;
  if (s.balance > 0) return s.balance;
  return paid ? 0 : Number(s.total) || 0;
}

/* A plain-text paragraph (ends with a blank line), or "" when not offered. */
function text(amount, ref) {
  if (!LINES.length || !(amount > 0) || !ref) return "";
  return `Prefer to pay by bank transfer?\n${LINES.join("\n")}\nAmount: $${amount}\nReference: ${ref}\n${NOTE}\n\n`;
}

/* The same as one table row for the branded confirmation, or "". */
function htmlRow(amount, ref) {
  if (!LINES.length || !(amount > 0) || !ref) return "";
  return `<tr><td style="padding:14px 28px 2px;">
      <div style="background:#F7F4ED;border:1px solid #E5E0D2;border-radius:9px;padding:12px 16px;font:400 13.5px/1.7 Arial,sans-serif;color:#333B4C;">
        <div style="font:700 10px Arial,sans-serif;letter-spacing:1.5px;color:#68707F;padding-bottom:4px;">OR PAY BY BANK TRANSFER</div>
        ${LINES.map(escHtml).join("<br>")}<br>
        <strong>Amount:</strong> $${escHtml(amount)} &nbsp;&middot;&nbsp; <strong>Reference:</strong> ${escHtml(ref)}
        <div style="font-size:12.5px;line-height:1.55;color:#68707F;padding-top:6px;">${escHtml(NOTE)}</div>
      </div>
    </td></tr>`;
}

module.exports = { lines: LINES, amountFor, text, htmlRow };
