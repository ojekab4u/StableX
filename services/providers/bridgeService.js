// Bridge API adapter.
// Indicative exchange rates do not lock a rate or create a transfer.
// Customer lookup is read-only; onboarding writes are implemented separately
// only after the provider's ToS and customer-data requirements are satisfied.

const apiKey = () => String(process.env.BRIDGE_API_KEY || "").trim();

function baseUrl() {
  const configured = String(process.env.BRIDGE_API_BASE_URL || "").trim();
  const environment = String(process.env.BRIDGE_ENVIRONMENT || "Sandbox").toLowerCase();
  const fallback = environment === "production"
    ? "https://api.bridge.xyz"
    : "https://api.sandbox.bridge.xyz";
  const value = (configured || fallback).replace(/\/+$/, "");
  return value.endsWith("/v0") ? value : `${value}/v0`;
}

function isUsableCredential(value) {
  return Boolean(value) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder|test)$/i.test(value.trim());
}

async function bridgeRequest(path, { method = "GET", body, idempotencyKey } = {}) {
  const key = apiKey();
  if (!isUsableCredential(key)) {
    const error = new Error("Bridge API key not configured. Set BRIDGE_API_KEY in .env.");
    error.statusCode = 503;
    throw error;
  }
  const headers = { Accept: "application/json", "Api-Key": key };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(new URL(`${baseUrl()}${path}`), {
    method, headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { payload = { message: raw.slice(0, 1000) }; }
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `Bridge returned HTTP ${response.status}`);
    error.statusCode = response.status >= 500 ? 502 : response.status;
    error.providerStatus = response.status;
    error.providerResponse = payload;
    throw error;
  }
  return payload;
}

const SUPPORTED_NON_USD = new Set(["BRL", "COP", "EUR", "GBP", "MXN", "USDT"]);
const isSupportedPair = (from, to) =>
  (from === "USD" && SUPPORTED_NON_USD.has(to)) ||
  (to === "USD" && SUPPORTED_NON_USD.has(from));

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getBridgeReadiness() {
  const missingVariables = [];
  if (!isUsableCredential(apiKey())) missingVariables.push("BRIDGE_API_KEY");
  const url = baseUrl();
  const environment = url.includes("api.sandbox.bridge.xyz")
    ? "Sandbox"
    : url.includes("api.bridge.xyz") ? "Production" : "Custom";
  return {
    name: "Bridge",
    role: "Indicative USD, EUR, GBP, BRL, COP, MXN and USDT exchange-rate feed",
    corridors: ["USD", "EUR", "GBP", "BRL", "COP", "MXN", "USDT"],
    configured: missingVariables.length === 0,
    status: missingVariables.length === 0
      ? "CREDENTIALS_PRESENT_CONNECTION_NOT_TESTED"
      : "AWAITING_PROVIDER_CREDENTIALS",
    missingVariables, environment, baseUrl: url,
    capabilities: ["INDICATIVE_FX_RATE_PREVIEW", "CUSTOMER_LOOKUP", "CUSTOMER_CREATION_AFTER_COMPLIANCE_AND_TOS"],
    capabilitiesPlanned: ["TRANSFER_EXECUTION_PENDING_PRODUCT_AND_ACCOUNT_VALIDATION"],
    executionEnabled: false,
    note: "Bridge exchange rates are indicative estimates refreshed roughly every 30 seconds. They are not locked quotes and do not create or fund transfers.",
  };
}

export async function listBridgeCustomers({ startingAfter, limit = 100 } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (startingAfter) params.set("starting_after", startingAfter);
  return bridgeRequest(`/customers?${params.toString()}`);
}

export async function requestBridgeTosLink({ idempotencyKey, redirectUri } = {}) {
  if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.length > 128) {
    const error = new Error("A stable Idempotency-Key is required for Bridge ToS link creation.");
    error.statusCode = 400;
    throw error;
  }
  const payload = await bridgeRequest("/customers/tos_links", { method: "POST", idempotencyKey });
  if (redirectUri && payload.url) {
    const hostedUrl = new URL(payload.url);
    hostedUrl.searchParams.set("redirect_uri", redirectUri);
    payload.url = hostedUrl.toString();
  }
  return payload;
}

export async function createBridgeCustomer(customer, { idempotencyKey } = {}) {
  if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.length > 128) {
    const error = new Error("A stable Idempotency-Key is required for Bridge customer creation.");
    error.statusCode = 400;
    throw error;
  }
  return bridgeRequest("/customers", { method: "POST", body: customer, idempotencyKey });
}

