export function isPaytriePlatformExecutionApproved() {
  return String(process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED || "").trim().toLowerCase() === "true";
}

export function getPaytrieExecutionReadiness() {
  const apiKey = String(process.env.PAYTRIE_API_KEY || "").trim();
  const keyPresent = Boolean(apiKey) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder)$/i.test(apiKey);
  const platformApproved = isPaytriePlatformExecutionApproved();

  return {
    provider: "Paytrie",
    apiVersion: "v2",
    apiKeyPresent: keyPresent,
    customerAuthenticationModel: "AWAITING_PAYTRIE_PLATFORM_CONFIRMATION",
    platformAuthorizationRequired: true,
    platformExecutionApproved: platformApproved,
    transactionCreationEnabled: false,
    status: !keyPresent
      ? "API_KEY_MISSING"
      : !platformApproved
        ? "PAYTRIE_PLATFORM_APPROVAL_REQUIRED"
        : "PLATFORM_AUTH_MODEL_UNCONFIRMED",
    supportedExecutionRoute: "CAD -> USDC-BASE",
    note: platformApproved
      ? "Local approval flag is enabled, but execution must remain unavailable until Paytrie confirms the approved platform authentication and end-user funding model."
      : "Paytrie has not confirmed an approved platform/partner arrangement for StableX. StableX customers must not be asked to create Paytrie accounts as a workaround. Order creation is disabled.",
  };
}

const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });

export async function createPaytrieOrder() {
  if (!isPaytriePlatformExecutionApproved()) {
    throw fail("Paytrie platform execution is disabled pending written platform authorization.", 403);
  }
  throw fail("Paytrie platform authentication and end-user funding model are not confirmed or implemented. Order creation remains disabled.", 503);
}

export async function refreshPaytrieOrder() {
  throw fail("Paytrie order refresh is unavailable until the approved platform authentication model is implemented.", 503);
}
