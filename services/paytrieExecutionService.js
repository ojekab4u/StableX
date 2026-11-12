import { randomUUID } from "node:crypto";
import {
  createPublicClient, decodeEventLog, http, isAddress, parseAbi, parseUnits,
} from "viem";
import { base } from "viem/chains";
import { readTransfer, updateTransferStatus } from "../repositories/transferRepository.js";
import {
  createProviderOrder, readProviderOrderByTransfer, updateProviderOrder,
} from "../repositories/providerOrderRepository.js";
import { decryptBeneficiaryDetails, encryptBeneficiaryDetails } from "./beneficiaryCrypto.js";
import { savePaytrieCustomerSession, getPaytrieCustomerSession, deletePaytrieCustomerSession } from "../repositories/paytrieCustomerRepository.js";
import { getCustomerGateStatus } from "./complianceService.js";

const API_BASE = "https://api.paytrie.com/v2";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function apiKey() {
  const value = String(process.env.PAYTRIE_API_KEY || "").trim();
  if (!value || /^(key|your[_ -].*|replace[_ -].*|changeme|placeholder)$/i.test(value)) {
    throw fail("PAYTRIE_API_KEY is not configured. Add the Paytrie-issued API key to the server .env for this personal-account test or approved integration.", 503);
  }
  return value;
}
async function request(path, { method = "GET", jwt, body } = {}) {
  const response = await fetch(API_BASE + path, {
    method,
    headers: {
      Accept: "application/json", "Content-Type": "application/json",
      "x-api-key": apiKey(), ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw.slice(0, 1000) }; }
  if (!response.ok || data.success === false) {
    const detail = Array.isArray(data.errors) ? data.errors.map(x => x.message).filter(Boolean).join("; ") : "";
    throw fail(detail || data.message || data.error || `Paytrie HTTP ${response.status}`, response.status >= 500 ? 502 : response.status);
  }
  return data.data ?? data;
}

export function isPaytriePlatformExecutionApproved() {
  return String(process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED || "").trim().toLowerCase() === "true";
}

export function isPaytriePersonalTestModeEnabled(customerId, accountType) {
  const enabled = String(process.env.PAYTRIE_PERSONAL_TEST_MODE || "").trim().toLowerCase() === "true";
  const allowedCustomerId = String(process.env.PAYTRIE_PERSONAL_TEST_CUSTOMER_ID || "").trim();
  return enabled && Boolean(allowedCustomerId) && customerId === allowedCustomerId && accountType === "PERSONAL";
}

export function getPaytrieExecutionReadiness({ customerId, accountType } = {}) {
  let keyPresent = false;
  try { apiKey(); keyPresent = true; } catch {}
  const platformApproved = isPaytriePlatformExecutionApproved();
  const personalTestModeEnabled = isPaytriePersonalTestModeEnabled(customerId, accountType);
  return {
    provider: "Paytrie",
    apiVersion: "v2",
    apiKeyPresent: keyPresent,
    customerJwtRequired: true,
    platformAuthorizationRequired: true,
    platformExecutionApproved: platformApproved,
    personalTestModeEnabled,
    transactionCreationEnabled: keyPresent && (platformApproved || personalTestModeEnabled),
    status: !keyPresent ? "API_KEY_MISSING" : personalTestModeEnabled ? "PERSONAL_ACCOUNT_TEST_MODE_READY" : !platformApproved ? "PAYTRIE_PLATFORM_APPROVAL_REQUIRED" : "CONFIGURED_AWAITING_CUSTOMER_AUTH",
    supportedExecutionRoute: "CAD -> USDC-BASE",
    note: personalTestModeEnabled
      ? "Restricted local test: only the configured StableX PERSONAL account may authenticate its own Paytrie retail account and submit its own transaction. This does not approve StableX platform execution."
      : platformApproved
        ? "Platform execution is enabled by local configuration; use only within Paytrie's approved partner scope."
        : "Platform execution is disabled. A separately configured, single-customer personal-account test may be enabled for local development; it does not authorize platform or other customer transactions."
  };
}
export async function requestPaytrieLoginCode(email) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw fail("Enter the registered Paytrie customer email.");
  return request("/auth/login-codes", { method: "POST", body: { email: email.trim().toLowerCase() } });
}
export async function verifyPaytrieLoginCode({ email, code }) {
  if (typeof email !== "string" || typeof code !== "string" || !/^\d{4}$/.test(code.trim())) throw fail("Enter the registered email and 4-digit Paytrie code.");
  const result = await request("/auth/login-codes/verify", { method: "POST", body: { email: email.trim().toLowerCase(), code: code.trim() } });
  if (!result.accessToken) throw fail("Paytrie did not return an access token.", 502);
  return { accessToken: result.accessToken, tokenType: result.tokenType || "Bearer", expiresIn: result.expiresIn || 3600 };
}

