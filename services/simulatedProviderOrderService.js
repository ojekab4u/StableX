import { createHash } from "node:crypto";
import {
 createSimulatedProviderOrder,
 advanceSimulatedProviderOrder,
 readSimulatedProviderOrders,
} from "../repositories/providerOrderRepository.js";

function validateCustomer(customerId) {
 if (typeof customerId !== "string" || !/^[A-Za-z0-9._:-]{2,128}$/.test(customerId)) {
  const e = new Error("A valid customerId is required."); e.statusCode = 400; throw e;
 }
}
function validateUuid(value, field) {
 if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
  const e = new Error(`A valid ${field} is required.`); e.statusCode = 400; throw e;
 }
}
export async function createSimulatedOrder({ transferId, customerId, idempotencyKey }) {
 validateCustomer(customerId);
 validateUuid(transferId, "transferId");
 if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
  const e = new Error("Send an Idempotency-Key header (8–128 characters)."); e.statusCode = 400; throw e;
 }
 const fingerprint = createHash("sha256").update(JSON.stringify({ transferId, customerId, executionMode: "SIMULATED" })).digest("hex");
 return createSimulatedProviderOrder({ transferId, customerId, idempotencyKey, fingerprint });
}
export async function advanceSimulatedOrder({ orderId, customerId, status, actorId, note }) {
 validateCustomer(customerId);
 validateUuid(orderId, "orderId");
 const allowed = ["SIMULATED_AWAITING_FUNDING","SIMULATED_FUNDED","SIMULATED_SETTLEMENT_PENDING","SIMULATED_COMPLETED"];
 if (!allowed.includes(status)) { const e = new Error("Unsupported simulated provider-order status."); e.statusCode = 400; throw e; }
 return advanceSimulatedProviderOrder({ orderId, customerId, status, actorId, note });
}
export async function getSimulatedOrder({ transferId, customerId }) {
 validateCustomer(customerId);
 validateUuid(transferId, "transferId");
 return readSimulatedProviderOrders({ transferId, customerId });
}
