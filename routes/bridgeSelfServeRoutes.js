import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { getCustomerGateStatus } from "../services/complianceService.js";
import {
  getBridgeOnboarding,
  saveBridgeTosLink,
  saveBridgeSignedAgreement,
  saveBridgeCustomerId,
  saveBridgeCustomerStatus,
} from "../repositories/providerCustomerRepository.js";
import {
  getBridgeReadiness,
  requestBridgeTosLink,
  createBridgeCustomer,
  getBridgeCustomer,
  updateBridgeCustomer,
  createBridgeVirtualAccount,
  listBridgeVirtualAccounts,
} from "../services/providers/bridgeService.js";
import {
  listBridgeOccupations,
  isValidBridgeOccupation,
  BRIDGE_EMPLOYMENT_STATUSES,
  BRIDGE_EXPECTED_MONTHLY_PAYMENTS,
  BRIDGE_ACCOUNT_PURPOSES,
  BRIDGE_SOURCE_OF_FUNDS,
} from "../services/providers/bridgeOccupations.js";

export const bridgeSelfServeRouter = Router();
bridgeSelfServeRouter.use(requireAuth);

const fail = (res, error) => res.status(error.statusCode || 503).json({
  error: error.message,
  ...(error.providerStatus ? { provider: "Bridge", providerStatus: error.providerStatus } : {}),
  ...(error.providerResponse ? {
    providerDetails: error.providerResponse.errors || error.providerResponse.validation_errors ||
      error.providerResponse.message || error.providerResponse.error || null,
  } : {}),
});

const clean = (value) => typeof value === "string" ? value.trim() : "";
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validPhone = (value) => /^\+[1-9]\d{7,14}$/.test(value);
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const validDataUri = (value) => typeof value === "string" &&
  /^data:(image\/(jpeg|jpg|png|heic|heif|tiff?)|application\/pdf);base64,[A-Za-z0-9+/=]+$/i.test(value);

function addressPayload(value, label) {
  const address = value && typeof value === "object" ? value : {};
  const result = {
    street_line_1: clean(address.streetLine1),
    city: clean(address.city),
    country: clean(address.country).toUpperCase(),
  };
  if (address.streetLine2) result.street_line_2 = clean(address.streetLine2);
  if (address.subdivision) result.subdivision = clean(address.subdivision).toUpperCase();
  if (address.postalCode) result.postal_code = clean(address.postalCode);
  const missing = [];
  if (result.street_line_1.length < 4) missing.push(label + ".streetLine1");
  if (!result.city) missing.push(label + ".city");
  if (!/^[A-Z]{3}$/.test(result.country)) missing.push(label + ".country (ISO alpha-3)");
  return { value: result, missing };
}

// Individual source-of-funds (SOF) fields. Bridge requires exact enum values:
// https://apidocs.bridge.xyz/api-reference/customers/update-a-single-customer-object
// With requireAll=false the fields are optional but any value supplied must be
// valid; with requireAll=true every field must be present and valid.
function validatedIndividualSofFields(profile, { requireAll = false } = {}) {
  const invalid = [];
  const missing = [];
  const result = {};

  const employmentStatus = clean(profile.employmentStatus);
  if (employmentStatus) {
    if (BRIDGE_EMPLOYMENT_STATUSES.includes(employmentStatus)) result.employment_status = employmentStatus;
    else invalid.push("employmentStatus");
  } else if (requireAll) missing.push("employmentStatus");

  const expectedMonthly = clean(profile.expectedMonthlyPaymentsUsd);
  if (expectedMonthly) {
    // For individuals Bridge expects the bucket enum, not a raw number.
    if (BRIDGE_EXPECTED_MONTHLY_PAYMENTS.includes(expectedMonthly)) result.expected_monthly_payments_usd = expectedMonthly;
    else invalid.push("expectedMonthlyPaymentsUsd (use 0_4999, 5000_9999, 10000_49999 or 50000_plus)");
  } else if (requireAll) missing.push("expectedMonthlyPaymentsUsd");

  const occupation = clean(profile.mostRecentOccupation);
  if (occupation) {
    if (isValidBridgeOccupation(occupation)) result.most_recent_occupation = occupation;
    else invalid.push("mostRecentOccupation (must be an official Bridge occupation code)");
  } else if (requireAll) missing.push("mostRecentOccupation");

  if (typeof profile.actingAsIntermediary === "boolean") result.acting_as_intermediary = profile.actingAsIntermediary;
  else if (profile.actingAsIntermediary === "true") result.acting_as_intermediary = true;
  else if (profile.actingAsIntermediary === "false") result.acting_as_intermediary = false;
  else if (requireAll) missing.push("actingAsIntermediary");

  const accountPurpose = clean(profile.accountPurpose);
  if (accountPurpose) {
    if (BRIDGE_ACCOUNT_PURPOSES.includes(accountPurpose)) result.account_purpose = accountPurpose;
    else invalid.push("accountPurpose");
  }

  const sourceOfFunds = clean(profile.sourceOfFunds);
  if (sourceOfFunds) {
    if (BRIDGE_SOURCE_OF_FUNDS.includes(sourceOfFunds)) result.source_of_funds = sourceOfFunds;
    else invalid.push("sourceOfFunds");
  }

  return { result, missing, invalid };
}

