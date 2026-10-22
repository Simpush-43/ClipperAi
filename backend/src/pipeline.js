import fs from "node:fs";
import { parseArgs } from "./config.js";
import { pickClips } from "./clip-selection.js";
import { renderClip } from "./render.js";
import { uploadClips } from "./storage.js";
import { getWords } from "./transcription.js";
import { createJobDirectories, downloadVideo, readVideoId } from "./youtube.js";

export async function runPipeline(args, { onProgress = () => {}, ownerId = "legacy-dashboard" } = {}) {
  const config = parseArgs(args);
  onProgress({ stage: "resolving", progress: 5, message: "Reading video details" });
  const videoId = await readVideoId(config.url);
  const { workDir, clipsDir, sourcePath } = createJobDirectories(videoId);

  try {
    onProgress({ stage: "downloading", progress: 12, message: "Downloading source video" });
    await downloadVideo(config.url, sourcePath);
    onProgress({ stage: "transcribing", progress: 35, message: "Extracting speech and timestamps" });
    const words = await getWords({ sourcePath, workDir, apiKey: config.groqApiKey });
    console.log(`Transcript: ${words.length} words. Asking Gemini for clips...`);

    onProgress({ stage: "selecting", progress: 55, message: "Finding the strongest moments" });
    const clips = await pickClips({
      words,
      maxClips: config.maxClips,
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
    });
    if (!clips.length) throw new Error("No usable clips returned. Check the prompt or try another video.");

    const rendered = [];
    for (let index = 0; index < clips.length; index++) {
      onProgress({
        stage: "rendering",
        progress: 60 + Math.round((index / clips.length) * 25),
        message: `Rendering clip ${index + 1} of ${clips.length}`,
      });
      console.log(`Rendering ${index + 1}/${clips.length}: ${clips[index].title}`);
      const output = await renderClip({ words, clip: clips[index], number: index + 1, clipsDir });
      rendered.push({ ...clips[index], ...output });
    }

    onProgress({ stage: "uploading", progress: 88, message: "Saving clips to cloud storage" });
    const uploaded = await uploadClips({ clips: rendered, videoId, config, ownerId });
    onProgress({ stage: "complete", progress: 100, message: `${uploaded.length} clips are ready`, clipCount: uploaded.length });
    console.log(`\nDone. Uploaded ${uploaded.length} clips to Cloudflare R2; metadata saved in MongoDB.`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    console.log("Local working files removed.");
  }
}
