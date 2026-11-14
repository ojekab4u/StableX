import "dotenv/config";

const apiKey = process.env.HONEYCOIN_API_KEY;
const publicKey = process.env.HONEYCOIN_PUBLIC_KEY;
const base = (process.env.HONEYCOIN_B2B_BASE_URL || "").replace(/\/$/, "");

if (!apiKey || !publicKey || !base) {
  throw new Error("HoneyCoin credentials or B2B base URL are missing.");
}

async function call(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(20000)
  });

  const text = await response.text();
  let body;

  try {
    body = JSON.parse(text);
  } catch {
    body = { rawResponse: text };
  }

  console.log("HTTP status:", response.status);
  console.log(JSON.stringify(body, null, 2));

  if (!response.ok) {
    throw new Error(`HoneyCoin returned HTTP ${response.status}`);
  }

  return body;
}

console.log("1. Authenticating...");
const auth = await call(`${base}/auth/generate-bearer-token`, {
  method: "POST",
  headers: {
    "api-key": apiKey,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ publicKey })
});

if (!auth.token) throw new Error("No bearer token returned.");

console.log("\n2. Requesting NGN to USDC FX rate...");
const url = new URL(`${base}/utilities/rates`);
url.searchParams.set("from", "NGN");
url.searchParams.set("to", "USDC");
url.searchParams.set("amount", "10000");

await call(url, {
  headers: {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json"
  }
});