function buildIndividualPayload(account, profile, customerId, signedAgreementId) {
  const nameParts = clean(account.fullName).split(/\s+/);
  const firstName = clean(profile.firstName) || nameParts[0] || "";
  const lastName = clean(profile.lastName) || nameParts.slice(1).join(" ");
  const email = clean(profile.email) || clean(account.email);
  const phone = clean(profile.phone) || clean(account.phone);
  const birthDate = clean(profile.birthDate) || clean(account.dateOfBirth);
  const { value: residentialAddress, missing: addressMissing } =
    addressPayload(profile.residentialAddress, "residentialAddress");
  const required = [];
  if (firstName.length < 2) required.push("firstName");
  if (lastName.length < 2) required.push("lastName");
  if (!validEmail(email)) required.push("email");
  if (!validPhone(phone)) required.push("phone (E.164)");
  if (!validDate(birthDate)) required.push("birthDate (YYYY-MM-DD)");
  required.push(...addressMissing);
  const idType = clean(profile.identificationType || "passport").toLowerCase();
  const issuingCountry = clean(profile.identificationIssuingCountry).toLowerCase();
  const idNumber = clean(profile.identificationNumber);
  const imageFront = clean(profile.identificationImageFrontDataUri);
  const imageBack = clean(profile.identificationImageBackDataUri);
  if (!idNumber) required.push("identificationNumber");
  if (!/^[a-z]{3}$/.test(issuingCountry)) required.push("identificationIssuingCountry (ISO alpha-3)");
  if (!imageFront || !validDataUri(imageFront)) required.push("identificationImageFrontDataUri (JPEG/PNG/PDF data URI)");
  if (imageBack && !validDataUri(imageBack)) required.push("identificationImageBackDataUri (valid data URI)");
  if (imageFront.length > 10_000_000 || imageBack.length > 10_000_000) {
    const error = new Error("Identity document image is too large; each image must be under 10 MB.");
    error.statusCode = 413;
    throw error;
  }
  if (required.length) {
    const error = new Error("Bridge individual profile is incomplete.");
    error.statusCode = 400;
    error.missingFields = required;
    throw error;
  }
  const payload = {
    type: "individual",
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    birth_date: birthDate,
    residential_address: residentialAddress,
    signed_agreement_id: signedAgreementId,
    client_reference_id: customerId,
    identifying_information: [{
      type: idType,
      issuing_country: issuingCountry,
      number: idNumber,
      image_front: imageFront,
      ...(imageBack ? { image_back: imageBack } : {}),
    }],
  };
  if (clean(profile.middleName)) payload.middle_name = clean(profile.middleName);
  const sof = validatedIndividualSofFields(profile, { requireAll: false });
  if (sof.invalid.length) {
    const error = new Error("Invalid source-of-funds values.");
    error.statusCode = 400;
    error.missingFields = sof.invalid;
    throw error;
  }
  Object.assign(payload, sof.result);
  return payload;
}

