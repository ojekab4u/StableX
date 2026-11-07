import { Router } from "express";
import {
  getSettlementReadiness,
  getOperatorBalance,
  getTokenBalance,
  settleTransfer,
  simulateSettlement,
} from "../services/baseSettlementService.js";
import { getAllAssets, getAsset } from "../config/assets.js";

export const baseSettlementRouter = Router();
const fail = (res, e) => res.status(e.statusCode || 503).json({ error: e.message });

baseSettlementRouter.get("/readiness", (_req, res) => {
  return res.json(getSettlementReadiness());
});

baseSettlementRouter.get("/balance", async (_req, res) => {
  try {
    return res.json(await getOperatorBalance());
  } catch (e) {
    return fail(res, e);
  }
});

baseSettlementRouter.get("/tokens", (_req, res) => {
  return res.json({
    tokens: getAllAssets().map((a) => ({
      symbol: a.code,
      name: a.name,
      type: a.type,
      issuer: a.issuer,
      region: a.region,
      settlement: a.settlement,
      status: a.status,
      decimals: a.decimals,
      networks: a.networks,
      contractAddresses: a.contractAddresses,
    })),
    count: getAllAssets().length,
  });
});

baseSettlementRouter.get("/token-balance", async (req, res) => {
  try {
    const token = req.query.token || "USDC";
    const address = req.query.address;
    if (!address) {
      return res.status(400).json({ error: "Provide ?address=0x..." });
    }
    return res.json(await getTokenBalance(token, address));
  } catch (e) {
    return fail(res, e);
  }
});

baseSettlementRouter.post("/settle", async (req, res) => {
  try {
    const result = await settleTransfer({
      transferId: req.body?.transferId,
      customerId: req.body?.customerId,
      recipientAddress: req.body?.recipientAddress,
      amount: req.body?.amount,
      tokenSymbol: req.body?.token || "USDC",
    });
    return res.status(200).json(result);
  } catch (e) {
    return fail(res, e);
  }
});

baseSettlementRouter.post("/simulate", async (req, res) => {
  try {
    const result = await simulateSettlement({
      transferId: req.body?.transferId,
      customerId: req.body?.customerId,
      recipientAddress: req.body?.recipientAddress,
      amount: req.body?.amount,
      tokenSymbol: req.body?.token || "USDC",
    });
    return res.status(200).json(result);
  } catch (e) {
    return fail(res, e);
  }
});
