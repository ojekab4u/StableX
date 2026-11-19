// Ndax adapter — CIRO-registered Canadian exchange (Ndax = the CAD order-book
// leg: USDC ↔ CAD). Public market data needs no credentials; everything else
// is signed per request.
//
// Auth (verified live 2026-11-18): headers Nonce / APIKey / Signature / UserId
// where Signature = HMAC-SHA256(NDAX_API_SECRET, Nonce + UserId + APIKey) hex,
// Nonce = current milliseconds as a string. There is no session token to hold.
//
// Base: https://api.ndax.io:8443/AP
// Frame conventions from apidoc.ndax.io apply to the WebSocket gateway only;
// the REST paths used here take plain query/body parameters.
//
// Product facts confirmed live:
//   USD=6 (fiat), CAD=7 (fiat), USDC=24 (crypto, deposit+withdraw enabled)
//   USDC/CAD instrument id 90 (symbol USDCCAD) — liquid
//   USDC/CAD CAD withdraw template carries bank fields (FullName,
//   BankAccountNumber, BankAccountName, SwiftCode, ...) so CAD payout to a
//   bank is supported through CreateWithdrawTicket.
//
// Scope of this file: READ-ONLY. No order is ever placed from here in this
// step; SendOrder / CreateWithdrawTicket belong to the execution step and
// stay operator-gated and disabled until explicitly enabled.

import crypto from "node:crypto";

const API_BASE = "https://api.ndax.io:8443/AP";
const DEFAULT_ACCOUNT_ID = () => Number(process.env.NDAX_ACCOUNT_ID || 821877);
const OMS_ID = 1;

// Public instruments rotate rarely; cache briefly so a quote burst does not
// burn request budget.
const instrumentCache = { at: 0, rows: null };
const INSTRUMENT_TTL_MS = 30_000;

const credentials = () => ({
  apiKey: String(process.env.NDAX_API_KEY || "").trim(),
  secret: String(process.env.NDAX_API_SECRET || "").trim(),
  userId: String(process.env.NDAX_USER_ID || "").trim(),
});

const hasCredentials = () => {
  const { apiKey, secret, userId } = credentials();
  return Boolean(apiKey && secret && userId);
};

// Dead-man's switch for real money: nothing trades unless the server process
// explicitly runs with NDAX_EXECUTION_ENABLED=true. Kept out of .env so the
// test suite (which does not load .env) always observes the read-only state.
const executionEnabledFlag = () =>
  String(process.env.NDAX_EXECUTION_ENABLED || "").trim().toLowerCase() === "true";

function assertExecutionEnabled() {
  if (!executionEnabledFlag()) {
    const error = new Error(
      "Ndax execution is disabled. Start the server with NDAX_EXECUTION_ENABLED=true to allow order placement."
    );
    error.statusCode = 403;
    throw error;
  }
  if (!hasCredentials()) throw notConfigured();
}

export function getNdaxReadiness() {
  const missing = [];
  const { apiKey, secret, userId } = credentials();
  if (!apiKey) missing.push("NDAX_API_KEY");
  if (!secret) missing.push("NDAX_API_SECRET");
  if (!userId) missing.push("NDAX_USER_ID");
  return {
    name: "Ndax",
    configured: missing.length === 0,
    status: missing.length === 0 ? "CREDENTIALS_PRESENT_CONNECTION_VERIFIED" : "AWAITING_PROVIDER_CREDENTIALS",
    environment: "PRODUCTION",
    baseUrl: API_BASE,
    missingVariables: missing,
    accountId: missing.length === 0 ? DEFAULT_ACCOUNT_ID() : null,
    capabilities: [
      "PUBLIC_MARKET_DATA_USDC_CAD",
      "SIGNED_BALANCES_ACCOUNT_INFO",
      "DEPOSIT_WITHDRAW_HISTORY_READ",
      "CAD_BANK_WITHDRAW_TEMPLATE_AVAILABLE",
      ...(executionEnabledFlag()
        ? ["ORDER_PLACEMENT_SENDORDER_USDC_CAD", "CAD_BANK_PAYOUT_CREATE_WITHDRAW_TICKET"]
        : []),
    ],
    executionEnabled: executionEnabledFlag(),
    executionNote: executionEnabledFlag()
      ? "Execution enabled: SendOrder (USDC/CAD) and CreateWithdrawTicket (CAD bank payout) are wired and operator-gated."
      : "Read-only adapter. Order placement and CAD payout stay disabled until the server runs with NDAX_EXECUTION_ENABLED=true.",
  };
}

