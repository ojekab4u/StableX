import "dotenv/config";

const base = process.env.FIATMATCH_BASE_URL?.replace(/\/+$/, "");
const apiKey = process.env.BUSINESS_SDK_API_KEY ||   process.env.FIATMATCH_SECRET_KEY;
const email = process.argv[2];

if (!base || !apiKey || !email) {
  console.error("Missing FIATMATCH_BASE_URL, FIATMATCH_SECRET_KEY, or customer email.");
  process.exit(1);
}

const apiBase = /\/api\/v1$/i.test(base) ? base : `${base}/api/v1`;
const url = `${apiBase}/sub-wallets/${encodeURIComponent(email)}`;

try {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "Accept": "application/json"
    }
  });

  const raw = await response.text();
  let body;

  try {
    body = JSON.parse(raw);
  } catch {
    body = { response: raw.slice(0, 1000) };
  }

  const redact = (value) => {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          /accountnumber|walletid|iban|accountname|email|secret|token/i.test(key)
            ? "[REDACTED]"
            : redact(item)
        ])
      );
    }
    return value;
  };

  console.log("HTTP status:", response.status);
  console.log("Response:", JSON.stringify(redact(body), null, 2));
} catch (error) {
  console.error("FiatMatch request failed:", error.message);
  process.exit(1);
}
