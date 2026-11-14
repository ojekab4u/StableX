import { Router } from "express";
import { createBeneficiary, listBeneficiaries, createTransfer, getTransfer, getTransfers, setTransferStatus } from "../services/transferService.js";
import { recordProviderEvent } from "../repositories/transferRepository.js";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  createHoneycoinOrderForTransfer,
  getHoneycoinOrderForTransfer,
  refreshHoneycoinOrder,
} from "../services/providerOrderService.js";

export const transferRouter = Router();
const fail = (res, error) => res.status(error.statusCode || 503).json({ error: error.message });

// Customer-owned resources always derive customerId from the authenticated session.
transferRouter.post("/beneficiaries", requireAuth, async (req, res) => {
  try {
    const beneficiary = await createBeneficiary({
      customerId: req.account.accountId,
      details: req.body?.details || req.body,
    });
    return res.status(201).json({ beneficiary });
  } catch (error) { return fail(res, error); }
});

transferRouter.get("/beneficiaries", requireAuth, async (req, res) => {
  try {
    return res.json({ beneficiaries: await listBeneficiaries(req.account.accountId) });
  } catch (error) { return fail(res, error); }
});

transferRouter.post("/", requireAuth, async (req, res) => {
  try {
    const result = await createTransfer({
      ...req.body,
      customerId: req.account.accountId,
      idempotencyKey: req.get("Idempotency-Key"),
    });
    return res.status(result.replayed ? 200 : 201).json({
      message: result.replayed
        ? "Existing transfer returned; no duplicate created."
        : "Draft transfer persisted. No funds were collected or moved.",
      ...result,
    });
  } catch (error) { return fail(res, error); }
});

transferRouter.get("/", requireAuth, async (req, res) => {
  try { return res.json({ transfers: await getTransfers(req.account.accountId) }); }
  catch (error) { return fail(res, error); }
});

transferRouter.get("/:id", requireAuth, async (req, res) => {
  try {
    const transfer = await getTransfer(req.params.id, req.account.accountId);
    return transfer ? res.json({ transfer }) : res.status(404).json({ error: "Transfer not found." });
  } catch (error) { return fail(res, error); }
});

// Operator-only state changes remain separate from customer quote selection.
transferRouter.patch("/:id/status", async (req, res) => {
  try {
    const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
    if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
      return res.status(401).json({ error: "Unauthorized operator action." });
    }
    const transfer = await setTransferStatus({
      id: req.params.id,
      customerId: String(req.body?.customerId || ""),
      status: req.body?.status,
      actorId: req.body?.actorId,
      reason: req.body?.reason,
    });
    return res.json({ message: "State recorded only; no provider or blockchain action was triggered.", transfer });
  } catch (error) { return fail(res, error); }
});

transferRouter.post("/:id/provider-order", requireAuth, async (req, res) => {
  try {
    const result = await createHoneycoinOrderForTransfer({
      transferId: req.params.id,
      customerId: req.account.accountId,
      paymentMethod: req.body?.paymentMethod,
      email: req.account.email,
    });
    return res.status(result.created ? 201 : 200).json({
      message: result.created
        ? "Honeycoin order created. Complete the payment action and refresh status; funds are not considered settled until provider and Base verification succeed."
        : result.message,
      ...result,
    });
  } catch (error) { return fail(res, error); }
});

transferRouter.get("/:id/provider-order", requireAuth, async (req, res) => {
  try {
    const order = await getHoneycoinOrderForTransfer({
      transferId: req.params.id,
      customerId: req.account.accountId,
    });
    return order ? res.json({ order }) : res.status(404).json({ error: "No provider order exists for this transfer." });
  } catch (error) { return fail(res, error); }
});

transferRouter.post("/:id/provider-order/refresh", requireAuth, async (req, res) => {
  try {
    const result = await refreshHoneycoinOrder({
      transferId: req.params.id,
      customerId: req.account.accountId,
    });
    return res.json({
      message: result.settlementVerified
        ? "Honeycoin payment and Base USDC settlement verified."
        : "Provider status refreshed. StableX has not marked the transfer completed without Base USDC verification.",
      ...result,
    });
  } catch (error) { return fail(res, error); }
});

transferRouter.post("/provider-events", async (req, res) => {
  try {
    const token = process.env.STABLEX_EVENT_INGESTION_TOKEN;
    if (!token || req.get("Authorization") !== `Bearer ${token}`) {
      return res.status(401).json({ error: "Unauthorized event ingestion." });
    }
    const { provider, providerEventId, eventType, payload } = req.body || {};
    if (typeof provider !== "string" || !provider.trim() ||
        typeof providerEventId !== "string" || !providerEventId.trim() ||
        typeof eventType !== "string" || !eventType.trim() ||
        !payload || typeof payload !== "object") {
      return res.status(400).json({ error: "provider, providerEventId, eventType and object payload are required." });
    }
    const result = await recordProviderEvent({
      provider: provider.trim(),
      eventId: providerEventId.trim(),
      eventType: eventType.trim(),
      payload,
    });
    return res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) { return fail(res, error); }
});
