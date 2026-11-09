import "dotenv/config";

const apiKey = process.env.HONEYCOIN_API_KEY;
const publicKey = process.env.HONEYCOIN_PUBLIC_KEY;

const authBase = "https://api-v2.honeycoin.app/api/sandbox/b2b";
const cryptoBase = "https://crypto.honeycoin.app/api/sandbox";

if (!apiKey || !publicKey) {
  throw new Error("HoneyCoin credentials are missing.");
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.success === false) {
    throw new Error(
      `HTTP ${response.status}: ${body.message || body.error || JSON.stringify(body)}`
    );
  }

  return body;
}

try {
  console.log("Authenticating with HoneyCoin...");

  const auth = await request(
    `${authBase}/auth/generate-bearer-token`,
    {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ publicKey })
    }
  );

  if (!auth.token) throw new Error("No bearer token returned.");

  console.log("Authentication successful.");
  console.log("Creating Base sandbox wallet...");

  const wallet = await request(
    `${cryptoBase}/wallets/addresses`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ chain: "BASE" })
    }
  );

  console.log("Wallet creation response:");
  console.log(JSON.stringify(wallet, null, 2));

} catch (error) {
  console.error("HoneyCoin wallet creation failed:", error.message);
  process.exit(1);
}
