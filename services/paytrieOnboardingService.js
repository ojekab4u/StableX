import {
  isAddress,
} from "viem";
import {
  encryptBeneficiaryDetails,
  decryptBeneficiaryDetails,
} from "./beneficiaryCrypto.js";
import {
  savePaytrieCustomerSession,
  getPaytrieCustomerSession,
  deletePaytrieCustomerSession,
} from "../repositories/paytrieCustomerRepository.js";
import {
  getPaytrieCustomerByStableXId,
  getPaytrieCustomerByProviderUserId,
  getPaytrieCustomerByEmail,
  upsertPaytrieCustomer,
} from "../repositories/paytrieOnboardingRepository.js";

const API_BASE = "https://api.paytrie.com/v2";
const PROVINCES = new Set(["ab","bc","mb","nb","nl","ns","nt","nu","on","pe","qc","sk","yt"]);
const POSTAL_CODE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/i;
const SUPPORTED_PATCH_FIELDS = new Set([
  "firstName","lastName","dob","phone","addressLine1","addressLine2",
  "city","province","postalCode","occupation",
  "olderUserInfo.sourceOfFunds","olderUserInfo.intendedUseOfUSDC",
  "olderUserInfo.walletProvider","olderUserInfo.walletAddress",
  "olderUserInfo.howDidYouHear","olderUserInfo.whoReferredYou",
  "olderUserInfo.previousCryptoExperience",
]);

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const normalizedEmail = (value) => String(value || "").trim().toLowerCase();

function paytrieApiKey() {
  const value = String(process.env.PAYTRIE_API_KEY || "").trim();
  if (!value || /^(key|your[_ -].*|replace[_ -].*|changeme|placeholder)$/i.test(value)) {
    throw fail("Paytrie API access is not configured on StableX. Add the API key issued to the StableX integration.", 503);
  }
  return value;
}

export function isPaytrieCustomerOnboardingEnabled() {
  return String(process.env.PAYTRIE_CUSTOMER_ONBOARDING_ENABLED || "").trim().toLowerCase() === "true";
}

function assertOnboardingEnabled() {
  if (!isPaytrieCustomerOnboardingEnabled()) {
    throw fail("Paytrie customer onboarding is not enabled for this StableX environment. It must be enabled after Paytrie has granted API onboarding access.", 503);
  }
  paytrieApiKey();
}

