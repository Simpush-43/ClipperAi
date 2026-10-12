import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function createR2Client(config) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
  });
}

export function createClipObjectKey(videoId, filename) {
  return `${videoId}/${randomUUID()}-${path.basename(filename)}`;
}

export function getRetentionCutoff(days, now = Date.now()) {
  return new Date(now - days * 24 * 60 * 60 * 1000);
}

export async function uploadClips({ clips, videoId, config }) {
  const mongo = new MongoClient(config.mongoUri);
  const r2 = createR2Client(config);
  const uploaded = [];

  try {
    await mongo.connect();
    const collection = mongo.db(config.mongoDb).collection("clips");

    for (const clip of clips) {
      const key = createClipObjectKey(videoId, clip.filePath);
      const thumbnailKey = clip.thumbnailPath ? createClipObjectKey(videoId, clip.thumbnailPath) : null;
      const result = await r2.send(new PutObjectCommand({
        Bucket: config.r2Bucket,
        Key: key,
        Body: fs.createReadStream(clip.filePath),
        ContentLength: fs.statSync(clip.filePath).size,
        ContentType: "video/mp4",
      }));
      if (thumbnailKey) {
        await r2.send(new PutObjectCommand({
          Bucket: config.r2Bucket,
          Key: thumbnailKey,
          Body: fs.createReadStream(clip.thumbnailPath),
          ContentLength: fs.statSync(clip.thumbnailPath).size,
          ContentType: "image/jpeg",
        }));
      }
      const createdAt = new Date();
      const record = {
        videoId,
        title: clip.title,
        start: clip.start,
        end: clip.end,
        score: clip.score,
        status: "pending",
        storage: "r2",
        bucket: config.r2Bucket,
        key,
        thumbnailKey,
        etag: result.ETag,
        contentType: "video/mp4",
        createdAt,
      };
      try {
        await collection.insertOne(record);
      } catch (error) {
        if (thumbnailKey) await r2.send(new DeleteObjectCommand({ Bucket: config.r2Bucket, Key: thumbnailKey }));
        await r2.send(new DeleteObjectCommand({ Bucket: config.r2Bucket, Key: key }));
        throw error;
      }
      uploaded.push(record);
      console.log(`Uploaded ${key} to Cloudflare R2`);
    }

    await deleteExpiredClips({ collection, r2, bucket: config.r2Bucket, retentionDays: config.clipRetentionDays });
    return uploaded;
  } finally {
    r2.destroy();
    await mongo.close();
  }
}

async function deleteExpiredClips({ collection, r2, bucket, retentionDays }) {
  const cutoff = getRetentionCutoff(retentionDays);
  const expired = collection.find({ storage: "r2", createdAt: { $lt: cutoff } });
  let deleted = 0;

  for await (const record of expired) {
    if (!record.key) continue;
    await r2.send(new DeleteObjectCommand({ Bucket: record.bucket || bucket, Key: record.key }));
    if (record.thumbnailKey) {
      await r2.send(new DeleteObjectCommand({ Bucket: record.bucket || bucket, Key: record.thumbnailKey }));
    }
    const result = await collection.deleteOne({ _id: record._id });
    if (result.deletedCount !== 1) throw new Error(`R2 object ${record.key} was deleted but its MongoDB record was not`);
    deleted++;
  }

  if (deleted) console.log(`Removed ${deleted} clip(s) older than ${retentionDays} days from R2 and MongoDB`);
  return deleted;
}

export async function cleanupExpiredClips(config) {
  const mongo = new MongoClient(config.mongoUri);
  const r2 = createR2Client(config);
  try {
    await mongo.connect();
    const collection = mongo.db(config.mongoDb).collection("clips");
    return await deleteExpiredClips({
      collection,
      r2,
      bucket: config.r2Bucket,
      retentionDays: config.clipRetentionDays,
    });
  } finally {
    r2.destroy();
    await mongo.close();
  }
}

export async function getClipPlaybackUrl({ clipId, config }) {
  const mongo = new MongoClient(config.mongoUri);
  const r2 = createR2Client(config);
  try {
    await mongo.connect();
    const { ObjectId } = await import("mongodb");
    const record = await mongo.db(config.mongoDb).collection("clips").findOne({ _id: new ObjectId(clipId), storage: "r2" });
    if (!record) throw new Error("R2 clip record not found");

    const expiresIn = 60 * 60;
    const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: record.bucket, Key: record.key }), { expiresIn });
    const downloadUrl = await getSignedUrl(r2, new GetObjectCommand({
      Bucket: record.bucket,
      Key: record.key,
      ResponseContentDisposition: `attachment; filename="${path.basename(record.key)}"`,
    }), { expiresIn });
    const thumbnailUrl = record.thumbnailKey
      ? await getSignedUrl(r2, new GetObjectCommand({ Bucket: record.bucket, Key: record.thumbnailKey }), { expiresIn })
      : null;
    return { url, downloadUrl, thumbnailUrl, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  } finally {
    r2.destroy();
    await mongo.close();
  }
}

