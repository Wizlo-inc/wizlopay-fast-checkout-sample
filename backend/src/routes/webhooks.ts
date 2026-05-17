import { Router, Request, Response } from "express";
import { verifyWebhook } from "@gr4vy/sdk";
import pool from "../db";

const router = Router();

// POST /api/webhooks/gr4vy
router.post("/gr4vy", async (req: Request, res: Response) => {
  const rawBody = (req.body as Buffer).toString("utf8");
  const secret = process.env.GR4VY_WEBHOOK_SECRET;

  if (secret) {
    const signatureHeader = req.headers["gr4vy-signature"] as string | undefined;
    const timestampHeader = req.headers["gr4vy-timestamp"] as string | undefined;

    try {
      verifyWebhook(rawBody, secret, signatureHeader ?? "", timestampHeader ?? "", 300);
    } catch (err) {
      console.warn("Webhook signature verification failed:", err);
      return res.status(401).json({ error: "Invalid signature" });
    }
  } else {
    console.warn("GR4VY_WEBHOOK_SECRET not set — skipping signature verification");
  }

  let event: Record<string, any>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  const eventId: string   = event.id ?? event.event_id ?? "";
  const eventType: string = event.type ?? event.event_type ?? "";

  // Idempotency — skip already-processed events
  try {
    await pool.query(
      `INSERT INTO webhook_events (event_id, event_type, payload) VALUES ($1, $2, $3)`,
      [eventId, eventType, JSON.stringify(event)]
    );
  } catch (err: any) {
    if (err.code === "23505") {
      return res.json({ ok: true, duplicate: true });
    }
    throw err;
  }

  const txId: string = event.target?.id ?? event.context?.id ?? "";

  if (eventType === "transaction.capture.succeeded" || eventType === "transaction.captured") {
    if (txId) {
      await pool.query(
        `UPDATE orders SET status = 'paid', updated_at = NOW()
         WHERE gr4vy_transaction_id = $1 AND status != 'paid'`,
        [txId]
      );
      await pool.query(
        `UPDATE upsell_transactions SET status = 'captured'
         WHERE gr4vy_transaction_id = $1 AND status != 'captured'`,
        [txId]
      );
    }
  }

  if (eventType === "transaction.capture.declined" || eventType === "transaction.declined") {
    if (txId) {
      await pool.query(
        `UPDATE orders SET status = 'declined', updated_at = NOW()
         WHERE gr4vy_transaction_id = $1`,
        [txId]
      );
    }
  }

  if (eventType === "buyer.created") {
    const gr4vyBuyerId: string = event.target?.id ?? event.context?.id ?? "";
    const externalId: string   = event.target?.external_identifier ?? event.context?.external_identifier ?? "";
    if (gr4vyBuyerId && externalId) {
      await pool.query(
        `UPDATE buyers SET gr4vy_buyer_id = $1 WHERE external_id = $2`,
        [gr4vyBuyerId, externalId]
      );
    }
  }

  return res.json({ ok: true });
});

export default router;
