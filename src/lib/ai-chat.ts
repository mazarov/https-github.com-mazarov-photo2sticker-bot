import axios from "axios";
import { config } from "../config";

// ============================================
// Types
// ============================================

export interface ToolCall {
  name: "update_sticker_params" | "confirm_and_generate" | "request_photo";
  args: Record<string, any>;
}

export interface AssistantMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIChatResult {
  text: string;            // Text for user (may be empty if only tool call)
  toolCall: ToolCall | null;  // Function call from LLM (if any)
}

export interface AssistantContext {
  firstName: string;
  languageCode: string;
  isPremium: boolean;
  totalGenerations: number;
  credits: number;
  hasPhoto: boolean;
  previousGoal?: string | null;
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
// Tools definition (Function Calling)
// ============================================

const ASSISTANT_TOOLS = [
  {
    name: "update_sticker_params",
    description: "Call when user provides sticker parameters (style, emotion, pose). Can update one or several at once. Call every time user mentions any parameter.",
    parameters: {
      type: "object",
      properties: {
        style: { type: "string", description: "Sticker visual style (e.g. anime, cartoon, minimal, line art, realistic)" },
        emotion: { type: "string", description: "Emotion to express (e.g. happy, sad, surprised, love, angry)" },
        pose: { type: "string", description: "Pose or gesture (e.g. peace sign, thumbs up, waving, crossed arms)" },
      },
    },
  },
  {
    name: "confirm_and_generate",
    description: "Call ONLY when user explicitly confirms all parameters and is ready to generate the sticker. User must say something affirmative like 'yes', 'ok', 'да', 'confirm', 'go ahead', 'подтверждаю'.",
  },
  {
    name: "request_photo",
    description: "Call when you need to ask the user for a photo to create a sticker from. Call this after understanding the user's goal.",
  },
];

// ============================================
// System Prompt Builder (v2 — compact, tool-based)
// ============================================

export function buildSystemPrompt(ctx: AssistantContext): string {
  return `You are a sticker creation assistant. Your goal: collect 3 parameters from the user (style, emotion, pose) and confirm them before generation.

You have these tools:
- update_sticker_params() — call when user provides any parameter(s)
- confirm_and_generate() — call ONLY when user explicitly confirms all parameters
- request_photo() — call when you need to ask for a photo

## User Context
- Name: ${ctx.firstName}
- Language: ${ctx.languageCode} → respond in this language
- Is Premium: ${ctx.isPremium}
- Total generations: ${ctx.totalGenerations}
- Has credits: ${ctx.credits > 0}
- Has photo: ${ctx.hasPhoto}
- Returning user: ${ctx.previousGoal ? "yes" : "no"}${ctx.previousGoal ? `\n- Previous goal: ${ctx.previousGoal}` : ""}

## Language Rules
- If language_code starts with "ru" → speak Russian
- Otherwise → speak English
- Always match the user's language in responses
- Address user by their first name

## Conversation Flow
1. If returning user (previous goal exists): greet briefly, skip the goal question, go directly to request_photo().
   If new user: greet and understand their goal (why they need stickers). Ask ONE question only about the goal.
2. After understanding the goal (or skipping for returning users), ask for a photo via request_photo()
3. After photo received, collect style, emotion, pose — ask one at a time
4. If user gives multiple params at once — accept all via single update_sticker_params() call
5. NEVER ask for parameters already collected (see [SYSTEM STATE] below)
6. When all 3 params collected — show mirror message, then STOP and wait for user response
7. After mirror — ONLY if user explicitly confirms (says "да", "ok", "go", "подтверждаю", "верно", "yes") → call confirm_and_generate()
8. If user wants changes → call update_sticker_params() with new values, then show new mirror

CRITICAL RULES for confirm_and_generate():
- NEVER call confirm_and_generate() if ANY parameter is still missing (check [SYSTEM STATE])
- NEVER call confirm_and_generate() in the same turn where you collect the last parameter
- When user provides the last missing param: FIRST call update_sticker_params(), THEN show mirror, THEN STOP
- The user MUST explicitly say something affirmative AFTER seeing the mirror before you call confirm_and_generate()

For experienced users (total_generations > 10):
  Combine style + emotion + pose into one question after photo.

## Mirror Message Format (when all 3 collected)
> – **Style:** value
> – **Emotion:** value
> – **Pose / gesture:** value
>
> If anything is off, tell me what to change.

NEVER use quotes around values. Plain text only.

## Behavior Rules
- YOU initiate the conversation. Do not wait for the user.
- Speak simply and clearly. No marketing language.
- Do NOT mention AI, models, or neural networks.
- Do NOT generate any image — only collect and confirm parameters.
- If user is unsure, help them clarify — do not choose for them.
- If user writes text but you need a photo, remind them to send a photo.

## Tone
Calm, confident, collaborative. You take responsibility for the result.`;
}

// ============================================
// Gemini API call (with function calling)
// ============================================

async function callGemini(
  messages: AssistantMessage[],
  systemPrompt: string
): Promise<AIChatResult> {
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

  const body: Record<string, any> = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: [{ function_declarations: ASSISTANT_TOOLS }],
    tool_config: { function_calling_config: { mode: "AUTO" } },
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

  const parts = response.data?.candidates?.[0]?.content?.parts || [];
  let text = "";
  let toolCall: ToolCall | null = null;

  for (const part of parts) {
    if (part.text) {
      text += part.text;
    }
    if (part.functionCall) {
      toolCall = {
        name: part.functionCall.name,
        args: part.functionCall.args || {},
      };
    }
  }

  if (!text && !toolCall) {
    throw new Error("Gemini returned empty response (no text, no function call)");
  }

  return { text: text.trim(), toolCall };
}

// ============================================
// OpenAI API call (with function calling)
// ============================================

async function callOpenAI(
  messages: AssistantMessage[],
  systemPrompt: string
): Promise<AIChatResult> {
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

  // Convert tools to OpenAI format
  const openaiTools = ASSISTANT_TOOLS.map(t => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: (t as any).parameters || { type: "object", properties: {} },
    },
  }));

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: MODEL,
      messages: openaiMessages,
      tools: openaiTools,
      tool_choice: "auto",
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

  const choice = response.data?.choices?.[0];
  const text = choice?.message?.content || "";
  let toolCall: ToolCall | null = null;

  const toolCalls = choice?.message?.tool_calls || [];
  if (toolCalls.length > 0) {
    const tc = toolCalls[0];
    try {
      toolCall = {
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments || "{}"),
      };
    } catch {
      console.error("[AIChat] Failed to parse OpenAI tool call arguments:", tc.function.arguments);
    }
  }

  if (!text && !toolCall) {
    throw new Error("OpenAI returned empty response (no text, no function call)");
  }

  return { text: text.trim(), toolCall };
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
      const result = PROVIDER === "openai"
        ? await callOpenAI(messages, systemPrompt)
        : await callGemini(messages, systemPrompt);

      return result;
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