// Customer authentication is bound to the authenticated StableX account ID and the customer's Paytrie-registered email.
// Paytrie JWTs are encrypted at rest and never returned to the browser.
export async function requestPaytrieCustomerLoginCode({ customerId, email }) {
  if (!customerId || typeof email !== "string") throw fail("Authenticated StableX customer is required.", 401);
  await requestPaytrieLoginCode(email);
  return { requested: true, email, message: "Paytrie login code requested. Verify the code to link this Paytrie customer session to your signed-in StableX account." };
}

export async function verifyPaytrieCustomerLoginCode({ customerId, email, code }) {
  if (!customerId || typeof email !== "string") throw fail("Authenticated StableX customer is required.", 401);
  const session = await verifyPaytrieLoginCode({ email, code });
  const expiresAt = new Date(Date.now() + Number(session.expiresIn || 3600) * 1000).toISOString();
  await savePaytrieCustomerSession({
    customerId,
    encryptedToken: encryptBeneficiaryDetails({ accessToken: session.accessToken, email: email.trim().toLowerCase() }),
    expiresAt,
  });
  return { authenticated: true, expiresAt, tokenType: session.tokenType, message: "Paytrie customer authentication stored securely for this StableX account." };
}

export async function getPaytrieCustomerAuthStatus(customerId) {
  const session = await getPaytrieCustomerSession(customerId);
  return {
    authenticated: Boolean(session),
    expiresAt: session?.expiresAt || null,
    message: session ? "A valid Paytrie customer session is available." : "Paytrie customer authentication is required or has expired.",
  };
}

async function getStoredPaytrieCustomerJwt(customerId) {
  const session = await getPaytrieCustomerSession(customerId);
  if (!session) throw fail("Paytrie customer authentication is missing or expired. Request a new login code.", 401);
  const decrypted = decryptBeneficiaryDetails(session.encryptedToken);
  if (!decrypted.accessToken) throw fail("Stored Paytrie customer session is invalid. Authenticate again.", 401);
  return decrypted.accessToken;
}

export async function logoutPaytrieCustomer({ customerId }) {
  await deletePaytrieCustomerSession(customerId);
  return { authenticated: false, message: "Paytrie customer session revoked from StableX." };
}

