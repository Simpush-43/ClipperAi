import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import ffprobe from "ffprobe-static";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MongoClient, ObjectId } from "mongodb";
import { ffmpegPath } from "./config.js";

const VIDEO_TYPES = new Map([
  [".mp4", new Set(["video/mp4"])],
  [".mov", new Set(["video/quicktime"])],
  [".webm", new Set(["video/webm"])],
  [".mkv", new Set(["video/x-matroska", "application/octet-stream"])],
  [".mpeg", new Set(["video/mpeg"])],
  [".mpg", new Set(["video/mpeg"])],
]);
const SHARE_ID_BYTES = 32;
const PROFILE_HEIGHTS = [1080, 720, 480];
let warnedAboutFfprobePath = false;

function createMongo(config) {
  return new MongoClient(config.mongoUri);
}

export function validateVideoUploadInput({ filename, size, contentType, maxBytes }) {
  const originalName = cleanName(filename);
  const extension = path.extname(originalName).toLowerCase();
  const allowedTypes = VIDEO_TYPES.get(extension);
  const normalizedType = allowedTypes?.has(contentType)
    ? contentType
    : contentType === "application/octet-stream" && allowedTypes
      ? [...allowedTypes][0]
      : null;
  if (!originalName || !normalizedType) {
    return { ok: false, error: "Choose a supported video file." };
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
    return { ok: false, error: `Video must be smaller than ${Math.floor(maxBytes / (1024 * 1024))} MB.` };
  }
  return { ok: true, originalName, contentType: normalizedType };
}

function createR2(config) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
  });
}

function videosCollection(database) {
  return database.collection("videos");
}

export function videoOwnerFilter(ownerId, filter = {}) {
  if (typeof ownerId !== "string" || !ownerId) throw new TypeError("An authenticated owner ID is required");
  return { ...filter, ownerId };
}

export function normalizeMultipartParts(parts, totalParts) {
  if (!Number.isInteger(totalParts) || totalParts < 1 || totalParts > 10_000 ||
      !Array.isArray(parts) || parts.length !== totalParts ||
      parts.some((part) => !part || !Number.isInteger(part.partNumber) ||
        typeof part.etag !== "string" || !/^"[^"]+"$/.test(part.etag))) {
    return null;
  }
  const sorted = [...parts].sort((left, right) => left.partNumber - right.partNumber);
  return sorted.every((part, index) => part.partNumber === index + 1) ? sorted : null;
}

export async function initializeVideoCollections(config) {
  const mongo = createMongo(config);
  try {
    await mongo.connect();
    const database = mongo.db(config.mongoDb);
    await database.collection("users").createIndex({ email: 1 }, { unique: true, name: "users_email_unique" });
    await database.collection("users").createIndex(
      { googleSub: 1 },
      { unique: true, partialFilterExpression: { googleSub: { $type: "string" } }, name: "users_google_sub_unique" },
    );
    await videosCollection(database).createIndex({ ownerId: 1, createdAt: -1 });
    await videosCollection(database).createIndex(
      { shareId: 1 },
      { unique: true, partialFilterExpression: { shareId: { $type: "string" } } },
    );
    await database.collection("video_jobs").createIndex({ videoId: 1 }, { unique: true });
    await database.collection("video_jobs").createIndex({ status: 1, createdAt: 1 });
  } finally {
    await mongo.close();
  }
}

function cleanName(value) {
  const name = path.basename(String(value || "")).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim();
  return name.slice(0, 255);
}

function safeVideo(video) {
  if (!video) return null;
  return {
    id: video._id.toString(),
    title: video.title,
    originalName: video.originalName,
    size: video.size,
    contentType: video.contentType,
    status: video.status,
    error: video.error || null,
    metadata: video.metadata || null,
    formats: video.formats || [],
    thumbnailUrl: video.assets?.thumbnailKey ? `/api/videos/${video._id}/thumbnail` : null,
    mp4Url: video.assets?.mp4?.key ? `/api/videos/${video._id}/mp4` : null,
    hlsUrl: video.assets?.hls?.masterKey ? `/api/videos/${video._id}/hls/master.m3u8` : null,
    shareMode: video.shareMode,
    shareId: video.shareId || null,
    shareExpiresAt: video.shareExpiresAt || null,
    createdAt: video.createdAt,
    updatedAt: video.updatedAt,
  };
}

function validObjectId(value) {
  return typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
}

async function listAllUploadParts(r2, config, video) {
  const parts = [];
  let marker;
  do {
    const page = await r2.send(new ListPartsCommand({
      Bucket: config.r2Bucket,
      Key: video.sourceKey,
      UploadId: video.uploadId,
      MaxParts: 1000,
      ...(marker ? { PartNumberMarker: marker } : {}),
    }));
    parts.push(...(page.Parts || []));
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
  } while (marker);
  return parts;
}

