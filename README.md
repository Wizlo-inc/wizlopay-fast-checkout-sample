# WizloPay Fast Checkout Sample

A sample three-step checkout (details → checkout → confirmation with card-on-file upsells) built on
[gr4vy](https://docs.gr4vy.com) with a Node.js / Express / TypeScript backend, a plain HTML/CSS/JS
frontend and PostgreSQL.

## Checkout layout

```
┌ Express checkout ──────────────────────────────┐
│  [ Apple Pay ]   [ Google Pay ]   [ PayPal ]   │  ← wallet supplies the shipping address
└────────────────────────────────────────────────┘
                ── or pay another way ──
┌ Shipping address ──────────────────────────────┐
└────────────────────────────────────────────────┘
┌ Payment ───────────────────────────────────────┐
│  [ Cards ]  [ Buy Now, Pay Later ]             │
│   Cards: card number / expiry / CVV            │
│   BNPL:  Affirm · Klarna · PayPal Pay Later ·  │
│          Sezzle                                │
└────────────────────────────────────────────────┘
```

Only the methods that gr4vy returns from the
[payment options API](https://docs.gr4vy.com/guides/payments/direct-api/quick-start/payment-options)
for the order are shown, so Flow rules and connection setup in the gr4vy dashboard control what appears.

### How each method works

| Method | Integration | Shipping address |
|---|---|---|
| Card | [Secure Fields](https://docs.gr4vy.com/guides/payments/secure-fields/quick-start/overview) vaults the card into a checkout session; the server creates the transaction (`store: true`, hosted 3DS via `redirect_url`) | Shipping form |
| Affirm, Klarna, PayPal Pay Later, Sezzle | Server creates a redirect transaction → buyer approves at the provider → `/api/payment/return` | Shipping form (required up front for eligibility checks) |
| PayPal | Redirect transaction; buyer picks their address on PayPal | Imported by gr4vy from PayPal (see setup below) |
| Apple Pay | [Apple Pay JS](https://docs.gr4vy.com/guides/features/apple-pay/web-without-sdk) with gr4vy merchant validation | `requiredShippingContactFields` in the Apple Pay sheet |
| Google Pay | [Google Pay API](https://docs.gr4vy.com/guides/features/google-pay/web-without-sdk) with the `gr4vy` gateway | `shippingAddressRequired` in the Google Pay sheet |

Wallet shipping and billing addresses are saved on the order, attached to the gr4vy buyer as
shipping details, and copied into the shipping form so the buyer sees what was captured.

Card payments store the card on the gr4vy buyer, which the confirmation page's one-click upsells
charge as `card_on_file`.

## Requirements

- Node.js 20+
- PostgreSQL 14+
- A gr4vy instance with a private key, plus the connections you want to offer
- [ngrok](https://ngrok.com) (or another HTTPS tunnel) to test Apple Pay and Google Pay

## Setup

```bash
# 1. Database (macOS / Homebrew example)
brew install postgresql@16
brew services start postgresql@16
createdb checkout_db
psql -d checkout_db -f schema.sql

# 2. Environment
cp .env.example .env        # then fill in the gr4vy values

# 3. Run
cd backend
npm install
npm run dev                 # http://localhost:4000
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `GR4VY_ID` | yes | gr4vy instance ID |
| `GR4VY_ENVIRONMENT` | yes | `sandbox` or `production` |
| `GR4VY_PRIVATE_KEY` | yes | PEM private key on one line, newlines written as `\n` |
| `GR4VY_MERCHANT_ACCOUNT_ID` | multi-merchant instances | Passed to every gr4vy call |
| `GR4VY_WEBHOOK_SECRET` | for webhooks | Signing secret for `/api/webhooks` |
| `APP_URL` | no | Public base URL for redirect/3DS return URLs. Defaults to the request's host, which works behind ngrok |
| `APPLE_PAY_DOMAIN` | no | Domain sent for Apple Pay merchant validation. Defaults to the request hostname |
| `PORT` | no | Defaults to `4000` |

## Testing over HTTPS (Apple Pay / Google Pay)

Apple Pay never shows on plain `http://` pages, and Google Pay needs a real domain outside its TEST
mode. Use ngrok:

```bash
ngrok config add-authtoken <your-token>   # once
ngrok http 4000
```

The server trusts `X-Forwarded-*` headers, so redirect URLs and wallet domain validation use the
public `https://…ngrok…` host automatically.

On localhost, Google Pay runs in its TEST environment without a gr4vy session; on any other domain
the server fetches a session JWT from gr4vy for `merchantInfo`.

### gr4vy dashboard setup

- **Apple Pay:** under **Connections → Apple Pay → Domains**, register the exact host (for example your
  ngrok domain) and download the domain association file into
  `public/.well-known/apple-developer-merchantid-domain-association`. The server serves that folder.
- **PayPal shipping:** under **Connections → Configured → PayPal → Credentials**, enable
  **Import shipping details** (and optionally **Import billing details**). Without it, PayPal orders
  have no shipping address.
- **BNPL / wallets:** each method must have an active connection and must not be hidden by a Flow rule.

### Sandbox test data

- Card: `4111 1111 1111 1111`, any future expiry, any CVV
- Apple Pay: use an [Apple Pay sandbox test card](https://developer.apple.com/apple-pay/sandbox-testing/); real cards are rejected in sandbox
- Google Pay: Google's [test card suite](https://developers.google.com/pay/api/web/guides/resources/test-card-suite)

## API

| Route | Purpose |
|---|---|
| `POST /api/orders` | Create an order from the details form |
| `GET /api/orders/:id` | Order summary |
| `POST /api/payment/init` | Create a checkout session and list available card / BNPL / express methods |
| `POST /api/payment/card` | Charge the card vaulted by Secure Fields |
| `POST /api/payment/redirect` | Start Affirm, Klarna, PayPal Pay Later, Sezzle or PayPal |
| `GET /api/payment/return` | Return URL for redirects and 3DS; verifies the transaction and routes to confirmation |
| `POST /api/payment/applepay/session` | Apple Pay merchant validation through gr4vy |
| `POST /api/payment/googlepay/session` | Google Pay `merchantInfo` JWT (skipped on localhost) |
| `POST /api/payment/wallet` | Charge an Apple Pay / Google Pay token with the wallet's shipping address |
| `POST /api/upsell/charge` | Charge the stored card for an upsell product |
| `POST /api/webhooks` | gr4vy webhooks |

Each payment route returns one of `{ approvalUrl }` (send the buyer there), `{ redirect }` (payment
succeeded) or `{ error }`.

## Project layout

```
backend/src/
  index.ts           Express app, static files, /api/config
  gr4vy.ts           gr4vy SDK client
  routes/payment.ts  Checkout: cards, BNPL, PayPal, Apple Pay, Google Pay
  routes/orders.ts   Orders
  routes/upsell.ts   Card-on-file upsells
  routes/webhooks.ts Webhooks
public/
  index.html         Step 1: details and product
  checkout.html      Step 2: express checkout, shipping, payment tabs
  confirmation.html  Step 3: confirmation and upsells
schema.sql           Database schema
```

`GR4VY_INTEGRATION_GUIDE.md` documents the earlier gr4vy Embed integration and its gotchas.
