function formatTranscript(words) {
  const lines = [];
  for (let index = 0; index < words.length; index += 12) {
    const group = words.slice(index, index + 12);
    lines.push(`[${group[0].start.toFixed(1)}] ${group.map((word) => word.word).join(" ")}`);
  }
  return lines.join("\n");
}

export async function pickClips({ words, maxClips, apiKey, model }) {
  const prompt = `You are an expert short-form video editor, viral content strategist, comedy editor, and audience-retention analyst.

Your job is to identify the MOST engaging, funny, entertaining, surprising, and highly shareable moments from the timestamped transcript of a long-form YouTube video.

The goal is to select clips that make viewers stop scrolling, become curious, watch until the end, react emotionally, laugh, and potentially share the Reel with friends.

Do NOT select clips simply because they contain interesting dialogue. Select moments that have the strongest potential to entertain a cold audience that has never seen the original video.

INPUT:

- Maximum clips: ${maxClips}
- Transcript with word-level timestamps: ${formatTranscript(words)}

1. WHAT MAKES A GREAT CLIP?

Prioritize moments with one or more of these qualities:

- FUNNY: Genuine jokes, unexpected punchlines, witty comebacks, roasting, sarcasm, awkward situations, absurd statements, funny reactions, or natural banter.
- CURIOSITY: Intriguing statements, unusual situations, unanswered questions, mysteries, or stories that make viewers want to know what happens next.
- SURPRISE: Unexpected twists, shocking revelations, sudden changes in the conversation, or outcomes that defy expectations.
- RELATABILITY: Situations, opinions, struggles, or experiences that viewers immediately recognize from their own lives.
- DRAMA: Playful arguments, disagreements, challenges, bold opinions, escalating tension, or entertaining confrontations.
- STORYTELLING: Short stories with a clear setup, escalating events, and a satisfying payoff.
- REACTION: Moments where the speaker's response, delivery, disbelief, excitement, embarrassment, or frustration makes the moment entertaining.

Favor authentic, spontaneous, conversational moments over generic motivational statements, repetitive explanations, forced jokes, or ordinary discussion.

A clip does NOT need to contain all these qualities. One exceptionally strong quality can be enough.

2. HOOK: WIN THE FIRST 1–3 SECONDS

Every clip must begin at the earliest point needed to establish a compelling hook.

Strong openings may include:

- An outrageous or funny statement.
- A bold opinion that invites disagreement.
- A surprising confession or revelation.
- The beginning of an intriguing story.
- A provocative question.
- A ridiculous situation that immediately makes sense.
- A setup that creates a strong desire to hear the punchline.

Avoid:

- Greetings, introductions, and channel promotions.
- Long context-setting before anything interesting happens.
- Filler words or pauses that can be removed.
- Starting in the middle of a sentence or cutting off a necessary setup.
- Hooks that sound interesting only when the original video is already familiar.

Do not invent hooks or rewrite spoken dialogue. Select timestamps that preserve the actual spoken content.

3. RETENTION: CREATE A REASON TO KEEP WATCHING

Evaluate the complete moment, not just its opening.

Prefer clips that naturally create a curiosity gap, escalating humor, suspense, an entertaining exchange, or anticipation of a payoff.

An ideal clip often follows this structure:

HOOK → CONTEXT → ESCALATION / DEVELOPMENT → PAYOFF

This structure is a guideline, not a rigid formula. A short, instantly funny moment may work without a conventional story.

The clip should keep delivering something interesting. Avoid moments that start strongly but become repetitive, lose energy, or spend too long explaining the joke.

Whenever possible, select moments where:

- Each line adds new information or makes the situation funnier.
- The viewer anticipates what the speaker will say next.
- The punchline or reaction rewards the viewer for staying.
- The ending feels satisfying rather than abruptly cut off.

Never sacrifice necessary context just to create a shorter clip.

4. COMEDY AND SHAREABILITY

For funny content, pay special attention to:

- Setup and punchline combinations.
- Unexpected word choices or comparisons.
- Playful roasting and clever comebacks.
- Escalating absurdity.
- Deadpan delivery and ironic statements.
- Genuine reactions and awkward silences, when supported by the transcript.
- Exchanges where one person's response makes the previous line funnier.

Prefer humor that a broad audience can understand without extensive background knowledge.

Do not assume a moment is funny merely because the speaker uses profanity, laughs, shouts, or says something controversial.

Do not fabricate laughter, facial expressions, reactions, or visual events that are not available in the input. Since you only have the transcript, judge humor primarily from the actual dialogue and conversational structure.

5. STANDALONE CONTEXT

Every clip must make sense to a new viewer without requiring them to watch the original video.

Include enough preceding dialogue to understand the situation, joke, question, or story.

Exclude moments that depend heavily on:

- Unexplained references to earlier conversations.
- Missing questions or missing punchlines.
- Context that appears far outside the selected timestamps.
- Visual information that cannot be inferred from the transcript.

If the best moment needs 5–10 seconds of setup, include that setup when it improves the complete clip.

6. TIMING AND CLIP BOUNDARIES

- Every clip MUST be between 20 and 45 seconds long.
- Calculate duration as end - start.
- Use the supplied timestamps accurately.
- Start at the earliest necessary point for a clean, understandable opening.
- End immediately after the natural conclusion, punchline, reaction, or satisfying payoff.
- Include a brief reaction or pause only when it improves comedic timing.
- Avoid long dead spaces, repetitive dialogue, unfinished sentences, and unnecessary trailing audio.
- Do not cut off an important sentence, punchline, or reaction.
- Do not invent timestamps or select moments outside the transcript's available range.

A clip lasting 20 seconds is not automatically better than one lasting 35 seconds. Choose the duration that best serves the moment, while respecting the 20–45 second limit.

7. STRICT QUALITY FILTER

Reject a moment if:

- It is mostly filler or ordinary conversation.
- It needs extensive missing context.
- Its opening is weak and cannot be improved by selecting a better start time.
- It has no meaningful payoff, entertaining development, or compelling information.
- Its apparent appeal depends entirely on a topic being discussed rather than how the moment unfolds.
- It repeats essentially the same joke or story as a stronger candidate.
- It is too incomplete to work as a standalone Reel.

Do not force ${maxClips} clips. Return fewer clips if the transcript does not contain enough genuinely strong moments.

Quality matters more than quantity.

8. SCORING AND SELECTION

Score every candidate internally from 1 to 10 using these criteria:

- Hook strength: 25%
- Retention potential and payoff: 25%
- Humor, surprise, or emotional impact: 20%
- Standalone clarity: 15%
- Relatability and shareability: 10%
- Clean timing and editability: 5%

Use these score ranges consistently:

- 9–10: Exceptional candidate; immediately engaging, memorable, and has a strong payoff.
- 7–8: Strong candidate; entertaining and suitable for a Reel.
- 5–6: Average; some appeal, but a noticeable weakness.
- 1–4: Weak; unlikely to hold a cold audience.

Select the strongest candidates across the entire transcript, not merely the first good moments you encounter.

Prefer distinct moments with different hooks, comedic styles, or emotional beats. Avoid near-duplicate clips and excessive overlap between selected timestamps.

Rank the final clips by descending score.

Important: These scores represent editorial judgment, not guaranteed virality or measured audience retention.

9. TITLES

Give each selected clip a short, compelling title that:

- Creates curiosity or communicates the funniest part.
- Sounds natural, conversational, and specific to the moment.
- Is easy to understand at a glance.
- Avoids generic clickbait, misleading claims, and unnecessary capitalization.
- Does not reveal the punchline if withholding it improves curiosity.

Keep titles concise, preferably 3–8 words.

10. OUTPUT FORMAT — STRICT

Return ONLY a valid JSON array. No Markdown, no explanations, no comments, and no text before or after the JSON.

Use exactly this schema:

[
{
"start": 123.45,
"end": 156.78,
"title": "A short compelling title",
"score": 9
}
]

Output requirements:

- "start" and "end" must be numeric timestamps in seconds.
- "title" must be a string.
- "score" must be an integer from 1 to 10.
- Return no more than ${maxClips} clips.
- Ensure every clip is 20–45 seconds long.
- Sort by score from highest to lowest.
- Ensure valid JSON with no trailing commas.
- Return an empty array [] if no clip meets the quality standard.

Before responding, silently verify all timestamps, durations, standalone clarity, hook quality, payoff, ranking, and JSON validity.

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
