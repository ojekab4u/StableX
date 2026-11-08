import { randomUUID } from "node:crypto";
import {
  saveComplianceCase,
  readComplianceCase,
  readComplianceCaseByProviderReference,
  readComplianceCasesForCustomer,
  readAllComplianceCases,
  updateComplianceCaseStatus,
  updateComplianceProviderStatus,
} from "../repositories/complianceRepository.js";
import {
  createVoveKycCase,
  createVoveKybCase,
  getVoveKybReadiness,
  getVoveVerificationResult,
} from "./voveKybService.js";

const customerIdRegex = /^[A-Za-z0-9._:-]{2,128}$/;
const nameRegex = /^[A-Za-z .,'-]{2,120}$/;
const countryRegex = /^[A-Z]{2}$/;

export function getComplianceReadiness() {
  const voveReady = getVoveKybReadiness();
  const voveConfigured = voveReady.configured;
  return {
    application: "StableX",
    module: "VOVE identity verification",
    mode: voveConfigured ? "VOVE_SANDBOX" : "NOT_CONFIGURED",
    realProviderConnected: voveConfigured,
    autoApprove: false,
    checks: [
      { requirement: "KYC", subject: "INDIVIDUAL", providerConfigured: voveConfigured, activeImplementation: voveConfigured ? "VOVE_KYC_SESSION_AND_RESULT_LOOKUP" : "NOT_CONFIGURED" },
      { requirement: "KYB", subject: "BUSINESS", providerConfigured: voveConfigured, activeImplementation: voveConfigured ? "VOVE_KYB_CASE_AND_RESULT_LOOKUP" : "NOT_CONFIGURED" },
      { requirement: "AML", subject: "INDIVIDUAL_AND_BUSINESS", providerConfigured: false, activeImplementation: "NOT_CONFIGURED" },
    ],
    note: voveConfigured
      ? "Hosted VOVE verification sessions are enabled. Case creation is not approval; final status is tracked from VOVE results and authorized review."
      : "VOVE ID is not configured. Set the server-side VOVE credentials before creating verification sessions.",
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
  for (const field of ["fullName", "firstName", "lastName", "dateOfBirth", "country", "email", "phone", "businessName", "registrationNumber", "city", "address"]) {
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
  const voveResult = subjectType === "BUSINESS"
    ? await createVoveKybCase({
        businessName,
        country: cleanSubject.country,
        registrationNumber: cleanSubject.registrationNumber || "",
        city: cleanSubject.city || "",
        address: cleanSubject.address || "",
      })
    : await createVoveKycCase({
        fullName: name,
        country: cleanSubject.country,
        dateOfBirth: cleanSubject.dateOfBirth || "",
        email: cleanSubject.email || "",
        phone: cleanSubject.phone || "",
      });

  const caseId = randomUUID();
  const created = await saveComplianceCase({
    id: caseId,
    customerId,
    subjectType,
    requirement,
    subject: cleanSubject,
    screening: {
      method: "VOVE_HOSTED_SESSION",
      provider: "VOVE ID",
      environment: process.env.VOVE_ID_ENVIRONMENT || "Sandbox",
      voveRefId: voveResult.refId,
      flow: voveResult.flow || null,
    },
    status: "SUBMITTED",
    providerStatus: voveResult.status || "NOT_STARTED",
    decisionReason: null,
    provider: "VOVE ID",
    providerReference: voveResult.refId,
    decidedAt: null,
  });

  return {
    case: { ...created, id: caseId },
    gateMessage: `Compliance case created via VOVE ID. Case ID: ${caseId}. Ref: ${voveResult.refId}. Customer must complete verification at: ${voveResult.verificationUrl}`,
    verificationUrl: voveResult.verificationUrl,
    isKybSimulation: Boolean(voveResult.isKybSimulation),
  };
}

export async function getComplianceCaseByProviderReference(providerReference) {
  if (typeof providerReference !== "string" || providerReference.length < 8 || providerReference.length > 255) {
    const error = new Error("A valid VOVE reference is required.");
    error.statusCode = 400;
    throw error;
  }
  return readComplianceCaseByProviderReference("VOVE ID", providerReference);
}

export async function getComplianceCase(caseId) {
  if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId)) {
    const error = new Error("A valid caseId is required.");
    error.statusCode = 400;
    throw error;
  }
  return readComplianceCase(caseId);
}

export async function refreshVoveComplianceCase(caseId) {
  const caseRecord = await getComplianceCase(caseId);
  if (!caseRecord) {
    const error = new Error("Compliance case not found.");
    error.statusCode = 404;
    throw error;
  }
  if (caseRecord.status === "APPROVED" || caseRecord.status === "REJECTED") {
    return {
      refreshed: false,
      reason: "This case already has a final StableX compliance decision.",
      case: caseRecord,
    };
  }
  const refId = caseRecord.providerReference || caseRecord.screening?.voveRefId;
  if (!refId) {
    const error = new Error("This compliance case has no mapped VOVE refId.");
    error.statusCode = 409;
    throw error;
  }
  const providerResult = await getVoveVerificationResult(refId, { subjectType: caseRecord.subjectType });
  if (providerResult?.refId && providerResult.refId !== refId) {
    const error = new Error("VOVE returned a different refId; refusing to update this compliance case.");
    error.statusCode = 502;
    throw error;
  }
  const outcome = normalizeVoveOutcome(null, providerResult);
  const updated = await updateComplianceProviderStatus({
    caseId,
    providerStatus: outcome.providerStatus,
    status: outcome.status,
    eventType: "operator_requested_status_refresh",
  });
  return {
    refreshed: true,
    refId,
    caseId,
    subjectType: caseRecord.subjectType,
    providerStatus: updated.providerStatus,
    complianceStatus: updated.status,
    providerUpdatedAt: providerResult.updatedAt || null,
    // Deliberately omit document, biometric, and registry PII from this response.
  };
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

export async function listAllComplianceCases() {
  const cases = await readAllComplianceCases();
  return { cases, count: cases.length };
}

export async function decideComplianceCase({ caseId, status, reason, actorId }) {
  if (typeof caseId !== "string" || !/^[0-9a-f-]{36}$/i.test(caseId)) {
    const error = new Error("A valid caseId is required.");
    error.statusCode = 400;
    throw error;
  }
  return updateComplianceCaseStatus({ caseId, status, reason, actorId });
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

export function normalizeVoveOutcome(event, result) {
  const data = event?.data || {};
  const eventType = String(event?.type || "").toLowerCase();
  const rawStatus = result?.status || result?.data?.status || result?.user?.status ||
    data.status || data.case?.status || data.session?.status ||
    (eventType.endsWith(".rejected") ? "REJECTED" :
      eventType.endsWith(".completed") ? "COMPLETED" : "UNKNOWN");
  const providerStatus = String(rawStatus).trim().toUpperCase();

  // KYC's documented "successful" result is a positive provider outcome.
  // KYB's "COMPLETED" means evidence collection/checks are complete and must
  // still go through StableX's internal compliance review.
  if (["VERIFIED", "APPROVED", "SUCCESSFUL"].includes(providerStatus) && result?.refId) {
    return { providerStatus, status: "APPROVED" };
  }
  if (providerStatus === "REJECTED") return { providerStatus, status: "REJECTED" };
  if (["COMPLETED", "IN_REVIEW", "SUSPECTED", "PENDING_REVIEW"].includes(providerStatus)) {
    return { providerStatus, status: "IN_REVIEW" };
  }
  if (["IN_PROGRESS", "PENDING", "NOT_STARTED", "UNKNOWN"].includes(providerStatus)) {
    return { providerStatus, status: "SUBMITTED" };
  }
  return { providerStatus, status: "SUBMITTED" };
}

export async function processVoveWebhook(event) {
  const data = event?.data || event || {};
  const refId = data.refId || data.caseId || data.sessionRefId;
  if (!refId) {
    return { updated: false, reason: "Webhook did not include a VOVE refId." };
  }

  const caseRecord = await readComplianceCaseByProviderReference("VOVE ID", String(refId));
  if (!caseRecord) {
    return { updated: false, reason: `No StableX compliance case is mapped to VOVE refId: ${refId}` };
  }

  // Fetch the latest provider record rather than trusting an unsigned status field
  // or treating a hosted-flow completion as a compliance approval.
  const result = await getVoveVerificationResult(String(refId), { subjectType: caseRecord.subjectType });
  const outcome = normalizeVoveOutcome(event, result);
  const updated = await updateComplianceProviderStatus({
    caseId: caseRecord.caseId,
    providerStatus: outcome.providerStatus,
    status: outcome.status,
    eventType: event?.type || "unknown",
  });

  return {
    updated: true,
    refId: String(refId),
    caseId: caseRecord.caseId,
    customerId: caseRecord.customerId,
    status: updated.status,
    providerStatus: updated.providerStatus,
    previousStatus: caseRecord.status,
  };
}
