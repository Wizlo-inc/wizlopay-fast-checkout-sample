---
title: "gr4vy Embed Integration Guide"
description: "A complete developer reference for integrating gr4vy Embed — covering JWT tokens, billing address handling, card-on-file upsells, and common pitfalls."
version: "1.0.0"
date: "2026-05-17"
authors:
  - Wizlo Inc.
tags:
  - gr4vy
  - payments
  - embed
  - node.js
  - typescript
  - card-on-file
  - upsell
  - ecommerce
stack:
  backend: "Node.js / Express / TypeScript"
  frontend: "Plain HTML / CSS / JS"
  sdk: "@gr4vy/sdk v1.x"
  embed: "embed.latest.js (CDN)"
  database: "PostgreSQL"
metadata:
  checkout: "true"
  upsell: "true"
---

# gr4vy Embed Integration Guide

A complete reference for developers implementing gr4vy Embed with a Node.js/Express backend and plain JS frontend. Every nuance below was discovered through real implementation and debugging.

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

---

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

*Built on `@gr4vy/sdk` v1.x · Embed `embed.latest.js`*