async function paytrieRequest(path, { method = "GET", jwt, body } = {}) {
  const response = await fetch(API_BASE + path, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": paytrieApiKey(),
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { data = { message: raw.slice(0, 1000) }; }
  if (!response.ok || data.success === false) {
    const detail = Array.isArray(data.errors)
      ? data.errors.map((item) => item.message).filter(Boolean).join("; ")
      : "";
    throw fail(detail || data.message || data.error || `Paytrie returned HTTP ${response.status}.`,
      response.status >= 500 ? 502 : response.status || 502);
  }
  return data.data ?? data;
}

function assertStableXCustomer(account) {
  if (!account?.accountId) throw fail("Sign in to StableX before connecting Paytrie.", 401);
  if (account.accountType !== "PERSONAL") throw fail("Paytrie individual onboarding is available for PERSONAL StableX accounts only. Business onboarding requires Paytrie's separate corporate API flow.", 403);
  if (account.status !== "ACTIVE" || account.verification?.emailVerified !== true) {
    throw fail("Verify your StableX email and activate your account before connecting Paytrie.", 403);
  }
  if (String(account.country || "").toUpperCase() !== "CA") {
    throw fail("Paytrie individual onboarding currently requires a Canadian customer profile and Canadian banking eligibility. This route is not available for accounts registered outside Canada.", 403);
  }
}

export function validatePaytrieRegistrationProfile(profile = {}) {
  const issues = [];
  const textFields = [
    ["firstName","First name"],
    ["lastName","Last name"],
    ["dateOfBirth","Date of birth"],
    ["phone","Canadian mobile number"],
    ["addressLine1","Canadian street address"],
    ["city","City"],
    ["province","Province"],
    ["postalCode","Canadian postal code"],
    ["occupation","Occupation"],
  ];
  for (const [key,label] of textFields) {
    if (typeof profile[key] !== "string" || !profile[key].trim()) issues.push(`${label} is required.`);
  }
  if (profile.dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(profile.dateOfBirth)) {
    issues.push("Date of birth must use YYYY-MM-DD.");
  } else if (profile.dateOfBirth && Number.isNaN(Date.parse(profile.dateOfBirth))) {
    issues.push("Date of birth is invalid.");
  }
  if (profile.phone && !/^\d{10}$/.test(profile.phone.replace(/[\s()-]/g, ""))) {
    issues.push("Enter a 10-digit Canadian mobile number without the country code.");
  }
  if (profile.province && !PROVINCES.has(profile.province.trim().toLowerCase())) {
    issues.push("Select a valid Canadian province or territory.");
  }
  if (profile.postalCode && !POSTAL_CODE.test(profile.postalCode.replace(/\s/g, ""))) {
    issues.push("Enter a valid Canadian postal code.");
  }
  if (profile.notPepConfirmed !== true) issues.push("Confirm that you are not a politically exposed person (PEP).");
  if (profile.notThirdPartyConfirmed !== true) issues.push("Confirm that you are opening and using this account for yourself, not for a third party.");
  return issues;
}

export function buildPaytrieUserPayload({ email, profile = {} }) {
  const issues = validatePaytrieRegistrationProfile(profile);
  if (issues.length) throw fail(issues.join(" "));
  const phone = profile.phone.replace(/[\s()-]/g, "");
  return {
    email: normalizedEmail(email),
    firstName: profile.firstName.trim(),
    lastName: profile.lastName.trim(),
    dob: profile.dateOfBirth.trim(),
    phone,
    addressLine1: profile.addressLine1.trim(),
    ...(profile.addressLine2?.trim() ? { addressLine2: profile.addressLine2.trim() } : {}),
    city: profile.city.trim(),
    province: profile.province.trim().toLowerCase(),
    postalCode: profile.postalCode.replace(/\s/g, "").toUpperCase(),
    occupation: profile.occupation.trim(),
    // The Paytrie API only accepts API-created signups that self-attest false.
    pep: false,
    tpd: false,
  };
}

export function getPaytrieRequiredFields(requirementsData) {
  const requirements = requirementsData?.requirements || {};
  return [...new Set(Object.values(requirements)
    .flatMap((item) => Array.isArray(item?.requiredFields) ? item.requiredFields : []))];
}

export function buildPaytrieRequirementsPatch(requiredFields, values = {}) {
  const required = [...new Set(requiredFields || [])];
  if (!required.length) return {};
  const unsupported = required.filter((field) => !SUPPORTED_PATCH_FIELDS.has(field));
  if (unsupported.length) {
    throw fail(`Paytrie returned requirement fields not yet supported by this StableX form: ${unsupported.join(", ")}. Contact support rather than submitting guessed fields.`, 422);
  }
  const payload = {};
  for (const field of required) {
    const value = values[field];
    if (typeof value !== "string" || !value.trim()) {
      throw fail(`Provide a value for ${field}.`);
    }
    const parts = field.split(".");
    let target = payload;
    for (const part of parts.slice(0, -1)) {
      target[part] ||= {};
      target = target[part];
    }
    target[parts.at(-1)] = value.trim();
  }
  for (const field of Object.keys(values)) {
    if (!required.includes(field)) throw fail(`The field ${field} was not requested by Paytrie and cannot be submitted.`);
  }
  if (payload.olderUserInfo?.walletAddress && !isAddress(payload.olderUserInfo.walletAddress)) {
    throw fail("Paytrie requires a valid wallet address for the olderUserInfo.walletAddress field.");
  }
  return payload;
}

function getMappedCustomer(customerId) {
  return getPaytrieCustomerByStableXId(customerId);
}

async function getCustomerJwt(customerId) {
  const session = await getPaytrieCustomerSession(customerId);
  if (!session) throw fail("Your Paytrie session has expired or is not connected. Request a new Paytrie email code.", 401);
  const stored = decryptBeneficiaryDetails(session.encryptedToken);
  if (!stored?.accessToken) throw fail("The saved Paytrie session is invalid. Authenticate again.", 401);
  return stored.accessToken;
}

async function getRequirementsForCustomer(customerId, mapping) {
  const jwt = await getCustomerJwt(customerId);
  const data = await paytrieRequest(`/users/${encodeURIComponent(mapping.providerUserId)}/requirements`, { jwt });
  return { data, jwt };
}

export async function getPaytrieCustomerOnboardingReadiness(account) {
  const mapping = account?.accountId ? await getMappedCustomer(account.accountId) : null;
  return {
    provider: "Paytrie",
    enabled: isPaytrieCustomerOnboardingEnabled(),
    apiKeyPresent: Boolean(String(process.env.PAYTRIE_API_KEY || "").trim()),
    platformExecutionApproved: String(process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED || "").trim().toLowerCase() === "true",
    eligibleStableXAccount: account?.accountType === "PERSONAL" && account?.status === "ACTIVE"
      && account?.verification?.emailVerified === true && String(account?.country || "").toUpperCase() === "CA",
    linked: Boolean(mapping),
    customer: mapping,
    transactionCreationEnabled: String(process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED || "").trim().toLowerCase() === "true",
    note: "Paytrie account registration and KYC can be completed within StableX when onboarding access is enabled. Live order submission remains separately gated by Paytrie's platform approval.",
  };
}

export async function getPaytrieCustomerOnboardingState(account) {
  assertStableXCustomer(account);
  const mapping = await getMappedCustomer(account.accountId);
  const session = mapping ? await getPaytrieCustomerSession(account.accountId) : null;
  return {
    readiness: await getPaytrieCustomerOnboardingReadiness(account),
    customer: mapping,
    authenticated: Boolean(session),
    sessionExpiresAt: session?.expiresAt || null,
    providerVerified: String(mapping?.providerStatus || "").toLowerCase() === "verified",
  };
}

export async function registerOrLinkPaytrieCustomer({ account, profile, paytrieEmail }) {
  assertOnboardingEnabled();
  assertStableXCustomer(account);
  const email = normalizedEmail(paytrieEmail || account.email);
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) throw fail("Enter the email address registered with your Paytrie account.", 400);

  const existingMapping = await getMappedCustomer(account.accountId);
  if (existingMapping) {
    if (normalizedEmail(existingMapping.email) !== email) {
      throw fail("The linked Paytrie email does not match this StableX account. Contact support to correct the link.", 409);
    }
    await paytrieRequest("/auth/login-codes", { method: "POST", body: { email } });
    return { linked: true, existingPaytrieAccount: true, customer: existingMapping, otpRequested: true, message: "Your Paytrie account is already linked. A fresh sign-in code has been sent to your verified StableX email." };
  }

  const emailOwner = await getPaytrieCustomerByEmail(email);
  if (emailOwner && emailOwner.customerId !== account.accountId) {
    throw fail("This Paytrie identity is already linked to another StableX account. Contact support if you believe this is an error.", 409);
  }

  const matches = await paytrieRequest(`/users?email=${encodeURIComponent(email)}`);
  if (!Array.isArray(matches)) throw fail("Paytrie returned an unexpected user lookup response.", 502);
  if (matches.length > 1) throw fail("Paytrie returned multiple accounts for this email. Contact Paytrie support before proceeding.", 409);

  let user;
  let created = false;
  if (matches.length === 1) {
    user = matches[0];
  } else {
    const payload = buildPaytrieUserPayload({ email, profile });
    user = await paytrieRequest("/users", { method: "POST", body: payload });
    created = true;
  }
  const providerUserId = user?.id;
  if (typeof providerUserId !== "string" || !providerUserId) {
    throw fail("Paytrie did not return a customer ID. No Paytrie account was linked in StableX.", 502);
  }
  const otherOwner = await getPaytrieCustomerByProviderUserId(providerUserId);
  if (otherOwner && otherOwner.customerId !== account.accountId) {
    throw fail("This Paytrie account is already linked to another StableX customer.", 409);
  }
  const mapping = await upsertPaytrieCustomer({
    customerId: account.accountId,
    providerUserId,
    email,
    providerStatus: user.status || null,
    onboardingStatus: created ? "REGISTERED" : (user.status || "EXISTING_ACCOUNT_FOUND").toUpperCase().replaceAll("-", "_"),
  });

  await paytrieRequest("/auth/login-codes", { method: "POST", body: { email } });
  return {
    linked: true,
    created,
    existingPaytrieAccount: !created,
    customer: mapping,
    otpRequested: true,
    message: created
      ? "Your Paytrie profile has been created and linked. Paytrie sent a 4-digit sign-in code to your email; enter it here to continue."
      : "We found your existing Paytrie account and linked it to your StableX account. Paytrie sent a 4-digit sign-in code to your email.",
  };
}

