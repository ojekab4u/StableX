import { randomUUID } from "node:crypto";
import { getPool } from "../db/pool.js";
import { readTransfer } from "../repositories/transferRepository.js";
import {
  createProviderOrderAttempt,
  updateProviderOrderAttempt,
  readProviderOrderAttempt,
} from "../repositories/providerOrderRepository.js";
import {
  createPaytrieTransaction,
  getPaytrieTransaction,
  getPaytrieReadiness,
} from "./paytrieService.js";
import { setTransferStatus } from "./transferService.js";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function assertOperatorConfirmation(confirm) {
  if (confirm !== true) throw fail("Set confirm=true to explicitly authorize creation of the Paytrie provider transaction.", 400);
}

async function getBaseWallet(customerId) {
  const result = await getPool().query(
    `SELECT address FROM external_wallets
     WHERE customer_id=$1 AND chain_id=8453 AND status='ACTIVE'
     ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  );
  if (!result.rowCount) throw fail("Connect the customer's Base Mainnet wallet (chain ID 8453) before creating a Paytrie USDC-BASE order.", 409);
  return result.rows[0].address;
}

function buildPaytrieRequest(transfer, wallet, attemptId) {
  const quote = transfer.quote || {};
  if (quote.provider !== "Paytrie" || quote.providerClass !== "LIVE" || quote.quoteType !== "LIVE_PROVIDER_QUOTE") {
    throw fail("Only a selected live Paytrie quote can be submitted as a provider order.", 409);
  }
  if (!quote.providerQuoteId || !Number.isInteger(Number(quote.providerQuoteId)) || Number(quote.providerQuoteId) <= 0) {
    throw fail("The selected transfer is missing Paytrie's original quoteId. Request and select a fresh Paytrie quote.", 409);
  }
  if (!quote.providerLeftSideLabel || !quote.providerRightSideLabel) {
    throw fail("The selected transfer is missing Paytrie's original currency labels. Request and select a fresh quote.", 409);
  }
  if (Date.parse(quote.expiresAt) <= Date.now()) {
    throw fail("The selected StableX quote has expired. Request and select a fresh quote.", 410);
  }
  const allowed = new Set(["CAD", "USDC-BASE", "CADC-BASE"]);
  if (!allowed.has(quote.providerLeftSideLabel) || !allowed.has(quote.providerRightSideLabel) ||
      quote.providerLeftSideLabel === quote.providerRightSideLabel) {
    throw fail("This first Paytrie order integration is limited to CAD, USDC-BASE and CADC-BASE pairs.", 400);
  }
  return {
    leftSideLabel: quote.providerLeftSideLabel,
    leftSideValue: Number(transfer.sourceAmount),
    rightSideLabel: quote.providerRightSideLabel,
    wallet,
    quoteId: Number(quote.providerQuoteId),
    externalSessionId: attemptId,
  };
}

export async function createPaytrieProviderOrder({ transferId, customerId, idempotencyKey, userJwt, confirm }) {
  assertOperatorConfirmation(confirm);
  if (typeof customerId !== "string" || customerId.length < 2) throw fail("A valid customerId is required.");
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8 || idempotencyKey.trim().length > 128) {
    throw fail("Send an Idempotency-Key header containing 8–128 characters.");
  }
  if (!getPaytrieReadiness().apiKeyPresent) {
    throw fail("Paytrie order creation is disabled. Configure PAYTRIE_API_KEY first; public quote access is not sufficient.", 503);
  }
  if (typeof userJwt !== "string" || userJwt.trim().length < 20) {
    throw fail("Authenticate the verified Paytrie customer and send its short-lived JWT in X-Paytrie-User-Token.", 401);
  }

  const transfer = await readTransfer(transferId, customerId);
  if (!transfer) throw fail("Transfer not found for this customer.", 404);
  if (transfer.status !== "QUOTED") throw fail(`Provider order requires a QUOTED transfer. Current status: ${transfer.status}.`, 409);
  const wallet = await getBaseWallet(customerId);
  const attemptId = randomUUID();
  const transaction = buildPaytrieRequest(transfer, wallet, attemptId);

  const created = await createProviderOrderAttempt({
    attemptId,
    transferId,
    customerId,
    provider: "Paytrie",
    idempotencyKey: idempotencyKey.trim(),
    request: transaction,
  });
  if (created.replayed) {
    return { replayed: true, attempt: created.attempt, message: "An attempt already exists for this transfer. StableX did not submit a second provider order." };
  }

  let result;
  try {
    result = await createPaytrieTransaction({ userJwt, transaction });
  } catch (error) {
    const status = error.statusCode && error.statusCode < 500 ? "REJECTED" : "UNKNOWN";
    const attempt = await updateProviderOrderAttempt({
      attemptId, status, errorMessage: error.message,
    });
    return {
      replayed: false,
      attempt,
      message: status === "UNKNOWN"
        ? "The provider outcome is uncertain. Do not retry this transfer; reconcile the attempt first."
        : "Paytrie rejected the transaction request. Correct the reported issue before creating a new transfer.",
    };
  }

  const providerOrderId = result.id ? String(result.id) : null;
  const providerStatus = result.status ? String(result.status) : "UNKNOWN";
  if (!providerOrderId) {
    const attempt = await updateProviderOrderAttempt({
      attemptId, status: "UNKNOWN", providerStatus, response: result,
      errorMessage: "Paytrie returned success without a transaction ID. Do not retry until reconciled.",
    });
    return { replayed: false, attempt, message: "Paytrie response did not include a transaction ID. The attempt is UNKNOWN and must be reconciled before any retry." };
  }

  const attempt = await updateProviderOrderAttempt({
    attemptId, status: "ACCEPTED", providerOrderId, providerStatus, response: result,
  });

  let transferStateWarning = null;
  if (providerStatus.toLowerCase() === "awaiting-fiat") {
    try {
      await setTransferStatus({
        id: transferId, customerId, status: "AWAITING_FUNDING",
        actorId: "PAYTRIE", reason: "Paytrie transaction created; awaiting customer fiat payment.",
      });
    } catch (error) {
      transferStateWarning = `Paytrie accepted the order, but StableX could not advance the transfer state: ${error.message}`;
    }
  }

  return {
    replayed: false,
    attempt,
    funding: {
      required: providerStatus.toLowerCase() === "awaiting-fiat",
      method: result.paymentType || "PAYTRIE_PAYMENT_INSTRUCTIONS",
      reference: result.rmtId || null,
    },
    transferStateWarning,
    message: "Paytrie accepted the transaction request. This is not proof of funding or settlement.",
  };
}

export async function getPaytrieProviderOrder({ transferId, customerId }) {
  return readProviderOrderAttempt({ transferId, customerId });
}

export async function refreshPaytrieProviderOrder({ transferId, customerId, userJwt }) {
  const attempt = await readProviderOrderAttempt({ transferId, customerId });
  if (!attempt) throw fail("No Paytrie provider order attempt exists for this transfer.", 404);
  if (!attempt.providerOrderId) {
    return { updated: false, attempt, reason: "No Paytrie transaction ID is available. An UNKNOWN creation attempt must be reconciled through provider support or webhook evidence; do not resubmit." };
  }
  const result = await getPaytrieTransaction({ userJwt, transactionId: attempt.providerOrderId });
  const providerStatus = String(result.status || "UNKNOWN");
  const updatedAttempt = await updateProviderOrderAttempt({
    attemptId: attempt.attemptId,
    status: "ACCEPTED",
    providerOrderId: attempt.providerOrderId,
    providerStatus,
    response: result,
  });

  const currentTransfer = await readTransfer(transferId, customerId);
  const providerState = providerStatus.toLowerCase();
  const desired = providerState === "awaiting-fiat" ? ["AWAITING_FUNDING"]
    : providerState === "processing-fiat" ? ["AWAITING_FUNDING", "FUNDED"]
    : ["finalizing-fiat", "sending-crypto", "complete"].includes(providerState)
      ? ["AWAITING_FUNDING", "FUNDED", "SETTLEMENT_PENDING"]
      : ["cancelled", "expired", "expired-contact-support", "refunded"].includes(providerState)
        ? ["FAILED"] : [];

  let latestStatus = currentTransfer?.status;
  for (const nextStatus of desired) {
    if (!latestStatus || latestStatus === nextStatus) continue;
    const allowedNext = {
      QUOTED: "AWAITING_FUNDING",
      AWAITING_FUNDING: "FUNDED",
      FUNDED: "SETTLEMENT_PENDING",
      SETTLEMENT_PENDING: null,
    };
    if (nextStatus === "FAILED") {
      if (["QUOTED", "AWAITING_FUNDING", "FUNDED", "SETTLEMENT_PENDING"].includes(latestStatus)) {
        const updated = await setTransferStatus({
          id: transferId, customerId, status: "FAILED", actorId: "PAYTRIE",
          reason: `Paytrie transaction status: ${providerStatus}`,
        });
        latestStatus = updated.status;
      }
      break;
    }
    if (allowedNext[latestStatus] !== nextStatus) continue;
    const updated = await setTransferStatus({
      id: transferId, customerId, status: nextStatus, actorId: "PAYTRIE",
      reason: `Reconciled Paytrie transaction status: ${providerStatus}`,
    });
    latestStatus = updated.status;
  }

  return {
    updated: true,
    providerStatus,
    transferStatus: latestStatus,
    attempt: updatedAttempt,
    note: providerState === "complete"
      ? "Paytrie reports complete. StableX remains at SETTLEMENT_PENDING until the blockchain transfer is independently verified."
      : "Provider status refreshed. No StableX completion or customer balance credit was fabricated.",
  };
}
