import { Router } from "express";
import {
  getCustomerWallets,
  createCustomerWallet,
  getWalletEligibleForCustomer,
  getCustomerBalances,
  creditBalance,
  debitBalance,
  getCustomerSummary,
  setCustomerCountry,
  getCustomerCountry,
} from "../services/customerBalanceService.js";
import { getCustomerGateStatus } from "../services/complianceService.js";

export const customerRouter = Router();
const fail = (res, e) => res.status(e.statusCode || 503).json({ error: e.message });

// --- Wallet endpoints ---

customerRouter.get("/wallets/:customerId", (_req, res) => {
  try {
    const customerId = _req.params.customerId;
    return res.json({ customerId, wallets: getCustomerWallets(customerId) });
  } catch (e) {
    return fail(res, e);
  }
});

customerRouter.get("/wallets/eligible/:customerId", (_req, res) => {
  try {
    const customerId = _req.params.customerId;
    const country = _req.query.country || getCustomerCountry(customerId);
    return res.json({ customerId, eligible: getWalletEligibleForCustomer(customerId, country) });
  } catch (e) {
    return fail(res, e);
  }
});

customerRouter.post("/wallets", async (req, res) => {
  try {
    const { customerId, currency, country } = req.body || {};
    if (!customerId || !currency) {
      return res.status(400).json({ error: "customerId and currency are required." });
    }

    // Require KYC approval before creating wallet
    const gate = await getCustomerGateStatus(customerId);
    if (!gate.gate.approved) {
      return res.status(403).json({
        error: "Compliance gate not approved. Complete KYC/KYB verification first.",
        gateStatus: gate.gate,
      });
    }

    if (country) setCustomerCountry(customerId, country);
    const wallet = createCustomerWallet(customerId, currency, getCustomerCountry(customerId));
    return res.status(201).json({ wallet });
  } catch (e) {
    return fail(res, e);
  }
});

// --- Balance endpoints ---

customerRouter.get("/balance/:customerId", (_req, res) => {
  try {
    return res.json({ customerId: _req.params.customerId, balances: getCustomerBalances(_req.params.customerId) });
  } catch (e) {
    return fail(res, e);
  }
});

customerRouter.get("/summary/:customerId", async (_req, res) => {
  try {
    return res.json(await getCustomerSummary(_req.params.customerId));
  } catch (e) {
    return fail(res, e);
  }
});

customerRouter.post("/credit", async (req, res) => {
  try {
    const { customerId, currency, amount, reference, meta } = req.body || {};
    if (!customerId || !currency || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "customerId, currency and positive amount are required." });
    }
    return res.status(201).json(creditBalance(customerId, currency.toUpperCase(), amount, reference, meta));
  } catch (e) {
    return fail(res, e);
  }
});

customerRouter.post("/debit", async (req, res) => {
  try {
    const { customerId, currency, amount, reference, meta } = req.body || {};
    if (!customerId || !currency || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "customerId, currency and positive amount are required." });
    }
    return res.status(200).json(debitBalance(customerId, currency.toUpperCase(), amount, reference, meta));
  } catch (e) {
    return fail(res, e);
  }
});

// --- Country ---

customerRouter.post("/country", async (req, res) => {
  try {
    const { customerId, country } = req.body || {};
    if (!customerId || !country) {
      return res.status(400).json({ error: "customerId and country are required." });
    }
    setCustomerCountry(customerId, country);
    return res.json({ customerId, country });
  } catch (e) {
    return fail(res, e);
  }
});
