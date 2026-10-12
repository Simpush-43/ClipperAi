import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { ffmpegPath } from "./config.js";
import { run } from "./process.js";

function assTime(seconds) {
  const centiseconds = Math.round(Math.max(0, seconds) * 100);
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const wholeSeconds = Math.floor((centiseconds % 6000) / 100);
  const remainder = centiseconds % 100;
  const pad = (value) => String(value).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(wholeSeconds)}.${pad(remainder)}`;
}

function buildAss(words, clipStart, clipEnd) {
  const inClip = words.filter((word) => word.start >= clipStart - 0.05 && word.end <= clipEnd + 0.05);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,58,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,5,2,2,60,60,140,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = [];
  for (let index = 0; index < inClip.length; index += 3) {
    const group = inClip.slice(index, index + 3);
    const text = group.map((word) => word.word).join(" ").toUpperCase().replace(/[{}\\]/g, "");
    events.push(
      `Dialogue: 0,${assTime(group[0].start - clipStart)},${assTime(group[group.length - 1].end - clipStart)},Default,,0,0,0,,${text}`
    );
  }
  return header + events.join("\n") + "\n";
}

export async function renderClip({ words, clip, number, clipsDir }) {
  const name = `clip${number}`;
  const clipPath = path.join(clipsDir, `${name}.mp4`);
  const thumbnailPath = path.join(clipsDir, `${name}.jpg`);
  fs.writeFileSync(path.join(clipsDir, `${name}.ass`), buildAss(words, clip.start, clip.end));
  await run(ffmpegPath, [
    "-y", "-ss", String(clip.start), "-i", "../source.mp4", "-t", String(clip.end - clip.start),
    "-vf", `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,subtitles=${name}.ass`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k", clipPath,
  ], { cwd: clipsDir });

  const clipDuration = Math.max(1, clip.end - clip.start);
  const sampleAt = randomInt(Math.max(1, Math.floor(clipDuration * 1000))) / 1000;
  await run(ffmpegPath, [
    "-y", "-ss", String(sampleAt), "-i", clipPath,
    "-frames:v", "1", "-q:v", "3", thumbnailPath,
  ]);
  return { filePath: clipPath, thumbnailPath };
}
