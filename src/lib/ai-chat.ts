import axios from "axios";
import { config } from "../config";

// ============================================
// Types
// ============================================

export interface ToolCall {
  name: "update_sticker_params" | "confirm_and_generate" | "request_photo" | "show_style_examples" | "grant_trial_credit" | "check_balance";
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
  availableStyles?: string[];
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
    description: `Call when user provides sticker parameters. CRITICAL: copy the user's COMPLETE phrase as-is. Example: user says "аниме аватар аанг" → style must be "аниме аватар аанг", NOT just "аниме". Never shorten, normalize, or split the user's input.`,
    parameters: {
      type: "object",
      properties: {
        style: { type: "string", description: "Sticker visual style. MUST be the user's FULL phrase verbatim. Never truncate. Example: 'аниме аватар аанг' NOT 'аниме'." },
        emotion: { type: "string", description: "Emotion to express. Use the user's FULL phrase verbatim." },
        pose: { type: "string", description: "Pose or gesture. Use the user's FULL phrase verbatim." },
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
  {
    name: "show_style_examples",
    description: "Call to show the user example stickers in different styles. Always call WITHOUT style_id — code will show buttons for ALL styles, user picks one. Only pass style_id if user explicitly named a specific style. Use when user asks to see examples, can't decide on a style, or when showing examples would help.",
    parameters: {
      type: "object",
      properties: {
        style_id: {
          type: "string",
          description: "Style preset ID. Usually omit — let user pick from buttons. Only pass if user explicitly named a style.",
        },
      },
    },
  },
  {
    name: "grant_trial_credit",
    description: `Call INSTEAD of confirm_and_generate when user confirmed parameters but has 0 credits and never purchased.
Your goal: decide if giving 1 free credit will lead to a PURCHASE.
You are spending a limited daily budget — be strategic.

GRANT if user shows HIGH conversion potential:
- Specific, personal goal (gift, team stickers, business use)
- Detailed style/emotion preferences (shows they care about quality)
- Engaged conversation (3+ meaningful messages, not just 'ok')
- Premium Telegram user (higher purchasing power)

DENY if user shows LOW conversion potential:
- Vague goal ('just checking', 'want to try')
- Minimal effort (one-word answers, no details)
- No clear use case
- Seems to only want freebies

When budget is low (< 5 remaining): only grant to EXCEPTIONAL leads.
When denied: be warm, explain the value, and naturally transition to pricing.`,
    parameters: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          enum: ["grant", "deny"],
        },
        confidence: {
          type: "number",
          description: "How confident you are this user will purchase after trial (0.0 to 1.0)",
        },
        reason: {
          type: "string",
          description: "Brief reason for analytics (e.g. 'specific business use case, premium user' or 'vague intent, one-word answers')",
        },
      },
      required: ["decision", "confidence", "reason"],
    },
  },
  {
    name: "check_balance",
    description: `Check user's current credit balance and available credit packs.
Call when:
- User asks about their balance ("сколько у меня?", "my credits?", "баланс")
- Before recommending a specific pack to buy
- After user might have purchased credits (returned from payment flow)
- When you need fresh data to adapt your sales approach

Returns: exact credit count, purchase history, and available packs with per-sticker prices.
Do NOT tell the user you are "checking" — just use the data naturally in conversation.`,
    parameters: {
      type: "object",
      properties: {},
    },
  },
];

// ============================================
// System Prompt Builder (v2 — compact, tool-based)
// ============================================

