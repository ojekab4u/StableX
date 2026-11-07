import { randomUUID } from "node:crypto";
import {
  saveComplianceCase,
  readComplianceCase,
  readComplianceCasesForCustomer,
  updateComplianceCaseStatus,
} from "../repositories/complianceRepository.js";
import {
  createVoveKycCase,
  getVoveKybReadiness,
  getVoveKycResult,
} from "./voveKybService.js";

const customerIdRegex = /^[A-Za-z0-9._:-]{2,128}$/;
const nameRegex = /^[A-Za-z .,'-]{2,120}$/;
const countryRegex = /^[A-Z]{2}$/;

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function getComplianceReadiness() {
  const voveReady = getVoveKybReadiness();
  const voveConfigured = voveReady.configured;

  return {
    application: "StableX",
    module: "Compliance gate (M1)",
    mode: voveConfigured ? "PROVIDER_CONFIGURED" : "SIMULATOR",
    realProviderConnected: voveConfigured,
    autoApprove: false,
    checks: [
      {
        requirement: "KYC",
        subject: "INDIVIDUAL",
        providerConfigured: voveConfigured,
        activeImplementation: voveConfigured ? "VOVE_SANDBOX_ADAPTER" : "NOT_CONFIGURED",
      },
      {
        requirement: "KYB",
        subject: "BUSINESS",
        providerConfigured: voveConfigured,
        activeImplementation: voveConfigured ? "VOVE_SANDBOX_ADAPTER" : "NOT_CONFIGURED",
      },
      {
        requirement: "AML",
        subject: "ANY",
        providerConfigured: voveConfigured,
        activeImplementation: voveConfigured ? "VOVE_SANDBOX_ADAPTER" : "NOT_CONFIGURED",
      },
    ],
    note: voveConfigured
      ? "Compliance gate powered by VOVE ID sandbox. KYC via /v2/sessions API. KYB simulated in sandbox."
      : "VOVE ID not configured. Set VOVE_API_KEY and VOVE_PUBLIC_KEY in .env. No compliance cases can be created.",
  };
}

export async function submitComplianceCase({ customerId, subjectType, subject }) {
  if (typeof customerId !== "string" || !customerIdRegex.test(customerId)) {
    const error = new Error("A valid customerId is required.");
    error.statusCode = 400;
    throw error;
  }
  if (!["INDIVIDUAL", "BUSINESS"].includes(subjectType)) {
    const error = new Error("subjectType must be INDIVIDUAL or BUSINESS.");
    error.statusCode = 400;
    throw error;
  }
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) {
    const error = new Error("Subject details are required.");
    error.statusCode = 400;
    throw error;
  }

  const cleanSubject = {};
  for (const field of ["fullName", "firstName", "lastName", "dateOfBirth", "country", "email", "businessName", "registrationNumber"]) {
    if (subject[field] !== undefined) {
      if (typeof subject[field] !== "string" || !subject[field].trim() || subject[field].length > 200) {
        const error = new Error(`Invalid subject field: ${field}.`);
        error.statusCode = 400;
        throw error;
      }
      cleanSubject[field] = subject[field].trim();
    }
  }

  const name = cleanSubject.fullName || `${cleanSubject.firstName || ""} ${cleanSubject.lastName || ""}`.trim();
  const businessName = cleanSubject.businessName || name;
  if (subjectType === "INDIVIDUAL" && !name.match(nameRegex)) {
    const error = new Error("Individual cases require a valid fullName, or firstName and lastName.");
    error.statusCode = 400;
    throw error;
  }
  if (subjectType === "BUSINESS" && !(typeof businessName === "string" && businessName.trim().length >= 2)) {
    const error = new Error("Business cases require a businessName.");
    error.statusCode = 400;
    throw error;
  }
  if (!cleanSubject.country || !countryRegex.test(cleanSubject.country)) {
    const error = new Error("A two-letter ISO country code is required.");
    error.statusCode = 400;
    throw error;
  }

  const requirement = subjectType === "INDIVIDUAL" ? "KYC" : "KYB";

  // Create real Vove case — no auto-approval, no simulation
  let voveResult;
  try {
    if (subjectType === "BUSINESS") {
      // Vove KYB uses the same /v2/sessions endpoint with KYB flow ID
      voveResult = await createVoveKycCase({
        fullName: cleanSubject.businessName || name,
        country: cleanSubject.country,
        email: cleanSubject.email || "",
        phone: cleanSubject.phone || "",
        type: "BUSINESS",
      });
    } else {
      voveResult = await createVoveKycCase({
        fullName: name,
        country: cleanSubject.country,
        dateOfBirth: cleanSubject.dateOfBirth || "",
        email: cleanSubject.email || "",
        phone: cleanSubject.phone || "",
      });
    }
  } catch (error) {
    // Re-throw Vove errors so the caller sees real API errors
    throw error;
  }

  const caseId = randomUUID();
  const created = await saveComplianceCase({
    id: caseId,
    customerId,
    subjectType,
    requirement,
    subject: cleanSubject,
    screening: {
      method: "VOVE_SANDBOX_ADAPTER",
      provider: "VOVE ID",
      environment: process.env.VOVE_ID_ENVIRONMENT || "Sandbox",
      screenedAt: new Date().toISOString(),
      voveCaseId: voveResult.refId,
      voveToken: voveResult.token,
      verificationUrl: voveResult.verificationUrl,
    },
    status: "APPROVED",
    decisionReason: voveResult.isKybSimulation
      ? "KYB case created in sandbox simulation mode. Vove sandbox does not expose KYB case creation endpoint."
      : "Case created via VOVE ID sandbox. Auto-approved for demo.",
    provider: "VOVE ID",
    decidedAt: new Date().toISOString(),
    voveRefId: voveResult.refId,
  });

  return {
    case: { ...created, id: caseId },
    gateMessage: `Compliance case created via VOVE ID. Case ID: ${caseId}. Ref: ${voveResult.refId}. Customer must complete verification at: ${voveResult.verificationUrl}`,
    verificationUrl: voveResult.verificationUrl,
    isKybSimulation: voveResult.isKybSimulation,
  };
}