function safeOrder(order) {
  const secret = order.paymentDetails ? decryptBeneficiaryDetails(order.paymentDetails) : {};
  return { ...order, paymentDetails: secret.instructions || null, redirectUrl: secret.redirectUrl || null, providerResponse: secret.providerResponse || null };
}
async function baseWallet(customerId) {
  const { getPool } = await import("../db/pool.js");
  const result = await getPool().query(
    "SELECT address FROM external_wallets WHERE customer_id=$1 AND chain_id=8453 AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1",
    [customerId],
  );
  if (!result.rowCount || !isAddress(result.rows[0].address)) throw fail("Connect and verify the customer's Base Mainnet wallet (chain ID 8453) first.", 409);
  return result.rows[0].address;
}
function selectedPaytrieQuote(transfer) {
  const quote = transfer.quote || {};
  if (quote.provider !== "Paytrie" || quote.providerClass !== "LIVE" || quote.quoteType !== "LIVE_PROVIDER_QUOTE") throw fail("Select a live Paytrie quote before creating this order.", 409);
  if (Date.parse(quote.expiresAt) <= Date.now()) throw fail("The selected quote has expired. Request a fresh quote.", 410);
  const raw = quote.providerData || quote.raw || {};
  const quoteId = quote.providerQuoteId ?? raw.quoteId;
  const left = quote.providerLeftSideLabel || raw.leftSideLabel;
  const right = quote.providerRightSideLabel || raw.rightSideLabel;
  if (!quoteId || !left || !right) throw fail("The selected quote is missing Paytrie's original quote ID or currency labels. Select a fresh quote.", 409);
  if (left !== "CAD" || right !== "USDC-BASE") throw fail("The first executable Paytrie flow is CAD -> USDC on Base. CADC and sell-side execution remain gated until their settlement rules are verified.", 409);
  return { quoteId: Number(quoteId), left, right };
}
async function verifyUsdcReceipt({ hash, wallet, expectedAmount }) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(String(hash || ""))) return { verified: false, reason: "Paytrie has not supplied a valid Base transaction hash." };
  let receipt;
  try { receipt = await publicClient.getTransactionReceipt({ hash }); } catch { return { verified: false, reason: "The transaction is not yet available on Base Mainnet." }; }
  if (receipt.status !== "success") return { verified: false, reason: "The Base transaction failed." };
  let amount = null;
  if (expectedAmount !== undefined && expectedAmount !== null) {
    try { amount = parseUnits(String(expectedAmount), 6); } catch { return { verified: false, reason: "Provider-reported USDC amount has invalid precision." }; }
  }
  const matched = receipt.logs.some(log => {
    if (log.address.toLowerCase() !== USDC_BASE.toLowerCase()) return false;
    try {
      const event = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics });
      return event.eventName === "Transfer" && event.args.to.toLowerCase() === wallet.toLowerCase() && event.args.value > 0n && (amount === null || event.args.value === amount);
    } catch { return false; }
  });
  return matched ? { verified: true, blockNumber: receipt.blockNumber.toString() } : { verified: false, reason: "The Base receipt does not contain the expected USDC transfer to the saved wallet." };
}
export async function createPaytrieOrder({ transferId, customerId, accountType, jwt, confirm }) {
  const platformApproved = isPaytriePlatformExecutionApproved();
  const personalTestMode = isPaytriePersonalTestModeEnabled(customerId, accountType);
  if (!platformApproved && !personalTestMode) {
    const personalTestConfigured =
      String(process.env.PAYTRIE_PERSONAL_TEST_MODE || "").trim().toLowerCase() === "true" &&
      Boolean(String(process.env.PAYTRIE_PERSONAL_TEST_CUSTOMER_ID || "").trim());
    if (personalTestConfigured) {
      throw fail("Paytrie personal-account test mode is restricted to the single StableX PERSONAL account configured for local testing.", 403);
    }
    throw fail("Paytrie platform execution is disabled. A local personal-account test must be explicitly configured for one StableX PERSONAL account.", 403);
  }
  if (confirm !== true) throw fail("Explicit confirmation is required before submitting a real Paytrie transaction.");
  apiKey(); // Fail before reserving an order if the provider credential is missing.
  const customerJwt = typeof jwt === "string" && jwt.trim().length >= 20 ? jwt.trim() : await getStoredPaytrieCustomerJwt(customerId);
  const transfer = await readTransfer(transferId, customerId);
  if (!transfer) throw fail("Transfer not found for this customer.", 404);
  if (transfer.status !== "QUOTED") throw fail(`Only a QUOTED transfer can be submitted. Current status: ${transfer.status}.`, 409);
  if (transfer.sourceCurrency !== "CAD" || transfer.destinationCurrency !== "USDC") throw fail("This first executable adapter supports CAD -> USDC only.", 409);
  const gate = await getCustomerGateStatus(customerId);
  if (!gate.gate.approved) throw fail(`StableX compliance gate is ${gate.gate.status}; approval is required.`, 403);
  const quote = selectedPaytrieQuote(transfer);
  const wallet = await baseWallet(customerId);
  const existing = await readProviderOrderByTransfer(transferId, customerId);
  if (existing) return { created: false, order: safeOrder(existing), message: "A provider order already exists for this transfer. No duplicate Paytrie request was sent." };
  const orderId = randomUUID();
  const externalReference = `stablex-${transferId}`;
  const transaction = {
    leftSideLabel: quote.left,
    leftSideValue: Number(transfer.sourceAmount),
    rightSideLabel: quote.right,
    wallet,
    quoteId: quote.quoteId,
    externalSessionId: orderId,
  };
  const reserved = await createProviderOrder({
    orderId, transferId, customerId, provider: "Paytrie",
    externalReference, paymentMethod: "INTERAC", recipientAddress: wallet,
  });
  if (!reserved.created) return { created: false, order: reserved.order ? safeOrder(reserved.order) : null, message: "An order already exists; no duplicate provider request was sent." };
  let result;
  try {
    result = await request("/transactions", { method: "POST", jwt: customerJwt, body: transaction });
  } catch (error) {
    const updated = await updateProviderOrder({
      orderId, customerId, status: error.statusCode >= 500 ? "UNKNOWN" : "REJECTED",
      failureReason: error.message,
    });
    return { created: false, order: safeOrder(updated), message: error.statusCode >= 500 ? "The provider outcome is uncertain. Reconcile before retrying; do not submit another order." : "Paytrie rejected the transaction request." };
  }
  const transactionId = result.id ? String(result.id) : null;
  const providerStatus = String(result.status || "UNKNOWN");
  const paymentDetails = encryptBeneficiaryDetails({
    instructions: { rmtId: result.rmtId || null, paymentType: result.paymentType || null, status: providerStatus },
    redirectUrl: result.redirectUrl || null,
    providerResponse: result,
  });
  const updated = await updateProviderOrder({
    orderId, customerId, providerTransactionId: transactionId,
    status: transactionId ? (providerStatus.toLowerCase() === "awaiting-fiat" ? "AWAITING_PAYMENT" : "PROVIDER_ACCEPTED") : "UNKNOWN",
    providerStatus, paymentDetails,
    failureReason: transactionId ? null : "Paytrie returned no transaction ID; reconcile before retrying.",
  });
  if (providerStatus.toLowerCase() === "awaiting-fiat") {
    await updateTransferStatus({ id: transferId, customerId, status: "AWAITING_FUNDING", actorId: "PAYTRIE", reason: "Paytrie transaction created; awaiting the customer's Interac payment." });
  }
  return { created: Boolean(transactionId), order: safeOrder(updated), funding: { required: providerStatus.toLowerCase() === "awaiting-fiat", reference: result.rmtId || null, paymentType: result.paymentType || null }, message: "Paytrie transaction submitted. This response is not proof of payment or USDC settlement." };
}
export async function getPaytrieOrderForTransfer({ transferId, customerId }) {
  const [order, transfer] = await Promise.all([
    readProviderOrderByTransfer(transferId, customerId),
    readTransfer(transferId, customerId),
  ]);
  if (!transfer) throw fail("Transfer not found for this customer.", 404);
  if (!order || order.provider !== "Paytrie") return { transfer, order: null, message: "No Paytrie order exists for this transfer." };
  return {
    transfer,
    order: safeOrder(order),
    message: "Saved Paytrie order recovered from StableX storage. Refresh provider status for the latest update.",
  };
}

