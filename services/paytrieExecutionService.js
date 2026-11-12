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
import { getCustomerGateStatus } from "./complianceService.js";

const API_BASE = "https://api.paytrie.com/v2";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function apiKey() {
  const value = String(process.env.PAYTRIE_API_KEY || "").trim();
  if (!value || /^(key|your[_ -].*|replace[_ -].*|changeme|placeholder)$/i.test(value)) {
    throw fail("PAYTRIE_API_KEY is not configured. Add the Paytrie-issued API key for the approved StableX integration to the server .env.", 503);
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

export function getPaytrieExecutionReadiness() {
  let keyPresent = false;
  try { apiKey(); keyPresent = true; } catch {}
  const platformApproved = isPaytriePlatformExecutionApproved();
  return {
    provider: "Paytrie",
    apiVersion: "v2",
    apiKeyPresent: keyPresent,
    customerAuthenticationModel: "AWAITING_PAYTRIE_PLATFORM_CONFIRMATION",
    platformAuthorizationRequired: true,
    platformExecutionApproved: platformApproved,
    transactionCreationEnabled: false,
    status: !keyPresent ? "API_KEY_MISSING" : !platformApproved ? "PAYTRIE_PLATFORM_APPROVAL_REQUIRED" : "PLATFORM_AUTH_MODEL_UNCONFIRMED",
    supportedExecutionRoute: "CAD -> USDC-BASE",
    note: platformApproved
      ? "Local approval flag is enabled, but execution must remain unavailable until Paytrie confirms the approved platform authentication and end-user funding model."
      : "Paytrie has not confirmed an approved platform/partner arrangement for StableX. StableX customers must not be asked to create Paytrie accounts as a workaround. Order creation is disabled."
  };
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
export async function createPaytrieOrder() {
  if (!isPaytriePlatformExecutionApproved()) throw fail("Paytrie platform execution is disabled pending written platform authorization.", 403);
  throw fail("Paytrie platform authentication and end-user funding model are not confirmed or implemented. Order creation remains disabled.", 503);
}
export async function refreshPaytrieOrder() {
  throw fail("Paytrie order refresh is unavailable until the approved platform authentication model is implemented.", 503);
}
