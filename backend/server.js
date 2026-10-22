import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readRuntimeConfig } from "./src/config.js";
import { createSessionToken, passwordMatches, verifySessionToken } from "./src/dashboard-auth.js";
import { buildGoogleOAuthUrl, decodeSessionToken, exchangeGoogleCode } from "./src/auth.js";
import {
  createAccount,
  createGoogleSession,
  loginWithPassword,
  requestPasswordReset,
  resetPassword,
  resolveSessionUser,
  verifyEmailToken,
} from "./src/accounts.js";
import {
  createInstagramReel,
  deleteClip,
  getInstagramAccountSettings,
  getClipPlaybackUrl,
  getInstagramReelStatus,
  listClips,
  publishInstagramReel,
  saveInstagramAccountId,
  updateClipSocial,
} from "./src/storage.js";
import { createJob, getJob, validateYouTubeUrl } from "./src/jobs.js";
import {
  completeVideoUpload,
  deleteUserVideo,
  getUserVideo,
  getVideoUploadPartUrls,
  getVideoUploadStatus,
  initiateVideoUpload,
  initializeVideoCollections,
  listUserVideos,
  resolvePublicVideo,
  retryVideoProcessing,
  serveVideoAsset,
  startVideoWorker,
  updateVideoSettings,
} from "./src/videos.js";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(projectDir, "..", "frontend", "dist");
const config = readRuntimeConfig();
const password = process.env.DASHBOARD_PASSWORD;
const sessionSecret = process.env.DASHBOARD_SESSION_SECRET;
const port = Number(process.env.PORT || process.env.API_PORT || 3001);

if (password && password.length < 12) throw new Error("DASHBOARD_PASSWORD must be at least 12 characters when configured");
if (!sessionSecret || sessionSecret.length < 32) throw new Error("Set DASHBOARD_SESSION_SECRET in .env (at least 32 characters)");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");

const SESSION_COOKIE_NAME = "clipper_session";
const loginAttempts = new Map();
const sessionStore = new Map();
const oauthTransactions = new Map();

const cookies = (header = "") => Object.fromEntries(header.split(";").map((part) => {
  const index = part.indexOf("=");
  if (index < 0) return ["", ""];
  const key = part.slice(0, index).trim();
  try {
    return [key, decodeURIComponent(part.slice(index + 1).trim())];
  } catch {
    return [key, ""];
  }
}));

function getClientAddress(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return request.socket?.remoteAddress || "unknown";
}

