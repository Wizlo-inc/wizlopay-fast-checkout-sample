import { Router, Request, Response } from "express";
import pool from "../db";
import { createGr4vyClient, getMerchantAccountId } from "../gr4vy";

const router = Router();

/*
 * Checkout without Embed:
 *   - Cards:            Secure Fields vaults the card into a checkout session → POST /card
 *   - BNPL / PayPal:    redirect methods → POST /redirect → buyer approves → GET /return
 *   - Apple/Google Pay: wallet sheet (collects shipping) → POST /wallet
 */

const BNPL_METHODS    = ["affirm", "klarna", "paypalpaylater", "sezzle"];
const EXPRESS_METHODS = ["applepay", "googlepay", "paypal"];
const REDIRECT_METHODS = new Set([...BNPL_METHODS, "paypal"]);

const SUCCESS_STATUSES = new Set([
  "authorization_succeeded", "capture_succeeded", "capture_pending", "processing",
]);

export interface ShippingInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

// ── Helpers ─────────────────────────────────────────────────────

async function loadOrder(orderId: string) {
  const { rows } = await pool.query(
    `SELECT id, amount, currency, status, buyer_external_id, first_name, last_name,
            email, mobile, product_id, product_name, gr4vy_checkout_session_id, shipping_address
     FROM orders WHERE id = $1`,
    [orderId]
  );
  return rows[0] ?? null;
}

function appUrl(req: Request): string {
  return process.env.APP_URL ?? `${req.protocol}://${req.get("host")}`;
}

function cartItemsFor(order: any) {
  return [{
    name:       order.product_name,
    quantity:   1,
    unitAmount: order.amount,
    sku:        order.product_id,
    categories: ["Electronics"],
  }];
}

function toGr4vyAddress(s: ShippingInput) {
  return {
    line1:      s.line1,
    line2:      s.line2 || undefined,
    city:       s.city,
    state:      s.state || undefined,
    postalCode: s.postalCode,
    country:    s.country,
  };
}

/** Find the gr4vy buyer for this order (by external id) or create one. */
async function ensureBuyer(order: any): Promise<string> {
  const gr4vy = createGr4vyClient();
  const merchantAccountId = getMerchantAccountId();

  const pages = await gr4vy.buyers.list({
    externalIdentifier: order.buyer_external_id, limit: 1, merchantAccountId,
  });
  for await (const page of pages) {
    const existing = page.result?.items?.[0];
    if (existing?.id) return existing.id;
    break;
  }

  const buyer = await gr4vy.buyers.create({
    externalIdentifier: order.buyer_external_id,
    displayName:        `${order.first_name} ${order.last_name}`,
    billingDetails: {
      firstName:    order.first_name,
      lastName:     order.last_name,
      emailAddress: order.email,
      phoneNumber:  order.mobile ?? undefined,
    },
  }, merchantAccountId);
  return buyer.id as string;
}

/** Update buyer billing address + attach a shipping-details record; returns its id. */
async function attachAddresses(buyerId: string, order: any, shipping: ShippingInput, billing?: ShippingInput) {
  const gr4vy = createGr4vyClient();
  const merchantAccountId = getMerchantAccountId();
  const bill = billing ?? shipping;

  await gr4vy.buyers.update({
    billingDetails: {
      firstName:    bill.firstName || order.first_name,
      lastName:     bill.lastName  || order.last_name,
      emailAddress: bill.email     || order.email,
      phoneNumber:  bill.phone     || order.mobile || undefined,
      address:      toGr4vyAddress(bill),
    },
  }, buyerId, merchantAccountId);

  const details = await gr4vy.buyers.shippingDetails.create({
    firstName:    shipping.firstName || order.first_name,
    lastName:     shipping.lastName  || order.last_name,
    emailAddress: shipping.email     || order.email,
    phoneNumber:  shipping.phone     || order.mobile || undefined,
    address:      toGr4vyAddress(shipping),
  }, buyerId, merchantAccountId);

  return details.id as string;
}

