import crypto from "node:crypto";
import { postProviderCredit } from "./walletService.js";
import { findCustomerIdByBridgeId } from "../repositories/providerCustomerRepository.js";

// Bridge signs each delivery as: X-Webhook-Signature: t=<ms>,v0=<base64 RSA signature>
// Signed content is SHA256(SHA256("<t>.<raw body>")). Node's crypto.verify hashes
// its input once, so we pass the first digest and let it apply the second.
export const BRIDGE_WEBHOOK_MAX_AGE_MS = 10 * 60 * 1000;

export function verifyBridgeSignature({ rawBody, header, publicKeyPem, nowMs = Date.now() }) {
  const parts = Object.fromEntries(
    String(header || "").split(",").map((p) => p.trim().split("=", 2)).filter((p) => p.length === 2)
  );
  const timestamp = Number(parts.t);
  const signature = parts.v0;
  if (!publicKeyPem || !Number.isFinite(timestamp) || !signature) return { ok: false, reason: "missing_signature_parts" };
  if (Math.abs(nowMs - timestamp) > BRIDGE_WEBHOOK_MAX_AGE_MS) return { ok: false, reason: "stale_timestamp" };
  const digest = crypto.createHash("sha256").update(`${timestamp}.${rawBody}`).digest();
  const valid = crypto.verify("sha256", digest, publicKeyPem, Buffer.from(signature, "base64"));
  return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
}

// Credits the customer's USDC wallet when a deposit is fully processed on-chain.
// We credit on payment_processed (final), not funding, so nothing is credited
// before the USDC has actually been delivered.
export async function applyBridgeVirtualAccountEvent(event) {
  if (event?.event_category !== "virtual_account.activity") return { handled: false, reason: "not_virtual_account" };
  const obj = event.event_object || {};
  if (obj.type !== "payment_processed") return { handled: false, reason: `ignored_${obj.type || "unknown"}` };

  const customerId = await findCustomerIdByBridgeId(obj.customer_id);
  if (!customerId) return { handled: false, reason: "unknown_bridge_customer" };

  const usdc = Number(obj.receipt?.final_amount);
  const credit = await postProviderCredit({
    customerId,
    currency: "USDC",
    amount: usdc,
    provider: "Bridge",
    providerEventId: event.event_id,
    reference: obj.deposit_id || obj.id,
    metadata: {
      virtualAccountId: obj.virtual_account_id,
      depositId: obj.deposit_id,
      sourceCurrency: obj.currency,
      sourceAmount: obj.amount,
      sourceRail: obj.source?.payment_rail,
      receipt: obj.receipt,
    },
  });
  return { handled: true, ...credit };
}
