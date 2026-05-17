import { Router, Request, Response } from "express";
import pool from "../db";
import { MAIN_PRODUCTS } from "../products";

const router = Router();

// POST /api/orders — create a new order from personal details form
router.post("/", async (req: Request, res: Response) => {
  const { firstName, lastName, email, mobile, productId } = req.body;

  if (!firstName || !lastName || !email || !mobile || !productId) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const product = MAIN_PRODUCTS.find((p) => p.id === productId);
  if (!product) {
    return res.status(400).json({ error: "Invalid product" });
  }

  const buyerExternalId = email.toLowerCase().trim();

  const { rows } = await pool.query(
    `INSERT INTO orders
       (first_name, last_name, email, mobile, product_id, product_name, amount, currency, buyer_external_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [firstName, lastName, email, mobile, product.id, product.name, product.amount, product.currency, buyerExternalId]
  );

  // Upsert buyer record (may already exist from a prior order)
  await pool.query(
    `INSERT INTO buyers (external_id, email)
     VALUES ($1, $2)
     ON CONFLICT (external_id) DO NOTHING`,
    [buyerExternalId, email]
  );

  return res.json({ orderId: rows[0].id });
});

// GET /api/orders/:id — fetch order summary for checkout page
router.get("/:id", async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, first_name, last_name, email, mobile, product_id, product_name,
            amount, currency, status, shipping_address, gr4vy_payment_method_id
     FROM orders WHERE id = $1`,
    [req.params.id]
  );

  if (!rows.length) return res.status(404).json({ error: "Order not found" });

  return res.json(rows[0]);
});

export default router;
