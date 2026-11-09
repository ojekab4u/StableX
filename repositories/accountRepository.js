import { randomUUID } from "node:crypto";
import { getPool } from "../db/pool.js";

const ACCOUNT_SELECT = `SELECT account_id AS "accountId", email, phone,
  password_hash AS "passwordHash",
  account_type AS "accountType", full_name AS "fullName", business_name AS "businessName",
  country, date_of_birth AS "dateOfBirth",
  email_verified AS "emailVerified", phone_verified AS "phoneVerified", status,
  created_at AS "createdAt", updated_at AS "updatedAt" FROM accounts`;

export async function insertAccount({ id, email, phone, passwordHash, accountType, fullName, businessName, country, dateOfBirth }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO accounts(account_id, email, phone, password_hash, account_type, full_name, business_name, country, date_of_birth)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING account_id AS "accountId"`,
      [id, email, phone, passwordHash, accountType, fullName, businessName || null, country || null, dateOfBirth || null]
    );
    await client.query(
      `INSERT INTO audit_logs(actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES('CUSTOMER',$1,'ACCOUNT_REGISTERED','ACCOUNT',$2,$3::jsonb)`,
      [id, id, JSON.stringify({ email, accountType, country, hasPhone: Boolean(phone) })]
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      const conflict = new Error("An account with this email already exists.");
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function findAccountByEmail(email) {
  const result = await getPool().query(`${ACCOUNT_SELECT} WHERE email=$1`, [email]);
  return result.rows[0] || null;
}

export async function findAccountById(accountId) {
  const result = await getPool().query(`${ACCOUNT_SELECT} WHERE account_id=$1`, [accountId]);
  return result.rows[0] || null;
}

export async function markChannelVerified({ accountId, channel }) {
  const column = channel === "EMAIL" ? "email_verified" : "phone_verified";
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE accounts SET ${column}=TRUE, updated_at=NOW()
       WHERE account_id=$1
       RETURNING account_id AS "accountId", email_verified AS "emailVerified",
         phone_verified AS "phoneVerified", phone, account_type AS "accountType", status`,
      [accountId]
    );
    if (!updated.rowCount) {
      await client.query("ROLLBACK");
      return null;
    }
    // An account becomes ACTIVE once every provided contact channel is verified.
    const row = updated.rows[0];
    const phoneProvided = Boolean(row.phone);
    const fullyVerified = row.emailVerified && (!phoneProvided || row.phoneVerified);
    const finalStatus = fullyVerified ? "ACTIVE" : row.status;
    await client.query(`UPDATE accounts SET status=$1, updated_at=NOW() WHERE account_id=$2`, [finalStatus, accountId]);
    await client.query(
      `INSERT INTO audit_logs(actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES('CUSTOMER',$1,'ACCOUNT_VERIFIED','ACCOUNT',$2,$3::jsonb)`,
      [accountId, accountId, JSON.stringify({ channel, status: finalStatus })]
    );
    await client.query("COMMIT");
    return { ...row, status: finalStatus };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Replaces any outstanding code for the channel, so only the newest code works.
export async function saveVerificationCode({ accountId, channel, codeHash, expiresAt }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE verification_codes SET consumed_at=NOW()
       WHERE account_id=$1 AND channel=$2 AND consumed_at IS NULL`,
      [accountId, channel]
    );
    const codeId = randomUUID();
    await client.query(
      `INSERT INTO verification_codes(code_id, account_id, channel, code_hash, expires_at)
       VALUES($1,$2,$3,$4,$5)`,
      [codeId, accountId, channel, codeHash, expiresAt]
    );
    await client.query("COMMIT");
    return codeId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function findLiveVerificationCode({ accountId, channel }) {
  const result = await getPool().query(
    `SELECT code_id AS "codeId", code_hash AS "codeHash", attempts, expires_at AS "expiresAt"
     FROM verification_codes
     WHERE account_id=$1 AND channel=$2 AND consumed_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [accountId, channel]
  );
  return result.rows[0] || null;
}

export async function consumeVerificationCode(codeId) {
  const result = await getPool().query(
    `UPDATE verification_codes SET consumed_at=NOW()
     WHERE code_id=$1 AND consumed_at IS NULL AND expires_at > NOW()
     RETURNING code_id`,
    [codeId]
  );
  return Boolean(result.rowCount);
}

// Counts a wrong-code entry. After MAX_CODE_ATTEMPTS failed attempts the code
// is consumed (locked) and can no longer be used.
export const MAX_CODE_ATTEMPTS = 5;

export async function registerFailedCodeAttempt(codeId) {
  const result = await getPool().query(
    `UPDATE verification_codes
     SET attempts=attempts+1,
         consumed_at=CASE WHEN attempts+1 >= $2 THEN NOW() ELSE consumed_at END
     WHERE code_id=$1 AND consumed_at IS NULL
     RETURNING consumed_at`,
    [codeId, MAX_CODE_ATTEMPTS]
  );
  if (!result.rowCount) return { allowed: false };
  return { allowed: result.rows[0].consumed_at === null };
}

export async function saveSession({ accountId, tokenHash, expiresAt }) {
  const sessionId = randomUUID();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO auth_sessions(session_id, account_id, token_hash, expires_at)
       VALUES($1,$2,$3,$4)`,
      [sessionId, accountId, tokenHash, expiresAt]
    );
    await client.query(
      `INSERT INTO audit_logs(actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES('CUSTOMER',$1,'ACCOUNT_LOGIN','ACCOUNT',$2,$3::jsonb)`,
      [accountId, accountId, JSON.stringify({ sessionId })]
    );
    await client.query("COMMIT");
    return sessionId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function findLiveSessionByToken(tokenHash) {
  const result = await getPool().query(
    `SELECT s.session_id AS "sessionId", s.expires_at AS "sessionExpiresAt",
            a.account_id AS "accountId", a.email, a.phone,
            a.account_type AS "accountType", a.full_name AS "fullName", a.business_name AS "businessName",
            a.country, a.date_of_birth AS "dateOfBirth",
            a.email_verified AS "emailVerified", a.phone_verified AS "phoneVerified",
            a.status, a.created_at AS "createdAt", a.updated_at AS "updatedAt"
     FROM auth_sessions s
     JOIN accounts a ON a.account_id = s.account_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

export async function revokeSession(sessionId) {
  const result = await getPool().query(
    `UPDATE auth_sessions SET revoked_at=NOW()
     WHERE session_id=$1 AND revoked_at IS NULL
     RETURNING session_id`,
    [sessionId]
  );
  return Boolean(result.rowCount);
}