async function headUploadedSource(r2, config, video) {
  try {
    return await r2.send(new HeadObjectCommand({ Bucket: config.r2Bucket, Key: video.sourceKey }));
  } catch (error) {
    if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

export async function initiateVideoUpload({ config, user, filename, size, contentType }) {
  const maxBytes = config.videoMaxBytes;
  const validation = validateVideoUploadInput({ filename, size, contentType, maxBytes });
  if (!validation.ok) return { ok: false, status: validation.error.startsWith("Video must") ? 413 : 400, error: validation.error };
  const originalName = validation.originalName;
  contentType = validation.contentType;

  const id = new ObjectId();
  const sourceKey = `video-sources/${randomUUID()}`;
  const now = new Date();
  const mongo = createMongo(config);
  const r2 = createR2(config);
  let uploadId;
  try {
    await mongo.connect();
    const collection = videosCollection(mongo.db(config.mongoDb));
    const pending = await collection.countDocuments({
      ownerId: user.id,
      status: { $in: ["uploading", "queued", "processing"] },
    });
    if (pending >= config.videoMaxPendingPerUser) {
      return { ok: false, status: 429, error: "Too many videos are uploading or processing. Try again when one is finished." };
    }
    const partSize = config.videoUploadPartBytes;
    const totalParts = Math.ceil(size / partSize);
    if (totalParts > 10_000) return { ok: false, status: 413, error: "Video is too large for the configured multipart upload size." };
    const multipart = await r2.send(new CreateMultipartUploadCommand({
      Bucket: config.r2Bucket,
      Key: sourceKey,
      ContentType: contentType,
    }));
    uploadId = multipart.UploadId;
    if (!uploadId) throw new Error("Cloud storage did not create an upload session.");
    const record = {
      _id: id,
      ownerId: user.id,
      title: path.parse(originalName).name.slice(0, 120),
      originalName,
      size,
      contentType,
      sourceKey,
      uploadId,
      partSize,
      assetPrefix: `videos/${randomUUID()}`,
      status: "uploading",
      shareMode: "private",
      shareId: null,
      shareExpiresAt: null,
      assets: {},
      formats: [],
      createdAt: now,
      updatedAt: now,
    };
    await collection.insertOne(record);
    return {
      ok: true,
      video: safeVideo(record),
      partSize,
      totalParts,
    };
  } catch (error) {
    if (uploadId) {
      await r2.send(new AbortMultipartUploadCommand({ Bucket: config.r2Bucket, Key: sourceKey, UploadId: uploadId })).catch(() => {});
    }
    throw error;
  } finally {
    r2.destroy();
    await mongo.close();
  }
}

export async function getVideoUploadStatus({ config, userId, videoId }) {
  if (!validObjectId(videoId)) return { ok: false, status: 400, error: "Invalid video." };
  const mongo = createMongo(config);
  const r2 = createR2(config);
  try {
    await mongo.connect();
    const video = await videosCollection(mongo.db(config.mongoDb)).findOne(
      videoOwnerFilter(userId, { _id: new ObjectId(videoId), status: "uploading" }),
    );
    if (!video?.uploadId) return { ok: false, status: 404, error: "Upload session not found." };
    let result;
    try {
      result = await listAllUploadParts(r2, config, video);
    } catch (error) {
      const stored = await headUploadedSource(r2, config, video);
      if (!stored || stored.ContentLength !== video.size || stored.ContentType !== video.contentType) throw error;
      return {
        ok: true,
        completed: true,
        video: { id: video._id.toString(), originalName: video.originalName, size: video.size, partSize: video.partSize },
        parts: [],
      };
    }
    return {
      ok: true,
      completed: false,
      video: { id: video._id.toString(), originalName: video.originalName, size: video.size, partSize: video.partSize },
      parts: result.map(({ PartNumber, ETag, Size }) => ({ partNumber: PartNumber, etag: ETag, size: Size })),
    };
  } finally {
    r2.destroy();
    await mongo.close();
  }
}

export async function getVideoUploadPartUrls({ config, userId, videoId, partNumbers }) {
  if (!validObjectId(videoId)) return { ok: false, status: 400, error: "Invalid video." };
  if (!Array.isArray(partNumbers) || partNumbers.length < 1 || partNumbers.length > 8 ||
      partNumbers.some((number) => !Number.isInteger(number) || number < 1)) {
    return { ok: false, status: 400, error: "Request between 1 and 8 valid upload parts." };
  }
  const mongo = createMongo(config);
  const r2 = createR2(config);
  try {
    await mongo.connect();
    const video = await videosCollection(mongo.db(config.mongoDb)).findOne(
      videoOwnerFilter(userId, { _id: new ObjectId(videoId), status: "uploading" }),
    );
    if (!video?.uploadId) return { ok: false, status: 404, error: "Upload session not found." };
    const totalParts = Math.ceil(video.size / video.partSize);
    if (partNumbers.some((number) => number > totalParts) || new Set(partNumbers).size !== partNumbers.length) {
      return { ok: false, status: 400, error: "Invalid upload part number." };
    }
    const urls = await Promise.all(partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await getSignedUrl(r2, new UploadPartCommand({
        Bucket: config.r2Bucket,
        Key: video.sourceKey,
        UploadId: video.uploadId,
        PartNumber: partNumber,
      }), { expiresIn: 15 * 60 }),
    })));
    return { ok: true, urls };
  } finally {
    r2.destroy();
    await mongo.close();
  }
}

