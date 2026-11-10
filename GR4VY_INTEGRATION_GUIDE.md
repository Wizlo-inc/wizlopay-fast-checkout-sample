---
title: "gr4vy Integration Guide"
description: "A developer reference for integrating gr4vy with Secure Fields and the direct API (cards, BNPL, PayPal, Apple Pay, Google Pay) and with gr4vy Embed, covering card-on-file upsells and common pitfalls."
version: "2.0.0"
date: "2026-11-10"
authors:
  - Wizlo Inc.
tags:
  - gr4vy
  - payments
  - embed
  - secure-fields
  - apple-pay
  - google-pay
  - paypal
  - bnpl
  - node.js
  - typescript
  - card-on-file
  - upsell
  - ecommerce
stack:
  backend: "Node.js / Express / TypeScript"
  frontend: "Plain HTML / CSS / JS"
  sdk: "@gr4vy/sdk v1.x"
  secure_fields: "secure-fields.js (CDN, latest)"
  embed: "embed.latest.js (CDN) — previous integration"
  database: "PostgreSQL"
metadata:
  checkout: "true"
  upsell: "true"
---

# gr4vy Integration Guide

A reference for developers integrating gr4vy with a Node.js/Express backend and plain JS frontend. Every nuance below was discovered through real implementation and debugging.

The guide has two parts:

- **Part 1 — gr4vy Embed** (§1–§13): the original integration. Embed renders every payment method as one list. §1, §2, §7–§11 and the error notes in §13 still apply to the current app.
- **Part 2 — Secure Fields + direct API** (§14–§21): what this app uses now. It gives full control of the layout: express wallets on top, then Cards and Buy Now, Pay Later tabs.

---

## Table of Contents

