import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpegPath } from "../backend/src/config.js";
import {
  inspectMedia,
  normalizeMultipartParts,
  outputDimensions,
  transcode,
  validateVideoUploadInput,
  videoOwnerFilter,
} from "../backend/src/videos.js";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

test("video upload validation rejects mismatched types and oversized files", () => {
  assert.deepEqual(validateVideoUploadInput({
    filename: "../../holiday.mp4",
    size: 100,
    contentType: "video/mp4",
    maxBytes: 1024,
  }), { ok: true, originalName: "holiday.mp4", contentType: "video/mp4" });

  assert.equal(validateVideoUploadInput({
    filename: "holiday.mp4",
    size: 100,
    contentType: "image/png",
    maxBytes: 1024,
  }).ok, false);
  assert.equal(validateVideoUploadInput({
    filename: "holiday.mov",
    size: 1025,
    contentType: "video/quicktime",
    maxBytes: 1024,
  }).ok, false);
});

test("output profiles preserve aspect ratio and never upscale", () => {
  assert.deepEqual(outputDimensions(320, 180, 1080), { width: 320, height: 180 });
  assert.deepEqual(outputDimensions(720, 1280, 720), { width: 720, height: 1280 });
  const square = outputDimensions(1000, 1000, 720);
  assert.equal(square.width, square.height);
  assert.ok(square.width <= 1000);
});

test("video access filters cannot cross owner boundaries", () => {
  const sharedFilter = { _id: "video-1", status: { $ne: "deleted" } };
  const aliceQuery = videoOwnerFilter("alice", sharedFilter);
  const bobQuery = videoOwnerFilter("bob", sharedFilter);
  assert.equal(aliceQuery.ownerId, "alice");
  assert.equal(bobQuery.ownerId, "bob");
  assert.notDeepEqual(aliceQuery, bobQuery);
  assert.throws(() => videoOwnerFilter("", sharedFilter), /authenticated owner ID/);
});

test("multipart completion requires every unique part and a quoted ETag", () => {
  const unordered = [
    { partNumber: 2, etag: '"part-two"' },
    { partNumber: 1, etag: '"part-one"' },
  ];
  assert.deepEqual(normalizeMultipartParts(unordered, 2), [
    { partNumber: 1, etag: '"part-one"' },
    { partNumber: 2, etag: '"part-two"' },
  ]);
  assert.equal(normalizeMultipartParts([{ partNumber: 1, etag: '"part-one"' }], 2), null);
  assert.equal(normalizeMultipartParts([
    { partNumber: 1, etag: '"part-one"' },
    { partNumber: 1, etag: '"duplicate"' },
  ], 2), null);
  assert.equal(normalizeMultipartParts([{ partNumber: 1, etag: "unquoted" }], 1), null);
});

test("FFprobe and FFmpeg produce a playable MP4 and HLS rendition for a small source", { timeout: 90_000 }, async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper-test-"));
  try {
    const inputPath = path.join(workDir, "source.mp4");
    await run(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=320x180:rate=24",
      "-t", "1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", inputPath,
    ]);
    const config = { ffprobePath: "path-to-ffprobe", videoMaxDurationSeconds: 30, videoProcessTimeoutMs: 60_000, videoFfmpegThreads: 1 };
    const metadata = await inspectMedia(inputPath, config);
    assert.equal(metadata.width, 320);
    assert.equal(metadata.height, 180);
    assert.equal(metadata.audioCodec, null);

    const output = await transcode(config, inputPath, workDir, metadata, { assetPrefix: "unit-test" });
    assert.equal(fs.statSync(output.mp4Path).isFile(), true);
    assert.equal(output.hlsVariants.length, 1);
    const variantPlaylist = await fsp.readFile(path.join(output.hlsVariants[0].localDir, "index.m3u8"), "utf8");
    assert.match(variantPlaylist, /segment_\d+\.ts/);
    assert.ok(fs.statSync(path.join(output.hlsVariants[0].localDir, "segment_000.ts")).size > 0);
    const outputMetadata = await inspectMedia(output.mp4Path, config);
    assert.ok(outputMetadata.width <= metadata.width);
    assert.ok(outputMetadata.height <= metadata.height);
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});
