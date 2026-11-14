// Nomba adapter — NGN virtual accounts, collections, bank transfers.
// Authoritative spec: https://developer.nomba.com (OpenAPI: /nomba-api-reference/openapi.json).
//
// Auth is OAuth2 client-credentials (verified live 2026-11-14 against both
// https://api.nomba.com and https://sandbox.nomba.com):
//   POST {base}/v1/auth/token/issue   headers: accountId  body: {grant_type,
//   client_id, client_secret} -> {code:"00", data:{access_token, refresh_token,
//   businessId, expiresAt}}. Access tokens expire after ~30 minutes; refresh
//   via POST /v1/auth/token/refresh. Every API call also carries the
//   `accountId` header (the parent account UUID).
//
// Env vars:
//   NOMBA_API_BASE_URL   — https://sandbox.nomba.com (default) or https://api.nomba.com
//   NOMBA_CLIENT_ID      — client id from Nomba
//   NOMBA_CLIENT_SECRET  — client secret (NOMBA_PRIVATE_KEY accepted as alias)
//   NOMBA_ACCOUNT_ID     — parent account UUID (accountId header)
//   NOMBA_WEBHOOK_SECRET — webhook signing secret (dashboard/API config)
//
// Sandbox endpoints work WITHOUT credentials too, so integration tests do not
// depend on them. Bank transfer path verified live: POST /v2/transfers/bank.

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { getPool } from "../db/pool.js";
import { postProviderCredit } from "./walletService.js";

const baseUrl = () => String(process.env.NOMBA_API_BASE_URL || "https://sandbox.nomba.com").replace(/\/+$/, "");
const clientId = () => String(process.env.NOMBA_CLIENT_ID || "").trim();
const clientSecret = () =>
  String(process.env.NOMBA_CLIENT_SECRET || process.env.NOMBA_PRIVATE_KEY || "").trim();
const accountId = () => String(process.env.NOMBA_ACCOUNT_ID || "").trim();
const webhookSecret = () => String(process.env.NOMBA_WEBHOOK_SECRET || "").trim();

function isUsableCredential(value) {
  return Boolean(value) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder|test)$/i.test(value.trim());
}

export function getNombaReadiness() {
  const missing = [];
  if (!isUsableCredential(clientId())) missing.push("NOMBA_CLIENT_ID");
  if (!isUsableCredential(clientSecret())) missing.push("NOMBA_CLIENT_SECRET");
  if (!isUsableCredential(accountId())) missing.push("NOMBA_ACCOUNT_ID");

  return {
    name: "Nomba",
    role: "NGN collections (virtual accounts), bank transfers, and cross-border Global Payout (INTERAC, SEPA, ACH, WIRE) — planned",
    corridors: ["NGN"],
    configured: missing.length === 0,
    status: missing.length === 0
      ? "CREDENTIALS_PRESENT_TOKEN_ISSUE_LIVE_VERIFIED"
      : "AWAITING_PROVIDER_CREDENTIALS",
    missingVariables: missing,
    environment: baseUrl().includes("sandbox") ? "Sandbox" : "Production",
    baseUrl: baseUrl(),
    capabilities: ["NGN_VIRTUAL_ACCOUNT", "NGN_BANK_TRANSFER_FUNDING", "NGN_WEBHOOK_SETTLEMENT", "NGN_BANK_LOOKUP"],
    capabilitiesPlanned: ["GLOBAL_PAYOUT", "MULTI_CURRENCY_WALLETS", "CAD_PAYOUT_INTERAC", "DRC_MOBILE_MONEY_COLLECTIONS"],
    requiredWebhooks: true,
    note: "OAuth2 client-credentials; sandbox accepts unauthenticated requests.",
  };
}

// ---------------------------------------------------------------------------
// OAuth2 token management
// ---------------------------------------------------------------------------

let tokenCache = null; // { accessToken, refreshToken, expiresAt(ms) }
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export async function invalidateNombaToken() {
  tokenCache = null;
}

async function issueToken() {
  const response = await fetch(`${baseUrl()}/v1/auth/token/issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accountId: accountId() },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId(),
      client_secret: clientSecret(),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== "00" || !payload.data?.access_token) {
    const error = new Error(payload.description || payload.message || `Nomba token issue failed with HTTP ${response.status}.`);
    error.statusCode = 502;
    throw error;
  }
  tokenCache = {
    accessToken: payload.data.access_token,
    refreshToken: payload.data.refresh_token || null,
    expiresAt: Date.parse(payload.data.expiresAt) || Date.now() + 25 * 60 * 1000,
  };
  return tokenCache.accessToken;
}

async function refreshToken() {
  if (!tokenCache?.refreshToken) return issueToken();
  const response = await fetch(`${baseUrl()}/v1/auth/token/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      accountId: accountId(),
      Authorization: `Bearer ${tokenCache.accessToken}`,
    },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: tokenCache.refreshToken }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== "00" || !payload.data?.access_token) {
    return issueToken(); // refresh failed — fall back to a clean issue
  }
  tokenCache = {
    accessToken: payload.data.access_token,
    refreshToken: payload.data.refresh_token || tokenCache.refreshToken,
    expiresAt: Date.parse(payload.data.expiresAt) || Date.now() + 25 * 60 * 1000,
  };
  return tokenCache.accessToken;
}

