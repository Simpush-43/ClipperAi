import { MongoClient, ObjectId } from "mongodb";
import { OAuth2Client } from "google-auth-library";
import {
  buildPasswordResetEmail,
  createSessionToken,
  decodeSessionToken,
  generateSecureToken,
  hashPassword,
  hashToken,
  isValidEmail,
  normalizeEmail,
  validPassword,
  verifySessionToken,
  verifyPassword,
} from "./auth.js";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, verificationTokenHash, verificationExpiresAt, resetTokenHash, resetExpiresAt, googleSub, ...rest } = user;
  return {
    ...rest,
    id: rest._id ? rest._id.toString() : rest.id,
  };
}

export function createSessionRecord({ secret, user, sessionStore, sessionId = generateSecureToken(24), now = Date.now() }) {
  const token = createSessionToken(secret, sessionId, now);
  const expiresAt = new Date(now + SESSION_TTL_MS);
  sessionStore.set(sessionId, {
    userId: user._id.toString(),
    email: user.email,
    name: user.name || "",
    createdAt: new Date(now),
    expiresAt,
  });
  return { sessionId, token, expiresAt };
}

export async function getUserByEmail(config, email) {
  const mongo = new MongoClient(config.mongoUri);
  try {
    await mongo.connect();
    const users = mongo.db(config.mongoDb).collection("users");
    return await users.findOne({ email: normalizeEmail(email) });
  } finally {
    await mongo.close();
  }
}

export async function createAccount({ config, email, password, name = "", sessionStore, secret }) {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    return { ok: false, status: 400, error: "Enter a valid email address." };
  }
  if (!validPassword(password)) {
    return { ok: false, status: 400, error: "Use a password with at least 12 characters." };
  }
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) {
    return { ok: false, status: 400, error: "Enter a name with 100 characters or fewer." };
  }

  const mongo = new MongoClient(config.mongoUri);
  try {
    await mongo.connect();
    const users = mongo.db(config.mongoDb).collection("users");
    const existing = await users.findOne({ email: normalizedEmail });
    if (existing) {
      return { ok: false, status: 409, error: "An account with that email already exists." };
    }

    const now = new Date();
    const entity = {
      _id: new ObjectId(),
      email: normalizedEmail,
      name: String(name || "").trim().slice(0, 100) || "Clipper user",
      passwordHash: await hashPassword(password),
      emailVerified: false,
      status: "active",
      authProviders: { password: true, google: false },
      createdAt: now,
      updatedAt: now,
      verificationTokenHash: null,
      verificationExpiresAt: null,
      resetTokenHash: null,
      resetExpiresAt: null,
    };

    try {
      await users.insertOne(entity);
    } catch (error) {
      if (error.code === 11000) return { ok: false, status: 409, error: "An account with that email already exists." };
      throw error;
    }

    const session = createSessionRecord({ secret, user: entity, sessionStore });
    return {
      ok: true,
      user: sanitizeUser(entity),
      token: session.token,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
    };
  } finally {
    await mongo.close();
  }
}

export async function loginWithPassword({ config, email, password, sessionStore, secret }) {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    return { ok: false, status: 400, error: "Enter a valid email address." };
  }
  if (typeof password !== "string" || !password.trim()) {
    return { ok: false, status: 400, error: "Enter your password." };
  }

  const mongo = new MongoClient(config.mongoUri);
  try {
    await mongo.connect();
    const users = mongo.db(config.mongoDb).collection("users");
    const user = await users.findOne({ email: normalizedEmail });
    if (!user) {
      return { ok: false, status: 401, error: "Invalid email or password." };
    }
    const matches = await verifyPassword(password, user.passwordHash);
    if (!matches) {
      return { ok: false, status: 401, error: "Invalid email or password." };
    }
    if (user.status === "disabled") {
      return { ok: false, status: 401, error: "Invalid email or password." };
    }
    const session = createSessionRecord({ secret, user, sessionStore });
    const updated = {
      ...user,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    };
    await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: updated.lastLoginAt, updatedAt: updated.updatedAt } });
    return {
      ok: true,
      user: sanitizeUser(updated),
      token: session.token,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
    };
  } finally {
    await mongo.close();
  }
}

export async function verifyEmailToken({ config, token }) {
  const value = String(token || "").trim();
  if (!value) {
    return { ok: false, status: 400, error: "Missing verification token." };
  }

  const mongo = new MongoClient(config.mongoUri);
  try {
    await mongo.connect();
    const users = mongo.db(config.mongoDb).collection("users");
    const user = await users.findOne({ verificationTokenHash: hashToken(value), verificationExpiresAt: { $gt: new Date() } });
    if (!user) {
      return { ok: false, status: 400, error: "This verification link is invalid or expired." };
    }
    await users.updateOne({ _id: user._id }, {
      $set: { emailVerified: true, verificationTokenHash: null, verificationExpiresAt: null, updatedAt: new Date() },
    });
    return { ok: true, user: sanitizeUser({ ...user, emailVerified: true }) };
  } finally {
    await mongo.close();
  }
}

