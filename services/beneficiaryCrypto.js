import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
function getKey() {
  const encoded=process.env.BENEFICIARY_ENCRYPTION_KEY;
  if(!encoded) throw new Error("BENEFICIARY_ENCRYPTION_KEY is not configured.");
  const key=Buffer.from(encoded,"base64");
  if(key.length!==32) throw new Error("BENEFICIARY_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}
export function encryptBeneficiaryDetails(details) {
  const iv=randomBytes(12), cipher=createCipheriv("aes-256-gcm",getKey(),iv);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(details),"utf8"),cipher.final()]);
  return {algorithm:"aes-256-gcm",iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),ciphertext:ciphertext.toString("base64")};
}
export function decryptBeneficiaryDetails(envelope) {
  const decipher=createDecipheriv("aes-256-gcm",getKey(),Buffer.from(envelope.iv,"base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag,"base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,"base64")),decipher.final()]).toString("utf8"));
}
export function fingerprintBeneficiary(details) { return createHash("sha256").update(JSON.stringify(details)).digest("hex"); }
