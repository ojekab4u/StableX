import { Router } from "express";
import { createBeneficiary,listBeneficiaries,createTransfer,getTransfer,getTransfers,setTransferStatus } from "../services/transferService.js";
import { recordProviderEvent } from "../repositories/transferRepository.js";
import { getCustomerGateStatus } from "../services/complianceService.js";
import { createPaytrieProviderOrder, getPaytrieProviderOrder, refreshPaytrieProviderOrder } from "../services/providerOrderService.js";
export const transferRouter=Router();
const fail=(res,e)=>res.status(e.statusCode||503).json({error:e.message});
transferRouter.post("/beneficiaries",async(req,res)=>{try{return res.status(201).json({beneficiary:await createBeneficiary(req.body||{})});}catch(e){return fail(res,e);}});
transferRouter.get("/beneficiaries",async(req,res)=>{try{return res.json({beneficiaries:await listBeneficiaries(String(req.query.customerId||""))});}catch(e){return fail(res,e);}});
transferRouter.post("/",async(req,res)=>{try{const result=await createTransfer({...req.body,idempotencyKey:req.get("Idempotency-Key")});return res.status(result.replayed?200:201).json({message:result.replayed?"Existing transfer returned; no duplicate created.":"Draft created; no funds were collected or moved.",...result});}catch(e){return fail(res,e);}});
transferRouter.get("/",async(req,res)=>{try{return res.json({transfers:await getTransfers(String(req.query.customerId||""))});}catch(e){return fail(res,e);}});
transferRouter.get("/:id",async(req,res)=>{try{const transfer=await getTransfer(req.params.id,String(req.query.customerId||""));return transfer?res.json({transfer}):res.status(404).json({error:"Transfer not found."});}catch(e){return fail(res,e);}});
transferRouter.patch("/:id/status",async(req,res)=>{try{const operatorToken=process.env.STABLEX_OPERATOR_TOKEN;if(!operatorToken||req.get("Authorization")!==`Bearer ${operatorToken}`)return res.status(401).json({error:"Unauthorized operator action."});const transfer=await setTransferStatus({id:req.params.id,customerId:String(req.body?.customerId||""),status:req.body?.status,actorId:req.body?.actorId,reason:req.body?.reason});return res.json({message:"State recorded only; no provider or blockchain action was triggered.",transfer});}catch(e){return fail(res,e);}});

// Prepare a transfer for settlement: creates DRAFT, then advances to QUOTED (operator action)
transferRouter.post("/prepare",async(req,res)=>{try{
  const { customerId, beneficiaryId, from, to, amount } = req.body || {};
  if (!customerId || !beneficiaryId || !from || !to || !amount) {
    return res.status(400).json({ error: "customerId, beneficiaryId, from, to and amount are required." });
  }
  // Create DRAFT transfer
  const draft = await createTransfer({ customerId, beneficiaryId, from, to, amount, idempotencyKey: "stablex_prepare_" + Date.now() });
  // Advance to QUOTED via operator (simulates quote selection)
  const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
  const gate = await getCustomerGateStatus(customerId);
  if (!gate.gate.approved) {
    return res.status(403).json({ error: `Compliance gate: transfer cannot be prepared. Customer status is ${gate.gate.status}.` });
  }
  const quoted = await setTransferStatus({
    id: draft.id,
    customerId,
    status: "QUOTED",
    actorId: "operator",
    reason: "Prepared for settlement",
  });
  return res.status(201).json({ message: "Transfer prepared for settlement.", transferId: draft.id, status: quoted.status, transfer: quoted });
}catch(e){return fail(res,e);}});


// Paytrie order actions are operator-gated in this local prototype.
// The customer's short-lived Paytrie JWT is forwarded only to the provider adapter.
function requireOperator(req, res) {
  const token = process.env.STABLEX_OPERATOR_TOKEN;
  if (!token || req.get("Authorization") !== `Bearer ${token}`) {
    res.status(401).json({ error: "Unauthorized operator action." });
    return false;
  }
  return true;
}

transferRouter.post("/:id/provider-order", async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const result = await createPaytrieProviderOrder({
      transferId: req.params.id,
      customerId: String(req.body?.customerId || ""),
      idempotencyKey: req.get("Idempotency-Key"),
      userJwt: req.get("X-Paytrie-User-Token"),
      confirm: req.body?.confirm,
    });
    const status = result.attempt?.status === "ACCEPTED" ? (result.replayed ? 200 : 201)
      : result.attempt?.status === "UNKNOWN" ? 202 : 200;
    return res.status(status).json(result);
  } catch (error) {
    return fail(res, error);
  }
});

transferRouter.get("/:id/provider-order", async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const attempt = await getPaytrieProviderOrder({
      transferId: req.params.id,
      customerId: String(req.query.customerId || ""),
    });
    return attempt ? res.json({ attempt }) : res.status(404).json({ error: "No provider order attempt exists for this transfer." });
  } catch (error) {
    return fail(res, error);
  }
});

transferRouter.post("/:id/provider-order/refresh", async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const result = await refreshPaytrieProviderOrder({
      transferId: req.params.id,
      customerId: String(req.body?.customerId || ""),
      userJwt: req.get("X-Paytrie-User-Token"),
    });
    return res.json(result);
  } catch (error) {
    return fail(res, error);
  }
});

transferRouter.post("/provider-events",async(req,res)=>{
 try {
  const token=process.env.STABLEX_EVENT_INGESTION_TOKEN;
  if(!token || req.get("Authorization")!==`Bearer ${token}`) return res.status(401).json({error:"Unauthorized event ingestion."});
  const {provider,providerEventId,eventType,payload}=req.body||{};
  if(typeof provider!=="string"||!provider.trim()||typeof providerEventId!=="string"||!providerEventId.trim()||typeof eventType!=="string"||!eventType.trim()||!payload||typeof payload!=="object") return res.status(400).json({error:"provider, providerEventId, eventType and object payload are required."});
  const result=await recordProviderEvent({provider:provider.trim(),eventId:providerEventId.trim(),eventType:eventType.trim(),payload});
  return res.status(result.duplicate?200:201).json(result);
 } catch(error){return fail(res,error);}
});
