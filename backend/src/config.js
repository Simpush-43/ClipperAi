import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import FFMPEG from "ffmpeg-static";

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ytDlpPath = path.join(projectDir, "tools", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
export const ffmpegPath = FFMPEG;
export const chunkSeconds = 600;

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function readRuntimeConfig() {
  const {
    MONGODB_URI,
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    APP_BASE_URL,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    SMTP_HOST,
    SMTP_PORT,
    SMTP_SECURE,
    SMTP_USER,
    SMTP_PASS,
    EMAIL_FROM,
    GOOGLE_REDIRECT_URI,
    VIDEO_MAX_BYTES,
    VIDEO_MAX_DURATION_SECONDS,
    VIDEO_PROCESS_TIMEOUT_MS,
    VIDEO_WORKER_CONCURRENCY,
    VIDEO_MAX_PENDING_PER_USER,
    VIDEO_FFMPEG_THREADS,
    VIDEO_UPLOAD_PART_BYTES,
    FFPROBE_PATH,
  } = process.env;
  if (!MONGODB_URI) {
    throw new Error("Set MONGODB_URI in .env to store clip metadata in MongoDB");
  }
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new Error("Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET in .env");
  }
  const videoUploadPartBytes = Math.max(5 * 1024 * 1024, Math.floor(positiveNumber("VIDEO_UPLOAD_PART_BYTES", 16 * 1024 * 1024)));
  if (videoUploadPartBytes > 5 * 1024 ** 3) {
    throw new Error("VIDEO_UPLOAD_PART_BYTES cannot exceed 5 GiB");
  }
  return {
    mongoUri: MONGODB_URI,
    mongoDb: process.env.MONGODB_DB || "clipper",
    r2AccountId: R2_ACCOUNT_ID,
    r2AccessKeyId: R2_ACCESS_KEY_ID,
    r2SecretAccessKey: R2_SECRET_ACCESS_KEY,
    r2Bucket: R2_BUCKET,
    clipRetentionDays: 21,
    appBaseUrl: APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://127.0.0.1:5173",
    googleClientId: GOOGLE_CLIENT_ID || "",
    googleClientSecret: GOOGLE_CLIENT_SECRET || "",
    googleRedirectUri: GOOGLE_REDIRECT_URI || `${(process.env.NODE_ENV === "production" ? (APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3001") : "http://127.0.0.1:3001").replace(/\/$/, "")}/api/auth/google/callback`,
    videoMaxBytes: positiveNumber("VIDEO_MAX_BYTES", 2 * 1024 * 1024 * 1024),
    videoMaxDurationSeconds: positiveNumber("VIDEO_MAX_DURATION_SECONDS", 2 * 60 * 60),
    videoProcessTimeoutMs: positiveNumber("VIDEO_PROCESS_TIMEOUT_MS", 60 * 60 * 1000),
    videoWorkerConcurrency: Math.max(1, Math.floor(positiveNumber("VIDEO_WORKER_CONCURRENCY", 1))),
    videoMaxPendingPerUser: Math.max(1, Math.floor(positiveNumber("VIDEO_MAX_PENDING_PER_USER", 3))),
    videoFfmpegThreads: Math.max(1, Math.floor(positiveNumber("VIDEO_FFMPEG_THREADS", 2))),
    videoUploadPartBytes,
    ffprobePath: FFPROBE_PATH || "",
    smtpHost: SMTP_HOST || "",
    smtpPort: SMTP_PORT || "587",
    smtpSecure: SMTP_SECURE === "true" || SMTP_SECURE === "1",
    smtpUser: SMTP_USER || "",
    smtpPass: SMTP_PASS || "",
    emailFrom: EMAIL_FROM || "",
    instagramUserId: process.env.INSTAGRAM_USER_ID || "",
    instagramAccessToken: process.env.INSTAGRAM_ACCESS_TOKEN || "",
    instagramGraphVersion: process.env.INSTAGRAM_GRAPH_VERSION || "v25.0",
  };
}

export function parseArgs(args) {
  const [url, ...options] = args;
  if (!url) {
    throw new Error("Usage: node --env-file=.env clip.js <youtube-url> [--max 8]");
  }

  const maxIndex = options.indexOf("--max");
  const maxClips = maxIndex >= 0 ? Number(options[maxIndex + 1]) || 8 : 8;
  if (!Number.isInteger(maxClips) || maxClips < 1) {
    throw new Error("--max must be a positive integer");
  }

  const { GROQ_API_KEY, GEMINI_API_KEY } = process.env;
  if (!GROQ_API_KEY || !GEMINI_API_KEY) {
    throw new Error("Set GROQ_API_KEY and GEMINI_API_KEY in .env");
  }
  const storageConfig = readRuntimeConfig();
  if (!fs.existsSync(ytDlpPath)) {
    throw new Error(`Project-local yt-dlp not found at ${ytDlpPath}`);
  }
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error("Project-local FFmpeg is missing. Run npm install to install project dependencies.");
  }

  return {
    url,
    maxClips,
    groqApiKey: GROQ_API_KEY,
    geminiApiKey: GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    ...storageConfig,
  };
}
