export const providerOrderSchemaStatement = `
  CREATE TABLE IF NOT EXISTS provider_order_attempts (
    attempt_id UUID PRIMARY KEY,
    transfer_id UUID NOT NULL UNIQUE REFERENCES transfers(transfer_id),
    provider VARCHAR(80) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    status VARCHAR(24) NOT NULL CHECK (status IN ('SUBMITTING','ACCEPTED','REJECTED','UNKNOWN')),
    provider_order_id VARCHAR(255),
    provider_status VARCHAR(64),
    request_payload JSONB NOT NULL,
    response_payload JSONB,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS provider_order_attempts_status_idx
    ON provider_order_attempts(status, updated_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS provider_order_attempts_provider_order_idx
    ON provider_order_attempts(provider, provider_order_id)
    WHERE provider_order_id IS NOT NULL;
`;
