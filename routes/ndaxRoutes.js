// Ndax operator workspace routes (CAD order-book leg).
// Readiness is public so workspace pages can show configuration state; every
// account-data endpoint requires the StableX operator token because the Ndax
// account belongs to the operator, not to individual customers.
//
// This step started read-only. Execution now exists behind two gates: the
// operator token on every route below, and NDAX_EXECUTION_ENABLED=true in the
// server environment (checked inside the service). Neither alone moves funds.
import { Router } from "express";
import {
  getNdaxReadiness,
  listNdaxProducts,
  listNdaxInstruments,
  resolveNdaxInstrument,
  getNdaxTicker,
  getNdaxOrderBook,
  getNdaxRate,
  listNdaxAccounts,
  getNdaxAccountInfo,
  getNdaxBalances,
  listNdaxNonZeroBalances,
  listNdaxDeposits,
  listNdaxWithdrawals,
  getNdaxWithdrawTemplate,
  sendNdaxOrder,
  getNdaxOrderStatus,
  cancelNdaxOrder,
  createNdaxWithdrawTicket,
  getNdaxWithdrawFee,
} from "../services/providers/ndaxService.js";
import { listAllCashOuts } from "../services/cashOutService.js";
import { fundWalletFromNdax, checkFunding, listAllFundings } from "../services/fundService.js";
import { quoteFund } from "../config/fees.js";

export const ndaxRouter = Router();

const fail = (res, error) => res.status(error.statusCode || 503).json({
  error: error.message,
  ...(error.providerCode !== null && error.providerCode !== undefined
    ? { provider: "Ndax", providerCode: error.providerCode }
    : {}),
  ...(error.providerStatus ? { providerStatus: error.providerStatus } : {}),
});

function requireOperator(req, res, next) {
  const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
  if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
    return res.status(401).json({ error: "Unauthorized operator action." });
  }
  return next();
}

ndaxRouter.get("/readiness", (_req, res) => res.json(getNdaxReadiness()));

// ---- public market data (no credentials needed) ----

ndaxRouter.get("/products", requireOperator, async (_req, res) => {
  try { return res.json({ provider: "Ndax", products: await listNdaxProducts() }); }
  catch (error) { return fail(res, error); }
});

ndaxRouter.get("/instruments", requireOperator, async (_req, res) => {
  try { return res.json({ provider: "Ndax", instruments: await listNdaxInstruments() }); }
  catch (error) { return fail(res, error); }
});

// Best bid/offer for a pair: /market/USDC/CAD
ndaxRouter.get("/market/:base/:quote", requireOperator, async (req, res) => {
  try {
    const instrument = await resolveNdaxInstrument(req.params.base, req.params.quote);
    if (!instrument) return res.status(404).json({ error: `Ndax has no instrument for ${req.params.base}/${req.params.quote}.` });
    const ticker = await getNdaxTicker(instrument.InstrumentId);
    return res.json({
      provider: "Ndax",
      instrument: { id: instrument.InstrumentId, symbol: instrument.Symbol, sessionStatus: instrument.SessionStatus },
      ticker,
    });
  } catch (error) { return fail(res, error); }
});

ndaxRouter.get("/orderbook/:base/:quote", requireOperator, async (req, res) => {
  try {
    const instrument = await resolveNdaxInstrument(req.params.base, req.params.quote);
    if (!instrument) return res.status(404).json({ error: `Ndax has no instrument for ${req.params.base}/${req.params.quote}.` });
    const depth = Math.min(Math.max(Number(req.query.depth) || 50, 1), 500);
    const book = await getNdaxOrderBook(instrument.InstrumentId, depth);
    return res.json({
      provider: "Ndax",
      instrument: { id: instrument.InstrumentId, symbol: instrument.Symbol },
      bestBid: book.bids[0]?.price ?? null,
      bestAsk: book.asks[0]?.price ?? null,
      bidLevels: book.bids.length,
      askLevels: book.asks.length,
      bids: book.bids.slice(0, 20),
      asks: book.asks.slice(0, 20),
      note: "Full-depth arrays are trimmed to 20 levels per side in this response; counts above reflect the requested depth.",
    });
  } catch (error) { return fail(res, error); }
});

// Depth-walked indicative rate: body { from, to, amount }
ndaxRouter.post("/rate", requireOperator, async (req, res) => {
  try {
    return res.json({
      provider: "Ndax",
      quote: await getNdaxRate({ from: req.body?.from, to: req.body?.to, amount: Number(req.body?.amount) }),
    });
  } catch (error) { return fail(res, error); }
});

// ---- signed account data (operator only) ----

ndaxRouter.get("/accounts", requireOperator, async (_req, res) => {
  try { return res.json({ provider: "Ndax", accountIds: await listNdaxAccounts() }); }
  catch (error) { return fail(res, error); }
});

ndaxRouter.get("/account", requireOperator, async (req, res) => {
  try {
    const accountId = req.query.accountId || undefined;
    return res.json({ provider: "Ndax", account: await getNdaxAccountInfo(accountId) });
  } catch (error) { return fail(res, error); }
});

ndaxRouter.get("/balances", requireOperator, async (req, res) => {
  try {
    const accountId = req.query.accountId || undefined;
    const onlyNonZero = String(req.query.nonZero || "") === "true";
    const balances = onlyNonZero
      ? await listNdaxNonZeroBalances(accountId)
      : await getNdaxBalances(accountId);
    return res.json({ provider: "Ndax", balances });
  } catch (error) { return fail(res, error); }
});

