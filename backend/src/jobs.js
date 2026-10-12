import { randomUUID } from "node:crypto";
import { runPipeline } from "./pipeline.js";

const jobs = new Map();
let activeJobId = null;

export function validateYouTubeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a valid YouTube link"); }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!["youtube.com", "m.youtube.com", "youtu.be"].includes(host) || url.protocol !== "https:") {
    throw new Error("Use a YouTube video link (youtube.com or youtu.be)");
  }
  if (host === "youtu.be" && !url.pathname.slice(1)) throw new Error("That YouTube link has no video ID");
  if (host.endsWith("youtube.com") && !url.searchParams.get("v") && !url.pathname.startsWith("/shorts/") && !url.pathname.startsWith("/live/")) {
    throw new Error("Use a YouTube video, Shorts, or live replay link");
  }
  return url.toString();
}

export function createJob({ url, maxClips }) {
  if (activeJobId) throw new Error("Another video is already processing. Please wait for it to finish.");
  const id = randomUUID();
  const job = {
    id,
    url,
    maxClips,
    status: "queued",
    stage: "queued",
    progress: 0,
    message: "Waiting to start",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  activeJobId = id;

  queueMicrotask(async () => {
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    try {
      await runPipeline([url, "--max", String(maxClips)], {
        onProgress(update) {
          Object.assign(job, update, { updatedAt: new Date().toISOString() });
          if (update.stage === "complete") job.status = "complete";
        },
      });
      job.status = "complete";
    } catch (error) {
      job.status = "failed";
      job.stage = "failed";
      job.message = error.message;
      job.updatedAt = new Date().toISOString();
    } finally {
      activeJobId = null;
      if (jobs.size > 100) {
        const removable = [...jobs.values()].filter((item) => item.status !== "running").slice(0, jobs.size - 100);
        for (const item of removable) jobs.delete(item.id);
      }
    }
  });

  return publicJob(job);
}

function publicJob(job) {
  const { id, status, stage, progress, message, clipCount, createdAt, updatedAt } = job;
  return { id, status, stage, progress, message, clipCount, createdAt, updatedAt };
}

export function getJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}
