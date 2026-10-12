import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRuntimeConfig } from "./src/config.js";
import { createSessionToken, passwordMatches, verifySessionToken } from "./src/dashboard-auth.js";
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

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(projectDir, "..", "frontend", "dist");
const config = readRuntimeConfig();
const password = process.env.DASHBOARD_PASSWORD;
const sessionSecret = process.env.DASHBOARD_SESSION_SECRET;
const port = Number(process.env.API_PORT || 3001);

if (!password || password.length < 12) throw new Error("Set DASHBOARD_PASSWORD in .env (at least 12 characters)");
if (!sessionSecret || sessionSecret.length < 32) throw new Error("Set DASHBOARD_SESSION_SECRET in .env (at least 32 characters)");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");

const cookies = (header = "") => Object.fromEntries(header.split(";").map((part) => {
  const index = part.indexOf("=");
  return index < 0 ? ["", ""] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
}));

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
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

function isAuthenticated(request) {
  const token = cookies(request.headers.cookie).clipper_session;
  return verifySessionToken(token, sessionSecret);
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function allowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === request.headers.host || ["localhost:5173", "127.0.0.1:5173"].includes(parsed.host);
  } catch {
    return false;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, { authenticated: isAuthenticated(request) });
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      const body = await readJson(request);
      if (!passwordMatches(String(body.password || ""), password)) {
        return sendJson(response, 401, { error: "Incorrect password" });
      }
      const token = createSessionToken(sessionSecret);
      return sendJson(response, 200, { ok: true }, {
        "Set-Cookie": `clipper_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      return sendJson(response, 200, { ok: true }, {
        "Set-Cookie": `clipper_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
      });
    }

    if (url.pathname.startsWith("/api/") && !isAuthenticated(request)) {
      return sendJson(response, 401, { error: "Sign in required" });
    }

    if (request.method === "GET" && url.pathname === "/api/clips") {
      const requestedLimit = Number(url.searchParams.get("limit") || 24);
      const limit = Math.max(1, Math.min(Number.isInteger(requestedLimit) ? requestedLimit : 24, 48));
      const result = await listClips({ config, cursor: url.searchParams.get("cursor"), limit });
      return sendJson(response, 200, result);
    }

    const clipSocial = url.pathname.match(/^\/api\/clips\/([a-f\d]{24})\/social$/i);
    if (request.method === "PUT" && clipSocial) {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const body = await readJson(request, 8192);
      const updated = await updateClipSocial({ clipId: clipSocial[1], update: body, config });
      return sendJson(response, updated ? 200 : 404, { updated });
    }

    if (request.method === "GET" && url.pathname === "/api/settings/instagram") {
      const settings = await getInstagramAccountSettings(config);
      return sendJson(response, 200, settings);
    }

    if (request.method === "PUT" && url.pathname === "/api/settings/instagram") {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const body = await readJson(request);
      const settings = await saveInstagramAccountId({ userId: body.userId, config });
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
      return sendJson(response, 202, createJob({ url: videoUrl, maxClips }));
    }

    const jobStatus = url.pathname.match(/^\/api\/jobs\/([a-f\d-]{36})$/i);
    if (request.method === "GET" && jobStatus) {
      const job = getJob(jobStatus[1]);
      return job ? sendJson(response, 200, job) : sendJson(response, 404, { error: "Job not found" });
    }

    const playback = url.pathname.match(/^\/api\/clips\/([a-f\d]{24})\/playback$/i);
    if (request.method === "GET" && playback) {
      const result = await getClipPlaybackUrl({ clipId: playback[1], config });
      return sendJson(response, 200, result);
    }

    const instagramCreate = url.pathname.match(/^\/api\/clips\/([a-f\d]{24})\/instagram$/i);
    if (request.method === "POST" && instagramCreate) {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const body = await readJson(request, 8192);
      const result = await createInstagramReel({ clipId: instagramCreate[1], caption: String(body.caption || ""), config });
      return sendJson(response, 202, result);
    }

    const instagramStatus = url.pathname.match(/^\/api\/clips\/([a-f\d]{24})\/instagram\/status$/i);
    if (request.method === "GET" && instagramStatus) {
      const result = await getInstagramReelStatus({ clipId: instagramStatus[1], config });
      return sendJson(response, 200, result);
    }

    const instagramPublish = url.pathname.match(/^\/api\/clips\/([a-f\d]{24})\/instagram\/publish$/i);
    if (request.method === "POST" && instagramPublish) {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const result = await publishInstagramReel({ clipId: instagramPublish[1], config });
      return sendJson(response, 200, result);
    }

    const deletion = url.pathname.match(/^\/api\/clips\/([a-f\d]{24})$/i);
    if (request.method === "DELETE" && deletion) {
      if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Invalid origin" });
      const deleted = await deleteClip({ clipId: deletion[1], config });
      return sendJson(response, deleted ? 200 : 404, { deleted });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
      const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
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

server.listen(port, "127.0.0.1", () => {
  console.log(`Clip dashboard API running at http://127.0.0.1:${port}`);
});