function buildBusinessPayload(account, profile, customerId, signedAgreementId) {
  const email = clean(profile.email) || clean(account.email);
  const phone = clean(profile.phone) || clean(account.phone);
  const { value: registeredAddress, missing: registeredMissing } =
    addressPayload(profile.registeredAddress, "registeredAddress");
  const { value: physicalAddress, missing: physicalMissing } =
    addressPayload(profile.physicalAddress || profile.registeredAddress, "physicalAddress");
  const required = [];
  if (clean(profile.businessLegalName || account.businessName).length < 2) required.push("businessLegalName");
  if (!validEmail(email)) required.push("email");
  if (!validPhone(phone)) required.push("phone (E.164)");
  if (!["cooperative", "corporation", "llc", "other", "partnership", "sole_prop", "trust"].includes(profile.businessType)) required.push("businessType");
  required.push(...registeredMissing, ...physicalMissing);
  if (clean(profile.businessDescription).length < 2) required.push("businessDescription");
  if (!Array.isArray(profile.businessIndustry) || !profile.businessIndustry.length) required.push("businessIndustry (Bridge industry code)");
  if (!Array.isArray(profile.highRiskActivities) || !profile.highRiskActivities.length) required.push("highRiskActivities");
  if (!profile.accountPurpose) required.push("accountPurpose");
  if (!profile.sourceOfFunds) required.push("sourceOfFunds");
  if (typeof profile.conductsMoneyServices !== "boolean") required.push("conductsMoneyServices");
  if (typeof profile.conductsMoneyServicesUsingBridge !== "boolean" && profile.conductsMoneyServices) required.push("conductsMoneyServicesUsingBridge");
  if (profile.conductsMoneyServices && clean(profile.complianceScreeningExplanation).length < 10) required.push("complianceScreeningExplanation");
  if (profile.conductsMoneyServices && clean(profile.conductsMoneyServicesDescription).length < 10) required.push("conductsMoneyServicesDescription");
  const hasHighRiskActivity = profile.highRiskActivities?.some((activity) => activity !== "none_of_the_above");
  if (hasHighRiskActivity && clean(profile.highRiskActivitiesExplanation).length < 10) required.push("highRiskActivitiesExplanation");
  if (hasHighRiskActivity && clean(profile.sourceOfFundsDescription).length < 5) required.push("sourceOfFundsDescription");
  if (hasHighRiskActivity && !profile.estimatedAnnualRevenueUsd) required.push("estimatedAnnualRevenueUsd");
  if (hasHighRiskActivity && (!Number.isInteger(Number(profile.expectedMonthlyPaymentsUsd)) || Number(profile.expectedMonthlyPaymentsUsd) < 0)) required.push("expectedMonthlyPaymentsUsd");
  if (hasHighRiskActivity && typeof profile.operatesInProhibitedCountries !== "boolean") required.push("operatesInProhibitedCountries");
  if (profile.accountPurpose === "other" && clean(profile.accountPurposeOther).length < 2) required.push("accountPurposeOther");
  if (!Array.isArray(profile.associatedPersons) || !profile.associatedPersons.length) required.push("associatedPersons (at least one UBO/control person)");
  const persons = Array.isArray(profile.associatedPersons) ? profile.associatedPersons : [];
  if (persons.length && !persons.some((person) => person.hasControl === true)) required.push("at least one associated person with hasControl=true");
  if (persons.length && !persons.some((person) => person.isSigner === true)) required.push("at least one associated person with isSigner=true");
  for (let i = 0; i < persons.length; i += 1) {
    const person = persons[i] || {};
    const prefix = "associatedPersons[" + i + "]";
    if (clean(person.firstName).length < 1) required.push(prefix + ".firstName");
    if (clean(person.lastName).length < 2) required.push(prefix + ".lastName");
    if (!validEmail(clean(person.email))) required.push(prefix + ".email");
    if (!validDate(clean(person.birthDate))) required.push(prefix + ".birthDate");
    if (!person.residentialAddress) required.push(prefix + ".residentialAddress");
    if (!Array.isArray(person.identifyingInformation) || !person.identifyingInformation.length) required.push(prefix + ".identifyingInformation");
    else if (person.identifyingInformation.some((id) => !validDataUri(id.imageFrontDataUri))) required.push(prefix + ".identifyingInformation front image");
    if (person.hasOwnership && (!Number.isInteger(Number(person.ownershipPercentage)) || Number(person.ownershipPercentage) < 1 || Number(person.ownershipPercentage) > 100)) required.push(prefix + ".ownershipPercentage (1-100)");
    if (person.hasControl && !clean(person.title)) required.push(prefix + ".title");
  }
  const documents = Array.isArray(profile.documents) ? profile.documents : [];
  const allowedPurposes = new Set([
    "business_formation", "ownership_information", "proof_of_address",
    "proof_of_nature_of_business", "flow_of_funds", "proof_of_source_of_funds",
    "proof_of_source_of_wealth", "proof_of_tax_identification", "ownership_chart",
    "directors_registry", "proof_of_account_purpose",
  ]);
  for (let i = 0; i < documents.length; i += 1) {
    const document = documents[i] || {};
    if (!Array.isArray(document.purposes) || !document.purposes.length ||
        document.purposes.some((purpose) => !allowedPurposes.has(purpose)) ||
        !validDataUri(document.file)) required.push("documents[" + i + "] (valid purposes and file required)");
    if (clean(document.file).length > 10_000_000) required.push("documents[" + i + "] (file must be under 10 MB)");
  }
  const purposes = new Set(documents.flatMap((document) => Array.isArray(document.purposes) ? document.purposes : []));
  if (!purposes.has("business_formation")) required.push("business formation document");
  if (!purposes.has("ownership_information") && !persons.some((person) => person.attestedOwnershipStructure === true)) required.push("ownership document or UBO ownership attestation");
  if (!purposes.has("proof_of_address")) required.push("proof of business address document");
  if (!clean(profile.primaryWebsite) && !purposes.has("proof_of_nature_of_business")) required.push("primary website or proof of nature of business document");
  if (profile.conductsMoneyServicesUsingBridge && !purposes.has("flow_of_funds")) required.push("flow of funds document");
  if (required.length) {
    const error = new Error("Bridge business KYB profile is incomplete.");
    error.statusCode = 400;
    error.missingFields = [...new Set(required)];
    throw error;
  }
  const associatedPersons = persons.map((person) => {
    const { value: residentialAddress, missing } = addressPayload(person.residentialAddress, "associatedPerson.residentialAddress");
    if (missing.length) {
      const error = new Error("An associated person's residential address is incomplete.");
      error.statusCode = 400;
      error.missingFields = missing;
      throw error;
    }
    const identifyingInformation = person.identifyingInformation.map((id) => ({
      type: clean(id.type).toLowerCase(),
      issuing_country: clean(id.issuingCountry).toLowerCase(),
      number: clean(id.number),
      ...(id.imageFrontDataUri ? { image_front: id.imageFrontDataUri } : {}),
      ...(id.imageBackDataUri ? { image_back: id.imageBackDataUri } : {}),
    }));
    if (identifyingInformation.some((id) => !id.type || !/^[a-z]{3}$/.test(id.issuing_country) || !id.number ||
      (id.image_front && !validDataUri(id.image_front)) || (id.image_back && !validDataUri(id.image_back)))) {
      const error = new Error("An associated person's identity document is invalid.");
      error.statusCode = 400;
      throw error;
    }
    return {
      first_name: clean(person.firstName),
      last_name: clean(person.lastName),
      email: clean(person.email),
      phone: clean(person.phone),
      birth_date: clean(person.birthDate),
      ...(Array.isArray(person.nationalities) && person.nationalities.length ? { nationalities: person.nationalities.map((value) => clean(value).toUpperCase()) } : {}),
      residential_address: residentialAddress,
      identifying_information: identifyingInformation,
      has_ownership: person.hasOwnership === true,
      has_control: person.hasControl === true,
      is_signer: person.isSigner === true,
      is_director: person.isDirector === true,
      ...(person.ownershipPercentage !== undefined ? { ownership_percentage: Number(person.ownershipPercentage) } : {}),
      ...(person.hasControl ? { title: clean(person.title) } : {}),
      ...(person.attestedOwnershipStructure ? { attested_ownership_structure_at: new Date().toISOString() } : {}),
    };
  });
  const payload = {
    type: "business",
    business_legal_name: clean(profile.businessLegalName || account.businessName),
    business_description: clean(profile.businessDescription),
    business_type: profile.businessType,
    email,
    phone,
    registered_address: registeredAddress,
    physical_address: physicalAddress,
    signed_agreement_id: signedAgreementId,
    client_reference_id: customerId,
    business_industry: profile.businessIndustry,
    high_risk_activities: profile.highRiskActivities,
    account_purpose: profile.accountPurpose,
    source_of_funds: profile.sourceOfFunds,
    conducts_money_services: profile.conductsMoneyServices,
    associated_persons: associatedPersons,
    documents: documents.map((document) => ({
      purposes: document.purposes,
      file: document.file,
      ...(document.description ? { description: clean(document.description) } : {}),
    })),
  };
  for (const [source, target] of [
    ["primaryWebsite", "primary_website"], ["accountPurposeOther", "account_purpose_other"],
    ["sourceOfFundsDescription", "source_of_funds_description"], ["highRiskActivitiesExplanation", "high_risk_activities_explanation"],
    ["complianceScreeningExplanation", "compliance_screening_explanation"],
    ["conductsMoneyServicesUsingBridge", "conducts_money_services_using_bridge"],
    ["conductsMoneyServicesDescription", "conducts_money_services_description"],
    ["isDao", "is_dao"], ["hasMaterialIntermediaryOwnership", "has_material_intermediary_ownership"],
    ["estimatedAnnualRevenueUsd", "estimated_annual_revenue_usd"],
    ["expectedMonthlyPaymentsUsd", "expected_monthly_payments_usd"], ["operatesInProhibitedCountries", "operates_in_prohibited_countries"],
    ["operatesInProhibitedCountries", "operates_in_prohibited_countries"],
    ["businessTradeName", "business_trade_name"],
  ]) {
    if (profile[source] !== undefined && profile[source] !== "") payload[target] = profile[source];
  }
  if (profile.incorporationDate) payload.incorporation_date = clean(profile.incorporationDate);
  if (profile.identifyingInformation) {
    payload.identifying_information = profile.identifyingInformation.map((id) => ({
      type: clean(id.type).toLowerCase(),
      issuing_country: clean(id.issuingCountry).toLowerCase(),
      number: clean(id.number),
      ...(id.imageFrontDataUri ? { image_front: id.imageFrontDataUri } : {}),
      ...(id.imageBackDataUri ? { image_back: id.imageBackDataUri } : {}),
    }));
  }
  return payload;
}