function mapStatus(status: string | undefined): string {
  if (!status) return "pending";
  if (status === "capture_succeeded") return "paid";
  if (status === "authorization_succeeded") return "authorized";
  if (status.includes("declined")) return "declined";
  if (status.includes("failed") || status.includes("voided") || status.includes("canceled")) return "failed";
  return "pending";
}

function shippingFromTransaction(tx: any): ShippingInput | null {
  const s = tx?.shippingDetails;
  const a = s?.address;
  if (!a?.line1) return null;
  return {
    firstName: s.firstName ?? undefined, lastName: s.lastName ?? undefined,
    email: s.emailAddress ?? undefined, phone: s.phoneNumber ?? undefined,
    line1: a.line1, line2: a.line2 ?? undefined, city: a.city ?? "",
    state: a.state ?? undefined, postalCode: a.postalCode ?? "", country: a.country ?? "",
  };
}

/** Persist transaction outcome on the order. */
async function recordTransaction(orderId: string, tx: any, shipping?: ShippingInput | null) {
  await pool.query(
    `UPDATE orders
     SET gr4vy_transaction_id    = $1,
         status                  = $2,
         shipping_address        = COALESCE($3::jsonb, shipping_address),
         gr4vy_payment_method_id = COALESCE($4, gr4vy_payment_method_id),
         updated_at              = NOW()
     WHERE id = $5`,
    [tx.id, mapStatus(tx.status), shipping ? JSON.stringify(shipping) : null, tx.paymentMethod?.id ?? null, orderId]
  );
}

/** Shape a transaction into what the frontend needs to do next. */
function nextStep(orderId: string, tx: any) {
  if (tx.status === "buyer_approval_pending" && tx.paymentMethod?.approvalUrl) {
    return { status: tx.status, transactionId: tx.id, approvalUrl: tx.paymentMethod.approvalUrl };
  }
  if (SUCCESS_STATUSES.has(tx.status)) {
    return { status: tx.status, transactionId: tx.id, redirect: `/confirmation.html?order_id=${orderId}` };
  }
  return { status: tx.status, transactionId: tx.id, error: declineMessage(tx) };
}

function declineMessage(tx: any): string {
  if (tx.errorCode) return `Payment was not approved (${tx.errorCode}).`;
  return "Payment was not approved. Please try another payment method.";
}

function sendError(res: Response, err: unknown, label: string) {
  const msg = err instanceof Error ? err.message : "Unknown error";
  console.error(`${label}:`, err);
  return res.status(502).json({ error: `${label}. ${msg}` });
}

// ── POST /api/payment/init — checkout session + available methods ──
router.post("/init", async (req: Request, res: Response) => {
  const { orderId, country = "US" } = req.body;
  const order = orderId && await loadOrder(orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });

  try {
    const gr4vy = createGr4vyClient();
    const merchantAccountId = getMerchantAccountId();

    const [session, options] = await Promise.all([
      gr4vy.checkoutSessions.create(undefined, merchantAccountId),
      gr4vy.paymentOptions.list({
        amount: order.amount, currency: order.currency, country,
        cartItems: cartItemsFor(order),
      }, merchantAccountId),
    ]);

    await pool.query(
      `UPDATE orders SET gr4vy_checkout_session_id = $1, updated_at = NOW() WHERE id = $2`,
      [session.id, orderId]
    );

    const byMethod = new Map(options.items.map((o: any) => [o.method, o]));
    const pick = (methods: string[]) => methods
      .filter((m) => byMethod.has(m))
      .map((m) => {
        const o: any = byMethod.get(m);
        return { method: o.method, label: o.label, iconUrl: o.iconUrl, context: o.context ?? null };
      });

    return res.json({
      sessionId: session.id,
      card:      byMethod.has("card"),
      bnpl:      pick(BNPL_METHODS),
      express:   pick(EXPRESS_METHODS),
    });
  } catch (err) {
    return sendError(res, err, "Could not start checkout");
  }
});

