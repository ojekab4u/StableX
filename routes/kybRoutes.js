import { Router } from "express";
import {
  submitComplianceCase,
  getComplianceCaseByProviderReference,
  processVoveWebhook,
  refreshVoveComplianceCase,
} from "../services/complianceService.js";
import { getVoveKybReadiness, verifyVoveWebhookSignature } from "../services/voveKybService.js";

export const kybRouter = Router();

kybRouter.get("/readiness", (_req, res) => {
  return res.json(getVoveKybReadiness());
});

// Keep the existing hosted VOVE link workflow, but attach every case to a
// StableX customer and persist the VOVE refId in PostgreSQL.
kybRouter.post("/cases", async (req, res) => {
  const { customerId, businessName, country, registrationNumber, city, address } = req.body || {};
  if (typeof customerId !== "string" || !customerId.trim()) {
    return res.status(400).json({ error: "StableX customerId is required to track this verification." });
  }
  if (typeof businessName !== "string" || businessName.trim().length < 2 ||
      typeof country !== "string" || !/^[A-Za-z]{2}$/.test(country.trim())) {
    return res.status(400).json({ error: "Business name and a two-letter ISO country code are required." });
  }

  try {
    const result = await submitComplianceCase({
      customerId: customerId.trim(),
      subjectType: "BUSINESS",
      subject: {
        businessName: businessName.trim(),
        country: country.trim().toUpperCase(),
        ...(typeof registrationNumber === "string" && registrationNumber.trim() ? { registrationNumber: registrationNumber.trim() } : {}),
        ...(typeof city === "string" && city.trim() ? { city: city.trim() } : {}),
        ...(typeof address === "string" && address.trim() ? { address: address.trim() } : {}),
      },
    });
    return res.status(201).json({
      message: "VOVE hosted verification session created and linked to the StableX customer. Completion is not automatic approval.",
      case: {
        caseId: result.case.caseId,
        customerId: result.case.customerId,
        refId: result.case.providerReference,
        status: result.case.status,
        providerStatus: result.case.providerStatus,
        createdAt: result.case.createdAt,
      },
      verificationUrl: result.verificationUrl,
    });
  } catch (error) {
    console.error("VOVE KYB case creation failed:", error.message);
    return res.status(error.statusCode || 502).json({
      error: error.message,
      providerStatus: error.providerStatus || null,
    });
  }
});

// Operator-only pull refresh for cases where a VOVE webhook was missed.
kybRouter.post("/cases/:refId/refresh", async (req, res) => {
  const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
  if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
    return res.status(401).json({ error: "Unauthorized operator action." });
  }
  try {
    const result = await refreshVoveComplianceCase(req.params.refId);
    return res.status(result.updated ? 200 : 202).json(result);
  } catch (error) {
    return res.status(error.statusCode || 502).json({ error: error.message });
  }
});

kybRouter.get("/cases/:refId", async (req, res) => {
  try {
    const record = await getComplianceCaseByProviderReference(req.params.refId);
    if (!record) return res.status(404).json({ error: "No persisted StableX compliance case matches this VOVE reference." });
    return res.json({
      case: {
        caseId: record.caseId,
        customerId: record.customerId,
        refId: record.providerReference,
        requirement: record.requirement,
        status: record.status,
        providerStatus: record.providerStatus,
        decisionReason: record.decisionReason,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        decidedAt: record.decidedAt,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 503).json({ error: error.message });
  }
});

// Retain the existing webhook URL so the VOVE dashboard configuration does
// not need to change. Only verified signatures can update persisted cases.
kybRouter.post("/webhook", async (req, res) => {
  try {
    const signature = req.get("svix-signature");
    const secret = process.env.VOVE_ID_WEBHOOK_SECRET || process.env.VOVE_WEBHOOK_SECRET;
    if (!req.rawBody || !signature || !secret) {
      return res.status(400).json({ error: "Missing VOVE webhook signature, signing secret or raw request body." });
    }
    if (!verifyVoveWebhookSignature(req.rawBody, signature, secret)) {
      return res.status(401).json({ error: "Invalid VOVE webhook signature." });
    }
    const result = await processVoveWebhook(req.body);
    return res.status(200).json({ received: true, ...result });
  } catch (error) {
    return res.status(error.statusCode || 503).json({ error: error.message });
  }
});
