import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGoogleOAuthUrl,
  isValidEmail,
  normalizeEmail,
  validPassword,
} from "../backend/src/auth.js";

test("account input normalization and password length are strict", () => {
  assert.equal(normalizeEmail("  PERSON@Example.com "), "person@example.com");
  assert.equal(isValidEmail("person@example.com"), true);
  assert.equal(isValidEmail("person@example"), false);
  assert.equal(validPassword("long-enough-password"), true);
  assert.equal(validPassword({ value: "long-enough-password" }), false);
  assert.equal(validPassword("short"), false);
});

test("Google OAuth requests only OpenID identity scopes and binds state with PKCE", () => {
  const authorization = new URL(buildGoogleOAuthUrl({
    clientId: "client-id",
    redirectUri: "https://app.example.test/api/auth/google/callback",
    state: "csrf-state",
    codeVerifier: "a-secure-code-verifier",
  }));
  assert.deepEqual(authorization.searchParams.get("scope").split(" "), ["openid", "email", "profile"]);
  assert.equal(authorization.searchParams.get("state"), "csrf-state");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorization.searchParams.get("code_challenge"));
  assert.equal(authorization.searchParams.has("access_type"), false);
  assert.equal(authorization.searchParams.get("redirect_uri"), "https://app.example.test/api/auth/google/callback");
});
