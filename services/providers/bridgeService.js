// Bridge (Stripe) — USD / GBP / EUR stablecoin issuance and on/off-ramp
//
// Required env vars:
//   BRIDGE_API_BASE_URL — https://api.bridge.xyz
//   BRIDGE_API_KEY      — sandbox API key from Bridge dashboard
//
import { createHmac, timingSafeEqual } from "node:crypto";

const apiKey = () => String(process.env.BRIDGE_API_KEY || "").trim();
const baseUrl = () => String(process.env.BRIDGE_API_BASE_URL || "https://api.bridge.xyz").replace(/\/+$/, "");

function isUsableCredential(value) {
  return Boolean(value) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder|test)$/i.test(value.trim());
}

export function getBridgeReadiness() {
  const missing = [];
  if (!isUsableCredential(apiKey())) missing.push("BRIDGE_API_KEY");

  return {
    name: "Bridge",
    role: "USD / GBP / EUR stablecoin issuance and on/off-ramp",
    corridors: ["USD", "GBP", "EUR"],
    configured: missing.length === 0,
    status: missing.length === 0
      ? "CREDENTIALS_PRESENT_CONNECTION_NOT_TESTED"
      : "AWAITING_PROVIDER_CREDENTIALS",
    missingVariables: missing,
    environment: "Sandbox",
    baseUrl: baseUrl(),
    capabilities: ["USD_ONOFFRAMP", "GBP_ONOFFRAMP", "EUR_ONOFFRAMP", "STABLECOIN_ISSUANCE"],
    note: "Bridge sandbox API key required for stablecoin issuance and fiat on/off-ramp.",
  };
}

export async function getBridgeRate({ from, to, amount }) {
  if (!isUsableCredential(apiKey())) {
    const error = new Error("Bridge API key not configured. Set BRIDGE_API_KEY in .env.");
    error.statusCode = 503;
    throw error;
  }

  // Bridge API: get quote for fiat-to-stablecoin or stablecoin-to-fiat conversion
  const response = await fetch(`${baseUrl()}/v1/quotes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      from,
      to,
      amount: String(amount),
    }),
    signal: AbortSignal.timeout(20000),
  });

  const raw = await response.text();
  let result;
  try { result = raw ? JSON.parse(raw) : {}; } catch { result = { message: raw.slice(0, 1000) }; }

  if (!response.ok) {
    const error = new Error(result.message || result.error || `Bridge returned HTTP ${response.status}`);
    error.statusCode = response.status >= 500 ? 502 : 400;
    throw error;
  }

  return {
    provider: "Bridge",
    quoteType: "LIVE_PROVIDER_QUOTE",
    from,
    to,
    amount,
    destinationAmount: extractNumeric(result, ["convertedAmount", "toAmount", "destinationAmount"]),
    rate: extractNumeric(result, ["rate", "exchangeRate", "conversionRate"]),
    fee: extractNumeric(result, ["fee", "fees", "totalFee"]),
    feeCurrency: result.feeCurrency || to,
    raw,
  };
}

function extractNumeric(source, keys) {
  for (const key of keys) {
    const val = source?.[key];
    if (val === null || val === undefined || val === "") continue;
    const number = Number(val);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

export async function createBridgeOnRampOrder({ customerId, from, to, amount, recipientWalletAddress }) {
  if (!isUsableCredential(apiKey())) {
    const error = new Error("Bridge API key not configured. Set BRIDGE_API_KEY in .env.");
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(`${baseUrl()}/v1/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      customerId,
      fromCurrency: from,
      toCurrency: to,
      amount: String(amount),
      recipientWalletAddress,
    }),
    signal: AbortSignal.timeout(30000),
  });

  const raw = await response.text();
  let result;
  try { result = raw ? JSON.parse(raw) : {}; } catch { result = { message: raw.slice(0, 1000) }; }

  if (!response.ok) {
    const error = new Error(result.message || result.error || `Bridge returned HTTP ${response.status}`);
    error.statusCode = response.status >= 500 ? 502 : 400;
    throw error;
  }

  return {
    provider: "Bridge",
    orderId: result.orderId || result.id,
    status: result.status || "PENDING",
    from,
    to,
    amount,
    destinationAmount: extractNumeric(result, ["convertedAmount", "toAmount"]),
    recipientWalletAddress,
    raw,
  };
}