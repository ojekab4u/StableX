// End-to-end compliance gate test. Uses a unique customer on every run so
// persistent PostgreSQL records from previous runs cannot contaminate results.
import { randomUUID } from "node:crypto";

const BASE = process.env.STABLEX_TEST_BASE_URL || "http://localhost:3000";
const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
if (!operatorToken) {
  throw new Error("Set STABLEX_OPERATOR_TOKEN in your environment before running this test.");
}
const OPERATOR = `Bearer ${operatorToken}`;
const customerId = `cust-gate-test-${randomUUID()}`;

function line(label, value) {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}
async function jsonRequest(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);
  const body = await response.json();
  return { status: response.status, body };
}

const benResult = await jsonRequest("/api/transfers/beneficiaries", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    customerId,
    details: { name: "StableX Compliance Test", country: "NG", currency: "NGN", accountNumber: "0123456789", bankName: "Test Bank" },
  }),
});
if (benResult.status !== 201) throw new Error(`Beneficiary creation failed: ${JSON.stringify(benResult.body)}`);
const beneficiaryId = benResult.body.beneficiary.beneficiaryId;
line("test customer", customerId);
line("beneficiary", beneficiaryId);

const transferResult = await jsonRequest("/api/transfers", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Idempotency-Key": `gate-test-${randomUUID()}` },
  body: JSON.stringify({ customerId, beneficiaryId, from: "USDC", to: "NGN", amount: 50 }),
});
if (transferResult.status !== 201) throw new Error(`Transfer creation failed: ${JSON.stringify(transferResult.body)}`);
const transferId = transferResult.body.transfer.transferId;
line("transfer", transferId);

const statusPath = `/api/transfers/${transferId}/status`;
const firstAttempt = await jsonRequest(statusPath, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Authorization: OPERATOR },
  body: JSON.stringify({ customerId, status: "QUOTED" }),
});
line("before compliance submission", `${firstAttempt.status} ${JSON.stringify(firstAttempt.body)}`);
if (firstAttempt.status !== 403) {
  throw new Error("Expected a fresh customer with no compliance case to be blocked with HTTP 403.");
}

const caseResult = await jsonRequest("/api/compliance/cases", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    customerId,
    subjectType: "INDIVIDUAL",
    subject: { fullName: "StableX Test Applicant", country: "NG" },
  }),
});
if (caseResult.status !== 201) throw new Error(`VOVE case creation failed: ${JSON.stringify(caseResult.body)}`);
const caseId = caseResult.body.case.caseId;
line("VOVE compliance case", { caseId, status: caseResult.body.case.status, providerStatus: caseResult.body.case.providerStatus, refId: caseResult.body.case.providerReference });

const stillBlocked = await jsonRequest(statusPath, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Authorization: OPERATOR },
  body: JSON.stringify({ customerId, status: "QUOTED" }),
});
line("after case creation (not an approval)", `${stillBlocked.status} ${JSON.stringify(stillBlocked.body)}`);
if (stillBlocked.status !== 403) {
  throw new Error("Creating a VOVE case must not itself approve the customer.");
}

const refresh = await jsonRequest(`/api/compliance/cases/${caseId}/refresh`, {
  method: "POST",
  headers: { Authorization: OPERATOR },
});
if (refresh.status !== 200) throw new Error(`VOVE status refresh failed: ${JSON.stringify(refresh.body)}`);
line("fetched VOVE status", refresh.body);

let gate = await jsonRequest(`/api/compliance/status?customerId=${encodeURIComponent(customerId)}`);
line("gate after VOVE refresh", gate.body.gate);

// A successful KYC provider result can satisfy the KYC gate. Pending results
// remain blocked until an explicitly authorized reviewer records a decision.
if (gate.body.gate?.status !== "APPROVED") {
  if (gate.body.gate?.status === "REJECTED") {
    throw new Error("VOVE returned a rejected result; this test customer must not advance.");
  }
  const decision = await jsonRequest(`/api/compliance/cases/${caseId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: OPERATOR },
    body: JSON.stringify({
      status: "APPROVED",
      reason: "TEST ONLY: authorized reviewer approval for compliance gate integration test.",
      actorId: "stablex-compliance-test",
    }),
  });
  if (decision.status !== 200) throw new Error(`Test operator decision failed: ${JSON.stringify(decision.body)}`);
  line("explicit test operator decision", decision.body.decision);
}

const allowed = await jsonRequest(statusPath, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Authorization: OPERATOR },
  body: JSON.stringify({ customerId, status: "QUOTED" }),
});
line("approved customer PATCH ->", `${allowed.status} ${JSON.stringify(allowed.body)}`);
if (allowed.status !== 200) throw new Error("Expected an approved test customer to transition DRAFT -> QUOTED.");
console.log("PASS: fresh customer blocked before verification; VOVE status fetched; only a real provider success or explicit operator decision opened the gate.");
