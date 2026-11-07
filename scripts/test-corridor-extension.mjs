// M2.5 corridor extension regression test: multi-leg composition + full sim coverage
const BASE = "http://localhost:3000";

async function quotes(from, to, amount) {
  const res = await fetch(`${BASE}/api/routing/quotes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, amount }),
  });
  return { status: res.status, data: await res.json() };
}

function show(label, { status, data }) {
  console.log(`\n=== ${label} (HTTP ${status}) quoteType=${data.quoteType} ===`);
  for (const q of data.candidates ?? []) {
    console.log(`  ${q.providerClass.padEnd(10)} ${q.provider.padEnd(46)} ${q.destinationAmount ?? "?"} ${q.to}`);
  }
  for (const u of data.unavailableProviders ?? []) {
    console.log(`  UNAVAILABLE ${u.provider}: ${u.reason}`);
  }
  if (data.error) console.log("  ERROR:", data.error);
}

// 1. Regression: textbook corridor with a real provider
show("USDC -> NGN", await quotes("USDC", "NGN", 100));

// 2. Corridor with NO direct provider: expect COMPOSED multi-leg quotes
show("NGN -> CAD", await quotes("NGN", "CAD", 100000));

// 3. African corridor not yet on Paycrest's public list: expect COMPOSED
show("NGN -> GHS", await quotes("NGN", "GHS", 50000));

// 4. EUR corridor (new asset added to the registry)
show("USDC -> EUR", await quotes("USDC", "EUR", 100));
