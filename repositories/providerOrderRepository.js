import { getPool } from "../db/pool.js";
import { randomUUID } from "node:crypto";

const ORDER_SELECT = `
 SELECT order_id AS "orderId", transfer_id AS "transferId",
 customer_id AS "customerId", provider, execution_mode AS "executionMode",
 status, provider_order_reference AS "providerOrderReference",
 quote_snapshot AS "quoteSnapshot", created_at AS "createdAt",
 updated_at AS "updatedAt"
 FROM provider_order_attempts
`;

export async function createSimulatedProviderOrder({ transferId, customerId, idempotencyKey, fingerprint }) {
 const client = await getPool().connect();
 try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [customerId + ":provider-order:" + idempotencyKey]);
  const existing = await client.query(
   "SELECT order_id, request_fingerprint FROM provider_order_attempts WHERE customer_id=$1 AND idempotency_key=$2 FOR UPDATE",
   [customerId, idempotencyKey]
  );
  if (existing.rowCount) {
   if (existing.rows[0].request_fingerprint !== fingerprint) {
    const e = new Error("Idempotency-Key already used with a different provider-order request."); e.statusCode = 409; throw e;
   }
   const found = await client.query(`${ORDER_SELECT} WHERE order_id=$1`, [existing.rows[0].order_id]);
   await client.query("COMMIT");
   return { order: found.rows[0], replayed: true };
  }

  const transferResult = await client.query(
   "SELECT status, quote_data FROM transfers WHERE transfer_id=$1 AND customer_id=$2 FOR UPDATE",
   [transferId, customerId]
  );
  if (!transferResult.rowCount) { const e = new Error("Transfer not found for this customer."); e.statusCode = 404; throw e; }
  const transfer = transferResult.rows[0];
  if (transfer.status !== "QUOTED" || !transfer.quote_data) {
   const e = new Error("A provider order can only be created from a transfer with a selected quote (QUOTED)."); e.statusCode = 409; throw e;
  }
  const quote = transfer.quote_data;
  if (!quote.provider || !quote.quoteId) {
   const e = new Error("The selected quote is missing its provider or quote reference."); e.statusCode = 409; throw e;
  }
  const conflicting = await client.query("SELECT order_id FROM provider_order_attempts WHERE transfer_id=$1", [transferId]);
  if (conflicting.rowCount) { const e = new Error("This transfer already has a provider-order attempt."); e.statusCode = 409; throw e; }

  const orderId = randomUUID();
  const providerOrderReference = "SIM-" + orderId;
  await client.query(
   `INSERT INTO provider_order_attempts
    (order_id,transfer_id,customer_id,provider,execution_mode,status,idempotency_key,request_fingerprint,provider_order_reference,quote_snapshot)
    VALUES($1,$2,$3,$4,'SIMULATED','SIMULATED_ACCEPTED',$5,$6,$7,$8::jsonb)`,
   [orderId, transferId, customerId, quote.provider, idempotencyKey, fingerprint, providerOrderReference, JSON.stringify(quote)]
  );
  await client.query(
   "INSERT INTO provider_order_events(order_id,to_status,actor_id,note) VALUES($1,'SIMULATED_ACCEPTED','STABLEX_SIMULATOR','Synthetic acceptance; no external provider was contacted.')",
   [orderId]
  );
  await client.query(
   `INSERT INTO audit_logs(actor_type,actor_id,action,resource_type,resource_id,metadata)
    VALUES('SYSTEM','STABLEX_SIMULATOR','SIMULATED_PROVIDER_ORDER_CREATED','PROVIDER_ORDER',$1,$2::jsonb)`,
   [orderId, JSON.stringify({ transferId, provider: quote.provider, executionMode: "SIMULATED", quoteId: quote.quoteId })]
  );
  const found = await client.query(`${ORDER_SELECT} WHERE order_id=$1`, [orderId]);
  await client.query("COMMIT");
  return { order: found.rows[0], replayed: false };
 } catch (e) { await client.query("ROLLBACK"); throw e; }
 finally { client.release(); }
}

export async function advanceSimulatedProviderOrder({ orderId, customerId, status, actorId, note }) {
 const transitions = {
  SIMULATED_ACCEPTED: ["SIMULATED_AWAITING_FUNDING"],
  SIMULATED_AWAITING_FUNDING: ["SIMULATED_FUNDED"],
  SIMULATED_FUNDED: ["SIMULATED_SETTLEMENT_PENDING"],
  SIMULATED_SETTLEMENT_PENDING: ["SIMULATED_COMPLETED"],
 };
 const client = await getPool().connect();
 try {
  await client.query("BEGIN");
  const current = await client.query(
   "SELECT status FROM provider_order_attempts WHERE order_id=$1 AND customer_id=$2 FOR UPDATE",
   [orderId, customerId]
  );
  if (!current.rowCount) { const e = new Error("Provider order not found."); e.statusCode = 404; throw e; }
  const previous = current.rows[0].status;
  if (!(transitions[previous] || []).includes(status)) {
   const e = new Error(`Invalid simulated order transition: ${previous} -> ${status}.`); e.statusCode = 409; throw e;
  }
  await client.query(
   "UPDATE provider_order_attempts SET status=$1, updated_at=NOW() WHERE order_id=$2",
   [status, orderId]
  );
  await client.query(
   "INSERT INTO provider_order_events(order_id,from_status,to_status,actor_id,note) VALUES($1,$2,$3,$4,$5)",
   [orderId, previous, status, actorId || "LOCAL_OPERATOR", note || "Operator advanced the simulated provider order."]
  );
  await client.query(
   `INSERT INTO audit_logs(actor_type,actor_id,action,resource_type,resource_id,metadata)
    VALUES('OPERATOR',$1,'SIMULATED_PROVIDER_ORDER_ADVANCED','PROVIDER_ORDER',$2,$3::jsonb)`,
   [actorId || "LOCAL_OPERATOR", orderId, JSON.stringify({ from: previous, to: status, note: note || null, executionMode: "SIMULATED" })]
  );
  const found = await client.query(`${ORDER_SELECT} WHERE order_id=$1`, [orderId]);
  const events = await client.query(
   `SELECT from_status AS "fromStatus",to_status AS "toStatus",actor_id AS "actorId",note,created_at AS "createdAt"
    FROM provider_order_events WHERE order_id=$1 ORDER BY created_at,event_id`,
   [orderId]
  );
  await client.query("COMMIT");
  return { order: found.rows[0], events: events.rows };
 } catch (e) { await client.query("ROLLBACK"); throw e; }
 finally { client.release(); }
}

export async function readSimulatedProviderOrders({ transferId, customerId }) {
 const result = await getPool().query(
  `${ORDER_SELECT} WHERE transfer_id=$1 AND customer_id=$2`,
  [transferId, customerId]
 );
 if (!result.rowCount) return null;
 const events = await getPool().query(
  `SELECT from_status AS "fromStatus",to_status AS "toStatus",actor_id AS "actorId",note,created_at AS "createdAt"
   FROM provider_order_events WHERE order_id=$1 ORDER BY created_at,event_id`,
  [result.rows[0].orderId]
 );
 return { order: result.rows[0], events: events.rows };
}
