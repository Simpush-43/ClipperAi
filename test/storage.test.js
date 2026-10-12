import test from "node:test";
import assert from "node:assert/strict";
import { createClipObjectKey, getRetentionCutoff } from "../backend/src/storage.js";

test("object keys are unique across uploads of the same clip filename", () => {
  const first = createClipObjectKey("youtube-video", "clip1.mp4");
  const second = createClipObjectKey("youtube-video", "clip1.mp4");

  assert.notEqual(first, second);
  assert.match(first, /^youtube-video\/[0-9a-f-]{36}-clip1\.mp4$/);
  assert.match(second, /^youtube-video\/[0-9a-f-]{36}-clip1\.mp4$/);
});

test("retention cutoff is exactly 21 days before the supplied time", () => {
  const now = Date.UTC(2026, 9, 11);
  assert.equal(getRetentionCutoff(21, now).getTime(), now - 21 * 24 * 60 * 60 * 1000);
});
