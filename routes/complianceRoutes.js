import { Router } from "express";
import {
  getComplianceReadiness,
  submitComplianceCase,
  getComplianceCase,
  refreshVoveComplianceCase,
  listComplianceCases,
  decideComplianceCase,
  getCustomerGateStatus,
  listAllComplianceCases,
  processVoveWebhook,
} from "../services/complianceService.js";
import { verifyVoveWebhookSignature } from "../services/voveKybService.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { submitSelfServeComplianceCase } from "../services/complianceService.js";

export const complianceRouter = Router();
const fail = (res, e) => res.status(e.statusCode || 503).json({ error: e.message });

complianceRouter.get("/readiness", (_req, res) => {
  return res.json(getComplianceReadiness());
});

// Step 2 of the customer flow: the signed-in account starts its own KYC/KYB
// case. subjectType is derived from the account type and the subject is
// prefilled from registration data; extras only add fields the account does
// not store (registrationNumber, city, address).
complianceRouter.post("/cases/self", requireAuth, async (req, res) => {
  try {
    const result = await submitSelfServeComplianceCase({
      account: req.account,
      extras: {
        registrationNumber: req.body?.registrationNumber,
        city: req.body?.city,
        address: req.body?.address,
      },
    });
    return res.status(201).json(result);
  } catch (e) {
    return fail(res, e);
  }
});

complianceRouter.post("/cases", async (req, res) => {
  try {
    const result = await submitComplianceCase({
      customerId: req.body?.customerId,
      subjectType: req.body?.subjectType,
      subject: req.body?.subject,
    });
    return res.status(201).json(result);
  } catch (e) {
    return fail(res, e);
  }
});

complianceRouter.get("/cases", async (req, res) => {
  try {
    return res.json(await listComplianceCases(String(req.query.customerId || "")));
  } catch (e) {
    return fail(res, e);
  }
});

complianceRouter.get("/cases/all", async (req, res) => {
  try {
    const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
    if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
      return res.status(401).json({ error: "Unauthorized operator action." });
    }
    return res.json(await listAllComplianceCases());
  } catch (e) {
    return fail(res, e);
  }
});

complianceRouter.post("/cases/:caseId/refresh", async (req, res) => {
  try {
    const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
    if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
      return res.status(401).json({ error: "Unauthorized operator action." });
    }
    return res.json(await refreshVoveComplianceCase(req.params.caseId));
  } catch (e) {
    return fail(res, e);
  }
});

complianceRouter.get("/cases/:caseId", async (req, res) => {
  try {
    const record = await getComplianceCase(req.params.caseId);
    return record ? res.json({ case: record }) : res.status(404).json({ error: "Compliance case not found." });
  } catch (e) {
    return fail(res, e);
  }
});

complianceRouter.get("/status", async (req, res) => {
  try {
    return res.json(await getCustomerGateStatus(String(req.query.customerId || "")));
  } catch (e) {
    return fail(res, e);
  }
});

complianceRouter.post("/cases/:caseId/decision", async (req, res) => {
  try {
    const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
    if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
      return res.status(401).json({ error: "Unauthorized operator action." });
    }
    const decision = await decideComplianceCase({
      caseId: req.params.caseId,
      status: req.body?.status,
      reason: req.body?.reason,
      actorId: req.body?.actorId,
    });
    return res.json({ message: "Only the compliance record changed; no transfer state was modified.", decision });
  } catch (e) {
    return fail(res, e);
  }
});

complianceRouter.post("/webhook", async (req, res) => {
  try {
    const signature = req.get("svix-signature");
    const secret = process.env.VOVE_WEBHOOK_SECRET || process.env.VOVE_ID_WEBHOOK_SECRET;
    if (!req.rawBody || !signature || !secret) {
      return res.status(400).json({ error: "Missing VOVE webhook signature, signing secret or raw request body." });
    }
    if (!verifyVoveWebhookSignature(req.rawBody, signature, secret)) {
      return res.status(401).json({ error: "Invalid VOVE webhook signature." });
    }

    const result = await processVoveWebhook(req.body);
    return res.status(200).json(result);
  } catch (e) {
    return fail(res, e);
  }
});
