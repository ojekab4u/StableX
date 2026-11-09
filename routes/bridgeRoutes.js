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
    const payload = await listBridgeCustomers();
    const customers = Array.isArray(payload) ? payload
      : Array.isArray(payload.data) ? payload.data
      : Array.isArray(payload.customers) ? payload.customers
      : Array.isArray(payload.results) ? payload.results : null;
    if (!customers) {
      return res.status(502).json({
        error: "Bridge customer-list response did not contain a recognized customer array.",
        responseKeys: Object.keys(payload || {}),
      });
    }
    const matches = customers.filter((item) =>
      String(item.client_reference_id || item.clientReferenceId || "") === customerId
    );
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
