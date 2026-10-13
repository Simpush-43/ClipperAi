import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpegPath, projectDir, ytDlpPath } from "./config.js";
import { run, runCapture } from "./process.js";

const ytDlpOptions = process.env.YTDLP_JS_RUNTIME
  ? ["--js-runtimes", process.env.YTDLP_JS_RUNTIME === "deno"
      ? `deno:${path.join(projectDir, "tools", "deno", "bin", "deno")}`
      : process.env.YTDLP_JS_RUNTIME]
  : [];
const ytDlpRetryOptions = ["--retries", "5", "--extractor-retries", "3", "--sleep-requests", "1"];

async function runYtDlp(args, runner, options) {
  const commonArgs = [...ytDlpOptions, ...ytDlpRetryOptions];
  if (!process.env.YTDLP_COOKIES_FILE) {
    return runner(ytDlpPath, [...commonArgs, ...args], options);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-ytdlp-"));
  const tempCookiesPath = path.join(tempDir, "cookies.txt");
  try {
    fs.copyFileSync(process.env.YTDLP_COOKIES_FILE, tempCookiesPath);
    return await runner(ytDlpPath, [...commonArgs, "--cookies", tempCookiesPath, ...args], options);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function readVideoId(url) {
  const result = await runYtDlp(["--get-id", url], runCapture);
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
  await runYtDlp([
    "-f", "bv*[height<=720]+ba/b[height<=720]",
    "--merge-output-format", "mp4",
    "--ffmpeg-location", ffmpegPath,
    "-o", sourcePath,
    url,
  ], run);
}
