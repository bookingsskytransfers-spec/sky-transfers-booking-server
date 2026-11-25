/* Bank details on a guest's confirmation (26 Nov 2026, Aman: "it goes with a
   payment link - it should also have bank details if someone wants to do a
   bank transfer").

   The details are the office's to set, never written in code: this reads the
   same Render setting the invoices already use (INVOICE_BANK_DETAILS - one
   line with a middle dot, "|" or ";" between the parts, or real line breaks). With
   it unset nothing is added anywhere.

   They are offered beside any payment link - for the whole fare, a deposit,
   or a balance - because the office can record each of them arriving another
   way from the admin page (Paid another way / Deposit paid another way /
   Balance paid another way). The amount shown is always the amount that
   link asks for. */
const RAW = String(process.env.INVOICE_BANK_DETAILS || "").trim();
const DOT = String.fromCharCode(183);   /* the middle dot, kept out of the source so this file stays plain ASCII */
const LINES = RAW.replace(/\\n/g, "\n").split(new RegExp("\\r?\\n|\\s+[" + DOT + "|]\\s+|\\s*;\\s*")).map((s) => s.trim()).filter(Boolean);
const NOTE = "Please reply to this email with your transfer receipt so we can match it to your booking. " +
  "A transfer can take a day or two to reach us, so for travel in the next 2 days please pay by card.";
const escHtml = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* What the guest would transfer, in whole dollars, for a summary that goes out
   with a payment link, and what to call it: the deposit while that is what is
   due, the balance if one is owing, otherwise the total. 0 means "do not
   offer it" - there is nothing to pay. */
function amountFor(s, paid) {
  if (!s) return 0;
  if (s.depositDue > 0 && !paid) return s.depositDue;
  if (s.balance > 0) return s.balance;
  return paid ? 0 : Number(s.total) || 0;
}
function labelFor(s, paid) {
  if (!s) return "";
  if (s.depositDue > 0 && !paid) return "deposit";
  if (s.balance > 0) return "balance";
  return "";
}

/* A plain-text paragraph (ends with a blank line), or "" when not offered. */
function text(amount, ref, label) {
  if (!LINES.length || !(amount > 0) || !ref) return "";
  return `Prefer to pay by bank transfer?\n${LINES.join("\n")}\nAmount: $${amount}${label ? ` (${label})` : ""}\nReference: ${ref}\n${NOTE}\n\n`;
}

/* The same as one table row for the branded confirmation, or "". */
function htmlRow(amount, ref, label) {
  if (!LINES.length || !(amount > 0) || !ref) return "";
  return `<tr><td style="padding:14px 28px 2px;">
      <div style="background:#F7F4ED;border:1px solid #E5E0D2;border-radius:9px;padding:12px 16px;font:400 13.5px/1.7 Arial,sans-serif;color:#333B4C;">
        <div style="font:700 10px Arial,sans-serif;letter-spacing:1.5px;color:#68707F;padding-bottom:4px;">OR PAY BY BANK TRANSFER</div>
        ${LINES.map(escHtml).join("<br>")}<br>
        <strong>Amount:</strong> $${escHtml(amount)}${label ? ` (${escHtml(label)})` : ""} &nbsp;&middot;&nbsp; <strong>Reference:</strong> ${escHtml(ref)}
        <div style="font-size:12.5px;line-height:1.55;color:#68707F;padding-top:6px;">${escHtml(NOTE)}</div>
      </div>
    </td></tr>`;
}

/* For a booking summary: works out the amount and what to call it. */
const textFor = (s, paid, ref) => text(amountFor(s, paid), ref, labelFor(s, paid));
const htmlRowFor = (s, paid, ref) => htmlRow(amountFor(s, paid), ref, labelFor(s, paid));

module.exports = { lines: LINES, amountFor, labelFor, text, htmlRow, textFor, htmlRowFor };