function buildSessionCookie(token, expiresAt = Date.now() + 12 * 60 * 60 * 1000) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200; Expires=${new Date(expiresAt).toUTCString()}${secure}`;
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self' https:; media-src 'self' https:; object-src 'none'; base-uri 'self'",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, maxBytes = 4096) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

function getSessionToken(request) {
  return cookies(request.headers.cookie)[SESSION_COOKIE_NAME] || "";
}

function isAuthenticated(request) {
  const token = getSessionToken(request);
  return verifySessionToken(token, sessionSecret);
}

async function getAuthenticatedUser(request) {
  const token = getSessionToken(request);
  if (!token) return null;
  return resolveSessionUser({ config, sessionStore, secret: sessionSecret, token });
}

function allowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const appOrigin = new URL(config.appBaseUrl).origin;
    const developmentOrigin = process.env.NODE_ENV === "production"
      ? []
      : ["http://localhost:5173", "http://127.0.0.1:5173"];
    return parsed.host === request.headers.host || parsed.origin === appOrigin || developmentOrigin.includes(parsed.origin);
  } catch {
    return false;
  }
}

function checkLoginRateLimit(request) {
  const clientAddress = getClientAddress(request);
  const now = Date.now();
  const previousAttempts = loginAttempts.get(clientAddress) || [];
  const recentAttempts = previousAttempts.filter((timestamp) => now - timestamp < 60_000);

  if (recentAttempts.length >= 5) {
    return false;
  }

  recentAttempts.push(now);
  loginAttempts.set(clientAddress, recentAttempts);
  return true;
}

function startGoogleOAuth(response, linkUser = null) {
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  oauthTransactions.set(state, { codeVerifier, linkUserId: linkUser?.id || null, expiresAt: Date.now() + 10 * 60 * 1000 });
  for (const [key, transaction] of oauthTransactions) {
    if (transaction.expiresAt <= Date.now()) oauthTransactions.delete(key);
  }
  const location = buildGoogleOAuthUrl({
    clientId: config.googleClientId,
    redirectUri: config.googleRedirectUri,
    state,
    codeVerifier,
  });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.writeHead(302, {
    Location: location,
    "Set-Cookie": `clipper_google_state=${state}; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=600${secure}`,
    "Cache-Control": "no-store",
  });
  response.end();
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (allowedOrigin(request)) {
      response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Vary", "Origin");
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && request.headers.origin && !allowedOrigin(request)) {
      return sendJson(response, 403, { error: "Invalid origin" });
    }

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return sendJson(response, 204, "", {
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Range",
      });
    }

    if (request.method === "GET" && url.pathname === "/api/auth/google") {
      if (!config.googleClientId || !config.googleClientSecret) {
        return sendJson(response, 503, { error: "Google sign-in is not configured." });
      }
      return startGoogleOAuth(response);
    }

    if (request.method === "POST" && url.pathname === "/api/auth/google/link") {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      if (!config.googleClientId || !config.googleClientSecret) {
        return sendJson(response, 503, { error: "Google sign-in is not configured." });
      }
      const linkUser = await getAuthenticatedUser(request);
      if (!linkUser) return sendJson(response, 401, { error: "Sign in before connecting Google." });
      return startGoogleOAuth(response, linkUser);
    }

    if (request.method === "GET" && url.pathname === "/api/auth/google/callback") {
      const state = url.searchParams.get("state") || "";
      const transaction = oauthTransactions.get(state);
      oauthTransactions.delete(state);
      const stateCookie = cookies(request.headers.cookie).clipper_google_state;
      const clearStateCookie = `clipper_google_state=; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
      const returnUrl = new URL(config.appBaseUrl);
      if (url.searchParams.has("error") || !transaction || transaction.expiresAt <= Date.now() || stateCookie !== state) {
        returnUrl.searchParams.set("authError", "google");
        response.writeHead(302, { Location: returnUrl.toString(), "Set-Cookie": clearStateCookie, "Cache-Control": "no-store" });
        return response.end();
      }
      try {
        const code = url.searchParams.get("code");
        if (!code) throw new Error("Authorization code missing");
        const tokens = await exchangeGoogleCode({
          clientId: config.googleClientId,
          clientSecret: config.googleClientSecret,
          redirectUri: config.googleRedirectUri,
          code,
          codeVerifier: transaction.codeVerifier,
        });
        if (!tokens.id_token) throw new Error("Identity token missing");
        const result = await createGoogleSession({
          config,
          sessionStore,
          secret: sessionSecret,
          idToken: tokens.id_token,
          googleClientId: config.googleClientId,
          linkUserId: transaction.linkUserId,
        });
        if (!result.ok) throw new Error(result.error);
        response.writeHead(302, {
          Location: returnUrl.toString(),
          "Set-Cookie": [
            clearStateCookie,
            buildSessionCookie(result.token, new Date(result.expiresAt).getTime()),
          ],
          "Cache-Control": "no-store",
        });
        return response.end();
      } catch {
        returnUrl.searchParams.set("authError", "google");
        response.writeHead(302, { Location: returnUrl.toString(), "Set-Cookie": clearStateCookie, "Cache-Control": "no-store" });
        return response.end();
      }
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      const user = await getAuthenticatedUser(request);
      return sendJson(response, 200, { authenticated: Boolean(user), user: user ? { id: user.id, email: user.email, name: user.name } : null });
    }

    if (request.method === "POST" && url.pathname === "/api/signup") {
      if (!checkLoginRateLimit(request)) {
        return sendJson(response, 429, { error: "Too many sign-up attempts. Please try again shortly." });
      }

      const body = await readJson(request, 4096);
      const result = await createAccount({
        config,
        email: body.email,
        password: body.password,
        name: body.name,
        sessionStore,
        secret: sessionSecret,
        appBaseUrl: config.appBaseUrl,
      });

      if (!result.ok) {
        return sendJson(response, result.status || 400, { error: result.error || "Unable to create account." });
      }

      return sendJson(response, 201, { ok: true, user: result.user }, {
        "Set-Cookie": buildSessionCookie(result.token, new Date(result.expiresAt).getTime()),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/session") {
      const user = await getAuthenticatedUser(request);
      if (!user) {
        return sendJson(response, 401, { authenticated: false, error: "Sign in required" });
      }
      return sendJson(response, 200, { authenticated: true, user });
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      if (!checkLoginRateLimit(request)) {
        return sendJson(response, 429, { error: "Too many login attempts. Please try again shortly." });
      }

      const body = await readJson(request, 4096);
      if (body.email) {
        const result = await loginWithPassword({
          config,
          email: body.email,
          password: body.password,
          sessionStore,
          secret: sessionSecret,
        });

        if (!result.ok) {
          return sendJson(response, result.status || 401, { error: result.error || "Unable to sign in." });
        }

        return sendJson(response, 200, { ok: true, user: result.user }, {
          "Set-Cookie": buildSessionCookie(result.token, new Date(result.expiresAt).getTime()),
        });
      }

      const passwordCandidate = String(body.password || "");
      if (!passwordMatches(passwordCandidate, password)) {
        return sendJson(response, 401, { error: "Incorrect username or password" });
      }

      const token = createSessionToken(sessionSecret);
      return sendJson(response, 200, { ok: true }, {
        "Set-Cookie": buildSessionCookie(token),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
      const token = getSessionToken(request);
      const payload = decodeSessionToken(token);
      if (payload?.sid) sessionStore.delete(payload.sid);
      return sendJson(response, 200, { ok: true }, {
        "Set-Cookie": `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
      });
    }

    if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/watch/") && !["/api/login", "/api/signup", "/api/verify-email", "/api/reset-password", "/api/request-reset", "/api/session", "/api/auth/google", "/api/auth/google/callback"].includes(url.pathname) && !isAuthenticated(request)) {
      return sendJson(response, 401, { error: "Sign in required" });
    }

    if (request.method === "POST" && url.pathname === "/api/verify-email") {
      const body = await readJson(request, 2048);
      const result = await verifyEmailToken({ config, token: body.token });
      return sendJson(response, result.ok ? 200 : result.status || 400, result);
    }

    if (request.method === "POST" && url.pathname === "/api/request-reset") {
      const body = await readJson(request, 2048);
      const result = await requestPasswordReset({ config, email: body.email, appBaseUrl: config.appBaseUrl });
      return sendJson(response, 200, result);
    }

    if (request.method === "POST" && url.pathname === "/api/reset-password") {
      const body = await readJson(request, 4096);
      const result = await resetPassword({ config, token: body.token, password: body.password });
      if (result.ok) {
        for (const [sessionId, session] of sessionStore) {
          if (session.userId === result.userId) sessionStore.delete(sessionId);
        }
        delete result.userId;
      }
      return sendJson(response, result.ok ? 200 : result.status || 400, result);
    }

    if (request.method === "GET" && url.pathname === "/api/videos") {
      const user = await getAuthenticatedUser(request);
      if (!user) return sendJson(response, 401, { error: "Sign in required" });
      return sendJson(response, 200, { videos: await listUserVideos({ config, userId: user.id }) });
    }

    if (request.method === "POST" && url.pathname === "/api/videos/upload") {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const user = await getAuthenticatedUser(request);
      if (!user) return sendJson(response, 401, { error: "Sign in required" });
      const body = await readJson(request, 4096);
      const result = await initiateVideoUpload({
        config,
        user,
        filename: body.filename,
        size: body.size,
        contentType: body.contentType,
      });
      return sendJson(response, result.ok ? 201 : result.status || 400, result);
    }

    const videoUploadStatus = url.pathname.match(/^\/api\/videos\/([a-f\d]{24})\/upload-parts\/status$/i);
    if (request.method === "GET" && videoUploadStatus) {
      const user = await getAuthenticatedUser(request);
      if (!user) return sendJson(response, 401, { error: "Sign in required" });
      const result = await getVideoUploadStatus({ config, userId: user.id, videoId: videoUploadStatus[1] });
      return sendJson(response, result.ok ? 200 : result.status || 400, result);
    }

    const videoUploadParts = url.pathname.match(/^\/api\/videos\/([a-f\d]{24})\/upload-parts\/urls$/i);
    if (request.method === "POST" && videoUploadParts) {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const user = await getAuthenticatedUser(request);
      if (!user) return sendJson(response, 401, { error: "Sign in required" });
      const body = await readJson(request, 4096);
      const result = await getVideoUploadPartUrls({
        config,
        userId: user.id,
        videoId: videoUploadParts[1],
        partNumbers: body.partNumbers,
      });
      return sendJson(response, result.ok ? 200 : result.status || 400, result);
    }

    const videoRecord = url.pathname.match(/^\/api\/videos\/([a-f\d]{24})$/i);
    if (request.method === "GET" && videoRecord) {
      const user = await getAuthenticatedUser(request);
      if (!user) return sendJson(response, 401, { error: "Sign in required" });
      const video = await getUserVideo({ config, userId: user.id, videoId: videoRecord[1] });
      return video ? sendJson(response, 200, { video }) : sendJson(response, 404, { error: "Video not found." });
    }

    const videoComplete = url.pathname.match(/^\/api\/videos\/([a-f\d]{24})\/complete$/i);
    if (request.method === "PUT" && videoComplete) {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const user = await getAuthenticatedUser(request);
      if (!user) return sendJson(response, 401, { error: "Sign in required" });
      const body = await readJson(request, 1_500_000);
      const result = await completeVideoUpload({ config, userId: user.id, videoId: videoComplete[1], parts: body.parts });
      return sendJson(response, result.ok ? 202 : result.status || 400, result);
    }

    const videoRetry = url.pathname.match(/^\/api\/videos\/([a-f\d]{24})\/retry$/i);
    if (request.method === "POST" && videoRetry) {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const user = await getAuthenticatedUser(request);
      if (!user) return sendJson(response, 401, { error: "Sign in required" });
      const result = await retryVideoProcessing({ config, userId: user.id, videoId: videoRetry[1] });
      return sendJson(response, result.ok ? 202 : result.status || 400, result);
    }

    const videoSettings = url.pathname.match(/^\/api\/videos\/([a-f\d]{24})$/i);
    if (request.method === "PATCH" && videoSettings) {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const user = await getAuthenticatedUser(request);
      if (!user) return sendJson(response, 401, { error: "Sign in required" });
      const body = await readJson(request, 4096);
      const result = await updateVideoSettings({
        config,
        userId: user.id,
        videoId: videoSettings[1],
        title: body.title,
        shareMode: body.shareMode,
        expiresAt: body.expiresAt,
      });
      return sendJson(response, result.ok ? 200 : result.status || 400, result);
    }

    if (request.method === "DELETE" && videoSettings) {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const user = await getAuthenticatedUser(request);
      if (!user) return sendJson(response, 401, { error: "Sign in required" });
      const result = await deleteUserVideo({ config, userId: user.id, videoId: videoSettings[1] });
      return sendJson(response, result.ok ? 200 : result.status || 400, result);
    }

    const videoAsset = url.pathname.match(/^\/api\/videos\/([a-f\d]{24})\/(mp4|thumbnail|hls\/master\.m3u8|hls\/(\d{3,4})\/(index\.m3u8|segment_\d{3,}\.ts))$/i);
    if (request.method === "GET" && videoAsset) {
      const user = await getAuthenticatedUser(request);
      if (!user) return sendJson(response, 401, { error: "Sign in required" });
      const [, videoId, assetPath, profile, filename] = videoAsset;
      const route = assetPath === "mp4"
        ? { assetType: "mp4" }
        : assetPath === "thumbnail"
          ? { assetType: "thumbnail" }
          : assetPath.endsWith("master.m3u8")
            ? { assetType: "master" }
            : { assetType: "variant" };
      return serveVideoAsset({ config, response, range: request.headers.range, route, videoId, userId: user.id, profile, filename });
    }

    const publicWatch = url.pathname.match(/^\/api\/watch\/([A-Za-z0-9_-]{40,60})$/);
    if (request.method === "GET" && publicWatch) {
      const video = await resolvePublicVideo({ config, shareId: publicWatch[1] });
      return video
        ? sendJson(response, 200, video, { "Cache-Control": "no-store" })
        : sendJson(response, 404, { error: "This video link is unavailable, private, expired, or revoked." });
    }

    const publicVideoAsset = url.pathname.match(/^\/api\/watch\/([A-Za-z0-9_-]{40,60})\/(mp4|thumbnail|hls\/master\.m3u8|hls\/(\d{3,4})\/(index\.m3u8|segment_\d{3,}\.ts))$/);
    if (request.method === "GET" && publicVideoAsset) {
      const [, shareId, assetPath, profile, filename] = publicVideoAsset;
      const route = assetPath === "mp4"
        ? { assetType: "mp4" }
        : assetPath === "thumbnail"
          ? { assetType: "thumbnail" }
          : assetPath.endsWith("master.m3u8")
            ? { assetType: "master" }
            : { assetType: "variant" };
      return serveVideoAsset({ config, response, range: request.headers.range, route, shareId, profile, filename });
    }

    if (request.method === "GET" && url.pathname === "/api/clips") {
      const user = await getAuthenticatedUser(request);
      const ownerId = user?.id || "legacy-dashboard";
      const requestedLimit = Number(url.searchParams.get("limit") || 24);
      const limit = Math.max(1, Math.min(Number.isInteger(requestedLimit) ? requestedLimit : 24, 48));
      const result = await listClips({ config, ownerId, cursor: url.searchParams.get("cursor"), limit });
      return sendJson(response, 200, result);
    }

    const clipSocial = url.pathname.match(/^\/api\/clips\/([a-f\d]{24})\/social$/i);
    if (request.method === "PUT" && clipSocial) {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const body = await readJson(request, 8192);
      const user = await getAuthenticatedUser(request);
      const updated = await updateClipSocial({ clipId: clipSocial[1], ownerId: user?.id || "legacy-dashboard", update: body, config });
      return sendJson(response, updated ? 200 : 404, { updated });
    }

    if (request.method === "GET" && url.pathname === "/api/settings/instagram") {
      const user = await getAuthenticatedUser(request);
      const settings = await getInstagramAccountSettings(config, user?.id || "legacy-dashboard");
      return sendJson(response, 200, settings);
    }

    if (request.method === "PUT" && url.pathname === "/api/settings/instagram") {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const body = await readJson(request);
      const user = await getAuthenticatedUser(request);
      const settings = await saveInstagramAccountId({ userId: body.userId, ownerId: user?.id || "legacy-dashboard", config });
      return sendJson(response, 200, settings);
    }

    if (request.method === "POST" && url.pathname === "/api/jobs") {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const body = await readJson(request);
      const videoUrl = validateYouTubeUrl(String(body.url || "").trim());
      const maxClips = Number(body.maxClips ?? 6);
      if (!Number.isInteger(maxClips) || maxClips < 1 || maxClips > 12) {
        return sendJson(response, 400, { error: "Choose between 1 and 12 clips" });
      }
      const user = await getAuthenticatedUser(request);
      return sendJson(response, 202, createJob({ url: videoUrl, maxClips, ownerId: user?.id || "legacy-dashboard" }));
    }

    const jobStatus = url.pathname.match(/^\/api\/jobs\/([a-f\d-]{36})$/i);
    if (request.method === "GET" && jobStatus) {
      const user = await getAuthenticatedUser(request);
      const job = getJob(jobStatus[1], user?.id || "legacy-dashboard");
      return job ? sendJson(response, 200, job) : sendJson(response, 404, { error: "Job not found" });
    }

    const playback = url.pathname.match(/^\/api\/clips\/([a-f\d]{24})\/playback$/i);
    if (request.method === "GET" && playback) {
      const user = await getAuthenticatedUser(request);
      const result = await getClipPlaybackUrl({ clipId: playback[1], ownerId: user?.id || "legacy-dashboard", config });
      return sendJson(response, 200, result);
    }

    const instagramCreate = url.pathname.match(/^\/api\/clips\/([a-f\d]{24})\/instagram$/i);
    if (request.method === "POST" && instagramCreate) {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const body = await readJson(request, 8192);
      const user = await getAuthenticatedUser(request);
      const result = await createInstagramReel({ clipId: instagramCreate[1], ownerId: user?.id || "legacy-dashboard", caption: String(body.caption || ""), config });
      return sendJson(response, 202, result);
    }

    const instagramStatus = url.pathname.match(/^\/api\/clips\/([a-f\d]{24})\/instagram\/status$/i);
    if (request.method === "GET" && instagramStatus) {
      const user = await getAuthenticatedUser(request);
      const result = await getInstagramReelStatus({ clipId: instagramStatus[1], ownerId: user?.id || "legacy-dashboard", config });
      return sendJson(response, 200, result);
    }

    const instagramPublish = url.pathname.match(/^\/api\/clips\/([a-f\d]{24})\/instagram\/publish$/i);
    if (request.method === "POST" && instagramPublish) {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const user = await getAuthenticatedUser(request);
      const result = await publishInstagramReel({ clipId: instagramPublish[1], ownerId: user?.id || "legacy-dashboard", config });
      return sendJson(response, 200, result);
    }

    const deletion = url.pathname.match(/^\/api\/clips\/([a-f\d]{24})$/i);
    if (request.method === "DELETE" && deletion) {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const user = await getAuthenticatedUser(request);
      const deleted = await deleteClip({ clipId: deletion[1], ownerId: user?.id || "legacy-dashboard", config });
      return sendJson(response, deleted ? 200 : 404, { deleted });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/") || /^\/watch\/[A-Za-z0-9_-]{40,60}$/.test(url.pathname))) {
      const relative = url.pathname === "/" || url.pathname.startsWith("/watch/") ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const filePath = path.resolve(publicDir, relative);
      if (!filePath.startsWith(`${publicDir}${path.sep}`) && filePath !== path.join(publicDir, "index.html")) {
        return sendJson(response, 400, { error: "Invalid path" });
      }
      try {
        const content = await fs.readFile(filePath);
        const contentType = filePath.endsWith(".js") ? "text/javascript; charset=utf-8" : filePath.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
        response.writeHead(200, { "Content-Type": contentType, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; media-src https:; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self' https:" });
        return response.end(content);
      } catch {
        return sendJson(response, 404, { error: "Not found" });
      }
    }

    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return sendJson(response, error.message === "Request body too large" ? 413 : 500, { error: "Request failed" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Clip dashboard API running at http://127.0.0.1:${port}`);
  void initializeVideoCollections(config)
    .then(() => startVideoWorker(config))
    .catch((error) => console.error("Video worker initialization failed:", error.message));
});