export async function requestPaytrieOnboardingLoginCode({ account }) {
  assertOnboardingEnabled();
  assertStableXCustomer(account);
  const mapping = await getMappedCustomer(account.accountId);
  if (!mapping) throw fail("Connect or register your Paytrie account first.", 409);
  await paytrieRequest("/auth/login-codes", { method: "POST", body: { email: mapping.email } });
  return { requested: true, email: mapping.email, message: "A new 4-digit Paytrie sign-in code has been sent to your email." };
}

export async function verifyPaytrieOnboardingLoginCode({ account, code }) {
  assertOnboardingEnabled();
  assertStableXCustomer(account);
  if (typeof code !== "string" || !/^\d{4}$/.test(code.trim())) throw fail("Enter the 4-digit Paytrie code.");
  const mapping = await getMappedCustomer(account.accountId);
  if (!mapping) throw fail("Register or link your Paytrie account first.", 409);
  const result = await paytrieRequest("/auth/login-codes/verify", {
    method: "POST",
    body: { email: mapping.email, code: code.trim() },
  });
  if (!result.accessToken) throw fail("Paytrie did not return an access token.", 502);
  const expiresIn = Number(result.expiresIn || 3600);
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  await savePaytrieCustomerSession({
    customerId: account.accountId,
    encryptedToken: encryptBeneficiaryDetails({ accessToken: result.accessToken, email: mapping.email }),
    expiresAt,
  });
  const requirements = await paytrieRequest(
    `/users/${encodeURIComponent(mapping.providerUserId)}/requirements`,
    { jwt: result.accessToken }
  );
  return {
    authenticated: true,
    expiresAt,
    customerStatus: mapping.providerStatus,
    requirements,
    message: "Paytrie is connected to your StableX account. Your session token is stored securely on the server.",
  };
}

