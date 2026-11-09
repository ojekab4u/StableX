import { randomUUID, randomInt, randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  insertAccount,
  findAccountByEmail,
  findAccountById,
  markChannelVerified,
  saveVerificationCode,
  findLiveVerificationCode,
  consumeVerificationCode,
  registerFailedCodeAttempt,
  saveSession,
  findLiveSessionByToken,
  revokeSession,
  MAX_CODE_ATTEMPTS,
} from "../repositories/accountRepository.js";
import { getCustomerGateStatus, complianceSimulatorEnabled } from "./complianceService.js";
import { getVoveKybReadiness } from "./voveKybService.js";
import { buildComplianceSubject, buildProviderPrefill } from "./complianceSubject.js";

const scryptAsync = promisify(scrypt);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// E.164-style: optional +, then 7-15 digits.
const PHONE_REGEX = /^\+?\d{7,15}$/;
const CODE_TTL_MINUTES = 15;
const COUNTRY_REGEX = /^[A-Za-z]{2}$/;
const DOB_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Demo delivery returns verification codes in API responses and server logs so
// the flow can be exercised without an email/SMS provider. Set
// ACCOUNTS_DEMO_CODE_DELIVERY=false and wire a real provider before any
// production use; when disabled the code is only hashed and stored.
const demoDeliveryEnabled = () =>
  (process.env.ACCOUNTS_DEMO_CODE_DELIVERY || "true") !== "false";

const sessionTtlHours = () => Number(process.env.SESSION_TTL_HOURS || 72);

// ---------- pure helpers (unit-tested in test/authAccounts.test.js) ----------

export function validateRegistration({ email, phone, password, accountType, fullName, businessName, country, dateOfBirth }) {
  const problems = [];
  if (typeof email !== "string" || !EMAIL_REGEX.test(email.trim())) {
    problems.push("Provide a valid email address.");
  }
  if (phone !== undefined && phone !== null && phone !== "") {
    if (typeof phone !== "string" || !PHONE_REGEX.test(phone.trim())) {
      problems.push("Phone must be 7-15 digits with an optional leading +.");
    }
  }
  if (typeof password !== "string" || password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    problems.push("Password must be at least 8 characters and contain letters and numbers.");
  }
  if (!["PERSONAL", "BUSINESS"].includes(accountType)) {
    problems.push("accountType must be PERSONAL or BUSINESS.");
  }
  if (typeof fullName !== "string" || fullName.trim().length < 2) {
    problems.push("fullName is required.");
  }
  if (accountType === "BUSINESS" && (typeof businessName !== "string" || businessName.trim().length < 2)) {
    problems.push("businessName is required for BUSINESS accounts.");
  }
  // Country is required because every KYC/KYB provider (VOVE, Bridge) needs it.
  if (typeof country !== "string" || !COUNTRY_REGEX.test(country.trim())) {
    problems.push("A two-letter ISO country code is required (e.g. NG).");
  }
  const dobProblem = validateDateOfBirth(dateOfBirth);
  if (dobProblem) problems.push(dobProblem);
  return problems;
}

// Optional at registration; when provided it must be a real YYYY-MM-DD date and
// the person must be at least 18 (Bridge individual customers require adulthood).
export function validateDateOfBirth(dateOfBirth) {
  if (dateOfBirth === undefined || dateOfBirth === null || dateOfBirth === "") return null;
  if (typeof dateOfBirth !== "string" || !DOB_REGEX.test(dateOfBirth.trim()) || Number.isNaN(Date.parse(dateOfBirth))) {
    return "dateOfBirth must be a valid YYYY-MM-DD date.";
  }
  const dob = new Date(`${dateOfBirth.trim()}T00:00:00.000Z`);
  const adultCutoff = new Date();
  adultCutoff.setUTCFullYear(adultCutoff.getUTCFullYear() - 18);
  if (dob > adultCutoff) {
    return "Account holders must be at least 18 years old.";
  }
  return null;
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || "").split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const derived = await scryptAsync(password, salt, 64);
  return timingSafeEqual(Buffer.from(hash, "hex"), derived);
}

export function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function generateVerificationCode() {
  return String(randomInt(100000, 1000000));
}

