import { randomUUID } from "node:crypto";
import {
  createPublicClient, decodeEventLog, http, isAddress, parseAbi, parseUnits,
} from "viem";
import { base } from "viem/chains";
import {
  createProviderOrder as insertProviderOrder,
  readProviderOrderByTransfer,
  updateProviderOrder,
} from "../repositories/providerOrderRepository.js";
import { readTransfer, readBeneficiaries, updateTransferStatus } from "../repositories/transferRepository.js";
import { decryptBeneficiaryDetails, encryptBeneficiaryDetails } from "./beneficiaryCrypto.js";
import { getCustomerGateStatus } from "./complianceService.js";
import { createHoneycoinOnrampOrder, getHoneycoinTransaction } from "./providers/honeycoinService.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const transferEventAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org"),
});

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function publicOrder(order) {
  return {
    ...order,
    paymentDetails: order.paymentDetails
      ? decryptBeneficiaryDetails(order.paymentDetails)
      : null,
  };
}

function normalizeProviderStatus(value) {
  return String(value || "PENDING").trim().toUpperCase();
}

async function verifyBaseUsdcTransfer({ transactionHash, recipientAddress, cryptoAmount }) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(transactionHash)) {
    return { verified: false, reason: "Honeycoin has not supplied a valid Base transaction hash yet." };
  }
  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: transactionHash });
  } catch {
    return { verified: false, reason: "The provider transaction is not yet available on Base Mainnet." };
  }
  if (receipt.status !== "success") {
    return { verified: false, reason: "The Base transaction did not succeed." };
  }

  const expectedAmount = cryptoAmount !== undefined && cryptoAmount !== null
    ? parseUnits(String(cryptoAmount), 6)
    : null;
  const matchingTransfer = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== USDC_BASE.toLowerCase()) return false;
    try {
      const decoded = decodeEventLog({ abi: transferEventAbi, data: log.data, topics: log.topics });
      return decoded.eventName === "Transfer" &&
        decoded.args.to.toLowerCase() === recipientAddress.toLowerCase() &&
        decoded.args.value > 0n &&
        (expectedAmount === null || decoded.args.value === expectedAmount);
    } catch {
      return false;
    }
  });
  return matchingTransfer
    ? { verified: true, blockNumber: receipt.blockNumber.toString() }
    : { verified: false, reason: "The successful transaction does not contain the expected Base USDC transfer to the saved beneficiary address and amount." };
}

