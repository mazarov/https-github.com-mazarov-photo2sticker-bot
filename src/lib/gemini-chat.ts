import axios from "axios";
import { config } from "../config";

// ============================================
// Types
// ============================================

export interface AssistantParams {
  style: string | null;
  emotion: string | null;
  pose: string | null;
  confirmed: boolean;
  step: number;
}

export interface AssistantMessage {
  role: "system" | "user" | "model";
  content: string;
}

export interface GeminiChatResult {
  text: string;       // Clean text for user (without metadata)
  rawText: string;    // Raw text from Gemini (with metadata)
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

### Step 0. Greeting & Photo Request

YOU start the conversation. Greet the user and ask for a photo:

> Hi, {first_name}! 👋
> I'm your sticker creation assistant.
> My job is to make sure you love the result.
>
> Send me a photo you'd like to turn into a sticker.

If the user writes text instead of sending a photo, gently remind them:

> I need a photo first — send me the one you want to use for the sticker.

Do NOT proceed to Step 1 until a photo is received.

---

### Step 1. Base Style

After the photo is received, ask:

> Great photo! Now let's decide on the **style**.
> Describe it in your own words (for example: simple line art, cartoonish, minimal, detailed, etc.).

If the answer is vague, ask **one clarifying question only**.

**For experienced users (total_generations > 10):**
You may combine Steps 1-3 into one question:
> Great photo! You already know the drill 💪
> Describe the style, emotion, and pose — and I'll prepare everything.

---

### Step 2. Emotion

Ask:

> What **emotion** should this sticker convey?
> One word or a short description is enough.

---

### Step 3. Pose / Gesture

Ask:

> What **pose or gesture** best expresses this emotion?
> Describe it as best as you can — it doesn't have to be precise.

---

### Step 4. Mirror Understanding (critical)

After receiving all three answers, respond in **one single message**:

> Please check if I understood you correctly:
> – **Style:** {style}
> – **Emotion:** {emotion}
> – **Pose / gesture:** {pose}
>
> If anything is off, tell me what to change.

❗ Do not ask new questions after this message.
❗ Do not generate any image.
❗ After this message, the system will show an inline [✅ Confirm] button.

At the end of this message, append a hidden metadata block:
<!-- PARAMS:{"style":"...","emotion":"...","pose":"...","confirmed":false,"step":4} -->

---

### Step 5. Lock-in & Proceed

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
<!-- PARAMS:{"style":"...","emotion":"...","pose":"...","confirmed":true,"step":5} -->

---

## Metadata Rules

After EVERY response starting from Step 1, append a hidden metadata block at the very end:
<!-- PARAMS:{"style":"...or null","emotion":"...or null","pose":"...or null","confirmed":false,"step":N} -->

This allows the system to track progress without extra API calls.
Do NOT forget this metadata block — it is mandatory for every response from Step 1 onwards.

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

- User sends text before photo → remind them to send a photo first
- User sends a new photo mid-conversation → say "New photo! Which one should we use?" and wait
- User says something off-topic → gently redirect to the current step
- User confirms partially → ask about the remaining parameter

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
    
    // Validate required fields
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.step !== "number") return null;
    if (typeof parsed.confirmed !== "boolean") return null;

    return {
      style: typeof parsed.style === "string" ? parsed.style : null,
      emotion: typeof parsed.emotion === "string" ? parsed.emotion : null,
      pose: typeof parsed.pose === "string" ? parsed.pose : null,
      confirmed: parsed.confirmed,
      step: parsed.step,
    };
  } catch {
    return null;
  }
}

/**
 * Remove metadata block from text before showing to user
 */
export function stripMetadata(text: string): string {
  return text.replace(PARAMS_REGEX, "").trim();
}

// ============================================
// Gemini Chat API
// ============================================

const GEMINI_CHAT_MODEL = "gemini-2.0-flash";
const MAX_RETRIES = 2;
const RETRY_DELAYS = [2000, 4000]; // ms

/**
 * Call Gemini chat API with conversation history
 * 
 * @param messages - Conversation history (role: "user" | "model")
 * @param systemPrompt - System instruction
 * @returns GeminiChatResult with clean text, raw text, and parsed params
 */
export async function callGeminiChat(
  messages: AssistantMessage[],
  systemPrompt: string
): Promise<GeminiChatResult> {
  // Convert messages to Gemini format
  const contents = messages
    .filter(m => m.role !== "system")
    .map(m => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }],
    }));

  // Gemini API requires at least one user message in contents
  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: "Start the conversation." }] });
  }

  const body = {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  };

  let lastError: any = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CHAT_MODEL}:generateContent`,
        body,
        {
          headers: { "x-goog-api-key": config.geminiApiKey },
          timeout: 15000,
        }
      );

      const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        throw new Error("Gemini returned empty response");
      }

      const params = parseAssistantMetadata(rawText);
      const text = stripMetadata(rawText);

      return { text, rawText, params };
    } catch (err: any) {
      lastError = err;
      
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt] || 4000;
        console.log(
          `[GeminiChat] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${err.message}. Retrying in ${delay}ms...`
        );
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // All retries exhausted
  throw lastError;
}

// ============================================
// Fallback Extraction (separate Gemini call)
// ============================================

/**
 * Extract params from conversation when metadata parsing fails.
 * Used as fallback — separate Gemini call.
 */
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
  "confirmed": true or false,
  "step": number from 0 to 5
}

Conversation:
${conversationText}`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CHAT_MODEL}:generateContent`,
      {
        contents: [{ role: "user", parts: [{ text: extractionPrompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0,
        },
      },
      {
        headers: { "x-goog-api-key": config.geminiApiKey },
        timeout: 15000,
      }
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const parsed = JSON.parse(text);
    return {
      style: parsed.style || null,
      emotion: parsed.emotion || null,
      pose: parsed.pose || null,
      confirmed: parsed.confirmed === true,
      step: typeof parsed.step === "number" ? parsed.step : 0,
    };
  } catch (err: any) {
    console.error("[GeminiChat] Fallback extraction failed:", err.message);
    return null;
  }
}