bridgeSelfServeRouter.get("/onboarding", async (req, res) => {
  try {
    const customerId = req.account.accountId;
    const [gate, onboarding] = await Promise.all([
      getCustomerGateStatus(customerId),
      getBridgeOnboarding(customerId),
    ]);
    return res.json({
      provider: "Bridge",
      customerId,
      accountType: req.account.accountType,
      accountPrefill: {
        fullName: req.account.fullName,
        businessName: req.account.businessName,
        email: req.account.email,
        phone: req.account.phone,
        country: req.account.country,
        dateOfBirth: req.account.dateOfBirth,
      },
      stablexCompliance: gate.gate,
      onboarding,
      bridgeEnvironment: getBridgeReadiness().environment,
      nextStep: !gate.gate.approved ? "Complete StableX identity verification first."
        : !onboarding?.signedAgreementId ? "Generate and accept Bridge Terms of Service."
        : !onboarding?.providerCustomerId ? "Complete the Bridge profile and submit it."
        : "Refresh Bridge's customer and endorsement status to see outstanding requirements.",
    });
  } catch (error) { return fail(res, error); }
});

bridgeSelfServeRouter.post("/tos-link", async (req, res) => {
  try {
    const customerId = req.account.accountId;
    const gate = await getCustomerGateStatus(customerId);
    if (!gate.gate.approved) return res.status(409).json({
      error: "StableX identity approval is required before Bridge onboarding.",
      gate: gate.gate,
    });
    const existing = await getBridgeOnboarding(customerId);
    if (existing?.signedAgreementId) return res.json({ provider: "Bridge", customerId, onboarding: existing, tosAlreadyAccepted: true });
    const idempotencyKey = req.get("Idempotency-Key");
    if (!idempotencyKey || idempotencyKey.length > 128) {
      return res.status(400).json({ error: "Provide an Idempotency-Key header (maximum 128 characters)." });
    }
    let redirectUri;
    if (process.env.BRIDGE_TOS_REDIRECT_URI) {
      const callback = new URL(process.env.BRIDGE_TOS_REDIRECT_URI);
      callback.searchParams.set("customerId", customerId);
      redirectUri = callback.toString();
    }
    const result = await requestBridgeTosLink({ idempotencyKey, redirectUri });
    if (!result.url) return res.status(502).json({ error: "Bridge did not return a hosted ToS URL." });
    const onboarding = await saveBridgeTosLink({ customerId, url: result.url });
    return res.status(201).json({
      provider: "Bridge", customerId, onboarding, tosUrl: result.url,
      nextStep: "The customer must personally review and accept Bridge's hosted terms.",
      customerCreated: false, fundsMoved: false,
    });
  } catch (error) { return fail(res, error); }
});

