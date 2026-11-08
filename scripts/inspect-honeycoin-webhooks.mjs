import {
  getHoneycoinWebhookDeliveries,
  getHoneycoinWebhookDelivery,
} from "../services/providers/honeycoinService.js";

const reference = String(process.argv[2] || "").trim();
if (!reference) {
  console.error("Usage: node --env-file=.env scripts/inspect-honeycoin-webhooks.mjs <transactionId-or-externalReference>");
  process.exitCode = 1;
} else {
  try {
    const result = await getHoneycoinWebhookDeliveries(reference);
    const candidates = Array.isArray(result)
      ? result
      : result?.webhooks || result?.events || result?.deliveries || result?.data || [];
    const entries = Array.isArray(candidates) ? candidates : [];

    const safeEvent = (entry, detail = null) => {
      const body = detail?.payload || detail?.body || detail?.eventPayload
        || entry?.payload || entry?.body || entry?.eventPayload || detail || entry;
      const data = body?.data || body;
      const txId = data?.txId || data?.transactionHash || null;
      return {
        webhookId: detail?.id || body?.id || body?.webhookLogId || entry?.webhookLogId || entry?.webhookId || entry?.id || null,
        webhookIdSource: detail?.id ? "detail.id" : body?.id ? "payload.id" : body?.webhookLogId ? "payload.webhookLogId" : entry?.webhookLogId ? "entry.webhookLogId" : entry?.webhookId ? "entry.webhookId" : "entry.id",
        webhookLogId: body?.webhookLogId || entry?.webhookLogId || null,
        createdAt: body?.createdAt || entry?.createdAt || null,
        event: body?.event || entry?.event || detail?.event || null,
        deliveryStatus: detail?.status || detail?.deliveryStatus
          || entry?.status || entry?.deliveryStatus || null,
        lastAttemptStatus: detail?.lastAttempt?.status || detail?.lastAttempt?.responseStatus || null,
        lastAttemptHttpCode: detail?.lastAttempt?.httpStatus
          || detail?.lastAttempt?.statusCode || detail?.lastAttempt?.code || null,
        attemptCount: Array.isArray(detail?.attempts) ? detail.attempts.length : null,
        transactionId: data?.transactionId || null,
        externalReference: data?.externalReference || null,
        transactionType: data?.type || null,
        status: data?.status || null,
        chargeStatus: data?.chargeStatus || null,
        chain: data?.chain || null,
        receiverCurrency: data?.receiverCurrency || null,
        cryptoAmount: data?.cryptoAmount || data?.receiverAmount || null,
        receiverAddress: data?.receiverAddress || null,
        txId: txId && /^0x[a-fA-F0-9]{64}$/.test(String(txId)) ? txId : null,
        timestamp: body?.timestamp || entry?.timestamp || detail?.timestamp || null,
        detailKeys: detail && typeof detail === "object" ? Object.keys(detail).sort() : [],
        payloadKeys: body && typeof body === "object" ? Object.keys(body).sort() : [],
        dataKeys: data && typeof data === "object" ? Object.keys(data).sort() : [],
      };
    };

    const inspected = await Promise.all(entries.map(async (entry) => {
      const eventBody = entry?.payload || entry?.body || entry?.eventPayload || entry;
      const id = eventBody?.id || eventBody?.webhookLogId || entry?.webhookLogId || entry?.webhookId || entry?.id;
      if (!id) return safeEvent(entry);
      try {
        const detail = await getHoneycoinWebhookDelivery(String(id));
        return safeEvent(entry, detail);
      } catch (error) {
        return {
          ...safeEvent(entry),
          detailLookupError: error.message,
          detailLookupStatus: error.statusCode || null,
        };
      }
    }));

    console.log(JSON.stringify({
      reference,
      responseKeys: Object.keys(result || {}).sort(),
      eventsFound: entries.length,
      events: inspected,
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      error: error.message,
      statusCode: error.statusCode || null,
    }, null, 2));
    process.exitCode = 1;
  }
}