export async function getBridgeKycLink(customerId, { endorsement = "base" } = {}) {
  if (typeof customerId !== "string" || !customerId.trim()) {
    const error = new Error("A Bridge customer ID is required.");
    error.statusCode = 400;
    throw error;
  }
  const requestedEndorsement = String(endorsement || "base").trim().toLowerCase();
  if (!["base", "sepa"].includes(requestedEndorsement)) {
    const error = new Error("Bridge KYC endorsement must be base or sepa.");
    error.statusCode = 400;
    throw error;
  }
  const query = requestedEndorsement === "sepa" ? "?endorsement=sepa" : "";
  return bridgeRequest(`/customers/${encodeURIComponent(customerId.trim())}/kyc_link${query}`);
}

export async function getBridgeCustomer(customerId) {
  if (typeof customerId !== "string" || !customerId.trim()) {
    const error = new Error("A Bridge customer ID is required.");
    error.statusCode = 400;
    throw error;
  }
  return bridgeRequest(`/customers/${encodeURIComponent(customerId.trim())}`);
}

export async function getBridgeRate({ from, to, amount }) {
  const source = String(from || "").trim().toUpperCase();
  const destination = String(to || "").trim().toUpperCase();
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    const error = new Error("Bridge rate preview amount must be greater than zero.");
    error.statusCode = 400;
    throw error;
  }
  if (!isSupportedPair(source, destination)) {
    const error = new Error("Bridge indicative rates currently support USD paired with BRL, COP, EUR, GBP, MXN or USDT only.");
    error.statusCode = 400;
    throw error;
  }
  const payload = await bridgeRequest(`/exchange_rates?from=${encodeURIComponent(source.toLowerCase())}&to=${encodeURIComponent(destination.toLowerCase())}`);
  const rate = numeric(payload.sell_rate);
  if (rate === null || rate <= 0) {
    const error = new Error("Bridge returned an invalid or missing sell_rate.");
    error.statusCode = 502;
    throw error;
  }
  const observedAt = payload.updated_at || new Date().toISOString();
  const observedMs = Date.parse(observedAt);
  const expiresAt = new Date(Number.isFinite(observedMs) ? observedMs + 30_000 : Date.now() + 30_000).toISOString();
  return {
    provider: "Bridge", quoteType: "INDICATIVE_RATE_PREVIEW",
    from: source, to: destination, amount: value, rate,
    destinationAmount: value * rate, fee: null, feeCurrency: destination,
    observedAt, expiresAt, providerData: payload, executionEnabled: false,
    note: "Bridge sell_rate is an indicative estimate including Bridge's FX fee. Bridge does not lock this rate; no transfer, funding request or settlement is created.",
  };
}

// Deliberately disabled until a verified Bridge transfer product and account
// permissions are established. Never call an undocumented order endpoint.
export async function createBridgeOnRampOrder() {
  const error = new Error("Bridge transfer creation is not implemented. No order was created.");
  error.statusCode = 501;
  throw error;
}


// Sandbox virtual-account provisioning. Bridge returns dummy deposit instructions
// in Sandbox; this endpoint never moves funds.
export async function createBridgeVirtualAccount({ bridgeCustomerId, currency, destinationAddress, idempotencyKey }) {
  const customerId = String(bridgeCustomerId || "").trim();
  const sourceCurrency = String(currency || "").trim().toLowerCase();
  const address = String(destinationAddress || "").trim();
  if (!customerId) throw Object.assign(new Error("A linked Bridge customer is required."), { statusCode: 400 });
  if (!["usd", "eur", "gbp"].includes(sourceCurrency)) {
    throw Object.assign(new Error("Sandbox virtual-account testing currently supports USD, EUR or GBP source currencies in this workspace."), { statusCode: 400 });
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw Object.assign(new Error("Enter a valid EVM destination address on Base."), { statusCode: 400 });
  }
  if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.length > 128) {
    throw Object.assign(new Error("A stable Idempotency-Key is required."), { statusCode: 400 });
  }
  return bridgeRequest(`/customers/${encodeURIComponent(customerId)}/virtual_accounts`, {
    method: "POST",
    idempotencyKey,
    body: {
      source: { currency: sourceCurrency },
      destination: { payment_rail: "base", currency: "usdc", address },
      developer_fee_percent: "0.0",
    },
  });
}

// Read-only listing of custodial Bridge wallets already provisioned for a customer.
export async function listBridgeWallets(bridgeCustomerId) {
  const customerId = String(bridgeCustomerId || "").trim();
  if (!customerId) throw Object.assign(new Error("A linked Bridge customer is required."), { statusCode: 400 });
  return bridgeRequest(`/customers/${encodeURIComponent(customerId)}/wallets`);
}

export async function listBridgeVirtualAccounts(bridgeCustomerId) {
  const customerId = String(bridgeCustomerId || "").trim();
  if (!customerId) throw Object.assign(new Error("A linked Bridge customer is required."), { statusCode: 400 });
  return bridgeRequest(`/customers/${encodeURIComponent(customerId)}/virtual_accounts`);
}
