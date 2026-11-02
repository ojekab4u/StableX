import { randomUUID } from "node:crypto";
import { getAsset } from "../config/assets.js";

const ROUTES = [
  ["CAD", "USDC", "FIAT_TO_STABLECOIN"],
  ["USDC", "CAD", "STABLECOIN_TO_FIAT"],
  ["CADD", "USDC", "STABLECOIN_TO_STABLECOIN"],
  ["CADC", "USDC", "STABLECOIN_TO_STABLECOIN"],
  ["QCAD", "USDC", "STABLECOIN_TO_STABLECOIN"],
  ["USDC", "CADD", "STABLECOIN_TO_STABLECOIN"],
  ["USDC", "CADC", "STABLECOIN_TO_STABLECOIN"],
  ["USDC", "QCAD", "STABLECOIN_TO_STABLECOIN"],
  ["NGN", "CADC", "FIAT_TO_STABLECOIN"],
  ["NGN", "USDC", "FIAT_TO_STABLECOIN"],
  ["USDC", "NGN", "STABLECOIN_TO_FIAT"],
  ["USDT", "USDC", "STABLECOIN_TO_STABLECOIN"],
  ["USDC", "USDT", "STABLECOIN_TO_STABLECOIN"],
].map(([from, to, category]) => ({ from, to, category }));

const drafts = new Map();

export function getSendRoutes() {
  return ROUTES.map((route) => describeRoute(route.from, route.to));
}

export function describeRoute(fromInput, toInput) {
  const from = String(fromInput || "").toUpperCase();
  const to = String(toInput || "").toUpperCase();
  const route = ROUTES.find((item) => item.from === from && item.to === to);
  const source = getAsset(from);
  const destination = getAsset(to);

  if (!source || !destination || from === to || !route) {
    return {
      from, to, supported: false, quoteMode: "NOT_CONFIGURED",
      executionEnabled: false,
      reason: "This currency route has not been added to the StableX route list.",
    };
  }

  const sourceReady = source.status === "ACTIVE";
  const destinationReady = destination.status === "ACTIVE";

  return {
    ...route,
    supported: true,
    sourceAsset: source,
    destinationAsset: destination,
    quoteMode: "PROVIDER_INTEGRATION_REQUIRED",
    executionEnabled: false,
    sourceAssetReady: sourceReady,
    destinationAssetReady: destinationReady,
    reason: "This route is configured in StableX. Live provider availability, executable pricing, compliance checks and settlement have not been tested or connected.",
    stages: [
      { id: "compliance", label: "KYC/KYB eligibility", status: "NOT_CONNECTED" },
      { id: "liquidity", label: "Liquidity and quote", status: "NOT_CONNECTED" },
      { id: "onchain", label: "Base transaction", status: "NOT_ENABLED" },
      { id: "payout", label: "Financial institution payout", status: "NOT_CONNECTED" },
    ],
  };
}

export function createSendDraft({ from, to, amount, recipientType, recipientReference }) {
  const route = describeRoute(from, to);
  if (!route.supported) throw new Error("This currency route is not configured in StableX.");
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    throw new Error("Amount must be greater than zero and at most 1,000,000.");
  }
  if (!["WALLET", "PAYOUT_REFERENCE"].includes(recipientType)) {
    throw new Error("Choose a valid recipient destination.");
  }
  if (typeof recipientReference !== "string" ||
      recipientReference.trim().length < 3 ||
      recipientReference.trim().length > 160) {
    throw new Error("Enter the recipient wallet address or beneficiary/payout ID.");
  }

  const draft = {
    draftId: randomUUID(),
    from: route.from,
    to: route.to,
    amount,
    recipientType,
    recipientReference: recipientReference.trim(),
    status: "DRAFT_NOT_EXECUTED",
    executionEnabled: false,
    createdAt: new Date().toISOString(),
    nextAction: "Connect the required verification, liquidity and payout services before any real transfer can be processed.",
    route,
  };
  drafts.set(draft.draftId, draft);
  return draft;
}

export function getSendDraft(draftId) {
  return drafts.get(draftId) ?? null;
}
