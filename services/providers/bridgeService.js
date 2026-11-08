// Bridge exchange-rate adapter.
// The exchange-rates endpoint is an indicative feed only; it does not lock a rate
// or create a transfer. Transfer creation is deliberately not exposed here.

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

const SUPPORTED_NON_USD = new Set(["BRL", "COP", "EUR", "GBP", "MXN", "USDT"]);

function isSupportedPair(from, to) {
  return (from === "USD" && SUPPORTED_NON_USD.has(to)) ||
    (to === "USD" && SUPPORTED_NON_USD.has(from));
}

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
    : url.includes("api.bridge.xyz")
      ? "Production"
      : "Custom";

  return {
    name: "Bridge",
    role: "Indicative USD, EUR, GBP, BRL, COP, MXN and USDT exchange-rate feed",
    corridors: ["USD", "EUR", "GBP", "BRL", "COP", "MXN", "USDT"],
    configured: missingVariables.length === 0,
    status: missingVariables.length === 0
      ? "CREDENTIALS_PRESENT_CONNECTION_NOT_TESTED"
      : "AWAITING_PROVIDER_CREDENTIALS",
    missingVariables,
    environment,
    baseUrl: url,
    capabilities: ["INDICATIVE_FX_RATE_PREVIEW"],
    capabilitiesPlanned: ["TRANSFER_EXECUTION_PENDING_PRODUCT_AND_ACCOUNT_VALIDATION"],
    executionEnabled: false,
    note: "Bridge exchange rates are indicative estimates refreshed roughly every 30 seconds. They are not locked quotes and do not create or fund transfers.",
  };
}

export async function getBridgeRate({ from, to, amount }) {
  const key = apiKey();
  if (!isUsableCredential(key)) {
    const error = new Error("Bridge API key not configured. Set BRIDGE_API_KEY in .env.");
    error.statusCode = 503;
    throw error;
  }

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

  const url = new URL(`${baseUrl()}/exchange_rates`);
  url.searchParams.set("from", source.toLowerCase());
  url.searchParams.set("to", destination.toLowerCase());

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Api-Key": key,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { message: raw.slice(0, 1000) };
  }

  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `Bridge returned HTTP ${response.status}`);
    error.statusCode = response.status >= 500 ? 502 : response.status;
    throw error;
  }

  // Bridge defines sell_rate as the amount of target currency received per
  // one unit of source currency. It already includes Bridge's exchange fee.
  const rate = numeric(payload.sell_rate);
  if (rate === null || rate <= 0) {
    const error = new Error("Bridge returned an invalid or missing sell_rate.");
    error.statusCode = 502;
    throw error;
  }

  const observedAt = payload.updated_at || new Date().toISOString();
  const observedMs = Date.parse(observedAt);
  const expiresAt = new Date(
    Number.isFinite(observedMs) ? observedMs + 30_000 : Date.now() + 30_000
  ).toISOString();

  return {
    provider: "Bridge",
    quoteType: "INDICATIVE_RATE_PREVIEW",
    from: source,
    to: destination,
    amount: value,
    rate,
    destinationAmount: value * rate,
    fee: null,
    feeCurrency: destination,
    observedAt,
    expiresAt,
    providerData: payload,
    executionEnabled: false,
    note: "Bridge sell_rate is an indicative estimate including Bridge's FX fee. Bridge does not lock this rate; no transfer, funding request or settlement is created.",
  };
}

// Kept as an explicit guard for any older caller. The previous /v1/orders
// endpoint was not a verified Bridge API route and must never be called.
export async function createBridgeOnRampOrder() {
  const error = new Error("Bridge transfer creation is not implemented. The exchange-rates endpoint is indicative only; no order was created.");
  error.statusCode = 501;
  throw error;
}
