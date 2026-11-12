import { Router } from "express";
import { getRoutingQuotes, getRoutingQuote, selectQuoteForTransfer } from "../services/routingService.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const routingRouter = Router();
const fail = (res, e) => res.status(e.statusCode || 503).json({ error: e.message });

routingRouter.post("/quotes", async (req, res) => {
  try {
    return res.status(201).json(await getRoutingQuotes({
      from: req.body?.from,
      to: req.body?.to,
      amount: req.body?.amount,
    }));
  } catch (e) {
    return fail(res, e);
  }
});

routingRouter.get("/quotes/:quoteId", async (req, res) => {
  try {
    const quote = await getRoutingQuote(req.params.quoteId);
    return quote ? res.json({ quote }) : res.status(404).json({ error: "Quote not found or expired." });
  } catch (e) {
    return fail(res, e);
  }
});

routingRouter.post("/select", requireAuth, async (req, res) => {
  try {
    const result = await selectQuoteForTransfer({
      customerId: req.account.accountId,
      transferId: req.body?.transferId,
      quoteId: req.body?.quoteId,
    });
    return res.status(200).json({ message: "Quote recorded on the transfer; no order was created and no funds were moved.", ...result });
  } catch (e) {
    return fail(res, e);
  }
});