export async function completeVideoUpload({ config, userId, videoId, parts }) {
  if (!validObjectId(videoId)) return { ok: false, status: 400, error: "Invalid video." };
  const mongo = createMongo(config);
  const r2 = createR2(config);
  try {
    await mongo.connect();
    const collection = videosCollection(mongo.db(config.mongoDb));
    const video = await collection.findOne(videoOwnerFilter(userId, { _id: new ObjectId(videoId) }));
    if (!video) return { ok: false, status: 404, error: "Video not found." };
    if (["queued", "processing", "ready", "partially_ready"].includes(video.status)) {
      return { ok: true, video: safeVideo(video) };
    }
    if (video.status !== "uploading") {
      return { ok: false, status: 409, error: "This upload can no longer be completed." };
    }

    let stored = await headUploadedSource(r2, config, video);
    if (!stored) {
      const totalParts = Math.ceil(video.size / video.partSize);
      const sortedParts = normalizeMultipartParts(parts, totalParts);
      if (!sortedParts) {
        return { ok: false, status: 400, error: "Upload is missing one or more valid file parts." };
      }
      const actualParts = new Map((await listAllUploadParts(r2, config, video)).map((part) => [part.PartNumber, part]));
      const partsMatch = sortedParts.every((part, index) => {
        const actual = actualParts.get(part.partNumber);
        const expectedSize = index === totalParts - 1 ? video.size - index * video.partSize : video.partSize;
        return actual?.ETag === part.etag && actual.Size === expectedSize;
      });
      if (!partsMatch) return { ok: false, status: 400, error: "Uploaded parts do not match the expected file size." };
      await r2.send(new CompleteMultipartUploadCommand({
        Bucket: config.r2Bucket,
        Key: video.sourceKey,
        UploadId: video.uploadId,
        MultipartUpload: { Parts: sortedParts.map(({ partNumber, etag }) => ({ PartNumber: partNumber, ETag: etag })) },
      }));
      stored = await r2.send(new HeadObjectCommand({ Bucket: config.r2Bucket, Key: video.sourceKey }));
    }
    if (stored.ContentLength !== video.size || stored.ContentType !== video.contentType) {
      return { ok: false, status: 400, error: "The uploaded file does not match the selected video." };
    }

    const now = new Date();
    const jobs = mongo.db(config.mongoDb).collection("video_jobs");
    await jobs.updateOne({ videoId: video._id.toString() }, {
      $setOnInsert: {
        videoId: video._id.toString(),
        ownerId: userId,
        status: "queued",
        attempts: 0,
        createdAt: now,
      },
    }, { upsert: true });
    await collection.updateOne(
      videoOwnerFilter(userId, { _id: video._id, status: "uploading" }),
      { $set: { status: "queued", updatedAt: now } },
    );
    return { ok: true, video: safeVideo({ ...video, status: "queued", updatedAt: now }) };
  } finally {
    r2.destroy();
    await mongo.close();
  }
}

export async function listUserVideos({ config, userId }) {
  const mongo = createMongo(config);
  try {
    await mongo.connect();
    const records = await videosCollection(mongo.db(config.mongoDb))
      .find(videoOwnerFilter(userId, { status: { $ne: "deleted" } }))
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    return records.map(safeVideo);
  } finally {
    await mongo.close();
  }
}

export async function getUserVideo({ config, userId, videoId }) {
  if (!validObjectId(videoId)) return null;
  const mongo = createMongo(config);
  try {
    await mongo.connect();
    const record = await videosCollection(mongo.db(config.mongoDb)).findOne(videoOwnerFilter(userId, {
      _id: new ObjectId(videoId),
      status: { $ne: "deleted" },
    }));
    return safeVideo(record);
  } finally {
    await mongo.close();
  }
}

