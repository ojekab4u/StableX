import { Router } from "express";
import { getProviderReadiness, getProviderRatePreviews } from "../services/providers/providerService.js";

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
