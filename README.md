# Sky Transfers Booking Server

Booking + payment backend for the skytransfers.com.au booking widget.

- `POST /request-booking` — emails confirmation (with printable PDF) to the guest and to Sky Transfers
- `POST /create-checkout` — creates a Stripe Checkout session (fare re-computed server-side)
- `POST /stripe-webhook` — marks bookings paid after Stripe confirms payment

## Environment variables (set in Render — never commit secrets)

| Key | Purpose |
|---|---|
| `GMAIL_USER` | Gmail address that sends confirmations |
| `GMAIL_APP_PASSWORD` | Gmail App Password (secret) |
| `BOOKINGS_EMAIL` | Where business copies go (default info@skytransfers.com.au) |
| `STRIPE_SECRET_KEY` | Stripe secret key (secret) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (optional) |
| `SUCCESS_URL` | Redirect after payment |
| `CANCEL_URL` | Redirect if payment cancelled |
| `ALLOWED_ORIGIN` | Website origin for CORS |
| `ZAPIER_HOOK_URL` | Optional Zapier webhook |

Run: `npm install && npm start` (Node 18+).