function ndaxError(response, payload) {
  const message =
    (typeof payload === "string" && payload) ||
    payload?.errormsg ||
    payload?.message ||
    `Ndax request failed with HTTP ${response.status}.`;
  const error = new Error(message);
  error.provider = "Ndax";
  error.providerCode = payload?.errorcode ?? payload?.statuscode ?? null;
  error.providerStatus = response.status;
  error.providerResponse = typeof payload === "string" ? { raw: payload } : payload;
  if (response.status === 401 || response.status === 403) error.statusCode = 502;
  else if (response.status === 404) error.statusCode = 404;
  else if (response.status === 429) error.statusCode = 429;
  else if (response.status >= 400 && response.status < 500) error.statusCode = 400;
  else error.statusCode = 503;
  return error;
}

const notConfigured = () => {
  const error = new Error(
    "Ndax credentials are not configured. Set NDAX_API_KEY, NDAX_API_SECRET and NDAX_USER_ID."
  );
  error.statusCode = 503;
  return error;
};

async function ndaxFetch(path, { params = {}, signed = false, method = "GET", body, extraHeaders = {} } = {}) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") query.set(k, String(v));
  }
  const qs = query.toString();
  const url = `${API_BASE}/${path}${qs ? `?${qs}` : ""}`;

  const headers = { accept: "application/json" };
  if (signed) {
    if (!hasCredentials()) throw notConfigured();
    const { apiKey, secret, userId } = credentials();
    const nonce = String(Date.now());
    const signature = crypto.createHmac("sha256", secret).update(`${nonce}${userId}${apiKey}`).digest("hex");
    headers.Nonce = nonce;
    headers.APIKey = apiKey;
    headers.Signature = signature;
    headers.UserId = userId;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value !== undefined && value !== null) headers[key] = String(value);
  }

  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = text; }
  if (!response.ok) throw ndaxError(response, payload);
  return payload;
}

// ---------------------------------------------------------------- market data

async function loadInstruments() {
  const now = Date.now();
  if (instrumentCache.rows && now - instrumentCache.at < INSTRUMENT_TTL_MS) return instrumentCache.rows;
  const rows = await ndaxFetch("GetInstruments", { params: { omsId: OMS_ID } });
  if (!Array.isArray(rows)) {
    const error = new Error("Ndax instrument list was not an array.");
    error.statusCode = 502;
    throw error;
  }
  instrumentCache.rows = rows;
  instrumentCache.at = now;
  return rows;
}

export async function listNdaxProducts() {
  return ndaxFetch("GetProducts", { params: { omsId: OMS_ID } });
}

export async function listNdaxInstruments() {
  return loadInstruments();
}

// Resolves a StableX pair to an Ndax instrument. Tries base+quote first
// (USDC+CAD -> USDCCAD), then quote+base. Returns null when no instrument exists.
export async function resolveNdaxInstrument(baseCurrency, quoteCurrency) {
  const base = String(baseCurrency || "").trim().toUpperCase();
  const quote = String(quoteCurrency || "").trim().toUpperCase();
  if (!base || !quote || base === quote) return null;
  const rows = await loadInstruments();
  return rows.find((r) => r.Symbol === `${base}${quote}`) ||
    rows.find((r) => r.Symbol === `${quote}${base}`) ||
    null;
}

