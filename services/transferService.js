import { createHash, randomUUID } from "node:crypto";
import { encryptBeneficiaryDetails,decryptBeneficiaryDetails,fingerprintBeneficiary } from "./beneficiaryCrypto.js";
import { saveBeneficiary,readBeneficiaries,saveTransfer,readTransfer,readTransfers,updateTransferStatus } from "../repositories/transferRepository.js";
import { getCustomerGateStatus } from "./complianceService.js";
const currency=/^[A-Z0-9]{3,12}$/;
function customer(id){if(typeof id!=="string"||!/^[A-Za-z0-9._:-]{2,128}$/.test(id)){const e=new Error("A valid customerId is required.");e.statusCode=400;throw e;}}
export async function createBeneficiary({customerId,details}) {
 customer(customerId);if(!details||typeof details!=="object"||Array.isArray(details)){const e=new Error("Beneficiary details must be an object.");e.statusCode=400;throw e;}
 const fields=["name","country","currency","accountNumber","iban","bankName","bankCode","walletAddress","network","email"],clean={};
 for(const k of fields)if(details[k]!==undefined){if(typeof details[k]!=="string"||!details[k].trim()||details[k].length>200){const e=new Error(`Invalid beneficiary field: ${k}.`);e.statusCode=400;throw e;}clean[k]=details[k].trim();}
 if(!clean.name||!clean.country||!clean.currency||!(clean.accountNumber||clean.iban||clean.walletAddress)){const e=new Error("Provide name, country, currency and accountNumber, IBAN or walletAddress.");e.statusCode=400;throw e;}
 clean.currency=clean.currency.toUpperCase();if(!currency.test(clean.currency)){const e=new Error("Invalid beneficiary currency.");e.statusCode=400;throw e;}
 const record=await saveBeneficiary({id:randomUUID(),customerId,encrypted:encryptBeneficiaryDetails(clean),fingerprint:fingerprintBeneficiary(clean)});
 return {beneficiaryId:record.id,details:decryptBeneficiaryDetails(record.encrypted)};
}
export async function listBeneficiaries(customerId){customer(customerId);return (await readBeneficiaries(customerId)).map(x=>({beneficiaryId:x.id,details:decryptBeneficiaryDetails(x.encrypted),createdAt:x.createdAt}));}
export async function createTransfer({customerId,beneficiaryId,from,to,amount,idempotencyKey}) {
 customer(customerId);const source=String(from||"").trim().toUpperCase(),dest=String(to||"").trim().toUpperCase(),value=Number(amount);
 if(!/^[0-9a-f-]{36}$/i.test(beneficiaryId||"")||!currency.test(source)||!currency.test(dest)||!Number.isFinite(value)||value<=0||value>1000000){const e=new Error("Provide a valid beneficiary, valid currencies and an amount greater than zero (maximum 1,000,000).");e.statusCode=400;throw e;}
 if(typeof idempotencyKey!=="string"||idempotencyKey.length<8||idempotencyKey.length>128){const e=new Error("Send an Idempotency-Key header (8–128 characters).");e.statusCode=400;throw e;}
 const fingerprint=createHash("sha256").update(JSON.stringify({beneficiaryId,from:source,to:dest,amount:value})).digest("hex");
 return saveTransfer({id:randomUUID(),customerId,beneficiaryId,from:source,to:dest,amount:value,key:idempotencyKey,fingerprint});
}
export async function getTransfer(id,customerId){customer(customerId);return readTransfer(id,customerId);}
export async function getTransfers(customerId){customer(customerId);return readTransfers(customerId);}
const GATED_STATUSES=["QUOTED","AWAITING_FUNDING","FUNDED","SETTLEMENT_PENDING","COMPLETED"];
const states=["QUOTED","AWAITING_FUNDING","FUNDED","SETTLEMENT_PENDING","COMPLETED","FAILED","CANCELLED"];
export async function setTransferStatus({id,customerId,status,actorId,reason}) {
 customer(customerId);
 if(GATED_STATUSES.includes(status)){
  const gate=await getCustomerGateStatus(customerId);
  if(!gate.gate.approved){
   const e=new Error(`Compliance gate: transfer lifecycle cannot advance to ${status}. Customer compliance status is ${gate.gate.status}. Submit a compliance case and obtain APPROVED (or operator-approval of a pending case) first. Case/reason: ${gate.gate.caseId||"N/A"}.`);
   e.statusCode=403;
   throw e;
  }
 }
 if(!states.includes(status)){const e=new Error("Unsupported transfer status.");e.statusCode=400;throw e;}
 return updateTransferStatus({id,customerId,status,actorId,reason});
}
