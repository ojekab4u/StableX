import { randomUUID } from "node:crypto";
import { getPool } from "../db/pool.js";
import { getAsset, canHoldWallet, getWalletEligibleAssets } from "../config/assets.js";
import { verifyMessage, isAddress } from "viem";


function assetIcon(code) {
  return ({ NGN: "🇳🇬", CAD: "🇨🇦", USD: "🇺🇸", GBP: "🇬🇧", EUR: "🇪🇺", USDC: "🪙", USDT: "🪙", EURC: "🪙", CADD: "🪙", CADC: "🪙" })[code] || "💳";
}

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export async function createWallet({ customerId, currency, country = "GLOBAL" }) {
  if (!customerId || typeof customerId !== "string") throw fail("customerId is required.");
  const assetCode = String(currency || "").toUpperCase();
  const asset = getAsset(assetCode);
  if (!asset) throw fail(`Unknown asset: ${assetCode}`);
  if (!canHoldWallet(assetCode, String(country).toUpperCase())) throw fail(`${assetCode} is not available in this customer's region.`, 403);
  const gate = await getCustomerGateStatus(customerId);
  if (!gate.gate.approved) throw fail("Complete and pass identity verification before creating a wallet.", 403);

  const pool = getPool();
  try {
    const result = await pool.query(
      `INSERT INTO wallet_accounts(wallet_id,customer_id,asset_code,country_code)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(customer_id,asset_code) DO NOTHING
       RETURNING wallet_id AS "walletId", customer_id AS "customerId", asset_code AS currency,
                 country_code AS country, status, created_at AS "createdAt"`,
      [randomUUID(), customerId, assetCode, country === "GLOBAL" ? null : String(country).toUpperCase()]
    );
    if (!result.rowCount) throw fail(`A ${assetCode} wallet already exists.`, 409);
    return { ...result.rows[0], assetName: asset.name, assetType: asset.type, balance: 0 };
  } catch (error) { throw error; }
}

export async function listWallets(customerId) {
  const result = await getPool().query(
    `SELECT w.wallet_id AS "walletId", w.customer_id AS "customerId",
            w.asset_code AS currency, w.country_code AS country, w.status,
            w.created_at AS "createdAt",
            COALESCE(SUM(CASE WHEN l.status='POSTED' THEN l.amount ELSE 0 END),0)::text AS balance
     FROM wallet_accounts w LEFT JOIN wallet_ledger l ON l.wallet_id=w.wallet_id
     WHERE w.customer_id=$1
     GROUP BY w.wallet_id ORDER BY w.created_at`,
    [customerId]
  );
  return result.rows.map((row) => {
    const asset = getAsset(row.currency);
    return { ...row, balance: Number(row.balance), assetName: asset?.name || row.currency, assetType: asset?.type || "UNKNOWN", region: asset?.region || "GLOBAL", icon: assetIcon(row.currency) };
  });
}

export async function listEligibleWalletAssets(customerId, country = "GLOBAL") {
  const existing = new Set((await listWallets(customerId)).map((w) => w.currency));
  return getWalletEligibleAssets(String(country).toUpperCase())
    .filter((asset) => !existing.has(asset.code))
    .map(({ code, name, type, region, status, settlement }) => ({ currency: code, name, type, region: region || "GLOBAL", status, settlement, icon: assetIcon(code) }));
}

