// Linkio (LINK.IO Financial / LINK Technology Ltd) FX & ramp adapter.
// Authoritative spec: https://docs.linkio.world (Mintlify; llms.txt index).
//
// Verified live from this machine on 2026-11-14 with the LINKIO_SECRET_KEY in
// .env (single `ngnc-sec-key` header authenticates BOTH the Retail and B2B
// APIs — B2B access is already provisioned, confirmed against
// GET /otc/rate_quote for USD and NGN):
//   Retail rate:  GET /transactions/v2/retail_rate?trx_type=onramp&currency=USD&amount=1000
//                 -> {"NGNUSDC":1434.939,"USDUSDC":1.0095}
//   B2B onramp:   GET /otc/rate_quote?currency=USD&trx_type=onramp&amount=1000
//                 -> rate 1.0095, payout_amount 990.59, payment_asset USDT/USDC, ACH
//   B2B NGN:      GET /otc/rate_quote?currency=NGN&trx_type=onramp&amount=500000
//                 -> rate 1429.9417, payout_amount 349.66, LOCAL_BANK_TRANSFER
//
// Regulation: FINTRAC MSB N300000211, US FinCEN MSB 31000339351347;
// Circle Alliance Program member. Fees are baked into the rate (B2B ~0.5%).
//
// Key conventions:
//   - B2B fiat enum (26 currencies — NOTE: CAD is NOT in the B2B set; CAD is a
//     Retail/Direct-FX corridor only, e.g. Interac). B2B set:
//     AED AOA BIF CDF DZD EGP ETB EUR GBP GHS LYD MAD MUR MWK MZN NGN SGD SLE
//     SSP TRY TZS UGX USD XAF XOF.
//   - Stablecoins: USDC, USDT. USDC networks: ETHEREUM, BSC, POLYGON, BASE,
//     SOLANA, STELLAR. USDT networks: TRON, POLYGON, SOLANA.
//   - B2B on/off-ramp POST bodies require customer_id, currency, amount,
//     stables, wallet_address, network and paymentDetails (ACH / local bank /
//     IBAN / RIB shape depending on currency — get it from the rate quote's
//     paymentMethod). Settlement account details for onramps arrive via the
//     `banking_details_received` webhook.
//   - A test key returns test transactions; a live key returns live ones —
//     there is no separate sandbox host to configure.
//   - Retail (Direct FX) ramps: NGN/USD only, vendor-bank collection, min
//     ~15,000 NGN / ~20 USD, KYC handled by LINK.

const TOKEN = () => String(process.env.LINKIO_SECRET_KEY || "").trim();

const isUsableCredential = (value) =>
  Boolean(value) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder|test)$/i.test(value.trim());

export function getLinkioBaseUrl() {
  const configured = String(process.env.LINKIO_API_BASE_URL || "").trim().replace(/\/+$/, "");
  return configured || "https://api.linkio.world";
}

// Curated from the B2B rate-quote enum in the published OpenAPI spec.
export const LINKIO_B2B_FIAT_CURRENCIES = new Set([
  "AED", "AOA", "BIF", "CDF", "DZD", "EGP", "ETB", "EUR", "GBP", "GHS",
  "LYD", "MAD", "MUR", "MWK", "MZN", "NGN", "SGD", "SLE", "SSP", "TRY",
  "TZS", "UGX", "USD", "XAF", "XOF",
]);

// Conservative StableX routing scope: USDC as the stable leg, mirroring the
// Netcoins adapter. USDT is accepted by the API but kept out of routing until
// a business decision expands the asset scope.
export const LINKIO_ROUTING_STABLES = new Set(["USDC"]);
export const LINKIO_API_STABLES = new Set(["USDC", "USDT"]);

const NETWORKS_BY_STABLE = {
  USDC: new Set(["ETHEREUM", "BSC", "POLYGON", "BASE", "SOLANA", "STELLAR"]),
  USDT: new Set(["TRON", "POLYGON", "SOLANA"]),
};

const TRX_TYPES = new Set(["onramp", "offramp"]);

