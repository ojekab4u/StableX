import { Router } from "express";
import {
  getOrchestrationOverview,
  getOrchestrationIntent,
  quoteThroughOrchestrator,
} from "../services/orchestrationService.js";

export const orchestrationRouter = Router();

orchestrationRouter.get("/overview", (_req, res) => {
  res.json(getOrchestrationOverview());
});

orchestrationRouter.post("/quote", async (req, res) => {
  try {
    const { from, to, amount } = req.body || {};
    if (typeof from !== "string" || typeof to !== "string") {
      return res.status(400).json({ error: "Provide source and destination currencies." });
    }
    const intent = await quoteThroughOrchestrator({ from, to, amount });
    return res.status(201).json({
      message: "Live provider quote received and orchestration intent recorded. No payment or transfer was initiated.",
      intent,
    });
  } catch (error) {
    console.error("StableX orchestration quote failed:", error.message);
    return res.status(error.statusCode || 502).json({
      error: error.message,
      providerStatus: error.providerStatus || null,
    });
  }
});

orchestrationRouter.get("/intents/:intentId", (req, res) => {
  const intent = getOrchestrationIntent(req.params.intentId);
  if (!intent) return res.status(404).json({ error: "Orchestration intent not found in this running process." });
  return res.json({ intent });
});
