import { randomUUID } from "node:crypto";
import { getPaytrieQuote, getPaytrieReadiness } from "./paytrieService.js";

const intents = new Map();

export function getOrchestrationOverview() {
  return {
    application: "StableX",
    architecture: "PROVIDER_ORCHESTRATION",
    executionEnabled: false,
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
      { name: "VOVE ID", role: "KYC / KYB", status: "KYB_CODE_PRESENT_CREDENTIALS_REQUIRED" },
      { name: "Paytrie", role: "CAD / USDC / CADC quotes and purchase workflow", ...getPaytrieReadiness() },
      { name: "Honeycoin", role: "African fiat on/off-ramp and payouts", status: "DOCUMENTED_NOT_CONNECTED" },
      { name: "Paycrest", role: "Stablecoin / local fiat routing", status: "DOCUMENTED_NOT_CONNECTED" },
    ],
    safety: "StableX coordinates providers; it is not itself a bank, stablecoin issuer or liquidity provider. No real transfer is executed by this prototype.",
  };
}

export async function quoteThroughOrchestrator(input) {
  const quote = await getPaytrieQuote(input);
  const intentId = randomUUID();
  const intent = {
    intentId,
    createdAt: new Date().toISOString(),
    status: "QUOTE_RECEIVED_NOT_EXECUTED",
    source: { currency: input.from, amount: Number(input.amount) },
    destination: { currency: input.to, amount: quote.toAmount },
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
  intents.set(intentId, intent);
  return intent;
}

export function getOrchestrationIntent(intentId) {
  return intents.get(intentId) || null;
}