// ── POST /api/payment/card — charge the card vaulted by Secure Fields ──
router.post("/card", async (req: Request, res: Response) => {
  const { orderId, shippingAddress } = req.body as { orderId: string; shippingAddress: ShippingInput };
  const order = orderId && await loadOrder(orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!order.gr4vy_checkout_session_id) return res.status(400).json({ error: "Checkout session missing" });
  if (!shippingAddress?.line1) return res.status(400).json({ error: "Shipping address is required" });

  try {
    const gr4vy = createGr4vyClient();
    const buyerId = await ensureBuyer(order);
    const shippingDetailsId = await attachAddresses(buyerId, order, shippingAddress);

    const tx = await gr4vy.transactions.create({
      amount:   order.amount,
      currency: order.currency,
      country:  shippingAddress.country,
      buyerId,
      shippingDetailsId,
      paymentMethod: {
        method:      "checkout-session",
        id:          order.gr4vy_checkout_session_id,
        redirectUrl: `${appUrl(req)}/api/payment/return?order_id=${orderId}`, // hosted 3DS
      },
      store:         true,              // saved for card-on-file upsells
      paymentSource: "ecommerce",
      cartItems:     cartItemsFor(order),
      externalIdentifier: orderId,
      metadata:      { checkout: "true" },
    }, getMerchantAccountId());

    await recordTransaction(orderId, tx, shippingAddress);
    return res.json(nextStep(orderId, tx));
  } catch (err) {
    return sendError(res, err, "Card payment failed");
  }
});

// ── POST /api/payment/redirect — Affirm, Klarna, PayPal ─────────
router.post("/redirect", async (req: Request, res: Response) => {
  const { orderId, method, shippingAddress } = req.body as {
    orderId: string; method: string; shippingAddress?: ShippingInput;
  };
  if (!REDIRECT_METHODS.has(method)) return res.status(400).json({ error: "Unsupported method" });
  const order = orderId && await loadOrder(orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });

  // PayPal is an express method: the buyer picks their address on PayPal and gr4vy
  // imports it (requires "Import shipping details" on the PayPal connection).
  // BNPL providers need the address up front for their eligibility checks.
  if (method !== "paypal" && !shippingAddress?.line1) {
    return res.status(400).json({ error: "Shipping address is required" });
  }

  try {
    const gr4vy = createGr4vyClient();
    const buyerId = await ensureBuyer(order);
    const shippingDetailsId = shippingAddress?.line1
      ? await attachAddresses(buyerId, order, shippingAddress)
      : undefined;
    const country = shippingAddress?.country || "US";

    const tx = await gr4vy.transactions.create({
      amount:   order.amount,
      currency: order.currency,
      country,
      buyerId,
      ...(shippingDetailsId ? { shippingDetailsId } : {}),
      paymentMethod: {
        method:      method as any,
        country,
        currency:    order.currency,
        redirectUrl: `${appUrl(req)}/api/payment/return?order_id=${orderId}`,
      },
      paymentSource: "ecommerce",
      cartItems:     cartItemsFor(order),
      externalIdentifier: orderId,
      metadata:      { checkout: "true" },
    }, getMerchantAccountId());

    await recordTransaction(orderId, tx, shippingAddress?.line1 ? shippingAddress : null);
    return res.json(nextStep(orderId, tx));
  } catch (err) {
    return sendError(res, err, `Could not start ${method}`);
  }
});

