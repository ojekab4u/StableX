import { getPool } from "../db/pool.js";

export async function getPaytrieCustomerByStableXId(customerId) {
  const result = await getPool().query(
    `SELECT customer_id AS "customerId",
       provider_user_id AS "providerUserId",
       email,
       provider_status AS "providerStatus",
       onboarding_status AS "onboardingStatus",
       created_at AS "createdAt",
       updated_at AS "updatedAt"
     FROM paytrie_customers WHERE customer_id=$1 LIMIT 1`,
    [customerId]
  );
  return result.rows[0] || null;
}

export async function getPaytrieCustomerByProviderUserId(providerUserId) {
  const result = await getPool().query(
    `SELECT customer_id AS "customerId",
       provider_user_id AS "providerUserId",
       email,
       provider_status AS "providerStatus",
       onboarding_status AS "onboardingStatus"
     FROM paytrie_customers WHERE provider_user_id=$1 LIMIT 1`,
    [providerUserId]
  );
  return result.rows[0] || null;
}

export async function getPaytrieCustomerByEmail(email) {
  const result = await getPool().query(
    `SELECT customer_id AS "customerId",
       provider_user_id AS "providerUserId",
       email,
       provider_status AS "providerStatus",
       onboarding_status AS "onboardingStatus"
     FROM paytrie_customers WHERE LOWER(email)=LOWER($1) LIMIT 1`,
    [email]
  );
  return result.rows[0] || null;
}

export async function upsertPaytrieCustomer({
  customerId, providerUserId, email, providerStatus, onboardingStatus,
}) {
  const result = await getPool().query(
    `INSERT INTO paytrie_customers
       (customer_id, provider_user_id, email, provider_status, onboarding_status)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (customer_id) DO UPDATE SET
       provider_user_id=EXCLUDED.provider_user_id,
       email=EXCLUDED.email,
       provider_status=COALESCE(EXCLUDED.provider_status,paytrie_customers.provider_status),
       onboarding_status=EXCLUDED.onboarding_status,
       updated_at=NOW()
     RETURNING customer_id AS "customerId",
       provider_user_id AS "providerUserId",
       email,
       provider_status AS "providerStatus",
       onboarding_status AS "onboardingStatus",
       created_at AS "createdAt",
       updated_at AS "updatedAt"`,
    [customerId, providerUserId, email.toLowerCase(), providerStatus || null, onboardingStatus || "REGISTERED"]
  );
  return result.rows[0];
}

export async function updatePaytrieCustomerStatusByProviderUserId({ providerUserId, email, status }) {
  const result = await getPool().query(
    `UPDATE paytrie_customers SET
       provider_status=$3,
       onboarding_status=CASE WHEN LOWER($3)='verified' THEN 'VERIFIED'
         WHEN LOWER($3)='rejected' THEN 'REJECTED'
         WHEN LOWER($3)='in-review' THEN 'IN_REVIEW'
         WHEN LOWER($3)='upload' THEN 'ACTION_REQUIRED'
         ELSE onboarding_status END,
       updated_at=NOW()
     WHERE provider_user_id=$1 AND LOWER(email)=LOWER($2)
     RETURNING customer_id AS "customerId",
       provider_user_id AS "providerUserId",
       email,
       provider_status AS "providerStatus",
       onboarding_status AS "onboardingStatus"`,
    [providerUserId, email, status]
  );
  return result.rows[0] || null;
}

export async function insertPaytrieWebhookEvent({ eventId, eventType }) {
  const result = await getPool().query(
    `INSERT INTO paytrie_webhook_events(event_id,event_type,processing_status)
     VALUES($1,$2,'RECEIVED')
     ON CONFLICT(event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, eventType]
  );
  return Boolean(result.rowCount);
}

export async function markPaytrieWebhookEvent({ eventId, status, errorMessage = null }) {
  await getPool().query(
    `UPDATE paytrie_webhook_events SET
       processing_status=$2, error_message=$3, processed_at=NOW()
     WHERE event_id=$1`,
    [eventId, status, errorMessage ? String(errorMessage).slice(0, 1000) : null]
  );
}
