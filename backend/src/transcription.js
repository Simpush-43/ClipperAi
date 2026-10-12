import fs from "node:fs";
import path from "node:path";
import { chunkSeconds, ffmpegPath } from "./config.js";
import { run } from "./process.js";

async function transcribeChunk(file, offset, apiKey) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)]), path.basename(file));
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Groq ${response.status}: ${await response.text()}`);

  const data = await response.json();
  return (data.words || []).map((word) => ({
    word: word.word.trim(),
    start: word.start + offset,
    end: word.end + offset,
  }));
}

export async function getWords({ sourcePath, workDir, apiKey }) {
  const cachePath = path.join(workDir, "words.json");
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, "utf8"));

  console.log("Extracting audio...");
  await run(ffmpegPath, [
    "-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k",
    "-f", "segment", "-segment_time", String(chunkSeconds), "-reset_timestamps", "1",
    path.join(workDir, "audio_%03d.mp3"),
  ]);

  const chunks = fs.readdirSync(workDir).filter((file) => /^audio_\d+\.mp3$/.test(file)).sort();
  const words = [];
  for (let index = 0; index < chunks.length; index++) {
    console.log(`Transcribing chunk ${index + 1}/${chunks.length}...`);
    words.push(...await transcribeChunk(path.join(workDir, chunks[index]), index * chunkSeconds, apiKey));
  }

  fs.writeFileSync(cachePath, JSON.stringify(words));
  return words;
}
