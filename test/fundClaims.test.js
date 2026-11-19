import test from "node:test";
import assert from "node:assert/strict";
import { pickClaimForDeposit } from "../services/fundService.js";

const claim = (cadAmount, state = "OPEN", createdAt = "2026-01-01T00:00:00Z") => ({
  cadAmount,
  state,
  createdAt,
});

test("an exact amount match wins over a close one", () => {
  const deposit = { amount: 50, currency: "CAD", status: "FullyProcessed" };
  const claims = [claim(50.01, "OPEN", "2026-01-01"), claim(50, "OPEN", "2026-01-02")];
  const picked = pickClaimForDeposit(deposit, claims);
  assert.equal(picked.cadAmount, 50);
});

test("a tie in difference goes to the oldest claim", () => {
  const deposit = { amount: 50 };
  const claims = [claim(50, "OPEN", "2026-02-01"), claim(50, "OPEN", "2026-01-01")];
  const picked = pickClaimForDeposit(deposit, claims);
  assert.equal(picked.createdAt, "2026-01-01");
});

test("claims outside the tolerance never match", () => {
  const deposit = { amount: 50 };
  const claims = [claim(50.05, "OPEN")];
  assert.equal(pickClaimForDeposit(deposit, claims), null);
});

test("closed claims are ignored", () => {
  const deposit = { amount: 50 };
  const claims = [claim(50, "MATCHED"), claim(50, "CANCELLED")];
  assert.equal(pickClaimForDeposit(deposit, claims), null);
});

test("no claims means no match", () => {
  assert.equal(pickClaimForDeposit({ amount: 50 }, []), null);
});