ndaxRouter.get("/deposits", requireOperator, async (req, res) => {
  try {
    return res.json({ provider: "Ndax", deposits: await listNdaxDeposits(req.query.accountId || undefined) });
  } catch (error) { return fail(res, error); }
});

ndaxRouter.get("/withdrawals", requireOperator, async (req, res) => {
  try {
    return res.json({ provider: "Ndax", withdrawals: await listNdaxWithdrawals(req.query.accountId || undefined) });
  } catch (error) { return fail(res, error); }
});

// Which fields a payout for this product needs (CAD returns bank fields).
ndaxRouter.get("/withdraw-template/:productId", requireOperator, async (req, res) => {
  try {
    return res.json({
      provider: "Ndax",
      productId: Number(req.params.productId),
      template: await getNdaxWithdrawTemplate(req.params.productId, req.query.accountId || undefined),
    });
  } catch (error) { return fail(res, error); }
});

// ---- execution (operator token + NDAX_EXECUTION_ENABLED=true) ----
//
// Every mutating route requires confirm:true in the body. That is deliberate:
// a copied curl line or a stray script cannot trade by accident.

function requireConfirm(req, res) {
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "Set confirm:true in the body to perform this live action." });
    return false;
  }
  return true;
}

// Place an order: body { side: "SELL"|"BUY", quantity, limitPrice?, confirm }
// Sell converts USDC -> CAD (Direction A). Buy converts CAD -> USDC (Direction B).
ndaxRouter.post("/execute/order", requireOperator, async (req, res) => {
  if (!requireConfirm(req, res)) return;
  try {
    const { side, quantity, limitPrice, orderType, timeInForce } = req.body || {};
    const order = await sendNdaxOrder({ side, quantity, limitPrice, orderType, timeInForce });
    return res.status(201).json({ provider: "Ndax", order });
  } catch (error) { return fail(res, error); }
});

// Poll whether the order filled: GET /execute/order/:orderId
ndaxRouter.get("/execute/order/:orderId", requireOperator, async (req, res) => {
  try {
    return res.json({ provider: "Ndax", order: await getNdaxOrderStatus(req.params.orderId) });
  } catch (error) { return fail(res, error); }
});

// Unwind a resting order that never filled.
ndaxRouter.post("/execute/order/:orderId/cancel", requireOperator, async (req, res) => {
  if (!requireConfirm(req, res)) return;
  try {
    return res.json({ provider: "Ndax", cancel: await cancelNdaxOrder(req.params.orderId) });
  } catch (error) { return fail(res, error); }
});

// CAD -> bank payout: body { amount, template: {...bank fields}, twoFACode, confirm }
ndaxRouter.post("/execute/withdraw/cad", requireOperator, async (req, res) => {
  if (!requireConfirm(req, res)) return;
  try {
    const { amount, template, twoFACode } = req.body || {};
    const ticket = await createNdaxWithdrawTicket({ amount, template, twoFACode });
    return res.status(201).json({ provider: "Ndax", ticket });
  } catch (error) { return fail(res, error); }
});

// What the payout costs before we commit to it.
ndaxRouter.get("/fees/withdraw/:productId", requireOperator, async (req, res) => {
  try {
    return res.json({ provider: "Ndax", fee: await getNdaxWithdrawFee(req.params.productId) });
  } catch (error) { return fail(res, error); }
});

// Customer cash-out requests created by /api/customer/me/cash-out. The ones
// in ORDER_ACCEPTED state have CAD proceeds waiting for the payout above.
ndaxRouter.get("/cash-outs", requireOperator, async (req, res) => {
  try {
    return res.json({ cashOuts: await listAllCashOuts({ state: req.query.state }) });
  } catch (error) { return fail(res, error); }
});

// Direction B: convert CAD already sitting on Ndax into USDC and credit a
// customer wallet. Operator-driven because a shared-account CAD deposit has
// no customer identity attached; the operator supplies customerId plus the
// deposit reference from the Ndax dashboard.
ndaxRouter.post("/fund/wallet", requireOperator, async (req, res) => {
  if (!requireConfirm(req, res)) return;
  try {
    const { customerId, cadAmount, depositReference, idempotencyKey } = req.body || {};
    const result = await fundWalletFromNdax({ customerId, cadAmount, depositReference, idempotencyKey });
    return res.json(result);
  } catch (error) { return fail(res, error); }
});

// Re-checks a funding whose order had not filled on the first poll, then
// credits the wallet once the fill is confirmed.
ndaxRouter.post("/fund/:fundingId/check", requireOperator, async (req, res) => {
  try {
    return res.json(await checkFunding(req.params.fundingId));
  } catch (error) { return fail(res, error); }
});

ndaxRouter.get("/fundings", requireOperator, async (req, res) => {
  try {
    return res.json({ fundings: await listAllFundings({ state: req.query.state }) });
  } catch (error) { return fail(res, error); }
});

// What a CAD funding would credit, net of fees, before placing the order.
ndaxRouter.get("/quote/fund/:cadAmount", requireOperator, async (req, res) => {
  const cadAmount = Number(req.params.cadAmount);
  if (!Number.isFinite(cadAmount) || cadAmount <= 0) {
    return res.status(400).json({ error: "A positive CAD amount is required." });
  }
  try {
    const rate = await getNdaxRate({ from: "CAD", to: "USDC", amount: cadAmount });
    if (!rate.averageFillPrice) {
      return res.status(400).json({ error: "The order book cannot cover this amount right now." });
    }
    return res.json({ provider: "Ndax", indicative: true, ...quoteFund({ cadAmount, priceCadPerUsdc: rate.averageFillPrice }) });
  } catch (error) { return fail(res, error); }
});
