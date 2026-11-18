// Ndax operator workspace routes (CAD order-book leg).
// Readiness is public so workspace pages can show configuration state; every
// account-data endpoint requires the StableX operator token because the Ndax
// account belongs to the operator, not to individual customers.
//
// This step is READ-ONLY: no route here places an order or moves funds.
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
} from "../services/providers/ndaxService.js";

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
