import { Router } from "express";
import {
  getPaytrieExecutionReadiness, requestPaytrieLoginCode, verifyPaytrieLoginCode,
  createPaytrieOrder, refreshPaytrieOrder,
} from "../services/paytrieExecutionService.js";

export const paytrieRouter = Router();
function requireOperator(req,res) {
  const token = process.env.STABLEX_OPERATOR_TOKEN;
  if (!token || req.get("Authorization") !== `Bearer ${token}`) {
    res.status(401).json({ error: "Operator authentication required for this integration workspace." });
    return false;
  }
  return true;
}
paytrieRouter.get("/readiness", (_req,res) => res.json(getPaytrieExecutionReadiness()));
paytrieRouter.post("/auth/login-code", async (req,res) => {
  if (!requireOperator(req,res)) return;
  try { return res.status(202).json({ message: "Login code requested. The verified Paytrie customer must provide the code.", result: await requestPaytrieLoginCode(req.body?.email) }); }
  catch(e) { return res.status(e.statusCode || 502).json({ error: e.message }); }
});
paytrieRouter.post("/auth/verify", async (req,res) => {
  if (!requireOperator(req,res)) return;
  try { return res.json(await verifyPaytrieLoginCode({ email:req.body?.email, code:req.body?.code })); }
  catch(e) { return res.status(e.statusCode || 502).json({ error: e.message }); }
});
paytrieRouter.post("/transfers/:id/order", async (req,res) => {
  if (!requireOperator(req,res)) return;
  try {
    const result = await createPaytrieOrder({ transferId:req.params.id, customerId:String(req.body?.customerId || ""), jwt:req.get("X-Paytrie-User-Token"), confirm:req.body?.confirm });
    return res.status(result.created ? 201 : 200).json(result);
  } catch(e) { return res.status(e.statusCode || 503).json({ error:e.message }); }
});
paytrieRouter.post("/transfers/:id/refresh", async (req,res) => {
  if (!requireOperator(req,res)) return;
  try { return res.json(await refreshPaytrieOrder({ transferId:req.params.id, customerId:String(req.body?.customerId || ""), jwt:req.get("X-Paytrie-User-Token") })); }
  catch(e) { return res.status(e.statusCode || 503).json({ error:e.message }); }
});
