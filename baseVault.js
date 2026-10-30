

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  isAddress,
} from "viem";

import {
  privateKeyToAccount,
} from "viem/accounts";

import { baseSepolia } from "viem/chains";
import "dotenv/config";

// deployed contract
const CONTRACT_ADDRESS =
  "0x8d81e0d3e58af36404a9f1223f9858430f4f8073";

// Base Sepolia contract interface
const vaultAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
      },
    ],
  },
  {
    type: "function",
    name: "storedNumber",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "setNumber",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "newNumber",
        type: "uint256",
      },
    ],
    outputs: [],
  },
];

const rpcUrl =
  process.env.BASE_SEPOLIA_RPC_URL ||
  "https://sepolia.base.org";

// Public client: reads information from Base
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),

  
});

// Backend transaction signer
const privateKey = process.env.BASE_SEPOLIA_PRIVATE_KEY;

if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  throw new Error(
    "Missing or invalid BASE_SEPOLIA_PRIVATE_KEY in .env"
  );
}

const account = privateKeyToAccount(privateKey);

const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(rpcUrl),
});

//network connection check
export async function checkVaultConnection() {
  const chainId = await publicClient.getChainId();

  if (chainId !== 84532) {
    throw new Error(
      `Wrong network. Expected Base Sepolia (84532), received ${chainId}`
    );
  }

  const blockNumber = await publicClient.getBlockNumber();

  return {
    connected: true,
    network: "Base Sepolia",
    chainId,
    blockNumber: blockNumber.toString(),
    contractAddress: CONTRACT_ADDRESS,
  };
}

// Read the contract owner
export async function getVaultOwner() {
  return await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: vaultAbi,
    functionName: "owner",
  });
}

// Read the stored number
export async function getStoredNumber() {
  const number = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: vaultAbi,
    functionName: "storedNumber",
  });

  return number.toString();
}


// Retrieve all relevant vault information
export async function getVaultDetails() {
  const [owner, storedNumber, balance] = await Promise.all([
    getVaultOwner(),
    getStoredNumber(),
    publicClient.getBalance({
      address: CONTRACT_ADDRESS,
    }),
  ]);

  return {
    contractAddress: CONTRACT_ADDRESS,
    owner,
    storedNumber,
    contractBalanceWei: balance.toString(),
    contractBalanceEth: formatEther(balance),
    network: "Base Sepolia",
    chainId: 84532,
  };
}


export async function updateStoredNumber(newNumber) {
  if (
    !Number.isSafeInteger(newNumber) ||
    newNumber < 0
  ) {
    throw new Error(
      "newNumber must be a non-negative safe integer."
    );
  }

  const chainId = await publicClient.getChainId();

  if (chainId !== 84532) {
    throw new Error("Wrong network. Expected Base Sepolia.");
  }

  // Confirm that signer owns the contract
  const owner = await getVaultOwner();

  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      "Unauthorized: this wallet is not the contract owner."
    );
  }

  // Check that the signer has enough test ETH
  const balance = await publicClient.getBalance({
    address: account.address,
  });

  if (balance === 0n) {
    throw new Error("Insufficient ETH for gas fees.");
  }

  // Submit the smart contract transaction
  const hash = await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi: vaultAbi,
    functionName: "setNumber",
    args: [BigInt(newNumber)],
  });

  // Wait for Base to confirm the transaction
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
  });

  if (receipt.status !== "success") {
    throw new Error("Smart contract transaction failed.");
  }

  // Read the updated state
  const updatedNumber = await getStoredNumber();

  return {
    success: true,
    network: "Base Sepolia",
    transactionHash: hash,
    transactionUrl: `https://sepolia.basescan.org/tx/${hash}`,
    contractAddress: CONTRACT_ADDRESS,
    updatedNumber,
    gasUsed: receipt.gasUsed.toString(),
    signer: account.address,
  };
}


// Validating a wallet address before using it
export function validateWalletAddress(address) {
  return isAddress(address);
}
