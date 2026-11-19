import { randomUUID } from "node:crypto";
import { getPool } from "../db/pool.js";
import { postWalletDebit, postWalletReversal } from "./walletService.js";
import { getCustomerGateStatus } from "./complianceService.js";
import { sendNdaxOrder, getNdaxOrderStatus } from "./providers/ndaxService.js";
import { cashOutPayout } from "../config/fees.js";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export const CASH_OUT_ASSET = "USDC";
const DEBIT_PROVIDER = "STABLEX";

// Customer amount must land exactly on the Ndax trade increment for
// USDC/CAD (0.001), so the debited amount and the sold quantity always match.
export function validateCashOutRequest({ amount, idempotencyKey } = {}) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw fail("A positive amount is required.");
  if (Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-6) {
    throw fail("Amount supports up to 3 decimal places.");
  }
  if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.length > 255) {
    throw fail("An idempotencyKey is required.");
  }
  return { amount: value, idempotencyKey };
}

function rowToCashOut(row) {
  return {
    cashOutId: row.cash_out_id,
    customerId: row.customer_id,
    currency: row.currency,
    amount: Number(row.amount),
    state: row.state,
    ledgerEntryId: row.ledger_entry_id,
    reversalEntryId: row.reversal_entry_id,
    orderId: row.order_id,
    orderStatus: row.order_status,
    bankDetails: row.bank_details || null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// The Ndax EFT/Interac payout template fields, collected from the customer
// at request time so the operator never types them.
export function validateBankDetails(bank) {
  const fields = {
    FullName: bank?.holder,
    BankAccountName: bank?.bankName,
    BankAccountNumber: bank?.accountNumber,
    BankAddress: bank?.address,
    SwiftCode: bank?.swift,
  };
  const missing = Object.entries(fields).filter(([, v]) => !v || !String(v).trim()).map(([k]) => k);
  if (missing.length) throw fail(`Missing bank details: ${missing.join(", ")}.`);
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v).trim().slice(0, 140)]));
}

