import { Router } from "express";
import {
  getPaytrieExecutionReadiness,
  requestPaytrieCustomerLoginCode,
  verifyPaytrieCustomerLoginCode,
  getPaytrieCustomerAuthStatus,
  logoutPaytrieCustomer,
  createPaytrieOrder,
  refreshPaytrieOrder,
  getPaytrieOrderForTransfer,
} from "../services/paytrieExecutionService.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { registerExternalWallet, listExternalWallets } from "../services/walletService.js";

export const paytrieRouter = Router();
const fail = (res, error) => res.status(error.statusCode || 503).json({ error: error.message });

paytrieRouter.get("/readiness", (_req, res) => res.json(getPaytrieExecutionReadiness()));

function requirePersonalTestAccount(req, res) {
  if (req.account.accountType !== "PERSONAL") {
    res.status(403).json({ error: "Paytrie personal-account testing is available only to a StableX PERSONAL account." });
    return false;
  }
  const readiness = getPaytrieExecutionReadiness({
    customerId: req.account.accountId,
    accountType: req.account.accountType,
  });
  if (!readiness.personalTestModeEnabled) {
    res.status(403).json({ error: "This StableX account is not the single customer configured for Paytrie personal-account testing. Check PAYTRIE_PERSONAL_TEST_MODE and PAYTRIE_PERSONAL_TEST_CUSTOMER_ID." });
    return false;
  }
  return true;
}

paytrieRouter.get("/customer/test-readiness", requireAuth, (req, res) => {
  const readiness = getPaytrieExecutionReadiness({
    customerId: req.account.accountId,
    accountType: req.account.accountType,
  });
  return res.json(readiness);
});

paytrieRouter.get("/customer/base-wallet", requireAuth, async (req, res) => {
  if (!requirePersonalTestAccount(req, res)) return;
  try {
    const wallets = await listExternalWallets(req.account.accountId);
    return res.json({ wallets: wallets.filter((wallet) => Number(wallet.chainId) === 8453) });
  } catch (error) { return fail(res, error); }
});

paytrieRouter.post("/customer/base-wallet", requireAuth, async (req, res) => {
  if (!requirePersonalTestAccount(req, res)) return;
  try {
    const wallet = await registerExternalWallet({
      ...req.body,
      customerId: req.account.accountId,
      chainId: 8453,
    });
    return res.status(201).json({ wallet });
  } catch (error) { return fail(res, error); }
});

paytrieRouter.get("/customer/auth", requireAuth, async (req, res) => {
  try {
    if (!requirePersonalTestAccount(req, res)) return;
    return res.json(await getPaytrieCustomerAuthStatus(req.account.accountId));
  } catch (error) { return fail(res, error); }
});

paytrieRouter.post("/customer/auth/login-code", requireAuth, async (req, res) => {
  try {
    if (!requirePersonalTestAccount(req, res)) return;
    if (req.account.status !== "ACTIVE") return res.status(403).json({ error: "Verify your StableX account email before connecting Paytrie." });
    const result = await requestPaytrieCustomerLoginCode({
      customerId: req.account.accountId,
      email: req.body?.email,
    });
    return res.status(202).json(result);
  } catch (error) { return fail(res, error); }
});

paytrieRouter.post("/customer/auth/verify", requireAuth, async (req, res) => {
  try {
    if (!requirePersonalTestAccount(req, res)) return;
    if (req.account.status !== "ACTIVE") return res.status(403).json({ error: "Verify your StableX account email before connecting Paytrie." });
    const result = await verifyPaytrieCustomerLoginCode({
      customerId: req.account.accountId,
      email: req.body?.email,
      code: req.body?.code,
    });
    return res.json(result);
  } catch (error) { return fail(res, error); }
});

paytrieRouter.delete("/customer/auth", requireAuth, async (req, res) => {
  try {
    if (!requirePersonalTestAccount(req, res)) return;
    return res.json(await logoutPaytrieCustomer({ customerId: req.account.accountId }));
  }
  catch (error) { return fail(res, error); }
});

// Both order creation and refresh are customer-scoped. The customer ID and
// Paytrie JWT are resolved server-side; neither is accepted from the browser.
paytrieRouter.post("/transfers/:id/order", requireAuth, async (req, res) => {
  try {
    const result = await createPaytrieOrder({
      transferId: req.params.id,
      customerId: req.account.accountId,
      accountType: req.account.accountType,
      confirm: req.body?.confirm,
    });
    return res.status(result.created ? 201 : 200).json(result);
  } catch (error) { return fail(res, error); }
});

paytrieRouter.get("/transfers/:id/order", requireAuth, async (req, res) => {
  try {
    if (!requirePersonalTestAccount(req, res)) return;
    return res.json(await getPaytrieOrderForTransfer({
      transferId: req.params.id,
      customerId: req.account.accountId,
    }));
  } catch (error) { return fail(res, error); }
});

paytrieRouter.post("/transfers/:id/refresh", requireAuth, async (req, res) => {
  try {
    const result = await refreshPaytrieOrder({
      transferId: req.params.id,
      customerId: req.account.accountId,
      accountType: req.account.accountType,
    });
    return res.json(result);
  } catch (error) { return fail(res, error); }
});
