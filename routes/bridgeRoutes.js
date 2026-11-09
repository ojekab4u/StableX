import { Router } from "express";
import { getCustomerGateStatus } from "../services/complianceService.js";
import { saveBridgeTosLink, saveBridgeSignedAgreement, getBridgeOnboarding, saveBridgeCustomerId } from "../repositories/providerCustomerRepository.js";
import {
  getBridgeReadiness,
  getBridgeRate,
  listBridgeCustomers,
  getBridgeCustomer,
  getBridgeKycLink,
  createBridgeCustomer,
  createBridgeOnRampOrder,
  requestBridgeTosLink,
  createBridgeVirtualAccount,
  listBridgeVirtualAccounts,
} from "../services/providers/bridgeService.js";

export const bridgeRouter = Router();
const fail = (res, e) => res.status(e.statusCode || 503).json({
  error: e.message,
  ...(e.providerStatus ? { provider: "Bridge", providerStatus: e.providerStatus } : {}),
  ...(e.providerResponse ? {
    providerDetails: e.providerResponse.errors || e.providerResponse.validation_errors || e.providerResponse.message || e.providerResponse.error || null,
    providerRequestId: e.providerResponse.request_id || e.providerResponse.requestId || null,
  } : {}),
});

bridgeRouter.get("/readiness", (_req, res) => res.json(getBridgeReadiness()));

// Read-only provider lookup. Match locally by client_reference_id so no
// assumptions are made about undocumented server-side filtering parameters.
bridgeRouter.get("/customers/lookup", async (req, res) => {
  try {
    const customerId = String(req.query.customerId || "").trim();
    if (!customerId || customerId.length > 128) {
      return res.status(400).json({ error: "A valid StableX customerId is required." });
    }

    const matches = [];
    const seenCursors = new Set();
    let startingAfter;
    let pagesScanned = 0;
    const maxPages = 50;

    while (pagesScanned < maxPages) {
      const payload = await listBridgeCustomers({ startingAfter, limit: 100 });
      const customers = Array.isArray(payload) ? payload
        : Array.isArray(payload.data) ? payload.data
        : Array.isArray(payload.customers) ? payload.customers
        : Array.isArray(payload.results) ? payload.results : null;

      if (!customers) {
        return res.status(502).json({
          error: "Bridge customer-list response did not contain a recognized customer array.",
          responseKeys: Object.keys(payload || {}),
          pagesScanned,
          lookupComplete: false,
        });
      }

      pagesScanned += 1;
      matches.push(...customers.filter((item) =>
        String(item.client_reference_id || item.clientReferenceId || "") === customerId
      ));

      const hasMore = payload.has_more === true ||
        payload.hasMore === true ||
        payload.pagination?.has_more === true;

      if (!hasMore) {
        return res.json({
          provider: "Bridge",
          environment: getBridgeReadiness().environment,
          stablexCustomerId: customerId,
          matchCount: matches.length,
          matches: matches.map((item) => ({
            id: item.id || item.customer_id || item.customerId || null,
            clientReferenceId: item.client_reference_id || item.clientReferenceId || null,
            type: item.type || null,
            status: item.status || null,
            createdAt: item.created_at || item.createdAt || null,
          })),
          pagesScanned,
          lookupComplete: true,
          lookupIsReadOnly: true,
        });
      }

      const lastCustomer = customers[customers.length - 1];
      const nextCursor = payload.next_cursor || payload.pagination?.next_cursor ||
        lastCustomer?.id || lastCustomer?.customer_id || lastCustomer?.customerId;

      if (!nextCursor || seenCursors.has(String(nextCursor))) {
        return res.status(502).json({
          error: "Bridge indicated more customer pages but did not provide a usable next cursor.",
          pagesScanned,
          lookupComplete: false,
          lookupIsReadOnly: true,
        });
      }
      startingAfter = String(nextCursor);
      seenCursors.add(startingAfter);
    }

    return res.status(503).json({
      error: "Bridge customer lookup reached its 50-page safety limit; no complete result can be claimed.",
      pagesScanned,
      lookupComplete: false,
      lookupIsReadOnly: true,
    });
  } catch (e) { return fail(res, e); }
});


