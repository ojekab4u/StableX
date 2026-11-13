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
  `CREATE TABLE IF NOT EXISTS provider_orders (
    order_id UUID PRIMARY KEY,
    transfer_id UUID NOT NULL UNIQUE REFERENCES transfers(transfer_id),
    customer_id VARCHAR(128) NOT NULL,
    provider VARCHAR(80) NOT NULL,
    external_reference VARCHAR(255) NOT NULL UNIQUE,
    provider_transaction_id VARCHAR(255) UNIQUE,
    payment_method VARCHAR(24) NOT NULL,
    status VARCHAR(40) NOT NULL,
    provider_status VARCHAR(40),
    recipient_address VARCHAR(128) NOT NULL,
    payment_details JSONB,
    transaction_hash VARCHAR(80),
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS provider_orders_customer_idx ON provider_orders (customer_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS provider_orders_status_idx ON provider_orders (status)`,
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
  `CREATE INDEX IF NOT EXISTS routing_quotes_expiry_idx ON routing_quotes (expires_at)`,
  `CREATE TABLE IF NOT EXISTS wallet_accounts (
    wallet_id UUID PRIMARY KEY,
    customer_id VARCHAR(128) NOT NULL,
    asset_code VARCHAR(12) NOT NULL,
    country_code VARCHAR(2),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, asset_code)
  )`,
  `CREATE INDEX IF NOT EXISTS wallet_accounts_customer_idx ON wallet_accounts (customer_id)`,
  `CREATE TABLE IF NOT EXISTS wallet_ledger (
    entry_id UUID PRIMARY KEY,
    wallet_id UUID NOT NULL REFERENCES wallet_accounts(wallet_id),
    customer_id VARCHAR(128) NOT NULL,
    asset_code VARCHAR(12) NOT NULL,
    entry_type VARCHAR(24) NOT NULL CHECK (entry_type IN ('DEPOSIT','WITHDRAWAL','CONVERSION_CREDIT','CONVERSION_DEBIT','ADJUSTMENT','REVERSAL')),
    amount NUMERIC(24,8) NOT NULL CHECK (amount <> 0),
    reference VARCHAR(255) NOT NULL,
    provider VARCHAR(80),
    provider_event_id VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('PENDING','POSTED','REVERSED')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_event_id)
  )`,
  `CREATE INDEX IF NOT EXISTS wallet_ledger_customer_idx ON wallet_ledger (customer_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS wallet_ledger_wallet_idx ON wallet_ledger (wallet_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS payment_details (
    payment_detail_id UUID PRIMARY KEY,
    customer_id VARCHAR(128) NOT NULL,
    wallet_id UUID NOT NULL REFERENCES wallet_accounts(wallet_id),
    provider VARCHAR(80) NOT NULL,
    provider_reference VARCHAR(255) NOT NULL,
    currency VARCHAR(12) NOT NULL,
    details JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_reference)
  )`,
  `CREATE INDEX IF NOT EXISTS payment_details_customer_idx ON payment_details (customer_id)`,
  `CREATE TABLE IF NOT EXISTS provider_customers (
    id UUID PRIMARY KEY,
    provider VARCHAR(40) NOT NULL,
    customer_id VARCHAR(128) NOT NULL,
    provider_customer_id VARCHAR(255),
    onboarding_status VARCHAR(40) NOT NULL DEFAULT 'NOT_STARTED',
    tos_url TEXT,
    signed_agreement_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider, customer_id),
    UNIQUE(provider, provider_customer_id)
  )`,
  `ALTER TABLE provider_customers ADD COLUMN IF NOT EXISTS bridge_status VARCHAR(40)`,
  `ALTER TABLE provider_customers ADD COLUMN IF NOT EXISTS endorsements JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE provider_customers ADD COLUMN IF NOT EXISTS base_endorsement_status VARCHAR(40)`,
  `ALTER TABLE provider_customers ADD COLUMN IF NOT EXISTS sepa_endorsement_status VARCHAR(40)`,
  `ALTER TABLE provider_customers ADD COLUMN IF NOT EXISTS status_checked_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS external_wallets (
    external_wallet_id UUID PRIMARY KEY,
    customer_id VARCHAR(128) NOT NULL,
    address VARCHAR(128) NOT NULL,
    chain_id INTEGER NOT NULL,
    wallet_provider VARCHAR(64),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, chain_id, address)
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    account_id UUID PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    phone VARCHAR(32),
    password_hash VARCHAR(255) NOT NULL,
    account_type VARCHAR(16) NOT NULL CHECK (account_type IN ('PERSONAL','BUSINESS')),
    full_name VARCHAR(255) NOT NULL,
    business_name VARCHAR(255),
    country VARCHAR(2),
    date_of_birth VARCHAR(10),
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING_VERIFICATION'
      CHECK (status IN ('PENDING_VERIFICATION','ACTIVE','SUSPENDED','CLOSED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS country VARCHAR(2)`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS date_of_birth VARCHAR(10)`,
  `CREATE INDEX IF NOT EXISTS accounts_status_idx ON accounts (status)`,
  `CREATE TABLE IF NOT EXISTS verification_codes (
    code_id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    channel VARCHAR(8) NOT NULL CHECK (channel IN ('EMAIL','PHONE')),
    code_hash CHAR(64) NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS verification_codes_account_idx ON verification_codes (account_id, channel)`,
  `CREATE TABLE IF NOT EXISTS auth_sessions (
    session_id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS auth_sessions_account_idx ON auth_sessions (account_id)`,
  `CREATE TABLE IF NOT EXISTS paytrie_customer_sessions (
    customer_id VARCHAR(128) PRIMARY KEY,
    encrypted_token JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS paytrie_customer_sessions_expiry_idx ON paytrie_customer_sessions (expires_at)`,
  `CREATE TABLE IF NOT EXISTS paytrie_customers (
    customer_id VARCHAR(128) PRIMARY KEY,
    provider_user_id UUID NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    provider_status VARCHAR(40),
    onboarding_status VARCHAR(40) NOT NULL DEFAULT 'REGISTERED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS paytrie_customers_status_idx ON paytrie_customers (provider_status, onboarding_status)`,
  `CREATE TABLE IF NOT EXISTS paytrie_webhook_events (
    event_id VARCHAR(255) PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    processing_status VARCHAR(40) NOT NULL DEFAULT 'RECEIVED',
    error_message TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS paytrie_webhook_events_received_idx ON paytrie_webhook_events (received_at DESC)`

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
    return { initialized: true, tables: ["orchestration_intents", "provider_events", "audit_logs", "beneficiaries", "transfers", "transfer_events", "compliance_cases", "routing_quotes", "wallet_accounts", "wallet_ledger", "payment_details", "external_wallets", "provider_customers", "accounts", "verification_codes", "auth_sessions", "paytrie_customer_sessions", "paytrie_customers", "paytrie_webhook_events"] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