export function sessionExpiry(hours = sessionTtlHours()) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

// ---------- account lifecycle ----------

export async function registerAccount({ email, phone, password, accountType, fullName, businessName, country, dateOfBirth }) {
  const problems = validateRegistration({ email, phone, password, accountType, fullName, businessName, country, dateOfBirth });
  if (problems.length) {
    const error = new Error(problems.join(" "));
    error.statusCode = 400;
    throw error;
  }

  const accountId = randomUUID();
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedPhone = phone ? phone.trim() : null;

  const existing = await findAccountByEmail(normalizedEmail);
  if (existing) {
    const error = new Error("An account with this email already exists.");
    error.statusCode = 409;
    throw error;
  }

  const passwordHash = await hashPassword(password);
  await insertAccount({
    id: accountId,
    email: normalizedEmail,
    phone: normalizedPhone,
    passwordHash,
    accountType,
    fullName: fullName.trim(),
    businessName: businessName ? businessName.trim() : null,
    country: country.trim().toUpperCase(),
    dateOfBirth: dateOfBirth && dateOfBirth.trim() ? dateOfBirth.trim() : null,
  });

  const verification = {};
  verification.email = await issueVerificationCode(accountId, "EMAIL");
  if (normalizedPhone) {
    verification.phone = await issueVerificationCode(accountId, "PHONE");
  }

  return {
    accountId,
    email: normalizedEmail,
    accountType,
    status: "PENDING_VERIFICATION",
    nextStep: accountType === "BUSINESS" ? "KYB verification" : "KYC verification",
    verification,
  };
}

async function issueVerificationCode(accountId, channel) {
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();
  await saveVerificationCode({ accountId, channel, codeHash: sha256Hex(code), expiresAt });

  if (demoDeliveryEnabled()) {
    console.log(`[StableX demo delivery] ${channel} verification code for account ${accountId}: ${code}`);
    return { channel, deliveryMode: "DEMO_RETURNED_IN_RESPONSE", demoCode: code, expiresAt };
  }
  return { channel, deliveryMode: "NOT_CONFIGURED_NO_PROVIDER", expiresAt };
}

export async function verifyAccountChannel({ accountId, channel, code }) {
  if (!["EMAIL", "PHONE"].includes(channel)) {
    const error = new Error("channel must be EMAIL or PHONE.");
    error.statusCode = 400;
    throw error;
  }
  if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
    const error = new Error("Enter the 6-digit verification code.");
    error.statusCode = 400;
    throw error;
  }

  const account = await findAccountById(accountId);
  if (!account) {
    const error = new Error("Account not found.");
    error.statusCode = 404;
    throw error;
  }
  if (channel === "EMAIL" ? account.emailVerified : account.phoneVerified) {
    return { verified: true, alreadyVerified: true, status: account.status };
  }

  const live = await findLiveVerificationCode({ accountId, channel });
  if (!live) {
    const error = new Error("No active code for this channel. Request a new one.");
    error.statusCode = 410;
    throw error;
  }

  if (sha256Hex(code.trim()) !== live.codeHash) {
    const attempt = await registerFailedCodeAttempt(live.codeId);
    if (!attempt.allowed) {
      const error = new Error(`Too many incorrect attempts. Request a new ${channel.toLowerCase()} code.`);
      error.statusCode = 429;
      throw error;
    }
    const error = new Error("Incorrect code. Please try again.");
    error.statusCode = 400;
    throw error;
  }

  const consumed = await consumeVerificationCode(live.codeId);
  if (!consumed) {
    const error = new Error("This code can no longer be used. Request a new one.");
    error.statusCode = 410;
    throw error;
  }

  const updated = await markChannelVerified({ accountId, channel });
  return {
    verified: true,
    channel,
    accountStatus: updated ? updated.status : null,
    fullyVerified: updated ? updated.status === "ACTIVE" : false,
  };
}

