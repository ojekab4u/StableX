import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  http,
  isAddress,
  parseUnits,
} from "viem";
import { getAsset } from "../config/assets.js";

const MIXED_QUOTER = "0x0A5aA5D3a4d28014f967Bf0f29EAA3FF9807D5c6";
const QUOTER_ABI = [{
  type: "function",
  name: "quoteExactInput",
  stateMutability: "nonpayable",
  inputs: [
    { name: "path", type: "bytes" },
    { name: "amountIn", type: "uint256" },
  ],
  outputs: [
    { name: "amountOut", type: "uint256" },
    { name: "sqrtPriceX96AfterList", type: "uint160[]" },
    { name: "initializedTicksCrossedList", type: "uint32[]" },
    { name: "gasEstimate", type: "uint256" },
  ],
}];

const DEFAULT_TICK_SPACINGS = [1, 5, 10, 50, 100, 200, 500, 1000, 2000];

function getTickSpacings() {
  const configured = String(process.env.BASE_SLIPSTREAM_TICK_SPACINGS || "").trim();
  if (!configured) return DEFAULT_TICK_SPACINGS;
  const values = configured.split(",").map((value) => Number(value.trim()));
  if (!values.length || values.some((value) => !Number.isInteger(value) || value <= 0 || value > 887272)) {
    throw new Error("BASE_SLIPSTREAM_TICK_SPACINGS must be a comma-separated list of positive integers.");
  }
  return [...new Set(values)];
}

function getClient() {
  const rpcUrl = String(
    process.env.BASE_RPC_URL ||
    process.env.BASE_MAINNET_RPC_URL ||
    "https://mainnet.base.org"
  ).trim();
  return createPublicClient({ transport: http(rpcUrl, { timeout: 15_000 }) });
}

export function getAerodromeReadiness() {
  const rpcConfigured = Boolean(process.env.BASE_RPC_URL || process.env.BASE_MAINNET_RPC_URL);
  return {
    name: "Aerodrome Slipstream",
    configured: true,
    status: rpcConfigured ? "PUBLIC_BASE_RPC_CONFIGURED" : "PUBLIC_BASE_RPC_FALLBACK",
    network: "BASE",
    chainId: 8453,
    quoteContract: MIXED_QUOTER,
    capabilities: ["LIVE_READ_ONLY_ONCHAIN_QUOTES"],
    executionEnabled: false,
    note: "Quotes are obtained through Base eth_call. No wallet signature, approval, order or transaction is created.",
  };
}

export async function getAerodromeQuote({ from, to, amount }) {
  const source = getAsset(from);
  const destination = getAsset(to);
  const tokenIn = source?.contractAddresses?.BASE;
  const tokenOut = destination?.contractAddresses?.BASE;

  if (!source || !destination || !tokenIn || !tokenOut ||
      !Number.isInteger(source.decimals) || !Number.isInteger(destination.decimals) ||
      !isAddress(tokenIn) || !isAddress(tokenOut)) {
    const error = new Error("Aerodrome Slipstream quotes require verified Base token addresses and decimals for both assets.");
    error.statusCode = 400;
    throw error;
  }

  const client = getClient();
  const chainId = await client.getChainId();
  if (chainId !== 8453) {
    const error = new Error(`Base quote adapter expected chain ID 8453 but RPC returned ${chainId}.`);
    error.statusCode = 503;
    throw error;
  }

  const amountIn = parseUnits(String(amount), source.decimals);
  let best = null;
  const unavailable = [];

  for (const tickSpacing of getTickSpacings()) {
    const path = encodePacked(
      ["address", "int24", "address"],
      [tokenIn, tickSpacing, tokenOut]
    );
    try {
      const callData = encodeFunctionData({
        abi: QUOTER_ABI,
        functionName: "quoteExactInput",
        args: [path, amountIn],
      });
      const callResult = await client.call({ to: MIXED_QUOTER, data: callData });
      if (!callResult.data) continue;
      const [amountOut, , initializedTicksCrossed, gasEstimate] = decodeFunctionResult({
        abi: QUOTER_ABI,
        functionName: "quoteExactInput",
        data: callResult.data,
      });
      if (amountOut === 0n) continue;

      const destinationAmount = Number(formatUnits(amountOut, destination.decimals));
      if (!Number.isFinite(destinationAmount) || destinationAmount <= 0) continue;
      const candidate = {
        destinationAmount,
        tickSpacing,
        initializedTicksCrossed: initializedTicksCrossed?.[0] ?? null,
        gasEstimate: gasEstimate?.toString?.() ?? null,
      };
      if (!best || candidate.destinationAmount > best.destinationAmount) best = candidate;
    } catch (error) {
      unavailable.push({ tickSpacing, reason: error.shortMessage || error.message });
    }
  }

  if (!best) {
    const error = new Error("No Aerodrome Slipstream pool returned a valid quote for this Base token pair and amount.");
    error.statusCode = 404;
    error.providerDiagnostics = unavailable.slice(0, 3);
    throw error;
  }

  return {
    provider: "Aerodrome Slipstream",
    quoteType: "LIVE_ONCHAIN_QUOTE",
    from,
    to,
    amount: Number(amount),
    toAmount: best.destinationAmount,
    rate: best.destinationAmount / Number(amount),
    network: "BASE",
    chainId: 8453,
    tokenIn,
    tokenOut,
    tickSpacing: best.tickSpacing,
    initializedTicksCrossed: best.initializedTicksCrossed,
    gasEstimate: best.gasEstimate,
    observedAt: new Date().toISOString(),
    executionEnabled: false,
    providerData: {
      quoteContract: MIXED_QUOTER,
      tickSpacing: best.tickSpacing,
      initializedTicksCrossed: best.initializedTicksCrossed,
      gasEstimate: best.gasEstimate,
      unavailableTickSpacings: unavailable.slice(0, 3),
    },
    note: "Read-only on-chain quote from the current Base state. It is not a liquidity reservation or guaranteed execution price; no transaction was sent.",
  };
}
