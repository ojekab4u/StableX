import { getPool } from "../db/pool.js";

const SELECT = `SELECT attempt_id AS "attemptId", transfer_id AS "transferId",
  provider, idempotency_key AS "idempotencyKey", status,
  provider_order_id AS "providerOrderId", provider_status AS "providerStatus",
  request_payload AS request, response_payload AS response,
  error_message AS "errorMessage", created_at AS "createdAt",
  updated_at AS "updatedAt"
  FROM provider_order_attempts`;

export async function createProviderOrderAttempt({ attemptId, transferId, customerId, provider, idempotencyKey, request }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const transfer = await client.query(
      "SELECT status FROM transfers WHERE transfer_id=$1 AND customer_id=$2 FOR UPDATE",
      [transferId, customerId]
    );
    if (!transfer.rowCount) {
      const error = new Error("Transfer not found for this customer.");
      error.statusCode = 404;
      throw error;
    }
    const existing = await client.query(
      `${SELECT} WHERE transfer_id=$1 FOR UPDATE`,
      [transferId]
    );
    if (existing.rowCount) {
      await client.query("COMMIT");
      return { attempt: existing.rows[0], replayed: true };
    }
    const inserted = await client.query(
      `INSERT INTO provider_order_attempts
        (attempt_id, transfer_id, provider, idempotency_key, status, request_payload)
       VALUES ($1,$2,$3,$4,'SUBMITTING',$5::jsonb)
       RETURNING attempt_id`,
      [attemptId, transferId, provider, idempotencyKey, JSON.stringify(request)]
    );
    await client.query(
      `INSERT INTO audit_logs(actor_type,actor_id,action,resource_type,resource_id,metadata)
       VALUES('SYSTEM','STABLEX_PROVIDER_ORDER','PROVIDER_ORDER_ATTEMPT_CREATED','TRANSFER',$1,$2::jsonb)`,
      [transferId, JSON.stringify({ attemptId: inserted.rows[0].attempt_id, provider, idempotencyKey })]
    );
    const saved = await client.query(`${SELECT} WHERE attempt_id=$1`, [attemptId]);
    await client.query("COMMIT");
    return { attempt: saved.rows[0], replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateProviderOrderAttempt({ attemptId, status, providerOrderId, providerStatus, response, errorMessage }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE provider_order_attempts
       SET status=$1, provider_order_id=COALESCE($2,provider_order_id),
           provider_status=COALESCE($3,provider_status),
           response_payload=COALESCE($4::jsonb,response_payload),
           error_message=$5, updated_at=NOW()
       WHERE attempt_id=$6
       RETURNING attempt_id`,
      [status, providerOrderId || null, providerStatus || null, response ? JSON.stringify(response) : null, errorMessage || null, attemptId]
    );
    if (!updated.rowCount) {
      const error = new Error("Provider order attempt not found.");
      error.statusCode = 404;
      throw error;
    }
    await client.query(
      `INSERT INTO audit_logs(actor_type,actor_id,action,resource_type,resource_id,metadata)
       VALUES('PROVIDER','PAYTRIE','PROVIDER_ORDER_ATTEMPT_UPDATED','PROVIDER_ORDER_ATTEMPT',$1,$2::jsonb)`,
      [attemptId, JSON.stringify({ status, providerOrderId: providerOrderId || null, providerStatus: providerStatus || null, errorMessage: errorMessage || null })]
    );
    const saved = await client.query(`${SELECT} WHERE attempt_id=$1`, [attemptId]);
    await client.query("COMMIT");
    return saved.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readProviderOrderAttempt({ transferId, customerId }) {
  const result = await getPool().query(
    `${SELECT} a
     JOIN transfers t ON t.transfer_id=a.transfer_id
     WHERE a.transfer_id=$1 AND t.customer_id=$2`,
    [transferId, customerId]
  );
  return result.rows[0] || null;
}
