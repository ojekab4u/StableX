// Linkio operator workspace routes (FX + ramp APIs — Retail and B2B).
// Every state-changing endpoint is gated behind the StableX operator token:
// Linkio transactions are initiated against the StableX business account, so
// they are operator decisions, not individual customer actions.
import express, { Router } from "express";
import crypto from "node:crypto";
import {
  getLinkioReadiness,
  getLinkioBaseUrl,
  getLinkioRate,
  getLinkioB2BRateQuote,
  requestLinkioB2BOnramp,
  requestLinkioB2BOfframp,
  requestLinkioRetailOnramp,
  requestLinkioRetailOfframp,
  getLinkioTransaction,
  getLinkioPayoutStatus,
  recordLinkioEvent,
  listLinkioEvents,
  linkioEventsForReference,
  startLinkioCustomerOnramp,
  getLinkioOnrampSession,
  getLinkioPaymentVendors,
  mergeLinkioOnrampSessionTransaction,
} from "../services/providers/linkioService.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const linkioRouter = Router();

const fail = (res, error) => res.status(error.statusCode || 503).json({
  error: error.message,
  ...(error.providerCode ? { provider: "Linkio", providerCode: error.providerCode } : {}),
  ...(error.providerStatus ? { providerStatus: error.providerStatus } : {}),
});

function requireOperator(req, res, next) {
  const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
  if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
    return res.status(401).json({ error: "Unauthorized operator action." });
  }
  return next();
}

// Readiness is public so workspace pages can show configuration state.
linkioRouter.get("/readiness", (_req, res) => {
  const readiness = getLinkioReadiness();
  return res.json({
    ...readiness,
    baseUrl: getLinkioBaseUrl(),
    note: "One ngnc-sec-key authenticates both the Retail and B2B APIs. A test key returns test transactions; a live key returns live ones.",
  });
});

// Normalized routing preview used by the StableX routing engine.
linkioRouter.post("/rate", requireOperator, async (req, res) => {
  try {
    return res.json({
      provider: "Linkio",
      quote: await getLinkioRate({
        from: req.body?.from, to: req.body?.to, amount: Number(req.body?.amount),
      }),
    });
  } catch (error) { return fail(res, error); }
});

// Raw B2B rate quote: { currency, trxType, amount }.
linkioRouter.post("/b2b/rate", requireOperator, async (req, res) => {
  try {
    return res.json({
      provider: "Linkio",
      rateQuote: await getLinkioB2BRateQuote({
        currency: req.body?.currency, trxType: req.body?.trxType, amount: req.body?.amount,
      }),
    });
  } catch (error) { return fail(res, error); }
});

// POST /otc/onramp — fiat -> stablecoin to walletAddress. Settlement account
// details arrive via the banking_details_received webhook. This creates a REAL
// transaction; confirm a test key is configured before non-production use.
linkioRouter.post("/b2b/onramp", requireOperator, async (req, res) => {
  try {
    return res.status(201).json({
      provider: "Linkio",
      transaction: await requestLinkioB2BOnramp({
        customerId: req.body?.customerId,
        currency: req.body?.currency,
        amount: req.body?.amount,
        stables: req.body?.stables,
        walletAddress: req.body?.walletAddress,
        network: req.body?.network,
        paymentDetails: req.body?.paymentDetails,
      }),
      note: "Real B2B onramp initiated. Watch the banking_details_received webhook for the settlement account details.",
    });
  } catch (error) { return fail(res, error); }
});

// POST /otc/offramp — stablecoin -> fiat payout to the settlement account.
linkioRouter.post("/b2b/offramp", requireOperator, async (req, res) => {
  try {
    return res.status(201).json({
      provider: "Linkio",
      transaction: await requestLinkioB2BOfframp({
        customerId: req.body?.customerId,
        currency: req.body?.currency,
        amount: req.body?.amount,
        stables: req.body?.stables,
        walletAddress: req.body?.walletAddress,
        network: req.body?.network,
        paymentDetails: req.body?.paymentDetails,
      }),
      note: "Real B2B offramp initiated. The stablecoin must reach the wallet before fiat settles.",
    });
  } catch (error) { return fail(res, error); }
});

// Retail (Direct FX) ramps: NGN/USD only; LINK handles end-customer KYC.
linkioRouter.post("/retail/onramp", requireOperator, async (req, res) => {
  try {
    return res.status(201).json({
      provider: "Linkio",
      transaction: await requestLinkioRetailOnramp({
        currency: req.body?.currency,
        amount: req.body?.amount,
        stables: req.body?.stables,
        walletAddress: req.body?.walletAddress,
        network: req.body?.network,
        vendor: req.body?.vendor,
      }),
      note: "The response carries the vendor collection account the customer pays into.",
    });
  } catch (error) { return fail(res, error); }
});

