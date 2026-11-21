import crypto from "node:crypto";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// Circle Wallets (developer-controlled first: fully server-side, testable on
// testnet with a self-serve API key). User-controlled wallets (email/PIN,
// customer approves every send) are layered on with the Circle Web SDK.
export function getCircleReadiness() {
  const apiKey = process.env.CIRCLE_API_KEY || "";
  const environment = process.env.CIRCLE_ENVIRONMENT || "sandbox";
  return {
    configured: Boolean(apiKey),
    environment,
    baseUrl: baseUrl(environment),
  };
}

// Sandbox base for testnet USDC on Base Sepolia; production swaps to
// api.circle.com with the live key.
export function baseUrl(environment = process.env.CIRCLE_ENVIRONMENT || "sandbox") {
  return environment === "production" ? "https://api.circle.com" : "https://api-sandbox.circle.com";
}

function requireKey() {
  const key = process.env.CIRCLE_API_KEY;
  if (!key) {
    const error = new Error("Circle is not configured. Set CIRCLE_API_KEY (sandbox or production).");
    error.statusCode = 503;
    throw error;
  }
  return key;
}

async function circleFetch(path, { method = "GET", body } = {}) {
  const key = requireKey();
  const base = baseUrl();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || `Circle request failed with HTTP ${response.status}.`);
    error.statusCode = response.status >= 500 ? 502 : 400;
    error.providerResponse = payload;
    throw error;
  }
  return payload;
}

// Connectivity check against the configured environment.
export async function pingCircle() {
  const payload = await circleFetch("/v1/ping");
  return { provider: "Circle", environment: process.env.CIRCLE_ENVIRONMENT || "sandbox", pong: payload };
}

// Developer-controlled wallets need an entity key pair: the public key is
// registered with Circle once, and every mutating request is signed with the
// secret. Generated here; the secret stays in the operator's env only.
export function generateEntityKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}
