// Netcoins trading-rail adapter — Netcoins API v4 ("Trading & Balances").
// Authoritative spec: Netcoins_API_v4_Guide.pdf + the v4 Postman collection.
//
// Netcoins is a FINTRAC-registered (M15560893), BCSC-regulated Canadian trading
// platform. Authentication is a single long-lived bearer token (NETCOINS_API_KEY)
// issued per environment; there is no request signing secret.
//
// Environments (v4 guide):
//   staging:    https://api-staging.netcoins.app/api/v4
//   production: https://api.netcoins.com/api/v4
//
// v4 conventions:
//   - Every successful response is wrapped in a `data` envelope; this adapter
//     unwraps it and always returns the inner object.
//   - Monetary amounts are decimal STRINGS in requests.
//   - Instant trades are quote-then-execute: POST /trading/quotes opens an RFQ
//     session (quoteReqId) whose initial `quote` contains an executable
//     `quoteId`; refresh via GET /trading/quotes/{quoteReqId} (polling fallback;
//     the primary channel is a Pusher WebSocket we do not hold). Execute with
//     POST /trading/trades/execute/instant {quoteId} before validUntil.
//   - v4 does NOT document withdrawals, deposits or transfer history. Funding
//     and fiat/crypto movement are handled on the Netcoins side (app or desk)
//     unless a separate endpoint set is confirmed.

const TOKEN = () => String(process.env.NETCOINS_API_KEY || "").trim();

const isUsableCredential = (value) =>
  Boolean(value) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder|test)$/i.test(value.trim());

// Conservative start: USDC against CAD/USD. Confirm against GET /trading/pairs
// and GET /trading/permissions during the first staging session before expanding.
const SUPPORTED_CRYPTO_ASSETS = new Set(["USDC"]);
const SUPPORTED_COUNTER_ASSETS = new Set(["CAD", "USD"]);

const MAX_RFQ_DURATION_SECONDS = 180;

export function getNetcoinsEnvironment() {
  const value = String(process.env.NETCOINS_ENVIRONMENT || "staging").trim().toLowerCase();
  return value === "production" ? "production" : "staging";
}

