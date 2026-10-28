
import "dotenv/config";
import {
  createPublicClient,
  http,
  formatEther,
  isAddress,
} from "viem";
import { base } from "viem/chains";

const expectedChainId = Number(process.env.BASE_CHAIN_ID || 8453);
const rpcUrl =
  process.env.BASE_RPC_URL || "https://mainnet.base.org";

const baseClient = createPublicClient({
  chain: base,
  transport: http(rpcUrl),
});

export async function checkBaseConnection() {
  const chainId = await baseClient.getChainId();

  if (chainId !== expectedChainId || chainId !== 8453) {
    throw new Error(
      `Wrong network: expected Base Mainnet (8453), received ${chainId}`
    );
  }

  const blockNumber = await baseClient.getBlockNumber();

  return {
    connected: true,
    network: "Base Mainnet",
    chainId,
    blockNumber: blockNumber.toString(),
    rpcUrl,
  };
}

export async function getBaseWalletBalance(address) {
  if (!isAddress(address)) {
    throw new Error("Invalid Ethereum wallet address.");
  }

  const chainId = await baseClient.getChainId();

  if (chainId !== 8453) {
    throw new Error(
      `Wrong network: expected Base Mainnet (8453), received ${chainId}`
    );
  }

  const balanceWei = await baseClient.getBalance({
    address,
  });

  return {
    address,
    network: "Base Mainnet",
    chainId,
    currency: "ETH",
    balanceWei: balanceWei.toString(),
    balanceEth: formatEther(balanceWei),
  };
}
