#!/usr/bin/env node
// Inspect an existing Linkio Retail Direct FX transaction without creating one.
// Usage: node scripts/inspect-linkio-transaction.js <transaction-reference>
// Loads LINKIO_SECRET_KEY from the project's .env and prints a redacted shape summary.

import "dotenv/config";

const reference = String(process.argv[2] || "").trim();
const secret = String(process.env.LINKIO_SECRET_KEY || "").trim();
const base = String(process.env.LINKIO_API_BASE_URL || "https://api.linkio.world").trim().replace(/\\/+$/, "");

if (!reference) {
  console.error("Usage: node scripts/inspect-linkio-transaction.js <transaction-reference>");
  process.exit(2);
}
if (!secret) {
  console.error("LINKIO_SECRET_KEY is not configured in the project .env.");
  process.exit(2);
}

const url = new URL(base + "/transactions/v2/fetch_transaction");
url.searchParams.set("transaction_reference", reference);

let response;
try {
  response = await fetch(url, {
    headers: { accept: "application/json", "ngnc-sec-key": secret },
    signal: AbortSignal.timeout(15000),
  });
} catch (error) {
  console.error("Linkio request failed:", error.message);
  process.exit(1);
}

const rawText = await response.text();
let payload = {};
try { payload = rawText ? JSON.parse(rawText) : {}; } catch {
  console.error("Linkio returned a non-JSON response. HTTP", response.status);
  console.error(rawText.slice(0, 500));
  process.exit(1);
}
if (!response.ok) {
  console.error("Linkio returned HTTP", response.status);
  console.error(JSON.stringify({
    code: payload.code ?? null,
    message: payload.message ?? payload.description ?? null,
  }, null, 2));
  process.exit(1);
}

function walk(value, path = "$", depth = 0, out = []) {
  if (!value || typeof value !== "object" || depth > 5 || out.length >= 100) return out;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path + "." + key;
    if (child && typeof child === "object") walk(child, childPath, depth + 1, out);
    else out.push({ path: childPath, key, value: child });
  }
  return out;
}
const unwrapped = payload?.data ?? payload;
const flat = walk(unwrapped);
const candidates = {
  bankName: ["link_bank_name", "bank_name", "bankName"],
  accountNumber: ["link_account_number", "account_number", "accountNumber"],
  accountName: ["link_account_name", "account_name", "accountName"],
};
const sensitive = /account.?number|wallet.?address|email|phone|token|secret|password|authorization|api.?key/i;
const fields = flat.map(({ path, key, value }) => ({
  path,
  key,
  type: value === null ? "null" : typeof value,
  value: sensitive.test(key)
    ? (value == null || value === "" ? null : (String(value).length <= 4 ? "****" : "****" + String(value).slice(-4)))
    : (/account.?name/i.test(key) ? (value ? "[present; redacted]" : value)
      : (typeof value === "string" && value.length > 160 ? value.slice(0, 160) + "…" : value)),
}));
const result = {
  httpStatus: response.status,
  reference,
  rootKeys: Object.keys(payload || {}),
  dataKeys: payload?.data && typeof payload.data === "object" ? Object.keys(payload.data) : [],
  transactionKeys: payload?.transaction && typeof payload.transaction === "object" ? Object.keys(payload.transaction) : [],
  dataTransactionKeys: payload?.data?.transaction && typeof payload.data.transaction === "object"
    ? Object.keys(payload.data.transaction) : [],
  topLevelStatus: payload?.status ?? null,
  topLevelCode: payload?.code ?? null,
  unwrappedStatus: unwrapped?.transaction_status ?? unwrapped?.status ?? null,
  unwrappedReference: unwrapped?.reference ?? unwrapped?.transaction_reference ?? null,
  settlementCandidates: Object.fromEntries(Object.entries(candidates).map(([name, keys]) => [
    name,
    flat.filter((item) => keys.includes(item.key)).map((item) => ({
      path: item.path,
      present: item.value !== null && item.value !== undefined && String(item.value).trim() !== "",
      value: name === "accountNumber"
        ? (item.value ? "****" + String(item.value).slice(-4) : null)
        : name === "accountName"
          ? (item.value ? "[present; redacted]" : null)
          : item.value,
    })),
  ])),
  scalarFields: fields,
};
console.log(JSON.stringify(result, null, 2));