export async function createHoneycoinOrderForTransfer({
  transferId, customerId, paymentMethod, email,
}) {
  if (typeof customerId !== "string" || !/^[A-Za-z0-9._:-]{2,128}$/.test(customerId)) {
    throw fail("A valid customerId is required.");
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(transferId || ""))) {
    throw fail("A valid transferId is required.");
  }
  const method = String(paymentMethod || "").trim().toLowerCase();
  if (!["opay", "bank"].includes(method)) {
    throw fail("For the NGN corridor, paymentMethod must be opay or bank.");
  }

  const gate = await getCustomerGateStatus(customerId);
  if (!gate.gate.approved) {
    throw fail(`Compliance gate: an APPROVED customer is required. Current status: ${gate.gate.status}.`, 403);
  }

  const transfer = await readTransfer(transferId, customerId);
  if (!transfer) throw fail("Transfer not found for this customer.", 404);
  if (transfer.status !== "QUOTED") {
    throw fail(`Only a QUOTED transfer can create a provider order. Current status: ${transfer.status}.`, 409);
  }
  if (transfer.sourceCurrency !== "NGN" || transfer.destinationCurrency !== "USDC") {
    throw fail("This Honeycoin order adapter currently supports NGN to USDC only.", 409);
  }
  if (transfer.quote?.provider !== "Honeycoin") {
    throw fail("Select a Honeycoin quote for this transfer before creating its provider order.", 409);
  }
  if (transfer.quote?.expiresAt && Date.parse(transfer.quote.expiresAt) <= Date.now()) {
    throw fail("The selected indicative quote has expired. Request and select a fresh quote.", 409);
  }

  const beneficiaries = await readBeneficiaries(customerId);
  const beneficiary = beneficiaries.find((item) => item.id === transfer.beneficiaryId);
  if (!beneficiary) throw fail("The transfer beneficiary could not be found.", 409);
  const details = decryptBeneficiaryDetails(beneficiary.encrypted);
  const recipientAddress = String(details.walletAddress || "").trim();
  if (!isAddress(recipientAddress)) throw fail("The selected beneficiary must contain a valid Base wallet address.");
  const beneficiaryNetwork = String(details.network || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (beneficiaryNetwork && !["BASE", "BASEMAINNET"].includes(beneficiaryNetwork)) {
    throw fail("The selected beneficiary is not registered for Base Mainnet.", 409);
  }
  const customerEmail = String(email || details.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    throw fail("A valid customer email is required for Honeycoin OPay/bank payment instructions.");
  }

  const existing = await readProviderOrderByTransfer(transferId, customerId);
  if (existing) {
    if (existing.status === "CREATING") {
      throw fail("A provider order request is already being processed. Refresh the order before retrying.", 409);
    }
    return { created: false, order: publicOrder(existing), message: "An order already exists for this transfer; no duplicate provider request was sent." };
  }

  // Validate encryption configuration before making the external provider request.
  const encryptedEmpty = encryptBeneficiaryDetails({});
  const externalReference = `stablex-${transferId}`;
  const inserted = await insertProviderOrder({
    orderId: randomUUID(),
    transferId,
    customerId,
    provider: "Honeycoin",
    externalReference,
    paymentMethod: method,
    recipientAddress,
  });
  if (!inserted.created) {
    if (!inserted.order) throw fail("Unable to reserve a unique provider order for this transfer.", 409);
    return { created: false, order: publicOrder(inserted.order), message: "An order already exists; no duplicate provider request was sent." };
  }

  try {
    const providerOrder = await createHoneycoinOnrampOrder({
      senderAmount: Number(transfer.sourceAmount),
      senderCurrency: "NGN",
      receiverCurrency: "USDC",
      chain: "BASE",
      receiverAddress,
      method,
      email: customerEmail,
      externalReference,
    });
    const paymentDetails = providerOrder.virtualAccount
      ? encryptBeneficiaryDetails(providerOrder.virtualAccount)
      : encryptedEmpty;
    const saved = await updateProviderOrder({
      orderId: inserted.order.orderId,
      customerId,
      providerTransactionId: providerOrder.transactionId,
      status: providerOrder.redirectUrl ? "ACTION_REQUIRED" : "AWAITING_PAYMENT",
      providerStatus: normalizeProviderStatus(providerOrder.status),
      paymentDetails,
      failureReason: null,
    });
    await updateTransferStatus({
      id: transferId,
      customerId,
      status: "AWAITING_FUNDING",
      actorId: "HONEYCOIN",
      reason: `Honeycoin on-ramp order created. Provider reference: ${providerOrder.transactionId}`,
    });
    return {
      created: true,
      order: {
        ...publicOrder(saved),
        redirectUrl: providerOrder.redirectUrl,
        stepRequired: providerOrder.stepRequired,
        quoteNotice: "The selected Honeycoin rate was indicative only. Honeycoin calculates the order's actual conversion at order creation.",
      },
    };
  } catch (error) {
    await updateProviderOrder({
      orderId: inserted.order.orderId,
      customerId,
      status: "CREATE_FAILED",
      failureReason: error.message,
    });
    throw error;
  }
}

