import { Router, Request, Response } from "express";
import pool from "../db";
import { createGr4vyClient, getMerchantAccountId } from "../gr4vy";
import { UPSELL_PRODUCTS } from "../products";

const router = Router();

// GET /api/upsell/products — return the upsell product list
router.get("/products", (_req: Request, res: Response) => {
  res.json(UPSELL_PRODUCTS);
});

// POST /api/upsell/charge — charge saved payment method for an upsell product
router.post("/charge", async (req: Request, res: Response) => {
  const { orderId, productId } = req.body;
  if (!orderId || !productId) {
    return res.status(400).json({ error: "orderId and productId are required" });
  }

  const product = UPSELL_PRODUCTS.find((p) => p.id === productId);
  if (!product) return res.status(400).json({ error: "Invalid upsell product" });

  const { rows } = await pool.query(
    `SELECT id, gr4vy_payment_method_id, email FROM orders WHERE id = $1`,
    [orderId]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found" });

  const order = rows[0];
  if (!order.gr4vy_payment_method_id) {
    return res.status(400).json({ error: "No saved payment method found for this order" });
  }

  // Create an upsell transaction record
  const { rows: upsellRows } = await pool.query(
    `INSERT INTO upsell_transactions (order_id, product_id, product_name, amount)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orderId, product.id, product.name, product.amount]
  );
  const upsellId = upsellRows[0].id as string;

  try {
    const gr4vy = createGr4vyClient();

    // Charge the saved payment method directly — no Embed needed
    const transaction = await gr4vy.transactions.create(
      {
        amount: product.amount,
        currency: product.currency,
        paymentMethod: {
          method: "id",
          id: order.gr4vy_payment_method_id,
          redirectUrl: `${process.env.APP_URL ?? "http://localhost:4000"}/confirmation.html?order_id=${orderId}`,
        },
        intent: "capture",
        paymentSource: "card_on_file",
        externalIdentifier: `upsell-${upsellId}`,
        metadata: { upsell: "true" },
        isSubsequentPayment: true,
      },
      getMerchantAccountId()
    );

    await pool.query(
      `UPDATE upsell_transactions
       SET gr4vy_transaction_id = $1, status = $2
       WHERE id = $3`,
      [transaction.id, transaction.status, upsellId]
    );

    return res.json({
      ok: true,
      transactionId: transaction.id,
      status: transaction.status,
      product: { name: product.name, amount: product.amount },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("Upsell charge failed:", err);
    await pool.query(
      `UPDATE upsell_transactions SET status = 'failed' WHERE id = $1`,
      [upsellId]
    );
    return res.status(502).json({ error: "Payment charge failed", detail: msg });
  }
});

export default router;
