import { getPool } from "../db/pool.js";

const SELECT = `
  SELECT order_id AS "orderId", transfer_id AS "transferId", customer_id AS "customerId",
    provider, external_reference AS "externalReference",
    provider_transaction_id AS "providerTransactionId", payment_method AS "paymentMethod",
    status, provider_status AS "providerStatus", recipient_address AS "recipientAddress",
    payment_details AS "paymentDetails", transaction_hash AS "transactionHash",
    failure_reason AS "failureReason", created_at AS "createdAt", updated_at AS "updatedAt"
  FROM provider_orders
`;

export async function createProviderOrder(order) {
  const result = await getPool().query(
    `INSERT INTO provider_orders
      (order_id, transfer_id, customer_id, provider, external_reference,
       payment_method, status, recipient_address)
     VALUES ($1,$2,$3,$4,$5,$6,'CREATING',$7)
     ON CONFLICT DO NOTHING
     RETURNING order_id AS "orderId"`,
    [order.orderId, order.transferId, order.customerId, order.provider,
      order.externalReference, order.paymentMethod, order.recipientAddress]
  );
  if (result.rowCount) return { created: true, order: await readProviderOrderByTransfer(order.transferId, order.customerId) };
  return { created: false, order: await readProviderOrderByTransfer(order.transferId, order.customerId) };
}

export async function readProviderOrderByTransfer(transferId, customerId) {
  const result = await getPool().query(
    `${SELECT} WHERE transfer_id=$1 AND customer_id=$2`,
    [transferId, customerId]
  );
  return result.rows[0] || null;
}

export async function readProviderOrderByReference(reference) {
  const result = await getPool().query(
    `${SELECT} WHERE provider='Honeycoin'
      AND (external_reference=$1 OR provider_transaction_id=$1)
      ORDER BY created_at DESC LIMIT 1`,
    [reference]
  );
  return result.rows[0] || null;
}


export async function readProviderOrderByPaytrieTransactionId(providerTransactionId) {
  const result = await getPool().query(
    `${SELECT} WHERE provider='Paytrie' AND provider_transaction_id=$1 LIMIT 1`,
    [providerTransactionId]
  );
  return result.rows[0] || null;
}

export async function readProviderOrderById(orderId, customerId) {
  const result = await getPool().query(
    `${SELECT} WHERE order_id=$1 AND customer_id=$2`,
    [orderId, customerId]
  );
  return result.rows[0] || null;
}

export async function updateProviderOrder({
  orderId, customerId, providerTransactionId, status, providerStatus,
  paymentDetails, transactionHash, failureReason,
}) {
  const result = await getPool().query(
    `UPDATE provider_orders SET
       provider_transaction_id=COALESCE($3,provider_transaction_id),
       status=COALESCE($4,status),
       provider_status=COALESCE($5,provider_status),
       payment_details=COALESCE($6::jsonb,payment_details),
       transaction_hash=COALESCE($7,transaction_hash),
       failure_reason=$8,
       updated_at=NOW()
     WHERE order_id=$1 AND customer_id=$2
     RETURNING order_id AS "orderId", transfer_id AS "transferId",
       customer_id AS "customerId", provider, external_reference AS "externalReference",
       provider_transaction_id AS "providerTransactionId", payment_method AS "paymentMethod",
       status, provider_status AS "providerStatus", recipient_address AS "recipientAddress",
       payment_details AS "paymentDetails", transaction_hash AS "transactionHash",
       failure_reason AS "failureReason", created_at AS "createdAt", updated_at AS "updatedAt"`,
    [orderId, customerId, providerTransactionId || null, status || null,
      providerStatus || null, paymentDetails ? JSON.stringify(paymentDetails) : null,
      transactionHash || null, failureReason || null]
  );
  return result.rows[0] || null;
}
