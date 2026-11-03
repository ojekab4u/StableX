# StableX PostgreSQL foundation

StableX uses PostgreSQL through the `DATABASE_URL` environment variable.

## Configure

Add the Neon connection string to the server's local `.env` file:

```env
DATABASE_URL=postgresql://...
```

Do not commit `.env`, share the connection string, or expose it to browser code.

## Startup

The server initializes the initial schema automatically when `DATABASE_URL` is present. The initial tables are:

- `orchestration_intents`: durable quote/orchestration intent records.
- `provider_events`: provider webhook event inbox with duplicate-event protection when a provider event ID is supplied.
- `audit_logs`: append-oriented audit event storage.

This is an initial schema bootstrap, not yet a versioned migration framework. Future schema changes should move to numbered migrations before production use.

## Neon

Use the pooled connection string from Neon for application traffic where available. The application uses a small connection pool and TLS for Neon hosts. Keep the connection string server-side.
