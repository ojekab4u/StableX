import { randomUUID } from "node:crypto";
import { getAsset } from "../config/assets.js";
import { getPaytrieQuote } from "./paytrieService.js";
import { getHoneycoinRate } from "./providers/honeycoinService.js";
import { getPaycrestRate } from "./providers/paycrestService.js";
import { getBridgeRate } from "./providers/bridgeService.js";
import { getCustomerGateStatus } from "./complianceService.js";
import { readTransfer, applyQuoteSelection } from "../repositories/transferRepository.js";
import { saveRoutingQuote, readRoutingQuote, markRoutingQuoteSelected } from "../repositories/routingQuoteRepository.js";

// Quotes are persisted so selection survives server restarts and multiple instances.
// They remain provider previews/offers; persistence does not reserve liquidity or enable execution.
const QUOTE_TTL_MS = Math.max(10, Number(process.env.ROUTING_QUOTE_TTL_SECONDS || 120)) * 1000;

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    const error = new Error("Amount must be greater than 0 and at most 1,000,000.");
    error.statusCode = 400;
    throw error;
  }
  return amount;
}

function normalizeRoute(fromInput, toInput) {
  const from = String(fromInput || "").trim().toUpperCase();
  const to = String(toInput || "").trim().toUpperCase();
  if (!getAsset(from) || !getAsset(to) || from === to) {
    const error = new Error("Select two different assets registered in StableX.");
    error.statusCode = 400;
    throw error;
  }
  return { from, to };
}

function extractNumeric(candidate) {
  if (candidate === null || candidate === undefined || candidate === "") return null;
  const number = Number(candidate);
  return Number.isFinite(number) ? number : null;
}

function pickNumber(source, keys) {
  for (const key of keys) {
    const number = extractNumeric(source?.[key]);
    if (number !== null) return number;
  }
  return null;
}

function classify(quoteType) {
  if (quoteType === "LIVE_PROVIDER_QUOTE") return "LIVE";
  if (quoteType === "SIMULATION") return "SIMULATION";
  return "INDICATIVE";
}

function normalizeProviderResult(provider, request, result) {
  const raw = result.providerData ?? result.raw ?? result;

  // Paycrest nests rates under buy/sell
  let nestedRate = null;
  if (raw?.buy?.rate !== undefined || raw?.sell?.rate !== undefined) {
    nestedRate = result.direction === "OFFRAMP" ? raw.sell?.rate : raw.buy?.rate;
  }

  const destinationAmount =
    extractNumeric(result.toAmount) ??
    pickNumber(raw, ["toAmount", "netAmount", "amountReturned", "destinationAmount", "receivedAmount", "amount", "convertedAmount"]);
  const rate =
    extractNumeric(result.rate) ??
    extractNumeric(nestedRate) ??
    pickNumber(raw, ["rate", "unitRate", "fxRate", "exchangeRate", "perUnitRate", "conversionRate"]);

  let normalizedDestination = destinationAmount;
  let normalizedRate = rate;

  if (nestedRate !== null && Number(nestedRate) > 0) {
    const fiatPerToken = Number(nestedRate);
    if (result.direction === "ONRAMP") {
      normalizedDestination = request.amount / fiatPerToken;
      normalizedRate = 1 / fiatPerToken;
    } else {
      normalizedDestination = request.amount * fiatPerToken;
      normalizedRate = fiatPerToken;
    }
  } else if (normalizedDestination === null && normalizedRate !== null) {
    const implied = request.amount * normalizedRate;
    if (Number.isFinite(implied) && implied > 0 && implied < request.amount * 100000) {
      normalizedDestination = implied;
    }
  }
  if (normalizedDestination !== null && (normalizedRate === null || !Number.isFinite(normalizedRate)) && request.amount > 0) {
    normalizedRate = normalizedDestination / request.amount;
  }

  return {
    quoteId: randomUUID(),
    provider,
    providerClass: classify(result.quoteType),
    from: request.from,
    to: request.to,
    sourceAmount: request.amount,
    destinationAmount: normalizedDestination ?? null,
    rate: normalizedRate ?? null,
    fee: pickNumber(raw, ["fee", "fees", "totalFee", "feeAmount"]),
    feeCurrency: raw?.feeCurrency || raw?.fee_currency || request.to,
    quoteType: result.quoteType || "INDICATIVE_RATE_PREVIEW",
    expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    raw,
    note: result.note || null,
  };
}

async function rememberIssued(quote) {
  await saveRoutingQuote(quote);
  return quote;
}