export async function getPaytrieOnboardingRequirements(account) {
  assertOnboardingEnabled();
  assertStableXCustomer(account);
  const mapping = await getMappedCustomer(account.accountId);
  if (!mapping) throw fail("Connect or register your Paytrie account first.", 409);
  const { data } = await getRequirementsForCustomer(account.accountId, mapping);
  return { customer: mapping, ...data };
}

export async function submitPaytrieOnboardingRequirements({ account, values }) {
  assertOnboardingEnabled();
  assertStableXCustomer(account);
  const mapping = await getMappedCustomer(account.accountId);
  if (!mapping) throw fail("Connect or register your Paytrie account first.", 409);
  const { data: current, jwt } = await getRequirementsForCustomer(account.accountId, mapping);
  const requiredFields = getPaytrieRequiredFields(current);
  const payload = buildPaytrieRequirementsPatch(requiredFields, values);
  if (!Object.keys(payload).length) {
    return { updated: false, requirements: current, message: "Paytrie has no outstanding profile fields to update." };
  }
  await paytrieRequest(`/users/${encodeURIComponent(mapping.providerUserId)}`, { method: "PATCH", jwt, body: payload });
  const requirements = await paytrieRequest(`/users/${encodeURIComponent(mapping.providerUserId)}/requirements`, { jwt });
  return { updated: true, requirements, message: "Profile details submitted. Paytrie's requirements endpoint has been checked again." };
}

export async function requestPaytriePhoneVerification({ account, phone }) {
  assertOnboardingEnabled();
  assertStableXCustomer(account);
  const cleaned = String(phone || "").replace(/[\s()-]/g, "");
  if (!/^\d{10}$/.test(cleaned)) throw fail("Enter a 10-digit Canadian mobile number.");
  const mapping = await getMappedCustomer(account.accountId);
  if (!mapping) throw fail("Connect or register your Paytrie account first.", 409);
  const jwt = await getCustomerJwt(account.accountId);
  await paytrieRequest("/users/me/phone/send-verification", { method: "POST", jwt, body: { phone: cleaned } });
  return { requested: true, message: "Paytrie sent a phone verification code to the number supplied." };
}

