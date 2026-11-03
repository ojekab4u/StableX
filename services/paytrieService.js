const API_BASE = "https://api.paytrie.com/v2";

const TOKEN_LABELS = {
  USDC: "USDC-BASE",
  CADC: "CADC-BASE",
};

export function getPaytrieReadiness() {
  return {
    provider: "Paytrie",
    apiVersion: "v2",
    configured: Boolean(process.env.PAYTRIE_API_KEY),
    status: process.env.PAYTRIE_API_KEY ? "CREDENTIAL_PRESENT_CONNECTION_NOT_TESTED" : "AWAITING_API_KEY",
    supportedStablecoinPairs: ["CAD/USDC-BASE", "CAD/CADC-BASE", "USDC-BASE/CAD", "CADC-BASE/CAD"],
    quoteEndpoint: API_BASE + "/quotes",
    transactionCreationEnabled: false,
    note: "Paytrie v2 quotes are live only when a valid API key is configured. Transaction creation also requires an authenticated Paytrie user JWT and is intentionally not enabled in this prototype.",
  };
}

export async function getPaytrieQuote({ from, to, amount }) {
  const apiKey = process.env.PAYTRIE_API_KEY;
  if (!apiKey) {
    const error = new Error("Paytrie is not configured. Set PAYTRIE_API_KEY on the StableX server.");
    error.statusCode = 503;
    throw error;
  }

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

  const response = await fetch(url, {
    method: "GET",
    headers: { "x-api-key": apiKey, Accept: "application/json" },
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
    provider: "Paytrie",
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
