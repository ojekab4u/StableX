import { privateKeyToAccount } from "viem/accounts";

// The one place that decides where a customer's Bridge deposits settle.
// Mode "SHARED_OPERATOR_SANDBOX" (now): every customer uses one StableX operator
// address. Sandbox only. Mode "PER_CUSTOMER_DERIVED" (later): a unique address
// derived per customer from a master seed in a secrets manager. Replace the body
// of this function only; callers do not change.
export function getDepositDestination(customerId) {
  const key = String(process.env.BASE_SEPOLIA_PRIVATE_KEY || "").trim();
  if (!key) {
    const error = new Error("No StableX deposit address is configured. Set BASE_SEPOLIA_PRIVATE_KEY.");
    error.statusCode = 503;
    throw error;
  }
  return {
    customerId,
    address: privateKeyToAccount(key).address,
    mode: "SHARED_OPERATOR_SANDBOX",
    sandboxOnly: true,
  };
}