async function insertCashOut({ customerId, cashOutId, amount, idempotencyKey, bankDetails }) {
  const result = await getPool().query(
    `INSERT INTO cash_outs(cash_out_id,customer_id,currency,amount,state,idempotency_key,bank_details)
     VALUES($1,$2,$3,$4,'DEBITING',$5,$6::jsonb)
     ON CONFLICT (customer_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [cashOutId, customerId, CASH_OUT_ASSET, amount, idempotencyKey, JSON.stringify(bankDetails || null)]
  );
  if (!result.rowCount) {
    const existing = await getPool().query(
      "SELECT * FROM cash_outs WHERE customer_id=$1 AND idempotency_key=$2",
      [customerId, idempotencyKey]
    );
    return { cashOut: rowToCashOut(existing.rows[0]), duplicate: true };
  }
  return { cashOut: rowToCashOut(result.rows[0]), duplicate: false };
}

async function updateCashOut(cashOutId, fields) {
  const sets = ["state=$2", "updated_at=NOW()"];
  const params = [cashOutId, fields.state];
  let i = 3;
  for (const key of ["ledger_entry_id", "reversal_entry_id", "order_id", "order_status", "error"]) {
    if (key in fields) {
      sets.push(`${key}=$${i}`);
      params.push(fields[key]);
      i += 1;
    }
  }
  await getPool().query(`UPDATE cash_outs SET ${sets.join(", ")} WHERE cash_out_id=$1`, params);
}

export async function getCashOut(cashOutId) {
  const result = await getPool().query("SELECT * FROM cash_outs WHERE cash_out_id=$1", [cashOutId]);
  return result.rowCount ? rowToCashOut(result.rows[0]) : null;
}

export async function listCashOuts(customerId) {
  const result = await getPool().query(
    "SELECT * FROM cash_outs WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100",
    [customerId]
  );
  return result.rows.map(rowToCashOut);
}

export async function listAllCashOuts({ state } = {}) {
  const params = [];
  let filter = "";
  if (state) {
    params.push(String(state).toUpperCase());
    filter = " WHERE state=$1";
  }
  const result = await getPool().query(
    `SELECT * FROM cash_outs${filter} ORDER BY created_at DESC LIMIT 200`,
    params
  );
  return result.rows.map(rowToCashOut);
}

// Direction A, steps 3-4: debit the customer wallet, then sell USDC on Ndax.
// If Ndax rejects the sell, the debit is reversed so the customer is not left
// holding a debit with nothing to show. A Ndax order that was accepted but
// later cancelled unfilled is reconciled by the operator; this function only
// reverses on a rejected or failed send.
export async function requestCashOut({ customerId, amount, idempotencyKey, bank } = {}) {
  if (!customerId || typeof customerId !== "string") throw fail("customerId is required.");
  const request = validateCashOutRequest({ amount, idempotencyKey });
  const bankDetails = validateBankDetails(bank);

  const gate = await getCustomerGateStatus(customerId);
  if (!gate.gate.approved) throw fail("Complete and pass identity verification before cashing out.", 403);

  const cashOutId = randomUUID();
  const { cashOut, duplicate } = await insertCashOut({ customerId, cashOutId, amount: request.amount, idempotencyKey: request.idempotencyKey, bankDetails });
  if (duplicate) return { duplicate: true, cashOut };

  let debit;
  try {
    debit = await postWalletDebit({
      customerId,
      currency: CASH_OUT_ASSET,
      amount: request.amount,
      provider: DEBIT_PROVIDER,
      providerEventId: `cashout:${cashOutId}`,
      reference: `Cash out ${cashOutId}`,
      metadata: { cashOutId },
    });
  } catch (error) {
    await updateCashOut(cashOutId, { state: "DEBIT_FAILED", error: error.message });
    throw error;
  }
  if (debit.duplicate) {
    // Ledger already has this debit (retry after a lost response). Resume
    // from the recorded state instead of acting again.
    return { duplicate: true, cashOut: await getCashOut(cashOutId) };
  }
  await updateCashOut(cashOutId, { state: "DEBITED", ledger_entry_id: debit.entryId });

  // Derived from cashOutId so a reconciled retry cannot place a second order.
  const clientOrderId = parseInt(cashOutId.replace(/-/g, "").slice(0, 12), 16);

  try {
    const order = await sendNdaxOrder({ side: "SELL", quantity: request.amount, clientOrderId });
    await updateCashOut(cashOutId, { state: "ORDER_ACCEPTED", order_id: order.orderId, order_status: order.status });
    return { duplicate: false, cashOut: await getCashOut(cashOutId), order };
  } catch (error) {
    const reversal = await postWalletReversal({
      customerId,
      currency: CASH_OUT_ASSET,
      amount: request.amount,
      provider: DEBIT_PROVIDER,
      providerEventId: `cashout:${cashOutId}:reversal`,
      reference: `Cash out ${cashOutId} reversal`,
      metadata: { cashOutId },
    });
    await updateCashOut(cashOutId, {
      state: "REVERSED",
      reversal_entry_id: reversal?.entryId ?? null,
      error: error.message,
    });
    const wrapped = new Error(`Cash out failed and the wallet debit was reversed: ${error.message}`);
    wrapped.statusCode = error.statusCode || 502;
    wrapped.cashOut = await getCashOut(cashOutId);
    throw wrapped;
  }
}

// What the operator needs to pay this cash-out out of the CAD pool: the
// ticket amount, the fee breakdown, and the customer's bank template.
export async function getCashOutPayoutPlan(cashOutId, payoutMethod = "INTERAC") {
  const cashOut = await getCashOut(cashOutId);
  if (!cashOut) throw fail(`No cash-out ${cashOutId}.`, 404);
  if (cashOut.state !== "ORDER_ACCEPTED") {
    throw fail(`Cash-out ${cashOutId} is ${cashOut.state}, not payable.`, 409);
  }
  if (!cashOut.orderId) throw fail("This cash-out has no Ndax order.");
  if (!cashOut.bankDetails) throw fail("This cash-out has no bank details recorded.");

  const status = await getNdaxOrderStatus(cashOut.orderId);
  const state = String(status.state || "").toUpperCase();
  if (state !== "FULLYEXECUTED" || status.quantityExecuted <= 0) {
    throw fail(`Ndax order ${cashOut.orderId} is ${state || "unknown"} — nothing executed yet.`, 409);
  }
  const method = payoutMethod === "EFT" ? "EFT" : "INTERAC";
  const plan = cashOutPayout({
    quantityExecuted: status.quantityExecuted,
    averagePriceCad: status.averagePrice,
    payoutMethod: method,
  });
  return { cashOut, method, orderState: state, ...plan };
}

// Operator confirmation that a payout left the pool.
export async function completeCashOut(cashOutId) {
  const cashOut = await getCashOut(cashOutId);
  if (!cashOut) throw fail(`No cash-out ${cashOutId}.`, 404);
  if (cashOut.state === "PAID") return { cashOut, duplicate: true };
  if (cashOut.state !== "ORDER_ACCEPTED") {
    throw fail(`Cash-out ${cashOutId} is ${cashOut.state}; only ORDER_ACCEPTED can be marked paid.`, 409);
  }
  await getPool().query(
    "UPDATE cash_outs SET state='PAID', updated_at=NOW() WHERE cash_out_id=$1",
    [cashOutId]
  );
  return { cashOut: await getCashOut(cashOutId), duplicate: false };
}
