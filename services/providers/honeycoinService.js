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
    capabilities: ["READ_ONLY_FX_RATE_PREVIEW"],
    executionEnabled: false,
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
