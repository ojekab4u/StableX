// Nomba routes — NGN virtual accounts & webhook settlement
import { Router } from "express";
import {
  getNombaReadiness,
  createNombaVirtualAccount,
  getNombaAccount,
  getNombaAccountsByCustomer,
  applyNombaWebhook,
  verifyNombaWebhookSignature,
  lookupNombaBankAccount,
  transferToNigerianBank,
} from "../services/nombaService.js";
import { getCustomerGateStatus } from "../services/complianceService.js";

export const nombaRouter = Router();
const fail = (res, e) => res.status(e.statusCode || 503).json({ error: e.message });

function requireOperator(req, res, next) {
  const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
  if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
    return res.status(401).json({ error: "Unauthorized operator action." });
  }
  return next();
}

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
    const gate = await getCustomerGateStatus(customerId);
    if (!gate.gate.approved) return res.status(403).json({ error: "Complete identity verification before requesting payment details.", verification: gate.gate });
    const account = await createNombaVirtualAccount({ customerId, customerName, email, phone, bvn });
    return res.status(201).json({ account });
  } catch (e) {
    return fail(res, e);
  }
});

// List all virtual accounts for a customer
nombaRouter.get("/virtual-accounts/:customerId", async (_req, res) => {
  try {
    const customerId = _req.params.customerId;
    const accounts = await getNombaAccountsByCustomer(customerId);
    return res.json({ customerId, accounts });
  } catch (e) {
    return fail(res, e);
  }
});

// Get a single virtual account
nombaRouter.get("/virtual-accounts/:refId/details", async (_req, res) => {
  try {
    const refId = _req.params.refId;
    const account = await getNombaAccount(refId);
    if (!account) {
      return res.status(404).json({ error: "Virtual account not found." });
    }
    return res.json({ account });
  } catch (e) {
    return fail(res, e);
  }
});

// Verify a recipient bank account before payout (returns the holder's name).
nombaRouter.post("/bank-lookup", async (req, res) => {
  try {
    const result = await lookupNombaBankAccount(req.body?.accountNumber, req.body?.bankCode);
    return res.json({ lookup: result });
  } catch (e) {
    return fail(res, e);
  }
});

// Payout NGN to a Nigerian bank from the Nomba business account.
// Operator-only: this moves real funds in production.
nombaRouter.post("/transfers/bank", requireOperator, async (req, res) => {
  try {
    const result = await transferToNigerianBank({
      amount: req.body?.amount,
      accountNumber: req.body?.accountNumber,
      accountName: req.body?.accountName,
      bankCode: req.body?.bankCode,
      merchantTxRef: req.body?.merchantTxRef,
      senderName: req.body?.senderName,
      narration: req.body?.narration,
    });
    return res.status(201).json({
      transfer: result,
      note: "Final status arrives via webhook or the requery endpoint.",
    });
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
    const result = await applyNombaWebhook(event);

    if (!result.updated) {
      return res.status(200).json({ received: true, ...result });
    }

    return res.status(200).json({
      received: true,
      updated: true,
      duplicate: false,
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