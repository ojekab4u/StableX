const API_KEY = () => String(process.env.HONEYCOIN_API_KEY || "").trim();
const PUBLIC_KEY = () => String(process.env.HONEYCOIN_PUBLIC_KEY || "").trim();
const isUsableCredential = (value) => Boolean(value) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder)$/i.test(value.trim());

function getBaseUrl() {
  const configured = String(
    process.env.HONEYCOIN_B2B_BASE_URL || process.env.HONEYCOIN_API_BASE_URL || ""
  ).trim();
  if (configured) return configured.replace(/\/+$/, "");
  const sandbox = String(process.env.HONEYCOIN_ENVIRONMENT || "Sandbox").toLowerCase() !== "production";
  return sandbox
    ? "https://api-v2.honeycoin.app/api/sandbox/b2b"
    : "https://api-v2.honeycoin.app/api/b2b";
}

let cachedToken = null;
let tokenExpiresAt = 0;

export function getHoneycoinReadiness() {
  const missingVariables = [];
  if (!isUsableCredential(API_KEY())) missingVariables.push("HONEYCOIN_API_KEY");
  if (!isUsableCredential(PUBLIC_KEY())) missingVariables.push("HONEYCOIN_PUBLIC_KEY");
  return {
    name: "Honeycoin",
    configured: missingVariables.length === 0,
    status: missingVariables.length === 0
      ? "CREDENTIALS_PRESENT_NOT_CONNECTION_TESTED"
      : "AWAITING_PROVIDER_CREDENTIALS",
    environment: process.env.HONEYCOIN_ENVIRONMENT || "Sandbox",
    missingVariables,
    capabilities: ["READ_ONLY_FX_RATE_PREVIEW", "NGN_USDC_ONRAMP_ORDER_ADAPTER", "TRANSACTION_STATUS_LOOKUP"],
    executionEnabled: false,
    executionNote: "Order adapter is implemented. Actual execution remains subject to Honeycoin account permissions and a successful sandbox order test.",
  };
}

async function getBearerToken() {
  if (!isUsableCredential(API_KEY()) || !isUsableCredential(PUBLIC_KEY())) {
    const error = new Error("Honeycoin credentials are not configured. Set HONEYCOIN_API_KEY and HONEYCOIN_PUBLIC_KEY.");
    error.statusCode = 503;
    throw error;
  }

  if (cachedToken && tokenExpiresAt > Date.now() + 60_000) return cachedToken;

  const response = await fetch(`${getBaseUrl()}/auth/generate-bearer-token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": API_KEY(),
    },
    body: JSON.stringify({ publicKey: PUBLIC_KEY() }),
    signal: AbortSignal.timeout(12_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.token) {
    const error = new Error(payload.message || "Honeycoin authentication failed. Check the sandbox API key and public key configured on the server.");
    error.statusCode = response.status === 400 || response.status === 401 || response.status === 403 ? 502 : 503;
    throw error;
  }

  cachedToken = payload.token;
  tokenExpiresAt = Number(payload.expiresAt) > 0
    ? Number(payload.expiresAt) * 1000
    : Date.now() + 50 * 60_000;
  return cachedToken;
}

export async function getHoneycoinRate({ from, to, amount }) {
  const token = await getBearerToken();
  const url = new URL(`${getBaseUrl()}/utilities/rates`);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("amount", String(amount));

  const response = await fetch(url, {
    headers: { accept: "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(12_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const error = new Error(payload.message || "Honeycoin FX rate request failed.");
    error.statusCode = 502;
    throw error;
  }

  return {
    provider: "Honeycoin",
    quoteType: "INDICATIVE_RATE_PREVIEW",
    from,
    to,
    amount,
    providerData: payload.data ?? payload,
    executionEnabled: false,
    note: "Read-only FX preview. This is not a reserved quote and does not initiate a payment or crypto settlement.",
  };
}


function getCryptoBaseUrl() {
  const configured = String(process.env.HONEYCOIN_CRYPTO_BASE_URL || "").trim();
  if (configured) return configured.replace(/\\/+$/, "");
  const sandbox = String(process.env.HONEYCOIN_ENVIRONMENT || "Sandbox").toLowerCase() !== "production";
  return sandbox
    ? "https://crypto.honeycoin.app/api/sandbox"
    : "https://crypto.honeycoin.app/api";
}

async function honeycoinJson(url, options = {}) {
  const token = await getBearerToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const error = new Error(payload.message || `Honeycoin request failed with HTTP ${response.status}.`);
    error.statusCode = response.status === 400 ? 400 : response.status === 401 || response.status === 403 ? 502 : 503;
    throw error;
  }
  return payload;
}

// Creates an actual Honeycoin on-ramp order. This is an external provider action.
export async function createHoneycoinOnrampOrder({
  senderAmount, senderCurrency, receiverCurrency, chain, receiverAddress,
  method, email, externalReference,
}) {
  const body = {
    senderAmount: Number(senderAmount),
    senderCurrency,
    receiverCurrency,
    chain,
    receiverAddress,
    method,
    chargeDetails: { email },
    externalReference,
  };
  const payload = await honeycoinJson(`${getCryptoBaseUrl()}/minting/onramp`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!payload.data?.transactionId) {
    const error = new Error("Honeycoin accepted no identifiable transaction ID; the order cannot be safely reconciled.");
    error.statusCode = 502;
    throw error;
  }
  return {
    transactionId: String(payload.data.transactionId),
    stepRequired: payload.data.stepRequired || null,
    redirectUrl: payload.data.redirectUrl || payload.data.paymentSdkLink || null,
    status: payload.data.status || "PENDING",
    chargeStatus: payload.data.chargeStatus || "pending",
    virtualAccount: payload.data.virtualAccount || null,
    providerData: payload.data,
  };
}

// Reads the provider's canonical transaction record; never trusts browser-supplied status.
export async function getHoneycoinTransaction(transactionId) {
  if (typeof transactionId !== "string" || !/^[A-Za-z0-9_-]{6,128}$/.test(transactionId)) {
    const error = new Error("Invalid Honeycoin transaction ID.");
    error.statusCode = 400;
    throw error;
  }
  const payload = await honeycoinJson(`${getBaseUrl()}/transactions/${encodeURIComponent(transactionId)}`, {
    method: "GET",
  });
  return payload.data ?? payload;
}
