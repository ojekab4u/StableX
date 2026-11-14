// Netcoins operator workspace routes (API v4 — Trading & Balances).
// Every state-changing endpoint is gated behind the StableX operator token:
// the Netcoins account belongs to the operator, not to individual customers.
import { Router } from "express";
import {
  getNetcoinsReadiness,
  getNetcoinsEnvironment,
  getNetcoinsBaseUrl,
  getNetcoinsRate,
  requestNetcoinsQuote,
  getLatestNetcoinsQuote,
  cancelNetcoinsQuoteRequest,
  executeNetcoinsInstantTrade,
  previewNetcoinsLimitOrder,
  executeNetcoinsLimitOrder,
  listNetcoinsTrades,
  getNetcoinsTrade,
  cancelNetcoinsTrade,
  listNetcoinsPairs,
  getNetcoinsPair,
  getNetcoinsPermissions,
  getNetcoinsBalances,
  listNetcoinsAssets,
  getNetcoinsMarketPrices,
  getNetcoinsMarketStats,
} from "../services/providers/netcoinsService.js";

export const netcoinsRouter = Router();

const fail = (res, error) => res.status(error.statusCode || 503).json({
  error: error.message,
  ...(error.providerCode ? { provider: "Netcoins", providerCode: error.providerCode } : {}),
  ...(error.providerStatus ? { providerStatus: error.providerStatus } : {}),
  ...(error.providerResponse?.details ? { providerDetails: error.providerResponse.details } : {}),
});

function requireOperator(req, res, next) {
  const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
  if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
    return res.status(401).json({ error: "Unauthorized operator action." });
  }
  return next();
}

// Readiness is public so workspace pages can show configuration state.
netcoinsRouter.get("/readiness", (_req, res) => {
  const readiness = getNetcoinsReadiness();
  return res.json({
    ...readiness,
    baseUrl: getNetcoinsBaseUrl(),
    rateLimitNote: "Netcoins v4 rate limits are applied per token; responses include X-RateLimit-Limit / X-RateLimit-Remaining headers.",
  });
});

netcoinsRouter.get("/assets", requireOperator, async (_req, res) => {
  try {
    return res.json({ provider: "Netcoins", environment: getNetcoinsEnvironment(), assets: await listNetcoinsAssets() });
  } catch (error) { return fail(res, error); }
});

netcoinsRouter.get("/pairs", requireOperator, async (_req, res) => {
  try {
    return res.json({ provider: "Netcoins", environment: getNetcoinsEnvironment(), pairs: await listNetcoinsPairs() });
  } catch (error) { return fail(res, error); }
});

netcoinsRouter.get("/pairs/:base/:quote", requireOperator, async (req, res) => {
  try {
    return res.json({
      provider: "Netcoins", environment: getNetcoinsEnvironment(),
      pair: await getNetcoinsPair(req.params.base, req.params.quote),
    });
  } catch (error) { return fail(res, error); }
});

netcoinsRouter.get("/permissions", requireOperator, async (_req, res) => {
  try {
    return res.json({ provider: "Netcoins", environment: getNetcoinsEnvironment(), permissions: await getNetcoinsPermissions() });
  } catch (error) { return fail(res, error); }
});

netcoinsRouter.get("/balances", requireOperator, async (_req, res) => {
  try {
    return res.json({ provider: "Netcoins", environment: getNetcoinsEnvironment(), balances: await getNetcoinsBalances() });
  } catch (error) { return fail(res, error); }
});

netcoinsRouter.get("/balances/:subAccountType", requireOperator, async (req, res) => {
  try {
    return res.json({
      provider: "Netcoins", environment: getNetcoinsEnvironment(), subAccountType: req.params.subAccountType,
      balances: await getNetcoinsBalances(req.params.subAccountType),
    });
  } catch (error) { return fail(res, error); }
});

netcoinsRouter.get("/markets/prices", requireOperator, async (req, res) => {
  try {
    return res.json({
      provider: "Netcoins", environment: getNetcoinsEnvironment(),
      prices: await getNetcoinsMarketPrices(req.query.base, req.query.quote),
    });
  } catch (error) { return fail(res, error); }
});

netcoinsRouter.get("/markets/stats", requireOperator, async (_req, res) => {
  try {
    return res.json({ provider: "Netcoins", environment: getNetcoinsEnvironment(), stats: await getNetcoinsMarketStats() });
  } catch (error) { return fail(res, error); }
});

netcoinsRouter.get("/trades", requireOperator, async (_req, res) => {
  try {
    return res.json({ provider: "Netcoins", environment: getNetcoinsEnvironment(), trades: await listNetcoinsTrades() });
  } catch (error) { return fail(res, error); }
});