export async function requestPasswordReset({ config, email, appBaseUrl = process.env.APP_BASE_URL || "http://localhost:5173", sessionStore, secret }) {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    return { ok: false, status: 400, error: "Enter a valid email address." };
  }

  const mongo = new MongoClient(config.mongoUri);
  try {
    await mongo.connect();
    const users = mongo.db(config.mongoDb).collection("users");
    const user = await users.findOne({ email: normalizedEmail });
    if (!user) {
      return { ok: true, message: "If that account exists, a reset link was sent." };
    }

    const resetToken = generateSecureToken(32);
    await users.updateOne({ _id: user._id }, {
      $set: {
        resetTokenHash: hashToken(resetToken),
        resetExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
        updatedAt: new Date(),
      },
    });

    if (config.smtpHost && config.emailFrom) {
      const resetUrl = `${appBaseUrl.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(resetToken)}`;
      const emailContent = buildPasswordResetEmail({ name: user.name, url: resetUrl });
      await sendTransactionalEmail({ to: user.email, subject: emailContent.subject, html: emailContent.html, text: emailContent.text, config });
    }

    return { ok: true, message: "If that account exists, a reset link was sent." };
  } finally {
    await mongo.close();
  }
}

export async function resetPassword({ config, token, password }) {
  const value = String(token || "").trim();
  if (!value) {
    return { ok: false, status: 400, error: "Missing reset token." };
  }
  if (!validPassword(password)) {
    return { ok: false, status: 400, error: "Use a password with at least 12 characters." };
  }

  const mongo = new MongoClient(config.mongoUri);
  try {
    await mongo.connect();
    const users = mongo.db(config.mongoDb).collection("users");
    const user = await users.findOne({ resetTokenHash: hashToken(value), resetExpiresAt: { $gt: new Date() } });
    if (!user) {
      return { ok: false, status: 400, error: "This reset link is invalid or expired." };
    }
    await users.updateOne({ _id: user._id }, {
      $set: {
        passwordHash: await hashPassword(password),
        resetTokenHash: null,
        resetExpiresAt: null,
        updatedAt: new Date(),
      },
    });
    return { ok: true, message: "Your password has been reset.", userId: user._id.toString() };
  } finally {
    await mongo.close();
  }
}

export async function resolveSessionUser({ config, sessionStore, secret, token }) {
  if (!verifySessionToken(token, secret)) return null;
  const payload = decodeSessionToken(token);
  if (!payload || !payload.sid) return null;
  const session = sessionStore.get(payload.sid);
  if (!session || session.expiresAt <= new Date()) {
    sessionStore.delete(payload.sid);
    return null;
  }

  const mongo = new MongoClient(config.mongoUri);
  try {
    await mongo.connect();
    const users = mongo.db(config.mongoDb).collection("users");
    const user = await users.findOne({ _id: new ObjectId(session.userId) });
    if (!user || user.status === "disabled") return null;
    return sanitizeUser(user);
  } catch (error) {
    console.error("Unable to restore account session:", error.name);
    throw error;
  } finally {
    await mongo.close();
  }
}

export async function createGoogleSession({ config, sessionStore, secret, idToken, googleClientId, linkUserId = null }) {
  if (!googleClientId) {
    return { ok: false, status: 400, error: "Google sign-in is not configured." };
  }

  const client = new OAuth2Client(googleClientId);
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: googleClientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      return { ok: false, status: 400, error: "Google account could not be verified." };
    }

    const normalizedEmail = normalizeEmail(payload.email);
    const mongo = new MongoClient(config.mongoUri);
    try {
      await mongo.connect();
      const users = mongo.db(config.mongoDb).collection("users");
      const now = new Date();
      let user = linkUserId
        ? await users.findOne({ _id: new ObjectId(linkUserId), status: { $ne: "disabled" } })
        : await users.findOne({ googleSub: payload.sub });
      if (linkUserId) {
        if (!user || user.email !== normalizedEmail || (user.googleSub && user.googleSub !== payload.sub)) {
          return { ok: false, status: 409, error: "This Google account cannot be linked to the signed-in account." };
        }
        const linkedAccount = await users.findOne({ googleSub: payload.sub, _id: { $ne: user._id } });
        if (linkedAccount) {
          return { ok: false, status: 409, error: "This Google account is already connected to another account." };
        }
        await users.updateOne({ _id: user._id }, {
          $set: {
            googleSub: payload.sub,
            emailVerified: true,
            authProviders: { ...user.authProviders, google: true },
            updatedAt: now,
          },
        });
        user = { ...user, googleSub: payload.sub, emailVerified: true, authProviders: { ...user.authProviders, google: true }, updatedAt: now };
      }
      if (!user) {
        const emailOwner = await users.findOne({ email: normalizedEmail });
        if (emailOwner) {
          return { ok: false, status: 409, error: "This email already has an account. Sign in with that account before connecting Google." };
        }

        user = {
        _id: new ObjectId(),
        email: normalizedEmail,
        name: payload.name || "Google user",
        passwordHash: null,
        emailVerified: true,
        googleSub: payload.sub,
        status: "active",
        authProviders: { password: false, google: true },
        createdAt: now,
        updatedAt: now,
        verificationTokenHash: null,
        verificationExpiresAt: null,
        resetTokenHash: null,
        resetExpiresAt: null,
        };
        await users.insertOne(user);
      }

      if (user.status === "disabled") {
        return { ok: false, status: 401, error: "Google sign-in failed. Please try again." };
      }
      const session = createSessionRecord({ secret, user, sessionStore });
      return {
        ok: true,
        user: sanitizeUser(user),
        token: session.token,
        sessionId: session.sessionId,
      };
    } finally {
      await mongo.close();
    }
  } catch (error) {
    console.error("Google authentication failed:", error.name);
    return { ok: false, status: 401, error: "Google sign-in failed. Please try again." };
  }
}
