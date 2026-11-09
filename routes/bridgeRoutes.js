import { Router } from "express";
import {
  getBridgeReadiness,
  getBridgeRate,
  listBridgeCustomers,
  getBridgeCustomer,
  createBridgeOnRampOrder,
} from "../services/providers/bridgeService.js";

export const bridgeRouter = Router();
const fail = (res, e) => res.status(e.statusCode || 503).json({ error: e.message });

bridgeRouter.get("/readiness", (_req, res) => res.json(getBridgeReadiness()));

// Read-only provider lookup. Match locally by client_reference_id so no
// assumptions are made about undocumented server-side filtering parameters.
bridgeRouter.get("/customers/lookup", async (req, res) => {
  try {
    const customerId = String(req.query.customerId || "").trim();
    if (!customerId || customerId.length > 128) {
      return res.status(400).json({ error: "A valid StableX customerId is required." });
    }

    const matches = [];
    const seenCursors = new Set();
    let startingAfter;
    let pagesScanned = 0;
    const maxPages = 50;

    while (pagesScanned < maxPages) {
      const payload = await listBridgeCustomers({ startingAfter, limit: 100 });
      const customers = Array.isArray(payload) ? payload
        : Array.isArray(payload.data) ? payload.data
        : Array.isArray(payload.customers) ? payload.customers
        : Array.isArray(payload.results) ? payload.results : null;

      if (!customers) {
        return res.status(502).json({
          error: "Bridge customer-list response did not contain a recognized customer array.",
          responseKeys: Object.keys(payload || {}),
          pagesScanned,
          lookupComplete: false,
        });
      }

      pagesScanned += 1;
      matches.push(...customers.filter((item) =>
        String(item.client_reference_id || item.clientReferenceId || "") === customerId
      ));

      const hasMore = payload.has_more === true ||
        payload.hasMore === true ||
        payload.pagination?.has_more === true;

      if (!hasMore) {
        return res.json({
          provider: "Bridge",
          environment: getBridgeReadiness().environment,
          stablexCustomerId: customerId,
          matchCount: matches.length,
          matches: matches.map((item) => ({
            id: item.id || item.customer_id || item.customerId || null,
            clientReferenceId: item.client_reference_id || item.clientReferenceId || null,
            type: item.type || null,
            status: item.status || null,
            createdAt: item.created_at || item.createdAt || null,
          })),
          pagesScanned,
          lookupComplete: true,
          lookupIsReadOnly: true,
        });
      }

      const lastCustomer = customers[customers.length - 1];
      const nextCursor = payload.next_cursor || payload.pagination?.next_cursor ||
        lastCustomer?.id || lastCustomer?.customer_id || lastCustomer?.customerId;

      if (!nextCursor || seenCursors.has(String(nextCursor))) {
        return res.status(502).json({
          error: "Bridge indicated more customer pages but did not provide a usable next cursor.",
          pagesScanned,
          lookupComplete: false,
          lookupIsReadOnly: true,
        });
      }
      startingAfter = String(nextCursor);
      seenCursors.add(startingAfter);
    }

    return res.status(503).json({
      error: "Bridge customer lookup reached its 50-page safety limit; no complete result can be claimed.",
      pagesScanned,
      lookupComplete: false,
      lookupIsReadOnly: true,
    });
  } catch (e) { return fail(res, e); }
});

bridgeRouter.get("/customers/:bridgeCustomerId", async (req, res) => {
  try {
    const customer = await getBridgeCustomer(req.params.bridgeCustomerId);
    const item = customer.data || customer;
    return res.json({
      customer: {
        id: item.id || item.customer_id || item.customerId || null,
        clientReferenceId: item.client_reference_id || item.clientReferenceId || null,
        type: item.type || null,
        status: item.status || null,
        endorsements: item.endorsements || null,
      },
    });
  } catch (e) { return fail(res, e); }
});

bridgeRouter.post("/quote", async (req, res) => {
  try {
    const { from, to, amount } = req.body || {};
    if (!from || !to || !amount) return res.status(400).json({ error: "from, to and amount are required." });
    const quote = await getBridgeRate({ from, to, amount: Number(amount) });
    return res.json({ quote });
  } catch (e) { return fail(res, e); }
});

bridgeRouter.post("/onramp", async (req, res) => {
  try {
    const { customerId, from, to, amount, recipientWalletAddress } = req.body || {};
    if (!customerId || !from || !to || !amount || !recipientWalletAddress) {
      return res.status(400).json({ error: "customerId, from, to, amount and recipientWalletAddress are required." });
    }
    const order = await createBridgeOnRampOrder({ customerId, from, to, amount: Number(amount), recipientWalletAddress });
    return res.status(201).json({ order });
  } catch (e) { return fail(res, e); }
});
