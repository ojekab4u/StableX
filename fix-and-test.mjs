import "dotenv/config";
import { createHmac } from "node:crypto";

// Step 1: Verify env vars are loaded
const apiKey = process.env.VOVE_ID_API_KEY;
const publicKey = process.env.VOVE_ID_PUBLIC_KEY;
const webhookSecret = process.env.VOVE_ID_WEBHOOK_SECRET;

console.log("=== ENV VAR STATUS ===");
console.log("VOVE_ID_API_KEY:", apiKey ? "PRESENT (" + apiKey.substring(0, 8) + "..." + apiKey.substring(-4) + ")" : "MISSING");
console.log("VOVE_ID_PUBLIC_KEY:", publicKey ? "PRESENT (" + publicKey.substring(0, 8) + "..." + publicKey.substring(-4) + ")" : "MISSING");
console.log("VOVE_ID_WEBHOOK_SECRET:", webhookSecret ? "PRESENT (" + webhookSecret.substring(0, 8) + "..." + webhookSecret.substring(-4) + ")" : "MISSING");

// Step 2: Check compliance endpoint
import("node:https").then(https => {
  const req = https.request({ hostname: "localhost", port: 3000, path: "/api/compliance/readiness", method: "GET" }, (res) => {
    let body = "";
    res.on("data", chunk => body += chunk);
    res.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        console.log("\n=== COMPLIANCE ENDPOINT ===");
        console.log("mode:", parsed.mode);
        console.log("realProviderConnected:", parsed.realProviderConnected);
        console.log("providerConfigured (KYC):", parsed.checks.find(c => c.requirement === "KYC")?.providerConfigured);
        console.log("providerConfigured (KYB):", parsed.checks.find(c => c.requirement === "KYB")?.providerConfigured);
        
        // Step 3: Test webhook
        const webhookReq = https.request({ hostname: "localhost", port: 3000, path: "/api/kyb/webhook", method: "POST", headers: { "svix-signature": "test" } }, (res2) => {
          let body2 = "";
          res2.on("data", chunk => body2 += chunk);
          res2.on("end", () => {
            console.log("\n=== WEBHOOK TEST ===");
            console.log("Status:", res2.statusCode);
            console.log("Response:", body2);
          });
        });
        webhookReq.on("error", (e) => {
          console.log("\n=== WEBHOOK ERROR ===");
          console.log("Could not connect to webhook endpoint:", e.message);
        });
        webhookReq.write(JSON.stringify({ test: "webhook" }));
        webhookReq.end();
      } catch(e) {
        console.log("\n=== PARSE ERROR ===");
        console.log("Response body:", body);
        console.log("Error:", e.message);
      }
    });
  });
  req.on("error", (e) => {
    console.log("\n=== CONNECTION ERROR ===");
    console.log("Could not connect to localhost:3000 - is the server running?");
    console.log("Error:", e.message);
  });
  req.end();
}).catch(e => console.log("Fatal error:", e.message));