// Durable Bridge onboarding status for a StableX customer.
bridgeRouter.get("/customers/onboarding", async (req, res) => {
  try {
    const customerId = String(req.query.customerId || "").trim();
    if (!customerId || customerId.length > 128) {
      return res.status(400).json({ error: "A valid StableX customerId is required." });
    }
    return res.json({
      provider: "Bridge",
      customerId,
      onboarding: await getBridgeOnboarding(customerId),
    });
  } catch (e) { return fail(res, e); }
});

// Create a hosted Bridge ToS acceptance link only after StableX compliance approval.
bridgeRouter.post("/customers/tos-link", async (req, res) => {
  try {
    const customerId = String(req.body?.customerId || "").trim();
    if (!customerId || customerId.length > 128) {
      return res.status(400).json({ error: "A valid StableX customerId is required." });
    }
    const gate = await getCustomerGateStatus(customerId);
    if (!gate.gate.approved) {
      return res.status(409).json({
        error: "StableX compliance approval is required before Bridge onboarding.",
        gate: gate.gate,
      });
    }
    const idempotencyKey = req.get("Idempotency-Key");
    if (!idempotencyKey) {
      return res.status(400).json({ error: "Provide an Idempotency-Key header and reuse it for retries." });
    }
    let redirectUri;
    if (process.env.BRIDGE_TOS_REDIRECT_URI) {
      const callback = new URL(process.env.BRIDGE_TOS_REDIRECT_URI);
      callback.searchParams.set("customerId", customerId);
      redirectUri = callback.toString();
    }
    const result = await requestBridgeTosLink({ idempotencyKey, redirectUri });
    if (!result.url) {
      return res.status(502).json({ error: "Bridge did not return a hosted ToS URL." });
    }
    const onboarding = await saveBridgeTosLink({ customerId, url: result.url });
    return res.status(201).json({
      provider: "Bridge",
      customerId,
      onboarding,
      tosUrl: result.url,
      nextStep: "Customer must open the hosted URL and accept Bridge Terms of Service. Customer creation is not performed by this endpoint.",
      tosLinkCreated: true,
      customerCreated: false,
      fundsMoved: false,
    });
  } catch (e) { return fail(res, e); }
});

// Bridge redirects here with signed_agreement_id. Do not trust or persist
// browser-supplied agreement IDs until an authenticated operator records them.
bridgeRouter.get("/customers/tos-callback", async (req, res) => {
  const customerId = String(req.query.customerId || "").trim();
  const signedAgreementId = String(req.query.signed_agreement_id || "").trim();
  if (!customerId || customerId.length > 128 || !signedAgreementId || signedAgreementId.length > 255) {
    return res.status(400).json({ error: "customerId and signed_agreement_id are required." });
  }
  return res.json({
    provider: "Bridge",
    customerId,
    signedAgreementId,
    nextStep: "Submit this agreement ID through the authenticated StableX operator endpoint to record acceptance.",
    customerCreated: false,
    fundsMoved: false,
  });
});

bridgeRouter.post("/customers/tos-acceptance", async (req, res) => {
  try {
    const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
    if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
      return res.status(401).json({ error: "Unauthorized operator action." });
    }
    const customerId = String(req.body?.customerId || "").trim();
    const signedAgreementId = String(req.body?.signedAgreementId || "").trim();
    if (!customerId || customerId.length > 128 || !signedAgreementId || signedAgreementId.length > 255) {
      return res.status(400).json({ error: "customerId and signedAgreementId are required." });
    }
    const onboarding = await saveBridgeSignedAgreement({ customerId, signedAgreementId });
    return res.json({
      provider: "Bridge",
      onboarding,
      nextStep: "Terms acceptance recorded. Check customer profile completeness before Bridge customer creation.",
      customerCreated: false,
      fundsMoved: false,
    });
  } catch (e) { return fail(res, e); }
});


