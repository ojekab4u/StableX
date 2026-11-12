import { randomUUID } from "node:crypto";
import { getAsset } from "../config/assets.js";
import { getPaytrieQuote } from "./paytrieService.js";
import { getHoneycoinRate } from "./providers/honeycoinService.js";
import { getPaycrestRate } from "./providers/paycrestService.js";
import { getBridgeRate } from "./providers/bridgeService.js";
import { getAerodromeQuote } from "./providers/aerodromeService.js";
import { getCustomerGateStatus } from "./complianceService.js";
import { readTransfer, applyQuoteSelection } from "../repositories/transferRepository.js";
import { saveRoutingQuote, readRoutingQuote } from "../repositories/routingQuoteRepository.js";

// Quotes are persisted so selection survives server restarts and multiple instances.
// Persistence does not reserve liquidity or enable execution.
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
  if (quoteType === "LIVE_ONCHAIN_QUOTE") return "ONCHAIN";
  if (quoteType === "SIMULATION") return "SIMULATION";
  return "INDICATIVE";
}

export function normalizeProviderResult(provider, request, result) {
  const raw = result.providerData ?? result.raw ?? result;

  // Paycrest nests direction-specific rates under buy/sell.
  let nestedRate = null;
  if (raw?.buy?.rate !== undefined || raw?.sell?.rate !== undefined) {
    nestedRate = result.direction === "OFFRAMP" ? raw.sell?.rate : raw.buy?.rate;
  }

  const destinationAmount =
    extractNumeric(result.destinationAmount) ??
    extractNumeric(result.toAmount) ??
    pickNumber(raw, [
      "toAmount", "rightSideValue", "netAmount", "amountReturned",
      "destinationAmount", "receivedAmount", "amount", "convertedAmount",
    ]);
  const rate =
    extractNumeric(result.rate) ??
    extractNumeric(nestedRate) ??
    pickNumber(raw, [
      "rate", "unitRate", "fxRate", "exchangeRate", "perUnitRate",
      "conversionRate", "sell_rate",
    ]);

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

  const explicitFee = pickNumber(raw, ["fee", "fees", "totalFee", "feeAmount"]);
  const paytrieBreakdown = provider === "Paytrie" && raw?.breakdown && typeof raw.breakdown === "object"
    ? raw.breakdown
    : null;
  const paytrieBreakdownFee = extractNumeric(paytrieBreakdown?.paytrieFee);
  const fee = explicitFee ?? paytrieBreakdownFee;
  const feeCurrency = result.feeCurrency || raw?.feeCurrency || raw?.fee_currency ||
    (provider === "Paytrie"
      ? (paytrieBreakdown?.paytrieFeeCurrency || paytrieBreakdown?.feeCurrency || null)
      : request.to);
  const paytriePricingPolicy = provider === "Paytrie" && request.from === "CAD" && request.to === "USDC"
    ? {
        feeRateBps: 60,
        feeRatePercent: 0.6,
        minimumFee: 5,
        minimumFeeCurrency: "CAD",
        percentageFee: Number((request.amount * 0.006).toFixed(8)),
        estimatedFee: Number(Math.max(request.amount * 0.006, 5).toFixed(8)),
        estimatedNetSourceAmount: Number(Math.max(0, request.amount - Math.max(request.amount * 0.006, 5)).toFixed(8)),
        minimumFeeApplies: request.amount * 0.006 < 5,
        estimateOnly: true,
        source: "Paytrie support pricing confirmation and Paytrie public CAD-to-USDC swap display",
        note: "Pricing-rule estimate only. The original Paytrie quote breakdown is authoritative for the actual transaction. The $5 minimum is treated as CAD for this CAD-funded route.",
      }
    : null;

  return {
    quoteId: randomUUID(),
    customerId: request.customerId || null,
    provider,
    providerClass: classify(result.quoteType),
    from: request.from,
    to: request.to,
    sourceAmount: request.amount,
    destinationAmount: normalizedDestination ?? null,
    rate: normalizedRate ?? null,
    fee,
    feeCurrency,
    feeBreakdown: paytrieBreakdown,
    pricingPolicy: paytriePricingPolicy,
    quoteType: result.quoteType || "INDICATIVE_RATE_PREVIEW",
    expiresAt: result.expiresAt || new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    raw,
    providerData: provider === "Paytrie" ? raw : null,
    providerQuoteId: provider === "Paytrie" ? (raw?.quoteId ?? null) : null,
    providerLeftSideLabel: provider === "Paytrie" ? (raw?.leftSideLabel ?? null) : null,
    providerRightSideLabel: provider === "Paytrie" ? (raw?.rightSideLabel ?? null) : null,
    observedAt: result.observedAt || result.timestamp || raw?.updated_at || new Date().toISOString(),
    network: result.network || null,
    chainId: result.chainId || null,
    executionEnabled: result.executionEnabled === true,
    note: result.note || null,
  };
}

