import { Router } from "express";
import {
  getPaytrieExecutionReadiness,
  createPaytrieOrder,
  refreshPaytrieOrder,
} from "../services/paytrieExecutionService.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const paytrieRouter = Router();
const fail = (res, error) => res.status(error.statusCode || 503).json({ error: error.message });

paytrieRouter.get("/readiness", (_req, res) => res.json(getPaytrieExecutionReadiness()));

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