netcoinsRouter.get("/trades/:tradeId", requireOperator, async (req, res) => {
  try {
    return res.json({ provider: "Netcoins", environment: getNetcoinsEnvironment(), trade: await getNetcoinsTrade(req.params.tradeId) });
  } catch (error) { return fail(res, error); }
});

netcoinsRouter.delete("/trades/:tradeId", requireOperator, async (req, res) => {
  try {
    return res.json({ provider: "Netcoins", environment: getNetcoinsEnvironment(), cancelled: await cancelNetcoinsTrade(req.params.tradeId) });
  } catch (error) { return fail(res, error); }
});

// Opens an RFQ quote session. Body: { action, baseCurrency, quoteCurrency,
// amount, amountCurrency, rfqDuration? }. Returns quoteReqId + initial quote.
netcoinsRouter.post("/quote", requireOperator, async (req, res) => {
  try {
    return res.json({
      provider: "Netcoins", environment: getNetcoinsEnvironment(),
      quoteRequest: await requestNetcoinsQuote({
        action: req.body?.action,
        baseCurrency: req.body?.baseCurrency,
        quoteCurrency: req.body?.quoteCurrency,
        amount: req.body?.amount,
        amountCurrency: req.body?.amountCurrency,
        rfqDuration: req.body?.rfqDuration,
      }),
      note: "The initial quote is executable at its quoteId until validUntil. Refresh with GET /api/netcoins/quote/:quoteReqId while the session is open.",
    });
  } catch (error) { return fail(res, error); }
});

// Polling fallback for an open RFQ session.
netcoinsRouter.get("/quote/:quoteReqId", requireOperator, async (req, res) => {
  try {
    return res.json({ provider: "Netcoins", environment: getNetcoinsEnvironment(), quote: await getLatestNetcoinsQuote(req.params.quoteReqId) });
  } catch (error) { return fail(res, error); }
});

netcoinsRouter.delete("/quote/:quoteReqId", requireOperator, async (req, res) => {
  try {
    await cancelNetcoinsQuoteRequest(req.params.quoteReqId);
    return res.json({ provider: "Netcoins", environment: getNetcoinsEnvironment(), cancelled: true });
  } catch (error) { return fail(res, error); }
});

// Executes an instant trade against a live quoteId. Quotes expire in seconds —
// quote immediately before executing; never replay a stored quoteId.
netcoinsRouter.post("/execute", requireOperator, async (req, res) => {
  try {
    return res.status(201).json({
      provider: "Netcoins", environment: getNetcoinsEnvironment(),
      trade: await executeNetcoinsInstantTrade(req.body?.quoteId || req.body?.quote_id),
      note: "This executed a real trade on the Netcoins account. Confirm NETCOINS_ENVIRONMENT=staging before executing test trades.",
    });
  } catch (error) { return fail(res, error); }
});

netcoinsRouter.post("/limit/preview", requireOperator, async (req, res) => {
  try {
    return res.json({
      provider: "Netcoins", environment: getNetcoinsEnvironment(),
      preview: await previewNetcoinsLimitOrder({
        baseCurrency: req.body?.baseCurrency, quoteCurrency: req.body?.quoteCurrency,
        action: req.body?.action, price: req.body?.price,
        baseAmount: req.body?.baseAmount, quoteAmount: req.body?.quoteAmount,
      }),
    });
  } catch (error) { return fail(res, error); }
});

netcoinsRouter.post("/limit", requireOperator, async (req, res) => {
  try {
    return res.status(201).json({
      provider: "Netcoins", environment: getNetcoinsEnvironment(),
      trade: await executeNetcoinsLimitOrder({
        baseCurrency: req.body?.baseCurrency, quoteCurrency: req.body?.quoteCurrency,
        action: req.body?.action, price: req.body?.price,
        baseAmount: req.body?.baseAmount, quoteAmount: req.body?.quoteAmount,
      }),
      note: "This submitted a real limit order on the Netcoins account.",
    });
  } catch (error) { return fail(res, error); }
});

// Convenience preview used by the StableX routing engine for one pair.
netcoinsRouter.post("/rate", requireOperator, async (req, res) => {
  try {
    return res.json({
      provider: "Netcoins", environment: getNetcoinsEnvironment(),
      quote: await getNetcoinsRate({
        from: req.body?.from, to: req.body?.to, amount: Number(req.body?.amount),
      }),
    });
  } catch (error) { return fail(res, error); }
});