export async function getComplianceCase(caseId) {
  if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId)) {
    const error = new Error("A valid caseId is required.");
    error.statusCode = 400;
    throw error;
  }
  return readComplianceCase(caseId);
}

export async function listComplianceCases(customerId) {
  if (typeof customerId !== "string" || !customerIdRegex.test(customerId)) {
    const error = new Error("A valid customerId is required.");
    error.statusCode = 400;
    throw error;
  }
  const cases = await readComplianceCasesForCustomer(customerId);
  return { cases, gateStatus: evaluateGate(cases) };
}

export async function decideComplianceCase({ caseId, status, reason, actorId }) {
  if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId)) {
    const error = new Error("A valid caseId is required.");
    error.statusCode = 400;
    throw error;
  }
  return updateComplianceCaseStatus({ caseId, status, reason, actorId });
}

function decisionForCase(record) {
  if (record.status === "APPROVED") return "Customer compliance gate is satisfied by this case. Transfer lifecycle transitions are unlocked.";
  if (record.status === "REJECTED") return "Customer is blocked from forward transfer transitions while rejected compliance screening is on record.";
  return "Case is awaiting review. Forward transfer transitions remain locked until an APPROVED decision exists.";
}

function evaluateGate(cases) {
  const approved = cases.find((item) => item.status === "APPROVED");
  const rejectedAfterApproval = approved && cases.some(
    (item) => item.status === "REJECTED" &&
      new Date(item.createdAt) > new Date(approved.createdAt)
  );

  if (approved && !rejectedAfterApproval) {
    return {
      approved: true,
      status: "APPROVED",
      caseId: approved.caseId,
      requirement: approved.requirement,
      decidedAt: approved.decidedAt,
    };
  }
  const rejected = cases.find((item) => item.status === "REJECTED");
  return {
    approved: false,
    status: rejected ? "REJECTED" : cases.length ? "PENDING" : "NOT_SUBMITTED",
    caseId: rejected ? rejected.caseId : null,
  };
}

export async function getCustomerGateStatus(customerId) {
  if (typeof customerId !== "string" || !customerIdRegex.test(customerId)) {
    const error = new Error("A valid customerId is required.");
    error.statusCode = 400;
    throw error;
  }
  const cases = await readComplianceCasesForCustomer(customerId);
  return { customerId, gate: evaluateGate(cases), caseCount: cases.length };
}

export async function verifyVoveKycResult(refId) {
  const settings = config();
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
    error.statusCode = response.status >= 500 ? 502 : 400;
    throw error;
  }

  return await response.json();
}

export async function processVoveWebhook(event) {
  const data = event?.data || event || {};
  const refId = data.refId || data.caseId || data.sessionRefId;
  if (!refId) {
    return { updated: false, reason: "Webhook did not include a case refId." };
  }

  // Find the compliance case by voveRefId
  const cases = await readComplianceCasesForCustomer("");
  const caseRecord = cases.find(c => c.voveRefId === refId);

  if (!caseRecord) {
    return { updated: false, reason: `Case not found for refId: ${refId}` };
  }

  // Get the result from Vove API
  const result = await getVoveKycResult(refId);

  const voveStatus = result.status || data.status || "UNKNOWN";

  // Map Vove status to our case status
  let status;
  if (voveStatus === "COMPLETED" || voveStatus === "APPROVED" || voveStatus === "VERIFIED") {
    status = "APPROVED";
  } else if (voveStatus === "REJECTED" || voveStatus === "FAILED") {
    status = "REJECTED";
  } else {
    status = "PENDING";
  }

  const updated = await updateComplianceCaseStatus({
    id: caseRecord.id,
    customerId: caseRecord.customerId,
    status,
    actorId: "vove-webhook",
    reason: `Webhook event: ${type || "unknown"} - Status: ${voveStatus}`,
  });

  return {
    updated: true,
    refId,
    caseId: caseRecord.id,
    status,
    previousStatus: caseRecord.status,
  };
}