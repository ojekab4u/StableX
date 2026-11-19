import { Router } from "express";
import {
  createWallet, listWallets, listEligibleWalletAssets, getWalletLedger,
  registerExternalWallet, listExternalWallets,
} from "../services/walletService.js";
import { requestCashOut, listCashOuts } from "../services/cashOutService.js";
import { transferInternal, listTransfers } from "../services/transferService.js";
import { createFundClaim, listFundClaims } from "../services/fundService.js";
import { getNdaxRate } from "../services/providers/ndaxService.js";
import { quoteCashOut, quoteFund } from "../config/fees.js";
import { getCustomerGateStatus } from "../services/complianceService.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const customerRouter = Router();
const fail = (res, error) => res.status(error.statusCode || 503).json({ error: error.message });

// Every route here needs a signed-in session, and may only act on that
// customer's own records. A customerId in the URL or body must match the
// session, otherwise the request is refused.
customerRouter.use(requireAuth);

const isOwnCustomer = (req, res, customerId) => {
  if (!customerId || String(customerId) !== req.account.accountId) {
    res.status(403).json({ error: "You can only access your own customer records." });
    return false;
  }
  return true;
};

// The signed-in customer's wallets and their Bridge deposits.
customerRouter.get("/me/overview", async (req, res) => {
  try {
    const customerId = req.account.accountId;
    const [wallets, usdcLedger] = await Promise.all([
      listWallets(customerId),
      getWalletLedger(customerId, "USDC"),
    ]);
    const deposits = usdcLedger
      .filter((entry) => entry.provider === "Bridge" && entry.type === "DEPOSIT")
      .map((entry) => {
        const meta = entry.metadata || {};
        const sourceAmount = Number(meta.sourceAmount);
        const usdc = Number(entry.amount);
        return {
          createdAt: entry.createdAt,
          sourceCurrency: String(meta.sourceCurrency || "").toUpperCase(),
          sourceAmount,
          usdcReceived: usdc,
          ratePerUsdc: sourceAmount > 0 && usdc > 0 ? Number((sourceAmount / usdc).toFixed(4)) : null,
          depositId: meta.depositId || entry.reference,
        };
      });
    return res.json({ customerId, wallets, deposits });
  } catch (error) { return fail(res, error); }
});