// The customer must be signed in when the browser returns from Bridge. The
// opaque agreement ID is stored against this account only; Bridge validates it
// again when the customer record is created.
bridgeSelfServeRouter.post("/tos-acceptance", async (req, res) => {
  try {
    const signedAgreementId = clean(req.body?.signedAgreementId);
    const callbackCustomerId = clean(req.body?.customerId);
    if (callbackCustomerId !== req.account.accountId) return res.status(403).json({ error: "Bridge agreement callback does not match the signed-in StableX account." });
    if (!signedAgreementId || signedAgreementId.length > 255) {
      return res.status(400).json({ error: "A valid signedAgreementId from the Bridge redirect is required." });
    }
    const customerId = req.account.accountId;
    const current = await getBridgeOnboarding(customerId);
    if (!current?.tosUrl) return res.status(409).json({ error: "Generate a Bridge ToS link for this account before recording acceptance." });
    if (current.signedAgreementId && current.signedAgreementId !== signedAgreementId) {
      return res.status(409).json({ error: "A different Bridge agreement is already recorded for this account." });
    }
    const onboarding = await saveBridgeSignedAgreement({ customerId, signedAgreementId });
    return res.json({ provider: "Bridge", customerId, onboarding, termsAccepted: true, customerCreated: false, fundsMoved: false });
  } catch (error) { return fail(res, error); }
});

