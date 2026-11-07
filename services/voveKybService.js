import { randomUUID } from "node:crypto";
import { createHmac, timingSafeEqual } from "node:crypto";

const SANDBOX_URL = "https://api.voveid.net/v2";

function config() {
  const apiKey = process.env.VOVE_API_KEY || process.env.VOVE_ID_API_KEY;
  const publicKey = process.env.VOVE_PUBLIC_KEY || process.env.VOVE_ID_PUBLIC_KEY;
  const webhookSecret = process.env.VOVE_WEBHOOK_SECRET || process.env.VOVE_ID_WEBHOOK_SECRET;
  if (!apiKey || !publicKey) {
    const error = new Error("VOVE sandbox is not configured. Set VOVE_API_KEY and VOVE_PUBLIC_KEY on the server.");
    error.statusCode = 503;
    throw error;
  }
  return {
    apiKey,
    publicKey,
    webhookSecret,
    baseUrl: process.env.VOVE_ID_API_BASE_URL || SANDBOX_URL,
    environment: process.env.VOVE_ID_ENVIRONMENT || "Sandbox",
    flowId: process.env.VOVE_ID_KYB_FLOW_ID || undefined,
  };
}

export function getVoveKybReadiness() {
  const apiKey = process.env.VOVE_API_KEY || process.env.VOVE_ID_API_KEY;
  const publicKey = process.env.VOVE_PUBLIC_KEY || process.env.VOVE_ID_PUBLIC_KEY;
  const configured = Boolean(apiKey && publicKey);
  return {
    provider: "VOVE ID",
    environment: process.env.VOVE_ID_ENVIRONMENT || "Sandbox",
    baseUrl: process.env.VOVE_ID_API_BASE_URL || SANDBOX_URL,
    configured,
    status: configured ? "CREDENTIALS_PRESENT_CONNECTION_NOT_TESTED" : "AWAITING_SANDBOX_CREDENTIALS",
    missing: configured ? [] : ["VOVE_API_KEY / VOVE_ID_API_KEY", "VOVE_PUBLIC_KEY / VOVE_ID_PUBLIC_KEY"],
    executionEnabled: false,
    note: "VOVE verification can be tested in sandbox. KYC via /v2/sessions, KYB via /v2/sessions with KYB flowId.",
  };
}

export async function createVoveKycCase({ fullName, country, dateOfBirth, email, phone, type = "INDIVIDUAL", registrationNumber, city, address }) {
  const settings = config();
  const refId = `stablex_${type === "BUSINESS" ? "kyb" : "kyc"}_${randomUUID()}`;
  const payload = {
    refId,
    ...(settings.flowId ? { flowId: settings.flowId } : {}),
    fullName,
    country,
    ...(dateOfBirth ? { dateOfBirth } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(type === "BUSINESS" ? { type: "BUSINESS" } : {}),
    ...(registrationNumber ? { registrationNumber } : {}),
    ...(city ? { city } : {}),
    ...(address ? { address } : {}),
  };

  const response = await fetch(`${settings.baseUrl}/sessions`, {
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
  try { result = raw ? JSON.parse(raw) : {}; } catch { result = { message: raw.slice(0, 1000) }; }

  if (!response.ok) {
    const error = new Error(result.message || result.error || `VOVE returned HTTP ${response.status}`);
    error.statusCode = response.status >= 500 ? 502 : 400;
    error.providerStatus = response.status;
    throw error;
  }

  const token = result.token || result.sessionToken;
  if (!token) {
    throw new Error("VOVE response did not include a session token.");
  }

  const link = new URL("https://web.voveid.net/");
  link.searchParams.set("authToken", token);
  link.searchParams.set("publicKey", settings.publicKey);
  link.searchParams.set("environment", settings.environment);

  const record = {
    provider: "VOVE ID",
    refId,
    fullName,
    country,
    status: "NOT_STARTED",
    flow: settings.flowId || null,
    verificationUrl: link.toString(),
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    environment: settings.environment,
    providerResponse: {
      refId,
      status: "NOT_STARTED",
      flow: settings.flowId || null,
      token,
    },
  };
  return record;
}

export async function getVoveKycResult(refId, { subjectType = "INDIVIDUAL" } = {}) {
  const settings = config();

  if (subjectType === "BUSINESS") {
    const url = new URL(`${settings.baseUrl}/kyb/case`);
    url.searchParams.set("search", refId);
    url.searchParams.set("limit", "1");
    const response = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": settings.apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      const payload = await response.json();
      const records = Array.isArray(payload.data) ? payload.data : [];
      const record = records.find((item) => item.refId === refId) ||
        (payload.kybCase?.refId === refId ? payload.kybCase : null);
      if (record) return record;
    } else if (response.status >= 500) {
      const error = new Error(`VOVE KYB result retrieval failed (${response.status})`);
      error.statusCode = 502;
      throw error;
    }
    // Older hosted-session configurations may expose the result through /users.
  }

  const response = await fetch(`${settings.baseUrl}/users/${encodeURIComponent(refId)}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const error = new Error(`VOVE result retrieval failed (${response.status})`);
    error.statusCode = 502;
    throw error;
  }
  return await response.json();
}

export function verifyVoveWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const received = Buffer.from(signature);
  const calculated = Buffer.from(expected);
  return received.length === calculated.length && timingSafeEqual(received, calculated);
}
