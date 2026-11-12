import { getPool } from "../db/pool.js";

export async function savePaytrieCustomerSession({ customerId, encryptedToken, expiresAt }) {
  await getPool().query(
    `INSERT INTO paytrie_customer_sessions(customer_id, encrypted_token, expires_at, updated_at)
     VALUES($1,$2::jsonb,$3,NOW())
     ON CONFLICT(customer_id) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,
       expires_at=EXCLUDED.expires_at, updated_at=NOW()`,
    [customerId, JSON.stringify(encryptedToken), expiresAt]
  );
}

export async function getPaytrieCustomerSession(customerId) {
  const result = await getPool().query(
    `SELECT encrypted_token AS "encryptedToken", expires_at AS "expiresAt"
     FROM paytrie_customer_sessions
     WHERE customer_id=$1 AND expires_at > NOW()`,
    [customerId]
  );
  return result.rows[0] || null;
}

export async function deletePaytrieCustomerSession(customerId) {
  const result = await getPool().query(
    "DELETE FROM paytrie_customer_sessions WHERE customer_id=$1 RETURNING customer_id",
    [customerId]
  );
  return Boolean(result.rowCount);
}