export async function getWalletLedger(customerId, currency) {
  const params = [customerId];
  let filter = "";
  if (currency) { params.push(String(currency).toUpperCase()); filter = " AND asset_code=$2"; }
  const result = await getPool().query(
    `SELECT entry_id AS "entryId", asset_code AS currency, entry_type AS type,
            amount::text AS amount, reference, provider, status, metadata,
            created_at AS "createdAt"
     FROM wallet_ledger WHERE customer_id=$1${filter}
     ORDER BY created_at DESC LIMIT 200`, params
  );
  return result.rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

// Only trusted, signature-verified provider webhook handlers should call this.
export async function postProviderCredit({ customerId, currency, amount, provider, providerEventId, reference, metadata = {} }) {
  const assetCode = String(currency || "").toUpperCase();
  const value = Number(amount);
  if (!customerId || !assetCode || !Number.isFinite(value) || value <= 0 || !provider || !providerEventId) {
    throw fail("A customer, asset, positive amount and unique provider event reference are required.");
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const wallet = await client.query(
      "SELECT wallet_id FROM wallet_accounts WHERE customer_id=$1 AND asset_code=$2 AND status='ACTIVE' FOR UPDATE",
      [customerId, assetCode]
    );
    if (!wallet.rowCount) throw fail(`No active ${assetCode} wallet exists for this customer.`, 404);
    const inserted = await client.query(
      `INSERT INTO wallet_ledger(entry_id,wallet_id,customer_id,asset_code,entry_type,amount,reference,provider,provider_event_id,metadata)
       VALUES($1,$2,$3,$4,'DEPOSIT',$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT(provider,provider_event_id) DO NOTHING
       RETURNING entry_id AS "entryId"`,
      [randomUUID(), wallet.rows[0].wallet_id, customerId, assetCode, value, reference || providerEventId, provider, providerEventId, JSON.stringify(metadata)]
    );
    if (!inserted.rowCount) {
      const prior = await client.query(
        "SELECT customer_id,asset_code,amount::text AS amount FROM wallet_ledger WHERE provider=$1 AND provider_event_id=$2",
        [provider, providerEventId]
      );
      if (!prior.rowCount || prior.rows[0].customer_id !== customerId ||
          prior.rows[0].asset_code !== assetCode || Number(prior.rows[0].amount) !== value) {
        throw fail("Provider event ID was already used for a different credit. Manual reconciliation is required.", 409);
      }
    }
    const balance = await client.query(
      "SELECT COALESCE(SUM(amount),0)::text AS balance FROM wallet_ledger WHERE wallet_id=$1 AND status='POSTED'",
      [wallet.rows[0].wallet_id]
    );
    await client.query("COMMIT");
    return { credited: Boolean(inserted.rowCount), duplicate: !inserted.rowCount, customerId, currency: assetCode, balance: Number(balance.rows[0].balance) };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function registerExternalWallet({ customerId, address, chainId, walletProvider, signature, message }) {
  if (!isAddress(address)) throw fail("A valid EVM wallet address is required.");
  const chain = Number(chainId);
  if (![8453, 84532].includes(chain)) throw fail("Only Base Mainnet (8453) and Base Sepolia (84532) are currently supported.");
  const expectedMessage = `StableX wallet connection\nCustomer: ${customerId}\nAddress: ${address.toLowerCase()}\nChain ID: ${chain}`;
  if (message !== expectedMessage || !signature) throw fail("A valid wallet ownership signature is required.");
  const valid = await verifyMessage({ address, message, signature });
  if (!valid) throw fail("Wallet ownership signature could not be verified.", 401);
  const result = await getPool().query(
    `INSERT INTO external_wallets(external_wallet_id,customer_id,address,chain_id,wallet_provider,status)
     VALUES($1,$2,$3,$4,$5,'ACTIVE')
     ON CONFLICT(customer_id,chain_id,address) DO UPDATE SET wallet_provider=EXCLUDED.wallet_provider
     RETURNING external_wallet_id AS "walletId", customer_id AS "customerId", address, chain_id AS "chainId",
               wallet_provider AS "walletProvider", status, created_at AS "createdAt"`,
    [randomUUID(), customerId, address, chain, walletProvider || "EVM_WALLET"]
  );
  return result.rows[0];
}

export async function listExternalWallets(customerId) {
  const result = await getPool().query(
    `SELECT external_wallet_id AS "walletId", address, chain_id AS "chainId",
            wallet_provider AS "walletProvider", status, created_at AS "createdAt"
     FROM external_wallets WHERE customer_id=$1 AND status='ACTIVE' ORDER BY created_at DESC`,
    [customerId]
  );
  return result.rows;
}