// Create a Bridge individual only after compliance approval and recorded ToS acceptance.
// Profile PII is passed directly to Bridge and is not persisted by StableX.
bridgeRouter.post("/customers/create", async (req, res) => {
  try {
    const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
    if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
      return res.status(401).json({ error: "Unauthorized operator action." });
    }

    const customerId = String(req.body?.customerId || "").trim();
    if (!customerId || customerId.length > 128) {
      return res.status(400).json({ error: "A valid StableX customerId is required." });
    }

    const gate = await getCustomerGateStatus(customerId);
    if (!gate.gate.approved) {
      return res.status(409).json({ error: "StableX compliance approval is required before Bridge customer creation.", gate: gate.gate });
    }

    const onboarding = await getBridgeOnboarding(customerId);
    if (!onboarding?.signedAgreementId) {
      return res.status(409).json({ error: "Bridge ToS acceptance must be recorded before customer creation." });
    }
    if (onboarding.providerCustomerId) {
      return res.status(409).json({
        error: "A Bridge customer is already linked to this StableX customer.",
        providerCustomerId: onboarding.providerCustomerId,
        onboardingStatus: onboarding.onboardingStatus,
      });
    }

    const profile = req.body?.profile || {};
    const required = ["firstName", "lastName", "email", "phone", "birthDate", "passportNumber", "passportImageFrontDataUri"];
    const missing = required.filter((key) => typeof profile[key] !== "string" || !profile[key].trim());
    const address = profile.residentialAddress || {};
    for (const key of ["streetLine1", "city", "country"]) {
      if (typeof address[key] !== "string" || !address[key].trim()) missing.push(`residentialAddress.${key}`);
    }
    if (missing.length) {
      return res.status(400).json({ error: "Bridge customer profile is incomplete.", missingFields: missing });
    }

    const email = profile.email.trim();
    const phone = profile.phone.trim();
    const birthDate = profile.birthDate.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid email address is required." });
    }
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      return res.status(400).json({ error: "Phone must be in E.164 format, e.g. +2348012345678." });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || Number.isNaN(Date.parse(birthDate)) ||
        new Date(birthDate).toISOString().slice(0, 10) !== birthDate) {
      return res.status(400).json({ error: "birthDate must be a valid YYYY-MM-DD date." });
    }
    const dob = new Date(`${birthDate}T00:00:00.000Z`);
    const adultCutoff = new Date();
    adultCutoff.setUTCFullYear(adultCutoff.getUTCFullYear() - 18);
    if (dob > adultCutoff) {
      return res.status(400).json({ error: "Bridge individual customers must be at least 18 years old." });
    }

    const clean = (value) => typeof value === "string" ? value.trim() : "";
    const country = clean(address.country).toUpperCase();
    if (!/^[A-Z]{3}$/.test(country)) {
      return res.status(400).json({ error: "residentialAddress.country must be an ISO 3166-1 alpha-3 code (e.g. NGA)." });
    }
    const passportNumber = clean(profile.passportNumber);
    const passportImageFrontDataUri = clean(profile.passportImageFrontDataUri);
    if (passportImageFrontDataUri && !/^data:image\/(jpeg|jpg|png);base64,[A-Za-z0-9+/=]+$/i.test(passportImageFrontDataUri)) {
      return res.status(400).json({ error: "passportImageFrontDataUri must be a JPEG or PNG base64 data URI." });
    }
    if (passportImageFrontDataUri.length > 10_000_000) {
      return res.status(413).json({ error: "Passport image is too large; compress it before submission." });
    }
    const rawSubdivision = clean(address.subdivision);
    const subdivision = country === "NGA" && /^ogun(?: state)?$/i.test(rawSubdivision) ? "OG" : rawSubdivision.toUpperCase();
    const customer = {
      type: "individual",
      first_name: clean(profile.firstName),
      last_name: clean(profile.lastName),
      email,
      phone,
      birth_date: birthDate,
      signed_agreement_id: onboarding.signedAgreementId,
      client_reference_id: customerId,
      residential_address: {
        street_line_1: clean(address.streetLine1),
        city: clean(address.city),
        country,
        ...(subdivision ? { subdivision } : {}),
        ...(clean(address.postalCode) ? { postal_code: clean(address.postalCode) } : {}),
      },
      identifying_information: [{
        type: "passport",
        issuing_country: "nga",
        number: passportNumber,
        image_front: passportImageFrontDataUri,
      }],
    };
    if (profile.middleName) customer.middle_name = clean(profile.middleName);

    const idempotencyKey = req.get("Idempotency-Key");
    if (!idempotencyKey || idempotencyKey.length > 128) {
      return res.status(400).json({ error: "Provide a stable Idempotency-Key header (maximum 128 characters)." });
    }

    const created = await createBridgeCustomer(customer, { idempotencyKey });
    const item = created.data || created;
    const bridgeCustomerId = item.id || item.customer_id || item.customerId;
    if (!bridgeCustomerId) {
      return res.status(502).json({
        error: "Bridge accepted the request but returned no recognizable customer ID. Reconcile using the read-only customer lookup before retrying.",
        providerResponseKeys: Object.keys(item || {}),
        customerCreated: true,
        fundsMoved: false,
      });
    }

    const saved = await saveBridgeCustomerId({
      customerId,
      providerCustomerId: bridgeCustomerId,
      status: "CUSTOMER_CREATED",
    });
    return res.status(201).json({
      provider: "Bridge",
      customerId,
      bridgeCustomerId,
      onboarding: saved,
      bridgeStatus: item.status || null,
      endorsements: item.endorsements || [],
      nextStep: "Review Bridge KYC status and endorsement requirements. Customer creation is not approval for transactions.",
      customerCreated: true,
      fundsMoved: false,
      profilePiiPersistedByStableX: false,
    });
  } catch (e) { return fail(res, e); }
});