export async function retryVideoProcessing({ config, userId, videoId }) {
  if (!validObjectId(videoId)) return { ok: false, status: 400, error: "Invalid video." };
  const mongo = createMongo(config);
  try {
    await mongo.connect();
    const database = mongo.db(config.mongoDb);
    const collection = videosCollection(database);
    const video = await collection.findOne(videoOwnerFilter(userId, { _id: new ObjectId(videoId) }));
    if (!video) return { ok: false, status: 404, error: "Video not found." };
    if (video.status !== "failed") return { ok: false, status: 409, error: "Only failed videos can be retried." };
    const now = new Date();
    const result = await database.collection("video_jobs").updateOne(
      videoOwnerFilter(userId, { videoId, status: "failed" }),
      { $set: { status: "queued", error: null, updatedAt: now, retryAt: now } },
    );
    if (result.modifiedCount !== 1) return { ok: false, status: 409, error: "This video cannot be retried right now." };
    await collection.updateOne(videoOwnerFilter(userId, { _id: video._id }), { $set: { status: "queued", error: null, updatedAt: now } });
    return { ok: true, video: safeVideo({ ...video, status: "queued", error: null, updatedAt: now }) };
  } finally {
    await mongo.close();
  }
}

export async function updateVideoSettings({ config, userId, videoId, title, shareMode, expiresAt }) {
  if (!validObjectId(videoId)) return { ok: false, status: 400, error: "Invalid video." };
  if (title !== undefined && (typeof title !== "string" || !title.trim() || title.trim().length > 120)) {
    return { ok: false, status: 400, error: "Title must be between 1 and 120 characters." };
  }
  if (shareMode !== undefined && !["private", "unlisted", "public"].includes(shareMode)) {
    return { ok: false, status: 400, error: "Choose a valid sharing mode." };
  }
  let expiration = null;
  if (expiresAt !== undefined && expiresAt !== null && expiresAt !== "") {
    expiration = new Date(expiresAt);
    if (!Number.isFinite(expiration.getTime()) || expiration <= new Date()) {
      return { ok: false, status: 400, error: "Share expiration must be a future date." };
    }
  }

  const mongo = createMongo(config);
  try {
    await mongo.connect();
    const collection = videosCollection(mongo.db(config.mongoDb));
    const video = await collection.findOne(videoOwnerFilter(userId, { _id: new ObjectId(videoId) }));
    if (!video) return { ok: false, status: 404, error: "Video not found." };
    if (shareMode && shareMode !== "private" && !["ready", "partially_ready"].includes(video.status)) {
      return { ok: false, status: 409, error: "Sharing is available after a playable video is ready." };
    }

    const update = { updatedAt: new Date() };
    if (title !== undefined) update.title = title.trim();
    if (shareMode !== undefined) {
      update.shareMode = shareMode;
      update.shareId = shareMode === "private" ? null : (video.shareMode === shareMode && video.shareId ? video.shareId : randomBytes(SHARE_ID_BYTES).toString("base64url"));
      update.shareExpiresAt = shareMode === "private"
        ? null
        : expiresAt === undefined && video.shareMode === shareMode
          ? video.shareExpiresAt || null
          : expiration;
    } else if (expiresAt !== undefined && video.shareMode !== "private") {
      update.shareExpiresAt = expiration;
    }
    await collection.updateOne(videoOwnerFilter(userId, { _id: video._id }), { $set: update });
    return { ok: true, video: safeVideo({ ...video, ...update }) };
  } finally {
    await mongo.close();
  }
}

