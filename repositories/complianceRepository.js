import { getPool } from "../db/pool.js";

const SELECT = `SELECT case_id AS "caseId", customer_id AS "customerId",
  subject_type AS "subjectType", requirement, subject_data AS subject,
  screening, status, decision_reason AS "decisionReason",
  provider, provider_reference AS "providerReference",
  decided_at AS "decidedAt", created_at AS "createdAt",
  updated_at AS "updatedAt" FROM compliance_cases`;

export async function saveComplianceCase({ id, customerId, subjectType, requirement, subject, screening, status, decisionReason, provider, providerReference, decidedAt }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO compliance_cases(case_id, customer_id, subject_type, requirement, subject_data, screening, status, decision_reason, provider, provider_reference, decided_at)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11)
       RETURNING case_id AS "caseId"`,
      [id, customerId, subjectType, requirement, JSON.stringify(subject), JSON.stringify(screening), status, decisionReason ?? null, provider, providerReference ?? null, decidedAt ?? null]
    );
    // Screening results that produced a decision are recorded automatically.
    if (decidedAt) {
      await client.query(
        `INSERT INTO audit_logs(actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES('SYSTEM','COMPLIANCE_SIMULATOR','COMPLIANCE_CASE_DECIDED','COMPLIANCE_CASE',$1,$2::jsonb)`,
        [id, JSON.stringify({ customerId, requirement, status, decisionReason: decisionReason ?? null })]
      );
    }
    await client.query(
      `INSERT INTO audit_logs(actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES('SYSTEM','COMPLIANCE_SIMULATOR','COMPLIANCE_CASE_CREATED','COMPLIANCE_CASE',$1,$2::jsonb)`,
      [id, JSON.stringify({ customerId, requirement, subjectType, screeningMethod: screening.method ?? null })]
    );
    await client.query("COMMIT");
    const found = await client.query(`${SELECT} WHERE case_id=$1`, [id]);
    return found.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readComplianceCase(caseId) {
  const result = await getPool().query(`${SELECT} WHERE case_id=$1`, [caseId]);
  return result.rows[0] || null;
}

export async function readComplianceCasesForCustomer(customerId) {
  const result = await getPool().query(`${SELECT} WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`, [customerId]);
  return result.rows;
}

export async function updateComplianceCaseStatus({ caseId, status, reason, actorId }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query("SELECT status FROM compliance_cases WHERE case_id=$1 FOR UPDATE", [caseId]);
    if (!current.rowCount) {
      const error = new Error("Compliance case not found.");
      error.statusCode = 404;
      throw error;
    }
    const previous = current.rows[0].status;
    if (previous === "APPROVED" || previous === "REJECTED") {
      const error = new Error(`Compliance case is already ${previous.toLowerCase()} and cannot be decided again.`);
      error.statusCode = 409;
      throw error;
    }
    if (!["APPROVED", "REJECTED"].includes(status)) {
      const error = new Error("Operator decision must be APPROVED or REJECTED.");
      error.statusCode = 400;
      throw error;
    }
    const updated = await client.query(
      `UPDATE compliance_cases SET status=$1, decision_reason=$2, decided_at=NOW(), updated_at=NOW()
       WHERE case_id=$3 RETURNING case_id AS "caseId", status, decided_at AS "decidedAt"`,
      [status, reason || null, caseId]
    );
    await client.query(
      `INSERT INTO audit_logs(actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES('OPERATOR',$1,'COMPLIANCE_CASE_DECIDED','COMPLIANCE_CASE',$2,$3::jsonb)`,
      [actorId || "LOCAL_OPERATOR", caseId, JSON.stringify({ from: previous, to: status, reason: reason || null })]
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