// Generate a hosted KYC link for an already-created Bridge customer.
// Bridge hosts the remaining verification/questionnaire flow; StableX does not
// collect or persist the additional identity/source-of-funds responses.
bridgeRouter.post("/customers/kyc-link", async (req, res) => {
  try {
    const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
    if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
      return res.status(401).json({ error: "Unauthorized operator action." });
    }
    const customerId = String(req.body?.customerId || "").trim();
    if (!customerId || customerId.length > 128) {
      return res.status(400).json({ error: "A valid StableX customerId is required." });
    }
    const onboarding = await getBridgeOnboarding(customerId);
    if (!onboarding?.providerCustomerId) {
      return res.status(409).json({ error: "Create and link the Bridge customer before requesting hosted KYC." });
    }
    const endorsement = String(req.body?.endorsement || "base").trim().toLowerCase();
    if (!["base", "sepa"].includes(endorsement)) {
      return res.status(400).json({ error: "endorsement must be base or sepa." });
    }
    const result = await getBridgeKycLink(onboarding.providerCustomerId, { endorsement });
    const url = result.url || result.data?.url;
    if (!url || typeof url !== "string" || !/^https:\/\//i.test(url)) {
      return res.status(502).json({
        error: "Bridge did not return a valid hosted KYC URL.",
        providerResponseKeys: Object.keys(result || {}),
      });
    }
    return res.json({
      provider: "Bridge",
      customerId,
      bridgeCustomerId: onboarding.providerCustomerId,
      endorsement,
      kycUrl: url,
      nextStep: "Open the hosted Bridge KYC URL and complete all requested steps. Then refresh the Bridge customer status endpoint.",
      customerCreated: true,
      fundsMoved: false,
    });
  } catch (e) { return fail(res, e); }
});



