import { createHmac, timingSafeEqual } from "node:crypto";
import {
  insertPaytrieWebhookEvent,
  markPaytrieWebhookEvent,
  updatePaytrieCustomerStatusByProviderUserId,
} from "../repositories/paytrieOnboardingRepository.js";
import { readProviderOrderByPaytrieTransactionId } from "../repositories/providerOrderRepository.js";
import { refreshPaytrieOrder } from "./paytrieExecutionService.js";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export function verifyPaytrieWebhookSignature({
  rawBody, signature, timestamp, secret, now = Date.now(),
}) {
  if (typeof rawBody !== "string" || !rawBody || !secret || !signature || !timestamp) return false;
  if (!/^\d{10}$/.test(String(timestamp))) return false;
  const sentAt = Number(timestamp) * 1000;
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > 300_000) return false;
  const supplied = String(signature).replace(/^v1=/i, "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const expectedBytes = Buffer.from(expected, "hex");
  const suppliedBytes = Buffer.from(supplied, "hex");
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export async function processPaytrieWebhookEvent(event) {
  const eventId = event?.id || event?.eventId;
  const eventType = event?.type;
  const payload = event?.payload;
  if (typeof eventId !== "string" || !eventId || !["user.update", "transaction.update"].includes(eventType) || !payload || typeof payload !== "object") {
    throw fail("Invalid Paytrie v2 webhook envelope.", 400);
  }

  const inserted = await insertPaytrieWebhookEvent({ eventId, eventType });
  if (!inserted) return { received: true, duplicate: true, eventId };

  try {
    if (eventType === "user.update") {
      const { userId, email, status } = payload;
      if (!userId || !email || !status) throw fail("Paytrie user.update event is missing userId, email or status.");
      const customer = await updatePaytrieCustomerStatusByProviderUserId({
        providerUserId: String(userId),
        email: String(email).trim().toLowerCase(),
        status: String(status),
      });
      await markPaytrieWebhookEvent({
        eventId, status: customer ? "PROCESSED" : "UNMATCHED_CUSTOMER",
      });
      return { received: true, eventId, type: eventType, matched: Boolean(customer), customerStatus: customer?.providerStatus || null };
    }

    const transactionId = payload.transactionId;
    if (!transactionId) throw fail("Paytrie transaction.update event is missing transactionId.");
    const order = await readProviderOrderByPaytrieTransactionId(String(transactionId));
    if (!order) {
      await markPaytrieWebhookEvent({ eventId, status: "UNMATCHED_TRANSACTION" });
      return { received: true, eventId, type: eventType, matched: false };
    }

    try {
      const result = await refreshPaytrieOrder({
        transferId: order.transferId,
        customerId: order.customerId,
        accountType: "PERSONAL",
      });
      await markPaytrieWebhookEvent({
        eventId, status: result.settlementVerified ? "PROCESSED_SETTLED" : "PROCESSED_PENDING",
      });
      return {
        received: true, eventId, type: eventType, matched: true,
        providerStatus: result.providerStatus,
        settlementVerified: result.settlementVerified,
      };
    } catch (error) {
      // Webhooks are delivered once by Paytrie. Record the exception and acknowledge
      // the signed event; the customer can still reconcile using the authenticated
      // order-refresh endpoint without creating another order.
      await markPaytrieWebhookEvent({
        eventId, status: "RECEIVED_UNRECONCILED", errorMessage: error.message,
      });
      return { received: true, eventId, type: eventType, matched: true, reconciled: false, message: error.message };
    }
  } catch (error) {
    await markPaytrieWebhookEvent({ eventId, status: "PROCESSING_FAILED", errorMessage: error.message });
    throw error;
  }
}

export async function receivePaytrieWebhook({ rawBody, signature, timestamp }) {
  const secret = String(process.env.PAYTRIE_WEBHOOK_SECRET || "").trim();
  if (!secret) throw fail("Paytrie webhook signing secret is not configured on StableX.", 503);
  if (!verifyPaytrieWebhookSignature({ rawBody, signature, timestamp, secret })) {
    throw fail("Paytrie webhook signature is invalid or the timestamp is outside the five-minute replay window.", 401);
  }
  let event;
  try { event = JSON.parse(rawBody); }
  catch { throw fail("Paytrie webhook body is not valid JSON.", 400); }
  return processPaytrieWebhookEvent(event);
}
