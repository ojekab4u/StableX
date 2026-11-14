import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { readProviderOrderByReference } from "../repositories/providerOrderRepository.js";
import { refreshHoneycoinOrder } from "../services/providerOrderService.js";

export const honeycoinWebhookRouter = Router();

function signaturesMatch(received, expected) {
  if (typeof received !== "string" || !expected) return false;
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

// Honeycoin's documented X-Webhook-Signature is the shared secret configured
// by the account owner in the Honeycoin dashboard (not an HMAC digest).
honeycoinWebhookRouter.post("/", async (req, res) => {
  const secret = String(process.env.HONEYCOIN_WEBHOOK_SECRET || "");
  if (!secret) {
    return res.status(503).json({ error: "Honeycoin webhook secret is not configured." });
  }
  if (!signaturesMatch(req.get("X-Webhook-Signature"), secret)) {
    return res.status(401).json({ error: "Invalid Honeycoin webhook signature." });
  }

  const event = String(req.body?.event || "").trim().toLowerCase();
  const data = req.body?.data;
  const eventType = String(data?.type || "").trim().toLowerCase();
  const supportedEvent = event === "onramp_updated" ||
    (event === "transaction_updated" && eventType === "onramp");
  if (!supportedEvent || !data || typeof data !== "object" || eventType !== "onramp") {
    return res.status(202).json({ accepted: true, ignored: true, reason: "Not a Honeycoin on-ramp update." });
  }

  const reference = String(data.externalReference || data.transactionId || "").trim();
  if (!reference) {
    return res.status(400).json({ error: "Webhook is missing externalReference and transactionId." });
  }

  try {
    const order = await readProviderOrderByReference(reference);
    if (!order) {
      return res.status(404).json({ error: "No StableX Honeycoin order matches this webhook." });
    }
    if (data.transactionId && order.providerTransactionId &&
        String(data.transactionId) !== String(order.providerTransactionId)) {
      return res.status(409).json({ error: "Webhook transaction ID does not match the stored provider order." });
    }
    if (data.externalReference && String(data.externalReference) !== order.externalReference) {
      return res.status(409).json({ error: "Webhook external reference does not match the stored provider order." });
    }

    const result = await refreshHoneycoinOrder({
      transferId: order.transferId,
      customerId: order.customerId,
      providerPayload: data,
    });
    return res.status(200).json({
      accepted: true,
      settlementVerified: Boolean(result.settlementVerified),
      orderStatus: result.order?.status || null,
    });
  } catch (error) {
    return res.status(error.statusCode || 503).json({
      error: error.message || "Unable to reconcile Honeycoin webhook.",
    });
  }
});