1. [Environment & Credentials](#1-environment--credentials)
2. [SDK Setup](#2-sdk-setup)
3. [JWT Embed Token](#3-jwt-embed-token)
4. [Checkout Session](#4-checkout-session)
5. [Embed Initialisation (`gr4vy.setup()`)](#5-embed-initialisation-gr4vysetup)
6. [Billing Address](#6-billing-address)
7. [Buyer Management](#7-buyer-management)
8. [Saving Payment Methods (`store`)](#8-saving-payment-methods-store)
9. [Upsell / Card-on-File Charges](#9-upsell--card-on-file-charges)
10. [Payment Source](#10-payment-source)
11. [Metadata](#11-metadata)
12. [CDN Script Loading](#12-cdn-script-loading)
13. [Common Errors & Fixes](#13-common-errors--fixes)

**Part 2 — Secure Fields + direct API**

14. [Architecture](#14-architecture)
15. [Payment Options](#15-payment-options)
16. [Secure Fields Card Form](#16-secure-fields-card-form)
17. [Card Validation & Error Messages](#17-card-validation--error-messages)
18. [Charging the Card](#18-charging-the-card)
19. [Redirect Methods: BNPL & PayPal](#19-redirect-methods-bnpl--paypal)
20. [Apple Pay & Google Pay](#20-apple-pay--google-pay)
21. [HTTPS, Domains & More Errors](#21-https-domains--more-errors)

---

# Part 1 — gr4vy Embed

## 1. Environment & Credentials

```env
GR4VY_ID=your-gr4vy-id
GR4VY_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----\nMHQC...\n-----END EC PRIVATE KEY-----"
GR4VY_ENVIRONMENT=sandbox           # or production
GR4VY_MERCHANT_ACCOUNT_ID=merchant-xxxxxxxx
APP_URL=https://your-domain.com     # used for redirect URLs in server-side transactions
```

**Key gotchas with `GR4VY_PRIVATE_KEY`:**

- If pasting a multi-line PEM into a `.env` file, use `\n` for newlines or quote the whole value.
- Some editors/shells add leading whitespace to lines, which corrupts the PEM. Strip it in code:

```typescript
function getPrivateKey(): string {
  const key = process.env.GR4VY_PRIVATE_KEY!;
  return key
    .replace(/\\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())   // ← critical — strips accidental indentation
    .join("\n");
}
```

---

## 2. SDK Setup

```typescript
import { Gr4vy, getEmbedToken, withToken } from "@gr4vy/sdk";

export function createGr4vyClient() {
  return new Gr4vy({
    server: process.env.GR4VY_ENVIRONMENT as "sandbox" | "production",
    id: process.env.GR4VY_ID!,
    bearerAuth: withToken({ privateKey: getPrivateKey() }),
  });
}

export function getMerchantAccountId(): string | undefined {
  return process.env.GR4VY_MERCHANT_ACCOUNT_ID || undefined;
}
```

**Pass `merchantAccountId` to every SDK call** — omitting it on any one call (session creation, transaction creation, buyer lookups, etc.) results in silent failures or wrong-account responses.

---

## 3. JWT Embed Token

The embed token is a signed ES512 JWT. Use `getEmbedToken()` from the SDK — do not craft it manually.

```typescript
import { getEmbedToken } from "@gr4vy/sdk";
import type { CartItem } from "@gr4vy/sdk/models/components/cartitem.js";

async function generateEmbedToken(params: {
  amount: number;
  currency: string;
  buyerExternalIdentifier: string;
  checkoutSessionId: string;
  cartItems?: CartItem[];
}) {
  return getEmbedToken({
    privateKey: getPrivateKey(),
    checkoutSessionId: params.checkoutSessionId,
    embedParams: {
      amount:                  params.amount,
      currency:                params.currency,
      buyerExternalIdentifier: params.buyerExternalIdentifier,
      cartItems:               params.cartItems,
      merchantAccountId:       getMerchantAccountId(),
    },
  });
}
```

### What goes in the JWT (`embedParams`) vs `gr4vy.setup()`

| Field | JWT `embedParams` | `gr4vy.setup()` |
|---|---|---|
| `amount` | ✅ Required | ✅ Required (must match JWT) |
| `currency` | ✅ Required | ✅ Required (must match JWT) |
| `buyerExternalIdentifier` | ✅ Required | ✅ Required (must match JWT) |
| `cartItems` | ✅ Include here | ✅ Must pass same array |
| `merchantAccountId` | ✅ Required | ✅ Required |
| `paymentSource` | ❌ Not supported | ✅ Frontend only |
| `buyer` (object) | ❌ Not supported | ✅ Frontend only |

> **Rule:** gr4vy validates that `cart_items`, `buyer_external_identifier`, and `merchant_account_id` in `gr4vy.setup()` exactly match what is encoded in the JWT. A mismatch produces a cryptic validation error.

---

## 4. Checkout Session

Create a checkout session **server-side** before generating the embed token. The session ID is included in the JWT.

```typescript
const gr4vy = createGr4vyClient();
const session = await gr4vy.checkoutSessions.create(undefined, merchantAccountId);
const checkoutSessionId = session.id as string;
```

Store `checkoutSessionId` on your order record — you'll need it to correlate with webhooks.

---

## 5. Embed Initialisation (`gr4vy.setup()`)

```javascript
embedInstance = gr4vy.setup({
  gr4vyId:            "your-gr4vy-id",
  environment:        "sandbox",          // or "production"
  merchantAccountId:  "merchant-xxxxxxxx",
  element:            "#gr4vy-embed",     // CSS selector for mount point
  token:              jwtToken,
  amount:             order.amount,       // integer cents
  currency:           "USD",
  country:            "US",
  store:              true,               // always store; "ask" prompts; false never stores
  paymentSource:      "ecommerce",
  cartItems:          cartItems,          // must match JWT exactly
  metadata:           { checkout: "true" },

  buyerExternalIdentifier: buyer.externalIdentifier,
  buyer: {
    displayName: "Jane Smith",
    billingDetails: {
      firstName:    "Jane",
      lastName:     "Smith",
      emailAddress: "jane@example.com",
      phoneNumber:  "+12025551234",
      address: {           // pre-fills the card form's billing address
        line1:      "123 Main St",
        city:       "New York",
        state:      "NY",
        postalCode: "10001",
        country:    "US",
      },
    },
  },

  onBeforeTransaction: async () => {
    // Fires just before gr4vy creates the transaction.
    // Use to sync data (e.g. update buyer billing details on your backend).
    // Return { shippingDetailsId } if you need to attach shipping details.
    return {};
  },

  onComplete: async (transaction) => {
    // Called when the transaction finishes (success or failure).
    console.log(transaction.id, transaction.status);
  },

  onEvent: (eventName, data) => {
    if (eventName === "optionsLoaded") {
      // Payment options have rendered — safe to show your Pay button.
    }
    if (eventName === "transactionFailed" || eventName === "argumentError") {
      // Re-enable your Pay button so the user can retry.
    }
  },
});
```

**Submit the embed from your own button:**

```javascript
function submitPayment() {
  if (!validateForm()) return;
  document.getElementById("pay-btn").disabled = true;
  embedInstance.submit();
}
```

---

## 6. Billing Address

### The problem

`gr4vy.setup()` accepts `buyer.billingDetails.address` to **pre-fill** the billing address fields inside the embedded card form. However, the embed initialises on page load before the user has filled in the address form on your page — so `address` is undefined and the card form has empty billing address fields.

### The solution — two-layer approach

**Layer 1 — Pre-fill at setup time:**  
`gr4vy.setup()` is called after an async token fetch (~1–2 s). Read the form at that moment; if the user has already autofilled, the address will be present.

```javascript
const addr = getAddressFromForm();
const billingAddress = addr.line1 ? { ...addr } : undefined;

gr4vy.setup({
  buyer: {
    billingDetails: {
      ...,
      ...(billingAddress ? { address: billingAddress } : {}),
    },
  },
  ...
});
```

**Layer 2 — Reinit when address is completed:**  
Watch the required address fields. The moment they all have values, tear down and remount the embed with the address included. This reinit happens before the user can interact with the payment form.

```javascript
let storedEmbedParams = null;  // saved after token fetch
let addressBaked = false;

function watchAddressFields() {
  ["addressLine1", "city", "postalCode"].forEach((id) => {
    const el = document.getElementById(id);
    ["input", "change", "blur"].forEach((ev) =>
      el.addEventListener(ev, maybeReinitEmbed)
    );
  });
}

function maybeReinitEmbed() {
  if (addressBaked || !storedEmbedParams || !embedInstance) return;
  if (!["addressLine1", "city", "postalCode"].every(
    (id) => document.getElementById(id).value.trim()
  )) return;

  addressBaked = true;
  document.getElementById("gr4vy-embed").innerHTML = "";
  embedInstance = null;
  document.getElementById("pay-btn").style.display = "none";

  setupEmbed(storedEmbedParams);  // re-runs gr4vy.setup() with filled address
}
```

**Layer 3 — Sync buyer record (`onBeforeTransaction`):**  
Update the buyer's stored billing details in gr4vy right before the transaction. This ensures subsequent server-side transactions (upsells) also carry the correct billing address.

```typescript
// POST /api/payment/billing-details
// 1. Look up buyer by externalIdentifier via gr4vy.buyers.list({ externalIdentifier })
// 2. Call gr4vy.buyers.update({ billingDetails: { address: ... } }, buyerId, merchantId)
```

```javascript
onBeforeTransaction: async () => {
  await fetch("/api/payment/billing-details", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, billingAddress: getAddressFromForm() }),
  });
  return {};
},
```

---

## 7. Buyer Management

gr4vy identifies buyers by `externalIdentifier` (typically the customer's email). The embed auto-creates/upserts buyers on first use.

**Looking up a buyer's gr4vy UUID by external identifier:**

```typescript
const buyerList = await gr4vy.buyers.list({
  externalIdentifier: "customer@example.com",
  limit: 1,
  merchantAccountId: merchantId,
});

let buyerId: string | null = null;
for await (const page of buyerList) {
  if (page.result?.items?.length) {
    buyerId = page.result.items[0].id as string;
  }
  break;
}
```

> Note: `buyers.list()` returns a `PageIterator`. Each page has `page.result.items`, not `page.items` directly.

**Updating buyer billing details:**

```typescript
await gr4vy.buyers.update(
  {
    billingDetails: {
      firstName: "Jane",
      lastName:  "Smith",
      address: {
        line1:      "123 Main St",
        city:       "New York",
        state:      "NY",
        postalCode: "10001",
        country:    "US",
      },
    },
  },
  buyerId,
  merchantId
);
```

---

## 8. Saving Payment Methods (`store`)

| Value | Behaviour |
|---|---|
| `true` | Always saves the payment method after checkout |
| `false` | Never saves — upsell flows will not be possible |
| `"ask"` | Shows a "Save my card" checkbox to the user |

For an ecommerce flow with upsell, use `store: true`. The saved payment method ID is returned on the transaction object (`transaction.paymentMethod.id`) and must be stored in your database for later use.

**Fetching the saved payment method ID after checkout:**

```typescript
// In your /payment/complete endpoint:
const tx = await gr4vy.transactions.get(transactionId, merchantAccountId);
const paymentMethodId = tx?.paymentMethod?.id ?? null;
// Store paymentMethodId against the order in your DB
```

---

## 9. Upsell / Card-on-File Charges

Use the stored `paymentMethodId` to charge the buyer without re-entering card details.

```typescript
const transaction = await gr4vy.transactions.create(
  {
    amount:    1999,          // integer cents
    currency:  "USD",
    intent:    "capture",
    paymentSource:    "card_on_file",
    isSubsequentPayment: true,
    externalIdentifier: `upsell-${upsellId}`,
    metadata:  { upsell: "true" },
    paymentMethod: {
      method: "id",
      id:     savedPaymentMethodId,
      redirectUrl: `${process.env.APP_URL}/confirmation.html?order_id=${orderId}`,
    },
  },
  merchantAccountId
);
```

**Why `redirectUrl` is required on server-side transactions:**  
Even for card-on-file charges, gr4vy requires a `redirectUrl` on the payment method object in case a 3DS challenge is triggered. Without it, the transaction fails with `missing_redirect_url`. The URL should return the user to a relevant page (e.g. the confirmation/upsell page).

---

## 10. Payment Source

| Context | Value |
|---|---|
| New card entered in Embed | `"ecommerce"` |
| Returning buyer using a stored card | `"card_on_file"` *(gr4vy sets this automatically)* |
| Server-side upsell charge | `"card_on_file"` |

> **Important:** Even if you pass `paymentSource: "ecommerce"` in `gr4vy.setup()`, when a returning buyer selects a previously stored card, gr4vy will record the transaction as `card_on_file`. This is correct behaviour — `payment_source` reflects how the payment method was obtained, not your intent label. Only first-time buyers entering a new card produce an `ecommerce` transaction.

---

## 11. Metadata

Metadata values must be **strings** (not booleans or numbers).

```javascript
// Embed (checkout transaction)
gr4vy.setup({ metadata: { checkout: "true" }, ... });

// Server-side (upsell transaction)
gr4vy.transactions.create({ metadata: { upsell: "true" }, ... });
```

---

## 12. CDN Script Loading

The embed JS is loaded from gr4vy's CDN at runtime — it is not an npm package.

```javascript
// Correct URL format:
const src = `https://cdn.${gr4vyId}.gr4vy.app/embed.latest.js`;

// ❌ Wrong — sandbox subdomain does not exist:
// https://cdn.${gr4vyId}.sandbox.gr4vy.app/embed.latest.js
```

Load it dynamically and call `gr4vy.setup()` in the `onload` callback:

```javascript
const script = document.createElement("script");
script.src = src;
script.onload = () => setupEmbed();
script.onerror = () => showError(`Could not load gr4vy from ${src}`);
document.head.appendChild(script);
```

The `gr4vy` global becomes available after the script loads. The `environment` (`sandbox` / `production`) is passed as a parameter to `gr4vy.setup()` — not as part of the CDN URL.

---

## 13. Common Errors & Fixes

### `secretOrPrivateKey must be an asymmetric key when using ES512`
The PEM key has been corrupted — usually by leading whitespace added when pasting into `.env`. Fix: trim each line of the key in code (see §1).

### `Value for cart_items does not match value in JWT access token`
The `cartItems` array passed to `gr4vy.setup()` does not match what was encoded in the JWT. Fix: return `cartItems` from your token endpoint and pass the exact same array to `gr4vy.setup()` — do not reconstruct it on the frontend.

### `Value for buyer_external_identifier does not match value in JWT access token`
`buyerExternalIdentifier` must be present in **both** `embedParams` (JWT) and `gr4vy.setup()` with identical values.

### `missing_redirect_url`
Server-side `transactions.create()` requires `paymentMethod.redirectUrl` even for card-on-file charges. Always pass a valid URL.

### Pay button never appears
The correct event name is `optionsLoaded` (not `formLoaded` or similar). Also show the button immediately on embed init as a fallback — the event may not fire on all paths:
```javascript
embedInstance = gr4vy.setup({ ... });
document.getElementById("pay-btn").style.display = "block"; // immediate fallback
```

### Embed renders blank / doesn't mount
Ensure `dotenv.config()` is called **before** any module that reads `process.env`. With TypeScript/ESM, module-level code (e.g. `new Pool()`) runs at import time before your `dotenv.config()` call. Fix: use a lazy initialiser (Proxy or getter) for your DB pool.

### Merchant account ID not being applied
Pass `merchantAccountId` to every gr4vy SDK call: `checkoutSessions.create()`, `transactions.create()`, `transactions.get()`, `buyers.list()`, `buyers.update()`, `buyers.shippingDetails.create()`. Missing it on any one call causes silent failures or transactions landing in the wrong account.

### Upsell billing address missing
The billing address on a transaction comes from the **payment method's** billing details captured at card entry time, not from the buyer record. To ensure address is attached to the main checkout transaction, pre-fill `buyer.billingDetails.address` in `gr4vy.setup()` so the embedded card form is pre-populated. Update the buyer record via `buyers.update()` in `onBeforeTransaction` so subsequent server-side charges inherit the correct address.


---

# Part 2 — Secure Fields + Direct API

## 14. Architecture

```
Express:  Apple Pay / Google Pay sheet ──token + shipping──▶ POST /api/payment/wallet
          PayPal ──▶ POST /api/payment/redirect ──▶ paypal.com ──▶ GET /api/payment/return
Cards:    Secure Fields ──vaults card into checkout session──▶ POST /api/payment/card
BNPL:     Affirm / Klarna / PayPal Pay Later / Sezzle ──▶ POST /api/payment/redirect ──▶ provider ──▶ GET /api/payment/return
```

- `POST /api/payment/init` creates the **checkout session** (Secure Fields needs it) and lists the available methods.
- Every transaction is created **server-side** with the private key. No embed JWT is involved, so the `cartItems` / `buyerExternalIdentifier` JWT-mismatch errors from §13 cannot happen.
- Every payment route answers with one of `{ approvalUrl }` (send the buyer there: 3DS, BNPL, PayPal), `{ redirect }` (paid) or `{ error }`.

### Buyers and addresses

Before each transaction the server finds or creates the gr4vy buyer by `externalIdentifier`, updates its `billingDetails` and creates a **shipping details** record:

```typescript
const buyerId = await ensureBuyer(order);                       // buyers.list → buyers.create
const shippingDetailsId = await attachAddresses(buyerId, order, shipping, billing);

await gr4vy.transactions.create({ buyerId, shippingDetailsId, /* ... */ }, merchantAccountId);
```

Pass `buyerId` + `shippingDetailsId`. Don't also pass a guest `buyer` object on the same transaction.

---

## 15. Payment Options

Ask gr4vy which methods apply instead of hard-coding them. The response already respects Flow rules and active connections:

```typescript
const options = await gr4vy.paymentOptions.list(
  { amount: order.amount, currency: "USD", country: "US", cartItems },
  merchantAccountId
);
// items[].method: card, affirm, klarna, paypal, paypalpaylater, sezzle, applepay, googlepay, ...
// items[].iconUrl: ready-made 48×32 badges on the gr4vy CDN
// items[].context: wallet config, e.g. googlepay.gatewayMerchantId, applepay.supportedSchemes
```

The app groups the results into `express` (`applepay`, `googlepay`, `paypal`) and `bnpl` (`affirm`, `klarna`, `paypalpaylater`, `sezzle`). Methods missing from the response are not shown.

Card scheme logos live at `https://cdn.sandbox.<gr4vyId>.gr4vy.app/assets/icons/card-schemes/<scheme>.svg` (drop `sandbox.` in production).

---

## 16. Secure Fields Card Form

Load the library from the CDN. Unlike Embed (§12), the sandbox host includes `sandbox.`:

```javascript
const cdn = `https://cdn.${env === "production" ? "" : "sandbox."}${gr4vyId}.gr4vy.app/secure-fields/latest`;
loadStylesheet(`${cdn}/secure-fields.css`);
await loadScript(`${cdn}/secure-fields.js`);

const sf = new SecureFields({ gr4vyId, environment, sessionId }); // sessionId from /api/payment/init
```

Each field is attached to a plain `<div>`, which Secure Fields fills with a PCI-scoped iframe:

```javascript
const number = sf.addCardNumberField("#cc-number", {
  placeholder: "1234 5678 9012 3456",
  styles: { ...base, padding: "0 112px 0 16px" },            // room for 2 scheme icons
  showSchemeIcons: { scheme: true, additionalSchemes: true }, // Visa, Amex, co-badged cards
  maskInput: { showLastFour: true },                          // •••• •••• •••• 1111 on blur
});
sf.addExpiryDateField("#cc-expiry", { placeholder: "MM / YY", styles: base });
sf.addSecurityCodeField("#cc-cvv", { placeholder: "CVV", styles: base, maskInput: true });

sf.setAutoAdvance({ enabled: true }); // number → expiry → CVV once each is complete and valid
```

UX options used (see [Secure Fields UX options](https://docs.gr4vy.com/guides/payments/secure-fields/ux-options)):

| Option | Effect | Notes |
|---|---|---|
| `setAutoAdvance({ enabled: true })` | Moves focus to the next field when the current one is complete and valid | Default order: number, expiry, CVV. gr4vy warns it can confuse buyers who edit fields out of order. |
| `showSchemeIcons` | Shows the detected scheme (and co-badged schemes) inside the number field | Each icon is 48px plus a 4px gap. Reserve right padding inside the field. |
| `maskInput` | Masks the number (keeping the last four) and the CVV when the field loses focus | `maskOnInput: true` masks while typing instead. |
| `field.focus()` | Moves focus into a field | Used when the Cards tab opens and to jump to the first invalid field on submit. |
| `autoFocus` | Focuses a field when it loads | Not used: the shipping form sits above the card form. |

### Styling

- **Inside the iframe**, only an allow-listed set of CSS properties works (`color`, `fontSize`, `fontFamily`, `padding`, `caretColor`, ...). Borders and backgrounds are not on the list.
- **Outside**, Secure Fields sets data attributes on each field container, so borders and focus rings belong in your own CSS:

```css
.card-field:has([data-secure-fields-focused]) { box-shadow: inset 0 0 0 2px var(--wz-border-brand); }
.card-field.invalid                           { background: var(--wz-bg-error-primary); }
```

`[data-secure-fields-invalid]` and `[data-secure-fields-autofilled]` are available too. The app uses its own `.invalid` class instead, so that a field only turns red after the buyer has left it.

---

## 17. Card Validation & Error Messages

Listen to `FORM_CHANGE` on the Secure Fields instance. It reports every field's state on each change:

```javascript
sf.addEventListener(SecureFields.Events.FORM_CHANGE, ({ fields, complete }) => {
  // fields.number       → { valid, empty, complete, touched, dirty, autofilled, scheme }
  // fields.expiryDate   → { valid, empty, complete, touched, dirty, autofilled, expired }
  // fields.securityCode → { valid, empty, complete, touched, dirty, autofilled }
});
```

Rules the app follows:

1. **Only flag a field after the buyer leaves it** (`touched`), so nothing turns red while they type.
2. **On Pay**, if the form is incomplete, show every error at once and `focus()` the first invalid field. The Pay button stays enabled, since a disabled button gives no reason.
3. **Treat an unknown field as empty.** `FORM_CHANGE` only starts after the first keystroke, so clicking Pay on an untouched form has no field state yet.
4. **Use the scheme's code label.** The number field's `input` event carries `codeLabel` (`CVV`, `CVC`, `CID` for Amex), so messages read "Enter the CID." The field's placeholder cannot change after the field is created.
5. **Show messages in one `role="alert" aria-live="polite"` region** under the card group, so screen readers announce them.

| Field | Condition | Message |
|---|---|---|
| Number | `empty` | Enter your card number. |
| Number | not `complete` | Your card number is incomplete. |
| Number | `complete` but not `valid` (failed Luhn check) | This card number is not valid. |
| Expiry | `empty` | Enter the expiry date. |
| Expiry | `expired` | This card has expired. |
| Expiry | not `complete` | Enter the expiry date as MM / YY. |
| CVV | `empty` | Enter the CVV / CID. |
| CVV | not `valid` | Your CVV / CID is incomplete. |

`complete` in `FORM_CHANGE` treats an **empty CVV as acceptable**. The app requires all three fields to be `valid` before calling `submit()`.

`CARD_VAULT_FAILURE` fires if gr4vy rejects the card data on submit. Its `message` is shown in the same error region and the Pay button is re-enabled.

To refuse a scheme you don't accept, check `scheme` in the number field's `card-details-changed` event and don't call `submit()` while it's entered. Secure Fields won't block schemes for you.

---

## 18. Charging the Card

`sf.submit()` vaults the card into the checkout session. On `CARD_VAULT_SUCCESS`, the frontend calls the server, which charges the session:

```typescript
const tx = await gr4vy.transactions.create({
  amount, currency, country, buyerId, shippingDetailsId,
  paymentMethod: {
    method: "checkout-session",
    id: checkoutSessionId,
    redirectUrl: `${appUrl}/api/payment/return?order_id=${orderId}`, // hosted 3DS
  },
  store: true,               // keeps the card for card-on-file upsells (§9)
  paymentSource: "ecommerce",
  cartItems, externalIdentifier: orderId, metadata: { checkout: "true" },
}, merchantAccountId);
```

- `buyer_approval_pending` with `paymentMethod.approvalUrl` means 3DS is needed. Redirect the buyer there; they come back to `/api/payment/return`.

---

## 19. Redirect Methods: BNPL & PayPal

```typescript
const tx = await gr4vy.transactions.create({
  amount, currency, country, buyerId, shippingDetailsId, cartItems,
  paymentMethod: {
    method: "klarna",      // affirm | klarna | paypalpaylater | sezzle | paypal
    country, currency,
    redirectUrl: `${appUrl}/api/payment/return?order_id=${orderId}`,
  },
}, merchantAccountId);
// → status "buyer_approval_pending", paymentMethod.approvalUrl → send the buyer there
```

- **BNPL needs the shipping address up front**, because providers run eligibility checks on it.
- **Send cart items**: the app passes the same `cartItems` on every transaction so providers can show what is being bought.
- **On return**, gr4vy appends `transaction_id` (and a status) to the `redirectUrl`. Always re-fetch the transaction with `transactions.get()` rather than trusting the query string.
- **PayPal as express checkout**: send no shipping address. Enable **Import shipping details** on the PayPal connection (Connections → Configured → PayPal → Credentials) and gr4vy asks PayPal for the address and puts it on the transaction as `shippingDetails`, which `/return` saves on the order.
- The SDK's `PaypalOptions` type (v1.x) has no `shipping_preference`. Leaving it out lets gr4vy pick the right value.

---

## 20. Apple Pay & Google Pay

Both wallets collect the shipping address in their own sheet, so express checkout needs no address form.

### Apple Pay

```javascript
const session = new ApplePaySession(3, {
  countryCode: "US", currencyCode: "USD",
  merchantCapabilities: ["supports3DS"], supportedNetworks,
  total: { label: "WizloShop", type: "final", amount: "39.99" },
  requiredShippingContactFields: ["postalAddress", "name", "email", "phone"],
  requiredBillingContactFields:  ["postalAddress", "name"],
});
session.onvalidatemerchant = async (e) =>
  session.completeMerchantValidation(await post("/api/payment/applepay/session", { validationUrl: e.validationURL }));
session.onshippingcontactselected = () => session.completeShippingContactSelection({ newTotal: total });
session.onpaymentauthorized = async (e) => {
  // e.payment.token → POST /api/payment/wallet { method: "applepay", token, shipping: e.payment.shippingContact }
};
```

- The server validates with `gr4vy.digitalWallets.sessions.applePay({ validationUrl, domainName })`.
- Load `https://applepay.cdn-apple.com/jsapi/1.latest/apple-pay-sdk.js` for non-Safari browsers.
- **`ApplePaySession.canMakePayments()` throws on `http://` pages.** Wrap it in `try/catch` or the whole express row fails to render.
- The domain must be registered in gr4vy (Connections → Apple Pay → Domains), and `/.well-known/apple-developer-merchantid-domain-association` must be served. Express's static middleware ignores dot-folders, so serve that folder with `{ dotfiles: "allow" }`.

### Google Pay

```javascript
const client = new google.payments.api.PaymentsClient({ environment: sandbox ? "TEST" : "PRODUCTION" });
await client.loadPaymentData({
  apiVersion: 2, apiVersionMinor: 0,
  allowedPaymentMethods: [{
    type: "CARD",
    parameters: { allowedAuthMethods: ["PAN_ONLY", "CRYPTOGRAM_3DS"], allowedCardNetworks,
                  billingAddressRequired: true, billingAddressParameters: { format: "FULL" } },
    tokenizationSpecification: { type: "PAYMENT_GATEWAY",
      parameters: { gateway: "gr4vy", gatewayMerchantId } }, // from paymentOptions context
  }],
  merchantInfo,               // see below
  transactionInfo: { totalPriceStatus: "FINAL", totalPrice: "39.99", currencyCode: "USD", countryCode: "US" },
  emailRequired: true,
  shippingAddressRequired: true,
  shippingAddressParameters: { phoneNumberRequired: true },
});
// → POST /api/payment/wallet { method: "googlepay", token: paymentMethodData.tokenizationData.token, ... }
```

- **`merchantInfo` outside localhost** must be `{ merchantName, merchantId: "BCR2DN4T7C3KX6DY", authJwt, merchantOrigin }`. `authJwt` comes from `gr4vy.digitalWallets.sessions.googlePay({ originDomain })` and `BCR2DN4T7C3KX6DY` is gr4vy's Google merchant ID. A mismatched domain gives `OR_BIBED_*` errors.
- **On localhost** the gr4vy session call fails validation, and Google's TEST environment doesn't need it, so skip it.
- `PAN_ONLY` cards can trigger 3DS. Always send a `redirectUrl` and follow `approvalUrl`.

---

## 21. HTTPS, Domains & More Errors

### Testing over HTTPS with ngrok

```bash
ngrok config add-authtoken <token>
ngrok http 4000
```

- Set `app.set("trust proxy", true)` so `req.protocol` / `req.hostname` give the public `https://` host for redirect URLs and wallet domain validation.
- ngrok's free plan gives one **fixed** `*.ngrok-free.dev` domain per account, so you only register it with Apple Pay once.
- The free plan shows a warning page on the first visit in each browser. API calls from scripts need the header `ngrok-skip-browser-warning: 1`.

### More errors

| Symptom | Cause / fix |
|---|---|
| `InvalidAccessError: Trying to start an Apple Pay session from an insecure document` | Page is on `http://`. Use HTTPS, and wrap `canMakePayments()` in `try/catch`. |
| Google Pay session: `Request failed validation` | `originDomain` was `localhost` or another non-public name. Skip the session in TEST mode. |
| Apple Pay sheet closes with "Payment Not Completed" | Domain not registered in gr4vy, or page framed under a different top-level domain. |
| Card errors don't show when Pay is clicked on an empty form | No `FORM_CHANGE` has fired yet. Treat missing field state as empty (§17). |
| BNPL returns to checkout with `payment_error` | Buyer cancelled or was declined at the provider. The transaction status is in the query string. |
| PayPal order has no shipping address | **Import shipping details** is off on the PayPal connection. |

---

*Built on `@gr4vy/sdk` v1.x · Secure Fields `secure-fields.js` · Embed `embed.latest.js`*
