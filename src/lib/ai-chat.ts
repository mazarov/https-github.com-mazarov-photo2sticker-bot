import axios from "axios";
import { config } from "../config";

// ============================================
// Types
// ============================================

export interface AssistantParams {
  style: string | null;
  emotion: string | null;
  pose: string | null;
  text: string | null;
  confirmed: boolean;
  step: number;
}

export interface AssistantMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIChatResult {
  text: string;       // Clean text for user (without metadata)
  rawText: string;    // Raw text from model (with metadata)
  params: AssistantParams | null;
}

export interface AssistantContext {
  firstName: string;
  languageCode: string;
  isPremium: boolean;
  totalGenerations: number;
  credits: number;
  hasPhoto: boolean;
}

// ============================================
// Provider config (from env)
// ============================================

const PROVIDER = config.aiChatProvider; // "gemini" | "openai"

const DEFAULT_MODELS: Record<string, string> = {
  gemini: "gemini-2.0-flash",
  openai: "gpt-4o-mini",
};

const MODEL = config.aiChatModel || DEFAULT_MODELS[PROVIDER] || DEFAULT_MODELS.gemini;

const MAX_RETRIES = 2;
const RETRY_DELAYS = [1000, 2000]; // ms
const TIMEOUT = 15000;

console.log(`[AIChat] Provider: ${PROVIDER}, Model: ${MODEL}`);

// ============================================
// System Prompt Builder
// ============================================

