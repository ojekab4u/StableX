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
  `CREATE TABLE IF NOT EXISTS beneficiaries (
    beneficiary_id UUID PRIMARY KEY, customer_id VARCHAR(128) NOT NULL,
    encrypted_details JSONB NOT NULL, details_fingerprint CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, details_fingerprint)
  )`,
  `CREATE INDEX IF NOT EXISTS beneficiaries_customer_idx ON beneficiaries (customer_id)`,
  `CREATE TABLE IF NOT EXISTS transfers (
    transfer_id UUID PRIMARY KEY, customer_id VARCHAR(128) NOT NULL,
    beneficiary_id UUID NOT NULL REFERENCES beneficiaries(beneficiary_id),
    source_currency VARCHAR(12) NOT NULL, source_amount NUMERIC(24,8) NOT NULL CHECK (source_amount > 0),
    destination_currency VARCHAR(12) NOT NULL, destination_amount NUMERIC(24,8),
    status VARCHAR(40) NOT NULL, quote_data JSONB, failure_reason TEXT,
    idempotency_key VARCHAR(128) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (customer_id, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS transfers_customer_created_idx ON transfers (customer_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS transfers_status_idx ON transfers (status)`,
  `CREATE TABLE IF NOT EXISTS transfer_events (
    event_id BIGSERIAL PRIMARY KEY, transfer_id UUID NOT NULL REFERENCES transfers(transfer_id),
    from_status VARCHAR(40), to_status VARCHAR(40) NOT NULL, actor_type VARCHAR(32) NOT NULL,
    actor_id VARCHAR(128), reason TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS transfer_events_transfer_idx ON transfer_events (transfer_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS compliance_cases (
    case_id UUID PRIMARY KEY, customer_id VARCHAR(128) NOT NULL,
    subject_type VARCHAR(16) NOT NULL CHECK (subject_type IN ('INDIVIDUAL','BUSINESS')),
    requirement VARCHAR(8) NOT NULL CHECK (requirement IN ('KYC','KYB','AML')),
    subject_data JSONB NOT NULL,
    screening JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(20) NOT NULL CHECK (status IN ('SUBMITTED','IN_REVIEW','APPROVED','REJECTED')),
    provider_status VARCHAR(32),
    decision_reason TEXT,
    provider VARCHAR(40) NOT NULL,
    provider_reference VARCHAR(255),
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS compliance_cases_customer_idx ON compliance_cases (customer_id)`,
  `ALTER TABLE compliance_cases ADD COLUMN IF NOT EXISTS provider_status VARCHAR(32)`,
  `UPDATE compliance_cases SET provider_reference=screening->>'voveCaseId' WHERE provider='VOVE ID' AND provider_reference IS NULL AND screening ? 'voveCaseId'`,
  `UPDATE compliance_cases SET status='SUBMITTED', provider_status=COALESCE(provider_status, 'NOT_STARTED'), decision_reason=NULL, decided_at=NULL WHERE provider='VOVE ID' AND status='APPROVED' AND (decision_reason ILIKE '%Auto-approved for demo%' OR decision_reason ILIKE '%sandbox simulation mode%')`,
  `UPDATE compliance_cases SET screening=screening - 'voveToken' - 'verificationUrl' WHERE screening ? 'voveToken' OR screening ? 'verificationUrl'`,
  `CREATE INDEX IF NOT EXISTS compliance_cases_status_idx ON compliance_cases (status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS compliance_cases_provider_reference_idx ON compliance_cases (provider, provider_reference) WHERE provider_reference IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS routing_quotes (
    quote_id UUID PRIMARY KEY, provider VARCHAR(80) NOT NULL,
    from_currency VARCHAR(12) NOT NULL, to_currency VARCHAR(12) NOT NULL,
    source_amount NUMERIC(24,8) NOT NULL, quote_data JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    selected_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS routing_quotes_expiry_idx ON routing_quotes (expires_at)`

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
    return { initialized: true, tables: ["orchestration_intents", "provider_events", "audit_logs", "beneficiaries", "transfers", "transfer_events", "compliance_cases", "routing_quotes"] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