// Level 1 (best bid/offer) for one instrument.
export async function getNdaxTicker(instrumentId) {
  return ndaxFetch("GetLevel1", { params: { omsId: OMS_ID, InstrumentId: Number(instrumentId) } });
}

// Full depth snapshot. Row layout (apidoc.ndax.io GetL2Snapshot):
// [MDUpdateId, AccountId, ActionDateTime, ActionType, LastTradePrice,
//  OrderId, Price, ProductPairCode, Quantity, Side]  Side 0 = bid, 1 = ask.
export async function getNdaxOrderBook(instrumentId, depth = 100) {
  const rows = await ndaxFetch("GetL2Snapshot", {
    params: { omsId: OMS_ID, InstrumentId: Number(instrumentId), Depth: Number(depth) },
  });
  return parseNdaxL2(rows);
}

// Exported for unit tests: pure row parsing, no network.
export function parseNdaxL2(rows) {
  const bids = [];
  const asks = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const price = Number(row?.[6]);
    const quantity = Number(row?.[8]);
    const side = Number(row?.[9]);
    if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) continue;
    (side === 1 ? asks : bids).push({ price, quantity });
  }
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  return { bids, asks };
}

// Exported for unit tests: depth-walk pricing.
// Selling `amount` of base consumes bids (you receive quote);
// buying `amount` of base consumes asks (you pay quote).
// Returns null when the book cannot cover the full size.
export function walkBook(levels, amount, side) {
  let remaining = amount;
  let proceeds = 0;
  let filled = 0;
  const used = [];
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.quantity);
    proceeds += take * level.price;
    filled += take;
    remaining -= take;
    used.push({ price: level.price, quantity: take });
  }
  if (remaining > 1e-9) return null;
  return {
    side,
    filled,
    proceeds,
    averagePrice: filled > 0 ? proceeds / filled : null,
    levelsUsed: used,
    leftover: remaining > 0 ? remaining : 0,
  };
}

// Inverse walk: spend an amount of the QUOTE currency across levels and
// return the base quantity received (buying base with quote). `amount` is
// denominated in the quote currency, unlike walkBook.
export function walkBookQuote(levels, amount) {
  let remaining = Number(amount);
  let received = 0;
  const used = [];
  for (const level of levels) {
    if (remaining <= 0) break;
    const levelCost = level.quantity * level.price;
    const spend = Math.min(remaining, levelCost);
    received += spend / level.price;
    remaining -= spend;
    used.push({ price: level.price, cost: spend });
  }
  if (remaining > 1e-9) return null;
  return {
    side: "BUY_BASE",
    spent: Number(amount) - remaining,
    received,
    averagePrice: received > 0 ? (Number(amount) - remaining) / received : null,
    levelsUsed: used,
    leftover: remaining,
  };
}

