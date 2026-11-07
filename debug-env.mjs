import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(".env");
const raw = fs.readFileSync(envPath, "utf8");
const lines = raw.split("\n");

console.log("=== .env FILE CONTENTS (exact) ===\n");
for (const line of lines) {
  console.log(line);
}

console.log("\n=== ENV VAR PRESENCE CHECK ===\n");
const required = [
  "VOVE_ID_API_KEY",
  "VOVE_ID_PUBLIC_KEY", 
  "VOVE_ID_WEBHOOK_SECRET"
];

for (const key of required) {
  const value = process.env[key];
  console.log(`${key}:`);
  console.log(`  Present: ${!!value}`);
  console.log(`  Length: ${value ? value.length : 0}`);
  console.log(`  Starts with: ${value ? value.substring(0, 6) : "N/A"}`);
  console.log(`  Full value: "${value}"`);
  console.log("");
}