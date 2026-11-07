import { Router } from "express";
import { getProviderReadiness, getProviderRatePreviews } from "../services/providers/providerService.js";
import { createSimulatedOrder, advanceSimulatedOrder, getSimulatedOrder } from "../services/simulatedProviderOrderService.js";

export const providerRouter = Router();

providerRouter.get("/readiness", (_req, res) => {
  res.json(getProviderReadiness());
});

providerRouter.post("/quotes", async (req, res) => {
  const from = String(req.body?.from || "").trim().toUpperCase();
  const to = String(req.body?.to || "").trim().toUpperCase();
  const amount = Number(req.body?.amount);
  const provider = String(req.body?.provider || "all").trim().toLowerCase();
  const network = String(req.body?.network || "base").trim();

  if (!/^[A-Z0-9]{3,12}$/.test(from) || !/^[A-Z0-9]{3,12}$/.test(to) || from === to) {
    return res.status(400).json({ error: "Provide two different valid currency or token codes." });
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    return res.status(400).json({ error: "Amount must be greater than 0 and at most 1,000,000." });
  }
  if (!["all", "honeycoin", "paycrest"].includes(provider)) {
    return res.status(400).json({ error: "Provider must be honeycoin, paycrest, or all." });
  }

  try {
    const result = await getProviderRatePreviews({ from, to, amount, network, provider });
    return res.json({
      message: "Provider rate preview completed. No order, payment, transfer or settlement was initiated.",
      ...result,
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ error: error.message });
  }
});


// Credential-free orchestration rehearsal. This never contacts a provider or moves funds.
function requireOperator(req, res) {
  const token = process.env.STABLEX_OPERATOR_TOKEN;
  if (!token || req.get("Authorization") !== `Bearer ${token}`) {
    res.status(401).json({ error: "Unauthorized operator action." });
    return false;
  }
  return true;
}

providerRouter.post("/orders/simulate", async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const result = await createSimulatedOrder({
      transferId: req.body?.transferId,
      customerId: req.body?.customerId,
      idempotencyKey: req.get("Idempotency-Key"),
    });
    return res.status(result.replayed ? 200 : 201).json({
      message: result.replayed
        ? "Existing simulated provider order returned; no duplicate created."
        : "Simulated provider order recorded. No external provider was contacted and no funds moved.",
      executionMode: "SIMULATED",
      realExecutionEnabled: false,
      ...result,
    });
  } catch (error) {
    return res.status(error.statusCode || 503).json({ error: error.message });
  }
});

providerRouter.get("/orders/simulate/:transferId", async (req, res) => {
  try {
    const result = await getSimulatedOrder({
      transferId: req.params.transferId,
      customerId: String(req.query.customerId || ""),
    });
    return result
      ? res.json({ executionMode: "SIMULATED", realExecutionEnabled: false, ...result })
      : res.status(404).json({ error: "No simulated provider order exists for this transfer." });
  } catch (error) {
    return res.status(error.statusCode || 503).json({ error: error.message });
  }
});

providerRouter.post("/orders/simulate/:orderId/advance", async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const result = await advanceSimulatedOrder({
      orderId: req.params.orderId,
      customerId: req.body?.customerId,
      status: req.body?.status,
      actorId: "LOCAL_OPERATOR",
      note: req.body?.note,
    });
    return res.json({
      message: "Simulated order state updated. This is not evidence of real funding, conversion, settlement or payout.",
      executionMode: "SIMULATED",
      realExecutionEnabled: false,
      ...result,
    });
  } catch (error) {
    return res.status(error.statusCode || 503).json({ error: error.message });
  }
});