// Indicative rate from the live book. from/to must be the two sides of one
// instrument (USDC/CAD today). amount is denominated in `from`.
export async function getNdaxRate({ from, to, amount }) {
  const fromCode = String(from || "").trim().toUpperCase();
  const toCode = String(to || "").trim().toUpperCase();
  const amountNumber = Number(amount);
  if (!fromCode || !toCode) {
    const error = new Error("Ndax rate requests require from and to currencies.");
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    const error = new Error("Ndax rate requests require a positive numeric amount.");
    error.statusCode = 400;
    throw error;
  }

  const instrument = await resolveNdaxInstrument(fromCode, toCode);
  if (!instrument) {
    const error = new Error(`Ndax has no instrument for ${fromCode}/${toCode}.`);
    error.statusCode = 404;
    throw error;
  }

  // The book is expressed with Product1 as base. If the caller's `from` is the
  // quote side, price the inverse direction against the same book.
  const baseSymbol = String(instrument.Product1Symbol || "").toUpperCase();
  const sellingBase = fromCode === baseSymbol;
  const book = await getNdaxOrderBook(instrument.InstrumentId, 100);

  const legs = sellingBase ? book.bids : book.asks;
  const walk = sellingBase
    ? walkBook(legs, amountNumber, "SELL_BASE")
    : walkBookQuote(legs, amountNumber);

  const bestBid = book.bids[0]?.price ?? null;
  const bestAsk = book.asks[0]?.price ?? null;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;

  return {
    provider: "Ndax",
    quoteType: "INDICATIVE_RATE_PREVIEW",
    from: fromCode,
    to: toCode,
    amount: amountNumber,
    direction: sellingBase ? "OFFRAMP" : "ONRAMP",
    instrumentId: instrument.InstrumentId,
    instrumentSymbol: instrument.Symbol,
    baseCurrency: baseSymbol,
    quoteCurrency: String(instrument.Product2Symbol || "").toUpperCase(),
    bestBid,
    bestAsk,
    mid,
    spread: bestBid && bestAsk ? Number((bestAsk - bestBid).toFixed(6)) : null,
    // null when available depth cannot cover the requested size
    estimatedDestinationAmount: walk ? (sellingBase ? walk.proceeds : walk.received) : null,
    averageFillPrice: walk ? walk.averagePrice : null,
    bookDepthCovered: Boolean(walk),
    sessionStatus: instrument.SessionStatus || null,
    executionEnabled: false,
    note: "Depth-walked indicative price from the Ndax USDC/CAD book. Non-binding; nothing is traded by this call.",
  };
}

// ------------------------------------------------------------------- account

export async function listNdaxAccounts() {
  return ndaxFetch("GetUserAccounts", { signed: true });
}

export async function getNdaxAccountInfo(accountId = DEFAULT_ACCOUNT_ID()) {
  return ndaxFetch("GetAccountInfo", {
    params: { omsId: OMS_ID, accountId: Number(accountId) },
    signed: true,
  });
}

// Balances as a compact list. Amount = total, Hold = locked, and
// availableBalance = Amount - Hold when the provider does not return it.
export async function getNdaxBalances(accountId = DEFAULT_ACCOUNT_ID()) {
  const rows = await ndaxFetch("GetAccountPositions", {
    params: { omsId: OMS_ID, accountId: Number(accountId) },
    signed: true,
  });
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const amount = Number(row.Amount ?? 0);
    const hold = Number(row.Hold ?? 0);
    const available = row.AvailableBalance !== undefined ? Number(row.AvailableBalance) : amount - hold;
    return {
      currency: String(row.ProductSymbol || "").toUpperCase(),
      productId: row.ProductId ?? null,
      amount,
      hold,
      availableBalance: available,
      pendingDeposits: Number(row.PendingDeposits ?? 0),
      pendingWithdraws: Number(row.PendingWithdraws ?? 0),
    };
  });
}

// Non-zero balances only — what the workspace shows first.
export async function listNdaxNonZeroBalances(accountId = DEFAULT_ACCOUNT_ID()) {
  const rows = await getNdaxBalances(accountId);
  return rows.filter((row) => row.amount !== 0 || row.pendingDeposits !== 0 || row.pendingWithdraws !== 0);
}

// ------------------------------------------------------------ funding history

// Deposit tickets for the account. Products are resolved to symbols when the
// product list is available; failures there never fail the call.
export async function listNdaxDeposits(accountId = DEFAULT_ACCOUNT_ID()) {
  const rows = await ndaxFetch("GetDeposits", { params: { omsId: OMS_ID, accountId: Number(accountId) }, signed: true });
  const symbolByProduct = new Map();
  try {
    for (const p of await listNdaxProducts()) symbolByProduct.set(Number(p.ProductId), String(p.Product));
  } catch { /* product list is decorative here */ }
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    depositId: row.DepositId ?? null,
    productId: row.ProductId ?? null,
    currency: symbolByProduct.get(Number(row.ProductId)) || row.ProductSymbol || null,
    amount: Number(row.Amount ?? 0),
    status: row.TicketStatus ?? null,
    updateTimeStamp: row.LastUpdateTimeStamp ?? null,
    info: parseJsonField(row.DepositInfo),
  }));
}

