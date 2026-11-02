import { Router } from "express";
import { isAddress } from "viem";
import { getIntegrationReadiness } from "../services/integrationReadiness.js";
import {
  getSendRoutes,
  describeRoute,
  createSendDraft,
  getSendDraft,
} from "../services/sendWorkflow.js";

export const sendRouter = Router();

sendRouter.get("/readiness", (req, res) => {
  return res.json(getIntegrationReadiness());
});

sendRouter.get("/routes", (req, res) => {
  const routes = getSendRoutes();
  res.json({ count: routes.length, routes });
});

sendRouter.get("/availability", (req, res) => {
  const { from, to } = req.query;
  if (typeof from !== "string" || typeof to !== "string") {
    return res.status(400).json({ error: "Provide source and destination currencies." });
  }
  const route = describeRoute(from, to);
  return res.json({
    route,
    availability: route.supported ? "ROUTE_REGISTERED_LIVE_INTEGRATION_REQUIRED" : "ROUTE_NOT_CONFIGURED",
    executable: false,
  });
});

sendRouter.post("/drafts", (req, res) => {
  try {
    const { from, to, amount, recipientType, recipientReference } = req.body ?? {};
    if (recipientType === "WALLET" &&
        (typeof recipientReference !== "string" || !isAddress(recipientReference))) {
      return res.status(400).json({ error: "Enter a valid EVM wallet address (0x followed by 40 hexadecimal characters)." });
    }

    const draft = createSendDraft({
      from,
      to,
      amount: Number(amount),
      recipientType,
      recipientReference,
    });

    return res.status(201).json({
      message: "Transfer draft created. No funds were moved and no transaction was submitted.",
      draft,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

sendRouter.get("/drafts/:draftId", (req, res) => {
  const draft = getSendDraft(req.params.draftId);
  if (!draft) return res.status(404).json({ error: "Transfer draft not found." });
  return res.json({ draft });
});