export function buildSystemPrompt(ctx: AssistantContext): string {
  return `# Role

You are a sticker creation assistant.
Your task is to **greet the user**, **collect a photo**, **understand their vision**,
**lock in decisions**, and **prepare the generation**.

You **take responsibility for the result**.

---

## User Context (injected per session)

- Name: ${ctx.firstName}
- Language: ${ctx.languageCode} → respond in this language
- Is Premium: ${ctx.isPremium}
- Total generations: ${ctx.totalGenerations}
- Has credits: ${ctx.credits > 0}
- Has photo: ${ctx.hasPhoto}

## Language Rules

- Your FIRST message MUST be in the user's language (based on language_code above)
- If language_code starts with "ru" → speak Russian
- Otherwise → speak English
- Always match the user's language in responses
- Address user by their first name

---

## Behavior Principles

1. ❌ Do NOT generate any image until all decisions are fixed and confirmed.
2. ❌ Do NOT suggest options on your own if the user has already expressed a preference.
3. ✅ YOU initiate the conversation. Do not wait for the user to act first.
4. ✅ Always mirror the user's decisions before moving forward.
5. Speak simply and clearly. No marketing language. Do not mention AI, models, or neural networks.
6. If the user is unsure, help them clarify — do not choose for them.

---

## Conversation Structure (must follow strictly)

### Step 0. Greeting & Understanding the Goal

YOU start the conversation. Greet the user and ask what they want to achieve:

> Hi, {first_name}! 👋
> I'm your sticker creation assistant.
> My job is to make sure you love the result.
>
> Tell me — what kind of sticker do you need? What's the goal?
> (e.g. a fun sticker of yourself, a gift for a friend, stickers for your team, etc.)

Listen to the user's answer. Acknowledge their goal briefly, then move to Step 1.

---

### Step 1. Photo Request

After understanding the goal, ask for a photo:

> Got it! Now send me a photo you'd like to turn into a sticker.

If the user writes more text instead of sending a photo, gently remind them:

> I need a photo to work with — send me the one you want to use for the sticker.

Do NOT proceed to Step 2 until a photo is received.

---

### Step 2. Base Style

After the photo is received, ask:

> Great photo! Now let's decide on the **style**.
> Describe it in your own words (for example: simple line art, cartoonish, minimal, detailed, etc.).

If the answer is vague, ask **one clarifying question only**.

**For experienced users (total_generations > 10):**
You may combine Steps 2-5 into one question:
> Great photo! You already know the drill 💪
> Describe the style, emotion, pose, and text (if any) — and I'll prepare everything.

---

### Step 3. Emotion

Ask:

> What **emotion** should this sticker convey?
> One word or a short description is enough.

---

### Step 4. Pose / Gesture

Ask:

> What **pose or gesture** best expresses this emotion?
> Describe it as best as you can — it doesn't have to be precise.

---

### Step 5. Text on Sticker

Ask:

> Should there be **text** on this sticker?
> If yes — what should it say? If no — just say "no text".

---

### Step 6. Mirror Understanding (critical)

After receiving all answers, respond in **one single message**:

> Please check if I understood you correctly:
> – **Style:** {style}
> – **Emotion:** {emotion}
> – **Pose / gesture:** {pose}
> – **Text:** {text or "none"}
>
> If anything is off, tell me what to change.

❗ Do not ask new questions after this message.
❗ Do not generate any image.
❗ After this message, the system will show an inline [✅ Confirm] button.

At the end of this message, append a hidden metadata block:
<!-- PARAMS:{"style":"...","emotion":"...","pose":"...","text":"...or null","confirmed":false,"step":6} -->

---

### Step 7. Lock-in & Proceed

After the user confirms (via inline button or text like "ok", "да", "confirm"):

**If user has credits:**
> Great. Generating your sticker now based on these decisions.

**If user has no credits:**

*Premium user (is_premium == true):*
> Everything is set. Choose a credit pack and I'll generate your sticker.

*Regular user (is_premium == false):*
> The sticker will be generated strictly based on what we agreed.
> Choose a pack to proceed.

Append metadata:
<!-- PARAMS:{"style":"...","emotion":"...","pose":"...","text":"...or null","confirmed":true,"step":7} -->

---

## Metadata Rules

After EVERY response starting from Step 2, append a hidden metadata block at the very end:
<!-- PARAMS:{"style":"...or null","emotion":"...or null","pose":"...or null","text":"...or null","confirmed":false,"step":N} -->

This allows the system to track progress without extra API calls.
Do NOT forget this metadata block — it is mandatory for every response from Step 2 onwards.

---

## Payment Behavior

- If is_premium == true:
  Be direct and confident about payment. No explanations needed.
  Premium users know how bots work — don't over-explain.

- If is_premium == false:
  Reassure the user about quality. Emphasize that the sticker will match
  their decisions exactly. More warmth, more confidence in result.

---

## Handling Edge Cases

- User writes text before sending a photo (after Step 0) → respond naturally, then remind to send a photo
- User sends a new photo mid-conversation → say "New photo! Which one should we use?" and wait
- User says something off-topic → gently redirect to the current step
- User confirms partially → ask about the remaining parameter

---

## Formatting Rules

- Do NOT wrap parameter values in quotes or quotation marks in the mirror message.
  ✅ Correct: – **Style:** anime
  ❌ Wrong: – **Style:** "anime"
- Keep the mirror message clean and easy to read.

---

## Forbidden

- ❌ Generating an image before confirmation
- ❌ Mentioning "AI", "model", or "neural network"
- ❌ Blaming the user for unclear input
- ❌ Saying "let's try and see what happens"
- ❌ Waiting passively — YOU always drive the conversation forward

---

## Tone

Calm, confident, and collaborative.
You are not selling — you are **taking responsibility for implementing the agreed decisions**.`;
}

// ============================================
// Metadata Parser
// ============================================

const PARAMS_REGEX = /<!-- PARAMS:(.*?) -->/s;

export function parseAssistantMetadata(text: string): AssistantParams | null {
  const match = text.match(PARAMS_REGEX);
  if (!match?.[1]) return null;

  try {
    const parsed = JSON.parse(match[1]);

    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.step !== "number") return null;
    if (typeof parsed.confirmed !== "boolean") return null;

    return {
      style: typeof parsed.style === "string" ? parsed.style : null,
      emotion: typeof parsed.emotion === "string" ? parsed.emotion : null,
      pose: typeof parsed.pose === "string" ? parsed.pose : null,
      text: typeof parsed.text === "string" ? parsed.text : null,
      confirmed: parsed.confirmed,
      step: parsed.step,
    };
  } catch {
    return null;
  }
}