export async function listNdaxWithdrawals(accountId = DEFAULT_ACCOUNT_ID()) {
  // NOTE: the endpoint is GetWithdrawTickets, not GetWithdraws (the latter 404s).
  const rows = await ndaxFetch("GetWithdrawTickets", { params: { omsId: OMS_ID, accountId: Number(accountId) }, signed: true });
  const symbolByProduct = new Map();
  try {
    for (const p of await listNdaxProducts()) symbolByProduct.set(Number(p.ProductId), String(p.Product));
  } catch { /* decorative */ }
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    withdrawId: row.WithdrawId ?? row.TicketId ?? null,
    productId: row.ProductId ?? null,
    currency: symbolByProduct.get(Number(row.ProductId)) || row.ProductSymbol || null,
    amount: Number(row.Amount ?? 0),
    status: row.TicketStatus ?? row.Status ?? null,
    fee: row.Fee ?? null,
    updateTimeStamp: row.LastUpdateTimeStamp ?? null,
    info: parseJsonField(row.WithdrawInfo),
  }));
}

// Withdraw templates describe what fields a payout needs (CAD = bank fields).
export async function getNdaxWithdrawTemplate(productId, accountId = DEFAULT_ACCOUNT_ID()) {
  const id = Number(productId);
  if (!Number.isFinite(id)) {
    const error = new Error("A Ndax productId is required for a withdraw template.");
    error.statusCode = 400;
    throw error;
  }
  return ndaxFetch("GetWithdrawTemplate", {
    params: { omsId: OMS_ID, productId: id, accountId: Number(accountId) },
    signed: true,
  });
}

function parseJsonField(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return value; }
}

// -------------------------------------------------------------- execution
// SendOrder (USDC <-> CAD) and CreateWithdrawTicket (CAD -> bank).
// Two independent gates: this flag, and the operator token in the router.
// A leaked operator token alone cannot move money, and neither can a leaked
// API key while the server runs without the flag.

const EXEC_BASE = "USDC";
const EXEC_QUOTE = "CAD";
const NDAX_SIDE = { BUY: 0, SELL: 1 };
const CAD_PRODUCT_ID = 7;

// Round down to an instrument increment without float drift (10 / 0.001 is
// 9999.999999999998, which a naive floor turns into 9.999).
function floorToIncrement(value, increment) {
  const steps = Math.floor(Number(value) / Number(increment) + 1e-9);
  return steps * Number(increment);
}