export async function listClips({ config, cursor, limit = 24 }) {
  const mongo = new MongoClient(config.mongoUri);
  try {
    await mongo.connect();
    const collection = mongo.db(config.mongoDb).collection("clips");
    const query = { storage: "r2" };

    if (cursor) {
      let decoded;
      try {
        decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      } catch {
        throw new Error("Invalid pagination cursor");
      }
      const { ObjectId } = await import("mongodb");
      if (!decoded.createdAt || !ObjectId.isValid(decoded.id)) throw new Error("Invalid pagination cursor");
      query.$or = [
        { createdAt: { $lt: new Date(decoded.createdAt) } },
        { createdAt: new Date(decoded.createdAt), _id: { $lt: new ObjectId(decoded.id) } },
      ];
    }

    const records = await collection.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = records.length > limit;
    if (hasMore) records.pop();
    const last = records.at(-1);

    return {
      clips: records.map(({ _id, videoId, title, start, end, score, status, createdAt, thumbnailKey, instagram, caption, hashtags, reviewStatus, postingChecklist, postedAt }) => ({
        id: _id.toString(), videoId, title, start, end, score, status, createdAt,
        expiresAt: new Date(createdAt.getTime() + config.clipRetentionDays * 24 * 60 * 60 * 1000),
        hasThumbnail: Boolean(thumbnailKey), instagram, caption: caption || "", hashtags: hashtags || [],
        reviewStatus: reviewStatus || "needs_review", postingChecklist: postingChecklist || {}, postedAt: postedAt || null,
      })),
      nextCursor: hasMore && last
        ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last._id.toString() })).toString("base64url")
        : null,
    };
  } finally {
    await mongo.close();
  }
}

