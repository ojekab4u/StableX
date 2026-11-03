import { Router } from "express";
import { createBeneficiary,listBeneficiaries,createTransfer,getTransfer,getTransfers,setTransferStatus } from "../services/transferService.js";
import { recordProviderEvent } from "../repositories/transferRepository.js";
export const transferRouter=Router();
const fail=(res,e)=>res.status(e.statusCode||503).json({error:e.message});
transferRouter.post("/beneficiaries",async(req,res)=>{try{return res.status(201).json({beneficiary:await createBeneficiary(req.body||{})});}catch(e){return fail(res,e);}});
transferRouter.get("/beneficiaries",async(req,res)=>{try{return res.json({beneficiaries:await listBeneficiaries(String(req.query.customerId||""))});}catch(e){return fail(res,e);}});
transferRouter.post("/",async(req,res)=>{try{const result=await createTransfer({...req.body,idempotencyKey:req.get("Idempotency-Key")});return res.status(result.replayed?200:201).json({message:result.replayed?"Existing transfer returned; no duplicate created.":"Draft created; no funds were collected or moved.",...result});}catch(e){return fail(res,e);}});
transferRouter.get("/",async(req,res)=>{try{return res.json({transfers:await getTransfers(String(req.query.customerId||""))});}catch(e){return fail(res,e);}});
transferRouter.get("/:id",async(req,res)=>{try{const transfer=await getTransfer(req.params.id,String(req.query.customerId||""));return transfer?res.json({transfer}):res.status(404).json({error:"Transfer not found."});}catch(e){return fail(res,e);}});
transferRouter.patch("/:id/status",async(req,res)=>{try{const operatorToken=process.env.STABLEX_OPERATOR_TOKEN;if(!operatorToken||req.get("Authorization")!==`Bearer ${operatorToken}`)return res.status(401).json({error:"Unauthorized operator action."});const transfer=await setTransferStatus({id:req.params.id,customerId:String(req.body?.customerId||""),status:req.body?.status,actorId:req.body?.actorId,reason:req.body?.reason});return res.json({message:"State recorded only; no provider or blockchain action was triggered.",transfer});}catch(e){return fail(res,e);}});

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