// Account readiness is derived from the durable VOVE compliance records.
customerRouter.get("/account/:customerId", async (req, res) => {
  const customerId = req.params.customerId;
  if (!isOwnCustomer(req, res, customerId)) return;
  try {
    const [gate, wallets, externalWallets] = await Promise.all([
      getCustomerGateStatus(customerId), listWallets(customerId), listExternalWallets(customerId),
    ]);
    return res.json({ customerId, verification: gate.gate, walletCount: wallets.length, wallets, externalWallets });
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/wallets/eligible/:customerId", async (req, res) => {
  const customerId = req.params.customerId;
  if (!isOwnCustomer(req, res, customerId)) return;
  try {
    const country = String(req.query.country || "GLOBAL").toUpperCase();
    return res.json({ customerId, eligible: await listEligibleWalletAssets(customerId, country) });
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/wallets/:customerId", async (req, res) => {
  const customerId = req.params.customerId;
  if (!isOwnCustomer(req, res, customerId)) return;
  try {
    return res.json({ customerId, wallets: await listWallets(customerId) });
  } catch (error) { return fail(res, error); }
});

customerRouter.post("/wallets", async (req, res) => {
  const { customerId, currency, country } = req.body || {};
  if (!customerId || !currency) return res.status(400).json({ error: "customerId and currency are required." });
  if (!isOwnCustomer(req, res, customerId)) return;
  try {
    const wallet = await createWallet({ customerId, currency, country });
    return res.status(201).json({ wallet });
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/balance/:customerId", async (req, res) => {
  const customerId = req.params.customerId;
  if (!isOwnCustomer(req, res, customerId)) return;
  try {
    const wallets = await listWallets(customerId);
    return res.json({ customerId, balances: Object.fromEntries(wallets.map((wallet) => [wallet.currency, wallet.balance])) });
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/summary/:customerId", async (req, res) => {
  const customerId = req.params.customerId;
  if (!isOwnCustomer(req, res, customerId)) return;
  try {
    const [wallets, ledger] = await Promise.all([listWallets(customerId), getWalletLedger(customerId)]);
    const totalCredited = ledger.filter((entry) => ["DEPOSIT", "CONVERSION_CREDIT", "ADJUSTMENT"].includes(entry.type) && entry.amount > 0).reduce((sum, entry) => sum + entry.amount, 0);
    const totalDebited = ledger.filter((entry) => ["WITHDRAWAL", "CONVERSION_DEBIT"].includes(entry.type) && entry.amount < 0).reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
    return res.json({ customerId, balances: Object.fromEntries(wallets.map((wallet) => [wallet.currency, wallet.balance])), totalCredited, totalDebited, transactionCount: ledger.length, history: ledger });
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/ledger/:customerId", async (req, res) => {
  const customerId = req.params.customerId;
  if (!isOwnCustomer(req, res, customerId)) return;
  try { return res.json({ customerId, entries: await getWalletLedger(customerId, req.query.currency) }); }
  catch (error) { return fail(res, error); }
});

customerRouter.post("/external-wallets", async (req, res) => {
  if (!isOwnCustomer(req, res, req.body?.customerId)) return;
  try {
    const wallet = await registerExternalWallet(req.body || {});
    return res.status(201).json({ wallet });
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/external-wallets/:customerId", async (req, res) => {
  const customerId = req.params.customerId;
  if (!isOwnCustomer(req, res, customerId)) return;
  try { return res.json({ customerId, wallets: await listExternalWallets(customerId) }); }
  catch (error) { return fail(res, error); }
});

// Direction A cash out: debit the wallet, sell USDC on Ndax. The CAD payout
// to the customer's bank is completed by the operator with a 2FA code.
customerRouter.post("/me/cash-out", async (req, res) => {
  const customerId = req.account.accountId;
  try {
    const result = await requestCashOut({
      customerId,
      amount: req.body?.amount,
      idempotencyKey: req.body?.idempotencyKey,
      bank: req.body?.bank,
    });
    return res.json(result);
  } catch (error) {
    if (error.cashOut) return res.status(error.statusCode || 503).json({ error: error.message, cashOut: error.cashOut });
    return fail(res, error);
  }
});

customerRouter.get("/me/cash-outs", async (req, res) => {
  const customerId = req.account.accountId;
  try { return res.json({ customerId, cashOuts: await listCashOuts(customerId) }); }
  catch (error) { return fail(res, error); }
});

// Customer-to-customer USDC transfer. Same session rules as everything here.
customerRouter.post("/me/transfer", async (req, res) => {
  const customerId = req.account.accountId;
  try {
    const result = await transferInternal({
      fromCustomerId: customerId,
      toEmail: req.body?.toEmail,
      amount: req.body?.amount,
      idempotencyKey: req.body?.idempotencyKey,
    });
    return res.json(result);
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/me/transfers", async (req, res) => {
  const customerId = req.account.accountId;
  try { return res.json({ customerId, transfers: await listTransfers(customerId) }); }
  catch (error) { return fail(res, error); }
});

// "I sent CAD by Interac" — matched against the shared Ndax account by the
// operator's scan, then funded through the normal buy path.
customerRouter.post("/me/fund-claims", async (req, res) => {
  const customerId = req.account.accountId;
  try {
    const result = await createFundClaim({
      customerId,
      cadAmount: req.body?.cadAmount,
      reference: req.body?.reference,
      idempotencyKey: req.body?.idempotencyKey,
    });
    return res.json(result);
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/me/fund-claims", async (req, res) => {
  const customerId = req.account.accountId;
  try { return res.json({ customerId, claims: await listFundClaims(customerId) }); }
  catch (error) { return fail(res, error); }
});

// Fees are shown before the customer commits. Prices are indicative until
// the order fills, same as every exchange.
customerRouter.get("/quote/cash-out/:amount", async (req, res) => {
  const amount = Number(req.params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "A positive USDC amount is required." });
  }
  try {
    const rate = await getNdaxRate({ from: "USDC", to: "CAD", amount });
    if (!rate.averageFillPrice) {
      return res.status(400).json({ error: "The order book cannot cover this amount right now." });
    }
    const quote = quoteCashOut({
      amountUsdc: amount,
      priceCadPerUsdc: rate.averageFillPrice,
      payoutMethod: req.query.payout === "EFT" ? "EFT" : "INTERAC",
    });
    return res.json({ provider: "Ndax", indicative: true, ...quote });
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/quote/fund/:cadAmount", async (req, res) => {
  const cadAmount = Number(req.params.cadAmount);
  if (!Number.isFinite(cadAmount) || cadAmount <= 0) {
    return res.status(400).json({ error: "A positive CAD amount is required." });
  }
  try {
    const rate = await getNdaxRate({ from: "CAD", to: "USDC", amount: cadAmount });
    if (!rate.averageFillPrice) {
      return res.status(400).json({ error: "The order book cannot cover this amount right now." });
    }
    const quote = quoteFund({ cadAmount, priceCadPerUsdc: rate.averageFillPrice });
    return res.json({ provider: "Ndax", indicative: true, ...quote });
  } catch (error) { return fail(res, error); }
});

// Deliberately no public /credit or /debit endpoint. Balances may only change
// through verified provider events or controlled transfer/settlement services.
