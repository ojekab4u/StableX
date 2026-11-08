import { getHoneycoinWebhookDeliveries } from "../services/providers/honeycoinService.js";

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
    const events = entries.map((entry) => {
      const body = entry?.payload || entry?.body || entry?.eventPayload || entry;
      const data = body?.data || body;
      const txId = data?.txId || data?.transactionHash || null;
      return {
        event: body?.event || entry?.event || null,
        deliveryStatus: entry?.status || entry?.deliveryStatus || null,
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
        timestamp: body?.timestamp || entry?.timestamp || null,
      };
    });
    console.log(JSON.stringify({
      reference,
      responseKeys: Object.keys(result || {}).sort(),
      eventsFound: events.length,
      events,
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      error: error.message,
      statusCode: error.statusCode || null,
    }, null, 2));
    process.exitCode = 1;
  }
}
