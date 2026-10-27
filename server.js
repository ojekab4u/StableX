
import { randomUUID } from "node:crypto";
import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection } from "@solana/web3.js";
import { getQuotes } from "./providers/demoProviders.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rpcUrl =
  process.env.SOLANA_RPC_URL ||
  "https://api.devnet.solana.com";

const connection = new Connection(rpcUrl, "confirmed");

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

const supportedCurrencies = new Set(["USDT", "USDC", "NGN"]);
const selections = new Map();

// Health endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    application: "StableX",
    mode: "DEMO"
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

// Record the user's provider selection.
app.post("/api/selections", (req, res) => {
  const { quoteId, from, to, amount } = req.body ?? {};

  const validCurrencies =
    supportedCurrencies.has(from) &&
    supportedCurrencies.has(to) &&
    from !== to;

  if (
    typeof quoteId !== "string" ||
    !validCurrencies ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 1000000
  ) {
    return res.status(400).json({
      error: "Invalid selection details."
    });
  }

  
  const selectionId = randomUUID();
  const selection = {
    selectionId,
    quoteId,
    from,
    to,
    amount,
    status: "SELECTED_DEMO",
    createdAt: new Date().toISOString(),
    transactionSubmitted: false
  };

  selections.set(selectionId, selection);

  res.status(201).json({
    message: "Provider selection recorded for demonstration.",
    selection
  });
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

// Handle unknown API endpoints
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

app.listen(PORT, () => {
  console.log(`StableX running at http://localhost:${PORT}`);
  console.log("Quote mode: DEMO (no live prices or transactions)");
  console.log(`Solana RPC: ${rpcUrl}`);
});
