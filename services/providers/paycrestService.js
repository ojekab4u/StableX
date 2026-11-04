const API_BASE_URL = () =>
  String(process.env.PAYCREST_API_BASE_URL || "https://api.paycrest.io").trim().replace(/\/+$/, "");

const SUPPORTED_FIAT_PREVIEW = new Set(["NGN", "KES", "UGX", "TZS", "MWK", "BRL"]);
const SUPPORTED_TOKENS = new Set(["USDC", "USDT"]);
const isUsableCredential = (value) => Boolean(value) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder)$/i.test(value.trim());

export function getPaycrestReadiness() {
  const apiKeyPresent = isUsableCredential(String(process.env.PAYCREST_API_KEY || "").trim());
  const apiSecretPresent = isUsableCredential(String(process.env.PAYCREST_API_SECRET || "").trim());
  const missingVariables = [];
  if (!apiKeyPresent) missingVariables.push("PAYCREST_API_KEY");
  if (!apiSecretPresent) missingVariables.push("PAYCREST_API_SECRET");

  return {
    name: "Paycrest",
    configured: apiKeyPresent && apiSecretPresent,
    status: apiKeyPresent && apiSecretPresent
      ? "CREDENTIALS_PRESENT_NOT_CONNECTION_TESTED"
      : "PUBLIC_RATE_PREVIEW_ONLY_ORDER_ACCESS_REQUIRES_KYB_AND_CREDENTIALS",
    missingVariables,
    capabilities: ["PUBLIC_READ_ONLY_RATE_PREVIEW"],
    executionEnabled: false,
    note: "The public rate endpoint can be queried without credentials. Sender order creation requires approved sender onboarding, configured token/network settings and server-side credentials.",
  };
}

export async function getPaycrestRate({ from, to, amount, network = "base" }) {
  const fromIsToken = SUPPORTED_TOKENS.has(from);
  const toIsToken = SUPPORTED_TOKENS.has(to);
  if (fromIsToken === toIsToken) {
    const error = new Error("Paycrest rate preview requires one supported stablecoin (USDC/USDT) and one supported fiat currency.");
    error.statusCode = 400;
    throw error;
  }

  const token = fromIsToken ? from : to;
  const fiat = fromIsToken ? to : from;
  if (!SUPPORTED_FIAT_PREVIEW.has(fiat)) {
    const error = new Error(`Paycrest public rate preview documentation currently lists these fiat corridors: ${[...SUPPORTED_FIAT_PREVIEW].join(", ")}.`);
    error.statusCode = 400;
    throw error;
  }

  const safeNetwork = String(network || "base").toLowerCase();
  if (!/^[a-z0-9-]{2,24}$/.test(safeNetwork)) {
    const error = new Error("Invalid blockchain network code.");
    error.statusCode = 400;
    throw error;
  }

  const rateRequestTokenAmount = fromIsToken ? amount : 1;
  const url = `${API_BASE_URL()}/v2/rates/${encodeURIComponent(safeNetwork)}/${encodeURIComponent(token)}/${encodeURIComponent(String(rateRequestTokenAmount))}/${encodeURIComponent(fiat)}`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const error = new Error(payload.message || "Paycrest rate preview request failed.");
    error.statusCode = 502;
    throw error;
  }

  return {
    provider: "Paycrest",
    quoteType: "INDICATIVE_RATE_PREVIEW",
    from,
    to,
    amount,
    direction: fromIsToken ? "OFFRAMP" : "ONRAMP",
    network: safeNetwork,
    rateRequestTokenAmount,
    providerData: payload.data ?? payload,
    executionEnabled: false,
    note: "Public indicative rate preview only. Order creation, liquidity reservation and settlement are not performed.",
  };
}
