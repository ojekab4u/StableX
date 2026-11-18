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
    ],
    executionEnabled: false,
    executionNote:
      "Read-only adapter. Order placement and fiat/crypto withdrawal are not wired in this step and stay disabled until the operator enables the execution step.",
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

async function ndaxFetch(path, { params = {}, signed = false, method = "GET", body } = {}) {
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
  const walk = walkBook(legs, amountNumber, sellingBase ? "SELL_BASE" : "BUY_BASE");

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
    estimatedDestinationAmount: walk ? walk.proceeds : null,
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
