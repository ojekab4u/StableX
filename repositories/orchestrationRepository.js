import { getPool } from "../db/pool.js";

export async function saveOrchestrationIntent(intent) {
  const query = `
    INSERT INTO orchestration_intents (
      intent_id, status, source_currency, source_amount,
      destination_currency, destination_amount, provider,
      quote, intent_data, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, NOW())
    RETURNING intent_id
  `;

  const values = [
    intent.intentId,
    intent.status,
    intent.source.currency,
    intent.source.amount,
    intent.destination.currency,
    intent.destination.amount ?? null,
    intent.provider,
    JSON.stringify(intent.quote),
    JSON.stringify(intent),
    intent.createdAt,
  ];

  await getPool().query(query, values);
  return intent;
}

export async function findOrchestrationIntent(intentId) {
  const result = await getPool().query(
    "SELECT intent_data FROM orchestration_intents WHERE intent_id = $1",
    [intentId]
  );
  return result.rows[0]?.intent_data ?? null;
}
