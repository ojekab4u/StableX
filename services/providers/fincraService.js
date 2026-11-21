import crypto from "node:crypto";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// Fincra CAD rail. Endpoints and payload shapes come from Fincra's published
// documentation (collections, payouts via Interac, quotes). Sandbox base is
// documented; production base is the standard api.fincra.com host.
export function getFincraReadiness() {
  const apiKey = process.env.FINCRA_API_KEY || "";
  const businessId = process.env.FINCRA_BUSINESS_ID || "";
  const environment = process.env.FINCRA_ENVIRONMENT || "sandbox";
  return {
    configured: Boolean(apiKey && businessId),
    environment,
    baseUrl: baseUrl(environment),
    webhookSecretSet: Boolean(process.env.FINCRA_WEBHOOK_SECRET),
  };
}

export function baseUrl(environment = process.env.FINCRA_ENVIRONMENT || "sandbox") {
  return environment === "production" ? "https://api.fincra.com" : "https://sandboxapi.fincra.com";
}

function requireCredentials() {
  if (!process.env.FINCRA_API_KEY) {
    const error = new Error("Fincra is not configured. Set FINCRA_API_KEY.");
    error.statusCode = 503;
    throw error;
  }
  return process.env.FINCRA_API_KEY;
}

async function fincraFetch(path, { method = "GET", body } = {}) {
  const key = requireCredentials();
  const base = baseUrl();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "api-key": key,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || `Fincra request failed with HTTP ${response.status}.`);
    error.statusCode = response.status >= 500 ? 502 : 400;
    error.providerResponse = payload;
    throw error;
  }
  return payload;
}

// Confirms the recipient registered their email for Interac Autodeposit and
// returns the name on the receiving bank account, which the payer confirms
// before any money moves.
export async function resolveInteracRecipient(interacEmail) {
  const email = String(interacEmail || "").trim().toLowerCase();
  if (!email || !email.includes("@")) throw fail("A valid recipient Interac email is required.");
  const payload = await fincraFetch("/core/accounts/resolve", {
    method: "POST",
    body: { currency: "CAD", type: "interac_etransfer", interacEmail: email },
  });
  return {
    email,
    accountName: payload?.data?.accountName ?? null,
    autoDepositEnabled: payload?.data?.autoDepositEnabled ?? false,
    raw: payload,
  };
}

// Builds the CAD Interac payout request. Validation is pure so it is unit
// tested without touching Fincra.
export function buildCadPayoutRequest({ amount, description, customerReference, recipient = {}, sourceCurrency = "CAD", quoteReference } = {}) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw fail("A positive payout amount is required.");
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) throw fail("Amount supports up to 2 decimal places.");
  if (!description || !String(description).trim()) throw fail("A description is required; the recipient sees it on the transfer.");
  if (!customerReference || typeof customerReference !== "string") throw fail("A customerReference is required for reconciliation.");
  const email = String(recipient.interacEmail || "").trim().toLowerCase();
  if (!email || !email.includes("@")) throw fail("The beneficiary Interac email is required.");
  const type = recipient.type === "corporate" ? "corporate" : "individual";
  if (type === "individual" && (!recipient.firstName || !recipient.lastName)) {
    throw fail("Individual beneficiaries need firstName and lastName.");
  }
  const beneficiary = {
    type,
    accountHolderName: String(recipient.accountHolderName || "").trim(),
    interacEmail: email,
    country: "CA",
  };
  if (type === "individual") {
    beneficiary.firstName = String(recipient.firstName).trim();
    beneficiary.lastName = String(recipient.lastName).trim();
  }
  if (!beneficiary.accountHolderName) throw fail("The beneficiary accountHolderName is required.");
  const request = {
    business: process.env.FINCRA_BUSINESS_ID,
    sourceCurrency,
    destinationCurrency: "CAD",
    amount: value,
    description: String(description).trim().slice(0, 140),
    customerReference: String(customerReference).slice(0, 128),
    paymentDestination: "bank_account",
    paymentScheme: "interac",
    beneficiary,
  };
  if (sourceCurrency !== "CAD") {
    if (!quoteReference) throw fail("Cross-currency payouts require a quoteReference from the quote endpoint.");
    request.quoteReference = quoteReference;
  }
  if (recipient.autoDepositEnabled === false) {
    const question = String(recipient.securityQuestion || "");
    const answer = String(recipient.securityAnswer || "");
    if (!question || !answer) throw fail("Recipients without Autodeposit need a security question and answer.");
    if (question.length > 40) throw fail("The security question must be 40 characters or fewer.");
    if (answer.length < 3 || answer.length > 25 || /\s/.test(answer)) {
      throw fail("The security answer must be 3-25 characters with no spaces.");
    }
    beneficiary.securityQuestion = question;
    beneficiary.securityAnswer = answer;
  }
  return request;
}

export async function createCadPayout(request) {
  return fincraFetch("/disbursements/payouts", { method: "POST", body: request });
}

// Cross-currency funding of a payout (e.g. NGN wallet paying out CAD) needs a
// quote first; its reference goes into the payout request.
export async function generateQuote({ sourceCurrency, destinationCurrency, amount, transactionType = "disbursement", paymentDestination = "bank_account", paymentScheme = "interac" } = {}) {
  if (!process.env.FINCRA_BUSINESS_ID) throw fail("FINCRA_BUSINESS_ID is required for quotes.");
  return fincraFetch("/quotes/generate", {
    method: "POST",
    body: {
      business: process.env.FINCRA_BUSINESS_ID,
      sourceCurrency: String(sourceCurrency || "").toUpperCase(),
      destinationCurrency: String(destinationCurrency || "").toUpperCase(),
      amount: Number(amount),
      action: "send",
      transactionType,
      paymentDestination,
      paymentScheme,
    },
  });
}

// Fincra signs webhooks with HMAC SHA512 of the raw body using the merchant
// webhook secret, delivered in the `signature` header. Documented in their
// webhook validation guide.
export function verifyFincraWebhookSignature(rawBody, signature) {
  const secret = process.env.FINCRA_WEBHOOK_SECRET;
  if (!secret || !signature || !rawBody) return false;
  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
