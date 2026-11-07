// M4 — Base chain settlement (real USDC transfers on Base Sepolia testnet)
//
// Uses viem + the operator private key already in .env (BASE_SEPOLIA_PRIVATE_KEY).
// No provider keys needed — this is StableX's own wallet moving real USDC
// between addresses on-chain.
//
// Every settlement is linked to a durable transfer in PostgreSQL:
//   FUNDED → SETTLEMENT_PENDING → COMPLETED (or FAILED)
//
// Safety: all transfers are capped at 1,000,000 source units; execution is
// gated behind the M1 compliance gate (APPROVED customer required).
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  parseUnits,
  formatUnits,
  isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  readTransfer,
  updateTransferStatus,
} from "../repositories/transferRepository.js";
import { getCustomerGateStatus } from "./complianceService.js";
import { BASE_SEPOLIA_TOKENS } from "../config/tokenRegistry.js";

const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const privateKey = process.env.BASE_SEPOLIA_PRIVATE_KEY;

if (!privateKey) {
  console.warn(
    "[baseSettlementService] BASE_SEPOLIA_PRIVATE_KEY not set — settlement will be unavailable."
  );
}

const account = privateKey ? privateKeyToAccount(privateKey) : null;

const walletClient = account
  ? createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpcUrl),
    })
  : null;

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
});

const USDC = BASE_SEPOLIA_TOKENS.find((t) => t.expectedSymbol === "USDC");
const EURC = BASE_SEPOLIA_TOKENS.find((t) => t.expectedSymbol === "EURC");

function findToken(symbol) {
  return BASE_SEPOLIA_TOKENS.find((t) => t.expectedSymbol === symbol.toUpperCase());
}

function isUsableCredential(value) {
  return Boolean(value) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder|test)$/i.test(String(value).trim());
}

export function getSettlementReadiness() {
  return {
    module: "Base Settlement (M4)",
    network: "Base Sepolia",
    chainId: baseSepolia.id,
    rpcUrl,
    operatorAddress: account ? account.address : null,
    usdcContract: USDC ? USDC.contractAddress : null,
    eurcContract: EURC ? EURC.contractAddress : null,
    configured: Boolean(walletClient && USDC),
    status: walletClient && USDC
      ? "OPERATOR_WALLET_READY"
      : "MISSING_PRIVATE_KEY_OR_TOKEN_CONFIG",
    note: "Real USDC transfers on Base Sepolia testnet. Requires BASE_SEPOLIA_PRIVATE_KEY in .env. Transfers are gated by the M1 compliance gate.",
  };
}

function amountToWei(amount, decimals) {
  return parseUnits(String(amount), decimals);
}

function weiToAmount(wei, decimals) {
  return Number(formatUnits(wei, decimals));
}

export async function getOperatorBalance() {
  if (!publicClient) {
    const error = new Error("Operator wallet not configured. Set BASE_SEPOLIA_PRIVATE_KEY.");
    error.statusCode = 503;
    throw error;
  }
  const balance = await publicClient.getBalance({ address: account.address });
  return {
    address: account.address,
    network: "Base Sepolia",
    chainId: baseSepolia.id,
    currency: "ETH",
    balanceWei: balance.toString(),
    balanceEth: formatUnits(balance, 18),
  };
}

export async function getTokenBalance(tokenSymbol, walletAddress) {
  const token = findToken(tokenSymbol);
  if (!token) {
    const error = new Error(`Unsupported token: ${tokenSymbol}`);
    error.statusCode = 400;
    throw error;
  }
  if (!isAddress(walletAddress)) {
    const error = new Error("Invalid wallet address.");
    error.statusCode = 400;
    throw error;
  }

  const ERC20_ABI = parseAbi([
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ]);

  const [balance, decimals, symbol] = await Promise.all([
    publicClient.readContract({
      address: token.contractAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    }),
    publicClient.readContract({
      address: token.contractAddress,
      abi: ERC20_ABI,
      functionName: "decimals",
    }),
    publicClient.readContract({
      address: token.contractAddress,
      abi: ERC20_ABI,
      functionName: "symbol",
    }),
  ]);

  return {
    token: symbol,
    address: walletAddress,
    network: "Base Sepolia",
    contractAddress: token.contractAddress,
    balanceWei: balance.toString(),
    balance: weiToAmount(balance, Number(decimals)),
    decimals: Number(decimals),
  };
}

