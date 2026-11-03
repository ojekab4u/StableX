
import {
  checkVaultConnection,
  getVaultDetails,
  getVaultOwner,
  getStoredNumber,
  updateStoredNumber,
} from "./baseVault.js";

import { randomUUID } from "node:crypto";
import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAsset,
  getAllAssets,
  getAssetPairs,
} from "./config/assets.js";
import { checkBaseConnection, getBaseWalletBalance, } from "./baseConnection.js";
import { Connection } from "@solana/web3.js";
import { sendRouter } from "./routes/sendRoutes.js";
import { getQuotes, 
  getDemoSupportedPairs, } from "./providers/demoProviders.js";
import { sendRouter } from "./routes/sendRoutes.js";
const app = express();
const PORT = Number(process.env.PORT || 3000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rpcUrl =
  process.env.SOLANA_RPC_URL ||
  "https://api.devnet.solana.com";

const connection = new Connection(rpcUrl, "confirmed");

app.use(express.json({
  limit: "10kb",
  verify: (req, _res, buffer) => { req.rawBody = buffer.toString("utf8"); },
}));
app.use(express.static(path.join(__dirname, "public")));

const supportedCurrencies = new Set(["USDT", "USDC", "NGN"]);
const selections = new Map();
// Quotes issued by this server, keyed by their unique quote ID.
const issuedQuotes = new Map();

// Health endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    application: "StableX",
    mode: "DEMO"
  });
});

// List all registered currencies and tokens
app.get("/api/assets", (req, res) => {
  res.json({
    count: getAllAssets().length,
    assets: getAllAssets(),
  });
});

// Retrieve a specific currency or token
app.get("/api/assets/:code", (req, res) => {
  const asset = getAsset(req.params.code);

  if (!asset) {
    return res.status(404).json({
      error: "Asset not found.",
    });
  }

  res.json({ asset });
});

// List configured exchange pairs
app.get("/api/pairs", (req, res) => {
  const demoPairs = new Set(
    getDemoSupportedPairs().map(
      (pair) => `${pair.from}-${pair.to}`
    )
  );

  const pairs = getAssetPairs().map((pair) => {
    const pairKey = `${pair.from}-${pair.to}`;
    const demoSupported = demoPairs.has(pairKey);

    return {
      ...pair,
      quoteMode: demoSupported ? "DEMO" : "NOT_CONFIGURED",
      quoteAvailable: demoSupported,
      executionEnabled: false,
    };
  });

  res.json({
    count: pairs.length,
    pairs,
  });
});

// List supported currencies and pairs
app.get("/api/currencies", (req, res) => {
  res.json({
    currencies: [...supportedCurrencies],
    pairs: [
      ["USDT", "NGN"],
      ["USDC", "NGN"],
      ["NGN", "USDT"],
      ["NGN", "USDC"],
      ["USDT", "USDC"],
      ["USDC", "USDT"]
    ]
  });
});