// ── GET /api/payment/return — buyer comes back from a redirect / 3DS ──
router.get("/return", async (req: Request, res: Response) => {
  const orderId = String(req.query.order_id ?? "");
  const transactionId = String(req.query.transaction_id ?? req.query.gr4vy_transaction_id ?? "");
  if (!orderId) return res.redirect("/");
  if (!transactionId) return res.redirect(`/checkout.html?order_id=${orderId}&payment_error=cancelled`);

  try {
    const gr4vy = createGr4vyClient();
    const tx: any = await gr4vy.transactions.get(transactionId, getMerchantAccountId());
    await recordTransaction(orderId, tx, shippingFromTransaction(tx));

    if (SUCCESS_STATUSES.has(tx.status)) {
      return res.redirect(`/confirmation.html?order_id=${orderId}`);
    }
    return res.redirect(`/checkout.html?order_id=${orderId}&payment_error=${encodeURIComponent(tx.status)}`);
  } catch (err) {
    console.error("Could not verify returning transaction:", err);
    return res.redirect(`/checkout.html?order_id=${orderId}&payment_error=unverified`);
  }
});

// ── POST /api/payment/applepay/session — merchant validation ────
router.post("/applepay/session", async (req: Request, res: Response) => {
  const { validationUrl } = req.body;
  if (!validationUrl) return res.status(400).json({ error: "validationUrl is required" });
  try {
    const gr4vy = createGr4vyClient();
    const session = await gr4vy.digitalWallets.sessions.applePay({
      validationUrl,
      domainName: process.env.APPLE_PAY_DOMAIN ?? String(req.hostname),
    }, getMerchantAccountId());
    return res.json(session);
  } catch (err) {
    return sendError(res, err, "Apple Pay validation failed");
  }
});

// ── POST /api/payment/googlepay/session — merchantInfo auth for production ──
router.post("/googlepay/session", async (req: Request, res: Response) => {
  const originDomain = String(req.body.originDomain ?? req.hostname);
  // Google Pay's TEST environment does not need an auth JWT, and gr4vy rejects
  // non-public origins like "localhost", so skip the call there.
  if (originDomain === "localhost" || originDomain.endsWith(".localhost") || originDomain === "127.0.0.1") {
    return res.json({ authJwt: null });
  }
  try {
    const gr4vy = createGr4vyClient();
    const session = await gr4vy.digitalWallets.sessions.googlePay({ originDomain }, getMerchantAccountId());
    return res.json({ authJwt: session.token, gatewayMerchantId: session.gatewayMerchantId });
  } catch (err) {
    return sendError(res, err, "Google Pay session failed");
  }
});

// ── POST /api/payment/wallet — Apple Pay / Google Pay token + wallet shipping ──
router.post("/wallet", async (req: Request, res: Response) => {
  const { orderId, method, token, cardSuffix, cardScheme, shipping, billing } = req.body as {
    orderId: string; method: "applepay" | "googlepay"; token: any;
    cardSuffix?: string; cardScheme?: string; shipping: ShippingInput; billing?: ShippingInput;
  };
  if (method !== "applepay" && method !== "googlepay") return res.status(400).json({ error: "Unsupported wallet" });
  if (!token) return res.status(400).json({ error: "Wallet token is required" });
  if (!shipping?.line1) return res.status(400).json({ error: "Shipping address missing from wallet" });
  const order = orderId && await loadOrder(orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });

  try {
    const gr4vy = createGr4vyClient();
    const buyerId = await ensureBuyer(order);
    const shippingDetailsId = await attachAddresses(buyerId, order, shipping, billing?.line1 ? billing : undefined);

    const tx = await gr4vy.transactions.create({
      amount:   order.amount,
      currency: order.currency,
      country:  shipping.country,
      buyerId,
      shippingDetailsId,
      paymentMethod: {
        method,
        token,
        ...(cardSuffix ? { cardSuffix } : {}),
        ...(cardScheme ? { cardScheme: cardScheme.toLowerCase() } : {}),
        redirectUrl: `${appUrl(req)}/api/payment/return?order_id=${orderId}`,
      } as any,
      paymentSource: "ecommerce",
      cartItems:     cartItemsFor(order),
      externalIdentifier: orderId,
      metadata:      { checkout: "true", express: method },
    }, getMerchantAccountId());

    await recordTransaction(orderId, tx, shipping);
    return res.json(nextStep(orderId, tx));
  } catch (err) {
    return sendError(res, err, "Wallet payment failed");
  }
});

export default router;
