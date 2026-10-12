import { createHmac, timingSafeEqual, createHash } from "node:crypto";

const SESSION_SECONDS = 60 * 60 * 12;

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function passwordMatches(candidate, expected) {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

export function createSessionToken(secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + SESSION_SECONDS })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token, secret, now = Date.now()) {
  if (!token || typeof token !== "string") return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;

  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number.isInteger(session.exp) && session.exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
}
