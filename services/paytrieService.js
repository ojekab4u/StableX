const API_BASE = "https://api.paytrie.com/v2";

const TOKEN_LABELS = {
  USDC: "USDC-BASE",
  CADC: "CADC-BASE",
};

export function getPaytrieReadiness() {
  const apiKey = String(process.env.PAYTRIE_API_KEY || "").trim();
  const hasUsableKey = Boolean(apiKey) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder)$/i.test(apiKey);
  const platformApproved = String(process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED || "").trim().toLowerCase() === "true";
  return {
    name: "Paytrie",
    apiVersion: "v2",
    configured: true, // quotes work publicly; an API key is optional
    apiKeyPresent: hasUsableKey,
    status: hasUsableKey ? "CREDENTIAL_PRESENT_CONNECTION_NOT_TESTED" : "PUBLIC_QUOTES_NO_KEY_REQUIRED",
    supportedStablecoinPairs: ["CAD/USDC-BASE", "CAD/CADC-BASE", "USDC-BASE/CAD", "CADC-BASE/CAD"],
    quoteEndpoint: API_BASE + "/quotes",
    platformAuthorizationRequired: true,
    platformExecutionApproved: platformApproved,
    transactionCreationEnabled: hasUsableKey && platformApproved,
    authenticationRequired: "PAYTRIE_USER_JWT_PER_CUSTOMER",
    transactionEndpoint: API_BASE + "/transactions",
    note: !hasUsableKey
      ? "Live quotes may be available without a key. Transaction creation also requires an API key, a verified customer JWT and Paytrie's explicit approval of StableX's platform/partner arrangement."
      : !platformApproved
        ? "API key is present, but platform execution remains disabled until Paytrie explicitly approves StableX's platform/partner arrangement."
        : "Platform approval flag is enabled. A verified Paytrie customer JWT and eligible customer account are still required; verify the written approval before use.",
  };
}

export async function getPaytrieQuote({ from, to, amount }) {
  // Verified live 2026-11-04: the /quotes endpoint answers without an API key.
  // When an optional key is present it is attached; otherwise public access is used.
  const apiKey = String(process.env.PAYTRIE_API_KEY || "").trim();
  const hasUsableKey = Boolean(apiKey) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder)$/i.test(apiKey);

  const source = String(from || "").toUpperCase();
  const destination = String(to || "").toUpperCase();
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0 || value > 1000000) {
    const error = new Error("Amount must be greater than zero and at most 1,000,000.");
    error.statusCode = 400;
    throw error;
  }

  let leftSideLabel;
  let rightSideLabel;
  if (source === "CAD" && TOKEN_LABELS[destination]) {
    leftSideLabel = "CAD";
    rightSideLabel = TOKEN_LABELS[destination];
  } else if (TOKEN_LABELS[source] && destination === "CAD") {
    leftSideLabel = TOKEN_LABELS[source];
    rightSideLabel = "CAD";
  } else {
    const error = new Error("Paytrie v2 adapter currently supports CAD to/from USDC or CADC on Base only.");
    error.statusCode = 400;
    throw error;
  }

  const url = new URL(API_BASE + "/quotes");
  url.searchParams.set("leftSideLabel", leftSideLabel);
  url.searchParams.set("leftSideValue", String(value));
  url.searchParams.set("rightSideLabel", rightSideLabel);

  const headers = { Accept: "application/json" };
  if (hasUsableKey) headers["x-api-key"] = apiKey;

  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(20000),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { data = { message: raw.slice(0, 1000) }; }

  if (!response.ok || data.success === false) {
    const error = new Error(data.message || data.error || `Paytrie returned HTTP ${response.status}`);
    error.statusCode = response.status >= 500 ? 502 : response.status || 502;
    error.providerStatus = response.status;
    throw error;
  }

  const quote = data.data || data;
  return {
    name: "Paytrie",
    quoteType: "LIVE_PROVIDER_QUOTE",
    quoteId: quote.quoteId ?? null,
    from: quote.leftSideLabel || leftSideLabel,
    fromAmount: quote.leftSideValue ?? value,
    to: quote.rightSideLabel || rightSideLabel,
    toAmount: quote.rightSideValue ?? null,
    breakdown: quote.breakdown || null,
    timestamp: quote.timestamp || null,
    raw: quote,
    executable: false,
    note: "This is a live provider quote, not a completed purchase or transfer. Paytrie transaction creation requires a separately authenticated user JWT and customer payment.",
  };
}
