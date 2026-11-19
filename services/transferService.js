import { randomUUID } from "node:crypto";
import { getPool } from "../db/pool.js";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

const PROVIDER = "STABLEX_INTERNAL";

// USDC supports 6 decimals.
export function validateTransferRequest({ amount, idempotencyKey, toEmail } = {}) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw fail("A positive amount is required.");
  if (Math.abs(value * 1e6 - Math.round(value * 1e6)) > 1e-6) {
    throw fail("Amount supports up to 6 decimal places.");
  }
  if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.length > 255) {
    throw fail("An idempotencyKey is required.");
  }
  const email = String(toEmail || "").trim().toLowerCase();
  if (!email || email.length > 255 || !email.includes("@")) {
    throw fail("A valid recipient email is required.");
  }
  return { amount: value, idempotencyKey, toEmail: email };
}

// Moves USDC between two StableX customers inside one database transaction:
// the sender is debited and the recipient credited together, or neither.
// Idempotent on (provider, providerEventId) via the transfer idempotencyKey.
export async function transferInternal({ fromCustomerId, toEmail, amount, idempotencyKey } = {}) {
  if (!fromCustomerId || typeof fromCustomerId !== "string") throw fail("customerId is required.");
  const request = validateTransferRequest({ amount, idempotencyKey, toEmail });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT entry_id AS "entryId" FROM wallet_ledger
       WHERE provider=$1 AND provider_event_id=$2`,
      [PROVIDER, `${request.idempotencyKey}:out`]
    );
    if (existing.rowCount) {
      await client.query("COMMIT");
      return { duplicate: true, amount: request.amount };
    }

    const recipient = await client.query(
      `SELECT account_id AS "accountId", full_name AS "fullName", status
       FROM accounts WHERE email=$1`,
      [request.toEmail]
    );
    if (!recipient.rowCount) throw fail(`No StableX account for ${request.toEmail}.`, 404);
    if (recipient.rows[0].status !== "ACTIVE") {
      throw fail(`The account for ${request.toEmail} is not active.`, 409);
    }
    const toCustomerId = recipient.rows[0].accountId;
    if (toCustomerId === fromCustomerId) throw fail("You cannot transfer to your own account.");

    const senderWallet = await client.query(
      `SELECT wallet_id, COALESCE((
         SELECT SUM(amount) FROM wallet_ledger
         WHERE wallet_id=w.wallet_id AND status='POSTED'
       ),0) AS balance
       FROM wallet_accounts w
       WHERE customer_id=$1 AND asset_code='USDC' AND status='ACTIVE'
       FOR UPDATE`,
      [fromCustomerId]
    );
    if (!senderWallet.rowCount) throw fail("You have no active USDC wallet.", 404);
    if (Number(senderWallet.rows[0].balance) < request.amount) {
      throw fail("Insufficient USDC balance for this transfer.", 409);
    }

    const recipientWallet = await client.query(
      `SELECT wallet_id FROM wallet_accounts
       WHERE customer_id=$1 AND asset_code='USDC' AND status='ACTIVE'`,
      [toCustomerId]
    );
    if (!recipientWallet.rowCount) {
      throw fail(`${recipient.rows[0].fullName} has no USDC wallet yet.`, 404);
    }

    const transferId = randomUUID();
    await client.query(
      `INSERT INTO wallet_ledger(entry_id,wallet_id,customer_id,asset_code,entry_type,amount,reference,provider,provider_event_id,metadata)
       VALUES($1,$2,$3,'USDC','WITHDRAWAL',$4,$5,$6,$7,$8::jsonb)`,
      [randomUUID(), senderWallet.rows[0].wallet_id, fromCustomerId, -request.amount,
       `Transfer to ${request.toEmail} (${transferId})`, PROVIDER,
       `${request.idempotencyKey}:out`, JSON.stringify({ transferId, toCustomerId })]
    );
    await client.query(
      `INSERT INTO wallet_ledger(entry_id,wallet_id,customer_id,asset_code,entry_type,amount,reference,provider,provider_event_id,metadata)
       VALUES($1,$2,$3,'USDC','DEPOSIT',$4,$5,$6,$7,$8::jsonb)`,
      [randomUUID(), recipientWallet.rows[0].wallet_id, toCustomerId, request.amount,
       `Transfer from ${request.toEmail} (${transferId})`, PROVIDER,
       `${request.idempotencyKey}:in`, JSON.stringify({ transferId, fromCustomerId })]
    );

    const balance = await client.query(
      `SELECT COALESCE(SUM(amount),0)::text AS balance FROM wallet_ledger
       WHERE wallet_id=$1 AND status='POSTED'`,
      [senderWallet.rows[0].wallet_id]
    );
    await client.query("COMMIT");
    return {
      duplicate: false,
      transferId,
      amount: request.amount,
      currency: "USDC",
      to: { customerId: toCustomerId, email: request.toEmail, name: recipient.rows[0].fullName },
      fromBalance: Number(balance.rows[0].balance),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    // A concurrent retry of the same idempotencyKey lands on the unique
    // (provider, provider_event_id) index.
    if (error.code === "23505" && error.constraint && String(error.constraint).includes("wallet_ledger")) {
      return { duplicate: true, amount: request.amount };
    }
    throw error;
  } finally {
    client.release();
  }
}

// The customer's transfer history, derived from the ledger.
export async function listTransfers(customerId) {
  const result = await getPool().query(
    `SELECT entry_id AS "entryId", amount::text AS amount, reference, created_at AS "createdAt", metadata
     FROM wallet_ledger
     WHERE customer_id=$1 AND provider=$2 AND asset_code='USDC'
     ORDER BY created_at DESC LIMIT 50`,
    [customerId, PROVIDER]
  );
  return result.rows.map((row) => ({
    ...row,
    amount: Number(row.amount),
    direction: Number(row.amount) > 0 ? "IN" : "OUT",
  }));
}
