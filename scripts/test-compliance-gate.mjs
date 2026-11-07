// M1 compliance gate end-to-end test
const BASE = "http://localhost:3000";
const OPERATOR = "Bearer 6c5092c14a24f4f4e4be89d489aa6e076b10e50528eae3d0e5931785967c64e0";

function line(label, value) {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

const ben = await fetch(`${BASE}/api/transfers/beneficiaries`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ customerId: "cust-gate-test", details: { name: "Tayo Bello", country: "NG", currency: "NGN", accountNumber: "0123456789", bankName: "GTBank" } }),
}).then((r) => r.json());
line("beneficiary", ben.beneficiary.beneficiaryId ?? ben);

const created = await fetch(`${BASE}/api/transfers`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Idempotency-Key": "gate-test-" + Date.now() },
  body: JSON.stringify({ customerId: "cust-gate-test", beneficiaryId: ben.beneficiary.beneficiaryId, from: "USDC", to: "NGN", amount: 50 }),
}).then((r) => r.json());
const transferId = created.transfer?.transferId;
line("transfer", transferId ?? created);

// Non-compliant customer tries to advance: expect 403
const blocked = await fetch(`${BASE}/api/transfers/${transferId}/status`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Authorization: OPERATOR },
  body: JSON.stringify({ customerId: "cust-gate-test", status: "QUOTED" }),
});
const blockedBody = await blocked.json();
line("non-compliant PATCH ->", `${blocked.status} ${JSON.stringify(blockedBody)}`);

// Submit a clean compliance case: simulator auto-approves
const ok = await fetch(`${BASE}/api/compliance/cases`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ customerId: "cust-gate-test", subjectType: "INDIVIDUAL", subject: { fullName: "Ada Lovelace", country: "NG" } }),
}).then((r) => r.json());
line("compliance case", `${ok.case.status} (${ok.case.caseId})`);

// Same transition now passes
const allowed = await fetch(`${BASE}/api/transfers/${transferId}/status`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Authorization: OPERATOR },
  body: JSON.stringify({ customerId: "cust-gate-test", status: "QUOTED" }),
});
line("approved PATCH ->", `${allowed.status} ${JSON.stringify(await allowed.json())}`);
