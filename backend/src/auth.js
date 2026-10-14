import { randomBytes, createHmac, timingSafeEqual, createHash } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import nodemailer from "nodemailer";
import argon2 from "argon2";

export const SESSION_SECONDS = 60 * 60 * 12;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

export function validPassword(password) {
  const value = String(password || "");
  return value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH;
}

export function generateSecureToken(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

export function hashPassword(password) {
  return argon2.hash(String(password || ""));
}

export async function verifyPassword(candidate, hashValue) {
  if (!candidate || !hashValue) return false;
  try {
    return await argon2.verify(hashValue, String(candidate));
  } catch {
    return false;
  }
}

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createSessionToken(secret, sessionId = generateSecureToken(24), now = Date.now()) {
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
    return Boolean(
      session &&
      typeof session.sid === "string" &&
      session.sid.length >= 16 &&
      Number.isInteger(session.exp) &&
      session.exp > Math.floor(now / 1000),
    );
  } catch {
    return false;
  }
}

export function decodeSessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const [payload] = token.split(".");
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function buildSessionCookie(sessionToken, { secure = false, sameSite = "Lax" } = {}) {
  const secureSuffix = secure ? "; Secure" : "";
  return `clipper_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${SESSION_SECONDS}${secureSuffix}`;
}

export function clearSessionCookie({ secure = false, sameSite = "Lax" } = {}) {
  const secureSuffix = secure ? "; Secure" : "";
  return `clipper_session=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0${secureSuffix}`;
}

export function hashToken(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function readJsonBody(request, maxBytes = 16384) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

export function getClientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return request.socket?.remoteAddress || "unknown";
}

export function buildGoogleOAuthUrl({ clientId, redirectUri, state, codeVerifier }) {
  const oauth = new OAuth2Client(clientId, "", redirectUri);
  const codeChallenge = codeVerifier
    ? createHash("sha256").update(codeVerifier).digest("base64url")
    : undefined;
  return oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    scope: ["openid", "email", "profile"],
    redirect_uri: redirectUri,
  });
}

export async function exchangeGoogleCode({ clientId, clientSecret, redirectUri, code, codeVerifier }) {
  const oauth = new OAuth2Client(clientId, clientSecret, redirectUri);
  const { tokens } = await oauth.getToken({
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });
  return tokens;
}

export function createTransport(config) {
  if (!config.smtpHost || !config.emailFrom) return null;
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: Number(config.smtpPort || 587),
    secure: Boolean(config.smtpSecure),
    auth: config.smtpUser && config.smtpPass ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });
}

export async function sendTransactionalEmail({ to, subject, html, text, config }) {
  const transport = createTransport(config);
  if (!transport || !to) {
    return false;
  }
  await transport.sendMail({
    from: config.emailFrom,
    to,
    subject,
    html,
    text,
  });
  return true;
}

export function buildVerificationEmail({ name, url }) {
  return {
    subject: "Verify your Clipper account",
    text: `Hi ${name || "there"},\n\nPlease verify your email address to complete your Clipper account: ${url}\n\nIf you did not create this account, you can ignore this email.`,
    html: `<p>Hi ${name || "there"},</p><p>Please verify your email address to complete your Clipper account:</p><p><a href="${url}">${url}</a></p><p>If you did not create this account, you can ignore this email.</p>`,
  };
}

export function buildPasswordResetEmail({ name, url }) {
  return {
    subject: "Reset your Clipper password",
    text: `Hi ${name || "there"},\n\nUse the link below to reset your Clipper password: ${url}\n\nThis link expires in 1 hour.`,
    html: `<p>Hi ${name || "there"},</p><p>Use the link below to reset your Clipper password:</p><p><a href="${url}">${url}</a></p><p>This link expires in 1 hour.</p>`,
  };
}
