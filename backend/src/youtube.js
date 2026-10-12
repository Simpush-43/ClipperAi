import fs from "node:fs";
import path from "node:path";
import { ffmpegPath, projectDir, ytDlpPath } from "./config.js";
import { run, runCapture } from "./process.js";

export async function readVideoId(url) {
  const result = await runCapture(ytDlpPath, ["--get-id", url]);
  return result.stdout.trim().split("\n")[0];
}

export function createJobDirectories(videoId) {
  const workDir = path.join(projectDir, "out", videoId);
  const clipsDir = path.join(workDir, "clips");
  fs.mkdirSync(clipsDir, { recursive: true });
  return { workDir, clipsDir, sourcePath: path.join(workDir, "source.mp4") };
}

export async function downloadVideo(url, sourcePath) {
  if (fs.existsSync(sourcePath)) return;

  console.log("Downloading (720p max)...");
  await run(ytDlpPath, [
    "-f", "bv*[height<=720]+ba/b[height<=720]",
    "--merge-output-format", "mp4",
    "--ffmpeg-location", ffmpegPath,
    "-o", sourcePath,
    url,
  ]);
}