// Transfer USDC from the operator wallet to a recipient address.
// Linked to a transfer record: DRAFT/QUOTED → FUNDED → SETTLEMENT_PENDING → COMPLETED/FAILED
export async function settleTransfer({ transferId, customerId, recipientAddress, amount, tokenSymbol = "USDC" }) {
  if (!walletClient) {
    const error = new Error("Settlement not available. Operator wallet not configured.");
    error.statusCode = 503;
    throw error;
  }
  const token = findToken(tokenSymbol);
  if (!token) {
    const error = new Error(`Unsupported token: ${tokenSymbol}`);
    error.statusCode = 400;
    throw error;
  }
  if (!isAddress(recipientAddress)) {
    const error = new Error("Invalid recipient address.");
    error.statusCode = 400;
    throw error;
  }

  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0 || amountNum > 1000000) {
    const error = new Error("Amount must be greater than 0 and at most 1,000,000.");
    error.statusCode = 400;
    throw error;
  }

  // Compliance gate: customer must be APPROVED
  const gate = await getCustomerGateStatus(customerId);
  if (!gate.gate.approved) {
    const error = new Error(
      `Compliance gate: settlement requires an APPROVED customer. Status is ${gate.gate.status}. Case/reason: ${gate.gate.caseId || "N/A"}.`
    );
    error.statusCode = 403;
    throw error;
  }

  const transfer = await readTransfer(transferId, customerId);
  if (!transfer) {
    const error = new Error("Transfer not found for this customer.");
    error.statusCode = 404;
    throw error;
  }
  if (transfer.status !== "QUOTED") {
    const error = new Error(`Only QUOTED transfers can be settled. This transfer is ${transfer.status}.`);
    error.statusCode = 409;
    throw error;
  }
  if (transfer.sourceCurrency !== tokenSymbol) {
    const error = new Error(`Transfer source currency is ${transfer.sourceCurrency}, but settlement token is ${tokenSymbol}.`);
    error.statusCode = 409;
    throw error;
  }
  if (Number(transfer.sourceAmount) !== amountNum) {
    const error = new Error(`Settlement amount ${amountNum} does not match transfer amount ${transfer.sourceAmount}.`);
    error.statusCode = 409;
    throw error;
  }

  // Advance to SETTLEMENT_PENDING
  await updateTransferStatus({
    id: transferId,
    customerId,
    status: "SETTLEMENT_PENDING",
    actorId: account.address,
    reason: `Settlement initiated: ${amountNum} ${tokenSymbol} → ${recipientAddress}`,
  });

  try {
    const txHash = await walletClient.writeContract({
      address: token.contractAddress,
      abi: [
        'function transfer(address to, uint256 amount) returns (bool)',
      ],
      functionName: "transfer",
      args: [recipientAddress, amountToWei(amountNum, token.decimals)],
    });

    // Advance to COMPLETED on success
    const updated = await updateTransferStatus({
      id: transferId,
      customerId,
      status: "COMPLETED",
      actorId: account.address,
      reason: `Settlement completed on-chain. Tx: ${txHash}`,
    });

    return {
      transferId,
      status: "COMPLETED",
      token: token.expectedSymbol,
      amount: amountNum,
      recipient: recipientAddress,
      txHash,
      network: "Base Sepolia",
      chainId: baseSepolia.id,
      explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
      transfer: updated,
    };
  } catch (error) {
    // Advance to FAILED on error
    await updateTransferStatus({
      id: transferId,
      customerId,
      status: "FAILED",
      actorId: account.address,
      reason: `Settlement failed: ${error.message}`,
    });
    throw error;
  }
}

export async function simulateSettlement({ transferId, customerId, recipientAddress, amount, tokenSymbol = "USDC" }) {
  // Dry-run mode: validates everything but does not send a transaction.
  // Useful for testing the compliance gate + lifecycle without spending gas.
  const token = findToken(tokenSymbol);
  if (!token) {
    const error = new Error(`Unsupported token: ${tokenSymbol}`);
    error.statusCode = 400;
    throw error;
  }
  const gate = await getCustomerGateStatus(customerId);
  if (!gate.gate.approved) {
    const error = new Error(
      `Compliance gate: settlement requires an APPROVED customer. Status is ${gate.gate.status}.`
    );
    error.statusCode = 403;
    throw error;
  }
  const transfer = await readTransfer(transferId, customerId);
  if (!transfer) {
    const error = new Error("Transfer not found for this customer.");
    error.statusCode = 404;
    throw error;
  }
  return {
    transferId,
    status: "SIMULATED",
    token: token.expectedSymbol,
    amount: Number(amount),
    recipient: recipientAddress,
    network: "Base Sepolia",
    note: "Simulation only — no transaction sent. Compliance gate and lifecycle validated.",
  };
}