// One call fans out to every candidate liquidity provider.
// NO SIMULATION FALLBACK — only real provider rates.
async function collectSingleHopCandidates(request) {
  const attempts = await Promise.allSettled([
    getPaytrieQuote(request)
      .then((result) => normalizeProviderResult("Paytrie", request, result))
      .catch((error) => ({ provider: "Paytrie", available: false, reason: error.message })),
    getHoneycoinRate(request)
      .then((result) => normalizeProviderResult("Honeycoin", request, result))
      .catch((error) => ({ provider: "Honeycoin", available: false, reason: error.message })),
    getPaycrestRate(request)
      .then((result) => normalizeProviderResult("Paycrest", request, result))
      .catch((error) => ({ provider: "Paycrest", available: false, reason: error.message })),
    getBridgeRate(request)
      .then((result) => normalizeProviderResult("Bridge", request, result))
      .catch((error) => ({ provider: "Bridge", available: false, reason: error.message })),
  ]);

  const released = attempts.map((attempt) => attempt.status === "fulfilled" ? attempt.value : []);
  const all = released.flat();
  const candidates = [];
  const unavailableProviders = [];
  for (const item of all) {
    if (!item) continue;
    if (item.quoteId) {
      candidates.push(item);
      await rememberIssued(item);
    } else {
      unavailableProviders.push(item);
    }
  }
  return { candidates, unavailableProviders };
}

function rankQuotes(quotes) {
  return quotes.sort(
    (a, b) => (b.destinationAmount ?? -Infinity) - (a.destinationAmount ?? -Infinity)
  );
}

export async function getRoutingQuotes({ from, to, amount }) {
  const request = {
    ...normalizeRoute(from, to),
    amount: normalizeAmount(amount),
  };

  const direct = await collectSingleHopCandidates(request);

  // ONLY return real provider quotes. No simulation, no synthetic hub routes.
  // If no provider covers this corridor, return empty candidates.
  return {
    application: "StableX",
    quoteType: direct.candidates.length === 0
      ? "NO_PROVIDER"
      : direct.candidates.some((quote) => quote.providerClass === "LIVE")
        ? "LIVE_PROVIDER_QUOTES"
        : "INDICATIVE_PROVIDER_PREVIEWS",
    from: request.from,
    to: request.to,
    amount: request.amount,
    executionEnabled: false,
    candidates: rankQuotes(direct.candidates),
    unavailableProviders: direct.unavailableProviders,
    disclaimer: direct.candidates.length === 0
      ? "No provider covers this corridor. Add provider credentials to enable quotes."
      : "Quotes are offers to compare, not reservations of liquidity.",
  };
}

export async function getRoutingQuote(quoteId) {
  const quote = await readRoutingQuote(quoteId);
  if (!quote || Date.parse(quote.expiresAt) <= Date.now() || quote.selectedAt) return null;
  return quote;
}

export async function selectQuoteForTransfer({ customerId, transferId, quoteId }) {
  if (typeof customerId !== "string" || customerId.length < 2) {
    const error = new Error("A valid customerId is required.");
    error.statusCode = 400;
    throw error;
  }
  if (typeof transferId !== "string" || typeof quoteId !== "string") {
    const error = new Error("transferId and quoteId are required.");
    error.statusCode = 400;
    throw error;
  }

  const quote = await readRoutingQuote(quoteId);
  if (!quote) {
    const error = new Error("Quote not found or expired. Request new quotes and select again.");
    error.statusCode = 404;
    throw error;
  }
  if (Date.parse(quote.expiresAt) <= Date.now()) {
    const error = new Error("This quote has expired. Request new quotes and select again.");
    error.statusCode = 410;
    throw error;
  }

  const transfer = await readTransfer(transferId, customerId);
  if (!transfer) {
    const error = new Error("Transfer not found for this customer.");
    error.statusCode = 404;
    throw error;
  }
  if (transfer.status !== "DRAFT") {
    const error = new Error(`Only DRAFT transfers can receive a quote. This transfer is ${transfer.status}.`);
    error.statusCode = 409;
    throw error;
  }
  if (transfer.sourceCurrency !== quote.from || transfer.destinationCurrency !== quote.to || Number(transfer.sourceAmount) !== quote.sourceAmount) {
    const error = new Error("The selected quote does not match this transfer's route and amount.");
    error.statusCode = 409;
    throw error;
  }

  const gate = await getCustomerGateStatus(customerId);
  if (!gate.gate.approved) {
    const error = new Error(
      `Compliance gate: a quote can only be locked onto a transfer for an APPROVED customer. ` +
      `Compliance status is ${gate.gate.status}. Case/reason: ${gate.gate.caseId || "N/A"}.`
    );
    error.statusCode = 403;
    throw error;
  }

  const selection = await applyQuoteSelection({
    transferId,
    customerId,
    quote: {
      quoteId: quote.quoteId,
      provider: quote.provider,
      providerClass: quote.providerClass,
      quoteType: quote.quoteType,
      from: quote.from,
      to: quote.to,
      sourceAmount: quote.sourceAmount,
      destinationAmount: quote.destinationAmount,
      rate: quote.rate,
      fee: quote.fee,
      feeCurrency: quote.feeCurrency,
      expiresAt: quote.expiresAt,
      selectedAt: new Date().toISOString(),
    },
  });
  await markRoutingQuoteSelected(quoteId);
  return selection;
}