export async function getNombaAccessToken() {
  if (!isUsableCredential(clientId()) || !isUsableCredential(clientSecret()) || !isUsableCredential(accountId())) {
    const error = new Error(
      "Nomba credentials are not configured. Set NOMBA_CLIENT_ID, NOMBA_CLIENT_SECRET (or NOMBA_PRIVATE_KEY) and NOMBA_ACCOUNT_ID."
    );
    error.statusCode = 503;
    throw error;
  }
  if (tokenCache && tokenCache.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) {
    return tokenCache.accessToken;
  }
  if (tokenCache?.refreshToken) return refreshToken();
  return issueToken();
}

async function nombaJson(path, { method = "GET", body, reauthenticated = false } = {}) {
  const token = await getNombaAccessToken();
  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      accountId: accountId(),
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  if (response.status === 401 && !reauthenticated) {
    await invalidateNombaToken();
    return nombaJson(path, { method, body, reauthenticated: true });
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== "00") {
    const error = new Error(payload.description || payload.message || `Nomba request failed with HTTP ${response.status}.`);
    error.provider = "Nomba";
    error.providerCode = payload.code || null;
    error.statusCode = response.status === 400 || response.status === 404 ? 400 : response.status === 429 ? 429 : 502;
    throw error;
  }
  return payload.data ?? payload;
}

// ---------------------------------------------------------------------------
// NGN virtual accounts (collections)
// ---------------------------------------------------------------------------

export async function createNombaVirtualAccount({ customerId, customerName, email, phone, bvn }) {
  const existing = await getPool().query(
    "SELECT details FROM payment_details WHERE provider='Nomba' AND customer_id=$1 AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1",
    [customerId]
  );
  if (existing.rowCount) return existing.rows[0].details;

  const refId = `stablex_nomba_${customerId}_${Date.now()}`;
  const data = await nombaJson("/v1/accounts/virtual", {
    method: "POST",
    body: {
      accountRef: refId,
      accountName: customerName || customerId,
      currency: "NGN",
      ...(email ? { customerEmail: email } : {}),
      ...(phone ? { customerPhone: phone } : {}),
      ...(bvn ? { customerBVN: bvn } : {}),
    },
  });

  const accountNumber = data?.bankAccountNumber || data?.accountNumber || data?.data?.bankAccountNumber;
  const bankName = data?.bankName || data?.bank_name || data?.data?.bankName || "Nomba Partner Bank";
  const bankCode = data?.bankCode || data?.bank_code || data?.data?.bankCode;

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
    accountHolderName: data?.bankAccountName || customerName,
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

// ---------------------------------------------------------------------------
// NGN bank transfers (payouts) — operator-gated at the route layer
// ---------------------------------------------------------------------------

// POST /v1/transfers/bank/lookup — verify recipient before paying out.
export async function lookupNombaBankAccount(accountNumber, bankCode) {
  const normalized = String(accountNumber || "").trim();
  if (!/^\d{10}$/.test(normalized)) {
    const error = new Error("A Nigerian bank account number must be exactly 10 digits.");
    error.statusCode = 400;
    throw error;
  }
  if (!String(bankCode || "").trim()) {
    const error = new Error("A Nomba bankCode is required (from /v1/transfers/banks).");
    error.statusCode = 400;
    throw error;
  }
  return nombaJson("/v1/transfers/bank/lookup", {
    method: "POST",
    body: { accountNumber: normalized, bankCode: String(bankCode).trim() },
  });
}

// POST /v2/transfers/bank — pays out NGN from the Nomba parent account.
// Final status arrives via webhook; data.status may be SUCCESS/PENDING_BILLING.
export async function transferToNigerianBank({
  amount, accountNumber, accountName, bankCode,
  merchantTxRef, senderName, narration,
}) {
  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    const error = new Error("A positive NGN amount is required.");
    error.statusCode = 400;
    throw error;
  }
  const normalizedAccount = String(accountNumber || "").trim();
  if (!/^\d{10}$/.test(normalizedAccount)) {
    const error = new Error("A Nigerian bank account number must be exactly 10 digits.");
    error.statusCode = 400;
    throw error;
  }
  if (!accountName || !bankCode) {
    const error = new Error("accountName and bankCode are required (run lookupNombaBankAccount first).");
    error.statusCode = 400;
    throw error;
  }
  return nombaJson("/v2/transfers/bank", {
    method: "POST",
    body: {
      amount: amountNumber,
      accountNumber: normalizedAccount,
      accountName: String(accountName),
      bankCode: String(bankCode),
      merchantTxRef: String(merchantTxRef || `stablex_payout_${Date.now()}`),
      senderName: String(senderName || "StableX"),
      narration: String(narration || "StableX NGN payout"),
    },
  });
}

// ---------------------------------------------------------------------------
// Webhooks — payment arrival credits the customer's NGN wallet
// ---------------------------------------------------------------------------

export function verifyNombaWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const received = Buffer.from(signature);
  const calculated = Buffer.from(expected);
  return received.length === calculated.length && timingSafeEqual(received, calculated);
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