async function deleteVideoObjects(config, record) {
  const r2 = createR2(config);
  try {
    if (record.uploadId) {
      await r2.send(new AbortMultipartUploadCommand({
        Bucket: config.r2Bucket,
        Key: record.sourceKey,
        UploadId: record.uploadId,
      })).catch((error) => {
        if (error.name !== "NoSuchUpload" && error.$metadata?.httpStatusCode !== 404) throw error;
      });
    }
    let continuationToken;
    do {
      const listed = await r2.send(new ListObjectsV2Command({
        Bucket: config.r2Bucket,
        Prefix: `${record.assetPrefix}/`,
        ContinuationToken: continuationToken,
      }));
      for (const item of listed.Contents || []) {
        if (item.Key) await r2.send(new DeleteObjectCommand({ Bucket: config.r2Bucket, Key: item.Key }));
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
    if (record.sourceKey) {
      await r2.send(new DeleteObjectCommand({ Bucket: config.r2Bucket, Key: record.sourceKey }));
    }
  } finally {
    r2.destroy();
  }
}

export async function deleteUserVideo({ config, userId, videoId }) {
  if (!validObjectId(videoId)) return { ok: false, status: 400, error: "Invalid video." };
  const mongo = createMongo(config);
  try {
    await mongo.connect();
    const database = mongo.db(config.mongoDb);
    const collection = videosCollection(database);
    const record = await collection.findOne(videoOwnerFilter(userId, { _id: new ObjectId(videoId) }));
    if (!record) return { ok: false, status: 404, error: "Video not found." };
    await collection.updateOne(videoOwnerFilter(userId, { _id: record._id }), {
      $set: { status: "deleted", shareMode: "private", shareId: null, updatedAt: new Date() },
    });
    await database.collection("video_jobs").updateOne({ videoId, ownerId: userId }, {
      $set: { status: "deleted", updatedAt: new Date() },
    });
    await deleteVideoObjects(config, record);
    await collection.deleteOne(videoOwnerFilter(userId, { _id: record._id, status: "deleted" }));
    return { ok: true };
  } finally {
    await mongo.close();
  }
}

async function getVideoForShare(config, shareId) {
  if (typeof shareId !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(shareId)) return null;
  const mongo = createMongo(config);
  try {
    await mongo.connect();
    const video = await videosCollection(mongo.db(config.mongoDb)).findOne({
      shareId,
      shareMode: { $in: ["unlisted", "public"] },
      status: { $in: ["ready", "partially_ready"] },
      $or: [{ shareExpiresAt: null }, { shareExpiresAt: { $exists: false } }, { shareExpiresAt: { $gt: new Date() } }],
    });
    return video;
  } finally {
    await mongo.close();
  }
}

export async function resolvePublicVideo({ config, shareId }) {
  const video = await getVideoForShare(config, shareId);
  if (!video) return null;
  return {
    title: video.title,
    metadata: video.metadata,
    thumbnailUrl: video.assets?.thumbnailKey ? `/api/watch/${shareId}/thumbnail` : null,
    mp4Url: video.assets?.mp4?.key ? `/api/watch/${shareId}/mp4` : null,
    hlsUrl: video.assets?.hls?.masterKey ? `/api/watch/${shareId}/hls/master.m3u8` : null,
  };
}

async function findOwnedVideo(config, userId, videoId) {
  if (!validObjectId(videoId)) return null;
  const mongo = createMongo(config);
  try {
    await mongo.connect();
    return await videosCollection(mongo.db(config.mongoDb)).findOne(videoOwnerFilter(userId, {
      _id: new ObjectId(videoId),
      status: { $ne: "deleted" },
    }));
  } finally {
    await mongo.close();
  }
}

async function resolveVideoAsset(config, { shareId, videoId, userId, assetType, profile, filename }) {
  const video = shareId
    ? await getVideoForShare(config, shareId)
    : await findOwnedVideo(config, userId, videoId);
  if (!video) return null;
  if (assetType === "mp4") return video.assets?.mp4?.key ? { video, key: video.assets.mp4.key, contentType: "video/mp4" } : null;
  if (assetType === "thumbnail") return video.assets?.thumbnailKey ? { video, key: video.assets.thumbnailKey, contentType: "image/jpeg" } : null;
  if (assetType === "master") {
    return video.assets?.hls?.masterKey
      ? { video, key: video.assets.hls.masterKey, contentType: "application/vnd.apple.mpegurl", rewrite: "master" }
      : null;
  }
  if (!/^\d{3,4}$/.test(profile || "") || !/^(index\.m3u8|segment_\d{3,}\.ts)$/.test(filename || "")) return null;
  const variant = video.assets?.hls?.variants?.find((item) => String(item.height) === profile);
  if (!variant) return null;
  const isPlaylist = filename === "index.m3u8";
  return {
    video,
    key: `${variant.prefix}/${filename}`,
    contentType: isPlaylist ? "application/vnd.apple.mpegurl" : "video/mp2t",
    rewrite: isPlaylist ? `variant:${profile}` : null,
  };
}

export async function serveVideoAsset({ config, response, range, route, shareId, videoId, userId, profile, filename }) {
  const asset = await resolveVideoAsset(config, { shareId, videoId, userId, ...route, profile, filename });
  if (!asset) {
    response.writeHead(404, { "Cache-Control": "no-store" });
    response.end("Video unavailable");
    return;
  }

  const r2 = createR2(config);
  try {
    const result = await r2.send(new GetObjectCommand({
      Bucket: config.r2Bucket,
      Key: asset.key,
      ...(range ? { Range: range } : {}),
    }));
    const headers = {
      "Content-Type": asset.contentType,
      "Accept-Ranges": asset.contentType.startsWith("video/") ? "bytes" : "none",
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      ...(result.ContentLength ? { "Content-Length": result.ContentLength } : {}),
    };
    if (result.ContentRange) headers["Content-Range"] = result.ContentRange;
    if (asset.rewrite) {
      const text = await result.Body.transformToString();
      const rewritten = asset.rewrite === "master"
        ? text.replace(/^(\d{3,4}\/index\.m3u8)$/gm, `/api/${shareId ? `watch/${shareId}` : `videos/${videoId}`}/hls/$1`)
        : text.replace(/^(segment_\d{3,}\.ts)$/gm, `/api/${shareId ? `watch/${shareId}` : `videos/${videoId}`}/hls/${asset.rewrite.slice(8)}/$1`);
      response.writeHead(200, { ...headers, "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": Buffer.byteLength(rewritten) });
      response.end(rewritten);
      return;
    }
    response.writeHead(range ? 206 : 200, headers);
    await pipeline(result.Body, response);
  } catch (error) {
    console.error("Unable to serve video asset:", error.name);
    if (!response.headersSent) {
      response.writeHead(502, { "Cache-Control": "no-store" });
      response.end("Video asset could not be loaded");
    } else {
      response.destroy(error);
    }
  } finally {
    r2.destroy();
  }
}

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(code === null ? "Media processing exceeded its time limit." : `Media processing failed: ${stderr.slice(-1800)}`));
    });
  });
}

