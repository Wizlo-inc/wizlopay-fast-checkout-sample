import { Router, Request, Response } from "express";
import pool from "../db";
import { createGr4vyClient, generateEmbedToken, getMerchantAccountId } from "../gr4vy";
import { findProduct } from "../products";

const router = Router();

// POST /api/payment/token — generate gr4vy embed JWT + checkout session for an order
router.post("/token", async (req: Request, res: Response) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: "orderId is required" });

  const { rows } = await pool.query(
    `SELECT id, amount, currency, buyer_external_id,
            first_name, last_name, email, mobile, product_id, product_name
     FROM orders WHERE id = $1`,
    [orderId]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found" });

  const order = rows[0];
  const gr4vy = createGr4vyClient();
  const merchantId = getMerchantAccountId();

  const session = await gr4vy.checkoutSessions.create(undefined, merchantId);
  const checkoutSessionId = session.id as string;

  // Build buyer object
  const buyer = {
    displayName: `${order.first_name} ${order.last_name}`,
    externalIdentifier: order.buyer_external_id,
    billingDetails: {
      firstName:    order.first_name,
      lastName:     order.last_name,
      emailAddress: order.email,
      phoneNumber:  order.mobile ?? undefined,
    },
  };

  // Build cart item from the ordered product
  const product = findProduct(order.product_id, "main");
  const cartItems = [
    {
      name:        order.product_name,
      quantity:    1,
      unitAmount:  order.amount,
      sku:         order.product_id,
      ...(product ? { categories: ["Electronics"] } : {}),
    },
  ];

  const token = await generateEmbedToken({
    amount:                  order.amount,
    currency:                order.currency,
    buyerExternalIdentifier: order.buyer_external_id,
    checkoutSessionId,
    cartItems,
  });

  await pool.query(
    `UPDATE orders SET gr4vy_checkout_session_id = $1, updated_at = NOW() WHERE id = $2`,
    [checkoutSessionId, orderId]
  );

  return res.json({
    token,
    buyer: {
      externalIdentifier: order.buyer_external_id,
      firstName:          order.first_name,
      lastName:           order.last_name,
      email:              order.email,
      mobile:             order.mobile ?? undefined,
    },
    cartItems,
  });
});

// POST /api/payment/complete — called by frontend after embed onComplete fires
router.post("/complete", async (req: Request, res: Response) => {
  const { orderId, transactionId, status, shippingAddress } = req.body;
  if (!orderId || !transactionId) {
    return res.status(400).json({ error: "orderId and transactionId are required" });
  }

  let paymentMethodId: string | null = null;
  try {
    const gr4vy = createGr4vyClient();
    const tx = await gr4vy.transactions.get(transactionId, getMerchantAccountId());
    paymentMethodId = tx?.paymentMethod?.id ?? null;
  } catch (err) {
    console.error("Could not fetch gr4vy transaction details:", err);
  }

  await pool.query(
    `UPDATE orders
     SET gr4vy_transaction_id    = $1,
         status                   = $2,
         shipping_address         = $3,
         gr4vy_payment_method_id  = $4,
         updated_at               = NOW()
     WHERE id = $5`,
    [transactionId, mapStatus(status), shippingAddress ? JSON.stringify(shippingAddress) : null, paymentMethodId, orderId]
  );

  return res.json({ ok: true });
});

// POST /api/payment/billing-details — update gr4vy buyer billing address before transaction
router.post("/billing-details", async (req: Request, res: Response) => {
  const { orderId, billingAddress } = req.body;
  if (!orderId || !billingAddress) {
    return res.status(400).json({ error: "orderId and billingAddress are required" });
  }

  const { rows } = await pool.query(
    `SELECT buyer_external_id, first_name, last_name, email, mobile FROM orders WHERE id = $1`,
    [orderId]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found" });

  const order = rows[0];
  const gr4vy = createGr4vyClient();
  const merchantId = getMerchantAccountId();

  try {
    // Look up the gr4vy buyer UUID by external identifier
    const buyerList = await gr4vy.buyers.list(
      { externalIdentifier: order.buyer_external_id, limit: 1, merchantAccountId: merchantId }
    );
    const buyerItems: any[] = [];
    for await (const page of buyerList) {
      if (page.result?.items) buyerItems.push(...page.result.items);
      break; // only need the first page
    }

    if (!buyerItems.length) {
      return res.status(404).json({ error: "Buyer not found in gr4vy" });
    }

    const buyerId = buyerItems[0].id as string;

    await gr4vy.buyers.update(
      {
        billingDetails: {
          firstName:    order.first_name,
          lastName:     order.last_name,
          emailAddress: order.email,
          phoneNumber:  order.mobile ?? undefined,
          address: {
            line1:      billingAddress.line1,
            line2:      billingAddress.line2 || undefined,
            city:       billingAddress.city,
            state:      billingAddress.state || undefined,
            postalCode: billingAddress.postalCode,
            country:    billingAddress.country,
          },
        },
      },
      buyerId,
      merchantId
    );

    return res.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("Failed to update billing details:", err);
    return res.status(502).json({ error: "Could not update billing details", detail: msg });
  }
});

function mapStatus(embedStatus: string): string {
  if (!embedStatus) return "pending";
  if (embedStatus.includes("capture_succeeded") || embedStatus.includes("captured")) return "paid";
  if (embedStatus.includes("declined")) return "declined";
  if (embedStatus.includes("failed")) return "failed";
  if (embedStatus.includes("authorization_succeeded") || embedStatus.includes("authorized")) return "authorized";
  return "pending";
}

export default router;