async function rememberIssued(quote) {
  await saveRoutingQuote(quote);
  return quote;
}

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
    getAerodromeQuote(request)
      .then((result) => normalizeProviderResult("Aerodrome Slipstream", request, result))
      .catch((error) => ({ provider: "Aerodrome Slipstream", available: false, reason: error.message })),
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

// Executable offers always rank first. Non-executable provider/on-chain prices
// are ranked by quote class, then destination amount within that class.
export function rankRoutingQuotes(quotes) {
  const priority = { ONCHAIN: 0, LIVE: 1, INDICATIVE: 2, SIMULATION: 3 };
  return [...quotes].sort((a, b) => {
    const executableDifference = Number(b.executionEnabled === true) - Number(a.executionEnabled === true);
    if (executableDifference !== 0) return executableDifference;
    const classDifference = (priority[a.providerClass] ?? 9) - (priority[b.providerClass] ?? 9);
    if (classDifference !== 0) return classDifference;
    return (b.destinationAmount ?? -Infinity) - (a.destinationAmount ?? -Infinity);
  });
}

export async function getRoutingQuotes({ from, to, amount, customerId = null }) {
  const request = {
    ...normalizeRoute(from, to),
    amount: normalizeAmount(amount),
    customerId,
  };

  const direct = await collectSingleHopCandidates(request);
  const hasExecutableQuotes = direct.candidates.some((quote) => quote.executionEnabled === true);
  const hasOnchainQuotes = direct.candidates.some((quote) => quote.providerClass === "ONCHAIN");
  const hasLiveProviderQuotes = direct.candidates.some((quote) => quote.providerClass === "LIVE");

  return {
    application: "StableX",
    quoteType: direct.candidates.length === 0
      ? "NO_PROVIDER"
      : hasExecutableQuotes
        ? "EXECUTABLE_PROVIDER_QUOTES"
        : hasOnchainQuotes
          ? "LIVE_ONCHAIN_AND_PROVIDER_PREVIEWS"
          : hasLiveProviderQuotes
            ? "LIVE_PROVIDER_QUOTES_AND_INDICATIVE_PREVIEWS"
            : "INDICATIVE_PROVIDER_PREVIEWS",
    from: request.from,
    to: request.to,
    amount: request.amount,
    executionEnabled: hasExecutableQuotes,
    hasExecutableQuotes,
    candidates: rankRoutingQuotes(direct.candidates),
    unavailableProviders: direct.unavailableProviders,
    disclaimer: hasExecutableQuotes
      ? "Only candidates explicitly marked executionEnabled are eligible for provider execution. Selection alone does not move funds."
      : direct.candidates.length === 0
        ? "No provider covers this corridor. Add provider credentials or an eligible provider to enable rate previews."
        : "No returned candidate is executable. These are live or indicative rate previews only; selecting one records the choice but does not create an order, reserve liquidity, collect funds or settle a transfer.",
  };
}

export async function getRoutingQuote(quoteId, customerId) {
  const quote = await readRoutingQuote(quoteId);
  if (!quote || quote.customerId !== customerId || Date.parse(quote.expiresAt) <= Date.now() || quote.selectedAt) return null;
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
  if (!quote || (quote.customerId && quote.customerId !== customerId)) {
    const error = new Error("Quote not found for this customer or expired. Request new quotes and select again.");
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
      feeBreakdown: quote.feeBreakdown || quote.providerData?.breakdown || null,
      pricingPolicy: quote.pricingPolicy || null,
      expiresAt: quote.expiresAt,
      selectedAt: new Date().toISOString(),
      providerQuoteId: quote.providerQuoteId,
      providerLeftSideLabel: quote.providerLeftSideLabel,
      providerRightSideLabel: quote.providerRightSideLabel,
      providerData: quote.providerData,
    },
  });
  return selection;
}
