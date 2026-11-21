import { Router } from "express";
import {
  getFincraReadiness,
  resolveInteracRecipient,
  buildCadPayoutRequest,
  createCadPayout,
  generateQuote,
} from "../services/providers/fincraService.js";
import { receiveFincraWebhook } from "../services/fincraWebhookService.js";

export const fincraRouter = Router();
export const fincraWebhookRouter = Router();

const fail = (res, error) => res.status(error.statusCode || 502).json({
  error: error.message,
  ...(error.providerResponse ? { provider: "Fincra" } : {}),
});

function requireOperator(req, res, next) {
  const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
  if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
    return res.status(401).json({ error: "Unauthorized operator action." });
  }
  return next();
}

// Public: lets the app show whether the CAD rail is wired.
fincraRouter.get("/readiness", (_req, res) => res.json(getFincraReadiness()));

fincraRouter.post("/resolve-interac", requireOperator, async (req, res) => {
  try {
    return res.json({ provider: "Fincra", recipient: await resolveInteracRecipient(req.body?.interacEmail) });
  } catch (error) { return fail(res, error); }
});

fincraRouter.post("/payouts/cad", requireOperator, async (req, res) => {
  try {
    const request = buildCadPayoutRequest({
      amount: req.body?.amount,
      description: req.body?.description,
      customerReference: req.body?.customerReference,
      recipient: req.body?.recipient,
      sourceCurrency: req.body?.sourceCurrency,
      quoteReference: req.body?.quoteReference,
    });
    const payload = await createCadPayout(request);
    return res.status(201).json({ provider: "Fincra", payout: payload?.data ?? payload });
  } catch (error) { return fail(res, error); }
});

fincraRouter.post("/quotes", requireOperator, async (req, res) => {
  try {
    const payload = await generateQuote({
      sourceCurrency: req.body?.sourceCurrency,
      destinationCurrency: req.body?.destinationCurrency,
      amount: req.body?.amount,
      paymentDestination: req.body?.paymentDestination,
      paymentScheme: req.body?.paymentScheme,
    });
    return res.json({ provider: "Fincra", quote: payload?.data ?? payload });
  } catch (error) { return fail(res, error); }
});

// Signed by Fincra: HMAC SHA512 of the raw body in the signature header.
fincraWebhookRouter.post("/", async (req, res) => {
  try {
    const result = await receiveFincraWebhook({ rawBody: req.rawBody || "", signature: req.get("signature") || "" });
    return res.json({ received: true, ...result });
  } catch (error) {
    return res.status(error.statusCode || 401).json({ error: error.message });
  }
});
