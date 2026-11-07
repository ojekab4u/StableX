import { Router } from "express";
import {
  getBridgeReadiness,
  getBridgeRate,
  createBridgeOnRampOrder,
} from "../services/providers/bridgeService.js";

export const bridgeRouter = Router();
const fail = (res, e) => res.status(e.statusCode || 503).json({ error: e.message });

bridgeRouter.get("/readiness", (_req, res) => {
  return res.json(getBridgeReadiness());
});

bridgeRouter.post("/quote", async (req, res) => {
  try {
    const { from, to, amount } = req.body || {};
    if (!from || !to || !amount) {
      return res.status(400).json({ error: "from, to and amount are required." });
    }
    const quote = await getBridgeRate({ from, to, amount: Number(amount) });
    return res.json({ quote });
  } catch (e) {
    return fail(res, e);
  }
});

bridgeRouter.post("/onramp", async (req, res) => {
  try {
    const { customerId, from, to, amount, recipientWalletAddress } = req.body || {};
    if (!customerId || !from || !to || !amount || !recipientWalletAddress) {
      return res.status(400).json({ error: "customerId, from, to, amount and recipientWalletAddress are required." });
    }
    const order = await createBridgeOnRampOrder({ customerId, from, to, amount: Number(amount), recipientWalletAddress });
    return res.status(201).json({ order });
  } catch (e) {
    return fail(res, e);
  }
});