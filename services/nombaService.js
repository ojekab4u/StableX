// M5 — Nomba NGN virtual accounts & collections
//
// Provides real NGN virtual account numbers for Nigerian-region customers.
// Customers fund these accounts via bank transfer from any Nigerian bank.
// Nomba fires webhooks on payment arrival; StableX credits internal balances.
//
// Required env vars:
//   NOMBA_API_BASE_URL   — https://sandbox.nomba.com
//   NOMBA_API_KEY        — sandbox API key from Nomba dashboard
//   NOMBA_WEBHOOK_SECRET — webhook signing secret from Nomba dashboard
//
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { getPool } from "../db/pool.js";
import { postProviderCredit } from "./walletService.js";

const apiKey = () => String(process.env.NOMBA_API_KEY || "").trim();
const baseUrl = () => String(process.env.NOMBA_API_BASE_URL || "https://sandbox.nomba.com").replace(/\/+$/, "");
const webhookSecret = () => String(process.env.NOMBA_WEBHOOK_SECRET || "").trim();


function isUsableCredential(value) {
  return Boolean(value) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder|test)$/i.test(value.trim());
}

export function getNombaReadiness() {
  const missing = [];
  if (!isUsableCredential(apiKey())) missing.push("NOMBA_API_KEY");
  if (!isUsableCredential(webhookSecret())) missing.push("NOMBA_WEBHOOK_SECRET");

  return {
    name: "Nomba",
    role: "NGN collections (virtual accounts) and payouts",
    corridors: ["NGN"],
    configured: missing.length === 0,
    status: missing.length === 0
      ? "CREDENTIALS_PRESENT_CONNECTION_NOT_TESTED"
      : "AWAITING_PROVIDER_CREDENTIALS",
    missingVariables: missing,
    environment: "Sandbox",
    baseUrl: baseUrl(),
    capabilities: ["NGN_VIRTUAL_ACCOUNT", "NGN_BANK_TRANSFER_FUNDING", "NGN_WEBHOOK_SETTLEMENT"],
    requiredWebhooks: true,
    note: "Nomba virtual accounts require sandbox API key + webhook secret from the Nomba dashboard.",
  };
}

export function verifyNombaWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const received = Buffer.from(signature);
  const calculated = Buffer.from(expected);
  return received.length === calculated.length && timingSafeEqual(received, calculated);
}

export async function createNombaVirtualAccount({ customerId, customerName, email, phone, bvn }) {
  if (!isUsableCredential(apiKey())) {
    const error = new Error("Nomba API key not configured. Set NOMBA_API_KEY in .env.");
    error.statusCode = 503;
    throw error;
  }

  const refId = `stablex_nomba_${customerId}_${Date.now()}`;

  const payload = {
    accountReference: refId,
    accountName: customerName || customerId,
    customerEmail: email || "",
    customerPhone: phone || "",
    customerBVN: bvn || "",
    narration: `StableX NGN wallet funding for customer ${customerId}`,
  };

  const response = await fetch(`${baseUrl()}/api/v1/virtual-accounts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey()}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });

  const raw = await response.text();
  let result;
  try { result = raw ? JSON.parse(raw) : {}; } catch { result = { message: raw.slice(0, 1000) }; }

  if (!response.ok) {
    const error = new Error(result.message || result.error || `Nomba returned HTTP ${response.status}`);
    error.statusCode = response.status >= 500 ? 502 : 400;
    throw error;
  }

  const accountNumber = result.accountNumber || result.account_number || result.data?.accountNumber;
  const bankName = result.bankName || result.bank_name || result.data?.bankName || "Nomba Partner Bank";
  const bankCode = result.bankCode || result.bank_code || result.data?.bankCode;

  if (!accountNumber) {
    const error = new Error("Nomba did not return an account number.");
    error.statusCode = 502;
    throw error;
  }

  const record = {
    refId,
    customerId,
    customerName,
    accountNumber,
    bankName,
    bankCode,
    currency: "NGN",
    status: "ACTIVE",
    balance: 0,
    createdAt: new Date().toISOString(),
    lastFundedAt: null,
  };
  const wallet = await getPool().query(
    "SELECT wallet_id FROM wallet_accounts WHERE customer_id=$1 AND asset_code='NGN' AND status='ACTIVE'",
    [customerId]
  );
  if (!wallet.rowCount) {
    const error = new Error("Create an approved customer's NGN wallet before requesting NGN payment details.");
    error.statusCode = 409;
    throw error;
  }
  await getPool().query(
    `INSERT INTO payment_details(payment_detail_id,customer_id,wallet_id,provider,provider_reference,currency,details)
     VALUES($1,$2,$3,'Nomba',$4,'NGN',$5::jsonb)`,
    [randomUUID(), customerId, wallet.rows[0].wallet_id, refId, JSON.stringify(record)]
  );
  return record;
}

export async function getNombaAccount(refId) {
  const result = await getPool().query(
    "SELECT details FROM payment_details WHERE provider='Nomba' AND provider_reference=$1",
    [refId]
  );
  return result.rows[0]?.details || null;
}

export async function getNombaAccountsByCustomer(customerId) {
  const result = await getPool().query(
    `SELECT details FROM payment_details WHERE provider='Nomba' AND customer_id=$1 ORDER BY created_at DESC`,
    [customerId]
  );
  return result.rows.map((row) => row.details);
}

export async function applyNombaWebhook(event) {
  const data = event?.data || {};
  const refId = data.refId || data.accountReference || data.reference;
  const amount = Number(data.amount || data.creditAmount || data.amountCredited || 0);
  const currency = String(data.currency || "NGN").toUpperCase();
  const providerEventId = String(event?.id || data.eventId || data.transactionId || data.paymentId || data.id || "");

  if (!refId) return { updated: false, reason: "Webhook did not include a reference/account reference." };
  if (currency !== "NGN") return { updated: false, reason: `Currency ${currency} not supported for NGN accounts.` };
  if (!Number.isFinite(amount) || amount <= 0) return { updated: false, reason: "Invalid funding amount." };
  if (!providerEventId) return { updated: false, reason: "Webhook did not include a stable provider event/payment ID; refusing a non-idempotent credit." };

  const record = await getNombaAccount(String(refId));
  if (!record) return { updated: false, reason: "Virtual account not found for this reference." };

  const credit = await postProviderCredit({
    customerId: record.customerId,
    currency,
    amount,
    provider: "Nomba",
    providerEventId,
    reference: String(refId),
    metadata: { accountNumber: record.accountNumber, eventType: event?.type || "payment.received" },
  });
  return {
    updated: credit.credited,
    duplicate: credit.duplicate,
    refId: String(refId),
    customerId: record.customerId,
    accountNumber: record.accountNumber,
    amount,
    currency,
    newBalance: credit.balance,
    status: record.status,
  };
}
