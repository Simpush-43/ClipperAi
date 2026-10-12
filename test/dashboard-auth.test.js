import test from "node:test";
import assert from "node:assert/strict";
import { createSessionToken, passwordMatches, verifySessionToken } from "../backend/src/dashboard-auth.js";

const secret = "test-secret-long-enough-to-sign-sessions-123456";

test("session token is valid until its expiry and rejects tampering", () => {
  const now = Date.UTC(2026, 9, 11);
  const token = createSessionToken(secret, now);

  assert.equal(verifySessionToken(token, secret, now), true);
  assert.equal(verifySessionToken(token, secret, now + 12 * 60 * 60 * 1000), false);
  assert.equal(verifySessionToken(`${token}x`, secret, now), false);
  assert.equal(verifySessionToken(token, "another-secret-long-enough-to-sign-sessions-123", now), false);
});

test("password comparison accepts matching values and rejects other passwords", () => {
  assert.equal(passwordMatches("correct horse", "correct horse"), true);
  assert.equal(passwordMatches("wrong horse", "correct horse"), false);
});
