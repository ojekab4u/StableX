import "dotenv/config";

let cachedToken = null;
let tokenExpiresAt = 0;

const cleanBaseUrl = (value) => String(value || "").trim().replace(/\/+$/, "");

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(20000),
  });

  const text = await response.text();
  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`HoneyCoin returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok || body.success === false) {
    throw new Error(
      body.message || body.error || `HoneyCoin HTTP ${response.status}`
    );
  }

  return body;
}

async function getBearerToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const apiKey = process.env.HONEYCOIN_API_KEY;
  const publicKey = process.env.HONEYCOIN_PUBLIC_KEY;
  const baseUrl = cleanBaseUrl(process.env.HONEYCOIN_B2B_BASE_URL);

  if (!apiKey || !publicKey || !baseUrl) {
    throw new Error("HoneyCoin API credentials or B2B URL are missing.");
  }

  const auth = await requestJson(
    `${baseUrl}/auth/generate-bearer-token`,
    {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ publicKey }),
    }
  );

  if (!auth.token) {
    throw new Error("HoneyCoin did not return a bearer token.");
  }

  cachedToken = auth.token;
  tokenExpiresAt = Number(auth.expiresAt) * 1000;

  return cachedToken;
}

export async function getHoneycoinRate({ from, to, amount }) {
  const source = String(from || "").trim().toUpperCase();
  const destination = String(to || "").trim().toUpperCase();
  const value = Number(amount);

  if (!source || !destination || source === destination) {
    throw new Error("Invalid HoneyCoin currency pair.");
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("HoneyCoin quote amount must be greater than zero.");
  }

  const baseUrl = cleanBaseUrl(process.env.HONEYCOIN_B2B_BASE_URL);

  if (!baseUrl) {
    throw new Error("HONEYCOIN_B2B_BASE_URL is missing.");
  }

  const token = await getBearerToken();

  const url = new URL(`${baseUrl}/utilities/rates`);
  url.searchParams.set("from", source);
  url.searchParams.set("to", destination);
  url.searchParams.set("amount", String(value));

  const response = await requestJson(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const conversionRate = Number(response.data?.conversionRate);
  const convertedAmount = Number(response.data?.convertedAmount);

  if (
    !Number.isFinite(conversionRate) ||
    conversionRate <= 0 ||
    !Number.isFinite(convertedAmount) ||
    convertedAmount <= 0
  ) {
    throw new Error("HoneyCoin returned an invalid conversion rate or amount.");
  }

  return {
    name: "Honeycoin",
    quoteType: "INDICATIVE_RATE_PREVIEW",
    from: source,
    fromAmount: value,
    to: destination,
    toAmount: convertedAmount,
    rate: conversionRate,
    timestamp: new Date().toISOString(),
    raw: response.data,
    executable: false,
    executionEnabled: false,
    note: "HoneyCoin FX rate preview only. No liquidity reservation, order creation, collection or settlement has occurred.",
  };
}