export async function updateClipSocial({ clipId, update, config }) {
  const { ObjectId } = await import("mongodb");
  if (!ObjectId.isValid(clipId)) throw new Error("Invalid clip ID");

  const allowedStatuses = new Set(["needs_review", "approved", "posted_manually"]);
  if (!allowedStatuses.has(update.reviewStatus)) throw new Error("Invalid review status");
  if (typeof update.caption !== "string" || update.caption.length > 2200) throw new Error("Caption must be 2200 characters or fewer");
  if (!Array.isArray(update.hashtags) || update.hashtags.length > 30 || update.hashtags.some((tag) => typeof tag !== "string" || !/^#[\p{L}\p{N}_]{1,100}$/u.test(tag))) {
    throw new Error("Hashtags must be valid, up to 30 items");
  }
  const checklist = update.postingChecklist || {};
  if (["captionCopied", "fileDownloaded", "posted"].some((key) => typeof checklist[key] !== "boolean")) {
    throw new Error("Checklist values must be true or false");
  }

  const mongo = new MongoClient(config.mongoUri);
  try {
    await mongo.connect();
    const collection = mongo.db(config.mongoDb).collection("clips");
    const postedAt = update.reviewStatus === "posted_manually" ? new Date() : null;
    const result = await collection.updateOne({ _id: new ObjectId(clipId), storage: "r2" }, {
      $set: {
        caption: update.caption,
        hashtags: update.hashtags,
        reviewStatus: update.reviewStatus,
        postingChecklist: checklist,
        postedAt,
        socialUpdatedAt: new Date(),
      },
    });
    return result.matchedCount === 1;
  } finally {
    await mongo.close();
  }
}

export async function deleteClip({ clipId, config }) {
  const { ObjectId } = await import("mongodb");
  if (!ObjectId.isValid(clipId)) throw new Error("Invalid clip ID");

  const mongo = new MongoClient(config.mongoUri);
  const r2 = createR2Client(config);
  try {
    await mongo.connect();
    const collection = mongo.db(config.mongoDb).collection("clips");
    const record = await collection.findOne({ _id: new ObjectId(clipId), storage: "r2" });
    if (!record) return false;

    await r2.send(new DeleteObjectCommand({ Bucket: record.bucket, Key: record.key }));
    if (record.thumbnailKey) {
      await r2.send(new DeleteObjectCommand({ Bucket: record.bucket, Key: record.thumbnailKey }));
    }
    const result = await collection.deleteOne({ _id: record._id, storage: "r2" });
    return result.deletedCount === 1;
  } finally {
    r2.destroy();
    await mongo.close();
  }
}

export async function getInstagramAccountSettings(config) {
  const mongo = new MongoClient(config.mongoUri);
  try {
    await mongo.connect();
    const saved = await mongo.db(config.mongoDb).collection("settings").findOne({ _id: "instagram" });
    return {
      userId: saved?.userId || config.instagramUserId || "",
      tokenConfigured: Boolean(config.instagramAccessToken),
    };
  } finally {
    await mongo.close();
  }
}

export async function saveInstagramAccountId({ userId, config }) {
  const normalizedId = String(userId || "").trim();
  if (!/^\d{5,30}$/.test(normalizedId)) throw new Error("Enter a valid numeric Instagram Professional Account ID");

  const mongo = new MongoClient(config.mongoUri);
  try {
    await mongo.connect();
    await mongo.db(config.mongoDb).collection("settings").updateOne(
      { _id: "instagram" },
      { $set: { userId: normalizedId, updatedAt: new Date() } },
      { upsert: true },
    );
    return { userId: normalizedId, tokenConfigured: Boolean(config.instagramAccessToken) };
  } finally {
    await mongo.close();
  }
}

async function getInstagramUserId(database, config) {
  const settings = await database.collection("settings").findOne({ _id: "instagram" });
  const userId = settings?.userId || config.instagramUserId;
  if (!userId || !config.instagramAccessToken) {
    throw new Error("Save your Instagram Professional Account ID and configure the Meta access token on the backend first");
  }
  return userId;
}

async function instagramRequest(config, endpoint, { method = "GET", body } = {}) {
  const response = await fetch(`https://graph.facebook.com/${config.instagramGraphVersion}/${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${config.instagramAccessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error?.message || `Instagram API request failed (${response.status})`);
  return data;
}

export async function createInstagramReel({ clipId, caption, config }) {
  if (typeof caption !== "string" || caption.length > 2200) throw new Error("Caption must be 2200 characters or fewer");

  const mongo = new MongoClient(config.mongoUri);
  const r2 = createR2Client(config);
  try {
    await mongo.connect();
    const { ObjectId } = await import("mongodb");
    const database = mongo.db(config.mongoDb);
    const collection = database.collection("clips");
    const instagramUserId = await getInstagramUserId(database, config);
    const record = await collection.findOne({ _id: new ObjectId(clipId), storage: "r2" });
    if (!record) throw new Error("Clip not found");

    const videoUrl = await getSignedUrl(r2, new GetObjectCommand({ Bucket: record.bucket, Key: record.key }), { expiresIn: 60 * 60 * 24 });
    const container = await instagramRequest(config, `${instagramUserId}/media`, {
      method: "POST",
      body: { media_type: "REELS", video_url: videoUrl, caption, share_to_feed: true },
    });
    const status = await instagramRequest(config, container.id);
    await collection.updateOne({ _id: record._id }, {
      $set: {
        instagram: {
          containerId: container.id,
          status: status.status_code || "IN_PROGRESS",
          caption,
          updatedAt: new Date(),
        },
      },
    });
    return { containerId: container.id, status: status.status_code || "IN_PROGRESS" };
  } finally {
    r2.destroy();
    await mongo.close();
  }
}

export async function getInstagramReelStatus({ clipId, config }) {
  const mongo = new MongoClient(config.mongoUri);
  try {
    await mongo.connect();
    const { ObjectId } = await import("mongodb");
    const database = mongo.db(config.mongoDb);
    const collection = database.collection("clips");
    await getInstagramUserId(database, config);
    const record = await collection.findOne({ _id: new ObjectId(clipId), storage: "r2" });
    if (!record?.instagram?.containerId) throw new Error("No Instagram Reel container found for this clip");

    const status = await instagramRequest(config, `${record.instagram.containerId}?fields=status_code`);
    await collection.updateOne({ _id: record._id }, { $set: { "instagram.status": status.status_code, "instagram.updatedAt": new Date() } });
    return { status: status.status_code, mediaId: record.instagram.mediaId || null };
  } finally {
    await mongo.close();
  }
}

export async function publishInstagramReel({ clipId, config }) {
  const mongo = new MongoClient(config.mongoUri);
  try {
    await mongo.connect();
    const { ObjectId } = await import("mongodb");
    const database = mongo.db(config.mongoDb);
    const collection = database.collection("clips");
    const instagramUserId = await getInstagramUserId(database, config);
    const record = await collection.findOne({ _id: new ObjectId(clipId), storage: "r2" });
    if (!record?.instagram?.containerId) throw new Error("Create a Reel container first");
    if (record.instagram.status !== "FINISHED") throw new Error(`Reel is not ready to publish (status: ${record.instagram.status})`);

    const result = await instagramRequest(config, `${instagramUserId}/media_publish`, {
      method: "POST",
      body: { creation_id: record.instagram.containerId },
    });
    await collection.updateOne({ _id: record._id }, {
      $set: { "instagram.status": "PUBLISHED", "instagram.mediaId": result.id, "instagram.publishedAt": new Date() },
    });
    return { mediaId: result.id, status: "PUBLISHED" };
  } finally {
    await mongo.close();
  }
}
