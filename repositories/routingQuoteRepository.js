import { getPool } from "../db/pool.js";

export async function saveRoutingQuote(quote) {
  await getPool().query(
    `INSERT INTO routing_quotes
      (quote_id, provider, from_currency, to_currency, source_amount, quote_data, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT (quote_id) DO NOTHING`,
    [quote.quoteId, quote.provider, quote.from, quote.to, quote.sourceAmount, JSON.stringify(quote), quote.expiresAt]
  );
  return quote;
}

export async function readRoutingQuote(quoteId) {
  const result = await getPool().query(
    `SELECT quote_data AS quote, expires_at AS "expiresAt", selected_at AS "selectedAt"
     FROM routing_quotes WHERE quote_id=$1`,
    [quoteId]
  );
  if (!result.rowCount) return null;
  return { ...result.rows[0].quote, expiresAt: result.rows[0].expiresAt, selectedAt: result.rows[0].selectedAt };
}

export async function markRoutingQuoteSelected(quoteId) {
  await getPool().query(
    "UPDATE routing_quotes SET selected_at=NOW() WHERE quote_id=$1 AND selected_at IS NULL",
    [quoteId]
  );
}