export function getNetcoinsBaseUrl() {
  const configured = String(process.env.NETCOINS_API_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  return getNetcoinsEnvironment() === "production"
    ? "https://api.netcoins.com/api/v4"
    : "https://api-staging.netcoins.app/api/v4";
}

export function getNetcoinsReadiness() {
  const missingVariables = [];
  if (!isUsableCredential(TOKEN())) missingVariables.push("NETCOINS_API_KEY");
  return {
    name: "Netcoins",
    configured: missingVariables.length === 0,
    status: missingVariables.length === 0
      ? "CREDENTIALS_PRESENT_NOT_CONNECTION_TESTED"
      : "AWAITING_PROVIDER_CREDENTIALS",
    environment: getNetcoinsEnvironment(),
    missingVariables,
    capabilities: [
      "LIVE_RFQ_QUOTE_PREVIEW_CAD_USD_USDC",
      "INSTANT_TRADE_EXECUTION_ADAPTER",
      "LIMIT_ORDER_ADAPTER",
      "BALANCES_PAIRS_PERMISSIONS_MARKET_DATA",
    ],
    executionEnabled: false,
    executionNote:
      "Quote → execute calls are implemented server-side. Execution stays disabled until a staging trade test passes and the operator explicitly enables it.",
    openQuestions: [
      "v4 documents no withdrawal/deposit endpoints — confirm how crypto leaves the Netcoins account (separate endpoint set, app or desk).",
      "Confirm USDC:CAD and USDC:USD pairs and instant buy/sell permissions on the provisioned account.",
    ],
  };
}

function netcoinsError(response, payload) {
  // v4 error shape: { code, message, details }
  const message = payload?.message || `Netcoins request failed with HTTP ${response.status}.`;
  const error = new Error(message);
  error.provider = "Netcoins";
  error.providerCode = payload?.code || null;
  error.providerStatus = response.status;
  error.providerResponse = payload;
  if (response.status === 422 || response.status === 410 || response.status === 404) error.statusCode = 400;
  else if (response.status === 401 || response.status === 403) error.statusCode = 502;
  else if (response.status === 429) error.statusCode = 429;
  else error.statusCode = 503;
  return error;
}

async function netcoinsJson(path, { method = "GET", body } = {}) {
  if (!isUsableCredential(TOKEN())) {
    const error = new Error("Netcoins credentials are not configured. Set NETCOINS_API_KEY (and NETCOINS_ENVIRONMENT or NETCOINS_API_BASE_URL).");
    error.statusCode = 503;
    throw error;
  }
  const response = await fetch(`${getNetcoinsBaseUrl()}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      Authorization: `Bearer ${TOKEN()}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 204) return {};
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw netcoinsError(response, payload);
  return payload.data ?? payload;
}

// Routing preview: account-priced indicative rate from GET /markets/prices.
// Per the v4 pricing guide, RFQ quote sessions (POST /trading/quotes) must only
// be opened when actually trading — they are NOT a price-polling mechanism.
export async function getNetcoinsIndicativePrice(baseCurrency, quoteCurrency) {
  const base = String(baseCurrency || "").trim().toUpperCase();
  const quote = String(quoteCurrency || "").trim().toUpperCase();
  if (!base || !quote) {
    const error = new Error("A Netcoins price request requires base and quote symbols.");
    error.statusCode = 400;
    throw error;
  }
  return netcoinsJson(`/markets/prices/${encodeURIComponent(base)}/${encodeURIComponent(quote)}`);
}

export async function getNetcoinsRate({ from, to, amount }) {
  const fromIsAsset = SUPPORTED_CRYPTO_ASSETS.has(from);
  const toIsAsset = SUPPORTED_CRYPTO_ASSETS.has(to);
  if (fromIsAsset === toIsAsset) {
    const error = new Error(`Netcoins quotes require one supported crypto asset (${[...SUPPORTED_CRYPTO_ASSETS].join(", ")}) and one supported counter asset (${[...SUPPORTED_COUNTER_ASSETS].join(", ")}).`);
    error.statusCode = 400;
    throw error;
  }
  const counterAsset = fromIsAsset ? to : from;
  if (!SUPPORTED_COUNTER_ASSETS.has(counterAsset)) {
    const error = new Error(`Netcoins quotes currently support these counter assets: ${[...SUPPORTED_COUNTER_ASSETS].join(", ")}.`);
    error.statusCode = 400;
    throw error;
  }
  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    const error = new Error("Netcoins quotes require a positive numeric amount.");
    error.statusCode = 400;
    throw error;
  }

  const base = fromIsAsset ? from : to;
  const counter = fromIsAsset ? to : from;
  const priceData = await getNetcoinsIndicativePrice(base, counter);
  const buyPrice = Number(priceData.buy_price);
  const sellPrice = Number(priceData.sell_price);
  // Buy: the customer pays buy_price (fiat per crypto). Sell: the customer receives sell_price.
  const price = fromIsAsset ? sellPrice : buyPrice;
  if (!Number.isFinite(price) || price <= 0) {
    const error = new Error("Netcoins price response did not include a usable buy/sell price for this pair.");
    error.statusCode = 502;
    throw error;
  }
  const destinationAmount = fromIsAsset ? amountNumber * sellPrice : amountNumber / buyPrice;
  return {
    provider: "Netcoins",
    quoteType: "INDICATIVE_RATE_PREVIEW",
    from,
    to,
    amount: amountNumber,
    direction: fromIsAsset ? "OFFRAMP" : "ONRAMP",
    baseCurrency: base,
    quoteCurrency: counter,
    destinationAmount,
    rate: price,
    buyPrice: Number.isFinite(buyPrice) ? buyPrice : null,
    sellPrice: Number.isFinite(sellPrice) ? sellPrice : null,
    priceTimestamp: priceData.timestamp || null,
    providerData: priceData,
    executionEnabled: false,
    note: "Account-priced indicative rate from Netcoins GET /markets/prices. Non-binding; a binding RFQ quote is requested only at trade time.",
  };
}

// Opens an RFQ quote session. Returns { quoteReqId, endTime, quote }.
export async function requestNetcoinsQuote({ action, baseCurrency, quoteCurrency, amount, amountCurrency, rfqDuration }) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  if (normalizedAction !== "buy" && normalizedAction !== "sell") {
    const error = new Error("Netcoins quote action must be 'buy' or 'sell'.");
    error.statusCode = 400;
    throw error;
  }
  const body = {
    action: normalizedAction,
    baseCurrency: String(baseCurrency || "").trim().toUpperCase(),
    quoteCurrency: String(quoteCurrency || "").trim().toUpperCase(),
    amount: String(amount ?? "").trim(),
    amountCurrency: String(amountCurrency || "").trim().toUpperCase(),
  };
  if (!body.baseCurrency || !body.quoteCurrency || !body.amount || !body.amountCurrency) {
    const error = new Error("Netcoins quotes require action, baseCurrency, quoteCurrency, amount and amountCurrency.");
    error.statusCode = 400;
    throw error;
  }
  if (body.baseCurrency === body.quoteCurrency) {
    const error = new Error("Netcoins base and quote currencies must differ.");
    error.statusCode = 400;
    throw error;
  }
  if (rfqDuration !== undefined) {
    const duration = Number(rfqDuration);
    if (!Number.isInteger(duration) || duration < 1 || duration > MAX_RFQ_DURATION_SECONDS) {
      const error = new Error(`rfqDuration must be an integer between 1 and ${MAX_RFQ_DURATION_SECONDS} seconds.`);
      error.statusCode = 400;
      throw error;
    }
    body.rfqDuration = duration;
  }
  return netcoinsJson("/trading/quotes", { method: "POST", body });
}

