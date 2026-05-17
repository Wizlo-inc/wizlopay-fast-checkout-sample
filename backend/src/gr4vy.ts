import { Gr4vy, getEmbedToken, withToken } from "@gr4vy/sdk";
import type { CartItem } from "@gr4vy/sdk/models/components/cartitem.js";

function getPrivateKey(): string {
  const key = process.env.GR4VY_PRIVATE_KEY;
  if (!key) throw new Error("GR4VY_PRIVATE_KEY is not set");
  return key
    .replace(/\\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

export function getMerchantAccountId(): string | undefined {
  return process.env.WIZLOPAY_MERCHANT_ACCOUNT_ID || process.env.GR4VY_MERCHANT_ACCOUNT_ID || undefined;
}

export function createGr4vyClient() {
  return new Gr4vy({
    server: (process.env.GR4VY_ENVIRONMENT as "sandbox" | "production") ?? "sandbox",
    id: process.env.GR4VY_ID!,
    bearerAuth: withToken({ privateKey: getPrivateKey() }),
  });
}

export async function generateEmbedToken(params: {
  amount: number;
  currency: string;
  buyerExternalIdentifier: string;
  checkoutSessionId: string;
  cartItems?: CartItem[];
}) {
  const merchantAccountId = getMerchantAccountId();

  return getEmbedToken({
    privateKey: getPrivateKey(),
    checkoutSessionId: params.checkoutSessionId,
    embedParams: {
      amount:                  params.amount,
      currency:                params.currency,
      buyerExternalIdentifier: params.buyerExternalIdentifier,
      ...(params.cartItems  ? { cartItems: params.cartItems } : {}),
      ...(merchantAccountId ? { merchantAccountId }           : {}),
    },
  });
}
