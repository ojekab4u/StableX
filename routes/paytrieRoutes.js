import { Router } from "express";
import {
  getPaytrieExecutionReadiness,
  requestPaytrieCustomerLoginCode,
  verifyPaytrieCustomerLoginCode,
  getPaytrieCustomerAuthStatus,
  logoutPaytrieCustomer,
  createPaytrieOrder,
  refreshPaytrieOrder,
} from "../services/paytrieExecutionService.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const paytrieRouter = Router();
const fail = (res, error) => res.status(error.statusCode || 503).json({ error: error.message });

paytrieRouter.get("/readiness", (_req, res) => res.json(getPaytrieExecutionReadiness()));

paytrieRouter.get("/customer/auth", requireAuth, async (req, res) => {
  try {
    return res.json(await getPaytrieCustomerAuthStatus(req.account.accountId));
  } catch (error) { return fail(res, error); }
});

paytrieRouter.post("/customer/auth/login-code", requireAuth, async (req, res) => {
  try {
    if (req.account.status !== "ACTIVE") return res.status(403).json({ error: "Verify your StableX account email before connecting Paytrie." });
    const result = await requestPaytrieCustomerLoginCode({
      customerId: req.account.accountId,
      email: req.account.email,
    });
    return res.status(202).json(result);
  } catch (error) { return fail(res, error); }
});

paytrieRouter.post("/customer/auth/verify", requireAuth, async (req, res) => {
  try {
    if (req.account.status !== "ACTIVE") return res.status(403).json({ error: "Verify your StableX account email before connecting Paytrie." });
    const result = await verifyPaytrieCustomerLoginCode({
      customerId: req.account.accountId,
      email: req.account.email,
      code: req.body?.code,
    });
    return res.json(result);
  } catch (error) { return fail(res, error); }
});

paytrieRouter.delete("/customer/auth", requireAuth, async (req, res) => {
  try { return res.json(await logoutPaytrieCustomer({ customerId: req.account.accountId })); }
  catch (error) { return fail(res, error); }
});

// Both order creation and refresh are customer-scoped. The customer ID and
// Paytrie JWT are resolved server-side; neither is accepted from the browser.
paytrieRouter.post("/transfers/:id/order", requireAuth, async (req, res) => {
  try {
    const result = await createPaytrieOrder({
      transferId: req.params.id,
      customerId: req.account.accountId,
      confirm: req.body?.confirm,
    });
    return res.status(result.created ? 201 : 200).json(result);
  } catch (error) { return fail(res, error); }
});

paytrieRouter.post("/transfers/:id/refresh", requireAuth, async (req, res) => {
  try {
    const result = await refreshPaytrieOrder({
      transferId: req.params.id,
      customerId: req.account.accountId,
    });
    return res.json(result);
  } catch (error) { return fail(res, error); }
});