// Compare provider quotes
app.get("/api/quotes", async (req, res) => {
  const amount = Number(req.query.amount);
  const from = String(req.query.from || "").toUpperCase();
  const to = String(req.query.to || "").toUpperCase();

  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    return res.status(400).json({
      error: "Amount must be greater than 0 and at most 1,000,000."
    });
  }

  if (
    !supportedCurrencies.has(from) ||
    !supportedCurrencies.has(to) ||
    from === to
  ) {
    return res.status(400).json({
      error: "Select two different supported currencies."
    });
  }

  try {
    const quotes = await getQuotes({ amount, from, to });

    // Remove expired quotes from the registry.
    for (const [id, quote] of issuedQuotes) {
      if (Date.parse(quote.expiresAt) <= Date.now()) {
        issuedQuotes.delete(id);
      }
    }

    // Store every quote issued by the server.
    for (const quote of quotes) {
      issuedQuotes.set(quote.id, {
        ...quote,
        amount,
        from,
        to
      });
    }

    res.json({
      amount,
      from,
      to,
      mode: "DEMO",
      disclaimer:
        "Synthetic rates for demonstration. These are not live quotes.",
      quotes
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});


// Record a provider selection after validating its original quote.
app.post("/api/selections", (req, res) => {
  const { quoteId } = req.body ?? {};

  const from = String(req.body?.from || "").toUpperCase();
  const to = String(req.body?.to || "").toUpperCase();
  const amount = req.body?.amount;

  if (
    typeof quoteId !== "string" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 1000000
  ) {
    return res.status(400).json({
      error: "Invalid selection details."
    });
  }

  // Retrieve the actual quote issued by this server.
  const quote = issuedQuotes.get(quoteId);

  if (!quote) {
    return res.status(404).json({
      error: "Quote not found or no longer available. Compare offers again."
    });
  }

  // Check the quote's expiry.
  if (Date.parse(quote.expiresAt) <= Date.now()) {
    issuedQuotes.delete(quoteId);

    return res.status(410).json({
      error: "This quote has expired. Please request a new quote."
    });
  }

  // Verify that the submitted details match the original quote.
  if (
    quote.from !== from ||
    quote.to !== to ||
    quote.amount !== amount
  ) {
    return res.status(400).json({
      error: "Selection details do not match the issued quote."
    });
  }

  if (quote.status !== "AVAILABLE" || quote.quoteType !== "DEMO") {
    return res.status(400).json({
      error: "This quote is not available for demo selection."
    });
  }

  const selectionId = randomUUID();

  const selection = {
    selectionId,
    quoteId: quote.id,
    provider: quote.provider,

    from: quote.from,
    to: quote.to,
    amount: quote.amount,

    rate: quote.rate,
    grossAmount: quote.grossAmount,
    fee: quote.fee,
    feeCurrency: quote.feeCurrency,
    netAmount: quote.netAmount,

    quoteType: "DEMO",
    status: "SELECTED_DEMO",

    createdAt: new Date().toISOString(),
    quoteExpiresAt: quote.expiresAt,

    transactionSubmitted: false,
    transactionHash: null
  };

  selections.set(selectionId, selection);

  res.status(201).json({
    message: "Provider selection recorded for demonstration.",
    selection
  });
});


// Retrieve all recorded demo selections.
app.get("/api/selections", (req, res) => {
  const history = Array.from(selections.values())
    .sort(
      (a, b) =>
        new Date(b.createdAt) - new Date(a.createdAt)
    );

  res.json({
    count: history.length,
    records: history
  });
});

// Retrieve one selection by its ID.
app.get("/api/selections/:selectionId", (req, res) => {
  const selection = selections.get(req.params.selectionId);

  if (!selection) {
    return res.status(404).json({
      error: "Selection record not found."
    });
  }

  res.json({ selection });
});

// Check Solana Devnet connectivity
app.get("/api/solana/status", async (req, res) => {
  try {
    const [version, slot] = await Promise.all([
      connection.getVersion(),
      connection.getSlot()
    ]);

    res.json({
      connected: true,
      network: "devnet",
      coreVersion: version["solana-core"],
      slot
    });
  } catch (error) {
    console.error("Solana RPC error:", error.message);

    res.status(503).json({
      connected: false,
      network: "devnet",
      error: "Unable to reach Solana Devnet."
    });
  }
});


/**
 * Check Base Mainnet RPC connectivity.
 * This endpoint performs read-only blockchain requests.
 */
app.get("/api/base/status", async (req, res) => {
  try {
    const status = await checkBaseConnection();

    res.json({
      application: "StableX",
      ...status,
    });
  } catch (error) {
    console.error("Base RPC error:", error.message);

    res.status(503).json({
      application: "StableX",
      connected: false,
      network: "Base Mainnet",
      expectedChainId: 8453,
      error: "Unable to connect to Base Mainnet or verify its chain ID.",
      details: error.message,
    });
  }
});


/**
 * Read a wallet's native ETH balance on Base Mainnet.
 * Example: /api/base/balance?address=0x...
 */
app.get("/api/base/balance", async (req, res) => {
  try {
    const address = req.query.address;

    if (typeof address !== "string" || !address.trim()) {
      return res.status(400).json({
        application: "StableX",
        error: "Please provide a wallet address using ?address=0x...",
      });
    }

    const balance = await getBaseWalletBalance(address.trim());

    return res.json({
      application: "StableX",
      ...balance,
    });
  } catch (error) {
    console.error("Base balance error:", error.message);

    const isInvalidAddress =
      error.message === "Invalid Ethereum wallet address.";

    return res.status(isInvalidAddress ? 400 : 503).json({
      application: "StableX",
      error: isInvalidAddress
        ? error.message
        : "Unable to retrieve the Base wallet balance.",
      details: error.message,
    });
  }
});


// Base Sepolia smart contract connection
app.get("/api/base/vault/status", async (req, res) => {
  try {
    const result = await checkVaultConnection();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

// Retrieve all vault information
app.get("/api/base/vault", async (req, res) => {
  try {
    const result = await getVaultDetails();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

// Read the contract owner
app.get("/api/base/vault/owner", async (req, res) => {
  try {
    const owner = await getVaultOwner();

    res.json({ owner });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

// Read the stored number
app.get("/api/base/vault/number", async (req, res) => {
  try {
    const storedNumber = await getStoredNumber();

    res.json({ storedNumber });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

app.post("/api/base/vault/update", async (req, res) => {
  try {
    const { newNumber } = req.body;

    const result = await updateStoredNumber(newNumber);

    res.json(result);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.shortMessage || error.message,
    });
  }
});

app.use("/api/send", sendRouter);
app.use("/api/kyb", kybRouter);

// Handle unknown API endpoints
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});


app.listen(PORT, () => {
  console.log(`StableX running at http://localhost:${PORT}`);
  console.log(`Base RPC: ${process.env.BASE_RPC_URL || "https://mainnet.base.org"}`);
  console.log("Quote mode: DEMO (no live prices or transactions)");
  console.log(`Solana RPC: ${rpcUrl}`);
});
