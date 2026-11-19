import { randomUUID } from "node:crypto";
import { getPool } from "../db/pool.js";
import { postProviderCredit } from "./walletService.js";
import { getCustomerGateStatus } from "./complianceService.js";
import { getNdaxRate, sendNdaxOrder, getNdaxOrderStatus, listNdaxDeposits } from "./providers/ndaxService.js";
import { NDAX_FEES } from "../config/fees.js";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export const CREDIT_ASSET = "USDC";
const CREDIT_PROVIDER = "STABLEX";

// CAD supports 2 decimals.
export function validateFundRequest({ cadAmount, idempotencyKey, customerId } = {}) {
  if (!customerId || typeof customerId !== "string") throw fail("customerId is required.");
  const value = Number(cadAmount);
  if (!Number.isFinite(value) || value <= 0) throw fail("A positive CAD amount is required.");
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    throw fail("CAD amount supports up to 2 decimal places.");
  }
  if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.length > 255) {
    throw fail("An idempotencyKey is required.");
  }
  return { customerId, cadAmount: value, idempotencyKey };
}

function rowToFunding(row) {
  return {
    fundingId: row.funding_id,
    customerId: row.customer_id,
    currency: row.currency,
    cadAmount: Number(row.cad_amount),
    creditedAmount: row.credited_amount === null ? null : Number(row.credited_amount),
    state: row.state,
    orderId: row.order_id,
    orderStatus: row.order_status,
    depositReference: row.deposit_reference,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertFunding({ customerId, fundingId, cadAmount, depositReference, idempotencyKey }) {
  const result = await getPool().query(
    `INSERT INTO wallet_fundings(funding_id,customer_id,currency,cad_amount,state,deposit_reference,idempotency_key)
     VALUES($1,$2,$3,$4,'NEW',$5,$6)
     ON CONFLICT (customer_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [fundingId, customerId, CREDIT_ASSET, cadAmount, depositReference || null, idempotencyKey]
  );
  if (!result.rowCount) {
    const existing = await getPool().query(
      "SELECT * FROM wallet_fundings WHERE customer_id=$1 AND idempotency_key=$2",
      [customerId, idempotencyKey]
    );
    return { funding: rowToFunding(existing.rows[0]), duplicate: true };
  }
  return { funding: rowToFunding(result.rows[0]), duplicate: false };
}

async function updateFunding(fundingId, fields) {
  const sets = ["updated_at=NOW()"];
  const params = [];
  let i = 1;
  for (const key of ["state", "order_id", "order_status", "credited_amount", "error"]) {
    if (key in fields) {
      sets.push(`${key}=$${i}`);
      params.push(fields[key]);
      i += 1;
    }
  }
  params.push(fundingId);
  await getPool().query(`UPDATE wallet_fundings SET ${sets.join(", ")} WHERE funding_id=$${i}`, params);
}

export async function getFunding(fundingId) {
  const result = await getPool().query("SELECT * FROM wallet_fundings WHERE funding_id=$1", [fundingId]);
  return result.rowCount ? rowToFunding(result.rows[0]) : null;
}

export async function listFundings(customerId) {
  const result = await getPool().query(
    "SELECT * FROM wallet_fundings WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100",
    [customerId]
  );
  return result.rows.map(rowToFunding);
}

export async function listAllFundings({ state } = {}) {
  const params = [];
  let filter = "";
  if (state) {
    params.push(String(state).toUpperCase());
    filter = " WHERE state=$1";
  }
  const result = await getPool().query(
    `SELECT * FROM wallet_fundings${filter} ORDER BY created_at DESC LIMIT 200`,
    params
  );
  return result.rows.map(rowToFunding);
}

// Round down to the USDC trade increment (0.001) without float drift.
function toUsdcIncrement(value) {
  return Math.floor(Number(value) / 0.001 + 1e-9) * 0.001;
}

// Credits the customer's wallet with the quantity Ndax actually executed.
// Idempotent on (provider, providerEventId) so re-checking a fill never
// double-credits.
async function creditFilledOrder(funding, status) {
  if (!Number.isFinite(status.quantityExecuted) || status.quantityExecuted <= 0) {
    return { credited: false, reason: "nothing executed yet" };
  }
  // The customer receives the fill net of the trading fee (Ndax takes it in
  // USDC on buys); the fee amount stays with the company in the ledger gap.
  const netUsdc = status.quantityExecuted * (1 - NDAX_FEES.tradingRate);
  const credit = await postProviderCredit({
    customerId: funding.customerId,
    currency: CREDIT_ASSET,
    amount: netUsdc,
    provider: CREDIT_PROVIDER,
    providerEventId: `ndaxfund:${funding.orderId}`,
    reference: `Ndax CAD funding ${funding.fundingId}`,
    metadata: {
      fundingId: funding.fundingId,
      orderId: funding.orderId,
      averagePrice: status.averagePrice,
      grossExecuted: status.quantityExecuted,
      tradeFeeUsdc: status.quantityExecuted * NDAX_FEES.tradingRate,
    },
  });
  await updateFunding(funding.fundingId, { state: "CREDITED", credited_amount: netUsdc, order_status: status.state });
  return { credited: credit.credited, duplicate: credit.duplicate, balance: credit.balance, usdcCredited: netUsdc };
}

async function pollFill(orderId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const status = await getNdaxOrderStatus(orderId);
    const state = String(status.state || "").toUpperCase();
    if (state === "FULLYEXECUTED") return { status, filled: true };
    if (state === "REJECTED" || state === "CANCELLED") return { status, filled: false, terminal: true };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { status: await getNdaxOrderStatus(orderId), filled: false };
}

// Direction B, steps 2-3: convert CAD sitting on Ndax into USDC, then credit
// the customer's wallet with what actually filled. The CAD must already be on
// Ndax (Interac deposit, arranged in the Ndax dashboard).
export async function fundWalletFromNdax({ customerId, cadAmount, depositReference, idempotencyKey } = {}) {
  const request = validateFundRequest({ customerId, cadAmount, idempotencyKey });

  const gate = await getCustomerGateStatus(request.customerId);
  if (!gate.gate.approved) throw fail("Complete and pass identity verification before funding a wallet.", 403);

  const fundingId = randomUUID();
  const { funding, duplicate } = await insertFunding({
    customerId: request.customerId,
    fundingId,
    cadAmount: request.cadAmount,
    depositReference,
    idempotencyKey: request.idempotencyKey,
  });
  if (duplicate) return { duplicate: true, funding };

  // Depth-walked indicative quote; non-binding but prevents ordering more
  // USDC than the CAD can buy.
  const rate = await getNdaxRate({ from: "CAD", to: "USDC", amount: request.cadAmount });
  const estimatedUsdc = Number(rate.estimatedDestinationAmount);
  if (!Number.isFinite(estimatedUsdc) || estimatedUsdc < 1) {
    const error = fail(`CAD ${request.cadAmount} buys less than the Ndax minimum of 1 USDC.`, 400);
    await updateFunding(fundingId, { state: "ORDER_FAILED", error: error.message });
    throw error;
  }
  const quantity = toUsdcIncrement(estimatedUsdc);

  let order;
  try {
    order = await sendNdaxOrder({ side: "BUY", quantity });
  } catch (error) {
    await updateFunding(fundingId, { state: "ORDER_FAILED", error: error.message });
    throw error;
  }
  await updateFunding(fundingId, { state: "PLACED", order_id: order.orderId, order_status: order.status });

  const fill = await pollFill(order.orderId);
  const fundingNow = await getFunding(fundingId);
  if (fill.filled) {
    const credit = await creditFilledOrder(fundingNow, fill.status);
    return { duplicate: false, funding: await getFunding(fundingId), order, ...credit };
  }
  await updateFunding(fundingId, {
    state: fill.terminal ? "ORDER_FAILED" : "FILL_PENDING",
    order_status: fill.status.state,
  });
  return { duplicate: false, funding: await getFunding(fundingId), order, filled: false };
}

// Re-checks a funding whose order did not fill within the first few seconds,
// then credits on a fill. Safe to call repeatedly.
export async function checkFunding(fundingId) {  if (!fundingId) throw fail("A fundingId is required.");
  const funding = await getFunding(fundingId);
  if (!funding) throw fail(`No funding ${fundingId}.`, 404);
  if (funding.state === "CREDITED") {
    return { funding, credited: true, duplicate: true };
  }
  if (!funding.orderId) throw fail("This funding has no Ndax order yet.");

  const status = await getNdaxOrderStatus(funding.orderId);
  const state = String(status.state || "").toUpperCase();
  await updateFunding(fundingId, { order_status: state });
  if (state === "REJECTED" || state === "CANCELLED") {
    await updateFunding(fundingId, { state: "ORDER_FAILED", error: `Ndax order ${state.toLowerCase()}` });
    return { funding: await getFunding(fundingId), credited: false };
  }
  if (state !== "FULLYEXECUTED") {
    await updateFunding(fundingId, { state: "FILL_PENDING" });
    return { funding: await getFunding(fundingId), credited: false, orderState: state };
  }
  const credit = await creditFilledOrder({ ...funding, orderId: funding.orderId }, status);
  return { funding: await getFunding(fundingId), ...credit };
}

// ------------------------------------------------------- self-serve claims

// Pure matcher: the best open claim for a deposit, or null. Claims whose
// amount differs by more than the tolerance never match. Ambiguous ties go
// to the oldest claim.
export function pickClaimForDeposit(deposit, claims, tolerance = 0.02) {
  const candidates = claims
    .filter((c) => c.state === "OPEN")
    .map((c) => ({ claim: c, diff: Math.abs(Number(c.cadAmount) - Number(deposit.amount)) }))
    .filter((x) => x.diff <= tolerance)
    .sort((a, b) => a.diff - b.diff || new Date(a.claim.createdAt) - new Date(b.claim.createdAt));
  return candidates.length ? candidates[0].claim : null;
}

function rowToClaim(row) {
  return {
    claimId: row.claim_id,
    customerId: row.customer_id,
    cadAmount: Number(row.cad_amount),
    reference: row.reference,
    state: row.state,
    matchedDepositId: row.matched_deposit_id,
    error: row.metadata?.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// The customer tells us CAD is on the way (or already sent). The claim is
// matched automatically when a Ndax CAD deposit of that size appears.
export async function createFundClaim({ customerId, cadAmount, reference, idempotencyKey } = {}) {
  if (!customerId || typeof customerId !== "string") throw fail("customerId is required.");
  const value = Number(cadAmount);
  if (!Number.isFinite(value) || value <= 0) throw fail("A positive CAD amount is required.");
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) throw fail("CAD amount supports up to 2 decimal places.");
  if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.length > 255) {
    throw fail("An idempotencyKey is required.");
  }

  const gate = await getCustomerGateStatus(customerId);
  if (!gate.gate.approved) throw fail("Complete and pass identity verification before funding a wallet.", 403);

  const claimId = randomUUID();
  const result = await getPool().query(
    `INSERT INTO fund_claims(claim_id,customer_id,cad_amount,reference,state,idempotency_key)
     VALUES($1,$2,$3,$4,'OPEN',$5)
     ON CONFLICT (customer_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [claimId, customerId, value, reference ? String(reference).slice(0, 255) : null, idempotencyKey]
  );
  if (!result.rowCount) {
    const existing = await getPool().query(
      "SELECT * FROM fund_claims WHERE customer_id=$1 AND idempotency_key=$2",
      [customerId, idempotencyKey]
    );
    return { duplicate: true, claim: rowToClaim(existing.rows[0]) };
  }
  return { duplicate: false, claim: rowToClaim(result.rows[0]) };
}

export async function listFundClaims(customerId) {
  const result = await getPool().query(
    "SELECT * FROM fund_claims WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50",
    [customerId]
  );
  return result.rows.map(rowToClaim);
}

// Scans Ndax CAD deposits, matches them against open claims, and funds the
// wallets through the normal buy path. Each deposit funds at most one claim;
// the state guard on the UPDATE keeps two scans from claiming the same pair.
export async function matchDepositsToClaims() {
  const deposits = (await listNdaxDeposits()).filter(
    (d) => d.currency === "CAD" && Number(d.amount) > 0 && String(d.status) === "FullyProcessed" && d.depositId
  );

  const used = await getPool().query(
    `SELECT matched_deposit_id FROM fund_claims
     WHERE matched_deposit_id IS NOT NULL AND state='MATCHED'`
  );
  const usedIds = new Set(used.rows.map((r) => Number(r.matched_deposit_id)));

  const open = (await getPool().query(
    "SELECT * FROM fund_claims WHERE state='OPEN' ORDER BY created_at ASC LIMIT 200"
  )).rows.map(rowToClaim);

  const matched = [];
  const unmatched = [];
  for (const deposit of deposits) {
    if (usedIds.has(Number(deposit.depositId))) continue;
    const claim = pickClaimForDeposit(deposit, open);
    if (!claim) {
      unmatched.push(deposit);
      continue;
    }

    const locked = await getPool().query(
      `UPDATE fund_claims SET state='MATCHED', matched_deposit_id=$2, updated_at=NOW()
       WHERE claim_id=$1 AND state='OPEN'
       RETURNING customer_id`,
      [claim.claimId, deposit.depositId]
    );
    if (!locked.rowCount) continue; // another scan matched it first

    try {
      const funding = await fundWalletFromNdax({
        customerId: locked.rows[0].customer_id,
        cadAmount: Number(deposit.amount),
        depositReference: `Ndax deposit ${deposit.depositId}`,
        idempotencyKey: `deposit:${deposit.depositId}`,
      });
      matched.push({ claim: claim.claimId, depositId: deposit.depositId, funding });
    } catch (error) {
      // Give the claim back so a later scan can retry; record why it failed.
      await getPool().query(
        `UPDATE fund_claims SET state='OPEN', matched_deposit_id=NULL,
         metadata = metadata || $2::jsonb, updated_at=NOW() WHERE claim_id=$1`,
        [claim.claimId, JSON.stringify({ error: error.message })]
      );
      unmatched.push({ depositId: deposit.depositId, error: error.message });
    }
  }
  return { scanned: deposits.length, matched, unmatched };
}
