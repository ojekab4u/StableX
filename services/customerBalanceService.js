// Customer wallet & balance service — in-memory tracking per customer.
// Backed by PostgreSQL transfer events for debit/credit history.
import { getPool } from "../db/pool.js";
import { getAsset, canHoldWallet, getWalletEligibleAssets } from "../config/assets.js";

const customerBalances = new Map(); // customerId -> Map(currency -> balance)
const customerWallets = new Map(); // customerId -> Set(currency)
const customerCountries = new Map(); // customerId -> country code

function ensureCustomer(customerId) {
  if (!customerBalances.has(customerId)) {
    customerBalances.set(customerId, new Map());
    customerWallets.set(customerId, new Set());
  }
}

// --- Wallet management ---

export function getCustomerWallets(customerId) {
  ensureCustomer(customerId);
  const wallets = customerWallets.get(customerId);
  return Array.from(wallets).map((currency) => {
    const asset = getAsset(currency);
    const balance = customerBalances.get(customerId).get(currency) || 0;
    return {
      currency,
      name: asset?.name || currency,
      type: asset?.type || "FIAT",
      region: asset?.region || "GLOBAL",
      balance,
      icon: assetIcon(currency),
    };
  });
}

export function createCustomerWallet(customerId, currency, customerCountry = "GLOBAL") {
  ensureCustomer(customerId);
  currency = String(currency).toUpperCase();

  if (!getAsset(currency)) {
    const error = new Error(`Unknown currency: ${currency}`);
    error.statusCode = 400;
    throw error;
  }

  if (!canHoldWallet(currency, customerCountry)) {
    const error = new Error(`${currency} wallets are only available to customers in the ${currency === "NGN" ? "Nigeria" : "supported"} region.`);
    error.statusCode = 403;
    throw error;
  }

  const wallets = customerWallets.get(customerId);
  if (wallets.has(currency)) {
    const error = new Error(`Wallet for ${currency} already exists.`);
    error.statusCode = 409;
    throw error;
  }

  wallets.add(currency);
  customerBalances.get(customerId).set(currency, 0);

  return {
    customerId,
    currency,
    name: getAsset(currency).name,
    type: getAsset(currency).type,
    region: getAsset(currency).region,
    balance: 0,
    icon: assetIcon(currency),
  };
}

export function getWalletEligibleForCustomer(customerId, customerCountry = "GLOBAL") {
  const existing = new Set(customerWallets.get(customerId) || []);
  return getWalletEligibleAssets(customerCountry)
    .filter((asset) => !existing.has(asset.code))
    .map((asset) => ({
      currency: asset.code,
      name: asset.name,
      type: asset.type,
      region: asset.region,
      icon: assetIcon(asset.code),
    }));
}

// --- Balance management ---

export function getCustomerBalances(customerId) {
  ensureCustomer(customerId);
  const balances = customerBalances.get(customerId);
  const result = {};
  for (const [currency, balance] of balances) {
    result[currency] = balance;
  }
  return result;
}

export function creditBalance(customerId, currency, amount, reference, meta) {
  ensureCustomer(customerId);
  const balances = customerBalances.get(customerId);
  const current = balances.get(currency) || 0;
  balances.set(currency, current + amount);
  return { customerId, currency, amount, balance: balances.get(currency), type: "CREDIT", reference, meta };
}

export function debitBalance(customerId, currency, amount, reference, meta) {
  ensureCustomer(customerId);
  const balances = customerBalances.get(customerId);
  const current = balances.get(currency) || 0;
  if (current < amount) {
    const error = new Error(`Insufficient ${currency} balance. Available: ${current}, requested: ${amount}.`);
    error.statusCode = 400;
    throw error;
  }
  balances.set(currency, current - amount);
  return { customerId, currency, amount: -amount, balance: balances.get(currency), type: "DEBIT", reference, meta };
}

export function setCustomerCountry(customerId, country) {
  customerCountries.set(customerId, country);
}

export function getCustomerCountry(customerId) {
  return customerCountries.get(customerId) || "GLOBAL";
}

// --- Transaction history ---

export async function getTransactionHistory(customerId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT te.event_id AS id, te.to_status AS status, te.created_at AS "createdAt",
            te.reason, t.source_currency AS "sourceCurrency", t.source_amount AS "sourceAmount",
            t.destination_currency AS "destinationCurrency", t.destination_amount AS "destinationAmount",
            t.quote_data AS quote
     FROM transfer_events te
     JOIN transfers t ON te.transfer_id = t.transfer_id
     WHERE t.customer_id = $1
     ORDER BY te.created_at DESC
     LIMIT 100`,
    [customerId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    reason: row.reason,
    sourceCurrency: row.sourcecurrency,
    sourceAmount: Number(row.sourceamount),
    destinationCurrency: row.destinationcurrency,
    destinationAmount: row.destinationamount ? Number(row.destinationamount) : null,
    quote: row.quote,
  }));
}

export async function getCustomerSummary(customerId) {
  const balances = getCustomerBalances(customerId);
  const history = await getTransactionHistory(customerId);
  let totalCredited = 0;
  let totalDebited = 0;
  for (const tx of history) {
    if (tx.type === "CREDIT") totalCredited += tx.amount;
    if (tx.type === "DEBIT") totalDebited += Math.abs(tx.amount);
  }
  return { balances, totalCredited, totalDebited, transactionCount: history.length };
}

function assetIcon(code) {
  const icons = {
    CAD: "🇨🇦", USD: "🇺🇸", GBP: "🇬🇧", EUR: "🇪🇺", NGN: "🇳🇬",
    USDC: "🪙", USDT: "🪙", EURC: "🪙", CADD: "🪙", CADC: "🪙",
  };
  return icons[code] || "💳";
}