// Sandbox virtual accounts return dummy deposit instructions. This is an
// operator-only test action; it does not create a real bank account or move funds.
bridgeRouter.get("/virtual-accounts", async (req, res) => {
  try {
    const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
    if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
      return res.status(401).json({ error: "Unauthorized operator action." });
    }
    const customerId = String(req.query.customerId || "").trim();
    if (!customerId || customerId.length > 128) return res.status(400).json({ error: "A valid StableX customerId is required." });
    const onboarding = await getBridgeOnboarding(customerId);
    if (!onboarding?.providerCustomerId) return res.status(409).json({ error: "No Bridge customer is linked to this StableX customer." });
    const result = await listBridgeVirtualAccounts(onboarding.providerCustomerId);
    return res.json({ provider: "Bridge", environment: getBridgeReadiness().environment, customerId, bridgeCustomerId: onboarding.providerCustomerId, virtualAccounts: result.data || result, sandboxOnly: getBridgeReadiness().environment === "Sandbox", fundsMoved: false });
  } catch (e) { return fail(res, e); }
});

bridgeRouter.post("/virtual-accounts", async (req, res) => {
  try {
    const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
    if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
      return res.status(401).json({ error: "Unauthorized operator action." });
    }
    const customerId = String(req.body?.customerId || "").trim();
    const currency = String(req.body?.currency || "").trim().toUpperCase();
    const destinationAddress = String(req.body?.destinationAddress || "").trim();
    if (!customerId || customerId.length > 128) return res.status(400).json({ error: "A valid StableX customerId is required." });
    const readiness = getBridgeReadiness();
    if (readiness.environment !== "Sandbox") {
      return res.status(409).json({ error: "This test workspace is restricted to Bridge Sandbox. Use the separately approved production wallet/funding workflow for live accounts.", environment: readiness.environment });
    }
    const onboarding = await getBridgeOnboarding(customerId);
    if (!onboarding?.providerCustomerId) return res.status(409).json({ error: "No Bridge customer is linked. Create or link the Bridge customer first." });
    const idempotencyKey = req.get("Idempotency-Key");
    if (!idempotencyKey) return res.status(400).json({ error: "Provide an Idempotency-Key header." });
    const result = await createBridgeVirtualAccount({
      bridgeCustomerId: onboarding.providerCustomerId,
      currency,
      destinationAddress,
      idempotencyKey,
    });
    const account = result.data || result;
    return res.status(201).json({
      provider: "Bridge",
      environment: readiness.environment,
      customerId,
      bridgeCustomerId: onboarding.providerCustomerId,
      virtualAccount: account,
      sandboxOnly: true,
      dummyDepositInstructions: true,
      fundsMoved: false,
      nextStep: "Use the returned source_deposit_instructions to display the simulated funding details. Sandbox does not fire payment webhooks or move real money.",
    });
  } catch (e) { return fail(res, e); }
});

bridgeRouter.get("/customers/:bridgeCustomerId", async (req, res) => {
  try {
    const customer = await getBridgeCustomer(req.params.bridgeCustomerId);
    const item = customer.data || customer;
    return res.json({
      customer: {
        id: item.id || item.customer_id || item.customerId || null,
        clientReferenceId: item.client_reference_id || item.clientReferenceId || null,
        type: item.type || null,
        status: item.status || null,
        endorsements: item.endorsements || null,
      },
    });
  } catch (e) { return fail(res, e); }
});

bridgeRouter.post("/quote", async (req, res) => {
  try {
    const { from, to, amount } = req.body || {};
    if (!from || !to || !amount) return res.status(400).json({ error: "from, to and amount are required." });
    const quote = await getBridgeRate({ from, to, amount: Number(amount) });
    return res.json({ quote });
  } catch (e) { return fail(res, e); }
});

bridgeRouter.post("/onramp", async (req, res) => {
  try {
    const { customerId, from, to, amount, recipientWalletAddress } = req.body || {};
    if (!customerId || !from || !to || !amount || !recipientWalletAddress) {
      return res.status(400).json({ error: "customerId, from, to, amount and recipientWalletAddress are required." });
    }
    const order = await createBridgeOnRampOrder({ customerId, from, to, amount: Number(amount), recipientWalletAddress });
    return res.status(201).json({ order });
  } catch (e) { return fail(res, e); }
});
