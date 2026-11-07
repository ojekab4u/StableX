// M2 quote & routing engine end-to-end test
const BASE = "http://localhost:3000";

function line(label, value) {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

async function json(res) { return res.json(); }

// 1. Non-compliant customer should NOT be able to select a quote
// 2. Compliant customer (cust-001 approved in M1) selects best quote
const compliantCustomer = "cust-001";

// Create transfer for a NON-compliant customer
const ben = await fetch(`${BASE}/api/transfers/beneficiaries`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ customerId: "cust-routing-test", details: { name: "Tayo Bello", country: "NG", currency: "NGN", accountNumber: "0123456789", bankName: "GTBank" } }),
}).then(json);
const benId = ben.beneficiary.beneficiaryId;
line("beneficiary", benId);

const created = await fetch(`${BASE}/api/transfers`, {
  method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "routing-test-" + Date.now() },
  body: JSON.stringify({ customerId: "cust-routing-test", beneficiaryId: benId, from: "USDC", to: "NGN", amount: 100 }),
}).then(json);
const transferId = created.transfer.transferId;
line("draft transfer", `${transferId} (${created.transfer.status})`);

// Get unified quotes for USDC -> NGN
const quotes = await fetch(`${BASE}/api/routing/quotes`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ from: "USDC", to: "NGN", amount: 100 }),
}).then(json);
line("quote summary", {
  quoteType: quotes.quoteType,
  ranked: quotes.candidates.map((q) => `${q.provider} [${q.providerClass}] net=${q.destinationAmount} ${q.to}`),
  unavailable: quotes.unavailableProviders.map((u) => `${u.provider}: ${u.reason}`),
});

// Non-compliant selection attempt -> expect 403
const best = quotes.candidates[0];
const blocked = await fetch(`${BASE}/api/routing/select`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ customerId: "cust-routing-test", transferId, quoteId: best.quoteId }),
});
line("non-compliant select ->", `${blocked.status} ${JSON.stringify(await blocked.json())}`);

// Compliant customer creates their own matching transfer and selects
const benOk = await fetch(`${BASE}/api/transfers/beneficiaries`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ customerId: compliantCustomer, details: { name: "Ada Lovelace", country: "NG", currency: "NGN", accountNumber: "0987654321", bankName: "Access Bank" } }),
}).then(json);
const transferOk = await fetch(`${BASE}/api/transfers`, {
  method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "routing-ok-" + Date.now() },
  body: JSON.stringify({ customerId: compliantCustomer, beneficiaryId: benOk.beneficiary.beneficiaryId, from: "USDC", to: "NGN", amount: 100 }),
}).then(json);
const okId = transferOk.transfer.transferId;
line("compliant draft", `${okId} (${transferOk.transfer.status})`);

const selected = await fetch(`${BASE}/api/routing/select`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ customerId: compliantCustomer, transferId: okId, quoteId: best.quoteId }),
});
const selectedBody = await selected.json();
line("compliant select ->", `${selected.status} ${JSON.stringify(selectedBody.transfer ?? selectedBody)}`);

// Double-select another quote -> expect 409 (no longer DRAFT)
const second = quotes.candidates[1];
const again = await fetch(`${BASE}/api/routing/select`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ customerId: compliantCustomer, transferId: okId, quoteId: second.quoteId }),
});
line("second select ->", `${again.status} ${JSON.stringify(await again.json())}`);