export async function verifyPaytriePhoneVerification({ account, code }) {
  assertOnboardingEnabled();
  assertStableXCustomer(account);
  if (typeof code !== "string" || !/^\d{4}$/.test(code.trim())) throw fail("Enter the 4-digit phone verification code.");
  const jwt = await getCustomerJwt(account.accountId);
  await paytrieRequest("/users/me/phone/verify", { method: "POST", jwt, body: { code: code.trim() } });
  const mapping = await getMappedCustomer(account.accountId);
  const requirements = await paytrieRequest(`/users/${encodeURIComponent(mapping.providerUserId)}/requirements`, { jwt });
  return { verified: true, requirements, message: "Paytrie phone verification completed." };
}

export async function getPaytrieKycLink(account) {
  assertOnboardingEnabled();
  assertStableXCustomer(account);
  const mapping = await getMappedCustomer(account.accountId);
  if (!mapping) throw fail("Connect or register your Paytrie account first.", 409);
  const { data, jwt } = await getRequirementsForCustomer(account.accountId, mapping);
  const entries = Object.entries(data?.requirements || {});
  if (!entries.length) throw fail("Paytrie returned no requirement status. Refresh your profile before requesting KYC.", 409);
  const blocking = entries.filter(([key, item]) => key !== "kyc" && (item?.status === "pending" || item?.status === "processing"));
  if (blocking.length) {
    const labels = blocking.map(([key, item]) => `${key}${item?.requiredFields?.length ? ` (${item.requiredFields.join(", ")})` : ""}`);
    throw fail(`Complete the outstanding Paytrie profile requirements before KYC: ${labels.join("; ")}.`, 409);
  }
  const result = await paytrieRequest(`/users/${encodeURIComponent(mapping.providerUserId)}/kyc-url`, { jwt });
  const url = result.url || result.kycUrl || result.verificationUrl || result.redirectUrl;
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) throw fail("Paytrie did not return a valid hosted KYC URL.", 502);
  return { url, expiresAt: result.expiresAt || result.expiry || null, message: "Open Paytrie's secure identity-verification page. Your identity documents and liveness check are completed with Paytrie's KYC partner." };
}

export async function refreshPaytrieOnboardingStatus(account) {
  assertOnboardingEnabled();
  assertStableXCustomer(account);
  const mapping = await getMappedCustomer(account.accountId);
  if (!mapping) throw fail("Connect or register your Paytrie account first.", 409);
  const jwt = await getCustomerJwt(account.accountId);
  const [user, requirements] = await Promise.all([
    paytrieRequest(`/users/${encodeURIComponent(mapping.providerUserId)}`, { jwt }),
    paytrieRequest(`/users/${encodeURIComponent(mapping.providerUserId)}/requirements`, { jwt }),
  ]);
  const status = String(user.status || mapping.providerStatus || "initial");
  const onboardingStatus = status.toLowerCase() === "verified" ? "VERIFIED"
    : status.toLowerCase() === "rejected" ? "REJECTED"
      : status.toLowerCase() === "in-review" ? "IN_REVIEW"
        : status.toLowerCase() === "upload" ? "ACTION_REQUIRED" : "PROFILE_INCOMPLETE";
  const updated = await upsertPaytrieCustomer({
    customerId: account.accountId,
    providerUserId: mapping.providerUserId,
    email: mapping.email,
    providerStatus: status,
    onboardingStatus,
  });
  return {
    customer: updated,
    providerVerified: status.toLowerCase() === "verified",
    requirements,
    transactionCreationEnabled: String(process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED || "").trim().toLowerCase() === "true",
    message: status.toLowerCase() === "verified"
      ? "Paytrie reports this customer as KYC verified."
      : `Paytrie customer status: ${status}. Complete any outstanding requirements and refresh again.`,
  };
}

export async function unlinkPaytrieCustomer(account) {
  assertStableXCustomer(account);
  await deletePaytrieCustomerSession(account.accountId);
  return { authenticated: false, message: "The Paytrie session was disconnected from StableX. This does not delete the customer's Paytrie account." };
}