function resolveFfprobePath(config) {
  const configuredPath = config.ffprobePath?.trim();
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
  if (configuredPath && !warnedAboutFfprobePath) {
    console.warn("FFPROBE_PATH does not point to an existing file; using the bundled ffprobe-static binary.");
    warnedAboutFfprobePath = true;
  }
  if (ffprobe.path && fs.existsSync(ffprobe.path)) return ffprobe.path;
  throw new Error("FFprobe is unavailable. Remove the invalid FFPROBE_PATH setting or install a supported ffprobe binary.");
}

export async function inspectMedia(filePath, config) {
  const { stdout } = await run(resolveFfprobePath(config), [
    "-v", "error",
    "-show_streams", "-show_format",
    "-of", "json", filePath,
  ], 30_000);
  const data = JSON.parse(stdout);
  const stream = data.streams?.find((item) => item.codec_type === "video");
  const duration = Number(data.format?.duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0) throw new Error("The uploaded file is not a valid video.");
  if (duration > config.videoMaxDurationSeconds) throw new Error(`Video duration exceeds ${Math.floor(config.videoMaxDurationSeconds / 60)} minutes.`);
  let width = Number(stream.width);
  let height = Number(stream.height);
  const rotation = Number(stream.tags?.rotate || stream.side_data_list?.find((item) => item.rotation)?.rotation || 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  return {
    duration,
    width,
    height,
    videoCodec: stream.codec_name || "unknown",
    videoProfile: stream.profile || null,
    videoLevel: Number.isFinite(Number(stream.level)) ? Number(stream.level) : null,
    audioCodec: data.streams.find((item) => item.codec_type === "audio")?.codec_name || null,
    frameRate: stream.avg_frame_rate || null,
  };
}

function hlsCodecString(metadata) {
  const profile = {
    baseline: "4200",
    "constrained baseline": "42e0",
    main: "4d00",
    high: "6400",
  }[String(metadata.videoProfile || "").toLowerCase()] || "6400";
  const level = Number.isInteger(metadata.videoLevel) && metadata.videoLevel > 0
    ? metadata.videoLevel.toString(16).padStart(2, "0")
    : "28";
  return `avc1.${profile}${level}${metadata.audioCodec === "aac" ? ",mp4a.40.2" : ""}`;
}

export function outputDimensions(width, height, targetHeight) {
  const isLandscape = width > height;
  const targetWidth = isLandscape ? Math.round(targetHeight * 16 / 9) : targetHeight;
  const targetMaxHeight = isLandscape ? targetHeight : Math.round(targetHeight * 16 / 9);
  const factor = Math.min(targetWidth / width, targetMaxHeight / height, 1);
  return {
    width: Math.max(2, Math.floor(width * factor / 2) * 2),
    height: Math.max(2, Math.floor(height * factor / 2) * 2),
  };
}

export async function transcode(config, inputPath, workDir, metadata, record) {
  const maximumEdge = Math.max(metadata.width, metadata.height);
  const profiles = PROFILE_HEIGHTS.filter((height) => maximumEdge >= Math.round(height * 16 / 9) * 0.9 || height === 480);
  const supportedProfiles = profiles.filter((height) => {
    const dimensions = outputDimensions(metadata.width, metadata.height, height);
    return dimensions.width <= metadata.width && dimensions.height <= metadata.height;
  });
  if (!supportedProfiles.length) supportedProfiles.push(480);

  const mp4Path = path.join(workDir, "video.mp4");
  const mp4Dimensions = outputDimensions(metadata.width, metadata.height, Math.min(1080, maximumEdge));
  await run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", `scale=${mp4Dimensions.width}:${mp4Dimensions.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    "-c:v", "libx264", "-threads", String(config.videoFfmpegThreads), "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", mp4Path,
  ], config.videoProcessTimeoutMs);

  const hlsVariants = [];
  const failedProfiles = [];
  for (const height of supportedProfiles) {
    const variantDir = path.join(workDir, String(height));
    await fsp.mkdir(variantDir, { recursive: true });
    const dimensions = outputDimensions(metadata.width, metadata.height, height);
    const playlistPath = path.join(variantDir, "index.m3u8");
    const bandwidth = height >= 1080 ? 5_000_000 : height >= 720 ? 2_800_000 : 1_400_000;
    try {
      await run(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        "-c:v", "libx264", "-threads", String(config.videoFfmpegThreads), "-preset", "veryfast", "-crf", "23",
        "-maxrate", String(bandwidth), "-bufsize", String(bandwidth * 2), "-pix_fmt", "yuv420p",
        "-force_key_frames", "expr:gte(t,n_forced*6)", "-c:a", "aac", "-b:a", "128k", "-hls_time", "6", "-hls_playlist_type", "vod",
        "-hls_flags", "independent_segments", "-hls_segment_filename",
        path.join(variantDir, "segment_%03d.ts"), playlistPath,
      ], config.videoProcessTimeoutMs);
      hlsVariants.push({ profile: height, width: dimensions.width, height: dimensions.height, bandwidth, prefix: `${record.assetPrefix}/hls/${height}`, localDir: variantDir });
    } catch (error) {
      failedProfiles.push({ height, message: error.message });
    }
  }

  const thumbnailPath = path.join(workDir, "thumbnail.jpg");
  await run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y", "-ss", String(Math.min(2, metadata.duration * 0.1)),
    "-i", inputPath, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", thumbnailPath,
  ], 30_000).catch(() => null);

  return { mp4Path, mp4Dimensions, hlsVariants, failedProfiles, thumbnailPath };
}

