import { getHoneycoinTransaction } from "../services/providers/honeycoinService.js";

const transactionId = String(process.argv[2] || "").trim();
if (!transactionId) {
  console.error("Usage: node --env-file=.env scripts/inspect-honeycoin-transaction.mjs <transactionId>");
  process.exitCode = 1;
} else {
  try {
    const response = await getHoneycoinTransaction(transactionId);
    const provider = response?.data && typeof response.data === "object"
      ? response.data
      : response;
    const txId = provider?.txId || provider?.transactionHash || null;

    // Deliberately whitelist settlement fields. Never print the full provider
    // response because it may contain customer or payment information.
    console.log(JSON.stringify({
      transactionId: provider?.transactionId || transactionId,
      status: provider?.status ?? null,
      chargeStatus: provider?.chargeStatus ?? null,
      chain: provider?.chain ?? null,
      cryptoAmount: provider?.cryptoAmount ?? null,
      receiverAddressPresent: Boolean(provider?.receiverAddress),
      txIdPresent: Boolean(txId),
      txId: txId && /^0x[a-fA-F0-9]{64}$/.test(String(txId)) ? txId : null,
      topLevelKeys: Object.keys(response || {}).sort(),
      nestedDataKeys: response?.data && typeof response.data === "object"
        ? Object.keys(response.data).sort()
        : [],
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      error: error.message,
      statusCode: error.statusCode || null,
    }, null, 2));
    process.exitCode = 1;
  }
}
