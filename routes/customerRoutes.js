import { Router } from "express";
import {
  createWallet, listWallets, listEligibleWalletAssets, getWalletLedger,
  registerExternalWallet, listExternalWallets,
} from "../services/walletService.js";
import { requestCashOut, listCashOuts } from "../services/cashOutService.js";
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

// Deliberately no public /credit or /debit endpoint. Balances may only change
// through verified provider events or controlled transfer/settlement services.