async function uploadFile(r2, config, key, filePath, contentType) {
  await r2.send(new PutObjectCommand({
    Bucket: config.r2Bucket,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentLength: (await fsp.stat(filePath)).size,
    ContentType: contentType,
  }));
}

async function processJob(config) {
  const mongo = createMongo(config);
  const r2 = createR2(config);
  let workDir;
  let job;
  let record;
  let heartbeatTimer;
  let processingStage = "claim";
  try {
    await mongo.connect();
    const database = mongo.db(config.mongoDb);
    const jobs = database.collection("video_jobs");
    const claimed = await jobs.findOneAndUpdate(
      {
        $or: [
          { status: "queued" },
          { status: "processing", updatedAt: { $lt: new Date(Date.now() - 90_000) } },
        ],
      },
      { $set: { status: "processing", startedAt: new Date(), updatedAt: new Date() }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    );
    job = claimed?.value || claimed;
    if (!job) return;
    heartbeatTimer = setInterval(() => {
      jobs.updateOne({ _id: job._id, status: "processing" }, { $set: { updatedAt: new Date() } })
        .catch((error) => console.error("Video job heartbeat failed:", error.name));
    }, 30_000);
    heartbeatTimer.unref();
    const collection = videosCollection(database);
    record = await collection.findOne({ _id: new ObjectId(job.videoId), ownerId: job.ownerId, status: { $ne: "deleted" } });
    if (!record) {
      await jobs.updateOne({ _id: job._id }, { $set: { status: "deleted", updatedAt: new Date() } });
      return;
    }
    await collection.updateOne({ _id: record._id, ownerId: record.ownerId }, { $set: { status: "processing", error: null, updatedAt: new Date() } });
    processingStage = "download";
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper-video-"));
    const inputPath = path.join(workDir, "source");
    const source = await r2.send(new GetObjectCommand({ Bucket: config.r2Bucket, Key: record.sourceKey }));
    await pipeline(source.Body, fs.createWriteStream(inputPath));
    processingStage = "probe";
    const metadata = await inspectMedia(inputPath, config);
    processingStage = "transcode";
    const output = await transcode(config, inputPath, workDir, metadata, record);
    processingStage = "inspect_hls";
    for (const variant of output.hlsVariants) {
      const firstSegment = path.join(variant.localDir, "segment_000.ts");
      const variantMetadata = await inspectMedia(firstSegment, config);
      variant.codecs = hlsCodecString(variantMetadata);
    }

    processingStage = "upload_renditions";
    const mp4Key = `${record.assetPrefix}/mp4/video.mp4`;
    await uploadFile(r2, config, mp4Key, output.mp4Path, "video/mp4");
    const assets = {
      mp4: { key: mp4Key, width: output.mp4Dimensions.width, height: output.mp4Dimensions.height },
      hls: null,
      thumbnailKey: null,
    };
    if (await fsp.stat(output.thumbnailPath).then(() => true).catch(() => false)) {
      assets.thumbnailKey = `${record.assetPrefix}/thumbnail.jpg`;
      await uploadFile(r2, config, assets.thumbnailKey, output.thumbnailPath, "image/jpeg");
    }

    if (output.hlsVariants.length) {
      const masterPath = path.join(workDir, "master.m3u8");
      const master = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        ...output.hlsVariants.flatMap((variant) => [
          `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.width}x${variant.height},CODECS="${variant.codecs}"`,
          `${variant.profile}/index.m3u8`,
        ]),
        "",
      ].join("\n");
      await fsp.writeFile(masterPath, master);
      const masterKey = `${record.assetPrefix}/hls/master.m3u8`;
      await uploadFile(r2, config, masterKey, masterPath, "application/vnd.apple.mpegurl");
      const variants = [];
      for (const variant of output.hlsVariants) {
        const files = await fsp.readdir(variant.localDir);
        for (const filename of files) {
          const contentType = filename.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
          await uploadFile(r2, config, `${variant.prefix}/${filename}`, path.join(variant.localDir, filename), contentType);
        }
        variants.push({ height: variant.profile, resolutionHeight: variant.height, width: variant.width, bandwidth: variant.bandwidth, prefix: variant.prefix });
      }
      assets.hls = { masterKey, variants };
    }

    processingStage = "persist_result";
    const formats = ["mp4", ...(assets.hls ? ["hls"] : [])];
    const status = output.failedProfiles.length ? "partially_ready" : "ready";
    const now = new Date();
    const persisted = await collection.updateOne({ _id: record._id, ownerId: record.ownerId, status: { $ne: "deleted" } }, {
      $set: { status, metadata, assets, formats, error: output.failedProfiles.length ? "Some HLS quality levels could not be generated." : null, updatedAt: now },
    });
    if (!persisted.matchedCount) {
      await deleteVideoObjects(config, record);
      return;
    }
    await jobs.updateOne({ _id: job._id, status: "processing" }, {
      $set: { status, error: output.failedProfiles.length ? "Some HLS quality levels could not be generated." : null, completedAt: now, updatedAt: now },
    });
  } catch (error) {
    if (job) {
      const now = new Date();
      const message = error.message === "The uploaded file is not a valid video."
        ? error.message
        : /Video duration exceeds/.test(error.message)
          ? error.message
          : "Video processing failed. Retry this video.";
      await mongo.db(config.mongoDb).collection("video_jobs").updateOne({ _id: job._id, status: { $ne: "deleted" } }, {
        $set: { status: "failed", error: message, updatedAt: now, completedAt: now },
      }).catch((updateError) => console.error("Unable to persist video job failure:", updateError.message));
      await videosCollection(mongo.db(config.mongoDb)).updateOne(
        { _id: new ObjectId(job.videoId), ownerId: job.ownerId, status: { $ne: "deleted" } },
        { $set: { status: "failed", error: message, updatedAt: now } },
      ).catch((updateError) => console.error("Unable to persist video failure:", updateError.message));
      const diagnostic = String(error.message || "Unknown processing error")
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
        .replace(/[\r\n\t]+/g, " ")
        .slice(0, 1500);
      console.error("Video processing failed:", JSON.stringify({
        videoId: job.videoId,
        stage: processingStage,
        errorName: error.name || "Error",
        message: diagnostic,
      }));
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (workDir) await fsp.rm(workDir, { recursive: true, force: true });
    r2.destroy();
    await mongo.close();
  }
}

async function cleanupStaleUploads(config) {
  const mongo = createMongo(config);
  try {
    await mongo.connect();
    const collection = videosCollection(mongo.db(config.mongoDb));
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const cursor = collection.find({ status: "uploading", createdAt: { $lt: cutoff } });
    for await (const record of cursor) {
      try {
        await deleteVideoObjects(config, record);
        await collection.deleteOne({ _id: record._id, status: "uploading" });
      } catch (error) {
        console.error("Incomplete video cleanup failed:", record._id.toString(), error.name);
      }
    }
    const deleted = collection.find({ status: "deleted" });
    for await (const record of deleted) {
      try {
        await deleteVideoObjects(config, record);
        await collection.deleteOne({ _id: record._id, status: "deleted" });
      } catch (error) {
        console.error("Deleted video cleanup failed:", record._id.toString(), error.name);
      }
    }
  } finally {
    await mongo.close();
  }
}

export function startVideoWorker(config) {
  const timers = Array.from({ length: config.videoWorkerConcurrency }, () => {
    let running = false;
    const poll = async () => {
      if (running) return;
      running = true;
      try {
        await processJob(config);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => {
      poll().catch((error) => console.error("Video worker failed:", error.message));
    }, 1500);
    timer.unref();
    void poll();
    return timer;
  });
  const cleanupTimer = setInterval(() => {
    cleanupStaleUploads(config).catch((error) => console.error("Stale video upload cleanup failed:", error.message));
  }, 6 * 60 * 60 * 1000);
  cleanupTimer.unref();
  return () => {
    timers.forEach(clearInterval);
    clearInterval(cleanupTimer);
  };
}
