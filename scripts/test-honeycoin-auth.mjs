import "dotenv/config";

const apiKey = process.env.HONEYCOIN_API_KEY;
const publicKey = process.env.HONEYCOIN_PUBLIC_KEY;
const base = process.env.HONEYCOIN_B2B_BASE_URL;

if (!apiKey || !publicKey || !base) {
  console.error("Missing HoneyCoin credentials or B2B base URL.");
  process.exit(1);
}

try {
  const response = await fetch(
    `${base.replace(/\/+$/, "")}/auth/generate-bearer-token`,
    {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ publicKey })
    }
  );

  const body = await response.json().catch(() => ({}));

  console.log("HTTP status:", response.status);
  console.log("Success:", body.success === true);
  console.log("Bearer token issued:", Boolean(body.token));
  console.log("Expires at:", body.expiresAt ?? "Not supplied");
  if (!response.ok) {
    console.log("Error:", body.message ?? body.error ?? "Authentication failed");
  }
} catch (error) {
  console.error("Connection failed:", error.message);
  process.exit(1);
}
