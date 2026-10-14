import { createHmac, timingSafeEqual, pbkdf2Sync, randomBytes } from "node:crypto";

const SESSION_SECONDS = 60 * 60 * 12;
const PBKDF2_ITERATIONS = 200_000;
const PBKDF2_KEY_LENGTH = 32;

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function hashPassword(password, salt = randomBytes(16).toString("base64url")) {
  const derived = pbkdf2Sync(String(password), salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, "sha256");
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${salt}$${derived.toString("base64url")}`;
}

export function passwordMatches(candidate, expected) {
  const candidateValue = typeof candidate === "string" ? candidate : String(candidate ?? "");
  const expectedValue = typeof expected === "string" ? expected : String(expected ?? "");

  if (!candidateValue || !expectedValue) {
    return false;
  }

  if (expectedValue.startsWith("pbkdf2_sha256$")) {
    const [, iterationValue, salt, expectedHash] = expectedValue.split("$");
    if (!iterationValue || !salt || !expectedHash) {
      return false;
    }

    const iterations = Number(iterationValue);
    if (!Number.isInteger(iterations) || iterations <= 0) {
      return false;
    }

    const derived = pbkdf2Sync(candidateValue, salt, iterations, PBKDF2_KEY_LENGTH, "sha256");
    const expectedBuffer = Buffer.from(expectedHash, "base64url");
    if (derived.length !== expectedBuffer.length) {
      return false;
    }
    return timingSafeEqual(derived, expectedBuffer);
  }

  const candidateBuffer = Buffer.from(candidateValue);
  const expectedBuffer = Buffer.from(expectedValue);
  if (candidateBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

export function createSessionToken(secret, now = Date.now()) {
  const sessionId = randomBytes(18).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sid: sessionId,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + SESSION_SECONDS,
  })).toString("base64url");
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
    if (!session || typeof session.sid !== "string" || session.sid.length < 16) {
      return false;
    }
    return Number.isInteger(session.exp) && session.exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
}
