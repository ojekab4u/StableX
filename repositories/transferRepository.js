import { getPool } from "../db/pool.js";
const SELECT=`SELECT transfer_id AS "transferId",customer_id AS "customerId",beneficiary_id AS "beneficiaryId",
source_currency AS "sourceCurrency",source_amount AS "sourceAmount",destination_currency AS "destinationCurrency",
destination_amount AS "destinationAmount",status,quote_data AS quote,failure_reason AS "failureReason",version,
created_at AS "createdAt",updated_at AS "updatedAt" FROM transfers`;
export async function saveBeneficiary({id,customerId,encrypted,fingerprint}) {
 const r=await getPool().query(`INSERT INTO beneficiaries(beneficiary_id,customer_id,encrypted_details,details_fingerprint)
 VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(customer_id,details_fingerprint) DO UPDATE SET updated_at=NOW()
 RETURNING beneficiary_id AS id,encrypted_details AS encrypted`,[id,customerId,JSON.stringify(encrypted),fingerprint]);
 return r.rows[0];
}
export async function readBeneficiaries(customerId) {
 const r=await getPool().query(`SELECT beneficiary_id AS id,encrypted_details AS encrypted,created_at AS "createdAt"
 FROM beneficiaries WHERE customer_id=$1 ORDER BY created_at DESC`,[customerId]); return r.rows;
}
export async function saveTransfer({id,customerId,beneficiaryId,from,to,amount,key,fingerprint}) {
 const c=await getPool().connect();
 try {
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [customerId + ":" + key]);
  const old=await c.query("SELECT transfer_id,request_fingerprint FROM transfers WHERE customer_id=$1 AND idempotency_key=$2 FOR UPDATE",[customerId,key]);
  if(old.rowCount) {
   if(old.rows[0].request_fingerprint!==fingerprint){const e=new Error("Idempotency-Key already used with a different request.");e.statusCode=409;throw e;}
   const found=await c.query(`${SELECT} WHERE transfer_id=$1`,[old.rows[0].transfer_id]); await c.query("COMMIT"); return {transfer:found.rows[0],replayed:true};
  }
  const owned=await c.query("SELECT 1 FROM beneficiaries WHERE beneficiary_id=$1 AND customer_id=$2",[beneficiaryId,customerId]);
  if(!owned.rowCount){const e=new Error("Beneficiary not found for this customer.");e.statusCode=404;throw e;}
  await c.query(`INSERT INTO transfers(transfer_id,customer_id,beneficiary_id,source_currency,source_amount,destination_currency,status,idempotency_key,request_fingerprint)
  VALUES($1,$2,$3,$4,$5,$6,'DRAFT',$7,$8)`,[id,customerId,beneficiaryId,from,amount,to,key,fingerprint]);
  await c.query(`INSERT INTO transfer_events(transfer_id,to_status,actor_type,actor_id) VALUES($1,'DRAFT','CUSTOMER',$2)`,[id,customerId]);
  await c.query(`INSERT INTO audit_logs(actor_type,actor_id,action,resource_type,resource_id,metadata)
  VALUES('CUSTOMER',$1,'TRANSFER_CREATED','TRANSFER',$2,$3::jsonb)`,[customerId,id,JSON.stringify({from,to,amount})]);
  const found=await c.query(`${SELECT} WHERE transfer_id=$1`,[id]); await c.query("COMMIT"); return {transfer:found.rows[0],replayed:false};
 } catch(e){await c.query("ROLLBACK");throw e;} finally{c.release();}
}
export async function readTransfer(id,customerId){const r=await getPool().query(`${SELECT} WHERE transfer_id=$1 AND customer_id=$2`,[id,customerId]);return r.rows[0]||null;}
export async function readTransfers(customerId){const r=await getPool().query(`${SELECT} WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[customerId]);return r.rows;}
export async function updateTransferStatus({id,customerId,status,actorId,reason}) {
 const allowed={DRAFT:["QUOTED","CANCELLED"],QUOTED:["AWAITING_FUNDING","CANCELLED","FAILED"],AWAITING_FUNDING:["FUNDED","CANCELLED","FAILED"],FUNDED:["SETTLEMENT_PENDING","FAILED"],SETTLEMENT_PENDING:["COMPLETED","FAILED"]};
 const c=await getPool().connect();
 try {
  await c.query("BEGIN"); const old=await c.query("SELECT status FROM transfers WHERE transfer_id=$1 AND customer_id=$2 FOR UPDATE",[id,customerId]);
  if(!old.rowCount){const e=new Error("Transfer not found.");e.statusCode=404;throw e;}
  const previous=old.rows[0].status;
  if(!(allowed[previous]||[]).includes(status)){const e=new Error(`Invalid transfer transition: ${previous} -> ${status}.`);e.statusCode=409;throw e;}
  const r=await c.query(`UPDATE transfers SET status=$1,failure_reason=$2,version=version+1,updated_at=NOW()
  WHERE transfer_id=$3 RETURNING transfer_id AS "transferId",status,version,updated_at AS "updatedAt"`,
  [status,status==="FAILED"?(reason||"Unspecified failure"):null,id]);
  await c.query(`INSERT INTO transfer_events(transfer_id,from_status,to_status,actor_type,actor_id,reason)
  VALUES($1,$2,$3,'OPERATOR',$4,$5)`,[id,previous,status,actorId||"LOCAL_OPERATOR",reason||null]);
  await c.query(`INSERT INTO audit_logs(actor_type,actor_id,action,resource_type,resource_id,metadata)
  VALUES('OPERATOR',$1,'TRANSFER_STATUS_CHANGED','TRANSFER',$2,$3::jsonb)`,[actorId||"LOCAL_OPERATOR",id,JSON.stringify({from:previous,to:status,reason:reason||null})]);
  await c.query("COMMIT");return r.rows[0];
 }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}
