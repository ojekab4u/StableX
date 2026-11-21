import crypto from "node:crypto";
import { getPool } from "../db/pool.js";
import { postProviderCredit, createWallet } from "./walletService.js";
import { pickClaimForDeposit } from "./fundService.js";
import { verifyFincraWebhookSignature } from "./providers/fincraService.js";

const fail = (message, statusCode = 401) => Object.assign(new Error(message), { statusCode });

function rowToEvent(row) {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    processingStatus: row.processing_status,
    error: row.error_message,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  };
}

// Verifies the signature, stores the event once (idempotent on the provider
// reference), and processes the two event families that matter to us:
//   collection.successful — CAD landing in the Fincra wallet is credited to
//     the matching open claim's CAD wallet.
//   payout.successful / payout.failed — recorded for reconciliation.
export async function receiveFincraWebhook({ rawBody, signature }) {
  if (!verifyFincraWebhookSignature(rawBody, signature)) {
    throw fail("Fincra webhook signature is invalid or missing.");
  }
  let event;
  try { event = JSON.parse(rawBody); } catch { throw fail("Invalid JSON body.", 400); }

  const eventType = String(event?.event || "unknown");
  const data = event?.data || {};
  const eventId = String(data.reference || data._id || crypto.randomUUID());

  const pool = getPool();
  const inserted = await pool.query(
    `INSERT INTO fincra_webhook_events(event_id,event_type,processing_status,payload)
     VALUES($1,$2,'RECEIVED',$3::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, eventType, JSON.stringify(event)]
  );
  if (!inserted.rowCount) {
    const existing = await pool.query("SELECT * FROM fincra_webhook_events WHERE event_id=$1", [eventId]);
    return { duplicate: true, event: rowToEvent(existing.rows[0]) };
  }

  let status = "PROCESSED";
  let error = null;
  try {
    if (eventType === "collection.successful") {
      status = await processCadCollection(data);
    } else if (eventType === "payout.successful" || eventType === "payout.failed") {
      // Payout outcomes are recorded on the event row; the cash-out service
      // reads them by customerReference during reconciliation.
      status = "RECORDED";
    } else {
      status = "IGNORED";
    }
  } catch (processingError) {
    status = "FAILED";
    error = processingError.message;
  }

  const updated = await pool.query(
    `UPDATE fincra_webhook_events
     SET processing_status=$2, error_message=$3, processed_at=NOW()
     WHERE event_id=$1
     RETURNING *`,
    [eventId, status, error]
  );
  return { duplicate: false, event: rowToEvent(updated.rows[0]) };
}

async function processCadCollection(data) {
  const amount = Number(data.sourceAmount ?? data.destinationAmount ?? 0);
  if (!(amount > 0) || String(data.sourceCurrency || "").toUpperCase() !== "CAD") {
    return "IGNORED";
  }

  const open = (await getPool().query(
    "SELECT * FROM fund_claims WHERE state='OPEN' ORDER BY created_at ASC LIMIT 200"
  )).rows.map((row) => ({ ...row, cadAmount: Number(row.cad_amount), createdAt: row.created_at }));

  const claim = pickClaimForDeposit({ amount }, open);
  if (!claim) return "UNMATCHED";

  const locked = await getPool().query(
    `UPDATE fund_claims SET state='MATCHED', metadata = metadata || $2::jsonb, updated_at=NOW()
     WHERE claim_id=$1 AND state='OPEN'
     RETURNING customer_id`,
    [claim.claimId, JSON.stringify({ fincraReference: data.reference, payerName: data.customerName })]
  );
  if (!locked.rowCount) return "UNMATCHED";
  const customerId = locked.rows[0].customer_id;

  const wallets = await getPool().query(
    `SELECT wallet_id FROM wallet_accounts WHERE customer_id=$1 AND asset_code='CAD' AND status='ACTIVE'`,
    [customerId]
  );
  if (!wallets.rowCount) {
    await createWallet({ customerId, currency: "CAD", country: "CA" });
  }

  const credit = await postProviderCredit({
    customerId,
    currency: "CAD",
    amount,
    provider: "FINCRA",
    providerEventId: `fincra:${data.reference}`,
    reference: `Fincra CAD collection ${data.reference}`,
    metadata: { payerName: data.customerName ?? null, description: data.description ?? null, claimId: claim.claimId },
  });
  return credit.credited || credit.duplicate ? "PROCESSED" : "UNMATCHED";
}