export async function refreshHoneycoinOrder({ transferId, customerId }) {
  const order = await readProviderOrderByTransfer(transferId, customerId);
  if (!order) throw fail("No Honeycoin order exists for this transfer.", 404);
  if (!order.providerTransactionId) {
    throw fail("The provider order has no transaction ID and requires operator review; it will not be resubmitted automatically.", 409);
  }
  if (["COMPLETED", "FAILED"].includes(order.status)) {
    return { order: publicOrder(order), refreshed: false };
  }

  const provider = await getHoneycoinTransaction(order.providerTransactionId);
  const providerStatus = normalizeProviderStatus(provider.status);
  const chargeStatus = String(provider.chargeStatus || "").toLowerCase();
  const txHash = provider.txId || provider.transactionHash || null;

  if (providerStatus === "FAILED" || chargeStatus === "failed") {
    const updated = await updateProviderOrder({
      orderId: order.orderId, customerId, status: "FAILED",
      providerStatus, failureReason: provider.failureReason || "Honeycoin reports the on-ramp failed.",
    });
    const transfer = await readTransfer(transferId, customerId);
    if (transfer?.status === "AWAITING_FUNDING") {
      await updateTransferStatus({
        id: transferId, customerId, status: "FAILED", actorId: "HONEYCOIN",
        reason: provider.failureReason || "Honeycoin reports the on-ramp failed.",
      });
    }
    return { order: publicOrder(updated), providerStatus, refreshed: true };
  }

  if (chargeStatus === "successful" || providerStatus === "SUCCESSFUL") {
    const transfer = await readTransfer(transferId, customerId);
    if (transfer?.status === "AWAITING_FUNDING") {
      await updateTransferStatus({
        id: transferId, customerId, status: "FUNDED", actorId: "HONEYCOIN",
        reason: "Honeycoin's canonical transaction status confirms successful fiat collection.",
      });
    }
    if (txHash) {
      const chain = String(provider.chain || "base").toLowerCase();
      const receiver = String(provider.receiverAddress || "").toLowerCase();
      const expectedAmount = provider.cryptoAmount;
      if (chain !== "base" || receiver !== order.recipientAddress.toLowerCase()) {
        const updated = await updateProviderOrder({
          orderId: order.orderId, customerId, status: "REVIEW_REQUIRED",
          providerStatus, transactionHash: txHash,
          failureReason: "Provider settlement metadata does not match the saved Base beneficiary.",
        });
        return { order: publicOrder(updated), providerStatus, settlementVerified: false, refreshed: true };
      }
      const verification = await verifyBaseUsdcTransfer({
        transactionHash: txHash,
        recipientAddress: order.recipientAddress,
        cryptoAmount: expectedAmount,
      });
      if (verification.verified) {
        const current = await readTransfer(transferId, customerId);
        if (current?.status === "FUNDED") {
          await updateTransferStatus({
            id: transferId, customerId, status: "SETTLEMENT_PENDING", actorId: "BASE_MAINNET",
            reason: "Honeycoin Base USDC transfer located and matched to the saved beneficiary.",
          });
        }
        if (current?.status === "FUNDED" || current?.status === "SETTLEMENT_PENDING") {
          await updateTransferStatus({
            id: transferId, customerId, status: "COMPLETED", actorId: "BASE_MAINNET",
            reason: `Base USDC transfer confirmed in block ${verification.blockNumber}. Tx: ${txHash}`,
          });
        }
        const updated = await updateProviderOrder({
          orderId: order.orderId, customerId, status: "COMPLETED",
          providerStatus, transactionHash: txHash, failureReason: null,
        });
        return { order: publicOrder(updated), providerStatus, settlementVerified: true, verification, refreshed: true };
      }
      const updated = await updateProviderOrder({
        orderId: order.orderId, customerId, status: "SETTLEMENT_PENDING",
        providerStatus, transactionHash: txHash, failureReason: verification.reason,
      });
      const current = await readTransfer(transferId, customerId);
      if (current?.status === "FUNDED") {
        await updateTransferStatus({
          id: transferId, customerId, status: "SETTLEMENT_PENDING", actorId: "HONEYCOIN",
          reason: "Fiat funding is confirmed; waiting for verifiable Base USDC settlement.",
        });
      }
      return { order: publicOrder(updated), providerStatus, settlementVerified: false, verification, refreshed: true };
    }
    const updated = await updateProviderOrder({
      orderId: order.orderId, customerId, status: "FUNDED",
      providerStatus, failureReason: null,
    });
    return { order: publicOrder(updated), providerStatus, settlementVerified: false, refreshed: true };
  }

  const updated = await updateProviderOrder({
    orderId: order.orderId, customerId,
    status: provider.stepRequired === "redirect" ? "ACTION_REQUIRED" : "AWAITING_PAYMENT",
    providerStatus, failureReason: null,
  });
  return { order: publicOrder(updated), providerStatus, refreshed: true };
}

export async function getHoneycoinOrderForTransfer({ transferId, customerId }) {
  const order = await readProviderOrderByTransfer(transferId, customerId);
  return order ? publicOrder(order) : null;
}
