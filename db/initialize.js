import { getPool } from "./pool.js";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS orchestration_intents (
    intent_id UUID PRIMARY KEY,
    status VARCHAR(64) NOT NULL,
    source_currency VARCHAR(12) NOT NULL,
    source_amount NUMERIC(24, 8) NOT NULL CHECK (source_amount > 0),
    destination_currency VARCHAR(12) NOT NULL,
    destination_amount NUMERIC(24, 8),
    provider VARCHAR(80) NOT NULL,
    quote JSONB NOT NULL,
    intent_data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS orchestration_intents_created_at_idx
    ON orchestration_intents (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS orchestration_intents_status_idx
    ON orchestration_intents (status)`,
  `CREATE TABLE IF NOT EXISTS provider_events (
    id BIGSERIAL PRIMARY KEY,
    provider VARCHAR(80) NOT NULL,
    provider_event_id VARCHAR(255),
    event_type VARCHAR(120) NOT NULL,
    payload JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    processing_status VARCHAR(32) NOT NULL DEFAULT 'RECEIVED',
    UNIQUE (provider, provider_event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    actor_type VARCHAR(32) NOT NULL,
    actor_id VARCHAR(255),
    action VARCHAR(120) NOT NULL,
    resource_type VARCHAR(80) NOT NULL,
    resource_id VARCHAR(255),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

export async function initializeDatabase() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of schemaStatements) {
      await client.query(statement);
    }
    await client.query("COMMIT");
    return { initialized: true, tables: ["orchestration_intents", "provider_events", "audit_logs"] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