bridgeSelfServeRouter.post("/customer", async (req, res) => {
  try {
    const customerId = req.account.accountId;
    const gate = await getCustomerGateStatus(customerId);
    if (!gate.gate.approved) return res.status(409).json({ error: "StableX identity approval is required before Bridge customer creation.", gate: gate.gate });
    const onboarding = await getBridgeOnboarding(customerId);
    if (!onboarding?.signedAgreementId) return res.status(409).json({ error: "The customer must accept Bridge Terms of Service first." });
    if (onboarding.providerCustomerId) return res.status(409).json({
      error: "A Bridge customer is already linked to this account.",
      providerCustomerId: onboarding.providerCustomerId,
      onboardingStatus: onboarding.onboardingStatus,
    });
    const profile = req.body?.profile || {};
    const payload = req.account.accountType === "BUSINESS"
      ? buildBusinessPayload(req.account, profile, customerId, onboarding.signedAgreementId)
      : buildIndividualPayload(req.account, profile, customerId, onboarding.signedAgreementId);
    const idempotencyKey = req.get("Idempotency-Key");
    if (!idempotencyKey || idempotencyKey.length > 128) return res.status(400).json({ error: "Provide a stable Idempotency-Key header (maximum 128 characters)." });
    const created = await createBridgeCustomer(payload, { idempotencyKey });
    const item = created.data || created;
    const bridgeCustomerId = item.id || item.customer_id || item.customerId;
    if (!bridgeCustomerId) return res.status(502).json({
      error: "Bridge accepted the request but returned no recognizable customer ID. Reconcile before retrying.",
      customerCreated: true, fundsMoved: false,
    });
    const saved = await saveBridgeCustomerId({ customerId, providerCustomerId: bridgeCustomerId, status: "CUSTOMER_CREATED" });
    return res.status(201).json({
      provider: "Bridge", customerId, bridgeCustomerId, onboarding: saved,
      bridgeStatus: item.status || null, endorsements: item.endorsements || [],
      customerCreated: true, fundsMoved: false, profilePiiPersistedByStableX: false,
      nextStep: "Refresh Bridge status. The customer is not approved for transactions until the required endorsements are approved.",
    });
  } catch (error) {
    if (error.missingFields) return res.status(error.statusCode || 400).json({ error: error.message, missingFields: error.missingFields });
    return fail(res, error);
  }
});

