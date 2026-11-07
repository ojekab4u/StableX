// Nomba routes — NGN virtual accounts & webhook settlement
import { Router } from "express";
import {
  getNombaReadiness,
  createNombaVirtualAccount,
  getNombaAccount,
  getNombaAccountsByCustomer,
  applyNombaWebhook,
  verifyNombaWebhookSignature,
} from "../services/nombaService.js";
import { creditBalance } from "../services/customerBalanceService.js";

export const nombaRouter = Router();
const fail = (res, e) => res.status(e.statusCode || 503).json({ error: e.message });

// Readiness
nombaRouter.get("/readiness", (_req, res) => {
  return res.json(getNombaReadiness());
});

// Create NGN virtual account for a customer
nombaRouter.post("/virtual-accounts", async (req, res) => {
  try {
    const { customerId, customerName, email, phone, bvn } = req.body || {};
    if (!customerId || !customerName) {
      return res.status(400).json({ error: "customerId and customerName are required." });
    }
    const account = await createNombaVirtualAccount({ customerId, customerName, email, phone, bvn });
    return res.status(201).json({ account });
  } catch (e) {
    return fail(res, e);
  }
});

// List all virtual accounts for a customer
nombaRouter.get("/virtual-accounts/:customerId", (_req, res) => {
  try {
    const customerId = _req.params.customerId;
    const accounts = getNombaAccountsByCustomer(customerId);
    return res.json({ customerId, accounts });
  } catch (e) {
    return fail(res, e);
  }
});

// Get a single virtual account
nombaRouter.get("/virtual-accounts/:refId/details", (_req, res) => {
  try {
    const refId = _req.params.refId;
    const account = getNombaAccount(refId);
    if (!account) {
      return res.status(404).json({ error: "Virtual account not found." });
    }
    return res.json({ account });
  } catch (e) {
    return fail(res, e);
  }
});

// Nomba webhook — receives payment notifications
nombaRouter.post("/webhook", async (req, res) => {
  try {
    const secret = process.env.NOMBA_WEBHOOK_SECRET;
    const signature = req.header("x-nomba-signature") || req.header("nomba-signature") || req.header("svix-signature");

    if (!secret) {
      return res.status(503).json({ error: "Nomba webhook secret not configured." });
    }

    // Verify HMAC signature
    const valid = verifyNombaWebhookSignature(req.rawBody || "", signature || "", secret);
    if (!valid) {
      return res.status(401).json({ error: "Invalid or missing Nomba webhook signature." });
    }

    const event = req.body || {};
    const result = applyNombaWebhook(event);

    if (!result.updated) {
      return res.status(200).json({ received: true, updated: false, reason: result.reason });
    }

    // Credit the customer's NGN wallet
    await creditBalance(
      result.customerId,
      "NGN",
      result.amount,
      `nomba_webhook_${result.refId}`,
      { accountNumber: result.accountNumber, provider: "Nomba", eventType: event.type }
    );

    return res.status(200).json({
      received: true,
      updated: true,
      refId: result.refId,
      customerId: result.customerId,
      amount: result.amount,
      currency: result.currency,
      newBalance: result.newBalance,
    });
  } catch (e) {
    return fail(res, e);
  }
});