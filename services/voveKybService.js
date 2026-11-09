import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";

const SANDBOX_URL = "https://api.voveid.net/v2";
const HOSTED_SANDBOX_URL = "https://web.voveid.net";
const HOSTED_PRODUCTION_URL = "https://web.voveid.com";

function config() {
  const apiKey = process.env.VOVE_API_KEY || process.env.VOVE_ID_API_KEY;
  const publicKey = process.env.VOVE_PUBLIC_KEY || process.env.VOVE_ID_PUBLIC_KEY;
  const webhookSecret = process.env.VOVE_WEBHOOK_SECRET || process.env.VOVE_ID_WEBHOOK_SECRET;
  if (!apiKey || !publicKey) {
    const error = new Error("VOVE sandbox is not configured. Set VOVE_API_KEY and VOVE_PUBLIC_KEY on the server.");
    error.statusCode = 503;
    throw error;
  }
  const baseUrl = process.env.VOVE_ID_API_BASE_URL || SANDBOX_URL;
  const environment = process.env.VOVE_ID_ENVIRONMENT || "Sandbox";
  return {
    apiKey, publicKey, webhookSecret,
    baseUrl,
    // VOVE's API conventions: KYC routes begin with /v2, KYB and AML routes
    // are unversioned. The configured base URL usually includes /v2, so derive
    // the versionless root for KYB calls.
    rootBaseUrl: baseUrl.replace(/\/v2\/?$/, ""),
    environment,
    hostedBaseUrl: environment === "Production" ? HOSTED_PRODUCTION_URL : HOSTED_SANDBOX_URL,
    kycFlowId: process.env.VOVE_ID_KYC_FLOW_ID || undefined,
    kybFlowId: process.env.VOVE_ID_KYB_FLOW_ID || undefined,
  };
}

async function voveRequest(path, { method = "GET", body } = {}) {
  const settings = config();
  const response = await fetch(`${settings.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "x-api-key": settings.apiKey,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { payload = { message: raw.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `VOVE request failed (${response.status})`);
    error.statusCode = response.status === 401 || response.status === 403 ? 502 : response.status >= 500 ? 502 : 400;
    error.providerStatus = response.status;
    throw error;
  }
  return payload;
}

async function voveRequestRoot(path, { method = "GET", body } = {}) {
  const settings = config();
  const response = await fetch(`${settings.rootBaseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "x-api-key": settings.apiKey,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { payload = { message: raw.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `VOVE request failed (${response.status})`);
    error.statusCode = response.status === 401 || response.status === 403 ? 502 : response.status >= 500 ? 502 : 400;
    error.providerStatus = response.status;
    throw error;
  }
  return payload;
}

function buildKycLink(token, settings) {
  const url = new URL(settings.hostedBaseUrl + "/");
  url.searchParams.set("authToken", token);
  url.searchParams.set("publicKey", settings.publicKey);
  url.searchParams.set("environment", settings.environment);
  return url.toString();
}

function buildKybLink(token, settings) {
  const url = new URL(settings.hostedBaseUrl + "/kyb");
  url.searchParams.set("authToken", token);
  url.searchParams.set("publicKey", settings.publicKey);
  url.searchParams.set("environment", settings.environment);
  return url.toString();
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
    note: "KYC uses POST /sessions and GET /users/{refId}; KYB uses POST /kyb/case and GET /kyb/case?search={refId}&limit=1. Hosted-flow completion is not automatically an internal approval.",
  };
}

export async function createVoveKycCase({ fullName, country, dateOfBirth, email, phone }) {
  const settings = config();
  const refId = `stablex_kyc_${randomUUID()}`;
  const payload = {
    refId,
    ...(settings.kycFlowId ? { flowId: settings.kycFlowId } : {}),
    fullName, country,
    ...(dateOfBirth ? { dateOfBirth } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
  };
  const result = await voveRequest("/sessions", { method: "POST", body: payload });
  const token = result.token || result.sessionToken;
  if (!token) throw new Error("VOVE KYC session response did not include a session token.");
  return {
    provider: "VOVE ID", refId, fullName, country,
    status: result.status || "NOT_STARTED",
    flow: settings.kycFlowId || null,
    verificationUrl: buildKycLink(token, settings),
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    environment: settings.environment,
    providerResponse: { refId, status: result.status || "NOT_STARTED", flow: settings.kycFlowId || null },
  };
}

export async function createVoveKybCase({ businessName, country, registrationNumber, city, address }) {
  const settings = config();
  const refId = `stablex_kyb_${randomUUID()}`;
  // VOVE's documented create contract accepts only refId and the optional flow;
  // the applicant supplies business data inside the hosted case journey.
  const payload = {
    refId,
    ...(settings.kybFlowId ? { flow: settings.kybFlowId } : {}),
  };
  const result = await voveRequestRoot("/kyb/case", { method: "POST", body: payload });
  const kybCase = result.kybCase || result.data?.kybCase || result.data || {};
  const token = result.token || result.sessionToken;
  const providerRef = kybCase.refId || refId;
  if (!token) throw new Error("VOVE KYB case response did not include a hosted-flow token.");
  return {
    provider: "VOVE ID",
    refId: providerRef,
    fullName: businessName,
    country,
    status: kybCase.status || "NOT_STARTED",
    flow: kybCase.flow || settings.kybFlowId || null,
    verificationUrl: buildKybLink(token, settings),
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    environment: settings.environment,
    providerResponse: { refId: providerRef, status: kybCase.status || "NOT_STARTED", flow: kybCase.flow || settings.kybFlowId || null },
  };
}

export async function getVoveKycResult(refId) {
  return await voveRequest(`/users/${encodeURIComponent(refId)}`);
}

export async function getVoveKybResult(refId) {
  const settings = config();
  const query = new URLSearchParams({ search: refId, limit: "1" });
  const payload = await voveRequestRoot(`/kyb/case?${query.toString()}`);
  const records = Array.isArray(payload.data) ? payload.data : [];
  const record = records.find((item) => item.refId === refId) ||
    (payload.kybCase?.refId === refId ? payload.kybCase : null) ||
    (payload.refId === refId ? payload : null);
  if (!record) {
    const error = new Error(`VOVE KYB record not found for refId ${refId}.`);
    error.statusCode = 404;
    throw error;
  }
  return record;
}

export async function getVoveVerificationResult(refId, { subjectType = "INDIVIDUAL" } = {}) {
  return subjectType === "BUSINESS" ? getVoveKybResult(refId) : getVoveKycResult(refId);
}

export function verifyVoveWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const received = Buffer.from(signature);
  const calculated = Buffer.from(expected);
  return received.length === calculated.length && timingSafeEqual(received, calculated);
}