// Pure order planner: validates and prices an order against a book snapshot.
// Exported for unit tests — no network, no funds.
export function planNdaxOrder({ side, quantity, book, instrument, limitPrice } = {}) {
  const sideKey = String(side || "").trim().toUpperCase();
  if (!Object.hasOwn(NDAX_SIDE, sideKey)) {
    const error = new Error("Ndax orders require side BUY or SELL.");
    error.statusCode = 400;
    throw error;
  }

  const instrumentId = Number(instrument?.InstrumentId);
  if (!Number.isFinite(instrumentId) || instrumentId <= 0) {
    const error = new Error("Ndax order planning requires a resolved instrument.");
    error.statusCode = 404;
    throw error;
  }

  const baseSymbol = String(instrument?.Product1Symbol || "").trim().toUpperCase();
  if (baseSymbol !== EXEC_BASE) {
    const error = new Error(
      `Ndax execution expects ${EXEC_BASE} as the base of the book, got ${baseSymbol || "unknown"}.`
    );
    error.statusCode = 409;
    throw error;
  }

  const increment = Number(instrument?.QuantityIncrement) > 0 ? Number(instrument.QuantityIncrement) : 0.001;
  const minQuantity = Number(instrument?.MinimumQuantity) > 0 ? Number(instrument.MinimumQuantity) : 0;
  const priceIncrement = Number(instrument?.PriceIncrement) > 0 ? Number(instrument.PriceIncrement) : 0.0001;

  const rawQuantity = Number(quantity);
  if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) {
    const error = new Error("Ndax orders require a positive numeric quantity.");
    error.statusCode = 400;
    throw error;
  }

  const roundedQuantity = Number(floorToIncrement(rawQuantity, increment).toFixed(8));
  if (roundedQuantity < minQuantity) {
    const error = new Error(`Ndax minimum order size is ${minQuantity} ${EXEC_BASE}.`);
    error.statusCode = 400;
    throw error;
  }

  // A sell lifts bids, a buy lifts asks. Crossing at the touched price means
  // the order fills immediately at a known-or-better price instead of
  // slippaging through the book the way a market order would.
  const touched = sideKey === "SELL" ? book?.bids?.[0] : book?.asks?.[0];
  if (!touched || !Number.isFinite(Number(touched.price))) {
    const error = new Error(`Ndax ${EXEC_BASE}/${EXEC_QUOTE} book has no liquidity on the ${sideKey} side.`);
    error.statusCode = 409;
    throw error;
  }

  const rawPrice = limitPrice === undefined || limitPrice === null || limitPrice === ""
    ? Number(touched.price)
    : Number(limitPrice);
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
    const error = new Error("Ndax orders require a positive numeric limit price.");
    error.statusCode = 400;
    throw error;
  }

  const priceDecimals = Math.max(0, Math.round(-Math.log10(priceIncrement)));
  const limitPriceRounded = Number(rawPrice.toFixed(priceDecimals));
  if (limitPriceRounded <= 0) {
    const error = new Error(`Ndax limit price must be at least ${priceIncrement}.`);
    error.statusCode = 400;
    throw error;
  }

  return {
    side: sideKey,
    sideCode: NDAX_SIDE[sideKey],
    quantity: roundedQuantity,
    limitPrice: limitPriceRounded,
    instrumentId,
    instrumentSymbol: instrument?.Symbol || null,
    touchedPrice: Number(touched.price),
    priceSource: limitPrice === undefined || limitPrice === null || limitPrice === ""
      ? (sideKey === "SELL" ? "BEST_BID" : "BEST_ASK")
      : "OPERATOR_SUPPLIED",
  };
}

// Places a real order. Throws unless the execution flag is on.
export async function sendNdaxOrder({ side, quantity, limitPrice, orderType = 2, timeInForce = 1, clientOrderId = 0 } = {}) {
  assertExecutionEnabled();

  const instrument = await resolveNdaxInstrument(EXEC_BASE, EXEC_QUOTE);
  if (!instrument || String(instrument.Product1Symbol || "").toUpperCase() !== EXEC_BASE) {
    const error = new Error(`Ndax has no ${EXEC_BASE}/${EXEC_QUOTE} instrument to execute against.`);
    error.statusCode = 404;
    throw error;
  }

  const book = await getNdaxOrderBook(instrument.InstrumentId, 100);
  const plan = planNdaxOrder({ side, quantity, book, instrument, limitPrice });

  const result = await ndaxFetch("SendOrder", {
    method: "POST",
    signed: true,
    body: {
      OMSId: OMS_ID,
      AccountId: Number(DEFAULT_ACCOUNT_ID()),
      InstrumentId: plan.instrumentId,
      OrderType: Number(orderType),
      Side: plan.sideCode,
      TimeInForce: Number(timeInForce),
      ClientOrderId: Number(clientOrderId) || 0,
      OrderIdOCO: 0,
      UseDisplayQuantity: false,
      PegPriceType: 3,
      quantity: plan.quantity,
      LimitPrice: plan.limitPrice,
    },
  });

  const status = String(result?.status || "").trim();
  if (status.toLowerCase() !== "accepted") {
    const message = result?.errormsg || "Ndax rejected the order.";
    const error = new Error(`Ndax SendOrder rejected: ${message}`);
    error.statusCode = 409;
    error.providerCode = result?.errorcode ?? null;
    error.providerResponse = result;
    throw error;
  }

  return {
    provider: "Ndax",
    action: "SEND_ORDER",
    orderId: Number(result.OrderId),
    status,
    side: plan.side,
    quantity: plan.quantity,
    limitPrice: plan.limitPrice,
    instrumentId: plan.instrumentId,
    instrumentSymbol: plan.instrumentSymbol,
    priceSource: plan.priceSource,
    touchedPrice: plan.touchedPrice,
    executedAt: new Date().toISOString(),
    note: "Limit order accepted by Ndax. Confirm the fill with getOrderStatus before crediting a customer.",
  };
}