export async function refreshPaytrieOrder({ transferId, customerId, accountType, jwt }) {
  if (!isPaytriePlatformExecutionApproved() && !isPaytriePersonalTestModeEnabled(customerId, accountType)) throw fail("Paytrie order refresh is restricted to the configured personal-account test customer or an approved platform account.", 403);
  const order = await readProviderOrderByTransfer(transferId, customerId);
  if (!order || order.provider !== "Paytrie") throw fail("No Paytrie order exists for this transfer.", 404);
  if (!order.providerTransactionId) return { order: safeOrder(order), refreshed: false, message: "No provider transaction ID is stored. Do not retry an ambiguous create request." };
  const customerJwt = typeof jwt === "string" && jwt.trim().length >= 20 ? jwt.trim() : await getStoredPaytrieCustomerJwt(customerId);
  const result = await request(`/transactions/${encodeURIComponent(order.providerTransactionId)}`, { jwt: customerJwt });
  const status = String(result.status || "UNKNOWN");
  const state = status.toLowerCase();
  let transfer = await readTransfer(transferId, customerId);
  if (["cancelled", "expired", "expired-contact-support", "refunded"].includes(state)) {
    if (transfer && !["FAILED", "COMPLETED"].includes(transfer.status)) await updateTransferStatus({ id: transferId, customerId, status: "FAILED", actorId: "PAYTRIE", reason: `Paytrie status: ${status}` });
  } else if (["processing-fiat"].includes(state) && transfer?.status === "AWAITING_FUNDING") {
    await updateTransferStatus({ id: transferId, customerId, status: "FUNDED", actorId: "PAYTRIE", reason: "Paytrie reports fiat processing." });
  } else if (["finalizing-fiat", "sending-crypto", "complete"].includes(state) && ["AWAITING_FUNDING", "FUNDED"].includes(transfer?.status)) {
    if (transfer.status === "AWAITING_FUNDING") await updateTransferStatus({ id: transferId, customerId, status: "FUNDED", actorId: "PAYTRIE", reason: "Paytrie reports fiat processing/finalization." });
    await updateTransferStatus({ id: transferId, customerId, status: "SETTLEMENT_PENDING", actorId: "PAYTRIE", reason: `Paytrie reports ${status}; waiting for Base verification.` });
  }
  const hash = result.transactionHash || result.txHash || result.txid || result.paymentId || null;
  const expected = result.rightSideValue ?? result.cryptoAmount ?? transfer?.destinationAmount ?? null;
  let verification = { verified: false, reason: "Paytrie has not supplied a verifiable Base USDC settlement transaction yet." };
  if (state === "complete" && hash) verification = await verifyUsdcReceipt({ hash, wallet: order.recipientAddress, expectedAmount: expected });
  let finalStatus = state === "complete" && verification.verified ? "COMPLETED" : (state === "complete" ? "SETTLEMENT_PENDING" : order.status);
  const paymentDetails = encryptBeneficiaryDetails({
    instructions: { rmtId: result.rmtId || null, paymentType: result.paymentType || null, status },
    redirectUrl: result.redirectUrl || null,
    providerResponse: result,
  });
  const updated = await updateProviderOrder({
    orderId: order.orderId, customerId, providerStatus: status,
    status: finalStatus, transactionHash: hash,
    paymentDetails,
    failureReason: finalStatus === "SETTLEMENT_PENDING" ? verification.reason : null,
  });
  if (finalStatus === "COMPLETED") {
    transfer = await readTransfer(transferId, customerId);
    if (transfer?.status === "SETTLEMENT_PENDING") await updateTransferStatus({ id: transferId, customerId, status: "COMPLETED", actorId: "BASE_MAINNET", reason: `Paytrie USDC transfer verified in block ${verification.blockNumber}; tx ${hash}` });
  }
  return { order: safeOrder(updated), providerStatus: status, settlementVerified: verification.verified, verification, message: verification.verified ? "Paytrie transaction and Base USDC settlement verified." : "Provider status refreshed; StableX has not marked this transfer completed without Base verification." };
}
