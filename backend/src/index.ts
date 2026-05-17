import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.join(__dirname, "../../.env") });
import express from "express";
import cors from "cors";

import ordersRouter from "./routes/orders";
import paymentRouter from "./routes/payment";
import upsellRouter from "./routes/upsell";
import webhooksRouter from "./routes/webhooks";
import { MAIN_PRODUCTS, UPSELL_PRODUCTS } from "./products";

const app = express();
const PORT = process.env.PORT ?? 4000;

// Raw body for webhook signature verification — must come before json()
app.use("/api/webhooks", express.raw({ type: "application/json" }));

app.use(cors());
app.use(express.json());

// Serve the Wizlo design system tokens from localhost:3000 via a proxy-style redirect
// (design system is served separately on :3000 — no action needed here)

// API routes
app.use("/api/orders", ordersRouter);
app.use("/api/payment", paymentRouter);
app.use("/api/upsell", upsellRouter);
app.use("/api/webhooks", webhooksRouter);

// Expose public config the frontend needs (no secrets)
app.get("/api/config", (_req, res) => {
  res.json({
    gr4vyId: process.env.GR4VY_ID ?? "",
    environment: process.env.GR4VY_ENVIRONMENT ?? "sandbox",
    merchantAccountId: process.env.WIZLOPAY_MERCHANT_ACCOUNT_ID ?? process.env.GR4VY_MERCHANT_ACCOUNT_ID ?? null,
    products: MAIN_PRODUCTS,
    upsellProducts: UPSELL_PRODUCTS,
  });
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, "../../public")));

// SPA fallback — serve index.html for unmatched routes
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "../../public/index.html"));
});

app.listen(PORT, () => {
  console.log(`✓ Checkout server running at http://localhost:${PORT}`);
  console.log(`  gr4vy instance: ${process.env.GR4VY_ID ?? "(not set)"} [${process.env.GR4VY_ENVIRONMENT ?? "sandbox"}]`);
});