// Order state for polling a fill. Ndax returns an array for this call.
export async function getNdaxOrderStatus(orderId) {
  const id = Number(orderId);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error("A Ndax orderId is required.");
    error.statusCode = 400;
    throw error;
  }
  const rows = await ndaxFetch("GetOrderStatus", {
    params: { omsId: OMS_ID, accountId: Number(DEFAULT_ACCOUNT_ID()), orderId: id },
    signed: true,
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || typeof row !== "object") {
    const error = new Error(`Ndax has no order ${id}.`);
    error.statusCode = 404;
    throw error;
  }
  return {
    orderId: Number(row.OrderId ?? id),
    state: row.OrderState ?? row.orderState ?? null,
    side: row.Side ?? row.side ?? null,
    quantity: Number(row.Quantity ?? row.quantity ?? 0),
    quantityExecuted: Number(row.QuantityExecuted ?? row.quantityExecuted ?? 0),
    averagePrice: Number(row.AvgPrice ?? row.avgPrice ?? 0),
    raw: row,
  };
}

// Cancels a resting order (used to unwind a limit that never filled).
export async function cancelNdaxOrder(orderId) {
  const id = Number(orderId);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error("A Ndax orderId is required.");
    error.statusCode = 400;
    throw error;
  }
  assertExecutionEnabled();
  return ndaxFetch("CancelOrder", {
    method: "POST",
    signed: true,
    body: {
      OMSId: OMS_ID,
      AccountId: Number(DEFAULT_ACCOUNT_ID()),
      OrderId: id,
      ClientOrderId: 0,
    },
  });
}

// CAD -> bank payout. Ndax requires a 2FA code with every ticket; it is sent
// both in the payload and as a header because the API rejects the call
// without it and does not document which one it reads.
export async function createNdaxWithdrawTicket({ amount, template = {}, twoFACode } = {}) {
  assertExecutionEnabled();

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    const error = new Error("Ndax withdrawals require a positive numeric amount.");
    error.statusCode = 400;
    throw error;
  }

  const code = String(twoFACode || "").trim();
  if (!code) {
    const error = new Error("Ndax withdrawals require a 2FA code (twoFACode).");
    error.statusCode = 400;
    throw error;
  }

  const bankFields = {};
  for (const [key, fieldValue] of Object.entries(template || {})) {
    if (fieldValue !== undefined && fieldValue !== null && String(fieldValue).trim() !== "") {
      bankFields[key] = fieldValue;
    }
  }

  const payload = await ndaxFetch("CreateWithdrawTicket", {
    method: "POST",
    signed: true,
    body: { ...bankFields, amount: value, "2FACode": code },
    extraHeaders: { "2FACode": code },
  });

  return {
    provider: "Ndax",
    action: "CREATE_WITHDRAW_TICKET",
    amount: value,
    productId: CAD_PRODUCT_ID,
    payload,
    requestedAt: new Date().toISOString(),
    note: "Confirm the ticket with listNdaxWithdrawals before treating the payout as sent.",
  };
}

// What Ndax charges to move CAD out (4.99 for this account on product 7).
export async function getNdaxWithdrawFee(productId = CAD_PRODUCT_ID, accountId = DEFAULT_ACCOUNT_ID()) {
  return ndaxFetch("GetWithdrawFee", {
    params: { omsId: OMS_ID, accountId: Number(accountId), productId: Number(productId) },
    signed: true,
  });
}