export function getLinkioReadiness() {
  const missingVariables = [];
  if (!isUsableCredential(TOKEN())) missingVariables.push("LINKIO_SECRET_KEY");
  return {
    name: "Linkio",
    configured: missingVariables.length === 0,
    status: missingVariables.length === 0
      ? "CREDENTIALS_PRESENT_B2B_RATE_QUOTES_LIVE_VERIFIED"
      : "AWAITING_PROVIDER_CREDENTIALS",
    environment: "single-host (test key -> test transactions, live key -> live transactions)",
    missingVariables,
    capabilities: [
      "B2B_RATE_QUOTE_PREVIEW_25_FIAT_CURRENCIES",
      "B2B_ONRAMP_OFFRAMP_EXECUTION_ADAPTER",
      "RETAIL_DIRECT_FX_ONRAMP_OFFRAMP_ADAPTER",
      "RETAIL_RATE_BOARD",
      "TRANSACTION_STATUS_AND_PAYOUT_STATUS",
    ],
    executionEnabled: false,
    executionNote:
      "B2B on/off-ramp initiation is implemented server-side behind the operator gate. " +
      "Keep it disabled for customers until one end-to-end transaction (with real settlement details) has been verified.",
    scopeNotes: [
      "B2B API has no CAD: CAD is a Retail/Direct-FX corridor (Interac). CAD payouts need Nomba Global Payout (Interac) or the retail corridor.",
      "B2B onramps deliver settlement account details via the banking_details_received webhook — configure it before enabling execution.",
      "Fees are baked into the quoted rate (~0.5% B2B markup); developer fees may be configurable for customer spread.",
    ],
  };
}

function linkioError(response, payload) {
  const message =
    payload?.message || payload?.description ||
    `Linkio request failed with HTTP ${response.status}.`;
  const error = new Error(message);
  error.provider = "Linkio";
  error.providerStatus = response.status;
  error.providerResponse = payload;
  if (response.status === 400 || response.status === 404) error.statusCode = 400;
  else if (response.status === 401 || response.status === 403) error.statusCode = 502;
  else if (response.status === 429) error.statusCode = 429;
  else error.statusCode = 503;
  return error;
}