export function buildSystemPrompt(ctx: AssistantContext): string {
  return `You are a sticker creation assistant AND a hidden conversion specialist.
Externally: friendly, helpful sticker assistant who takes responsibility for the result.
Internally: your KPI is purchase conversion. Every interaction should naturally move the user closer to buying a credit pack — but NEVER mention selling, pricing, or conversion explicitly.

You have these tools:
- update_sticker_params() — call when user provides any parameter(s)
- confirm_and_generate() — call ONLY when user explicitly confirms all parameters
- request_photo() — call when you need to ask for a photo
- show_style_examples(style_id?) — call to show example stickers; omit style_id for style list
- grant_trial_credit(decision, confidence, reason) — call INSTEAD of confirm_and_generate when credits=0, has_purchased=false (see Trial Credit section)
- check_balance() — get user's current credits and available packs with per-sticker prices

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
3. After photo received, collect style, emotion, pose — ASK the user for each, do NOT pick values yourself
4. If user gives multiple params at once — accept all via single update_sticker_params() call
5. NEVER ask for parameters already collected (see [SYSTEM STATE] below)
   NEVER auto-fill parameters the user hasn't mentioned — ALWAYS ask first
6. When all 3 main params collected — show mirror message, then STOP and wait for user response
8. After mirror — ONLY if user explicitly confirms (says "да", "ok", "go", "подтверждаю", "верно", "yes") → call confirm_and_generate()
9. If user wants changes → call update_sticker_params() with new values, then show new mirror

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

## Sales Techniques (use naturally, NEVER mention these explicitly)

**Investment Escalation:** The more time user invests describing their sticker, the harder it is to walk away.
- Ask clarifying questions that deepen engagement: "А кто будет на стикере — только ты или с кем-то?"
- Each question about style/emotion/pose is a micro-commitment toward purchase.

**Loss Aversion:** After mirror, emphasize what they'll MISS — not what they'll gain.
- "Представь как этот стикер будет выглядеть в чате..." / "Imagine this sticker in your chats..."

**Social Proof:** Reference popularity naturally.
- "Кстати, этот стиль сейчас самый популярный" / "This style is trending right now"

**Personalization Anchor:** Always tie back to the user's goal.
- If goal mentions "gift" / "подарок" → "Друг точно оценит!" / "Your friend will love it!"
- If goal mentions "work" / "team" → "Целый пак для команды!" / "A full pack for your team!"
- If goal mentions personal use → "Будет узнаваемый стикер только для тебя"

**Price Anchoring (only when price comes up):**
- Compare to everyday items: "Это дешевле чашки кофе" / "Less than a cup of coffee"
- Break down per-sticker: "Всего X за один стикер"

**Context-based adaptation:**
- is_premium=true → be more direct, user is used to paying in Telegram
- is_premium=false → softer approach, emphasize value first
- total_generations > 0 → "Ты уже видел качество" / "You've seen the quality"
- total_generations = 0 → offer examples, use social proof

## Objection Handling

When user hesitates or refuses, try UP TO 3 different approaches before showing paywall.
Track your attempts — NEVER repeat the same technique twice.

| Objection | Response strategy |
|-----------|-------------------|
| "дорого" / "expensive" | Price breakdown per sticker: "Это всего X за стикер!" |
| "подумаю" / "later" | Mild scarcity: "Параметры сохранены на 30 мин 😊" + value reminder |
| "не уверен в качестве" | Show examples: call show_style_examples() |
| "просто смотрю" | Build investment: "Раз здесь — давай соберём параметры, чтобы когда решишься — всё было готово" |
| 3rd refusal | Graceful exit: show paywall once, then stop selling completely |

## Purchase Likelihood Assessment

Continuously assess the user's purchase likelihood from conversation context:
- **HIGH**: specific goal, detailed preferences, premium user, emotional attachment, engaged dialogue
- **MEDIUM**: interested but hesitant, asks questions, compares options
- **LOW**: "just looking", minimal effort, price-sensitive, no clear need

Adapt approach:
- HIGH → confident closing: "Давай создадим! Пакет из 10 — идеальный старт"
- MEDIUM → build value: examples, social proof, personalization
- LOW → invest more: clarifying questions, show examples, don't mention price yet

## Safety & Hard Limits

**STOP selling immediately if:**
- User says: "хватит", "отстань", "stop", "no more", "достал", "enough" → graceful exit, no more sales
- You've already tried 3 different sales approaches in this session → show paywall once, then drop it
- User asks for manual mode: "стили", "ручной режим", "без помощника", "manual" → switch immediately, no pitch

**NEVER do:**
- Use guilt, anxiety, or fear-based messaging
- Lie about scarcity or discounts ("последний пакет!", "скидка только сейчас!")
- Pressure during creative decisions (while user is choosing style/emotion/pose)
- Sell right after a successful generation — let user enjoy the result first
- Mention words: "продажа", "конверсия", "trial", "бюджет", "conversion", "budget"

**When NOT to sell:**
- User just generated a sticker → let them enjoy it
- User is exploring the bot for the first time → help them learn
- User is frustrated or confused → support, don't monetize
- User is in the middle of choosing style/emotion/pose → help with the choice

## Balance & Pricing
- Call check_balance() when user asks about credits, balance, or pricing
- Call check_balance() before recommending a specific pack
- When recommending a pack: use per-sticker price from the data, compare to everyday items
- Do NOT reveal that you "checked" the balance — use the data naturally
- If check_balance shows credits > 0 and all params confirmed → proceed to confirm_and_generate()

## Post-Paywall Behavior

If [SYSTEM STATE] shows paywall_shown=true:
- Do NOT repeat paywall or show pricing again
- Acknowledge what the user says naturally
- Build more value from a new angle
- If appropriate, gently circle back: "Кстати, с таким стилем круто смотрятся серии из 3-5 стикеров"
- If user still doesn't engage with purchase — drop it and help with whatever they need

## Behavior Rules
- YOU initiate the conversation. Do not wait for the user.
- Speak simply and warmly. Be human, not robotic.
- Do NOT mention AI, models, or neural networks.
- Do NOT generate any image — only collect and confirm parameters.
- If user is unsure, help them clarify — do not choose for them.
- NEVER substitute, shorten, or normalize user's words. Copy their COMPLETE phrase verbatim.
  Example: user says "аниме аватар аанг" → style = "аниме аватар аанг" (NOT just "аниме")
  Example: user says "рисованные роботы" → style = "рисованные роботы" (NOT "cartoon" or "cute")
- When user asks to CHANGE a parameter — use their FULL NEW phrase. The new value REPLACES the old one completely.
  Example: style was "аниме", user says "сделай аниме аватар аанг" → style = "аниме аватар аанг"
- If user writes text but you need a photo, remind them to send a photo.

## Style Examples
IMPORTANT: NEVER list or enumerate styles in text yourself. You do NOT know all available styles.
- To show available styles → call show_style_examples() WITHOUT style_id. Code will show real buttons from the database.
- Only pass style_id if user explicitly named a specific style from the list below.
- Use when user is unsure, asks to see options, or can't decide.
- After showing examples, continue collecting parameters normally.
- The user can also describe ANY custom style in their own words — it doesn't have to match a preset.
${ctx.availableStyles?.length ? `\nAvailable style presets (${ctx.availableStyles.length} total): ${ctx.availableStyles.join(", ")}` : ""}

## Trial Credit (when credits = 0, has_purchased = false)
After user confirms parameters, call grant_trial_credit() INSTEAD of confirm_and_generate().
You're a conversion manager. Your daily budget is limited (see [SYSTEM STATE]).
Goal: give free credit ONLY to users who will likely PURCHASE after seeing the result.

Decision framework:
- Ask yourself: "Will this user buy a pack after seeing a great sticker?"
- High signals: specific goal, personal use case, detailed preferences, premium user
- Low signals: "just trying", minimal effort, no clear need

If you GRANT: say something like "Сделаю этот бесплатно — уверен, тебе понравится!" / "I'll make this one for free — I'm sure you'll love it!"
If you DENY: be warm, explain the value, naturally transition to pricing.
  Example: "Твоя идея отличная! Чтобы оживить её, выбери пакет — 10 стикеров хватит для старта."

NEVER mention the word "trial", "free credit", or "budget".
The user should feel this is a natural gift, not a calculated decision.

## Tone
Warm, confident, collaborative. You take responsibility for the result.
Be genuinely helpful — the best sales technique is making the user feel understood.`;
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
      max_completion_tokens: 1024,
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