export async function resendVerificationCode({ accountId, channel }) {
  if (!["EMAIL", "PHONE"].includes(channel)) {
    const error = new Error("channel must be EMAIL or PHONE.");
    error.statusCode = 400;
    throw error;
  }
  const account = await findAccountById(accountId);
  if (!account) {
    const error = new Error("Account not found.");
    error.statusCode = 404;
    throw error;
  }
  if (channel === "PHONE" && !account.phone) {
    const error = new Error("No phone number is registered on this account.");
    error.statusCode = 400;
    throw error;
  }
  if (channel === "EMAIL" ? account.emailVerified : account.phoneVerified) {
    const error = new Error(`${channel.toLowerCase()} is already verified.`);
    error.statusCode = 409;
    throw error;
  }
  return issueVerificationCode(accountId, channel);
}

export async function loginWithPassword({ email, password }) {
  if (typeof email !== "string" || typeof password !== "string") {
    const error = new Error("Email and password are required.");
    error.statusCode = 400;
    throw error;
  }
  const account = await findAccountByEmail(email.trim().toLowerCase());
  const passwordOk = account
    ? await verifyPassword(password, account.passwordHash)
    : await verifyPassword(password, await hashPassword("timing-equalizer"));

  if (!account || !passwordOk) {
    const error = new Error("Incorrect email or password.");
    error.statusCode = 401;
    throw error;
  }
  if (account.status === "SUSPENDED" || account.status === "CLOSED") {
    const error = new Error(`This account is ${account.status.toLowerCase()}. Contact support.`);
    error.statusCode = 403;
    throw error;
  }
  if (account.status === "PENDING_VERIFICATION") {
    const pending = ["EMAIL", account.phone ? "PHONE" : null].filter(
      (channel) => channel && !(channel === "EMAIL" ? account.emailVerified : account.phoneVerified)
    );
    const error = new Error(`Verification required before signing in: ${pending.join(", ").toLowerCase()}.`);
    error.statusCode = 403;
    error.accountId = account.accountId;
    error.pendingChannels = pending;
    throw error;
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = sessionExpiry();
  await saveSession({ accountId: account.accountId, tokenHash: sha256Hex(token), expiresAt });

  return { token, expiresAt, account: toPublicAccount(account) };
}

export async function getAccountBySessionToken(token) {
  if (!token) return null;
  const row = await findLiveSessionByToken(sha256Hex(token));
  if (!row) return null;
  return {
    account: toPublicAccount(row),
    session: { sessionId: row.sessionId, expiresAt: row.sessionExpiresAt },
  };
}

export async function logoutSession(token) {
  const row = await findLiveSessionByToken(sha256Hex(token));
  if (!row) return false;
  return revokeSession(row.sessionId);
}

export function toPublicAccount(account) {
  return {
    accountId: account.accountId,
    email: account.email,
    phone: account.phone,
    accountType: account.accountType,
    fullName: account.fullName,
    businessName: account.businessName,
    country: account.country,
    dateOfBirth: account.dateOfBirth,
    verification: {
      emailVerified: account.emailVerified,
      phoneVerified: account.phoneVerified,
    },
    status: account.status,
    createdAt: account.createdAt,
  };
}

// Session summary including the compliance gate for the next step of the flow
// (KYC for PERSONAL accounts, KYB for BUSINESS accounts), plus the subject
// prefill built from stored registration data and which verification mode the
// server will use (real VOVE hosted sessions, or the labeled simulator).
export async function getSessionOverview(token) {
  const resolved = await getAccountBySessionToken(token);
  if (!resolved) return null;
  const account = resolved.account;
  const gate = await getCustomerGateStatus(account.accountId);
  const voveReady = getVoveKybReadiness();
  return {
    ...resolved,
    complianceGate: gate.gate,
    complianceSubjectType: account.accountType === "BUSINESS" ? "BUSINESS" : "INDIVIDUAL",
    compliancePrefill: buildComplianceSubject(account),
    providerPrefill: buildProviderPrefill(account),
    complianceOptions: {
      voveConfigured: voveReady.configured,
      simulatorEnabled: complianceSimulatorEnabled(),
      mode: voveReady.configured ? "VOVE_HOSTED" : complianceSimulatorEnabled() ? "LOCAL_SIMULATOR" : "NOT_AVAILABLE",
    },
  };
}

export const authConstants = { CODE_TTL_MINUTES, MAX_CODE_ATTEMPTS };
