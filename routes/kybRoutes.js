import { Router } from "express";
import {
  applyVoveKybWebhook,
  createVoveKybCase,
  getVoveKybCase,
  getVoveKybReadiness,
  verifyVoveWebhookSignature,
} from "../services/voveKybService.js";

export const kybRouter = Router();

kybRouter.get("/readiness", (_req, res) => {
  res.json(getVoveKybReadiness());
});

kybRouter.post("/cases", async (req, res) => {
  const { businessName, country, registrationNumber, city, address } = req.body || {};
  if (typeof businessName !== "string" || businessName.trim().length < 2 ||
      typeof country !== "string" || country.trim().length < 2) {
    return res.status(400).json({ error: "Business name and country are required." });
  }

  try {
    const record = await createVoveKybCase({
      businessName: businessName.trim(),
      country: country.trim(),
      registrationNumber: typeof registrationNumber === "string" ? registrationNumber.trim() : "",
      city: typeof city === "string" ? city.trim() : "",
      address: typeof address === "string" ? address.trim() : "",
    });
    return res.status(201).json({
      message: "VOVE sandbox KYB case created. This is not an approval or a production onboarding decision.",
      case: record,
    });
  } catch (error) {
    console.error("VOVE KYB case creation failed:", error.message);
    return res.status(error.statusCode || 502).json({
      error: error.message,
      providerStatus: error.providerStatus || null,
    });
  }
});

kybRouter.get("/cases/:refId", (req, res) => {
  const record = getVoveKybCase(req.params.refId);
  if (!record) {
    return res.status(404).json({
      error: "Case not found in this StableX process. Demo records are held in memory and reset when the server restarts.",
    });
  }
  return res.json({ case: record });
});

kybRouter.post("/webhook", (req, res) => {
  const secret = process.env.VOVE_ID_WEBHOOK_SECRET;
  const signature = req.header("svix-signature");
  if (!verifyVoveWebhookSignature(req.rawBody, signature, secret)) {
    return res.status(401).json({ error: "Invalid or missing VOVE webhook signature." });
  }
  const result = applyVoveKybWebhook(req.body);
  return res.status(200).json({ received: true, ...result });
});
