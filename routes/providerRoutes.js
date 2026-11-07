import { Router } from "express";
import { getProviderReadiness, getProviderRatePreviews } from "../services/providers/providerService.js";
import { requestPaytrieLoginCode, verifyPaytrieLoginCode } from "../services/paytrieService.js";

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


// Local operator-assisted Paytrie customer authentication.
// Paytrie requires the customer to be onboarded and verified before login.
function requireOperator(req, res) {
  const token = process.env.STABLEX_OPERATOR_TOKEN;
  if (!token || req.get("Authorization") !== `Bearer ${token}`) {
    res.status(401).json({ error: "Unauthorized operator action." });
    return false;
  }
  return true;
}

providerRouter.post("/paytrie/auth/login-code", async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const result = await requestPaytrieLoginCode(req.body?.email);
    return res.status(202).json({
      message: "Paytrie login code requested. The customer must provide the code sent to their registered email.",
      result,
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ error: error.message });
  }
});

providerRouter.post("/paytrie/auth/verify", async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const result = await verifyPaytrieLoginCode({
      email: req.body?.email,
      code: req.body?.code,
    });
    return res.json({
      message: "Paytrie customer authenticated. The JWT expires after the provider-defined lifetime; do not store it in StableX logs or source control.",
      ...result,
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ error: error.message });
  }
});