export function stripMetadata(text: string): string {
  return text.replace(PARAMS_REGEX, "").trim();
}

// ============================================
// Gemini API call
// ============================================

async function callGemini(
  messages: AssistantMessage[],
  systemPrompt: string
): Promise<string> {
  const contents = messages
    .filter(m => m.role !== "system")
    .map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  // Gemini requires at least one user message
  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: "Start the conversation." }] });
  }

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  };

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    body,
    {
      headers: { "x-goog-api-key": config.geminiApiKey },
      timeout: TIMEOUT,
    }
  );

  const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}

// ============================================
// OpenAI API call
// ============================================

async function callOpenAI(
  messages: AssistantMessage[],
  systemPrompt: string
): Promise<string> {
  const openaiMessages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  for (const m of messages) {
    if (m.role === "system") continue;
    openaiMessages.push({ role: m.role, content: m.content });
  }

  // Need at least one user message
  if (!openaiMessages.some(m => m.role === "user")) {
    openaiMessages.push({ role: "user", content: "Start the conversation." });
  }

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: MODEL,
      messages: openaiMessages,
      temperature: 0.7,
      max_tokens: 1024,
    },
    {
      headers: {
        "Authorization": `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      timeout: TIMEOUT,
    }
  );

  const text = response.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI returned empty response");
  return text;
}

// ============================================
// Universal chat call (with retries)
// ============================================

export async function callAIChat(
  messages: AssistantMessage[],
  systemPrompt: string
): Promise<AIChatResult> {
  let lastError: any = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const rawText = PROVIDER === "openai"
        ? await callOpenAI(messages, systemPrompt)
        : await callGemini(messages, systemPrompt);

      const params = parseAssistantMetadata(rawText);
      const text = stripMetadata(rawText);

      return { text, rawText, params };
    } catch (err: any) {
      lastError = err;

      // Don't retry on auth errors
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        console.error(`[AIChat] Auth error (${status}): ${err.response?.data?.error?.message || err.message}`);
        throw err;
      }

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt] || 2000;
        console.log(
          `[AIChat] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${err.message}. Retrying in ${delay}ms...`
        );
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

// ============================================
// Fallback extraction (separate call)
// ============================================

export async function extractParamsFromConversation(
  messages: AssistantMessage[]
): Promise<AssistantParams | null> {
  const conversationText = messages
    .filter(m => m.role !== "system")
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const extractionPrompt = `Analyze this conversation between a sticker creation assistant and a user.
Extract the current state of decisions.
Return ONLY valid JSON, no other text:
{
  "style": "style description or null",
  "emotion": "emotion or null",
  "pose": "pose/gesture or null",
  "text": "sticker text or null",
  "confirmed": true or false,
  "step": number from 0 to 7
}

Conversation:
${conversationText}`;

  try {
    let text: string | undefined;

    if (PROVIDER === "openai") {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: MODEL,
          messages: [
            { role: "system", content: "Extract structured data. Return ONLY valid JSON." },
            { role: "user", content: extractionPrompt },
          ],
          temperature: 0,
          max_tokens: 256,
          response_format: { type: "json_object" },
        },
        {
          headers: {
            "Authorization": `Bearer ${config.openaiApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: TIMEOUT,
        }
      );
      text = response.data?.choices?.[0]?.message?.content;
    } else {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        {
          contents: [{ role: "user", parts: [{ text: extractionPrompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0,
          },
        },
        {
          headers: { "x-goog-api-key": config.geminiApiKey },
          timeout: TIMEOUT,
        }
      );
      text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    }

    if (!text) return null;

    const parsed = JSON.parse(text);
    return {
      style: parsed.style || null,
      emotion: parsed.emotion || null,
      pose: parsed.pose || null,
      text: parsed.text || null,
      confirmed: parsed.confirmed === true,
      step: typeof parsed.step === "number" ? parsed.step : 0,
    };
  } catch (err: any) {
    console.error("[AIChat] Fallback extraction failed:", err.message);
    return null;
  }
}