linkioRouter.post("/retail/offramp", requireOperator, async (req, res) => {
  try {
    return res.status(201).json({
      provider: "Linkio",
      transaction: await requestLinkioRetailOfframp({
        currency: req.body?.currency,
        amount: req.body?.amount,
        stables: req.body?.stables,
        bankName: req.body?.bankName,
        accountNumber: req.body?.accountNumber,
        accountName: req.body?.accountName,
        walletAddress: req.body?.walletAddress,
        network: req.body?.network,
        routingNumber: req.body?.routingNumber,
        accountType: req.body?.accountType,
        chargeFeeOnRequest: req.body?.chargeFeeOnRequest,
      }),
      note: "Real retail offramp initiated; fiat is disbursed to the provided bank account.",
    });
  } catch (error) { return fail(res, error); }
});

linkioRouter.get("/transactions/:reference", requireOperator, async (req, res) => {
  try {
    return res.json({
      provider: "Linkio",
      transaction: await getLinkioTransaction(req.params.reference),
    });
  } catch (error) { return fail(res, error); }
});

linkioRouter.get("/payout-status/:reference", requireOperator, async (req, res) => {
  try {
    return res.json({
      provider: "Linkio",
      payoutStatus: await getLinkioPayoutStatus(req.params.reference),
    });
  } catch (error) { return fail(res, error); }
});

// Inbound Linkio (Bridge) webhooks.
// Signature verification: HMAC-SHA256 of the raw body with the endpoint's
// signing secret, sent as the `X-Webhook-Signature` header.
// Must stay public; we reject anything with a bad signature.
linkioRouter.post(
  "/webhooks",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const secret = String(process.env.LINKIO_WEBHOOK_SECRET_KEY || "").trim();
    const received = req.get("X-Webhook-Signature") || "";
    if (!secret) {
      console.log("[linkio] webhook: no secret configured, accepting unverified");
    } else if (!received) {
      console.log("[linkio] webhook: missing signature, rejecting");
      return res.status(401).send("Missing webhook signature");
    } else {
      const expected = crypto
        .createHmac("sha256", secret)
        .update(req.body)
        .digest("hex");
      if (
        received.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"))
      ) {
        console.log("[linkio] webhook: bad signature, rejecting");
        return res.status(401).send("Invalid webhook signature");
      }
    }

    let event;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON body");
    }

    const record = recordLinkioEvent(event);
    console.log(
      `[linkio] webhook: ${record.event}` +
        `${record.reference ? ` ref=${record.reference}` : ""}` +
        `${record.status ? ` status=${record.status}` : ""}`
    );
    return res.json({ received: true, event: record.event });
  }
);

// Operator view of the last events received (payment.onramp.* etc.).
linkioRouter.get("/webhooks", requireOperator, (_req, res) => {
  return res.json({ provider: "Linkio", events: listLinkioEvents() });
});

// Customer test flow: signed-in customers create a real NGN→USDC onramp
// (Linkio Retail Direct FX) and follow its progress by reference.
linkioRouter.post("/onramp-sessions", requireAuth, async (req, res) => {
  try {
    if (!req.body?.walletAddress || !String(req.body.walletAddress).startsWith("0x")) {
      return res.status(400).json({ error: "A Base wallet address (0x…) is required to receive the USDC." });
    }
    const session = await startLinkioCustomerOnramp({
      customerId: req.account.accountId,
      amount: req.body?.amount,
      network: req.body?.network || "Base",
      walletAddress: req.body?.walletAddress,
    });
    return res.status(201).json({ provider: "Linkio", session });
  } catch (error) { return fail(res, error); }
});

linkioRouter.get("/onramp-sessions/:reference", requireAuth, async (req, res) => {
  const session = getLinkioOnrampSession(req.params.reference);
  if (!session || session.customerId !== req.account.accountId) {
    return res.status(404).json({ error: "Onramp session not found. Sessions are cleared when the server restarts." });
  }
  let transaction = null;
  let transactionRefreshError = null;
  try {
    transaction = await getLinkioTransaction(req.params.reference);
    mergeLinkioOnrampSessionTransaction(req.params.reference, transaction);
  } catch (error) {
    // Keep the customer session available, but report why live transaction
    // reconciliation did not return details instead of silently hiding it.
    transactionRefreshError = error.message;
  }
  return res.json({
    provider: "Linkio",
    session: getLinkioOnrampSession(req.params.reference),
    events: linkioEventsForReference(req.params.reference),
    transaction,
    transactionRefreshError,
  });
});

// Customer test flow: list Linkio payment vendors (banks) the customer can pay into.
// GET /api/linkio/payment-vendors?currency=NGN
linkioRouter.get("/payment-vendors", requireAuth, async (_req, res) => {
  try {
    const vendors = await getLinkioPaymentVendors({ currency: "NGN" });
    return res.json({ provider: "Linkio", vendors });
  } catch (error) { return fail(res, error); }
});