// Polling fallback: most recent quote for an active RFQ session.
export async function getLatestNetcoinsQuote(quoteReqId) {
  const id = String(quoteReqId || "").trim();
  if (!id) {
    const error = new Error("A Netcoins quoteReqId is required.");
    error.statusCode = 400;
    throw error;
  }
  return netcoinsJson(`/trading/quotes/${encodeURIComponent(id)}`);
}

export async function cancelNetcoinsQuoteRequest(quoteReqId) {
  const id = String(quoteReqId || "").trim();
  if (!id) {
    const error = new Error("A Netcoins quoteReqId is required.");
    error.statusCode = 400;
    throw error;
  }
  return netcoinsJson(`/trading/quotes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// Executes a live quote. quoteIds expire within seconds (validUntil), so callers
// must quote immediately before executing — never replay a stored quoteId.
export async function executeNetcoinsInstantTrade(quoteId) {
  const id = String(quoteId || "").trim();
  if (!id) {
    const error = new Error("A Netcoins quoteId is required to execute a trade.");
    error.statusCode = 400;
    throw error;
  }
  return netcoinsJson("/trading/trades/execute/instant", { method: "POST", body: { quoteId: id } });
}

export async function previewNetcoinsLimitOrder({ baseCurrency, quoteCurrency, action, price, baseAmount, quoteAmount }) {
  const body = {
    baseCurrency: String(baseCurrency || "").trim().toUpperCase(),
    quoteCurrency: String(quoteCurrency || "").trim().toUpperCase(),
    action: String(action || "").trim().toLowerCase(),
    price: String(price ?? "").trim(),
  };
  if (baseAmount !== undefined && baseAmount !== null && baseAmount !== "") body.baseAmount = String(baseAmount);
  else if (quoteAmount !== undefined && quoteAmount !== null && quoteAmount !== "") body.quoteAmount = String(quoteAmount);
  else {
    const error = new Error("Provide exactly one of baseAmount or quoteAmount for a Netcoins limit preview.");
    error.statusCode = 400;
    throw error;
  }
  return netcoinsJson("/trading/trades/execute/limit/preview", { method: "POST", body });
}

export async function executeNetcoinsLimitOrder({ baseCurrency, quoteCurrency, action, price, baseAmount, quoteAmount }) {
  const preview = await previewNetcoinsLimitOrder({ baseCurrency, quoteCurrency, action, price, baseAmount, quoteAmount });
  return netcoinsJson("/trading/trades/execute/limit", {
    method: "POST",
    body: {
      baseCurrency: preview.base_currency || String(baseCurrency).toUpperCase(),
      quoteCurrency: preview.quote_currency || String(quoteCurrency).toUpperCase(),
      action: preview.action || String(action).toLowerCase(),
      price: String(preview.price ?? price),
      ...(preview.base_amount ? { baseAmount: String(preview.base_amount) } : { quoteAmount: String(preview.quote_amount) }),
    },
  });
}

export async function listNetcoinsTrades() {
  return netcoinsJson("/trading/trades");
}

export async function getNetcoinsTrade(tradeId) {
  const id = String(tradeId || "").trim();
  if (!id) {
    const error = new Error("A Netcoins trade id is required.");
    error.statusCode = 400;
    throw error;
  }
  return netcoinsJson(`/trading/trades/${encodeURIComponent(id)}`);
}

export async function cancelNetcoinsTrade(tradeId) {
  const id = String(tradeId || "").trim();
  if (!id) {
    const error = new Error("A Netcoins trade id is required.");
    error.statusCode = 400;
    throw error;
  }
  return netcoinsJson(`/trading/trades/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listNetcoinsPairs() {
  return netcoinsJson("/trading/pairs");
}

export async function getNetcoinsPair(base, quote) {
  const baseSymbol = String(base || "").trim().toUpperCase();
  const quoteSymbol = String(quote || "").trim().toUpperCase();
  if (!baseSymbol || !quoteSymbol) {
    const error = new Error("A Netcoins trading pair requires base and quote symbols.");
    error.statusCode = 400;
    throw error;
  }
  return netcoinsJson(`/trading/pairs/${encodeURIComponent(baseSymbol)}/${encodeURIComponent(quoteSymbol)}`);
}

export async function getNetcoinsPermissions() {
  return netcoinsJson("/trading/permissions");
}

export async function getNetcoinsBalances(subAccountType) {
  const type = String(subAccountType || "").trim().toLowerCase();
  return netcoinsJson(type ? `/balances/${encodeURIComponent(type)}` : "/balances");
}

export async function listNetcoinsAssets() {
  return netcoinsJson("/assets");
}

export async function getNetcoinsMarketPrices(base, quote) {
  const baseSymbol = String(base || "").trim().toUpperCase();
  const quoteSymbol = String(quote || "").trim().toUpperCase();
  return netcoinsJson(baseSymbol && quoteSymbol
    ? `/markets/prices/${encodeURIComponent(baseSymbol)}/${encodeURIComponent(quoteSymbol)}`
    : "/markets/prices");
}

export async function getNetcoinsMarketStats() {
  return netcoinsJson("/markets/stats");
}
