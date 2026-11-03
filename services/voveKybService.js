import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";

const SANDBOX_URL = "https://api.voveid.net/v2";
const cases = new Map();

function config() {
  const apiKey = process.env.VOVE_ID_API_KEY;
  const publicKey = process.env.VOVE_ID_PUBLIC_KEY;
  if (!apiKey || !publicKey) {
    const error = new Error("VOVE sandbox is not configured. Set VOVE_ID_API_KEY and VOVE_ID_PUBLIC_KEY on the server.");
    error.statusCode = 503;
    throw error;
  }
  return {
    apiKey,
    publicKey,
    baseUrl: process.env.VOVE_ID_API_BASE_URL || SANDBOX_URL,
    environment: process.env.VOVE_ID_ENVIRONMENT || "Sandbox",
    flowId: process.env.VOVE_ID_KYB_FLOW_ID || undefined,
  };
}

export function getVoveKybReadiness() {
  const required = ["VOVE_ID_API_KEY", "VOVE_ID_PUBLIC_KEY"];
  const missing = required.filter((key) => !process.env[key]);
  return {
    provider: "VOVE ID",
    environment: process.env.VOVE_ID_ENVIRONMENT || "Sandbox",
    baseUrl: process.env.VOVE_ID_API_BASE_URL || SANDBOX_URL,
    configured: missing.length === 0,
    status: missing.length ? "AWAITING_SANDBOX_CREDENTIALS" : "CREDENTIALS_PRESENT_CONNECTION_NOT_TESTED",
    missing,
    executionEnabled: false,
    note: "VOVE verification can be tested in sandbox. A created case is not an approval; the verification outcome must be reviewed.",
  };
}

export async function createVoveKybCase({ businessName, country, registrationNumber, city, address }) {
  const settings = config();
  const refId = `stablex_${randomUUID()}`;
  const payload = {
    businessName,
    refId,
    ...(settings.flowId ? { flow: settings.flowId } : {}),
    formData: {
      ...(registrationNumber ? { registrationNumber } : {}),
      ...(country ? { country } : {}),
      ...(city ? { city } : {}),
      ...(address ? { address } : {}),
    },
  };

  const response = await fetch(`${settings.baseUrl}/kyb/case`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });

  const raw = await response.text();
  let result;
  try { result = raw ? JSON.parse(raw) : {}; }
  catch { result = { message: raw.slice(0, 1000) }; }

  if (!response.ok) {
    const error = new Error(result.message || result.error || `VOVE returned HTTP ${response.status}`);
    error.statusCode = response.status >= 500 ? 502 : 400;
    error.providerStatus = response.status;
    throw error;
  }

  const kybCase = result.kybCase || {};
  if (!result.token || !kybCase.refId) {
    const error = new Error("VOVE response did not include the expected KYB case reference and hosted-session token.");
    error.statusCode = 502;
    throw error;
  }

  const link = new URL("https://web.voveid.com/kyb/");
  link.searchParams.set("authToken", result.token);
  link.searchParams.set("publicKey", settings.publicKey);
  link.searchParams.set("environment", settings.environment);

  const record = {
    provider: "VOVE ID",
    refId: kybCase.refId,
    businessName,
    country,
    status: kybCase.status || "NOT_STARTED",
    flow: kybCase.flow || settings.flowId || null,
    verificationUrl: link.toString(),
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    environment: settings.environment,
    providerResponse: {
      refId: kybCase.refId,
      status: kybCase.status || "NOT_STARTED",
      flow: kybCase.flow || settings.flowId || null,
    },
  };
  cases.set(record.refId, record);
  return record;
}

export function getVoveKybCase(refId) {
  return cases.get(refId) || null;
}

export function applyVoveKybWebhook(event) {
  const data = event?.data || {};
  const refId = data.refId || data.kybCase?.refId;
  if (!refId) return { updated: false, reason: "Webhook did not include a case refId." };
  const record = cases.get(refId);
  if (!record) return { updated: false, reason: "Case is not present in this running StableX process." };

  const type = String(event.type || "");
  const status = data.status || data.kybCase?.status ||
    (type.endsWith(".completed") ? "COMPLETED" : type.endsWith(".rejected") ? "REJECTED" : null);
  if (status) record.status = status;
  record.lastUpdatedAt = new Date().toISOString();
  record.lastWebhookEvent = type;
  return { updated: true, refId, status: record.status };
}

export function verifyVoveWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const received = Buffer.from(signature);
  const calculated = Buffer.from(expected);
  return received.length === calculated.length && timingSafeEqual(received, calculated);
}
