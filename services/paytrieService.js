const API_BASE = "https://api.paytrie.com/v2";

const TOKEN_LABELS = {
  USDC: "USDC-BASE",
  CADC: "CADC-BASE",
};

export function getPaytrieReadiness() {
  const apiKey = String(process.env.PAYTRIE_API_KEY || "").trim();
  const hasUsableKey = Boolean(apiKey) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder)$/i.test(apiKey);
  return {
    name: "Paytrie",
    apiVersion: "v2",
    configured: true, // quotes work publicly; an API key is optional
    apiKeyPresent: hasUsableKey,
    status: hasUsableKey ? "CREDENTIAL_PRESENT_CONNECTION_NOT_TESTED" : "PUBLIC_QUOTES_NO_KEY_REQUIRED",
    supportedStablecoinPairs: ["CAD/USDC-BASE", "CAD/CADC-BASE", "USDC-BASE/CAD", "CADC-BASE/CAD"],
    quoteEndpoint: API_BASE + "/quotes",
    transactionCreationEnabled: hasUsableKey,
    authenticationRequired: "PAYTRIE_USER_JWT_PER_CUSTOMER",
    transactionEndpoint: API_BASE + "/transactions",
    note: hasUsableKey
      ? "Integrator API key is configured. A verified Paytrie customer must authenticate and provide a short-lived user JWT before an order can be created."
      : "Public quotes are available, but transaction creation is disabled until PAYTRIE_API_KEY is configured and a verified Paytrie customer supplies a short-lived JWT.",
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


function requirePaytrieApiKey() {
  const apiKey = String(process.env.PAYTRIE_API_KEY || "").trim();
  if (!apiKey || /^(key|your[_ -].*|replace[_ -].*|changeme|placeholder)$/i.test(apiKey)) {
    const error = new Error("Paytrie order creation requires PAYTRIE_API_KEY. Public quote access does not authorize transactions.");
    error.statusCode = 503;
    throw error;
  }
  return apiKey;
}

async function paytrieRequest(path, { method = "GET", apiKey, userJwt, body } = {}) {
  const headers = { Accept: "application/json", "Content-Type": "application/json", "x-api-key": apiKey || requirePaytrieApiKey() };
  if (userJwt) headers.Authorization = `Bearer ${userJwt}`;
  const response = await fetch(API_BASE + path, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { message: text.slice(0, 1000) }; }
  if (!response.ok || data.success === false) {
    const detail = Array.isArray(data.errors) ? data.errors.map((item) => item.message).filter(Boolean).join("; ") : null;
    const error = new Error(detail || data.message || data.error || `Paytrie returned HTTP ${response.status}`);
    error.statusCode = response.status >= 500 ? 502 : response.status || 502;
    error.providerStatus = response.status;
    throw error;
  }
  return data.data ?? data;
}

export async function requestPaytrieLoginCode(email) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    const error = new Error("A valid registered Paytrie customer email is required.");
    error.statusCode = 400;
    throw error;
  }
  return paytrieRequest("/auth/login-codes", {
    method: "POST",
    body: { email: email.trim().toLowerCase() },
  });
}

export async function verifyPaytrieLoginCode({ email, code }) {
  if (typeof email !== "string" || typeof code !== "string" || !/^\d{4}$/.test(code.trim())) {
    const error = new Error("A registered Paytrie email and 4-digit login code are required.");
    error.statusCode = 400;
    throw error;
  }
  const result = await paytrieRequest("/auth/login-codes/verify", {
    method: "POST",
    body: { email: email.trim().toLowerCase(), code: code.trim() },
  });
  if (!result.accessToken) {
    const error = new Error("Paytrie did not return an access token.");
    error.statusCode = 502;
    throw error;
  }
  return { accessToken: result.accessToken, tokenType: result.tokenType || "Bearer", expiresIn: result.expiresIn || 3600 };
}

export async function createPaytrieTransaction({ userJwt, transaction }) {
  if (typeof userJwt !== "string" || userJwt.trim().length < 20) {
    const error = new Error("A Paytrie customer JWT is required in X-Paytrie-User-Token.");
    error.statusCode = 401;
    throw error;
  }
  return paytrieRequest("/transactions", {
    method: "POST",
    userJwt: userJwt.trim(),
    body: transaction,
  });
}

export async function getPaytrieTransaction({ userJwt, transactionId }) {
  if (typeof userJwt !== "string" || userJwt.trim().length < 20) {
    const error = new Error("A Paytrie customer JWT is required in X-Paytrie-User-Token.");
    error.statusCode = 401;
    throw error;
  }
  if (typeof transactionId !== "string" || !transactionId.trim()) {
    const error = new Error("A Paytrie transaction ID is required.");
    error.statusCode = 400;
    throw error;
  }
  return paytrieRequest(`/transactions/${encodeURIComponent(transactionId)}`, {
    userJwt: userJwt.trim(),
  });
}
