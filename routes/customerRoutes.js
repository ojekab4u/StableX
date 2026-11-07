import { Router } from "express";
import {
  createWallet, listWallets, listEligibleWalletAssets, getWalletLedger,
  registerExternalWallet, listExternalWallets,
} from "../services/walletService.js";
import { getCustomerGateStatus } from "../services/complianceService.js";

export const customerRouter = Router();
const fail = (res, error) => res.status(error.statusCode || 503).json({ error: error.message });

// Account readiness is derived from the durable VOVE compliance records.
customerRouter.get("/account/:customerId", async (req, res) => {
  try {
    const customerId = req.params.customerId;
    const [gate, wallets, externalWallets] = await Promise.all([
      getCustomerGateStatus(customerId), listWallets(customerId), listExternalWallets(customerId),
    ]);
    return res.json({ customerId, verification: gate.gate, walletCount: wallets.length, wallets, externalWallets });
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/wallets/eligible/:customerId", async (req, res) => {
  try {
    const customerId = req.params.customerId;
    const country = String(req.query.country || "GLOBAL").toUpperCase();
    return res.json({ customerId, eligible: await listEligibleWalletAssets(customerId, country) });
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/wallets/:customerId", async (req, res) => {
  try {
    const customerId = req.params.customerId;
    return res.json({ customerId, wallets: await listWallets(customerId) });
  } catch (error) { return fail(res, error); }
});

customerRouter.post("/wallets", async (req, res) => {
  try {
    const { customerId, currency, country } = req.body || {};
    if (!customerId || !currency) return res.status(400).json({ error: "customerId and currency are required." });
    const wallet = await createWallet({ customerId, currency, country });
    return res.status(201).json({ wallet });
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/balance/:customerId", async (req, res) => {
  try {
    const wallets = await listWallets(req.params.customerId);
    return res.json({ customerId: req.params.customerId, balances: Object.fromEntries(wallets.map((wallet) => [wallet.currency, wallet.balance])) });
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/summary/:customerId", async (req, res) => {
  try {
    const customerId = req.params.customerId;
    const [wallets, ledger] = await Promise.all([listWallets(customerId), getWalletLedger(customerId)]);
    const totalCredited = ledger.filter((entry) => ["DEPOSIT", "CONVERSION_CREDIT", "ADJUSTMENT"].includes(entry.type) && entry.amount > 0).reduce((sum, entry) => sum + entry.amount, 0);
    const totalDebited = ledger.filter((entry) => ["WITHDRAWAL", "CONVERSION_DEBIT"].includes(entry.type) && entry.amount < 0).reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
    return res.json({ customerId, balances: Object.fromEntries(wallets.map((wallet) => [wallet.currency, wallet.balance])), totalCredited, totalDebited, transactionCount: ledger.length, history: ledger });
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/ledger/:customerId", async (req, res) => {
  try { return res.json({ customerId: req.params.customerId, entries: await getWalletLedger(req.params.customerId, req.query.currency) }); }
  catch (error) { return fail(res, error); }
});

customerRouter.post("/external-wallets", async (req, res) => {
  try {
    const wallet = await registerExternalWallet(req.body || {});
    return res.status(201).json({ wallet });
  } catch (error) { return fail(res, error); }
});

customerRouter.get("/external-wallets/:customerId", async (req, res) => {
  try { return res.json({ customerId: req.params.customerId, wallets: await listExternalWallets(req.params.customerId) }); }
  catch (error) { return fail(res, error); }
});

// Deliberately no public /credit or /debit endpoint. Balances may only change
// through verified provider events or controlled transfer/settlement services.
