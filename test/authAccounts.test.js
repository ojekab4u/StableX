import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRegistration,
  validateDateOfBirth,
  hashPassword,
  verifyPassword,
  sha256Hex,
  generateVerificationCode,
  sessionExpiry,
} from "../services/accountService.js";
import { buildComplianceSubject, buildProviderPrefill } from "../services/complianceSubject.js";

const validPersonal = {
  email: "ada@example.com",
  phone: "+2348012345678",
  password: "correct-horse-7",
  accountType: "PERSONAL",
  fullName: "Ada Lovelace",
  country: "NG",
};

test("registration validation accepts a valid personal account", () => {
  assert.deepEqual(validateRegistration(validPersonal), []);
});

test("registration validation accepts a valid business account", () => {
  assert.deepEqual(
    validateRegistration({ ...validPersonal, accountType: "BUSINESS", businessName: "Analytical Engines Ltd" }),
    []
  );
});

test("business accounts require a business name", () => {
  const problems = validateRegistration({ ...validPersonal, accountType: "BUSINESS" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /businessName/);
});

test("invalid email, weak password and bad account type are rejected", () => {
  const problems = validateRegistration({
    email: "not-an-email",
    password: "short",
    accountType: "SOLE_TRADER",
    fullName: "",
  });
  assert.equal(problems.length, 5);
});

test("phone must be 7-15 digits with optional +", () => {
  assert.deepEqual(validateRegistration({ ...validPersonal, phone: "+2348012345678" }), []);
  assert.deepEqual(validateRegistration({ ...validPersonal, phone: "2348012345" }), []);
  const problems = validateRegistration({ ...validPersonal, phone: "1234" });
  assert.match(problems[0], /Phone/);
});

test("country is required as a two-letter code (KYC/KYB providers need it)", () => {
  const missing = validateRegistration({ ...validPersonal, country: undefined });
  assert.match(missing[0], /country/);
  const bad = validateRegistration({ ...validPersonal, country: "NGA" });
  assert.match(bad[0], /country/);
  assert.deepEqual(validateRegistration({ ...validPersonal, country: "ng" }), []);
});

test("date of birth is optional but must be a real adult YYYY-MM-DD date", () => {
  assert.deepEqual(validateRegistration({ ...validPersonal, dateOfBirth: "1990-05-14" }), []);
  assert.deepEqual(validateRegistration(validPersonal), []);
  assert.match(validateDateOfBirth("14/05/1990"), /YYYY-MM-DD/);
  assert.match(validateDateOfBirth("2020-01-01"), /18 years/);
});

test("passwords are salted; verification fails for the wrong password", async () => {
  const stored = await hashPassword("correct-horse-7");
  assert.match(stored, /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.notEqual(stored, await hashPassword("correct-horse-7"), "each hash must use a fresh salt");
  assert.equal(await verifyPassword("correct-horse-7", stored), true);
  assert.equal(await verifyPassword("wrong-password-9", stored), false);
  assert.equal(await verifyPassword("correct-horse-7", "garbage"), false);
});

test("sha256 hashing is deterministic and code generation stays 6 digits", () => {
  assert.equal(sha256Hex("abc"), sha256Hex("abc"));
  assert.notEqual(sha256Hex("abc"), sha256Hex("abd"));
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (let i = 0; i < 50; i += 1) {
    assert.match(generateVerificationCode(), /^\d{6}$/);
  }
});

test("session expiry honours the configured lifetime", () => {
  const expiresAt = new Date(sessionExpiry(2));
  const diffMinutes = (expiresAt.getTime() - Date.now()) / 60000;
  assert.ok(diffMinutes > 110 && diffMinutes <= 121, "expiry should be ~2 hours out");
});

test("account data maps onto VOVE KYC subject fields", () => {
  const subject = buildComplianceSubject({
    fullName: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+2348012345678",
    country: "NG",
    dateOfBirth: "1990-05-14",
    accountType: "PERSONAL",
  });
  assert.deepEqual(subject, {
    fullName: "Ada Lovelace",
    firstName: "Ada",
    lastName: "Lovelace",
    country: "NG",
    email: "ada@example.com",
    phone: "+2348012345678",
    dateOfBirth: "1990-05-14",
  });
});

test("business accounts map onto KYB subject fields with extras", () => {
  const subject = buildComplianceSubject(
    { fullName: "Ada Lovelace", email: "ada@example.com", country: "NG", accountType: "BUSINESS", businessName: "Analytical Engines Ltd" },
    { registrationNumber: "RC-123456", city: "Lagos", address: "1 Synthetic Way" }
  );
  assert.equal(subject.businessName, "Analytical Engines Ltd");
  assert.equal(subject.registrationNumber, "RC-123456");
  assert.equal(subject.city, "Lagos");
  assert.equal(subject.address, "1 Synthetic Way");
  assert.equal(subject.dateOfBirth, undefined);
});

test("provider prefill exposes what Bridge can draw from registration data", () => {
  const prefill = buildProviderPrefill({
    fullName: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+2348012345678",
    country: "NG",
    dateOfBirth: "1990-05-14",
    accountType: "PERSONAL",
  });
  assert.equal(prefill.vove.subjectType, "INDIVIDUAL");
  assert.equal(prefill.bridge.firstName, "Ada");
  assert.equal(prefill.bridge.lastName, "Lovelace");
  assert.equal(prefill.bridge.email, "ada@example.com");
  assert.equal(prefill.bridge.birthDate, "1990-05-14");
  assert.match(prefill.bridge.note, /passport/);
});