async function linkioJson(path, { method = "GET", query, body } = {}) {
  if (!isUsableCredential(TOKEN())) {
    const error = new Error("Linkio credentials are not configured. Set LINKIO_SECRET_KEY (and optionally LINKIO_API_BASE_URL).");
    error.statusCode = 503;
    throw error;
  }
  const url = new URL(`${getLinkioBaseUrl()}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "ngnc-sec-key": TOKEN(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 204) return {};
  // Retail endpoints can answer errors with an empty text/plain body.
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw linkioError(response, payload);
  // B2B wraps in `data`; retail returns the object directly.
  return payload?.data ?? payload;
}

function requireStableAndFiat(from, to) {
  const fromUpper = String(from || "").trim().toUpperCase();
  const toUpper = String(to || "").trim().toUpperCase();
  if (!fromUpper || !toUpper) {
    const error = new Error("A Linkio rate request requires 'from' and 'to' currencies.");
    error.statusCode = 400;
    throw error;
  }
  const fromIsStable = LINKIO_API_STABLES.has(fromUpper);
  const toIsStable = LINKIO_API_STABLES.has(toUpper);
  if (fromIsStable === toIsStable) {
    const error = new Error(
      `Linkio quotes require one stablecoin (${[...LINKIO_API_STABLES].join(", ")}) and one fiat currency.`
    );
    error.statusCode = 400;
    throw error;
  }
  const stable = fromIsStable ? fromUpper : toUpper;
  const fiat = fromIsStable ? toUpper : fromUpper;
  if (!LINKIO_B2B_FIAT_CURRENCIES.has(fiat)) {
    const error = new Error(
      `Linkio B2B quotes support these fiat currencies: ${[...LINKIO_B2B_FIAT_CURRENCIES].sort().join(", ")}. ` +
      "CAD and other corridors are Retail/Direct-FX only."
    );
    error.statusCode = 400;
    throw error;
  }
  return { stable, fiat, fromIsStable };
}

function requirePositiveAmount(amount) {
  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    const error = new Error("Linkio quotes require a positive numeric amount.");
    error.statusCode = 400;
    throw error;
  }
  return amountNumber;
}

// Routing preview: the binding-shaped B2B rate quote. GET /otc/rate_quote
// returns { trx_type, rate, payout_amount, payment_asset, paymentMethod }.
// 'rate' is fiat-per-stable (USD onramp: rate 1.0095 -> $1000 pays out 990.59).
export async function getLinkioRate({ from, to, amount }) {
  const { stable, fiat, fromIsStable } = requireStableAndFiat(from, to);
  const amountNumber = requirePositiveAmount(amount);

  const trxType = fromIsStable ? "offramp" : "onramp";
  const quote = await linkioJson("/otc/rate_quote", {
    query: { currency: fiat, trx_type: trxType, amount: String(amountNumber) },
  });

  const payoutAmount = Number(quote?.payout_amount);
  const rate = Number(quote?.rate);
  if (!Number.isFinite(payoutAmount) || payoutAmount <= 0 || !Number.isFinite(rate) || rate <= 0) {
    const error = new Error("Linkio rate quote response did not include a usable rate and payout_amount.");
    error.statusCode = 502;
    throw error;
  }

  return {
    provider: "Linkio",
    quoteType: "B2B_RATE_QUOTE",
    from: String(from).toUpperCase(),
    to: String(to).toUpperCase(),
    amount: amountNumber,
    direction: fromIsStable ? "OFFRAMP" : "ONRAMP",
    stableLeg: stable,
    fiatLeg: fiat,
    destinationAmount: payoutAmount,
    rate,
    paymentAsset: quote.payment_asset || null,
    paymentMethod: quote.paymentMethod || null,
    observedAt: new Date().toISOString(),
    providerData: quote,
    executionEnabled: false,
    note: "Linkio B2B rate quote; fees (~0.5%) are baked into the rate. Binding only when a B2B on/off-ramp transaction is actually initiated.",
  };
}

export async function getLinkioB2BRateQuote({ currency, trxType, amount }) {
  const normalizedCurrency = String(currency || "").trim().toUpperCase();
  const normalizedTrxType = String(trxType || "").trim().toLowerCase();
  if (!LINKIO_B2B_FIAT_CURRENCIES.has(normalizedCurrency)) {
    const error = new Error(`currency must be one of: ${[...LINKIO_B2B_FIAT_CURRENCIES].sort().join(", ")}.`);
    error.statusCode = 400;
    throw error;
  }
  if (!TRX_TYPES.has(normalizedTrxType)) {
    const error = new Error("trxType must be 'onramp' or 'offramp'.");
    error.statusCode = 400;
    throw error;
  }
  const amountNumber = requirePositiveAmount(amount);
  return linkioJson("/otc/rate_quote", {
    query: { currency: normalizedCurrency, trx_type: normalizedTrxType, amount: String(amountNumber) },
  });
}

function requireB2BTransactionFields({ customerId, currency, stables, walletAddress, network, paymentDetails }) {
  const missing = [];
  if (!customerId) missing.push("customerId");
  if (!currency) missing.push("currency");
  if (!stables) missing.push("stables");
  if (!walletAddress) missing.push("walletAddress");
  if (!network) missing.push("network");
  if (!paymentDetails || typeof paymentDetails !== "object" || Object.keys(paymentDetails).length === 0) {
    missing.push("paymentDetails");
  }
  if (missing.length) {
    const error = new Error(`Linkio B2B transaction requires: ${missing.join(", ")}.`);
    error.statusCode = 400;
    throw error;
  }
  const stable = String(stables).trim().toUpperCase();
  const allowedNetworks = NETWORKS_BY_STABLE[stable];
  if (!allowedNetworks) {
    const error = new Error(`stables must be one of: ${[...LINKIO_API_STABLES].join(", ")}.`);
    error.statusCode = 400;
    throw error;
  }
  const normalizedNetwork = String(network).trim().toUpperCase();
  if (!allowedNetworks.has(normalizedNetwork)) {
    const error = new Error(
      `network ${normalizedNetwork} is not supported for ${stable}. Supported: ${[...allowedNetworks].join(", ")}.`
    );
    error.statusCode = 400;
    throw error;
  }
  const normalizedCurrency = String(currency).trim().toUpperCase();
  if (!LINKIO_B2B_FIAT_CURRENCIES.has(normalizedCurrency)) {
    const error = new Error(
      `Linkio B2B transactions support these fiat currencies: ${[...LINKIO_B2B_FIAT_CURRENCIES].sort().join(", ")}.`
    );
    error.statusCode = 400;
    throw error;
  }
  requirePositiveAmount(arguments[0].amount);
  return {
    customer_id: String(customerId),
    currency: normalizedCurrency,
    amount: String(arguments[0].amount),
    stables: stable,
    wallet_address: String(walletAddress),
    network: normalizedNetwork,
    paymentDetails,
  };
}

// POST /otc/onramp — fiat -> stablecoin. Settlement account details arrive via
// the banking_details_received webhook. 201 { code: TXN_SUCCESSFUL, data }.
export async function requestLinkioB2BOnramp(request) {
  const body = requireB2BTransactionFields(request);
  return linkioJson("/otc/onramp", { method: "POST", body });
}

// POST /otc/offramp — stablecoin -> fiat payout to the settlement account.
export async function requestLinkioB2BOfframp(request) {
  const body = requireB2BTransactionFields(request);
  return linkioJson("/otc/offramp", { method: "POST", body });
}

// Retail (Direct FX) ramps: NGN/USD only; LINK handles the end-customer's KYC.
// Onramp returns the vendor collection account the customer pays into.
const RETAIL_FIAT_CURRENCIES = new Set(["NGN", "USD"]);

function requireRetailCurrency(currency) {
  const normalized = String(currency || "").trim().toUpperCase();
  if (!RETAIL_FIAT_CURRENCIES.has(normalized)) {
    const error = new Error("Linkio retail (Direct FX) ramps support NGN and USD only.");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

export async function requestLinkioRetailOnramp({ currency, amount, stables, walletAddress, network, vendor }) {
  const body = {
    currency: requireRetailCurrency(currency),
    amount: String(requirePositiveAmount(amount)),
    stables: String(stables || "").trim().toUpperCase(),
  };
  if (!LINKIO_API_STABLES.has(body.stables)) {
    const error = new Error(`stables must be one of: ${[...LINKIO_API_STABLES].join(", ")}.`);
    error.statusCode = 400;
    throw error;
  }
  if (walletAddress) body.wallet_address = String(walletAddress);
  if (network) body.network = String(network).trim().toUpperCase();
  if (vendor && typeof vendor === "object") {
    if (vendor.bank) body.vendor_bank = String(vendor.bank);
    if (vendor.number) body.vendor_number = String(vendor.number);
    if (vendor.name) body.vendor_name = String(vendor.name);
  }
  return linkioJson("/transactions/v2/onramp", { method: "POST", body });
}

export async function requestLinkioRetailOfframp({
  currency, amount, stables, bankName, accountNumber, accountName,
  walletAddress, network, routingNumber, accountType, chargeFeeOnRequest,
}) {
  const body = {
    currency: requireRetailCurrency(currency),
    amount: String(requirePositiveAmount(amount)),
    stables: String(stables || "").trim().toUpperCase(),
  };
  if (!LINKIO_API_STABLES.has(body.stables)) {
    const error = new Error(`stables must be one of: ${[...LINKIO_API_STABLES].join(", ")}.`);
    error.statusCode = 400;
    throw error;
  }
  if (!bankName || !accountNumber || !accountName) {
    const error = new Error("Linkio retail offramp requires bankName, accountNumber and accountName.");
    error.statusCode = 400;
    throw error;
  }
  body.bank_name = String(bankName);
  body.account_number = String(accountNumber);
  body.account_name = String(accountName);
  if (walletAddress) body.wallet_address = String(walletAddress);
  if (network) body.network = String(network).trim().toUpperCase();
  if (routingNumber) body.routing_number = String(routingNumber);
  if (accountType) body.account_type = String(accountType);
  if (chargeFeeOnRequest !== undefined) body.chargeFeeOnRequest = Boolean(chargeFeeOnRequest);
  return linkioJson("/transactions/v2/offramp", { method: "POST", body });
}

// GET /transactions/v2/fetch_transaction?transaction_reference=...
export async function getLinkioTransaction(reference) {
  const normalized = String(reference || "").trim();
  if (!normalized) {
    const error = new Error("A Linkio transaction reference is required.");
    error.statusCode = 400;
    throw error;
  }
  return linkioJson("/transactions/v2/fetch_transaction", {
    query: { transaction_reference: normalized },
  });
}

// GET /transactions/v2/direct_ramp/payout/status?trx_reference=...
export async function getLinkioPayoutStatus(reference) {
  const normalized = String(reference || "").trim();
  if (!normalized) {
    const error = new Error("A Linkio trx reference is required.");
    error.statusCode = 400;
    throw error;
  }
  return linkioJson("/transactions/v2/direct_ramp/payout/status", {
    query: { trx_reference: normalized },
  });
}

// ---------------------------------------------------------------------------
// Inbound webhook events from Linkio (registered in the Linkio dashboard).
// The most important event is `banking_details_received`: after a B2B onramp is
// created, Linkio pushes the fiat settlement account details the payer must
// transfer into. Events are kept in a bounded in-memory buffer and exposed to
// the operator via GET /api/linkio/webhooks.
// ---------------------------------------------------------------------------
const WEBHOOK_EVENT_LIMIT = 100;
const linkioEvents = [];

// Linkio envelope: { event: "bridge.events.transaction_request.updated"|"...successful",
// payload: { reference, payment_type, transaction_status, Notification?, ... } }.
export function recordLinkioEvent(event) {
  const payload = event?.payload || {};
  const record = {
    receivedAt: new Date().toISOString(),
    event: event?.event || event?.type || "unknown",
    reference: payload.reference || event?.trx_reference || event?.reference || null,
    paymentType: payload.payment_type || null,
    status: payload.transaction_status || null,
    notification: payload.Notification || null,
    signaturePresent: Boolean(event?._signatureHeader),
    payload: event,
  };
  linkioEvents.unshift(record);
  if (linkioEvents.length > WEBHOOK_EVENT_LIMIT) linkioEvents.pop();
  return record;
}

export function listLinkioEvents() {
  return linkioEvents;
}

export function linkioEventsForReference(reference) {
  return linkioEvents.filter((entry) => entry.reference === reference);
}

// ---------------------------------------------------------------------------
// Customer onramp sessions (signed-in customers only). A session wraps one
// Linkio B2B onramp: the customer supplies their payout wallet and the NGN bank
// account they will pay FROM, the server creates the onramp, and the fiat
// settlement account details arrive via the banking_details_received webhook.
// ---------------------------------------------------------------------------
const onrampSessions = new Map();

export async function startLinkioCustomerOnramp({
  customerId, currency, amount, stables, network, walletAddress, bankDetails,
}) {
  const quote = await getLinkioB2BRateQuote({ currency, trxType: "onramp", amount });
  const transaction = await requestLinkioB2BOnramp({
    customerId,
    currency,
    amount,
    stables,
    walletAddress,
    network,
    paymentDetails: bankDetails,
  });
  const reference = transaction?.reference || transaction?.data?.reference || null;
  const session = {
    reference,
    transactionId: transaction?.transaction_id || transaction?.data?.transaction_id || null,
    customerId,
    currency,
    amount,
    stables,
    network,
    walletAddress,
    rate: transaction?.rate ?? quote?.rate ?? null,
    payoutAmount: transaction?.payout_amount ?? quote?.payout_amount ?? null,
    paymentMethod: quote?.paymentMethod || null,
    status: transaction?.transaction_status || transaction?.data?.transaction_status || "pending",
    startedAt: new Date().toISOString(),
  };
  if (reference) onrampSessions.set(reference, session);
  return session;
}

export function getLinkioOnrampSession(reference) {
  return onrampSessions.get(String(reference || "")) || null;
}
