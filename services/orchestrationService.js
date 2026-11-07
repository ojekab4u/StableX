import { randomUUID } from "node:crypto";
import { getPaytrieQuote, getPaytrieReadiness } from "./paytrieService.js";
import { getVoveKybReadiness } from "./voveKybService.js";
import { getHoneycoinReadiness } from "./providers/honeycoinService.js";
import { getPaycrestReadiness } from "./providers/paycrestService.js";
import { getPartnerReadiness } from "./providers/partnerCatalog.js";
import { saveOrchestrationIntent, findOrchestrationIntent } from "../repositories/orchestrationRepository.js";

export function getOrchestrationOverview() {
  return {
    application: "StableX",
    architecture: "PROVIDER_ORCHESTRATION",
    executionEnabled: false,
    persistence: "POSTGRESQL_FOR_ORCHESTRATION_INTENTS",
    stages: [
      { id: "customer", name: "Customer and beneficiary profile", state: "LOCAL_PROTOTYPE" },
      { id: "identity", name: "KYC / KYB verification", state: "VOVE_KYB_ADAPTER_PRESENT_KYC_PENDING" },
      { id: "route", name: "Route and corridor eligibility", state: "ROUTE_REGISTRY_ONLY" },
      { id: "quote", name: "Provider quote and fees", state: "PAYTRIE_LIVE_QUOTE_ADAPTER" },
      { id: "funding", name: "Fiat collection or wallet funding", state: "PROVIDER_AUTH_REQUIRED" },
      { id: "asset", name: "Stablecoin acquisition / Base settlement", state: "NOT_ENABLED" },
      { id: "payout", name: "Beneficiary payout", state: "PROVIDER_AUTH_REQUIRED" },
      { id: "reconciliation", name: "Webhook, status and audit trail", state: "PARTIAL_IN_MEMORY" },
    ],
    providers: [
      { name: "VOVE ID", role: "KYC / KYB", ...getVoveKybReadiness() },
      { name: "Paytrie", role: "CAD / USDC / CADC quotes and purchase workflow", ...getPaytrieReadiness() },
      ...getPartnerReadiness().friendly.map((partner) => ({
        name: partner.name,
        role: partner.role,
        status: partner.status,
      })),
      { name: "Honeycoin", role: "African fiat on/off-ramp and payouts", ...getHoneycoinReadiness() },
      { name: "Paycrest", role: "Stablecoin / local fiat routing", ...getPaycrestReadiness() },
    ],
    safety: "StableX coordinates providers; it is not itself a bank, stablecoin issuer or liquidity provider. No real transfer is executed by this prototype.",
  };
}

export async function quoteThroughOrchestrator(input) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    const error = new Error("Amount must be greater than 0 and at most 1,000,000.");
    error.statusCode = 400;
    throw error;
  }

  const from = input.from.trim().toUpperCase();
  const to = input.to.trim().toUpperCase();
  if (from === to) {
    const error = new Error("Source and destination currencies must be different.");
    error.statusCode = 400;
    throw error;
  }

  const quote = await getPaytrieQuote({ ...input, from, to, amount });
  const intentId = randomUUID();
  const intent = {
    intentId,
    createdAt: new Date().toISOString(),
    status: "QUOTE_RECEIVED_NOT_EXECUTED",
    source: { currency: from, amount },
    destination: { currency: to, amount: quote.toAmount },
    provider: "Paytrie",
    quote,
    nextRequiredActions: [
      "Confirm customer identity and eligibility",
      "Authenticate the customer with Paytrie where required",
      "Confirm the payment/funding method",
      "Obtain customer confirmation before creating any provider transaction",
      "Monitor provider and blockchain settlement events",
    ],
    executionEnabled: false,
  };

  await saveOrchestrationIntent(intent);
  return intent;
}

export async function getOrchestrationIntent(intentId) {
  return findOrchestrationIntent(intentId);
}