// Shared sync: fetch the linked Bridge customer from the provider, normalize
// the endorsement requirements, and persist the result. Used by the manual
// refresh and immediately after a source-of-funds update so the caller sees
// the post-update state without a second request.
async function syncBridgeStatus(account) {
  const customerId = account.accountId;
  const gate = await getCustomerGateStatus(customerId);
  const onboarding = await getBridgeOnboarding(customerId);
  if (!onboarding?.providerCustomerId) {
    const error = new Error("No Bridge customer is linked to this account.");
    error.statusCode = 409;
    throw error;
  }
  const response = await getBridgeCustomer(onboarding.providerCustomerId);
  const item = response.data || response;
  const returnedId = item.id || item.customer_id || item.customerId;
  const returnedReference = item.client_reference_id || item.clientReferenceId;
  if (returnedId && returnedId !== onboarding.providerCustomerId) {
    const error = new Error("Bridge returned a different customer ID; status was not saved.");
    error.statusCode = 502;
    throw error;
  }
  if (returnedReference && returnedReference !== customerId) {
    const error = new Error("Bridge customer reference does not match this account; status was not saved.");
    error.statusCode = 409;
    throw error;
  }
  const endorsements = (Array.isArray(item.endorsements) ? item.endorsements : []).map((entry) => ({
    name: String(entry?.name || "").toLowerCase(),
    status: String(entry?.status || "unknown").toLowerCase(),
    requirements: {
      complete: Array.isArray(entry?.requirements?.complete) ? entry.requirements.complete : [],
      pending: Array.isArray(entry?.requirements?.pending) ? entry.requirements.pending : [],
      // Bridge documents missing as an object, not just an array. Preserve it.
      missing: entry?.requirements?.missing && typeof entry.requirements.missing === "object"
        ? entry.requirements.missing
        : Array.isArray(entry?.requirements?.missing) ? entry.requirements.missing : {},
      issues: Array.isArray(entry?.requirements?.issues) ? entry.requirements.issues : [],
    },
  })).filter((entry) => entry.name);
  const statusOf = (name) => endorsements.find((entry) => entry.name === name)?.status || null;
  const base = statusOf("base");
  const sepa = statusOf("sepa");
  const status = String(item.status || item.kyc_status || "unknown").toLowerCase();
  const onboardingStatus = base === "approved" && sepa === "approved" ? "BASE_AND_SEPA_APPROVED"
    : base === "approved" ? "BASE_APPROVED"
    : sepa === "approved" ? "SEPA_APPROVED"
    : base === "rejected" || status === "rejected" ? "BASE_REJECTED"
    : ["under_review", "awaiting_questionnaire", "awaiting_ubo"].includes(status) ? "KYC_PENDING"
    : "CUSTOMER_CREATED";
  const saved = await saveBridgeCustomerStatus({
    customerId, providerCustomerId: onboarding.providerCustomerId,
    bridgeStatus: status, endorsements, baseEndorsementStatus: base,
    sepaEndorsementStatus: sepa, onboardingStatus,
  });
  if (!saved) {
    const error = new Error("Bridge status was fetched but the linked customer changed before saving.");
    error.statusCode = 409;
    throw error;
  }
  return {
    provider: "Bridge", customerId, onboarding: saved,
    bridgeStatus: status, endorsements, statusSynchronized: true,
    transactionGate: {
      base: base === "approved",
      sepa: sepa === "approved",
      // StableX identity approval and Bridge product endorsements are separate.
      stablexIdentityApproved: gate.gate.approved,
    },
    fundsMoved: false,
  };
}

bridgeSelfServeRouter.post("/status/refresh", async (req, res) => {
  try {
    return res.json(await syncBridgeStatus(req.account));
  } catch (error) { return fail(res, error); }
});

// Official Bridge occupation codes for the individual "most recent occupation"
// field. Read-only; the browser dropdown is populated from this.
bridgeSelfServeRouter.get("/occupations", (_req, res) => {
  return res.json({ provider: "Bridge", occupations: listBridgeOccupations() });
});

// Session-based funding workspace. The customer is always the signed-in
// account; no customerId or operator token is accepted from the client.
bridgeSelfServeRouter.get("/funding", async (req, res) => {
  try {
    const customerId = req.account.accountId;
    const onboarding = await getBridgeOnboarding(customerId);
    const readiness = getBridgeReadiness();
    return res.json({
      provider: "Bridge",
      customerId,
      accountType: req.account.accountType,
      linked: Boolean(onboarding?.providerCustomerId),
      bridgeCustomerId: onboarding?.providerCustomerId || null,
      bridgeStatus: onboarding?.bridgeStatus || null,
      baseEndorsementStatus: onboarding?.baseEndorsementStatus || null,
      sepaEndorsementStatus: onboarding?.sepaEndorsementStatus || null,
      onboardingStatus: onboarding?.onboardingStatus || null,
      environment: readiness.environment,
      sandboxOnly: readiness.environment === "Sandbox",
    });
  } catch (error) { return fail(res, error); }
});

// List virtual accounts (dummy deposit instructions in Sandbox) for the
// signed-in customer's linked Bridge customer.
bridgeSelfServeRouter.get("/virtual-accounts", async (req, res) => {
  try {
    const customerId = req.account.accountId;
    const onboarding = await getBridgeOnboarding(customerId);
    if (!onboarding?.providerCustomerId) {
      return res.status(409).json({ error: "No Bridge customer is linked to this account. Complete Bridge onboarding first." });
    }
    const result = await listBridgeVirtualAccounts(onboarding.providerCustomerId);
    const readiness = getBridgeReadiness();
    return res.json({
      provider: "Bridge", environment: readiness.environment, customerId,
      bridgeCustomerId: onboarding.providerCustomerId,
      virtualAccounts: result.data || result,
      sandboxOnly: readiness.environment === "Sandbox", fundsMoved: false,
    });
  } catch (error) { return fail(res, error); }
});

