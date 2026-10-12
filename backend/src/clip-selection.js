function formatTranscript(words) {
  const lines = [];
  for (let index = 0; index < words.length; index += 12) {
    const group = words.slice(index, index + 12);
    lines.push(`[${group[0].start.toFixed(1)}] ${group.map((word) => word.word).join(" ")}`);
  }
  return lines.join("\n");
}

export async function pickClips({ words, maxClips, apiKey, model }) {
  const prompt = `You are a short-form video editor. Below is a timestamped transcript (seconds).
Pick up to ${maxClips} moments that would work as standalone Instagram Reels.
Rules:
- Each clip is 20 to 45 seconds long.
- Starts on a strong hook (a bold claim, question, story start or surprise), never mid-thought.
- Ends at a natural conclusion or punchline.
- Must make sense without the rest of the video.
Return ONLY a JSON array: [{"start": number, "end": number, "title": string, "score": number 1-10}]

TRANSCRIPT:
${formatTranscript(words)}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    }
  );
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${await response.text()}`);

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
  const picks = JSON.parse(text);

  return picks
    .map((pick) => {
      const first = words.find((word) => word.end > pick.start);
      const last = [...words].reverse().find((word) => word.start < pick.end);
      return first && last ? { ...pick, start: first.start, end: last.end } : null;
    })
    .filter((pick) => pick && pick.end - pick.start >= 15 && pick.end - pick.start <= 60)
    .sort((first, second) => second.score - first.score)
    .slice(0, maxClips);
}
