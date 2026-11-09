import { randomUUID } from "node:crypto";
import { getPool } from "../db/pool.js";

export async function saveBridgeTosLink({ customerId, url }) {
  const id = randomUUID();
  const result = await getPool().query(
    `INSERT INTO provider_customers
       (id, provider, customer_id, onboarding_status, tos_url)
     VALUES ($1, 'Bridge', $2, 'TOS_LINK_ISSUED', $3)
     ON CONFLICT (provider, customer_id) DO UPDATE
       SET tos_url=EXCLUDED.tos_url,
           onboarding_status=CASE
             WHEN provider_customers.signed_agreement_id IS NOT NULL THEN provider_customers.onboarding_status
             ELSE 'TOS_LINK_ISSUED' END,
           updated_at=NOW()
     RETURNING customer_id AS "customerId",
       onboarding_status AS "onboardingStatus",
       tos_url AS "tosUrl",
       signed_agreement_id AS "signedAgreementId",
       provider_customer_id AS "providerCustomerId"`,
    [id, customerId, url]
  );
  return result.rows[0];
}

export async function saveBridgeSignedAgreement({ customerId, signedAgreementId }) {
  const result = await getPool().query(
    `INSERT INTO provider_customers
       (id, provider, customer_id, onboarding_status, signed_agreement_id)
     VALUES ($1, 'Bridge', $2, 'TOS_ACCEPTED', $3)
     ON CONFLICT (provider, customer_id) DO UPDATE
       SET signed_agreement_id=EXCLUDED.signed_agreement_id,
           onboarding_status='TOS_ACCEPTED',
           updated_at=NOW()
     RETURNING customer_id AS "customerId",
       onboarding_status AS "onboardingStatus",
       signed_agreement_id AS "signedAgreementId",
       provider_customer_id AS "providerCustomerId"`,
    [randomUUID(), customerId, signedAgreementId]
  );
  return result.rows[0];
}

export async function saveBridgeCustomerId({ customerId, providerCustomerId, status }) {
  const result = await getPool().query(
    `UPDATE provider_customers
     SET provider_customer_id=$1,
         onboarding_status=$2,
         updated_at=NOW()
     WHERE provider='Bridge' AND customer_id=$3
     RETURNING customer_id AS "customerId",
       provider_customer_id AS "providerCustomerId",
       onboarding_status AS "onboardingStatus",
       signed_agreement_id AS "signedAgreementId"`,
    [providerCustomerId, status || "CUSTOMER_CREATED", customerId]
  );
  return result.rows[0] || null;
}

export async function getBridgeOnboarding(customerId) {
  const result = await getPool().query(
    `SELECT customer_id AS "customerId",
       provider_customer_id AS "providerCustomerId",
       onboarding_status AS "onboardingStatus",
       tos_url AS "tosUrl",
       signed_agreement_id AS "signedAgreementId"
     FROM provider_customers
     WHERE provider='Bridge' AND customer_id=$1 LIMIT 1`,
    [customerId]
  );
  return result.rows[0] || null;
}