// Create dummy Sandbox deposit instructions for the signed-in customer. The
// Idempotency-Key comes from the browser so a retry cannot double-create.
bridgeSelfServeRouter.post("/virtual-accounts", async (req, res) => {
  try {
    const customerId = req.account.accountId;
    const currency = String(req.body?.currency || "").trim().toUpperCase();
    const destinationAddress = String(req.body?.destinationAddress || "").trim();
    const readiness = getBridgeReadiness();
    if (readiness.environment !== "Sandbox") {
      return res.status(409).json({ error: "This workspace is restricted to Bridge Sandbox. Live accounts need the separately approved production workflow.", environment: readiness.environment });
    }
    const onboarding = await getBridgeOnboarding(customerId);
    if (!onboarding?.providerCustomerId) {
      return res.status(409).json({ error: "No Bridge customer is linked to this account. Complete Bridge onboarding first." });
    }
    const idempotencyKey = req.get("Idempotency-Key");
    if (!idempotencyKey || idempotencyKey.length > 128) {
      return res.status(400).json({ error: "Provide an Idempotency-Key header (maximum 128 characters)." });
    }
    const result = await createBridgeVirtualAccount({
      bridgeCustomerId: onboarding.providerCustomerId,
      currency,
      destinationAddress,
      idempotencyKey,
    });
    const account = result.data || result;
    return res.status(201).json({
      provider: "Bridge", environment: readiness.environment, customerId,
      bridgeCustomerId: onboarding.providerCustomerId, virtualAccount: account,
      sandboxOnly: true, dummyDepositInstructions: true, fundsMoved: false,
      nextStep: "Use the returned source_deposit_instructions to display the simulated funding details. Sandbox does not fire payment webhooks or move real money.",
    });
  } catch (error) { return fail(res, error); }
});

// Submit the Source-of-Funds (SOF) fields Bridge's base/SEPA review flags as
// incomplete_sof_field. Updates the linked Bridge customer via the documented
// partial PUT, then immediately re-syncs status so the response shows whether
// the requirement cleared.
bridgeSelfServeRouter.post("/customer/sof", async (req, res) => {
  try {
    const customerId = req.account.accountId;
    const onboarding = await getBridgeOnboarding(customerId);
    if (!onboarding?.providerCustomerId) {
      return res.status(409).json({ error: "No Bridge customer is linked to this account." });
    }
    const profile = req.body || {};
    let patch;
    if (req.account.accountType === "BUSINESS") {
      // For businesses Bridge expects an integer monthly figure.
      const monthly = Number(profile.expectedMonthlyPaymentsUsd);
      if (!Number.isInteger(monthly) || monthly < 0) {
        return res.status(400).json({ error: "expectedMonthlyPaymentsUsd must be a non-negative whole number for business accounts." });
      }
      if (typeof profile.actingAsIntermediary !== "boolean") {
        return res.status(400).json({ error: "actingAsIntermediary must be true or false." });
      }
      patch = {
        type: "business",
        expected_monthly_payments_usd: monthly,
        acting_as_intermediary: profile.actingAsIntermediary,
      };
    } else {
      const { result, missing, invalid } = validatedIndividualSofFields(profile, { requireAll: true });
      if (invalid.length) {
        return res.status(400).json({ error: "Invalid source-of-funds values.", invalid });
      }
      if (missing.length) {
        return res.status(400).json({ error: "All source-of-funds fields are required.", missingFields: missing });
      }
      patch = { type: "individual", ...result };
    }
    // Bridge's PUT customer resource does not accept an Idempotency-Key header,
    // so the update is sent without one. The StableX-side duplicate risk is
    // limited: the payload is validated and the customer ID is linked to this
    // account only.
    const updated = await updateBridgeCustomer(onboarding.providerCustomerId, patch);
    const synced = await syncBridgeStatus(req.account);
    const updatedItem = updated.data || updated;
    return res.json({
      provider: "Bridge", customerId,
      sourceOfFundsUpdated: true,
      bridgeStatus: synced.bridgeStatus,
      endorsements: synced.endorsements,
      transactionGate: synced.transactionGate,
      onboarding: synced.onboarding,
      providerUpdatedAt: updatedItem.updated_at || updatedItem.updatedAt || null,
      fundsMoved: false,
    });
  } catch (error) { return fail(res, error); }
});

function gateStatusPlaceholder() {
  return false;
}
