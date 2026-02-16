import express from "express";
import { Telegraf, Markup } from "telegraf";
import axios from "axios";
import sharp from "sharp";
import { config } from "./config";
import { supabase } from "./lib/supabase";
import { getText } from "./lib/texts";
import { sendAlert, sendNotification } from "./lib/alerts";
import { getFilePath, downloadFile, sendSticker } from "./lib/telegram";
import { addWhiteBorder, addTextToSticker } from "./lib/image-utils";
import { getAppConfig } from "./lib/app-config";
import {
  buildSystemPrompt,
  callAIChat,
  type AssistantMessage,
  type AssistantContext,
} from "./lib/ai-chat";
import {
  createAssistantSession,
  getActiveAssistantSession,
  updateAssistantSession,
  closeAssistantSession,
  closeAllActiveAssistantSessions,
  handleToolCall,
  buildStateInjection,
  allParamsCollected,
  getAssistantParams,
  expireOldAssistantSessions,
  getLastGoalForUser,
  getRecentAssistantSession,
  reactivateAssistantSession,
  type AssistantSessionRow,
} from "./lib/assistant-db";

const bot = new Telegraf(config.telegramBotToken, {
  handlerTimeout: 180_000, // 3 min — pack ideas generation with GPT-4o vision can be slow
});

// Global error handler — catch all unhandled errors from handlers
bot.catch((err: any, ctx: any) => {
  console.error("=== BOT UNHANDLED ERROR ===");
  console.error("Update type:", ctx?.updateType);
  console.error("Error:", err?.message || err);
  if (err?.stack) console.error("Stack:", err.stack.split("\n").slice(0, 5).join("\n"));
  console.error("=== END ERROR ===");
});

// Map: adminTelegramId → pending reply info (for admin replying to outreach)
const pendingAdminReplies = new Map<number, {
  outreachId: string;
  userTelegramId: number;
  username: string;
}>();

const app = express();
app.use(express.json({ limit: "10mb" }));

// Cache for agent data (refreshed every 5 minutes)
let agentCache: { data: any; timestamp: number } | null = null;
const AGENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache for style presets
let stylePresetsCache: { data: any[]; timestamp: number } | null = null;
const STYLE_PRESETS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache for emotion presets
let emotionPresetsCache: { data: any[]; timestamp: number } | null = null;
const EMOTION_PRESETS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache for motion presets
let motionPresetsCache: { data: any[]; timestamp: number } | null = null;
const MOTION_PRESETS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache for prompt templates
let promptTemplatesCache: { data: Map<string, string>; timestamp: number } | null = null;
const PROMPT_TEMPLATES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function safeAnswerCbQuery(ctx: any, payload?: any) {
  if (typeof ctx?.answerCbQuery !== "function") return;
  ctx.answerCbQuery(payload).catch((err: any) => {
    console.warn("answerCbQuery failed:", err?.description || err?.message || err);
  });
}

interface StylePreset {
  id: string;
  name_ru: string;
  name_en: string;
  prompt_hint: string;
  emoji: string;
  sort_order: number;
  is_active: boolean;
}

interface EmotionPreset {
  id: string;
  name_ru: string;
  name_en: string;
  prompt_hint: string;
  emoji: string;
  sort_order: number;
  is_active: boolean;
}

interface MotionPreset {
  id: string;
  name_ru: string;
  name_en: string;
  prompt_hint: string;
  emoji: string;
  sort_order: number;
  is_active: boolean;
}

async function getStylePresets(): Promise<StylePreset[]> {
  const now = Date.now();
  if (stylePresetsCache && now - stylePresetsCache.timestamp < STYLE_PRESETS_CACHE_TTL) {
    return stylePresetsCache.data;
  }

  const { data } = await supabase
    .from("style_presets")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");

  if (data) {
    stylePresetsCache = { data, timestamp: now };
  }
  return data || [];
}

// Style examples helpers
interface StyleExample {
  telegram_file_id: string;
  style_preset_id: string;
}

async function getStyleExample(styleId: string, offset: number = 0): Promise<StyleExample | null> {
  const { data } = await supabase
    .from("stickers")
    .select("telegram_file_id, style_preset_id")
    .eq("style_preset_id", styleId)
    .eq("is_example", true)
    .eq("env", config.appEnv)
    .not("telegram_file_id", "is", null)
    .order("created_at", { ascending: false })
    .range(offset, offset)
    .maybeSingle();
  
  return data;
}

async function countStyleExamples(styleId: string): Promise<number> {
  const { count } = await supabase
    .from("stickers")
    .select("id", { count: "exact", head: true })
    .eq("style_preset_id", styleId)
    .eq("is_example", true)
    .eq("env", config.appEnv)
    .not("telegram_file_id", "is", null);
  
  return count || 0;
}


// ============================================
// Style presets (flat list from style_presets_v2)
// ============================================

interface StylePresetV2 {
  id: string;
  group_id: string;
  emoji: string;
  name_ru: string;
  name_en: string;
  prompt_hint: string;
  description_ru: string | null;
  sort_order: number;
  is_active: boolean;
  show_in_onboarding: boolean;
  is_default?: boolean;
}

interface HolidayTheme {
  id: string;
  emoji: string;
  name_ru: string;
  name_en: string;
  prompt_modifier: string;
  is_active: boolean;
  sort_order: number;
}

// Cache for style_presets_v2
let stylePresetsV2Cache: { data: StylePresetV2[]; timestamp: number } | null = null;
const STYLE_PRESETS_V2_CACHE_TTL = 5 * 60 * 1000;

async function getStylePresetsV2(groupId?: string): Promise<StylePresetV2[]> {
  const now = Date.now();
  if (stylePresetsV2Cache && now - stylePresetsV2Cache.timestamp < STYLE_PRESETS_V2_CACHE_TTL) {
    const cached = stylePresetsV2Cache.data;
    return groupId ? cached.filter(p => p.group_id === groupId) : cached;
  }

  const { data } = await supabase
    .from("style_presets_v2")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");

  if (data) {
    stylePresetsV2Cache = { data, timestamp: now };
  }
  const result = data || [];
  return groupId ? result.filter(p => p.group_id === groupId) : result;
}

async function getStylePresetV2ById(id: string): Promise<StylePresetV2 | null> {
  const presets = await getStylePresetsV2();
  return presets.find(p => p.id === id) || null;
}

// Pick style for ideas: user's last style > default > random
async function pickStyleForIdeas(user: any): Promise<StylePresetV2> {
  const allPresets = await getStylePresetsV2();
  const active = allPresets.filter(p => p.is_active);

  // 1. User's last style
  if (user.last_style_id) {
    const last = active.find(p => p.id === user.last_style_id);
    if (last) {
      console.log("[pickStyleForIdeas] Using last style:", last.id, last.name_en);
      return last;
    }
  }

  // 2. Default style from DB
  console.log("[pickStyleForIdeas] Checking is_default. Sample:", active.slice(0, 3).map(p => ({ id: p.id, is_default: (p as any).is_default })));
  const def = active.find(p => (p as any).is_default);
  if (def) {
    console.log("[pickStyleForIdeas] Using default style:", def.id, def.name_en);
    return def;
  }

  // 3. Random fallback
  const rand = active[Math.floor(Math.random() * active.length)];
  console.log("[pickStyleForIdeas] Using random style:", rand.id, rand.name_en);
  return rand;
}

// Get first active holiday theme
async function getActiveHoliday(): Promise<HolidayTheme | null> {
  const { data, error } = await supabase
    .from("holiday_themes")
    .select("*")
    .eq("is_active", true)
    .order("sort_order")
    .limit(1)
    .maybeSingle();
  if (error) console.error("[getActiveHoliday] error:", error.message);
  console.log("[getActiveHoliday] result:", data?.id || "none", "is_active:", data?.is_active);
  return data;
}

async function sendStyleKeyboardFlat(
  ctx: any,
  lang: string,
  messageId?: number,
  options?: {
    includeCustom?: boolean;
    extraButtons?: any[][];
    headerText?: string;
    selectedStyleId?: string | null;
  }
) {
  const allPresets = await getStylePresetsV2();
  const customText = await getText(lang, "btn.custom_style");
  const includeCustom = options?.includeCustom !== false;

  // 3 styles per row (unified layout with ideas flow)
  const buttons: any[][] = [];
  for (let i = 0; i < allPresets.length; i += 3) {
    const row: any[] = [];
    for (let j = i; j < Math.min(i + 3, allPresets.length); j++) {
      const isSelected = options?.selectedStyleId && options.selectedStyleId === allPresets[j].id;
      row.push({
        text: `${isSelected ? "✅ " : ""}${allPresets[j].emoji} ${lang === "ru" ? allPresets[j].name_ru : allPresets[j].name_en}`,
        callback_data: `style_preview:${allPresets[j].id}`,
      });
    }
    buttons.push(row);
  }

  // Custom style button
  if (includeCustom) {
    buttons.push([{ text: customText, callback_data: "style_custom_v2" }]);
  }
  if (options?.extraButtons?.length) {
    buttons.push(...options.extraButtons);
  }

  const text = options?.headerText || await getText(lang, "photo.ask_style");

  if (messageId) {
    await ctx.telegram.editMessageText(
      ctx.chat?.id,
      messageId,
      undefined,
      text,
      { reply_markup: { inline_keyboard: buttons } }
    ).catch((err: any) => console.error("sendStyleKeyboardFlat error:", err?.message));
  } else {
    await ctx.reply(text, Markup.inlineKeyboard(buttons));
  }
}

/**
 * Get a sticker telegram_file_id for a style (for carousel preview).
 * Filtered by env so file_ids work only for the current bot.
 * Tries is_example first, then any sticker.
 */
async function getStyleStickerFileId(styleId: string): Promise<string | null> {
  // Try is_example first
  const { data: exData } = await supabase
    .from("stickers")
    .select("telegram_file_id")
    .eq("style_preset_id", styleId)
    .eq("is_example", true)
    .eq("env", config.appEnv)
    .not("telegram_file_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (exData?.telegram_file_id) return exData.telegram_file_id;

  // Fallback: any sticker for this style in same env
  const { data: anyData } = await supabase
    .from("stickers")
    .select("telegram_file_id")
    .eq("style_preset_id", styleId)
    .eq("env", config.appEnv)
    .not("telegram_file_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return anyData?.telegram_file_id || null;
}

/** Pack flow: get pack example image file_id for style (from style_presets_v2.pack_example_file_id). */
async function getPackStyleExampleFileId(styleId: string): Promise<string | null> {
  const { data } = await supabase
    .from("style_presets_v2")
    .select("pack_example_file_id")
    .eq("id", styleId)
    .not("pack_example_file_id", "is", null)
    .maybeSingle();
  return data?.pack_example_file_id || null;
}

/**
 * Style carousel: show 2 styles at a time with sticker examples.
 * Sends stickers (if available) + 1 text message with names and buttons.
 */
async function sendStyleCarousel(ctx: any, lang: string, page: number = 0): Promise<void> {
  const allPresets = await getStylePresetsV2();
  const isRu = lang === "ru";
  const PAGE_SIZE = 2;

  if (allPresets.length === 0) {
    await sendStyleKeyboardFlat(ctx, lang);
    return;
  }

  const totalPages = Math.ceil(allPresets.length / PAGE_SIZE);
  const safePage = page % totalPages; // cyclic
  const startIdx = safePage * PAGE_SIZE;
  const pagePresets = allPresets.slice(startIdx, startIdx + PAGE_SIZE);

  // Send sticker examples for each style on the page (via telegram_file_id)
  const stickerMsgIds: number[] = [];
  for (const preset of pagePresets) {
    try {
      const fileId = await getStyleStickerFileId(preset.id);
      if (fileId) {
        const msg = await ctx.replyWithSticker(fileId);
        stickerMsgIds.push(msg.message_id);
      }
    } catch (err: any) {
      console.error("[StyleCarousel] Failed to send sticker:", preset.id, err.message);
    }
  }

  // Build text with style names
  const nameLines = pagePresets.map((preset, i) => {
    const num = i === 0 ? "1️⃣" : "2️⃣";
    const name = isRu ? preset.name_ru : preset.name_en;
    return `${num} ${preset.emoji} ${name}`;
  });

  const headerText = isRu ? "Выбери стиль:" : "Choose a style:";
  const text = `${headerText}\n\n${nameLines.join("\n")}`;

  // Build buttons
  const selectButtons = pagePresets.map((preset, i) => {
    const num = i === 0 ? "1️⃣" : "2️⃣";
    const label = isRu ? "Выбрать" : "Select";
    return { text: `${num} ${label}`, callback_data: `style_preview:${preset.id}` };
  });

  const prevPage = (safePage - 1 + totalPages) % totalPages;
  const nextPage = (safePage + 1) % totalPages;

  const navButtons: any[] = [
    { text: "⬅️", callback_data: `style_carousel_next:${prevPage}:${stickerMsgIds.join(",")}` },
    { text: `${safePage + 1}/${totalPages}`, callback_data: "noop" },
    { text: "➡️", callback_data: `style_carousel_next:${nextPage}:${stickerMsgIds.join(",")}` },
  ];

  const keyboard = [selectButtons, navButtons];

  const textMsg = await ctx.reply(text, { reply_markup: { inline_keyboard: keyboard } });

  console.log("[StyleCarousel] Page:", safePage, "styles:", pagePresets.map((p: StylePresetV2) => p.id).join(","), "stickerMsgs:", stickerMsgIds, "textMsg:", textMsg.message_id);
}

/**
 * Send style keyboard for assistant's "show examples" — same layout as sendStyleKeyboardFlat
 * but clicking a STYLE returns the choice to the assistant (not manual mode).
 * Clicking opens a style preview with sticker + description, then assistant_pick_style on OK.
 */
async function sendStyleExamplesKeyboard(ctx: any, lang: string, selectedStyleId?: string | null) {
  const allPresets = await getStylePresetsV2();
  const isRu = lang === "ru";

  // 3 styles per row (unified layout)
  const buttons: any[][] = [];
  for (let i = 0; i < allPresets.length; i += 3) {
    const row: any[] = [];
    for (let j = i; j < Math.min(i + 3, allPresets.length); j++) {
      const isSelected = selectedStyleId && selectedStyleId === allPresets[j].id;
      row.push(Markup.button.callback(
        `${isSelected ? "✅ " : ""}${allPresets[j].emoji} ${isRu ? allPresets[j].name_ru : allPresets[j].name_en}`,
        `assistant_style_preview:${allPresets[j].id}`
      ));
    }
    buttons.push(row);
  }

  const header = isRu
    ? "🎨 Выбери стиль:"
    : "🎨 Choose a style:";

  await ctx.reply(header, Markup.inlineKeyboard(buttons));
}

async function getEmotionPresets(): Promise<EmotionPreset[]> {
  const now = Date.now();
  if (emotionPresetsCache && now - emotionPresetsCache.timestamp < EMOTION_PRESETS_CACHE_TTL) {
    return emotionPresetsCache.data;
  }

  const { data } = await supabase
    .from("emotion_presets")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");

  if (data) {
    emotionPresetsCache = { data, timestamp: now };
  }
  return data || [];
}

async function sendEmotionKeyboard(ctx: any, lang: string) {
  const presets = await getEmotionPresets();

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < presets.length; i += 2) {
    const row: ReturnType<typeof Markup.button.callback>[] = [];
    row.push(
      Markup.button.callback(
        `${presets[i].emoji} ${lang === "ru" ? presets[i].name_ru : presets[i].name_en}`,
        `emotion_${presets[i].id}`
      )
    );
    if (presets[i + 1]) {
      row.push(
        Markup.button.callback(
          `${presets[i + 1].emoji} ${lang === "ru" ? presets[i + 1].name_ru : presets[i + 1].name_en}`,
          `emotion_${presets[i + 1].id}`
        )
      );
    }
    buttons.push(row);
  }

  await ctx.reply(
    await getText(lang, "emotion.choose"),
    Markup.inlineKeyboard(buttons)
  );
}

async function getMotionPresets(): Promise<MotionPreset[]> {
  const now = Date.now();
  if (motionPresetsCache && now - motionPresetsCache.timestamp < MOTION_PRESETS_CACHE_TTL) {
    return motionPresetsCache.data;
  }

  const { data } = await supabase
    .from("motion_presets")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");

  if (data) {
    motionPresetsCache = { data, timestamp: now };
  }
  return data || [];
}

async function sendMotionKeyboard(ctx: any, lang: string) {
  const presets = await getMotionPresets();

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < presets.length; i += 2) {
    const row: ReturnType<typeof Markup.button.callback>[] = [];
    row.push(
      Markup.button.callback(
        `${presets[i].emoji} ${lang === "ru" ? presets[i].name_ru : presets[i].name_en}`,
        `motion_${presets[i].id}`
      )
    );
    if (presets[i + 1]) {
      row.push(
        Markup.button.callback(
          `${presets[i + 1].emoji} ${lang === "ru" ? presets[i + 1].name_ru : presets[i + 1].name_en}`,
          `motion_${presets[i + 1].id}`
        )
      );
    }
    buttons.push(row);
  }

  await ctx.reply(
    await getText(lang, "motion.choose"),
    Markup.inlineKeyboard(buttons)
  );
}

async function getPromptTemplate(id: string): Promise<string> {
  const now = Date.now();
  
  if (promptTemplatesCache && now - promptTemplatesCache.timestamp < PROMPT_TEMPLATES_CACHE_TTL) {
    return promptTemplatesCache.data.get(id) || "";
  }
  
  const { data } = await supabase
    .from("prompt_templates")
    .select("id, template");
  
  if (data) {
    const map = new Map<string, string>();
    for (const row of data) {
      map.set(row.id, row.template);
    }
    promptTemplatesCache = { data: map, timestamp: now };
    return map.get(id) || "";
  }
  
  return "";
}

function buildPromptFromTemplate(template: string, input: string): string {
  return template.replace(/{input}/g, input);
}

async function getAgent(name: string) {
  const now = Date.now();
  if (agentCache && agentCache.data?.name === name && now - agentCache.timestamp < AGENT_CACHE_TTL) {
    return agentCache.data;
  }

  const { data } = await supabase
    .from("agents")
    .select("*")
    .eq("name", name)
    .eq("is_active", true)
    .maybeSingle();

  if (data) {
    agentCache = { data, timestamp: now };
  }
  return data;
}

let botUsernameCache: string | null = config.botUsername || null;
async function getBotUsername(): Promise<string> {
  if (botUsernameCache) return botUsernameCache;
  const me = await bot.telegram.getMe();
  botUsernameCache = me.username || "bot";
  return botUsernameCache;
}

// Generate prompt using LLM
interface PromptResult {
  ok: boolean;
  prompt?: string | null;
  retry?: boolean;
}

async function generatePrompt(userInput: string): Promise<PromptResult> {
  try {
    const agent = await getAgent("prompt_generator");
    if (!agent) {
      console.error("Agent 'prompt_generator' not found in database");
      // Fallback: return user input as-is
      return { ok: true, prompt: userInput, retry: false };
    }

    const fewShotExamples = agent.few_shot_examples || [];
    
    // Build messages for Gemini
    const contents: any[] = [];
    
    // Add few-shot examples as conversation history
    for (const example of fewShotExamples) {
      contents.push({
        role: "user",
        parts: [{ text: example.human }],
      });
      contents.push({
        role: "model",
        parts: [{ text: example.ai }],
      });
    }
    
    // Add current user input
    contents.push({
      role: "user",
      parts: [{ text: userInput }],
    });

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${agent.model}:generateContent`,
      {
        systemInstruction: {
          parts: [{ text: agent.system_prompt }],
        },
        contents,
        generationConfig: {
          responseMimeType: "application/json",
        },
      },
      {
        headers: { "x-goog-api-key": config.geminiApiKey },
      }
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error("Gemini returned no text");
      return { ok: true, prompt: userInput, retry: false }; // Fallback
    }

    const parsed = JSON.parse(text);
    return {
      ok: parsed.ok === true,
      prompt: parsed.prompt,
      retry: parsed.retry === true,
    };
  } catch (err: any) {
    console.error("generatePrompt error:", err.response?.data || err.message);
    // Fallback: return user input as-is
    return { ok: true, prompt: userInput, retry: false };
  }
}

async function enqueueJob(sessionId: string, userId: string, isFirstFree: boolean = false) {
  await supabase.from("jobs").insert({
    session_id: sessionId,
    user_id: userId,
    status: "queued",
    attempts: 0,
    is_first_free: isFirstFree,
    env: config.appEnv,
  });
}

async function sendProgressStart(ctx: any, sessionId: string, lang: string) {
  const msg = await ctx.reply(await getText(lang, "progress.step1"));
  if (msg?.message_id && ctx.chat?.id) {
    await supabase
      .from("sessions")
      .update({ progress_message_id: msg.message_id, progress_chat_id: ctx.chat.id })
      .eq("id", sessionId);
  }
}

// Shared composition/background rules — same for single sticker and pack (unified prompt flow)
const COMPOSITION_SUFFIX = `\n\nCRITICAL COMPOSITION AND BACKGROUND RULES:\n1. Background MUST be flat uniform BRIGHT MAGENTA (#FF00FF). This exact color is required for automated background removal. No other background colors allowed.\n2. The COMPLETE character (including all limbs, hands, fingers, elbows, hair) must be fully visible with nothing cropped by image edges.\n3. Leave at least 15% empty space on EVERY side of the character.\n4. If the pose has extended arms or wide gestures — zoom out to include them fully. Better to make the character slightly smaller than to crop any body part.\n5. Do NOT add any border, outline, stroke, or contour around the character. Clean raw edges only.`;

async function startGeneration(
  ctx: any,
  user: any,
  session: any,
  lang: string,
  options: {
    generationType: "style" | "emotion" | "motion" | "text";
    promptFinal: string;
    userInput?: string | null;
    emotionPrompt?: string | null;
    selectedStyleId?: string | null;
    selectedEmotion?: string | null;
    textPrompt?: string | null;
    assistantParams?: { style: string; emotion: string; pose: string } | null;
  }
) {
  const creditsNeeded = 1;

  options.promptFinal = options.promptFinal + COMPOSITION_SUFFIX;

  console.log("=== startGeneration ===");
  console.log("user.id:", user?.id);
  console.log("user.credits:", user?.credits, "type:", typeof user?.credits);
  console.log("user.has_purchased:", user.has_purchased);
  console.log("user.onboarding_step:", user.onboarding_step);
  console.log("generationType:", options.generationType);
  console.log("creditsNeeded:", creditsNeeded);

  // Check if user has enough credits
  if (user.credits < creditsNeeded) {
    // Paywall for users who haven't purchased yet
    const isPaywall = !user.has_purchased;
    
    sendAlert({
      type: isPaywall ? "paywall_shown" : "not_enough_credits",
      message: isPaywall ? "Paywall shown to new user" : "Not enough credits!",
      details: {
        user: `@${user.username || user.telegram_id}`,
        sessionId: session.id,
        generationType: options.generationType,
        styleGroup: session.selected_style_group || "-",
        styleId: options.selectedStyleId || "-",
        credits: user.credits,
        needed: creditsNeeded,
        hasPurchased: user.has_purchased,
      },
    }).then(() => {
      // Send discount buttons for admin (only for paywall — new users)
      if (isPaywall && config.alertChannelId) {
        const tid = user.telegram_id;
        const uname = user.username || tid;
        fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: config.alertChannelId,
            text: `💸 Отправить скидку @${uname}?`,
            reply_markup: {
              inline_keyboard: [[
                { text: "🔥 -10%", callback_data: `admin_discount:${tid}:10` },
                { text: "🔥 -15%", callback_data: `admin_discount:${tid}:15` },
                { text: "🔥 -25%", callback_data: `admin_discount:${tid}:25` },
              ]],
            },
          }),
        }).catch(err => console.error("[Discount buttons] Error:", err));
      }
    }).catch(console.error);

    const targetState = isPaywall ? "wait_first_purchase" : "wait_buy_credit";
    console.log("[startGeneration] Setting paywall state:", targetState, "sessionId:", session.id);
    const { error: paywallUpdateErr } = await supabase
      .from("sessions")
      .update({
        state: targetState,
        pending_generation_type: options.generationType,
        user_input: options.userInput || session.user_input || null,
        prompt_final: options.promptFinal,
        emotion_prompt: options.emotionPrompt || null,
        selected_style_id: options.selectedStyleId || session.selected_style_id || null,
        selected_emotion: options.selectedEmotion || null,
        credits_spent: creditsNeeded,
        is_active: true,
      })
      .eq("id", session.id);
    if (paywallUpdateErr) {
      console.error("[startGeneration] Paywall state update FAILED:", paywallUpdateErr.message);
    } else {
      console.log("[startGeneration] Paywall state update OK");
    }

    if (isPaywall) {
      // Show paywall message with bonus info
      await ctx.reply(await getText(lang, "paywall.message"));
    } else {
      await ctx.reply(await getText(lang, "photo.not_enough_credits", {
        needed: creditsNeeded,
        balance: user.credits,
      }));
    }
    await sendBuyCreditsMenu(ctx, user);

    // Mark paywall on assistant session (if active) for post-paywall sales behavior
    if (session.state?.startsWith("assistant_") || options.selectedStyleId === "assistant") {
      const aSession = await getActiveAssistantSession(user.id);
      if (aSession && !aSession.paywall_shown) {
        await updateAssistantSession(aSession.id, {
          paywall_shown: true,
          paywall_shown_at: new Date().toISOString(),
          sales_attempts: (aSession.sales_attempts || 0) + 1,
        });
      }
    }
    return;
  }

  // Deduct credits atomically (prevents race condition)
  const { data: deducted, error: deductError } = await supabase
    .rpc("deduct_credits", { p_user_id: user.id, p_amount: creditsNeeded });
  
  if (deductError || !deducted) {
    console.error("Atomic deduct failed - race condition detected:", deductError?.message || "not enough credits");
    await ctx.reply(await getText(lang, "photo.not_enough_credits", {
      needed: creditsNeeded,
      balance: 0,
    }));
    await sendBuyCreditsMenu(ctx, user);
    return;
  }

  // Increment total_generations
  await supabase.rpc("increment_generations", { p_user_id: user.id });

  const nextState = 
    options.generationType === "emotion" ? "processing_emotion" :
    options.generationType === "motion" ? "processing_motion" :
    options.generationType === "text" ? "processing_text" : "processing";

  await supabase
    .from("sessions")
    .update({
      user_input: options.userInput || session.user_input || null,
      prompt_final: options.promptFinal,
      emotion_prompt: options.emotionPrompt || null,
      selected_style_id: options.selectedStyleId || session.selected_style_id || null,
      selected_emotion: options.selectedEmotion || null,
      text_prompt: options.textPrompt || null,
      generation_type: options.generationType,
      credits_spent: creditsNeeded,
      state: nextState,
      is_active: true,
    })
    .eq("id", session.id);

  await enqueueJob(session.id, user.id, false);

  // Alert: generation started with all parameters
  const isAssistant = !!options.assistantParams;
  const mode = isAssistant ? "🤖 assistant" : "✋ manual";
  const goal = (() => {
    if (isAssistant) {
      const ap = options.assistantParams!;
      return `${ap.style} / ${ap.emotion} / ${ap.pose}`;
    }
    switch (options.generationType) {
      case "style": return `Стикер в стиле: ${options.selectedStyleId || options.userInput || "custom"}`;
      case "emotion": return `Эмоция: ${options.emotionPrompt || "?"}`;
      case "motion": return `Движение: ${options.emotionPrompt || "?"}`;
      case "text": return `Текст: ${options.textPrompt || "?"}`;
      default: return options.generationType;
    }
  })();

  const alertDetails: Record<string, any> = {
    mode,
    user: `@${user.username || user.telegram_id}`,
    goal,
  };

  if (isAssistant) {
    const ap = options.assistantParams!;
    alertDetails.style = ap.style;
    alertDetails.emotion = ap.emotion;
    alertDetails.pose = ap.pose;
  } else {
    alertDetails.style = options.selectedStyleId || "-";
    alertDetails.input = options.userInput || "-";
    alertDetails.emotion = options.emotionPrompt || "-";
    alertDetails.text = options.textPrompt || "-";
  }
  alertDetails.prompt = options.promptFinal.slice(0, 200);

  sendAlert({
    type: "generation_started",
    message: "New generation",
    details: alertDetails,
  }).catch(console.error);

  await sendProgressStart(ctx, session.id, lang);
}

// Credit packages: { credits, price_in_stars, label_ru, label_en, price_rub, adminOnly?, hidden? }
const CREDIT_PACKS = [
  { credits: 1, price: 1, price_rub: 1, label_ru: "🔧 Тест", label_en: "🔧 Test", adminOnly: true },
  { credits: 2, price: 20, price_rub: 15, label_ru: "🎁 Попробовать", label_en: "🎁 Try", trialOnly: true },
  { credits: 10, price: 150, price_rub: 99, label_ru: "⭐ Старт", label_en: "⭐ Start" },
  { credits: 30, price: 300, price_rub: 249, label_ru: "💎 Поп", label_en: "💎 Pop" },
  { credits: 100, price: 700, price_rub: 699, label_ru: "👑 Про", label_en: "👑 Pro" },
  { credits: 250, price: 1500, price_rub: 1490, label_ru: "🚀 Макс", label_en: "🚀 Max" },
  // Hidden discount packs (not shown in UI, used via direct callback for promos, abandoned carts, admin discounts)
  // -10%
  { credits: 2, price: 18, price_rub: 13, label_ru: "🎁 Try -10%", label_en: "🎁 Try -10%", hidden: true },
  { credits: 10, price: 135, price_rub: 89, label_ru: "⭐ Старт -10%", label_en: "⭐ Start -10%", hidden: true },
  { credits: 30, price: 270, price_rub: 224, label_ru: "💎 Поп -10%", label_en: "💎 Pop -10%", hidden: true },
  { credits: 100, price: 630, price_rub: 629, label_ru: "👑 Про -10%", label_en: "👑 Pro -10%", hidden: true },
  { credits: 250, price: 1350, price_rub: 1341, label_ru: "🚀 Макс -10%", label_en: "🚀 Max -10%", hidden: true },
  // -15%
  { credits: 2, price: 17, price_rub: 12, label_ru: "🎁 Try -15%", label_en: "🎁 Try -15%", hidden: true },
  { credits: 10, price: 127, price_rub: 84, label_ru: "⭐ Старт -15%", label_en: "⭐ Start -15%", hidden: true },
  { credits: 30, price: 255, price_rub: 211, label_ru: "💎 Поп -15%", label_en: "💎 Pop -15%", hidden: true },
  { credits: 100, price: 595, price_rub: 594, label_ru: "👑 Про -15%", label_en: "👑 Pro -15%", hidden: true },
  { credits: 250, price: 1275, price_rub: 1267, label_ru: "🚀 Макс -15%", label_en: "🚀 Max -15%", hidden: true },
  // -25%
  { credits: 2, price: 15, price_rub: 11, label_ru: "🎁 Try -25%", label_en: "🎁 Try -25%", hidden: true },
  { credits: 10, price: 112, price_rub: 74, label_ru: "⭐ Старт -25%", label_en: "⭐ Start -25%", hidden: true },
  { credits: 30, price: 225, price_rub: 186, label_ru: "💎 Поп -25%", label_en: "💎 Pop -25%", hidden: true },
  { credits: 100, price: 525, price_rub: 524, label_ru: "👑 Про -25%", label_en: "👑 Pro -25%", hidden: true },
  { credits: 250, price: 1125, price_rub: 1117, label_ru: "🚀 Макс -25%", label_en: "🚀 Max -25%", hidden: true },
];

/**
 * Build balance info string for check_balance tool.
 * Returned as context for AI to use in conversation.
 */
function buildBalanceInfo(user: any, lang: string): string {
  const packs = CREDIT_PACKS
    .filter((p: any) => !p.adminOnly && !p.hidden)
    .map((p: any) => `• ${p.credits} credits — ${p.price}⭐ (${(p.price / p.credits).toFixed(1)}⭐/стикер) ${lang === "ru" ? p.label_ru : p.label_en}`)
    .join("\n");

  return [
    `[BALANCE]`,
    `Credits: ${user.credits || 0}`,
    `Has purchased: ${!!user.has_purchased}`,
    `Total generations: ${user.total_generations || 0}`,
    ``,
    `Available packs:`,
    packs,
  ].join("\n");
}

// Helper: get user by telegram_id
// Build standard sticker action buttons (used after generation, text overlay, border toggle)
async function buildStickerButtons(lang: string, stickerId: string) {
  const addToPackText = await getText(lang, "btn.add_to_pack");
  const changeEmotionText = await getText(lang, "btn.change_emotion");
  const changeMotionText = await getText(lang, "btn.change_motion");
  const addTextText = await getText(lang, "btn.add_text");
  const toggleBorderText = await getText(lang, "btn.toggle_border");
  const packIdeasText = lang === "ru" ? "💡 Идеи для пака" : "💡 Pack ideas";

  return {
    inline_keyboard: [
      [{ text: addToPackText, callback_data: `add_to_pack:${stickerId}` }],
      [
        { text: changeEmotionText, callback_data: `change_emotion:${stickerId}` },
        { text: changeMotionText, callback_data: `change_motion:${stickerId}` },
      ],
      [
        { text: toggleBorderText, callback_data: `toggle_border:${stickerId}` },
        { text: addTextText, callback_data: `add_text:${stickerId}` },
      ],
      [
        { text: packIdeasText, callback_data: `pack_ideas:${stickerId}` },
      ],
    ],
  };
}

async function getUser(telegramId: number) {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("env", config.appEnv)
    .maybeSingle();
  return data;
}

// Helper: get persistent menu keyboard (single row)
function getMainMenuKeyboard(lang: string) {
  const row = lang === "ru"
    ? ["🤖 1 стикер", "📦 Пак стикеров", "💰 Баланс", "❓"]
    : ["🤖 1 sticker", "📦 Sticker pack", "💰 Balance", "❓"];
  return Markup.keyboard([row]).resize().persistent();
}

// Helper: check if language is in whitelist for free credits
function isAllowedLanguage(languageCode: string): boolean {
  const code = (languageCode || "").toLowerCase();
  return config.allowedLangPrefixes.some(prefix => code.startsWith(prefix));
}

// ============================================
// AI Assistant helpers
// ============================================

/**
 * Start a new AI assistant dialog: create session, call Gemini for greeting, reply to user.
 */
async function startAssistantDialog(ctx: any, user: any, lang: string) {
  // Fetch previous goal before closing sessions (for returning users)
  const prevAssistantSession = await getActiveAssistantSession(user.id);
  let previousGoal = prevAssistantSession?.goal || null;
  // Fallback: check completed/abandoned sessions if no active one
  if (!previousGoal) {
    previousGoal = await getLastGoalForUser(user.id);
  }
  if (previousGoal) {
    // Strip analytics tags like [trial: ...] from the goal
    previousGoal = previousGoal.replace(/\s*\[trial:.*?\]/g, "").replace(/\s*\[intent:.*?\]/g, "").trim() || null;
  }
  if (previousGoal) {
    console.log("startAssistantDialog: previous goal found:", previousGoal.slice(0, 80));
  }

  // Close any active assistant sessions for this user
  await closeAllActiveAssistantSessions(user.id);

  // Cancel all active sessions
  await supabase
    .from("sessions")
    .update({ state: "canceled", is_active: false })
    .eq("user_id", user.id)
    .eq("is_active", true);

  // Create new session with assistant state
  const lastPhoto = user.last_photo_file_id || null;
  const { data: newSession, error: sessionError } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      state: lastPhoto ? "assistant_wait_idea" : "assistant_wait_photo",
      is_active: true,
      env: config.appEnv,
      current_photo_file_id: lastPhoto,
      photos: lastPhoto ? [lastPhoto] : [],
    })
    .select()
    .single();

  if (sessionError || !newSession) {
    console.error("startAssistantDialog: Failed to create session:", sessionError?.message || "no data");
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
    return;
  }

  console.log("startAssistantDialog: Session created:", newSession.id, "for user:", user.id);

  // Build context for system prompt
  const stylePresets = await getStylePresetsV2();
  const availableStyles = stylePresets.map(s => 
    `${s.emoji} ${lang === "ru" ? s.name_ru : s.name_en}`
  );

  const assistantCtx: AssistantContext = {
    firstName: ctx.from?.first_name || "User",
    languageCode: user.language_code || ctx.from?.language_code || "en",
    isPremium: ctx.from?.is_premium || false,
    totalGenerations: user.total_generations || 0,
    credits: user.credits || 0,
    hasPhoto: false,
    previousGoal,
    availableStyles,
  };

  const systemPrompt = buildSystemPrompt(assistantCtx);

  // Create assistant_sessions row
  const initMessages: AssistantMessage[] = [
    { role: "system", content: systemPrompt },
  ];
  const aSession = await createAssistantSession(user.id, newSession.id, initMessages);
  if (!aSession) {
    console.error("startAssistantDialog: Failed to create assistant_session");
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
    return;
  }

  // Template greeting — no AI call, instant response (~0.5s instead of 3-5s)
  const firstName = ctx.from?.first_name || "";
  const isReturning = previousGoal || (user.total_generations || 0) > 0;

  let greeting: string;
  if (lastPhoto) {
    // Photo already available — ideas will be shown right after greeting
    greeting = isReturning
      ? (lang === "ru"
        ? `С возвращением, ${firstName}! 👋`
        : `Welcome back, ${firstName}! 👋`)
      : (lang === "ru"
        ? `Привет, ${firstName}! 👋`
        : `Hi, ${firstName}! 👋`);
  } else {
    greeting = isReturning
      ? (lang === "ru"
        ? `С возвращением, ${firstName}! 👋\nПришли фото — сделаем новый стикер 📸`
        : `Welcome back, ${firstName}! 👋\nSend a photo — let's make a new sticker 📸`)
      : (lang === "ru"
        ? `Привет, ${firstName}! 👋\nЯ помогу превратить твоё фото в крутой стикер.\n\nПришли мне фото, из которого хочешь сделать стикер 📸`
        : `Hi, ${firstName}! 👋\nI'll help turn your photo into an awesome sticker.\n\nSend me a photo you'd like to turn into a sticker 📸`);
  }

  // Save greeting to assistant_sessions so AI has context when photo arrives
  const messages: AssistantMessage[] = [
    ...initMessages,
    { role: "assistant", content: greeting },
  ];
  await updateAssistantSession(aSession.id, { messages });

  await ctx.reply(greeting, getMainMenuKeyboard(lang));

  // If photo already exists — show sticker ideas immediately
  if (lastPhoto) {
    console.log("startAssistantDialog: lastPhoto exists, showing sticker ideas");

    // Pick style: user's last > default > random
    const pickedStyle = await pickStyleForIdeas(user);

    const loadingMsg = await ctx.reply(
      lang === "ru" ? "📸 Фото есть! Подбираю идею для стикера..." : "📸 Photo ready! Picking a sticker idea..."
    );

    // Generate first idea with photo analysis
    let idea: StickerIdea;
    let photoDescription = "";
    try {
      const result = await generateFirstIdeaWithPhoto({
        photoFileId: lastPhoto,
        stylePresetId: pickedStyle.id,
        lang,
      });
      idea = result.idea;
      photoDescription = result.photoDescription;
      console.log("[startAssistant_ideas] Got first idea:", idea.titleEn);
    } catch (err: any) {
      console.error("[startAssistant_ideas] Error:", err.message);
      idea = getDefaultIdeas(lang)[0];
    }

    // Save ideas state with photoDescription
    const ideasState = { styleId: pickedStyle.id, ideaIndex: 0, ideas: [idea], photoDescription, holidayId: null };
    const { error: ideasErr } = await supabase
      .from("sessions")
      .update({
        sticker_ideas_state: ideasState,
        state: "assistant_wait_idea",
        is_active: true,
      })
      .eq("id", newSession.id);
    if (ideasErr) console.error("[startAssistant_ideas] save error:", ideasErr.message);

    try { await ctx.deleteMessage(loadingMsg.message_id); } catch {}

    // Guard against race conditions: user may switch to another flow (e.g., pack)
    // while assistant idea generation is still running. Only check state: some DB setups
    // flip is_active to false on update, so we don't require is_active here.
    const { data: freshSession } = await supabase
      .from("sessions")
      .select("state")
      .eq("id", newSession.id)
      .maybeSingle();
    if (!String(freshSession?.state || "").startsWith("assistant_")) {
      console.log("[startAssistant_ideas] Session switched, skipping idea card for session:", newSession.id, "state:", freshSession?.state);
      return;
    }

    await showStickerIdeaCard(ctx, {
      idea,
      ideaIndex: 0,
      totalIdeas: 0, // unlimited
      style: pickedStyle,
      lang,
    });
  }
}

/**
 * Handle assistant confirmation: start generation or show paywall.
 */
async function handleAssistantConfirm(ctx: any, user: any, sessionId: string, lang: string) {
  // Get assistant session for params
  const aSession = await getActiveAssistantSession(user.id);
  if (!aSession) {
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
    return;
  }

  // Re-fetch sessions row for generation
  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (!session) {
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
    return;
  }

  const params = getAssistantParams(aSession);
  const userText = `${params.style}, ${params.emotion}, ${params.pose}`;

  // Use prompt_generator agent (same as manual flow) for consistent prompts
  const promptResult = await generatePrompt(userText);
  const promptFinal = promptResult.ok && promptResult.prompt
    ? promptResult.prompt
    : buildAssistantPrompt(params); // fallback to template if LLM fails
  console.log("[assistant] generatePrompt ok:", promptResult.ok, "used fallback:", !(promptResult.ok && promptResult.prompt));

  // Keep assistant session active so user can continue dialog after generation
  // (e.g. "not what I wanted", "change emotion", etc.)
  // Session will be closed when user starts new dialog, switches to manual, or by timeout

  // Re-fetch user for fresh credits
  const freshUser = await getUser(user.telegram_id);
  if (!freshUser) return;

  await startGeneration(ctx, freshUser, session, lang, {
    generationType: "style",
    promptFinal,
    userInput: `[assistant] style: ${params.style}, emotion: ${params.emotion}, pose: ${params.pose}`,
    selectedStyleId: "assistant",
    assistantParams: params,
  });
}

/**
 * Count trial credits granted today (global, across all users).
 */
async function getTodayTrialCreditsCount(): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from("assistant_sessions")
    .select("id", { count: "exact", head: true })
    .eq("env", config.appEnv)
    .gte("updated_at", todayStart.toISOString())
    .like("goal", "%[trial: grant%");

  return count || 0;
}

/**
 * Get system prompt with state injection for assistant session.
 * Looks for original system prompt in messages, appends current state.
 */
async function getAssistantSystemPrompt(
  messages: AssistantMessage[],
  aSession: AssistantSessionRow,
  userContext?: { credits: number; hasPurchased: boolean; totalGenerations: number; utmSource?: string | null; utmMedium?: string | null }
): Promise<string> {
  const basePrompt = messages.find(m => m.role === "system")?.content || "";

  // Get available styles for show_style_examples tool
  const presets = await getStylePresets();
  const availableStyles = presets.map(s => ({ id: s.id, name_en: s.name_en }));

  // Inject trial budget only when user qualifies (new users with <= 2 generations)
  let trialBudgetRemaining: number | undefined;
  if (userContext
    && userContext.credits === 0
    && !userContext.hasPurchased
    && userContext.totalGenerations <= 2) {
    const todayCount = await getTodayTrialCreditsCount();
    trialBudgetRemaining = Math.max(0, 20 - todayCount);
  }

  // Determine traffic source for trial credit decision
  const isPaidTraffic = userContext?.utmSource && userContext?.utmMedium === "cpc";
  const trafficSource = isPaidTraffic ? "paid" : (userContext?.utmSource || null);

  return basePrompt + buildStateInjection(aSession, { availableStyles, trialBudgetRemaining, trafficSource });
}

/**
 * Process assistant AI result: handle tool call, update session, decide what to do next.
 * Returns the action to take and whether confirm button should be shown.
 */
async function processAssistantResult(
  result: { text: string; toolCall: import("./lib/ai-chat").ToolCall | null },
  aSession: AssistantSessionRow,
  messages: AssistantMessage[],
): Promise<{ action: "confirm" | "photo" | "show_mirror" | "show_examples" | "grant_credit" | "deny_credit" | "check_balance" | "normal"; updatedSession: AssistantSessionRow }> {
  let action: "confirm" | "photo" | "show_mirror" | "show_examples" | "grant_credit" | "deny_credit" | "check_balance" | "normal" = "normal";
  let sessionUpdates: Partial<AssistantSessionRow> = {};

  if (result.toolCall) {
    console.log("[Assistant] Tool call:", result.toolCall.name, JSON.stringify(result.toolCall.args));
    const toolResult = handleToolCall(result.toolCall, aSession);
    sessionUpdates = { ...toolResult.updates };

    if (toolResult.action === "confirm") {
      // Guard: don't confirm if params are missing — LLM jumped ahead
      if (!allParamsCollected({ ...aSession, ...sessionUpdates } as AssistantSessionRow)) {
        console.warn("[Assistant] confirm_and_generate called but params incomplete! style:", aSession.style, "emotion:", aSession.emotion, "pose:", aSession.pose, "— falling back to normal");
        // Don't set action to confirm — will fall through to "normal" and ask for missing param
      } else {
        action = "confirm";
      }
    } else if (toolResult.action === "photo") {
      action = "photo";
    } else if (toolResult.action === "show_examples") {
      action = "show_examples";
    } else if (toolResult.action === "grant_credit") {
      action = "grant_credit";
    } else if (toolResult.action === "deny_credit") {
      action = "deny_credit";
    } else if (toolResult.action === "check_balance") {
      action = "check_balance";
    } else if (toolResult.action === "params") {
      // After updating params, check if all collected
      const mergedSession = { ...aSession, ...sessionUpdates } as AssistantSessionRow;
      if (allParamsCollected(mergedSession)) {
        action = "show_mirror";
      }
    }
  }

  // Save messages and updates
  console.log("[Assistant] processResult: saving, action:", action, "updates keys:", Object.keys(sessionUpdates));
  await updateAssistantSession(aSession.id, {
    messages,
    ...sessionUpdates,
    error_count: 0, // reset on success
  });
  console.log("[Assistant] processResult: saved successfully");

  // Return merged session for downstream checks
  const updatedSession = { ...aSession, ...sessionUpdates } as AssistantSessionRow;
  return { action, updatedSession };
}

/**
 * Generate a fallback reply when LLM returns only a tool call (no text).
 * This ensures the user always gets a response.
 */
function generateFallbackReply(action: string, session: AssistantSessionRow, lang: string): string {
  const isRu = lang === "ru";

  if (action === "confirm") {
    return isRu ? "Отлично! Запускаю генерацию..." : "Great! Starting generation...";
  }

  if (action === "photo") {
    return isRu
      ? "Пришли мне фото, из которого хочешь сделать стикер 📸"
      : "Send me a photo you'd like to turn into a sticker 📸";
  }

  if (action === "show_mirror") {
    return buildMirrorMessage(session, lang);
  }

  if (action === "show_examples") {
    return isRu
      ? "Нажми на стиль, чтобы увидеть пример:"
      : "Tap a style to see an example:";
  }

  if (action === "grant_credit") {
    return isRu
      ? "Отлично! Сгенерирую этот стикер для тебя — уверен, результат понравится! 🎨"
      : "Great! I'll generate this sticker for you — I'm sure you'll love it! 🎨";
  }

  if (action === "deny_credit") {
    return isRu
      ? "Твоя идея отличная! Чтобы воплотить её, выбери пакет — 10 стикеров хватит для старта:"
      : "Your idea is great! To bring it to life, choose a pack — 10 stickers is enough to start:";
  }

  if (action === "check_balance") {
    return isRu ? "Секунду..." : "One moment...";
  }

  // action === "params" or "normal" — ask for next missing param
  if (!session.style) {
    return isRu
      ? "Принял! Теперь опиши стиль стикера (например: аниме, мультяшный, минимализм)"
      : "Got it! Now describe the sticker style (e.g.: anime, cartoon, minimal)";
  }
  if (!session.emotion) {
    return isRu
      ? "Отлично! Какую эмоцию хочешь передать?"
      : "Great! What emotion should the sticker express?";
  }
  if (!session.pose) {
    return isRu
      ? "Понял! Какую позу или жест выбираешь?"
      : "Got it! What pose or gesture do you want?";
  }

  return isRu ? "Продолжаем!" : "Let's continue!";
}

/**
 * Build a mirror message showing all collected params.
 */
function buildMirrorMessage(session: AssistantSessionRow, lang: string): string {
  const isRu = lang === "ru";
  const lines = [
    isRu ? "Проверь, правильно ли я понял:" : "Please check if I understood you correctly:",
    `– **${isRu ? "Стиль" : "Style"}:** ${session.style || "?"}`,
    `– **${isRu ? "Эмоция" : "Emotion"}:** ${session.emotion || "?"}`,
    `– **${isRu ? "Поза / жест" : "Pose / gesture"}:** ${session.pose || "?"}`,
    "",
    isRu ? "Если что-то не так — скажи, что изменить." : "If anything is off, tell me what to change.",
  ];
  return lines.join("\n");
}

/**
 * Handle show_style_examples tool — show style keyboard with examples.
 * Uses the same style_presets_v2 layout as manual mode but routes style clicks back to assistant.
 */
async function handleShowStyleExamples(ctx: any, styleId: string | undefined | null, lang: string): Promise<void> {
  if (styleId) {
    // Specific style requested — show example via existing helper
    const example = await getStyleExample(styleId);
    if (example?.telegram_file_id) {
      try { await ctx.replyWithSticker(example.telegram_file_id); } catch (err: any) {
        console.error("handleShowStyleExamples: send sticker failed:", err.message);
      }
    } else {
      const isRu = lang === "ru";
      await ctx.reply(isRu
        ? "Примера для этого стиля пока нет. Опиши стиль словами — я пойму!"
        : "No example for this style yet. Describe it in words — I'll understand!");
    }
  } else {
    // Show full style keyboard — style clicks go to assistant, example clicks use standard flow
    await sendStyleExamplesKeyboard(ctx, lang, styleId || null);
  }
}

/**
 * Build final prompt for Gemini image generation from assistant params.
 */
function buildAssistantPrompt(params: { style: string; emotion: string; pose: string }): string {
  return `Create a high-quality character illustration.

Style: ${params.style}
Emotion: ${params.emotion}
Pose/gesture: ${params.pose}

Subject: Analyze the provided photo.
- If there is ONE person — use their face and appearance as reference.
- If there are MULTIPLE people — include ALL of them together, preserving their relative positions and interactions.
Recreate in a NEW dynamic sticker-friendly pose matching the emotion and pose above.
Do NOT copy the original photo's pose, angle, or composition.
Preserve recognizable facial features, hairstyle, and clothing style for every person.
Include only what the person(s) are wearing — no background objects or scenery from the photo.

Composition: Head, shoulders, and upper body visible with generous padding on all sides.
The character(s) must NOT touch or be cut off by the image edges.
Centered, large and prominent, but with clear space around the silhouette.

Background: Flat uniform single color, highly contrasting with the character. No gradients, no textures, no shadows.

Visual: Clean crisp edges, no glow, no halo, no soft transitions at silhouette. Natural shading. No watermark, no logo, no frame, no text.

CRITICAL: Do NOT add any border, outline, stroke, or contour around the character. No edge decoration of any kind. The character must have clean raw edges that blend directly into the background color. This is NOT a sticker — it is a source illustration for post-processing.

Quality: High-resolution, optimized for automated background removal.`;
}

// Helper: get active session
async function getActiveSession(userId: string) {
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .eq("env", config.appEnv)
    .order("created_at", { ascending: false })
    .maybeSingle();
  if (error) {
    console.log("getActiveSession error:", error.message, error.code);
  }
  if (data) return data;

  // Fallback: some DB setups flip is_active to false on update
  console.log("getActiveSession fallback for user:", userId);
  const { data: fallback } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .neq("state", "canceled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fallback) {
    console.log("getActiveSession fallback found:", fallback.id, "state:", fallback.state, "is_active:", fallback.is_active);
  }
  return fallback;
}

/** Get session that is in pack flow (for pack callbacks when user may have is_active assistant session). */
async function getPackFlowSession(userId: string) {
  const packStates = ["wait_pack_photo", "wait_pack_carousel", "wait_pack_preview_payment", "generating_pack_preview", "wait_pack_approval", "processing_pack"];
  const { data } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .in("state", packStates)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

/** Get session for style selection (wait_style or wait_pack_preview_payment). Prefers pack session when active is assistant. */
async function getSessionForStyleSelection(userId: string) {
  let session = await getActiveSession(userId);
  if (session && !["wait_style", "wait_pack_preview_payment"].includes(session.state)) {
    const packSession = await getPackFlowSession(userId);
    if (packSession?.state === "wait_pack_preview_payment") session = packSession;
  }
  return session;
}

/**
 * Handle grant_credit / deny_credit action from AI assistant.
 */
async function handleTrialCreditAction(
  ctx: any,
  action: "grant_credit" | "deny_credit",
  result: { text: string; toolCall: import("./lib/ai-chat").ToolCall | null },
  user: any,
  session: any,
  replyText: string | undefined,
  lang: string
): Promise<void> {
  if (action === "grant_credit") {
    // Code ALWAYS verifies limits — even if AI said "grant"
    const todayCount = await getTodayTrialCreditsCount();

    // Check if this user already received a trial credit (prevent duplicates)
    const { count: userTrialCount } = await supabase
      .from("assistant_sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("env", config.appEnv)
      .like("goal", "%[trial: grant%");
    const alreadyGranted = (userTrialCount || 0) > 0;

    const canGrant = todayCount < 20
      && (user.credits || 0) === 0
      && !user.has_purchased
      && (user.total_generations || 0) <= 2
      && !alreadyGranted;

    if (canGrant) {
      await supabase
        .from("users")
        .update({ credits: 1 })
        .eq("id", user.id);

      // Write [trial: grant] tag AFTER actual credit grant (fix: was written before check)
      const aSession = await getActiveAssistantSession(user.id);
      if (aSession) {
        const tag = `[trial: grant, confidence: ${result.toolCall?.args?.confidence}, reason: ${result.toolCall?.args?.reason}]`;
        await updateAssistantSession(aSession.id, {
          goal: `${aSession.goal || ""} ${tag}`.trim(),
        });
      }

      sendAlert({
        type: "trial_credit_granted",
        message: `🎁 Trial credit #${todayCount + 1}/20`,
        details: {
          user: `@${user.username || user.telegram_id}`,
          confidence: result.toolCall?.args?.confidence,
          reason: result.toolCall?.args?.reason,
          isPremium: user.is_premium,
          lang: user.language_code || user.lang,
        },
      }).catch(console.error);

      // Check if all sticker params are collected
      const paramsReady = aSession && allParamsCollected(aSession);

      if (paramsReady) {
        // All params collected — grant + generate (as before)
        const freshUser = await getUser(user.telegram_id);
        if (replyText) await ctx.reply(replyText);
        if (freshUser) await handleAssistantConfirm(ctx, freshUser, session.id, lang);
      } else {
        // Early grant — just credit the user, continue conversation
        if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
        // Generation will happen later when user hits [Confirm]
      }
    } else {
      // Budget exhausted or guard triggered
      // Write [trial: grant_blocked] tag
      const aSession = await getActiveAssistantSession(user.id);
      if (aSession) {
        const tag = `[trial: grant_blocked, reason: canGrant=false]`;
        await updateAssistantSession(aSession.id, {
          goal: `${aSession.goal || ""} ${tag}`.trim(),
        });
      }

      const paramsReady = aSession && allParamsCollected(aSession);

      if (paramsReady) {
        // Params collected — show paywall (as before)
        const paywallText = lang === "ru"
          ? "К сожалению, сейчас не могу сгенерировать бесплатно. Выбери пакет — 10 стикеров хватит для старта:"
          : "Unfortunately, I can't generate for free right now. Choose a pack — 10 stickers is enough to start:";
        await ctx.reply(paywallText);
        await sendBuyCreditsMenu(ctx, user);

        // Mark paywall shown on assistant session
        if (aSession) {
          await updateAssistantSession(aSession.id, {
            paywall_shown: true,
            paywall_shown_at: new Date().toISOString(),
            sales_attempts: (aSession.sales_attempts || 0) + 1,
          });
        }
      } else {
        // Early call, budget exhausted — silently continue conversation
        if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
      }
    }
  } else {
    // deny_credit
    // Write [trial: deny] tag
    const aSession = await getActiveAssistantSession(user.id);
    if (aSession) {
      const tag = `[trial: deny, confidence: ${result.toolCall?.args?.confidence}, reason: ${result.toolCall?.args?.reason}]`;
      await updateAssistantSession(aSession.id, {
        goal: `${aSession.goal || ""} ${tag}`.trim(),
      });
    }

    sendAlert({
      type: "trial_credit_denied",
      message: `❌ Trial denied`,
      details: {
        user: `@${user.username || user.telegram_id}`,
        confidence: result.toolCall?.args?.confidence,
        reason: result.toolCall?.args?.reason,
      },
    }).catch(console.error);

    const paramsReady = aSession && allParamsCollected(aSession);

    if (paramsReady) {
      // Params collected — show paywall (as before)
      if (replyText) await ctx.reply(replyText);
      await sendBuyCreditsMenu(ctx, user);

      // Mark paywall shown on assistant session
      if (aSession) {
        await updateAssistantSession(aSession.id, {
          paywall_shown: true,
          paywall_shown_at: new Date().toISOString(),
          sales_attempts: (aSession.sales_attempts || 0) + 1,
        });
      }
    } else {
      // Early deny — soft, no paywall, continue conversation
      if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
    }
  }
}

// Helper: send buy credits menu
async function sendBuyCreditsMenu(ctx: any, user: any, messageText?: string) {
  const lang = user.lang || "en";
  const text = messageText || await getText(lang, "payment.balance", { credits: user.credits });
  const isAdmin = config.adminIds.includes(user.telegram_id);

  // Filter packs: hide adminOnly (unless admin), hidden packs, and trialOnly (unless first purchase)
  const availablePacks = CREDIT_PACKS.filter((p: any) =>
    !p.hidden &&
    (!p.adminOnly || isAdmin) &&
    (!p.trialOnly || !user.has_purchased)
  );

  const buttons: any[][] = [];

  // One button per row with full label
  for (const pack of availablePacks) {
    const label = lang === "ru" ? pack.label_ru : pack.label_en;
    const unit = lang === "ru" ? "стикеров" : "stickers";
    buttons.push([
      Markup.button.callback(
        `${label}: ${pack.credits} ${unit} — ${pack.price}⭐ (${pack.price_rub}₽)`,
        `pack_${pack.credits}_${pack.price}`
      )
    ]);
  }

  // Button to buy Stars for rubles (RU only)
  if (lang === "ru") {
    buttons.push([
      Markup.button.url("💵 Купить Stars за ₽", "https://t.me/StarsZakupBot?start=ref_r_0477825983")
    ]);
  }

  const cancelText = await getText(lang, "btn.cancel");
  buttons.push([Markup.button.callback(cancelText, "cancel")]);

  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}

// Helper: parse start payload into UTM fields
function parseStartPayload(payload: string): {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
} {
  if (!payload) return { source: null, medium: null, campaign: null, content: null };

  const parts = payload.split("_");
  const knownSources = ["ya", "yandex", "gads", "google", "fb", "ig", "vk", "tg", "web"];
  const knownMediums = ["cpc", "cpm", "organic", "social", "referral"];

  if (parts.length >= 2 && knownSources.includes(parts[0]) && knownMediums.includes(parts[1])) {
    return {
      source: parts[0],
      medium: parts[1],
      campaign: parts[2] || null,
      content: parts[3] || null,
    };
  }

  return { source: payload, medium: null, campaign: null, content: null };
}

// Get start payload from /start deep link (t.me/bot?start=payload → message "/start payload")
function getStartPayload(ctx: { message?: { text?: string } }): string {
  const text = ctx.message?.text || "";
  const match = text.match(/^\/start\s+(.+)$/);
  return match ? match[1].trim() : "";
}

// ============================================
// Outreach — personalized message to new users
// ============================================

/**
 * Generate outreach message using AI and send alert to admin channel.
 * Async, non-blocking — called from bot.start for new users.
 */
async function generateAndSendOutreachAlert(
  ctx: any,
  user: any,
  languageCode: string,
  utm: { source: string | null; medium: string | null; campaign: string | null; content: string | null }
) {
  const telegramId = user.telegram_id;
  const lang = user.lang || "en";
  const firstName = ctx.from?.first_name || "";
  const username = ctx.from?.username || "";
  const isPremium = ctx.from?.is_premium || false;

  // Generate outreach message via Gemini
  let outreachText = "";
  try {
    const systemPrompt = await getText(lang, "outreach.system_prompt");
    const userContext = `Name: ${firstName || "unknown"}\nUsername: ${username || "none"}\nLanguage: ${lang}\nSource: ${utm.source || "organic"}/${utm.medium || "none"}\nPremium: ${isPremium}`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`,
      {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userContext }] }],
      },
      { headers: { "x-goog-api-key": config.geminiApiKey } }
    );

    outreachText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  } catch (err: any) {
    console.error("[Outreach] AI generation failed:", err.response?.data || err.message);
  }

  if (!outreachText) {
    // Fallback: no AI message, send plain alert
    const utmInfo = utm.source ? `\n📢 Источник: ${utm.source}${utm.medium ? "/" + utm.medium : ""}` : "";
    sendNotification({
      type: "new_user",
      message: `@${username || "no\\_username"} (${telegramId})\n🌐 Язык: ${languageCode || "unknown"}${utmInfo}`,
      buttons: [[
        { text: "🔥 -10%", callback_data: `admin_discount:${telegramId}:10` },
        { text: "🔥 -15%", callback_data: `admin_discount:${telegramId}:15` },
        { text: "🔥 -25%", callback_data: `admin_discount:${telegramId}:25` },
      ]],
    }).catch(console.error);
    return;
  }

  // Save outreach to DB
  const { data: outreach, error: outreachError } = await supabase
    .from("user_outreach")
    .insert({
      user_id: user.id,
      telegram_id: telegramId,
      message_text: outreachText,
      status: "draft",
      env: config.appEnv,
    })
    .select("id")
    .single();

  if (outreachError || !outreach) {
    console.error("[Outreach] DB insert failed:", outreachError?.message);
    return;
  }

  const outreachId = outreach.id;

  // Send alert with outreach preview + buttons
  const utmInfo = utm.source ? `\n📢 Источник: ${utm.source}${utm.medium ? "/" + utm.medium : ""}` : "";
  const premiumTag = isPremium ? " ⭐Premium" : "";
  const alertText =
    `🆕 *Новый пользователь*\n\n` +
    `👤 @${escapeMarkdownForAlert(username || "no_username")} (${telegramId})${premiumTag}\n` +
    `🌐 Язык: ${languageCode || "unknown"}${utmInfo}\n\n` +
    `✉️ *Outreach:*\n"${escapeMarkdownForAlert(outreachText)}"`;

  const channelId = config.alertChannelId;
  if (!channelId) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channelId,
        text: alertText,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔥 -10%", callback_data: `admin_discount:${telegramId}:10` },
              { text: "🔥 -15%", callback_data: `admin_discount:${telegramId}:15` },
              { text: "🔥 -25%", callback_data: `admin_discount:${telegramId}:25` },
            ],
            [
              { text: "✉️ Отправить", callback_data: `admin_send_outreach:${outreachId}` },
              { text: "🔄 Заново", callback_data: `admin_regen_outreach:${outreachId}` },
            ],
          ],
        },
      }),
    });

    const data = await res.json() as any;
    if (data.ok && data.result?.message_id) {
      // Save alert message_id for later editing
      await supabase
        .from("user_outreach")
        .update({ alert_message_id: data.result.message_id })
        .eq("id", outreachId);
    }
  } catch (err: any) {
    console.error("[Outreach] Failed to send alert:", err.message);
  }
}

function escapeMarkdownForAlert(text: string): string {
  return text.replace(/[_*`\[\]]/g, "\\$&");
}

// Avatar auto-generation for paid traffic users
async function handleAvatarAutoGeneration(ctx: any, user: any, lang: string) {
  const telegramId = user.telegram_id;
  console.log("[AvatarAuto] Starting for user:", telegramId);

  // Get profile photo
  const photos = await ctx.telegram.getUserProfilePhotos(telegramId, 0, 1);
  if (!photos || photos.total_count === 0) {
    console.log("[AvatarAuto] No profile photos found");
    return false;
  }

  const photoSizes = photos.photos[0]; // first photo, array of sizes
  const bestPhoto = photoSizes[photoSizes.length - 1]; // largest size
  const avatarFileId = bestPhoto.file_id;
  console.log("[AvatarAuto] Got avatar file_id:", avatarFileId?.substring(0, 30) + "...");

  // Send instant greeting
  const greetingText = lang === "ru"
    ? "Привет! Я делаю стикеры из фото 🎨 Смотри — уже готовлю один из твоей аватарки, чтобы ты увидел как это работает!"
    : "Hi! I turn photos into stickers 🎨 Look — I'm already making one from your profile photo so you can see how it works!";
  await ctx.reply(greetingText, getMainMenuKeyboard(lang));

  // Get configurable style from app_config (default: cartoon_telegram)
  const defaultStyleId = await getAppConfig("avatar_demo_style", "cartoon_telegram");
  const preset = await getStylePresetV2ById(defaultStyleId);
  if (!preset) {
    console.error("[AvatarAuto] Default preset not found:", defaultStyleId);
    return false;
  }

  // Generate prompt via prompt_generator agent (same as normal style flow)
  const userInput = preset.prompt_hint;
  const promptResult = await generatePrompt(userInput);
  const avatarPrompt = promptResult.ok && !promptResult.retry
    ? promptResult.prompt || userInput
    : userInput;

  console.log("[AvatarAuto] Style:", defaultStyleId, "prompt_hint:", userInput?.substring(0, 50));

  // Close any active sessions
  await supabase
    .from("sessions")
    .update({ state: "canceled", is_active: false })
    .eq("user_id", user.id)
    .eq("is_active", true);

  // Create session with credits_spent: 0 (free demo) and generation_type: avatar_demo
  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      state: "processing",
      is_active: true,
      selected_style_id: defaultStyleId,
      current_photo_file_id: avatarFileId,
      prompt_final: avatarPrompt,
      user_input: `[avatar_demo] ${userInput}`,
      generation_type: "avatar_demo",
      credits_spent: 0,
      env: config.appEnv,
    })
    .select("*")
    .single();

  if (sessionError || !session) {
    console.error("[AvatarAuto] Failed to create session:", sessionError?.message);
    return false;
  }

  console.log("[AvatarAuto] Session created:", session.id);

  // Enqueue job (no credit deduction needed)
  await enqueueJob(session.id, user.id, false);

  // Send progress message
  await sendProgressStart(ctx, session.id, lang);

  console.log("[AvatarAuto] Job enqueued, progress shown");
  return true;
}

// /start command
bot.start(async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  let user = await getUser(telegramId);
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    const languageCode = ctx.from?.language_code || "";
    const lang = languageCode.toLowerCase().startsWith("ru") ? "ru" : "en";

    // Parse UTM from start payload (t.me/bot?start=payload)
    const startPayload = getStartPayload(ctx);
    const utm = parseStartPayload(startPayload);
    if (startPayload) {
      console.log("New user - start_payload:", startPayload, "utm:", JSON.stringify(utm));
    }

    console.log("New user - language_code:", languageCode, "-> lang:", lang);

    const { data: created, error: insertError } = await supabase
      .from("users")
      .insert({ 
        telegram_id: telegramId, 
        lang, 
        language_code: languageCode || null,
        credits: 0,
        has_purchased: false,
        username: ctx.from?.username || null,
        env: config.appEnv,
        start_payload: startPayload || null,
        utm_source: utm.source,
        utm_medium: utm.medium,
        utm_campaign: utm.campaign,
        utm_content: utm.content,
      })
      .select("*")
      .single();

    if (insertError) {
      console.error("User insert error:", insertError);
      // Race condition: user might already exist, try to fetch again
      if (insertError.code === "23505") {  // unique_violation
        const { data: existingUser } = await supabase
          .from("users")
          .select("*")
          .eq("telegram_id", telegramId)
          .maybeSingle();
        user = existingUser;
        isNewUser = false;
        console.log("User already exists, fetched:", user?.id);
      }
    } else {
      user = created;
    }

    // No free credits on registration — credits granted by AI assistant (grant_credit, 20/day limit)
    // Paywall shows if no credits and no purchase

    // Send notification with outreach + discount buttons for admin (async, non-blocking)
    if (user?.id) {
      generateAndSendOutreachAlert(ctx, user, languageCode || "", utm).catch((err: any) =>
        console.error("[Outreach] Alert generation failed:", err.message)
      );
    }
  } else {
    // Update username and lang if changed
    const currentUsername = ctx.from?.username || null;
    const currentLangCode = ctx.from?.language_code || "";
    const currentLang = currentLangCode.toLowerCase().startsWith("ru") ? "ru" : "en";
    const updates: Record<string, any> = {};

    if (user.username !== currentUsername) updates.username = currentUsername;
    if (user.lang !== currentLang) updates.lang = currentLang;
    if (user.language_code !== currentLangCode) updates.language_code = currentLangCode || null;

    // Update UTM for returning users if they came via a new start link and UTM is empty
    const startPayload = getStartPayload(ctx);
    if (startPayload && !user.utm_source) {
      const utm = parseStartPayload(startPayload);
      if (utm.source) {
        updates.start_payload = startPayload;
        updates.utm_source = utm.source;
        updates.utm_medium = utm.medium;
        updates.utm_campaign = utm.campaign;
        updates.utm_content = utm.content;
        console.log("Returning user UTM update:", telegramId, "payload:", startPayload, "utm:", JSON.stringify(utm));
      }
    }

    if (Object.keys(updates).length > 0) {
      await supabase.from("users").update(updates).eq("id", user.id);
      Object.assign(user, updates);
    }
  }

  if (user?.id) {
    const lang = user.lang || "en";
    const startPayload = getStartPayload(ctx);

    // [DISABLED] Avatar auto-generation for new paid traffic users
    if ((false as boolean) && isNewUser && user.utm_source === "yandex" && user.utm_medium === "cpc") {
      console.log("[AvatarAuto] Paid traffic user detected, checking profile photo...");
      try {
        const success = await handleAvatarAutoGeneration(ctx, user, lang);
        if (success) {
          console.log("[AvatarAuto] Auto-generation started, skipping assistant dialog");
          return;
        }
        console.log("[AvatarAuto] No avatar or failed, falling back to assistant dialog");
      } catch (err: any) {
        console.error("[AvatarAuto] Error:", err.message);
      }
    }

    // Valentine broadcast: val_STYLE_ID — create session for direct style generation
    if (startPayload.startsWith("val_")) {
      const styleId = startPayload.replace("val_", "");
      const preset = await getStylePresetV2ById(styleId);
      if (preset) {
        // Close active sessions, create new one with preferred style
        await supabase
          .from("sessions")
          .update({ state: "canceled", is_active: false })
          .eq("user_id", user.id)
          .eq("is_active", true);

        await supabase.from("sessions").insert({
          user_id: user.id,
          state: "wait_photo",
          is_active: true,
          selected_style_id: styleId,
          env: config.appEnv,
        });

        const styleName = lang === "ru" ? preset.name_ru : preset.name_en;
        const text = lang === "ru"
          ? `💝 Отправь фото — создам стикер в стиле «${styleName}»!\n\n${preset.emoji} Просто отправь фото сюда 👇`
          : `💝 Send a photo — I'll create a sticker in «${styleName}» style!\n\n${preset.emoji} Just send your photo here 👇`;
        await ctx.reply(text, getMainMenuKeyboard(lang));
        return;
      }
    }

    // Start AI assistant dialog (cancels old sessions inside)
    await startAssistantDialog(ctx, user, lang);
  } else {
    const lang = "en";
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
  }
});

// Valentine broadcast: callback val_STYLE_ID (user already in bot, no /start redirect)
bot.action(/^val_(.+)$/, async (ctx) => {
  const styleId = ctx.match[1];
  console.log("[Broadcast] val_ callback:", styleId, "telegramId:", ctx.from?.id);
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) {
    console.log("[Broadcast] val_ user not found for telegramId:", telegramId, "appEnv:", config.appEnv);
    return;
  }

  const preset = await getStylePresetV2ById(styleId);
  if (!preset) {
    console.log("[Broadcast] val_ preset not found:", styleId);
    return;
  }

  const lang = user.lang || "en";

  await supabase
    .from("sessions")
    .update({ state: "canceled", is_active: false })
    .eq("user_id", user.id)
    .eq("is_active", true);

  await supabase.from("sessions").insert({
    user_id: user.id,
    state: "wait_photo",
    is_active: true,
    selected_style_id: styleId,
    env: config.appEnv,
  });

  const styleName = lang === "ru" ? preset.name_ru : preset.name_en;
  const text = lang === "ru"
    ? `💝 Отправь фото — создам стикер в стиле «${styleName}»!\n\n${preset.emoji} Просто отправь фото сюда 👇`
    : `💝 Send a photo — I'll create a sticker in «${styleName}» style!\n\n${preset.emoji} Just send your photo here 👇`;
  await ctx.reply(text, getMainMenuKeyboard(lang));
});

// /balance command - shows balance + tariffs directly (no intermediate "Top up" button)
bot.command("balance", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"));
    return;
  }

  const lang = user.lang || "en";
  const text = await getText(lang, "balance.info", { credits: user.credits || 0 });
  await sendBuyCreditsMenu(ctx, user, text);
});

// /support command
bot.command("support", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const { data: user } = await supabase
    .from("users")
    .select("lang")
    .eq("telegram_id", telegramId)
    .maybeSingle();

  const lang = user?.lang || "en";
  const message = await getText(lang, "support.message");
  const buttonText = await getText(lang, "support.button");

  await ctx.reply(message, {
    reply_markup: {
      inline_keyboard: [[
        { text: buttonText, url: "https://t.me/p2s_support_bot" }
      ]]
    }
  });
});

/**
 * Get photo file_id: from current session first, then from user.last_photo_file_id.
 * If found from user, copies it into the session for generation to work.
 */
function getUserPhotoFileId(user: any, session: any): string | null {
  return session?.current_photo_file_id || user?.last_photo_file_id || null;
}

// Photo handler
bot.on("photo", async (ctx) => {
  const telegramId = ctx.from?.id;
  console.log("Photo received, telegramId:", telegramId);
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  console.log("Photo handler - session:", session?.id, "state:", session?.state);
  if (!session?.id) {
    await ctx.reply(await getText(lang, "start.need_start"));
    return;
  }

  const photo = ctx.message.photo?.[ctx.message.photo.length - 1];
  if (!photo) return;

  // Save last photo on user for reuse across sessions
  const { error: lastPhotoErr } = await supabase.from("users")
    .update({ last_photo_file_id: photo.file_id })
    .eq("id", user.id);
  if (lastPhotoErr) {
    console.error("Failed to update last_photo_file_id:", lastPhotoErr.message);
  } else {
    console.log("last_photo_file_id updated for user:", user.id);
  }

  // Reactivate pack sessions found via fallback (is_active may be false)
  if (session.state === "wait_pack_photo" && !session.is_active) {
    console.log("Pack photo: reactivating fallback session:", session.id);
    await supabase.from("sessions").update({ is_active: true }).eq("id", session.id);
    session.is_active = true;
  }

  // === AI Assistant: re-route to assistant_wait_photo if assistant is active after generation ===
  // Skip re-route for pack flow states — pack handles photos independently
  if (!session.state?.startsWith("assistant_") && !session.state?.startsWith("wait_pack_") && !["processing", "processing_emotion", "processing_motion", "processing_text", "generating_pack_preview", "processing_pack"].includes(session.state)) {
    const activeAssistant = await getActiveAssistantSession(user.id);
    if (activeAssistant && activeAssistant.status === "active") {
      console.log("Assistant photo re-route: state was", session.state, "→ switching to assistant_wait_photo");
      await supabase.from("sessions")
        .update({ state: "assistant_wait_photo", is_active: true })
        .eq("id", session.id);
      session.state = "assistant_wait_photo";
      session.is_active = true;
    }
  }

  // === AI Assistant: photo sent during active chat — update photo and continue ===
  if (session.state === "assistant_chat") {
    console.log("Assistant chat photo: updating photo for session:", session.id);
    const chatPhotos = Array.isArray(session.photos) ? session.photos : [];
    chatPhotos.push(photo.file_id);
    await supabase.from("sessions")
      .update({ photos: chatPhotos, current_photo_file_id: photo.file_id, is_active: true })
      .eq("id", session.id);

    const aSessionChat = await getActiveAssistantSession(user.id);
    if (aSessionChat) {
      // Notify assistant about the new photo
      const chatMessages: AssistantMessage[] = Array.isArray(aSessionChat.messages) ? [...aSessionChat.messages] : [];
      chatMessages.push({ role: "user", content: "[User sent a new photo]" });
      const chatSystemPrompt = await getAssistantSystemPrompt(chatMessages, aSessionChat, {
        credits: user.credits || 0,
        hasPurchased: !!user.has_purchased,
        totalGenerations: user.total_generations || 0,
        utmSource: user.utm_source,
        utmMedium: user.utm_medium,
      });
      try {
        const chatResult = await callAIChat(chatMessages, chatSystemPrompt);
        chatMessages.push({ role: "assistant", content: chatResult.text });
        await updateAssistantSession(aSessionChat.id, { messages: chatMessages });
        if (chatResult.text) await ctx.reply(chatResult.text, getMainMenuKeyboard(lang));
      } catch (err: any) {
        console.error("Assistant chat photo AI error:", err.message);
        const ack = lang === "ru"
          ? "Фото обновлено! Продолжаем — что будем делать со стикером?"
          : "Photo updated! Let's continue — what shall we do with the sticker?";
        await ctx.reply(ack, getMainMenuKeyboard(lang));
      }
    } else {
      // No assistant session — acknowledge photo update
      const ack = lang === "ru" ? "Фото принято! 📸" : "Photo received! 📸";
      await ctx.reply(ack, getMainMenuKeyboard(lang));
    }
    return;
  }

  // === AI Assistant: waiting for photo ===
  if (session.state === "assistant_wait_photo") {
    console.log("Assistant photo: received, session:", session.id);
    const aSession = await getActiveAssistantSession(user.id);
    if (!aSession) {
      console.log("Assistant photo: no assistant_session — falling through to manual mode");
      // Reset session state so it doesn't stay stuck in assistant_wait_photo
      await supabase.from("sessions")
        .update({ state: "wait_photo", is_active: true })
        .eq("id", session.id);
      session.state = "wait_photo";
      // Fall through to manual photo handler below
    } else {

    const photos = Array.isArray(session.photos) ? session.photos : [];
    photos.push(photo.file_id);

    // === NEW: Show sticker ideas immediately after photo ===
    console.log("Assistant photo: showing sticker ideas flow");

    // Pick style: user's last > default > random
    const randomStyle = await pickStyleForIdeas(user);

    // Save photo and move to assistant_wait_idea
    const { error: updateErr1 } = await supabase
      .from("sessions")
      .update({
        photos,
        current_photo_file_id: photo.file_id,
        state: "assistant_wait_idea",
        is_active: true,
      })
      .eq("id", session.id);
    if (updateErr1) console.error("[assistant_ideas] session update error:", updateErr1.message);

    // Show loading message
    const loadingMsg = await ctx.reply(
      lang === "ru" ? "📸 Отличное фото! Подбираю идею для стикера..." : "📸 Great photo! Picking a sticker idea..."
    );

    // Generate first idea with photo analysis
    let idea: StickerIdea;
    let photoDescription = "";
    try {
      const result = await generateFirstIdeaWithPhoto({
        photoFileId: photo.file_id,
        stylePresetId: randomStyle.id,
        lang,
      });
      idea = result.idea;
      photoDescription = result.photoDescription;
      console.log("[assistant_ideas] Got first idea:", idea.titleEn);
    } catch (err: any) {
      console.error("[assistant_ideas] generateFirstIdeaWithPhoto error:", err.message);
      idea = getDefaultIdeas(lang)[0];
    }

    // Save ideas state with photoDescription
    const ideasState = {
      styleId: randomStyle.id,
      ideaIndex: 0,
      ideas: [idea],
      photoDescription,
      holidayId: null,
    };
    const { error: updateErr2 } = await supabase
      .from("sessions")
      .update({
        sticker_ideas_state: ideasState,
        state: "assistant_wait_idea",
        is_active: true,
      })
      .eq("id", session.id);
    if (updateErr2) console.error("[assistant_ideas] ideas state save error:", updateErr2.message);

    // Delete loading message
    try { await ctx.deleteMessage(loadingMsg.message_id); } catch {}

    // Guard against race conditions: session may switch to pack/other flow
    // while idea generation is running. Only check state: some DB setups flip
    // is_active to false on update.
    const { data: freshSession } = await supabase
      .from("sessions")
      .select("state")
      .eq("id", session.id)
      .maybeSingle();
    if (!String(freshSession?.state || "").startsWith("assistant_")) {
      console.log("[assistant_ideas] Session switched, skipping idea card for session:", session.id, "state:", freshSession?.state);
      return;
    }

    // Show first idea card
    await showStickerIdeaCard(ctx, {
      idea,
      ideaIndex: 0,
      totalIdeas: 0, // unlimited
      style: randomStyle,
      lang,
    });
    return;
  }

  // === AI Assistant: new photo during active dialog ===
  if (session.state === "assistant_chat") {
    // Store new photo file_id in assistant_sessions for later use
    const aSession = await getActiveAssistantSession(user.id);
    if (aSession) {
      await updateAssistantSession(aSession.id, { pending_photo_file_id: photo.file_id });
    }

    await ctx.reply(
      lang === "ru"
        ? "Вижу новое фото! С каким будем работать?"
        : "New photo! Which one should we use?",
      Markup.inlineKeyboard([
        [Markup.button.callback(
          lang === "ru" ? "✅ Новое фото" : "✅ New photo",
          "assistant_new_photo"
        )],
        [Markup.button.callback(
          lang === "ru" ? "❌ Оставить прежнее" : "❌ Keep current",
          "assistant_keep_photo"
        )],
      ])
    );
    return;
  }

  // [DISABLED] === Avatar demo follow-up ===
  if ((false as boolean) && session.generation_type === "avatar_demo" && session.state === "confirm_sticker") {
    console.log("[AvatarDemo] User sent photo after avatar_demo — starting assistant dialog");
    await startAssistantDialog(ctx, user, lang);
    // Re-fetch session to get the new assistant_wait_photo state
    const newSession = await getActiveSession(user.id);
    if (newSession?.state === "assistant_wait_photo") {
      // Save photo and process as assistant photo
      const photos = Array.isArray(newSession.photos) ? [...newSession.photos] : [];
      photos.push(photo.file_id);
      await supabase.from("sessions")
        .update({ photos, current_photo_file_id: photo.file_id, state: "assistant_chat", is_active: true })
        .eq("id", newSession.id);

      const aSession = await getActiveAssistantSession(user.id);
      if (aSession) {
        const messages: AssistantMessage[] = Array.isArray(aSession.messages) ? [...aSession.messages] : [];
        messages.push({ role: "user", content: "[User sent a photo]" });

        const systemPrompt = await getAssistantSystemPrompt(messages, aSession, {
          credits: user.credits || 0,
          hasPurchased: !!user.has_purchased,
          totalGenerations: user.total_generations || 0,
          utmSource: user.utm_source,
          utmMedium: user.utm_medium,
        });

        try {
          const result = await callAIChat(messages, systemPrompt);
          messages.push({ role: "assistant", content: result.text });
          const { action, updatedSession } = await processAssistantResult(result, aSession, messages);
          let replyText = result.text;
          if (!replyText && result.toolCall) {
            replyText = generateFallbackReply(action, updatedSession, lang);
            messages[messages.length - 1] = { role: "assistant", content: replyText };
          }
          await updateAssistantSession(aSession.id, { messages });
          if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
        } catch (err: any) {
          console.error("[AvatarDemo] Assistant AI error:", err.message);
          const fallback = lang === "ru"
            ? "Отличное фото! Опиши стиль стикера (например: аниме, мультяшный, минимализм)"
            : "Great photo! Describe the sticker style (e.g.: anime, cartoon, minimal)";
          await ctx.reply(fallback, getMainMenuKeyboard(lang));
        }
      }
    }
    return;
    } // end else (aSession exists)
  }

  // === Pack flow: photo for sticker pack ===
  if (session.state === "wait_pack_photo") {
    console.log("Pack photo received, session:", session.id);
    const packPhotos = Array.isArray(session.photos) ? session.photos : [];
    packPhotos.push(photo.file_id);

    // Update session with photo, move to preview payment state
    await supabase
      .from("sessions")
      .update({
        photos: packPhotos,
        current_photo_file_id: photo.file_id,
        state: "wait_pack_preview_payment",
        is_active: true,
      })
      .eq("id", session.id);

    // Send style selector (pack flow: always show Back to poses)
    await sendPackStyleSelectionStep(ctx, lang, session.selected_style_id, undefined, { useBackButton: true });
    return;
  }

  // === Manual mode: existing logic ===
  const photos = Array.isArray(session.photos) ? session.photos : [];
  photos.push(photo.file_id);

  // Valentine flow: came from val_* link with pre-selected style — go straight to generation
  if (session.state === "wait_photo" && session.selected_style_id) {
    const preset = await getStylePresetV2ById(session.selected_style_id);
    if (preset) {
      const { error: upErr } = await supabase
        .from("sessions")
        .update({
          photos,
          state: "wait_style",
          is_active: true,
          current_photo_file_id: photo.file_id,
        })
        .eq("id", session.id);
      if (upErr) console.error("Valentine photo update error:", upErr);
      await ctx.reply(await getText(lang, "photo.processing"));
      const userInput = preset.prompt_hint;
      const promptResult = await generatePrompt(userInput);
      const generatedPrompt = promptResult.ok && !promptResult.retry ? promptResult.prompt || userInput : userInput;
      Object.assign(session, { photos, current_photo_file_id: photo.file_id, state: "wait_style", selected_style_id: preset.id });
      await startGeneration(ctx, user, session, lang, {
        generationType: "style",
        promptFinal: generatedPrompt,
        userInput,
        selectedStyleId: preset.id,
      });
      return;
    }
  }

  const { error } = await supabase
    .from("sessions")
    .update({ photos, state: "wait_style", is_active: true, current_photo_file_id: photo.file_id })
    .eq("id", session.id);
  if (error) {
    console.error("Failed to update session to wait_style:", error);
  }

  await sendStyleKeyboardFlat(ctx, lang, undefined, { selectedStyleId: session.selected_style_id || null });
});

// ============================================
// Persistent menu handlers (Reply Keyboard)
// ============================================

// Menu: 🤖 1 стикер — launch or continue AI assistant dialog
bot.hears(["🤖 1 стикер", "🤖 1 sticker"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"), getMainMenuKeyboard(lang));
    return;
  }

  const lang = user.lang || "en";

  // If already in assistant dialog — ignore
  const session = await getActiveSession(user.id);
  if (session?.state?.startsWith("assistant_")) {
    return;
  }

  // Start new assistant dialog (implemented in step 4)
  await startAssistantDialog(ctx, user, lang);
});

// Menu: 🎨 Стили — manual style selection mode
bot.hears(["🎨 Стили", "🎨 Styles"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"), getMainMenuKeyboard(lang));
    return;
  }

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);

  // If user is in assistant mode, cancel it and switch to manual
  if (session?.state?.startsWith("assistant_")) {
    console.log("Styles: switching from assistant to manual mode, session:", session.id);
    await closeAllActiveAssistantSessions(user.id, "abandoned");
    // Always reset session state so photo handler won't get stuck in assistant_wait_photo
    await supabase.from("sessions")
      .update({ state: "wait_photo", is_active: true })
      .eq("id", session.id);
    if (session) session.state = "wait_photo";
  }

  // Get photo: from session or from user's last photo
  const photoFileId = getUserPhotoFileId(user, session);

  if (!session || !photoFileId) {
    await ctx.reply(await getText(lang, "photo.need_photo"), getMainMenuKeyboard(lang));
    return;
  }

  // Always set state to wait_style + copy photo if needed
  const sessionUpdate: any = { state: "wait_style", is_active: true };
  if (!session.current_photo_file_id && photoFileId) {
    sessionUpdate.current_photo_file_id = photoFileId;
    sessionUpdate.photos = [photoFileId];
    console.log("Styles: reused photo from user.last_photo_file_id");
  }
  if (session.state !== "wait_style") {
    console.log("Styles: switching state from", session.state, "to wait_style, session:", session.id);
  }
  await supabase.from("sessions")
    .update(sessionUpdate)
    .eq("id", session.id);

  // Show flat style list (unified with ideas flow)
  await sendStyleKeyboardFlat(ctx, lang, undefined, { selectedStyleId: session.selected_style_id || null });
});

// Menu: 💰 Баланс — show balance + credit packs
bot.hears(["💰 Баланс", "💰 Balance"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"), getMainMenuKeyboard(lang));
    return;
  }

  await sendBuyCreditsMenu(ctx, user);
});

// Menu: ❓ (help, icon only)
bot.hears(["❓"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  const lang = user?.lang || "en";
  await ctx.reply(await getText(lang, "menu.help"), getMainMenuKeyboard(lang));
});

// ============================================
// "Сделать пак" flow
// ============================================

async function getPackStylePrompt(lang: string, selectedStyleId?: string | null) {
  if (!selectedStyleId) {
    return lang === "ru"
      ? "Выбери стиль пака и нажми «Посмотреть превью»"
      : "Choose a pack style and tap “See preview”";
  }
  const preset = await getStylePresetV2ById(selectedStyleId);
  const styleName = preset ? (lang === "ru" ? preset.name_ru : preset.name_en) : selectedStyleId;
  return lang === "ru"
    ? `Выбери стиль пака и нажми «Посмотреть превью»\nТекущий стиль: ${styleName}`
    : `Choose a pack style and tap “See preview”\nCurrent style: ${styleName}`;
}

async function sendPackStyleSelectionStep(
  ctx: any,
  lang: string,
  selectedStyleId?: string | null,
  messageId?: number,
  options?: { useBackButton?: boolean }
) {
  const stylePrompt = await getPackStylePrompt(lang, selectedStyleId);
  const previewBtn = await getText(lang, "btn.preview_pack");
  const backBtn = await getText(lang, "pack.back_to_poses");
  const cancelBtn = await getText(lang, "btn.cancel_pack");

  let headerText = stylePrompt;
  const telegramId = ctx.from?.id;
  if (telegramId) {
    const user = await getUser(telegramId);
    if (user) {
      const session = await getPackFlowSession(user.id);
      if (session?.pack_content_set_id) {
        const { data: contentSet } = await supabase
          .from("pack_content_sets")
          .select("name_ru, name_en")
          .eq("id", session.pack_content_set_id)
          .maybeSingle();
        if (contentSet) {
          const setName = lang === "ru" ? contentSet.name_ru : contentSet.name_en;
          headerText += "\n\n" + (await getText(lang, "pack.selected_set", { name: setName }));
        }
      }
    }
  }

  const bottomButton = options?.useBackButton
    ? [{ text: `◀️ ${backBtn}`, callback_data: "pack_back_to_carousel" }]
    : [{ text: cancelBtn, callback_data: "pack_cancel" }];

  return sendStyleKeyboardFlat(ctx, lang, messageId, {
    includeCustom: false,
    headerText,
    selectedStyleId: selectedStyleId ?? undefined,
    extraButtons: [
      [{ text: previewBtn, callback_data: "pack_preview_pay" }],
      bottomButton,
    ],
  });
}

// Menu: 📦 Пак стикеров — show template CTA screen
bot.hears(["📦 Пак стикеров", "📦 Sticker pack"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"), getMainMenuKeyboard(lang));
    return;
  }
  const lang = user.lang || "en";

  // Close any active assistant session to prevent ideas from showing
  const activeAssistant = await getActiveAssistantSession(user.id);
  if (activeAssistant) {
    await updateAssistantSession(activeAssistant.id, { status: "completed" });
  }

  // Get first active template
  const { data: template } = await supabase
    .from("pack_templates")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!template) {
    await ctx.reply(
      lang === "ru" ? "Паки скоро будут доступны!" : "Packs coming soon!",
      getMainMenuKeyboard(lang)
    );
    return;
  }

  const templateId = template.id;
  const { data: contentSets } = await supabase
    .from("pack_content_sets")
    .select("*")
    .eq("pack_template_id", templateId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (!contentSets?.length) {
    await ctx.reply(lang === "ru" ? "Наборы пока не готовы." : "Sets not ready yet.", getMainMenuKeyboard(lang));
    return;
  }

  await supabase.from("sessions").update({ is_active: false }).eq("user_id", user.id).eq("is_active", true).eq("env", config.appEnv);
  let selectedPackStyleId: string | null = null;
  try {
    const defaultPackStyle = await pickStyleForIdeas(user);
    selectedPackStyleId = defaultPackStyle?.id || null;
  } catch (_) {}

  const { data: session, error: sessErr } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      state: "wait_pack_carousel",
      is_active: true,
      pack_template_id: templateId,
      pack_carousel_index: 0,
      selected_style_id: selectedPackStyleId,
      env: config.appEnv,
    })
    .select()
    .single();
  if (sessErr || !session) {
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
    return;
  }

  const set = contentSets[0];
  const setName = lang === "ru" ? set.name_ru : set.name_en;
  const setDesc = lang === "ru" ? (set.carousel_description_ru || set.name_ru) : (set.carousel_description_en || set.name_en);
  const intro = await getText(lang, "pack.carousel_intro");
  const carouselCaption = `${intro}\n\n*${setName}*\n${setDesc}`;
  const tryBtn = await getText(lang, "pack.carousel_try_btn", { name: setName });
  const keyboard = {
    inline_keyboard: [
      [
        { text: "◀️", callback_data: "pack_carousel_prev" },
        { text: `1/${contentSets.length}`, callback_data: "pack_carousel_noop" },
        { text: "▶️", callback_data: "pack_carousel_next" },
      ],
      [{ text: tryBtn, callback_data: `pack_try:${set.id}` }],
    ],
  };
  const msg = await ctx.reply(carouselCaption, { parse_mode: "Markdown", reply_markup: keyboard });
  if (msg?.message_id && ctx.chat?.id) {
    await supabase.from("sessions").update({ progress_message_id: msg.message_id, progress_chat_id: ctx.chat.id }).eq("id", session.id);
  }
});

// Callback: pack_start — user tapped "Попробовать" on template CTA
bot.action(/^pack_start:(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const templateId = ctx.match[1];

  // Verify template exists
  const { data: template } = await supabase
    .from("pack_templates")
    .select("*")
    .eq("id", templateId)
    .eq("is_active", true)
    .maybeSingle();

  if (!template) {
    await ctx.reply(
      lang === "ru" ? "Шаблон не найден." : "Template not found.",
      getMainMenuKeyboard(lang)
    );
    return;
  }

  // Check if user already has a photo (session or user-level last_photo)
  const existingSession = await getActiveSession(user.id);
  const existingPhoto = existingSession?.current_photo_file_id || user.last_photo_file_id || null;

  // Deactivate old sessions
  await supabase
    .from("sessions")
    .update({ is_active: false })
    .eq("user_id", user.id)
    .eq("is_active", true)
    .eq("env", config.appEnv);

  // Pick default style from style_presets_v2 for pack preview
  let selectedPackStyleId: string | null = null;
  try {
    const defaultPackStyle = await pickStyleForIdeas(user);
    selectedPackStyleId = defaultPackStyle?.id || null;
  } catch (e: any) {
    console.warn("Pack style preselect failed:", e.message);
  }

  // Create new session for pack flow
  const initialState = existingPhoto ? "wait_pack_preview_payment" : "wait_pack_photo";
  const { data: session, error: sessErr } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      state: initialState,
      is_active: true,
      pack_template_id: templateId,
      selected_style_id: selectedPackStyleId,
      current_photo_file_id: existingPhoto,
      photos: existingPhoto ? [existingPhoto] : [],
      env: config.appEnv,
    })
    .select()
    .single();

  if (sessErr || !session) {
    console.error("Failed to create pack session:", sessErr?.message);
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
    return;
  }

  if (existingPhoto) {
    // Photo already available — skip to style selection (pack flow: always Back to poses)
    await sendPackStyleSelectionStep(ctx, lang, session.selected_style_id, undefined, { useBackButton: true });
  } else {
    // No photo — ask user to send one
    await ctx.reply(await getText(lang, "pack.send_photo"), getMainMenuKeyboard(lang));
  }
});

// Callback: pack_show_carousel — step 2: show carousel of content sets
bot.action(/^pack_show_carousel:(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";
  const templateId = ctx.match[1];

  const { data: template } = await supabase.from("pack_templates").select("*").eq("id", templateId).eq("is_active", true).maybeSingle();
  if (!template) {
    await ctx.reply(lang === "ru" ? "Шаблон не найден." : "Template not found.", getMainMenuKeyboard(lang));
    return;
  }

  const { data: contentSets } = await supabase
    .from("pack_content_sets")
    .select("*")
    .eq("pack_template_id", templateId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (!contentSets?.length) {
    await ctx.reply(lang === "ru" ? "Наборы пока не готовы." : "Sets not ready yet.", getMainMenuKeyboard(lang));
    return;
  }

  await supabase.from("sessions").update({ is_active: false }).eq("user_id", user.id).eq("is_active", true).eq("env", config.appEnv);
  let selectedPackStyleId: string | null = null;
  try {
    const defaultPackStyle = await pickStyleForIdeas(user);
    selectedPackStyleId = defaultPackStyle?.id || null;
  } catch (_) {}

  const { data: session, error: sessErr } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      state: "wait_pack_carousel",
      is_active: true,
      pack_template_id: templateId,
      pack_carousel_index: 0,
      selected_style_id: selectedPackStyleId,
      env: config.appEnv,
    })
    .select()
    .single();
  if (sessErr || !session) {
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
    return;
  }

  const set = contentSets[0];
  const setName = lang === "ru" ? set.name_ru : set.name_en;
  const setDesc = lang === "ru" ? (set.carousel_description_ru || set.name_ru) : (set.carousel_description_en || set.name_en);
  const intro = await getText(lang, "pack.carousel_intro");
  const carouselCaption = `${intro}\n\n*${setName}*\n${setDesc}`;
  const tryBtn = await getText(lang, "pack.carousel_try_btn", { name: setName });
  const keyboard = {
    inline_keyboard: [
      [
        { text: "◀️", callback_data: "pack_carousel_prev" },
        { text: `1/${contentSets.length}`, callback_data: "pack_carousel_noop" },
        { text: "▶️", callback_data: "pack_carousel_next" },
      ],
      [{ text: tryBtn, callback_data: `pack_try:${set.id}` }],
    ],
  };
  await ctx.editMessageText(carouselCaption, { parse_mode: "Markdown", reply_markup: keyboard });
  await supabase
    .from("sessions")
    .update({
      progress_message_id: ctx.callbackQuery?.message?.message_id,
      progress_chat_id: ctx.chat?.id,
    })
    .eq("id", session.id);
});

bot.action("pack_carousel_noop", (ctx) => safeAnswerCbQuery(ctx));

bot.action("pack_carousel_prev", async (ctx) => {
  safeAnswerCbQuery(ctx);
  await updatePackCarouselCard(ctx, -1);
});
bot.action("pack_carousel_next", async (ctx) => {
  safeAnswerCbQuery(ctx);
  await updatePackCarouselCard(ctx, 1);
});

async function updatePackCarouselCard(ctx: any, delta: number) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";
  const session = await getPackFlowSession(user.id);
  if (!session || session.state !== "wait_pack_carousel" || !session.pack_template_id) return;

  const { data: contentSets } = await supabase
    .from("pack_content_sets")
    .select("*")
    .eq("pack_template_id", session.pack_template_id)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (!contentSets?.length) return;

  const currentIndex = (session.pack_carousel_index ?? 0) + delta;
  const idx = ((currentIndex % contentSets.length) + contentSets.length) % contentSets.length;
  const set = contentSets[idx];

  await supabase.from("sessions").update({ pack_carousel_index: idx }).eq("id", session.id);

  const setName = lang === "ru" ? set.name_ru : set.name_en;
  const setDesc = lang === "ru" ? (set.carousel_description_ru || set.name_ru) : (set.carousel_description_en || set.name_en);
  const intro = await getText(lang, "pack.carousel_intro");
  const carouselCaption = `${intro}\n\n*${setName}*\n${setDesc}`;
  const tryBtn = await getText(lang, "pack.carousel_try_btn", { name: setName });
  const keyboard = {
    inline_keyboard: [
      [
        { text: "◀️", callback_data: "pack_carousel_prev" },
        { text: `${idx + 1}/${contentSets.length}`, callback_data: "pack_carousel_noop" },
        { text: "▶️", callback_data: "pack_carousel_next" },
      ],
      [{ text: tryBtn, callback_data: `pack_try:${set.id}` }],
    ],
  };
  try {
    await ctx.editMessageText(carouselCaption, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch (_) {}
}

bot.action(/^pack_try:(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";
  const contentSetId = ctx.match[1];

  const session = await getPackFlowSession(user.id);
  if (!session || session.state !== "wait_pack_carousel") return;

  const existingPhoto = session.current_photo_file_id || (await supabase.from("users").select("last_photo_file_id").eq("id", user.id).single().then((r) => r.data?.last_photo_file_id)) || null;
  const initialState = existingPhoto ? "wait_pack_preview_payment" : "wait_pack_photo";

  await supabase
    .from("sessions")
    .update({
      state: initialState,
      pack_content_set_id: contentSetId,
      pack_carousel_index: null,
      current_photo_file_id: existingPhoto || null,
      photos: existingPhoto ? [existingPhoto] : [],
      is_active: true,
    })
    .eq("id", session.id);

  if (existingPhoto) {
    await sendPackStyleSelectionStep(ctx, lang, session.selected_style_id, session.progress_message_id ?? undefined, { useBackButton: true });
  } else {
    await ctx.reply(await getText(lang, "pack.send_photo"), getMainMenuKeyboard(lang));
  }
});

// Callback: pack_back_to_carousel — back from style selection to pose carousel (same message)
bot.action("pack_back_to_carousel", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";
  const session = await getPackFlowSession(user.id);
  if (!session || session.state !== "wait_pack_preview_payment" || !session.pack_template_id) return;

  const { data: contentSets } = await supabase
    .from("pack_content_sets")
    .select("*")
    .eq("pack_template_id", session.pack_template_id)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (!contentSets?.length) return;

  await supabase
    .from("sessions")
    .update({ state: "wait_pack_carousel", pack_carousel_index: 0 })
    .eq("id", session.id);

  const set = contentSets[0];
  const setName = lang === "ru" ? set.name_ru : set.name_en;
  const setDesc = lang === "ru" ? (set.carousel_description_ru || set.name_ru) : (set.carousel_description_en || set.name_en);
  const intro = await getText(lang, "pack.carousel_intro");
  const carouselCaption = `${intro}\n\n*${setName}*\n${setDesc}`;
  const tryBtn = await getText(lang, "pack.carousel_try_btn", { name: setName });
  const keyboard = {
    inline_keyboard: [
      [
        { text: "◀️", callback_data: "pack_carousel_prev" },
        { text: `1/${contentSets.length}`, callback_data: "pack_carousel_noop" },
        { text: "▶️", callback_data: "pack_carousel_next" },
      ],
      [{ text: tryBtn, callback_data: `pack_try:${set.id}` }],
    ],
  };
  if (session.progress_message_id && session.progress_chat_id) {
    try {
      await ctx.telegram.editMessageText(session.progress_chat_id, session.progress_message_id, undefined, carouselCaption, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (_) {}
  } else {
    const sent = await ctx.reply(carouselCaption, { parse_mode: "Markdown", reply_markup: keyboard });
    if (sent?.message_id && ctx.chat?.id) {
      await supabase.from("sessions").update({ progress_message_id: sent.message_id, progress_chat_id: ctx.chat.id }).eq("id", session.id);
    }
  }
});

// Callback: pack_preview_pay — user pays 1 credit for preview
bot.action("pack_preview_pay", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const session = await getPackFlowSession(user.id);
  if (!session || session.state !== "wait_pack_preview_payment") {
    return;
  }

  // Same prompt as single sticker: agent + composition suffix (unified flow)
  let packPromptFinal: string | null = null;
  let packStyleUserInput: string | null = null;
  if (session.selected_style_id) {
    const preset = await getStylePresetV2ById(session.selected_style_id);
    if (preset?.prompt_hint) {
      packStyleUserInput = preset.prompt_hint;
      const promptResult = await generatePrompt(packStyleUserInput);
      const stylePart =
        promptResult.ok && !promptResult.retry
          ? (promptResult.prompt || packStyleUserInput)
          : packStyleUserInput;
      packPromptFinal = stylePart + COMPOSITION_SUFFIX;
    }
  }

  // Load template to get sticker_count
  const { data: packTemplate } = await supabase
    .from("pack_templates")
    .select("sticker_count")
    .eq("id", session.pack_template_id)
    .maybeSingle();
  const packSize = packTemplate?.sticker_count || 4;

  // Check credits
  if ((user.credits || 0) < 1) {
    await ctx.reply(await getText(lang, "pack.not_enough_credits"), getMainMenuKeyboard(lang));
    await sendBuyCreditsMenu(ctx, user);
    return;
  }

  // Deduct 1 credit atomically
  const { data: deducted } = await supabase.rpc("deduct_credits", {
    p_user_id: user.id,
    p_amount: 1,
  });

  if (!deducted) {
    await ctx.reply(await getText(lang, "pack.not_enough_credits"), getMainMenuKeyboard(lang));
    await sendBuyCreditsMenu(ctx, user);
    return;
  }

  // Create pack_batch
  const { data: batch, error: batchErr } = await supabase
    .from("pack_batches")
    .insert({
      session_id: session.id,
      user_id: user.id,
      template_id: session.pack_template_id,
      size: packSize,
      status: "preview",
      credits_spent: 1,
      env: config.appEnv,
    })
    .select()
    .single();

  if (batchErr || !batch) {
    console.error("Failed to create pack_batch:", batchErr?.message);
    // Refund credit
    const { data: refUser } = await supabase.from("users").select("credits").eq("id", user.id).maybeSingle();
    await supabase.from("users").update({ credits: (refUser?.credits || 0) + 1 }).eq("id", user.id);
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
    return;
  }

  // Update session (must set prompt_final so worker uses correct style)
  const sessionUpdate = {
    state: "generating_pack_preview",
    pack_batch_id: batch.id,
    prompt_final: packPromptFinal,
    user_input: packStyleUserInput,
    is_active: true,
  };
  const { error: updateErr } = await supabase
    .from("sessions")
    .update(sessionUpdate)
    .eq("id", session.id);
  if (updateErr) {
    console.error("[pack_preview_pay] Session update failed:", updateErr.message);
    const { data: refUser } = await supabase.from("users").select("credits").eq("id", user.id).maybeSingle();
    await supabase.from("users").update({ credits: (refUser?.credits || 0) + 1 }).eq("id", user.id);
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
    return;
  }
  console.log("[pack_preview_pay] session.prompt_final saved, length:", (packPromptFinal || "").length, "preview:", (packPromptFinal || "").slice(0, 120));
  console.log("[pack_preview_pay] session.pack_content_set_id:", session.pack_content_set_id ?? "(not set)");

  // Enqueue pack_preview job
  await supabase.from("jobs").insert({
    session_id: session.id,
    user_id: user.id,
    pack_batch_id: batch.id,
    status: "queued",
    attempts: 0,
    env: config.appEnv,
  });

  // Send progress message
  const msg = await ctx.reply(await getText(lang, "pack.progress_generating"));
  if (msg?.message_id && ctx.chat?.id) {
    await supabase
      .from("sessions")
      .update({ progress_message_id: msg.message_id, progress_chat_id: ctx.chat.id })
      .eq("id", session.id);
  }

  // Alert
  sendAlert({
    type: "pack_preview_ordered",
    message: "Pack preview ordered",
    details: {
      user: `@${user.username || user.telegram_id}`,
      template: session.pack_template_id,
      batchId: batch.id,
    },
  }).catch(console.error);
});

// Callback: pack_approve — user approves preview, pays remaining credits
bot.action("pack_approve", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const session = await getPackFlowSession(user.id);
  if (!session || session.state !== "wait_pack_approval") {
    return;
  }

  // Get template for sticker count
  const { data: template } = await supabase
    .from("pack_templates")
    .select("sticker_count")
    .eq("id", session.pack_template_id)
    .maybeSingle();

  const stickerCount = template?.sticker_count || 4;
  const remainingCredits = stickerCount - 1; // already paid 1 for preview

  // Check credits
  if ((user.credits || 0) < remainingCredits) {
    await ctx.reply(await getText(lang, "pack.not_enough_credits"), getMainMenuKeyboard(lang));
    await sendBuyCreditsMenu(ctx, user);
    return;
  }

  // Deduct remaining credits
  const { data: deducted } = await supabase.rpc("deduct_credits", {
    p_user_id: user.id,
    p_amount: remainingCredits,
  });

  if (!deducted) {
    await ctx.reply(await getText(lang, "pack.not_enough_credits"), getMainMenuKeyboard(lang));
    await sendBuyCreditsMenu(ctx, user);
    return;
  }

  // Update batch
  await supabase
    .from("pack_batches")
    .update({
      status: "approved",
      credits_spent: stickerCount,
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.pack_batch_id);

  // Update session
  await supabase
    .from("sessions")
    .update({ state: "processing_pack", is_active: true })
    .eq("id", session.id);

  // Enqueue pack_assemble job
  await supabase.from("jobs").insert({
    session_id: session.id,
    user_id: user.id,
    pack_batch_id: session.pack_batch_id,
    status: "queued",
    attempts: 0,
    env: config.appEnv,
  });

  // Send progress
  const msg = await ctx.reply(await getText(lang, "pack.progress_assembling"));
  if (msg?.message_id && ctx.chat?.id) {
    await supabase
      .from("sessions")
      .update({ progress_message_id: msg.message_id, progress_chat_id: ctx.chat.id })
      .eq("id", session.id);
  }

  sendAlert({
    type: "pack_approved",
    message: "Pack approved",
    details: {
      user: `@${user.username || user.telegram_id}`,
      template: session.pack_template_id,
      batchId: session.pack_batch_id,
      credits: stickerCount,
    },
  }).catch(console.error);
});

// Callback: pack_regenerate — user wants new preview (pays 1 more credit)
bot.action("pack_regenerate", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const session = await getPackFlowSession(user.id);
  if (!session || session.state !== "wait_pack_approval") {
    return;
  }

  // Check credits
  if ((user.credits || 0) < 1) {
    await ctx.reply(await getText(lang, "pack.not_enough_credits"), getMainMenuKeyboard(lang));
    await sendBuyCreditsMenu(ctx, user);
    return;
  }

  // Deduct 1 credit
  const { data: deducted } = await supabase.rpc("deduct_credits", {
    p_user_id: user.id,
    p_amount: 1,
  });

  if (!deducted) {
    await ctx.reply(await getText(lang, "pack.not_enough_credits"), getMainMenuKeyboard(lang));
    await sendBuyCreditsMenu(ctx, user);
    return;
  }

  // Update batch credits_spent
  const { data: batch } = await supabase
    .from("pack_batches")
    .select("credits_spent")
    .eq("id", session.pack_batch_id)
    .maybeSingle();

  await supabase
    .from("pack_batches")
    .update({
      credits_spent: (batch?.credits_spent || 1) + 1,
      status: "preview",
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.pack_batch_id);

  // Update session (clear sheet so new preview gets its own; pack_sheet_cleaned set by worker)
  await supabase
    .from("sessions")
    .update({
      state: "generating_pack_preview",
      pack_sheet_file_id: null,
      pack_sheet_cleaned: false,
      is_active: true,
    })
    .eq("id", session.id);

  // Enqueue new preview job
  await supabase.from("jobs").insert({
    session_id: session.id,
    user_id: user.id,
    pack_batch_id: session.pack_batch_id,
    status: "queued",
    attempts: 0,
    env: config.appEnv,
  });

  const msg = await ctx.reply(await getText(lang, "pack.progress_generating"));
  if (msg?.message_id && ctx.chat?.id) {
    await supabase
      .from("sessions")
      .update({ progress_message_id: msg.message_id, progress_chat_id: ctx.chat.id })
      .eq("id", session.id);
  }

  sendAlert({
    type: "pack_regenerated",
    message: "Pack preview regenerated",
    details: {
      user: `@${user.username || user.telegram_id}`,
      template: session.pack_template_id,
      batchId: session.pack_batch_id,
    },
  }).catch(console.error);
});

// Callback: pack_back — from preview back to style selection (no cancel)
bot.action("pack_back", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const session = await getPackFlowSession(user.id);
  if (!session || session.state !== "wait_pack_approval") return;

  await supabase
    .from("sessions")
    .update({ state: "wait_pack_preview_payment", is_active: true })
    .eq("id", session.id);
  try { await ctx.deleteMessage(); } catch {}
  await sendPackStyleSelectionStep(ctx, lang, session.selected_style_id, undefined, { useBackButton: true });
});

// Callback: pack_cancel — user cancels pack
bot.action("pack_cancel", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const session = await getPackFlowSession(user.id);
  if (!session || !["wait_pack_approval", "wait_pack_preview_payment"].includes(session.state)) {
    return;
  }

  // Cancel batch if exists
  if (session.pack_batch_id) {
    await supabase
      .from("pack_batches")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", session.pack_batch_id);
  }

  // Deactivate session
  await supabase
    .from("sessions")
    .update({ state: "canceled", is_active: false })
    .eq("id", session.id);

  await ctx.reply(await getText(lang, "pack.cancelled"), getMainMenuKeyboard(lang));
});

// Text handler (style description)
bot.on("text", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // === Admin reply to outreach: intercept text from admin ===
  if (pendingAdminReplies.has(telegramId)) {
    const replyText = ctx.message.text?.trim();

    // Cancel command
    if (replyText === "/cancel") {
      pendingAdminReplies.delete(telegramId);
      await ctx.reply("❌ Отменено");
      return;
    }

    const pending = pendingAdminReplies.get(telegramId)!;
    pendingAdminReplies.delete(telegramId);

    if (!replyText) {
      await ctx.reply("❌ Пустое сообщение, отменено");
      return;
    }

    try {
      // Send reply to user via main bot
      await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
        chat_id: pending.userTelegramId,
        text: replyText,
      });

      // Update outreach in DB
      await supabase
        .from("user_outreach")
        .update({
          admin_reply_text: replyText,
          admin_replied_at: new Date().toISOString(),
          status: "admin_replied",
        })
        .eq("id", pending.outreachId);

      await ctx.reply(`✅ Ответ отправлен @${pending.username}`);

      // Also post confirmation to alert channel
      if (config.alertChannelId) {
        const confirmText =
          `✅ *Админ ответил на outreach*\n\n` +
          `👤 @${escapeMarkdownForAlert(pending.username)}\n` +
          `💬 "${escapeMarkdownForAlert(replyText.slice(0, 300))}"`;

        await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
          chat_id: config.alertChannelId,
          text: confirmText,
          parse_mode: "Markdown",
        }).catch(() => {});
      }

      console.log("[AdminReply] Sent to:", pending.userTelegramId, "text:", replyText.slice(0, 50));
    } catch (err: any) {
      console.error("[AdminReply] Failed to send:", err.response?.data || err.message);
      const errMsg = err.response?.data?.description || err.message;
      await ctx.reply(`❌ Не удалось отправить: ${errMsg}`);
    }
    return;
  }

  if (ctx.message.text?.startsWith("/")) return;

  // Skip menu button texts — they are handled by bot.hears() above
  const menuButtons = [
    "🤖 1 стикер", "🤖 1 sticker",
    "🎨 Стили", "🎨 Styles", // legacy, button hidden
    "📦 Пак стикеров", "📦 Sticker pack",
    "💰 Баланс", "💰 Balance",
    "❓",
  ];
  if (menuButtons.includes(ctx.message.text?.trim())) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.id) {
    await ctx.reply(await getText(lang, "start.need_start"));
    return;
  }

  // === Pack states: ignore text input during pack flow ===
  if (session.state?.startsWith("wait_pack_") || session.state === "generating_pack_preview" || session.state === "processing_pack") {
    return;
  }

  // === Custom Idea: intercept text when waiting for user concept ===
  if (session.waiting_custom_idea) {
    const userConcept = ctx.message.text.trim();
    console.log("[CustomIdea] User concept:", userConcept);

    // Reset flag immediately
    await supabase.from("sessions").update({ waiting_custom_idea: false }).eq("id", session.id);

    // Show thinking
    const thinkingMsg = await ctx.reply(lang === "ru" ? "💡 Думаю..." : "💡 Thinking...");

    // Get sticker file ID
    const stickerFileId = session.last_sticker_file_id;
    if (!stickerFileId) {
      await ctx.reply(lang === "ru" ? "⚠️ Сначала сгенерируй стикер" : "⚠️ Generate a sticker first");
      return;
    }

    // Generate custom idea
    let idea: StickerIdea;
    try {
      idea = await generateCustomIdea({
        stickerFileId,
        stylePresetId: session.selected_style_id,
        lang,
        userConcept,
      });
      console.log("[CustomIdea] Generated:", idea.titleEn, "category:", idea.category);
    } catch (err: any) {
      console.error("[CustomIdea] Error:", err.message);
      idea = getDefaultIdeaForConcept(userConcept, lang);
    }

    // Save custom idea to session
    const { error: saveErr } = await supabase.from("sessions").update({
      custom_idea: idea,
    }).eq("id", session.id);
    if (saveErr) console.error("[CustomIdea] save failed:", saveErr.message);

    // Format and show
    const title = lang === "ru" ? idea.titleRu : idea.titleEn;
    const desc = lang === "ru" ? idea.descriptionRu : idea.descriptionEn;
    const textHint = idea.hasText && idea.textSuggestion
      ? `\n💬 «${idea.textSuggestion}»`
      : "";

    const ideaText = `✏️ <b>${lang === "ru" ? "Твоя идея" : "Your idea"}:</b>\n\n`
      + `${idea.emoji} <b>${title}</b>\n`
      + `${desc}${textHint}`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: lang === "ru" ? "🎨 Сгенерить (1💎)" : "🎨 Generate (1💎)", callback_data: "idea_generate_custom" },
          { text: lang === "ru" ? "✏️ Ещё слово" : "✏️ Another word", callback_data: "custom_idea" },
        ],
        [
          { text: lang === "ru" ? "↩️ Назад к идеям" : "↩️ Back to ideas", callback_data: "idea_back" },
        ],
      ],
    };

    // Delete thinking message and send result
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, thinkingMsg.message_id);
    } catch {}

    await ctx.reply(ideaText, { parse_mode: "HTML", reply_markup: keyboard });
    return;
  }

  // === AI Assistant: re-route to assistant after sticker generation ===
  // If user was in assistant flow and sticker was generated, session.state moved to
  // confirm_sticker/wait_style/etc. but assistant_session is still active.
  // Route text back to assistant so user can request changes or continue dialog.
  if (!session.state?.startsWith("assistant_") && !["processing", "processing_emotion", "processing_motion", "processing_text", "wait_text_overlay"].includes(session.state)) {
    let activeAssistant = await getActiveAssistantSession(user.id);
    console.log("Re-route check: state=", session.state, "activeAssistant=", activeAssistant?.id || "null", "status=", activeAssistant?.status || "n/a");

    // Fallback: if no active session found, check for recently-updated session (may have been unexpectedly closed)
    if (!activeAssistant) {
      const recent = await getRecentAssistantSession(user.id);
      if (recent) {
        console.log("Re-route fallback: found recent session", recent.id, "status:", recent.status, "updated:", recent.updated_at);
        // Reactivate it so the user can continue dialog
        await reactivateAssistantSession(recent.id);
        activeAssistant = { ...recent, status: "active" };
      }
    }

    if (activeAssistant) {
      console.log("Assistant re-route: state was", session.state, "→ switching to assistant_chat, aSession:", activeAssistant.id);
      await supabase.from("sessions")
        .update({ state: "assistant_chat", is_active: true })
        .eq("id", session.id);
      // Update local session object for downstream handlers
      session.state = "assistant_chat";
      session.is_active = true;
    }
  }

  // === AI Assistant: waiting for photo but got text — forward to AI ===
  // AI will respond naturally (about goal) and remind about photo when appropriate
  if (session.state === "assistant_wait_photo") {
    console.log("Assistant wait_photo text: session:", session.id, "is_active:", session.is_active);
    if (!session.is_active) {
      await supabase.from("sessions").update({ is_active: true }).eq("id", session.id);
    }
    const aSession = await getActiveAssistantSession(user.id);
    if (!aSession) { console.error("assistant_wait_photo: no assistant_session"); return; }

    const userText = ctx.message.text.trim();
    const messages: AssistantMessage[] = Array.isArray(aSession.messages) ? [...aSession.messages] : [];
    messages.push({ role: "user", content: userText });

    const systemPrompt = await getAssistantSystemPrompt(messages, aSession, {
      credits: user.credits || 0,
      hasPurchased: !!user.has_purchased,
      totalGenerations: user.total_generations || 0,
      utmSource: user.utm_source,
      utmMedium: user.utm_medium,
    });

    try {
      const result = await callAIChat(messages, systemPrompt);
      messages.push({ role: "assistant", content: result.text });

      // Extract goal from early conversation (before photo)
      const goalUpdate: Partial<AssistantSessionRow> = {};
      if (!aSession.goal) {
        goalUpdate.goal = userText; // User's first text is likely the goal
      }

      // Process tool call (may get request_photo or show_examples)
      let toolUpdates: Partial<AssistantSessionRow> = {};
      let toolAction: import("./lib/assistant-db").ToolAction | "none" = "none";
      if (result.toolCall) {
        console.log("[Assistant] wait_photo tool call:", result.toolCall.name);
        const { updates, action: ta } = handleToolCall(result.toolCall, aSession);
        toolUpdates = updates;
        toolAction = ta;
      }

      await updateAssistantSession(aSession.id, {
        messages,
        ...toolUpdates,
        ...goalUpdate,
      });

      if (toolAction === "show_examples") {
        const styleId = result.toolCall?.args?.style_id;
        await handleShowStyleExamples(ctx, styleId, lang);
        if (result.text) await ctx.reply(result.text, getMainMenuKeyboard(lang));
      } else if (toolAction === "grant_credit" || toolAction === "deny_credit") {
        const freshUserWP = await getUser(user.telegram_id);
        const mergedSession = { ...aSession, ...toolUpdates, ...goalUpdate } as AssistantSessionRow;
        if (freshUserWP && (freshUserWP.credits || 0) > 0) {
          if (allParamsCollected(mergedSession)) {
            console.log("[wait_photo_text] User has credits, params complete — generating");
            if (result.text) await ctx.reply(result.text);
            await handleAssistantConfirm(ctx, freshUserWP, session.id, lang);
          } else {
            console.log("[wait_photo_text] User has credits but params not complete — continuing dialog");
            const paramsPrompt = generateFallbackReply("normal", mergedSession, lang);
            messages[messages.length - 1] = { role: "assistant", content: paramsPrompt };
            await updateAssistantSession(aSession.id, { messages });
            await ctx.reply(paramsPrompt, getMainMenuKeyboard(lang));
          }
        } else {
          await handleTrialCreditAction(ctx, toolAction as "grant_credit" | "deny_credit", result, freshUserWP || user, session, result.text, lang);
        }
      } else if (toolAction === "check_balance") {
        const freshUserBal3 = await getUser(user.telegram_id);
        const u3 = freshUserBal3 || user;
        const balanceInfo3 = buildBalanceInfo(u3, lang);
        console.log("[wait_photo_text] check_balance:", u3.credits);
        messages.push({ role: "assistant", content: balanceInfo3 });
        await updateAssistantSession(aSession.id, { messages });
        const sp3 = await getAssistantSystemPrompt(messages, aSession, {
          credits: u3.credits || 0, hasPurchased: !!u3.has_purchased, totalGenerations: u3.total_generations || 0,
          utmSource: u3.utm_source, utmMedium: u3.utm_medium,
        });
        const r3 = await callAIChat(messages, sp3);
        messages.push({ role: "assistant", content: r3.text || "" });
        await updateAssistantSession(aSession.id, { messages });
        if (r3.text) await ctx.reply(r3.text, getMainMenuKeyboard(lang));
      } else {
        const replyText = result.text || (lang === "ru"
          ? "Понял! Пришли фото для стикера 📸"
          : "Got it! Send me a photo for the sticker 📸");
        await ctx.reply(replyText, getMainMenuKeyboard(lang));
      }
    } catch (err: any) {
      console.error("Assistant wait_photo text AI error:", err.message);
      const reminder = lang === "ru"
        ? "Понял! А теперь пришли фото — из которого сделаем стикер 📸"
        : "Got it! Now send me a photo — I'll turn it into a sticker 📸";
      messages.push({ role: "assistant", content: reminder });

      await updateAssistantSession(aSession.id, { messages });

      await ctx.reply(reminder, getMainMenuKeyboard(lang));
    }
    return;
  }

  // === AI Assistant: active dialog (handles all: collecting params, confirming, changing) ===
  if (session.state === "assistant_chat") {
    console.log("Assistant chat: text received, session:", session.id, "user:", user.id, "is_active:", session.is_active);
    // Ensure is_active stays true (some DB setups reset it on update)
    if (!session.is_active) {
      await supabase.from("sessions").update({ is_active: true }).eq("id", session.id);
    }
    const aSession = await getActiveAssistantSession(user.id);
    if (!aSession) { console.error("assistant_chat: no assistant_session"); return; }
    console.log("Assistant chat: aSession found:", aSession.id, "style:", aSession.style, "emotion:", aSession.emotion, "pose:", aSession.pose);

    const userText = ctx.message.text.trim();
    const messages: AssistantMessage[] = Array.isArray(aSession.messages) ? [...aSession.messages] : [];
    messages.push({ role: "user", content: userText });

    // Build system prompt with state injection (tells LLM what's collected, including trial budget)
    const systemPrompt = await getAssistantSystemPrompt(messages, aSession, {
      credits: user.credits || 0,
      hasPurchased: !!user.has_purchased,
      totalGenerations: user.total_generations || 0,
      utmSource: user.utm_source,
      utmMedium: user.utm_medium,
    });

    // Track error count
    const errorCount = aSession.error_count || 0;

    try {
      console.log("Assistant chat: calling AI, messages count:", messages.length);
      const result = await callAIChat(messages, systemPrompt);
      console.log("Assistant chat: AI response received, text length:", result.text.length, "toolCall:", result.toolCall?.name || "none");
      messages.push({ role: "assistant", content: result.text });

      const { action, updatedSession } = await processAssistantResult(result, aSession, messages);
      console.log("Assistant chat: processResult done, action:", action);

      // Generate fallback text if LLM returned only a tool call (no text)
      let replyText = result.text;
      if (!replyText && result.toolCall) {
        replyText = generateFallbackReply(action, updatedSession, lang);
        console.log("Assistant chat: using fallback reply, length:", replyText.length);
        // Update messages with fallback text
        messages[messages.length - 1] = { role: "assistant", content: replyText };
        await updateAssistantSession(aSession.id, { messages });
      }

      console.log("Assistant chat: sending reply, action:", action, "replyText length:", replyText?.length || 0);

      // Race condition guard: re-check session state after AI call (user may have switched modes)
      const freshSession = await getActiveSession(user.id);
      if (freshSession && freshSession.state !== "assistant_chat") {
        console.log("Assistant chat: session state changed to", freshSession.state, "during AI call — skipping reply");
        return;
      }

      try {
        if (action === "confirm") {
          // LLM decided user confirmed — trigger generation
          if (replyText) await ctx.reply(replyText);
          await handleAssistantConfirm(ctx, user, session.id, lang);
        } else if (action === "show_mirror") {
          // All params collected — show mirror + confirm button
          const mirror = buildMirrorMessage(updatedSession, lang);
          await ctx.reply(mirror);
          await ctx.reply(
            lang === "ru" ? "Всё верно?" : "Is everything correct?",
            Markup.inlineKeyboard([
              [Markup.button.callback(
                lang === "ru" ? "✅ Подтвердить" : "✅ Confirm",
                "assistant_confirm"
              )],
            ])
          );
        } else if (action === "photo") {
          // LLM wants a photo — switch state
          await supabase
            .from("sessions")
            .update({ state: "assistant_wait_photo", is_active: true })
            .eq("id", session.id);
          if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
        } else if (action === "show_examples") {
          // Show style examples to help user choose
          const styleId = result.toolCall?.args?.style_id;
          await handleShowStyleExamples(ctx, styleId, lang);
          // Send LLM reply text after examples (if any)
          if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
        } else if (action === "grant_credit" || action === "deny_credit") {
          // Re-fetch user to get fresh credits (user may have purchased during conversation)
          const freshUser = await getUser(user.telegram_id);
          if (freshUser && (freshUser.credits || 0) > 0) {
            if (allParamsCollected(updatedSession)) {
              console.log("[assistant_chat] User has credits, params complete — generating");
              if (replyText) await ctx.reply(replyText);
              await handleAssistantConfirm(ctx, freshUser, session.id, lang);
            } else {
              console.log("[assistant_chat] User has credits but params not complete — continuing dialog");
              const paramsPrompt = generateFallbackReply("normal", updatedSession, lang);
              messages[messages.length - 1] = { role: "assistant", content: paramsPrompt };
              await updateAssistantSession(aSession.id, { messages });
              await ctx.reply(paramsPrompt, getMainMenuKeyboard(lang));
            }
          } else {
            await handleTrialCreditAction(ctx, action, result, freshUser || user, session, replyText, lang);
          }
        } else if (action === "check_balance") {
          // Fetch fresh user data and build balance info
          const freshUserBal = await getUser(user.telegram_id);
          const u = freshUserBal || user;
          const balanceInfo = buildBalanceInfo(u, lang);
          console.log("[assistant_chat] check_balance:", balanceInfo.split("\n").slice(0, 3).join(", "));

          // Add balance data to conversation and call AI again for natural response
          messages.push({ role: "assistant", content: balanceInfo });
          const systemPrompt2 = await getAssistantSystemPrompt(messages, aSession, {
            credits: u.credits || 0,
            hasPurchased: !!u.has_purchased,
            totalGenerations: u.total_generations || 0,
            utmSource: u.utm_source,
            utmMedium: u.utm_medium,
          });
          const result2 = await callAIChat(messages, systemPrompt2);
          messages.push({ role: "assistant", content: result2.text || "" });
          await updateAssistantSession(aSession.id, { messages });

          // Process the follow-up response (may contain another tool call)
          const { action: action2, updatedSession: uSession2 } = await processAssistantResult(result2, aSession, messages);
          const reply2 = result2.text || generateFallbackReply(action2, uSession2, lang);

          if (action2 === "confirm") {
            if (reply2) await ctx.reply(reply2);
            await handleAssistantConfirm(ctx, u, session.id, lang);
          } else {
            if (reply2) await ctx.reply(reply2, getMainMenuKeyboard(lang));
          }
        } else {
          // Normal dialog step
          if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
        }
        console.log("Assistant chat: reply sent to user, action:", action);
      } catch (replyErr: any) {
        console.error("Assistant chat: REPLY ERROR:", replyErr?.message || replyErr, "code:", replyErr?.code, "description:", replyErr?.description);
        // Try plain text fallback without keyboard
        try {
          if (replyText) await ctx.reply(replyText);
          console.log("Assistant chat: plain reply sent after error");
        } catch (plainErr: any) {
          console.error("Assistant chat: PLAIN REPLY ALSO FAILED:", plainErr?.message);
        }
      }
    } catch (err: any) {
      console.error("Assistant chat AI error:", err.message, err?.response?.status, err?.response?.data?.error?.message);
      const newErrorCount = errorCount + 1;

      await updateAssistantSession(aSession.id, { error_count: newErrorCount });

      if (newErrorCount >= 3) {
        // Level 3: escape to manual mode
        await closeAssistantSession(aSession.id, "error");
        const escapeMsg = lang === "ru"
          ? "К сожалению, помощник временно недоступен 😔\nПопробуй отправить фото ещё раз или позже."
          : "Unfortunately, the assistant is temporarily unavailable 😔\nTry sending a photo again or later.";
        await ctx.reply(escapeMsg, getMainMenuKeyboard(lang));
      } else {
        // Level 2: soft fallback
        const retryMsg = lang === "ru"
          ? "Произошла ошибка, попробуй написать ещё раз."
          : "Something went wrong, please try again.";
        await ctx.reply(retryMsg, getMainMenuKeyboard(lang));
      }

      sendAlert({
        type: "assistant_gemini_error" as any,
        message: `Assistant AI error (attempt ${newErrorCount})`,
        details: {
          user: `@${user.username || user.telegram_id}`,
          sessionId: session.id,
          error: err.message?.slice(0, 200),
        },
      }).catch(console.error);
    }
    return;
  }

  if (session.state === "wait_custom_emotion") {
    const emotionText = ctx.message.text.trim();
    if (!session.last_sticker_file_id) {
      await ctx.reply(await getText(lang, "error.no_stickers_added"));
      return;
    }

    const emotionTemplate = await getPromptTemplate("emotion");
    const promptFinal = buildPromptFromTemplate(emotionTemplate, emotionText);
    await startGeneration(ctx, user, session, lang, {
      generationType: "emotion",
      promptFinal,
      emotionPrompt: emotionText,
      selectedEmotion: emotionText,
    });
    return;
  }

  if (session.state === "wait_custom_motion") {
    const motionText = ctx.message.text.trim();
    if (!session.last_sticker_file_id) {
      await ctx.reply(await getText(lang, "error.no_stickers_added"));
      return;
    }

    const motionTemplate = await getPromptTemplate("motion");
    const promptFinal = buildPromptFromTemplate(motionTemplate, motionText);
    await startGeneration(ctx, user, session, lang, {
      generationType: "motion",
      promptFinal,
      emotionPrompt: motionText,
      selectedEmotion: motionText,
    });
    return;
  }

  // Programmatic text overlay (no AI, no credits)
  if (session.state === "wait_text_overlay") {
    const textInput = ctx.message.text.trim();
    if (!session.last_sticker_file_id) {
      await ctx.reply(await getText(lang, "error.no_stickers_added"));
      return;
    }

    if (!textInput) {
      await ctx.reply(lang === "ru"
        ? "✏️ Напиши текст для стикера:"
        : "✏️ Type the text for the sticker:");
      return;
    }

    const stickerId = session.user_input; // sticker UUID stored when button was clicked
    const processingMsg = await ctx.reply(lang === "ru" ? "✏️ Добавляю текст..." : "✏️ Adding text...");

    try {
      // Download current sticker via Telegram API
      const filePath = await getFilePath(session.last_sticker_file_id);
      const stickerBuffer = await downloadFile(filePath);
      console.log("text_overlay: downloaded sticker, size:", stickerBuffer.length);

      // Add text overlay via Sharp + SVG
      const textBuffer = await addTextToSticker(stickerBuffer, textInput, "bottom");
      console.log("text_overlay: result buffer size:", textBuffer.length);

      // Build buttons (same as post-generation)
      const btnStickerId = stickerId || "unknown";
      const replyMarkup = await buildStickerButtons(lang, btnStickerId);

      // Send sticker with text overlay
      const newFileId = await sendSticker(user.telegram_id, textBuffer, replyMarkup);
      console.log("text_overlay: sent sticker, new file_id:", newFileId?.substring(0, 30) + "...");

      // Update telegram_file_id in DB
      if (newFileId && stickerId) {
        await supabase
          .from("stickers")
          .update({ telegram_file_id: newFileId })
          .eq("id", stickerId);
        console.log("text_overlay: updated sticker telegram_file_id");
      }

      // Delete processing message
      try {
        await ctx.deleteMessage(processingMsg.message_id);
      } catch (_) {}
    } catch (err: any) {
      console.error("text_overlay error:", err.message);
      try { await ctx.deleteMessage(processingMsg.message_id); } catch (_) {}
      await ctx.reply(lang === "ru"
        ? "❌ Не удалось добавить текст. Попробуйте ещё раз."
        : "❌ Failed to add text. Please try again.");
    }
    return;
  }

  // Legacy AI text generation (fallback for old sessions)
  if (session.state === "wait_text") {
    const textInput = ctx.message.text.trim();
    if (!session.last_sticker_file_id) {
      await ctx.reply(await getText(lang, "error.no_stickers_added"));
      return;
    }

    const textTemplate = await getPromptTemplate("text");
    const promptFinal = buildPromptFromTemplate(textTemplate, textInput);
    await startGeneration(ctx, user, session, lang, {
      generationType: "text",
      promptFinal,
      textPrompt: textInput,
    });
    return;
  }

  if (session.state === "wait_custom_style") {
    const styleText = ctx.message.text.trim();
    const photos = Array.isArray(session.photos) ? session.photos : [];
    const currentPhotoId = session.current_photo_file_id || photos[photos.length - 1];
    if (!currentPhotoId) {
      await ctx.reply(await getText(lang, "photo.need_photo"));
      return;
    }

    // Generate prompt using LLM with user's custom style
    await ctx.reply(await getText(lang, "photo.processing"));
    const promptResult = await generatePrompt(styleText);

    if (!promptResult.ok || promptResult.retry) {
      await ctx.reply(await getText(lang, "photo.invalid_style"));
      return;
    }

    const generatedPrompt = promptResult.prompt || styleText;
    await startGeneration(ctx, user, session, lang, {
      generationType: "style",
      promptFinal: generatedPrompt,
      userInput: styleText,
      selectedStyleId: "custom",
    });
    return;
  }

  // Handle custom style v2 (same logic, different state name)
  if (session.state === "wait_custom_style_v2") {
    const styleText = ctx.message.text.trim();
    const photos = Array.isArray(session.photos) ? session.photos : [];
    const currentPhotoId = session.current_photo_file_id || photos[photos.length - 1];
    if (!currentPhotoId) {
      await ctx.reply(await getText(lang, "photo.need_photo"));
      return;
    }

    await ctx.reply(await getText(lang, "photo.processing"));
    const promptResult = await generatePrompt(styleText);

    if (!promptResult.ok || promptResult.retry) {
      await ctx.reply(await getText(lang, "photo.invalid_style"));
      return;
    }

    const generatedPrompt = promptResult.prompt || styleText;
    await startGeneration(ctx, user, session, lang, {
      generationType: "style",
      promptFinal: generatedPrompt,
      userInput: styleText,
      selectedStyleId: "custom_v2",
    });
    return;
  }

  // Check if we're in wait_style state
  if (session.state !== "wait_style") {
    if (session.state === "wait_photo") {
      await ctx.reply(await getText(lang, "photo.need_photo"));
    } else if (session.state === "wait_emotion") {
      await ctx.reply(await getText(lang, "emotion.choose"));
    } else if (session.state === "confirm_sticker") {
      // User sent text after sticker generation but re-route didn't find an assistant session
      // Suggest they start a new assistant dialog or use manual mode
      console.log("confirm_sticker text fallback: user sent text but no active assistant. Text:", ctx.message.text?.slice(0, 50));
      const msg = lang === "ru"
        ? "Нажми «1 стикер», чтобы создать новый стикер."
        : "Tap «1 sticker» to create a new sticker.";
      await ctx.reply(msg, getMainMenuKeyboard(lang));
    }
    return;
  }

  const photos = Array.isArray(session.photos) ? session.photos : [];
  const currentPhotoId = session.current_photo_file_id || photos[photos.length - 1];
  if (!currentPhotoId) {
    await ctx.reply(await getText(lang, "photo.need_photo"));
    return;
  }

  // Generate prompt using LLM
  await ctx.reply(await getText(lang, "photo.processing"));

  const promptResult = await generatePrompt(ctx.message.text);

  if (!promptResult.ok || promptResult.retry) {
    await ctx.reply(await getText(lang, "photo.invalid_style"));
    return;
  }

  const generatedPrompt = promptResult.prompt || ctx.message.text;
  const userInput = ctx.message.text;

  await startGeneration(ctx, user, session, lang, {
    generationType: "style",
    promptFinal: generatedPrompt,
    userInput,
  });
});

// Callback: style selection (legacy v1 — excludes style_v2, style_example, style_custom, style_group)
bot.action(/^style_(?!v2:|example|custom|group)([^:]+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    console.log("Style callback triggered, telegramId:", telegramId);
    if (!telegramId) return;

    const user = await getUser(telegramId);
    console.log("Style callback - User:", user?.id, "credits:", user?.credits);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const session = await getActiveSession(user.id);
    console.log("Style callback - Session:", session?.id, "state:", session?.state);
    if (!session?.id || session.state !== "wait_style") {
      console.log("Session state mismatch, expected wait_style");
      return;
    }

    const styleId = ctx.match[1];
    console.log("Style ID:", styleId);
    const presets = await getStylePresets();
    const preset = presets.find((p) => p.id === styleId);
    if (!preset) {
      console.log("Preset not found for:", styleId);
      return;
    }

    // Handle custom style - ask user to describe
    if (preset.id === "custom") {
      await supabase
        .from("sessions")
        .update({ state: "wait_custom_style", is_active: true })
        .eq("id", session.id);
      await ctx.reply(await getText(lang, "style.custom_prompt"));
      return;
    }

    const photos = Array.isArray(session.photos) ? session.photos : [];
    const currentPhotoId = session.current_photo_file_id || photos[photos.length - 1];
    if (!currentPhotoId) {
    await ctx.reply(await getText(lang, "photo.need_photo"));
    return;
  }

  // Use prompt_hint as userInput
  const userInput = preset.prompt_hint;

  // Generate prompt using LLM
  await ctx.reply(await getText(lang, "photo.processing"));

  const promptResult = await generatePrompt(userInput);

  if (!promptResult.ok || promptResult.retry) {
    await ctx.reply(await getText(lang, "photo.invalid_style"));
    return;
  }

    const generatedPrompt = promptResult.prompt || userInput;

    await startGeneration(ctx, user, session, lang, {
      generationType: "style",
      promptFinal: generatedPrompt,
      userInput,
      selectedStyleId: preset.id,
    });
  } catch (err) {
    console.error("Style callback error:", err);
  }
});

// ============================================
// Style Carousel handlers
// ============================================

// Callback: carousel — select a style
bot.action(/^style_carousel_pick:(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const session = await getSessionForStyleSelection(user.id);
    if (!session?.id || !["wait_style", "wait_pack_preview_payment"].includes(session.state)) return;

    const styleId = ctx.match[1];
    console.log("[StyleCarousel] Pick:", styleId);
    const preset = await getStylePresetV2ById(styleId);
    if (!preset) return;

    const currentPhotoId = getUserPhotoFileId(user, session);
    if (!currentPhotoId) {
      await ctx.reply(await getText(lang, "photo.need_photo"));
      return;
    }

    // Copy photo from user to session if needed
    if (!session.current_photo_file_id && currentPhotoId) {
      await supabase.from("sessions")
        .update({ current_photo_file_id: currentPhotoId, photos: [currentPhotoId] })
        .eq("id", session.id);
    }

    const userInput = preset.prompt_hint;
    await ctx.reply(await getText(lang, "photo.processing"));

    const promptResult = await generatePrompt(userInput);
    if (!promptResult.ok || promptResult.retry) {
      await ctx.reply(await getText(lang, "photo.invalid_style"));
      return;
    }

    const generatedPrompt = promptResult.prompt || userInput;
    await startGeneration(ctx, user, session, lang, {
      generationType: "style",
      promptFinal: generatedPrompt,
      userInput,
      selectedStyleId: preset.id,
    });
  } catch (err) {
    console.error("[StyleCarousel] Pick error:", err);
  }
});

// Callback: carousel — next page
bot.action(/^style_carousel_next:(\d+):(.*)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user?.id) return;
    const lang = user.lang || "en";
    const session = await getActiveSession(user.id);

    const nextPage = parseInt(ctx.match[1], 10);
    const stickerMsgIds = ctx.match[2].split(",").filter(Boolean).map(Number);

    // Delete previous sticker messages
    for (const msgId of stickerMsgIds) {
      await ctx.telegram.deleteMessage(ctx.chat!.id, msgId).catch(() => {});
    }
    // Delete the text+buttons message (current message)
    await ctx.deleteMessage().catch(() => {});

    await sendStyleKeyboardFlat(ctx, lang);
  } catch (err) {
    console.error("[StyleCarousel] Next error:", err);
  }
});

// Callback: noop — page counter button, do nothing
bot.action("noop", async (ctx) => {
  safeAnswerCbQuery(ctx);
});

// ============================================
// Styles v2 handlers (isolated, only for enabled users)
// ============================================

// Callback: style group selected (v2)
bot.action(/^style_group:(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    
    // Legacy handler - groups are no longer used, redirect to flat list
    const user = await getUser(telegramId);
    if (!user?.id) return;
    const lang = user.lang || "en";
    const session = await getActiveSession(user.id);
    await sendStyleKeyboardFlat(ctx, lang, ctx.callbackQuery?.message?.message_id, {
      selectedStyleId: session?.selected_style_id || null,
    });
  } catch (err) {
    console.error("Style group callback error:", err);
  }
});

// Callback: style preview card — show example + description before generation
bot.action(/^style_preview:(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const session = await getSessionForStyleSelection(user.id);
    if (!session?.id || !["wait_style", "wait_pack_preview_payment"].includes(session.state)) return;

    const styleId = ctx.match[1];
    console.log("[StylePreview] Showing preview for:", styleId);

    const preset = await getStylePresetV2ById(styleId);
    if (!preset) {
      console.log("[StylePreview] Preset not found:", styleId);
      return;
    }

    // Delete style list message
    try { await ctx.deleteMessage(); } catch {}

    // In pack flow prefer pack example image; else single-sticker example
    let stickerMsgId: number = 0;
    try {
      if (session.state === "wait_pack_preview_payment") {
        const packFileId = await getPackStyleExampleFileId(preset.id);
        if (packFileId) {
          const photoMsg = await ctx.replyWithPhoto(packFileId);
          stickerMsgId = photoMsg.message_id;
        }
      }
      if (stickerMsgId === 0) {
        const fileId = await getStyleStickerFileId(preset.id);
        if (fileId) {
          const stickerMsg = await ctx.replyWithSticker(fileId);
          stickerMsgId = stickerMsg.message_id;
        }
      }
    } catch (err: any) {
      console.error("[StylePreview] Failed to send example:", err.message);
    }

    // Build description text
    const styleName = lang === "ru" ? preset.name_ru : preset.name_en;
    const description = preset.description_ru || preset.prompt_hint;
    const text = `${preset.emoji} *${styleName}*\n\n${description}`;

    // Buttons: Back | Apply (unified with assistant flow)
    const applyText = lang === "ru" ? "✅ Применить" : "✅ Apply";
    const backText = lang === "ru" ? "↩️ Назад" : "↩️ Back";

    const applyCallback = session.state === "wait_pack_preview_payment" ? `style_v2:${preset.id}` : `style_v2:${preset.id}`;
    const keyboard = {
      inline_keyboard: [[
        { text: backText, callback_data: `back_to_style_list:${stickerMsgId}` },
        { text: applyText, callback_data: applyCallback },
      ]],
    };

    // Send description as new message (below sticker)
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch (err) {
    console.error("[StylePreview] error:", err);
  }
});

// Callback: back to style list from preview card
bot.action(/^back_to_style_list:(\d+)?$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const session = await getSessionForStyleSelection(user.id);

    // Delete sticker preview message if exists
    const stickerMsgId = ctx.match[1] ? parseInt(ctx.match[1], 10) : 0;
    if (stickerMsgId > 0) {
      await ctx.telegram.deleteMessage(ctx.chat!.id, stickerMsgId).catch(() => {});
    }

    // Delete description message (current message with buttons)
    try { await ctx.deleteMessage(); } catch {}

    // Send fresh style list (pack flow: always show Back to poses)
    if (session?.state === "wait_pack_preview_payment") {
      await sendPackStyleSelectionStep(ctx, lang, session.selected_style_id, undefined, { useBackButton: true });
    } else {
      await sendStyleKeyboardFlat(ctx, lang, undefined, { selectedStyleId: session?.selected_style_id || null });
    }
  } catch (err) {
    console.error("[StylePreview] back_to_style_list error:", err);
  }
});

// Callback: substyle selected (v2)
bot.action(/^style_v2:(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const session = await getSessionForStyleSelection(user.id);
    if (!session?.id) return;
    if (session.state !== "wait_style" && session.state !== "wait_pack_preview_payment") return;

    const styleId = ctx.match[1];
    console.log("[Styles v2] Substyle selected:", styleId);

    const preset = await getStylePresetV2ById(styleId);
    if (!preset) {
      console.log("[Styles v2] Preset not found:", styleId);
      return;
    }

    // Pack flow: save selected style and stay on preview-payment step
    if (session.state === "wait_pack_preview_payment") {
      await supabase
        .from("sessions")
        .update({ selected_style_id: preset.id, is_active: true })
        .eq("id", session.id);
      try { await ctx.deleteMessage(); } catch {}
      await sendPackStyleSelectionStep(ctx, lang, preset.id, undefined, { useBackButton: true });
      return;
    }

    const currentPhotoId = getUserPhotoFileId(user, session);
    if (!currentPhotoId) {
      await ctx.reply(await getText(lang, "photo.need_photo"));
      return;
    }

    // Copy photo from user to session if needed
    if (!session.current_photo_file_id && currentPhotoId) {
      await supabase.from("sessions")
        .update({ current_photo_file_id: currentPhotoId, photos: [currentPhotoId] })
        .eq("id", session.id);
    }

    // Use prompt_hint as userInput
    const userInput = preset.prompt_hint;
    await ctx.reply(await getText(lang, "photo.processing"));

    const promptResult = await generatePrompt(userInput);
    if (!promptResult.ok || promptResult.retry) {
      await ctx.reply(await getText(lang, "photo.invalid_style"));
      return;
    }

    const generatedPrompt = promptResult.prompt || userInput;

    await startGeneration(ctx, user, session, lang, {
      generationType: "style",
      promptFinal: generatedPrompt,
      userInput,
      selectedStyleId: preset.id,
    });
  } catch (err) {
    console.error("Style v2 callback error:", err);
  }
});

// Callback: back to groups (v2)
bot.action(/^style_groups_back(:.*)?$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    // Legacy handler - redirect to flat list
    const user = await getUser(telegramId);
    if (!user?.id) return;
    const lang = user.lang || "en";
    const session = await getActiveSession(user.id);
    await sendStyleKeyboardFlat(ctx, lang, ctx.callbackQuery?.message?.message_id, {
      selectedStyleId: session?.selected_style_id || null,
    });
  } catch (err) {
    console.error("Style groups back callback error:", err);
  }
});

// Callback: example from broadcast — original message stays, only sticker+caption removed on Back
bot.action(/^broadcast_example:(.+):(.+)$/, async (ctx) => {
  try {
    const substyleId = ctx.match[1];
    const groupId = ctx.match[2];
    console.log("[Broadcast] broadcast_example callback:", substyleId, groupId, "telegramId:", ctx.from?.id);
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user?.id) {
      console.log("[Broadcast] broadcast_example user not found for telegramId:", telegramId, "appEnv:", config.appEnv);
      return;
    }

    const lang = user.lang || "en";

    const { data: example } = await supabase
      .from("stickers")
      .select("telegram_file_id")
      .eq("style_preset_id", substyleId)
      .eq("is_example", true)
      .not("telegram_file_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!example?.telegram_file_id) {
      const noExamplesText = await getText(lang, "style.no_examples");
      await ctx.reply(noExamplesText);
      return;
    }

    const preset = await getStylePresetV2ById(substyleId);
    const styleName = preset ? (lang === "ru" ? preset.name_ru : preset.name_en) : substyleId;
    const titleText = await getText(lang, "style.example_title", { style: styleName });
    const backText = await getText(lang, "btn.back_to_styles");

    // Don't delete original broadcast message — send as new messages
    const stickerMsg = await ctx.replyWithSticker(example.telegram_file_id);
    await ctx.reply(titleText, {
      reply_markup: {
        inline_keyboard: [[{ text: backText, callback_data: `back_from_broadcast:${stickerMsg.message_id}` }]],
      },
    });
  } catch (err) {
    console.error("Broadcast example error:", err);
  }
});

bot.action(/^back_from_broadcast:(\d+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const stickerMsgId = parseInt(ctx.match[1], 10);
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Delete caption (current message) and sticker
    await ctx.deleteMessage().catch(() => {});
    await ctx.telegram.deleteMessage(chatId, stickerMsgId).catch(() => {});
  } catch (err) {
    console.error("Back from broadcast example error:", err);
  }
});

// Callback: example for v2 substyle
bot.action(/^style_example_v2:(.+):(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;


    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const substyleId = ctx.match[1];
    const groupId = ctx.match[2];
    
    console.log("[Styles v2] Example requested:", substyleId, "groupId:", groupId);

    // Get substyle name
    const preset = await getStylePresetV2ById(substyleId);
    const styleName = preset 
      ? (lang === "ru" ? preset.name_ru : preset.name_en)
      : substyleId;

    // Get example from stickers table
    const { data: example } = await supabase
      .from("stickers")
      .select("telegram_file_id")
      .eq("style_preset_id", substyleId)
      .eq("is_example", true)
      .not("telegram_file_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Count total examples
    const { count: totalExamples } = await supabase
      .from("stickers")
      .select("id", { count: "exact", head: true })
      .eq("style_preset_id", substyleId)
      .eq("is_example", true)
      .not("telegram_file_id", "is", null);

    console.log("[Styles v2] Example found:", !!example?.telegram_file_id, "total:", totalExamples);

    const backText = await getText(lang, "btn.back_to_styles");

    if (!example?.telegram_file_id) {
      // No examples - edit message to show text
      const noExamplesText = await getText(lang, "style.no_examples");
      await ctx.editMessageText(noExamplesText, {
        reply_markup: {
          inline_keyboard: [[{ text: backText, callback_data: `back_to_substyles_v2:${groupId}` }]]
        }
      });
      return;
    }

    // Delete old message
    await ctx.deleteMessage().catch(() => {});

    // Send sticker
    const stickerMsg = await ctx.replyWithSticker(example.telegram_file_id);

    // Build buttons
    const titleText = await getText(lang, "style.example_title", { style: styleName });
    const moreText = await getText(lang, "btn.more");
    const buttons: any[][] = [];
    
    if ((totalExamples || 0) > 1) {
      buttons.push([
        { text: moreText, callback_data: `style_example_v2_more:${substyleId}:${groupId}:1` },
        { text: backText, callback_data: `back_to_substyles_v2:${groupId}` }
      ]);
    } else {
      buttons.push([{ text: backText, callback_data: `back_to_substyles_v2:${groupId}` }]);
    }

    const captionMsg = await ctx.reply(titleText, {
      reply_markup: { inline_keyboard: buttons }
    });

    // Auto-delete after 30 seconds
    const chatId = ctx.chat?.id;
    if (chatId) {
      setTimeout(() => {
        ctx.telegram.deleteMessage(chatId, stickerMsg.message_id).catch(() => {});
        ctx.telegram.deleteMessage(chatId, captionMsg.message_id).catch(() => {});
      }, 30000);
    }
  } catch (err) {
    console.error("Style example v2 error:", err);
  }
});

// Callback: back to styles (from example) - now shows flat list
bot.action(/^back_to_substyles_v2:(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";

    // Delete current message and show style list
    await ctx.deleteMessage().catch(() => {});
    await sendStyleKeyboardFlat(ctx, lang);
  } catch (err) {
    console.error("Back to styles from example error:", err);
  }
});

// Callback: more examples v2
bot.action(/^style_example_v2_more:(.+):(.+):(\d+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;


    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const substyleId = ctx.match[1];
    const groupId = ctx.match[2];
    const offset = parseInt(ctx.match[3], 10);

    console.log("[Styles v2] More examples:", substyleId, "offset:", offset);

    const backText = await getText(lang, "btn.back_to_styles");

    // Max 3 examples
    if (offset >= 3) {
      const noMoreText = await getText(lang, "style.no_more_examples");
      await ctx.editMessageText(noMoreText, {
        reply_markup: {
          inline_keyboard: [[{ text: backText, callback_data: `back_to_substyles_v2:${groupId}` }]]
        }
      });
      return;
    }

    // Get next example
    const { data: examples } = await supabase
      .from("stickers")
      .select("telegram_file_id")
      .eq("style_preset_id", substyleId)
      .eq("is_example", true)
      .not("telegram_file_id", "is", null)
      .order("created_at", { ascending: false })
      .range(offset, offset);

    const example = examples?.[0];

    if (!example?.telegram_file_id) {
      const noMoreText = await getText(lang, "style.no_more_examples");
      await ctx.editMessageText(noMoreText, {
        reply_markup: {
          inline_keyboard: [[{ text: backText, callback_data: `back_to_substyles_v2:${groupId}` }]]
        }
      });
      return;
    }

    // Delete old messages (sticker + caption)
    await ctx.deleteMessage().catch(() => {});

    // Send new sticker
    const stickerMsg = await ctx.replyWithSticker(example.telegram_file_id);

    // Get substyle name
    const preset = await getStylePresetV2ById(substyleId);
    const styleName = preset 
      ? (lang === "ru" ? preset.name_ru : preset.name_en)
      : substyleId;
    const titleText = await getText(lang, "style.example_title", { style: styleName });
    const moreText = await getText(lang, "btn.more");

    const captionMsg = await ctx.reply(titleText, {
      reply_markup: {
        inline_keyboard: [[
          { text: moreText, callback_data: `style_example_v2_more:${substyleId}:${groupId}:${offset + 1}` },
          { text: backText, callback_data: `back_to_substyles_v2:${groupId}` }
        ]]
      }
    });

    // Auto-delete after 30 seconds
    const chatId = ctx.chat?.id;
    if (chatId) {
      setTimeout(() => {
        ctx.telegram.deleteMessage(chatId, stickerMsg.message_id).catch(() => {});
        ctx.telegram.deleteMessage(chatId, captionMsg.message_id).catch(() => {});
      }, 30000);
    }
  } catch (err) {
    console.error("Style example v2 more error:", err);
  }
});

// Callback: custom style (v2)
bot.action("style_custom_v2", async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;


    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const session = await getActiveSession(user.id);
    if (!session?.id || session.state !== "wait_style") return;

    // Switch state to wait for custom style text
    await supabase
      .from("sessions")
      .update({ state: "wait_custom_style_v2", is_active: true })
      .eq("id", session.id);

    await ctx.reply(await getText(lang, "style.custom_prompt_v2"));
  } catch (err) {
    console.error("Style custom v2 callback error:", err);
  }
});

// ============================================
// End of Styles v2 handlers
// ============================================

// Callback: add to pack (new format with sticker ID)
bot.action(/^add_to_pack:(.+)$/, async (ctx) => {
  console.log("=== add_to_pack:ID callback ===");
  console.log("callback_data:", ctx.match?.[0]);
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  console.log("telegramId:", telegramId);
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  console.log("stickerId from callback:", stickerId);

  // Get sticker from DB by ID
  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  console.log("sticker from DB:", sticker?.user_id, "telegram_file_id:", sticker?.telegram_file_id?.substring(0, 30) + "...");

  if (!sticker?.telegram_file_id) {
    console.log(">>> ERROR: no telegram_file_id for sticker", stickerId);
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  // Verify sticker belongs to user
  if (sticker.user_id !== user.id) {
    return;
  }

  const botUsername = await getBotUsername();
  let stickerSetName = user.sticker_set_name || `p2s_${telegramId}_by_${botUsername}`.toLowerCase();
  const packTitle = await getText(lang, "sticker.pack_title");

  const createStickerSet = async (name: string, fileId: string) => {
    console.log("add_to_pack: creating new sticker set:", name);
    await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/createNewStickerSet`, {
      user_id: telegramId,
      name,
      title: packTitle,
      stickers: [{ sticker: fileId, format: "static", emoji_list: ["🔥"] }],
    }, { timeout: 15000 });
    await supabase.from("users").update({ sticker_set_name: name }).eq("id", user.id);
    console.log("add_to_pack: sticker set created:", name);
  };

  try {
    if (!user.sticker_set_name) {
      // Create new sticker set
      try {
        await createStickerSet(stickerSetName, sticker.telegram_file_id);
      } catch (createErr: any) {
        // If name is occupied, try with timestamp
        if (createErr.response?.data?.description?.includes("already occupied")) {
          console.log("add_to_pack: name occupied, trying with timestamp...");
          stickerSetName = `p2s_${telegramId}_${Date.now()}_by_${botUsername}`.toLowerCase();
          await createStickerSet(stickerSetName, sticker.telegram_file_id);
        } else {
          throw createErr;
        }
      }
    } else {
      // Add to existing sticker set
      console.log("add_to_pack: adding to existing set:", stickerSetName);
      try {
        await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/addStickerToSet`, {
          user_id: telegramId,
          name: stickerSetName,
          sticker: { sticker: sticker.telegram_file_id, format: "static", emoji_list: ["🔥"] },
        }, { timeout: 15000 });
        console.log("add_to_pack: sticker added to existing set");
      } catch (addErr: any) {
        const desc = (addErr.response?.data?.description || "").toLowerCase();
        // Pack was deleted or invalid — auto-recover by creating a new one
        if (desc.includes("stickerset_invalid") || desc.includes("sticker_set_invalid") || desc.includes("not found")) {
          console.log("add_to_pack: set invalid/deleted, recreating. Old:", stickerSetName);
          stickerSetName = `p2s_${telegramId}_by_${botUsername}`.toLowerCase();
          try {
            await createStickerSet(stickerSetName, sticker.telegram_file_id);
          } catch (recreateErr: any) {
            if (recreateErr.response?.data?.description?.includes("already occupied")) {
              stickerSetName = `p2s_${telegramId}_${Date.now()}_by_${botUsername}`.toLowerCase();
              await createStickerSet(stickerSetName, sticker.telegram_file_id);
            } else {
              throw recreateErr;
            }
          }
        } else {
          throw addErr;
        }
      }
    }

    console.log("add_to_pack: success, set:", stickerSetName);
    await ctx.reply(await getText(lang, "sticker.added_to_pack", {
      link: `https://t.me/addstickers/${stickerSetName}`,
    }));
  } catch (err: any) {
    console.error("add_to_pack: error:", err.response?.data || err.message);
    await sendAlert({
      type: "api_error",
      message: `Add to pack failed: ${err.response?.data?.description || err.message}`,
      details: { 
        user: `@${user.username || telegramId}`,
        stickerId,
        stickerSetName,
        errorCode: err.response?.data?.error_code,
      },
    });
    await ctx.reply(await getText(lang, "error.technical"));
  }
});

// Callback: add to pack (old format - fallback for old messages)
bot.action("add_to_pack", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.last_sticker_file_id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  const botUsername = await getBotUsername();
  let stickerSetName = user.sticker_set_name || `p2s_${telegramId}_by_${botUsername}`.toLowerCase();
  const packTitle = await getText(lang, "sticker.pack_title");

  const createStickerSet = async (name: string, fileId: string) => {
    console.log("add_to_pack(old): creating new sticker set:", name);
    await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/createNewStickerSet`, {
      user_id: telegramId,
      name,
      title: packTitle,
      stickers: [{ sticker: fileId, format: "static", emoji_list: ["🔥"] }],
    }, { timeout: 15000 });
    await supabase.from("users").update({ sticker_set_name: name }).eq("id", user.id);
    console.log("add_to_pack(old): sticker set created:", name);
  };

  try {
    if (!user.sticker_set_name) {
      try {
        await createStickerSet(stickerSetName, session.last_sticker_file_id);
      } catch (createErr: any) {
        if (createErr.response?.data?.description?.includes("already occupied")) {
          console.log("add_to_pack(old): name occupied, trying with timestamp...");
          stickerSetName = `p2s_${telegramId}_${Date.now()}_by_${botUsername}`.toLowerCase();
          await createStickerSet(stickerSetName, session.last_sticker_file_id);
        } else {
          throw createErr;
        }
      }
    } else {
      console.log("add_to_pack(old): adding to existing set:", stickerSetName);
      try {
        await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/addStickerToSet`, {
          user_id: telegramId,
          name: stickerSetName,
          sticker: { sticker: session.last_sticker_file_id, format: "static", emoji_list: ["🔥"] },
        }, { timeout: 15000 });
        console.log("add_to_pack(old): sticker added to existing set");
      } catch (addErr: any) {
        const desc = (addErr.response?.data?.description || "").toLowerCase();
        if (desc.includes("stickerset_invalid") || desc.includes("sticker_set_invalid") || desc.includes("not found")) {
          console.log("add_to_pack(old): set invalid/deleted, recreating. Old:", stickerSetName);
          stickerSetName = `p2s_${telegramId}_by_${botUsername}`.toLowerCase();
          try {
            await createStickerSet(stickerSetName, session.last_sticker_file_id);
          } catch (recreateErr: any) {
            if (recreateErr.response?.data?.description?.includes("already occupied")) {
              stickerSetName = `p2s_${telegramId}_${Date.now()}_by_${botUsername}`.toLowerCase();
              await createStickerSet(stickerSetName, session.last_sticker_file_id);
            } else {
              throw recreateErr;
            }
          }
        } else {
          throw addErr;
        }
      }
    }

    console.log("add_to_pack(old): success, set:", stickerSetName);
    await ctx.reply(await getText(lang, "sticker.added_to_pack", {
      link: `https://t.me/addstickers/${stickerSetName}`,
    }));
  } catch (err: any) {
    console.error("add_to_pack(old): error:", err.response?.data || err.message);
    await sendAlert({
      type: "api_error",
      message: `Add to pack failed: ${err.response?.data?.description || err.message}`,
      details: { 
        user: `@${user.username || telegramId}`,
        sessionId: session?.id || "-",
        stickerSetName,
        errorCode: err.response?.data?.error_code,
      },
    });
    await ctx.reply(await getText(lang, "error.technical"));
  }
});

// Callback: change style (new format with sticker ID)
bot.action(/^change_style:(.+)$/, async (ctx) => {
  console.log("=== change_style:ID callback ===");
  console.log("callback_data:", ctx.match?.[0]);
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  console.log("stickerId:", stickerId);

  // Get sticker from DB by ID
  const { data: sticker } = await supabase
    .from("stickers")
    .select("source_photo_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  console.log("sticker from DB:", sticker?.user_id, "source_photo_file_id:", !!sticker?.source_photo_file_id);

  if (!sticker?.source_photo_file_id) {
    console.log(">>> ERROR: no source_photo_file_id for sticker", stickerId);
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  // Verify sticker belongs to user
  if (sticker.user_id !== user.id) {
    return;
  }

  // Get or create active session
  let session = await getActiveSession(user.id);
  if (!session?.id) {
    // Create new session
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_style", is_active: true, env: config.appEnv })
      .select()
      .single();
    session = newSession;
  }

  if (!session?.id) return;

  await supabase
    .from("sessions")
    .update({
      state: "wait_style",
      is_active: true,
      current_photo_file_id: sticker.source_photo_file_id,
      prompt_final: null,
      user_input: null,
      pending_generation_type: null,
      selected_emotion: null,
      emotion_prompt: null,
    })
    .eq("id", session.id);

  await sendStyleKeyboardFlat(ctx, lang);
});

// Callback: change style (old format - fallback)
bot.action("change_style", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.id) return;

  await supabase
    .from("sessions")
    .update({
      state: "wait_style",
      is_active: true,
      prompt_final: null,
      user_input: null,
      pending_generation_type: null,
      selected_emotion: null,
      emotion_prompt: null,
    })
    .eq("id", session.id);

  await sendStyleKeyboardFlat(ctx, lang);
});

// Callback: change emotion (new format with sticker ID)
bot.action(/^change_emotion:(.+)$/, async (ctx) => {
  console.log("=== change_emotion:ID callback ===");
  console.log("callback_data:", ctx.match?.[0]);
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  console.log("stickerId:", stickerId);

  // Get sticker from DB by ID
  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, source_photo_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  console.log("sticker from DB:", sticker?.user_id, "telegram_file_id:", !!sticker?.telegram_file_id);

  if (!sticker?.telegram_file_id) {
    console.log(">>> ERROR: no telegram_file_id for sticker", stickerId);
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  // Verify sticker belongs to user
  if (sticker.user_id !== user.id) {
    return;
  }

  // Get or create active session
  let session = await getActiveSession(user.id);
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_emotion", is_active: true, env: config.appEnv })
      .select()
      .single();
    session = newSession;
  }

  if (!session?.id) return;

  await supabase
    .from("sessions")
    .update({
      state: "wait_emotion",
      is_active: true,
      last_sticker_file_id: sticker.telegram_file_id,
      current_photo_file_id: sticker.source_photo_file_id,
      pending_generation_type: null,
    })
    .eq("id", session.id);

  await sendEmotionKeyboard(ctx, lang);
});

// Callback: change emotion (old format - fallback)
bot.action("change_emotion", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.last_sticker_file_id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  await supabase
    .from("sessions")
    .update({ state: "wait_emotion", is_active: true, pending_generation_type: null })
    .eq("id", session.id);

  await sendEmotionKeyboard(ctx, lang);
});

// Callback: emotion selection
bot.action(/^emotion_(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.last_sticker_file_id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  const emotionId = ctx.match[1];
  const presets = await getEmotionPresets();
  const preset = presets.find((p) => p.id === emotionId);
  if (!preset) return;

  if (preset.id === "custom") {
    await supabase
      .from("sessions")
      .update({ state: "wait_custom_emotion", is_active: true })
      .eq("id", session.id);
    await ctx.reply(await getText(lang, "emotion.custom_prompt"));
    return;
  }

  const emotionTemplate = await getPromptTemplate("emotion");
  const promptFinal = buildPromptFromTemplate(emotionTemplate, preset.prompt_hint);
  await startGeneration(ctx, user, session, lang, {
    generationType: "emotion",
    promptFinal,
    emotionPrompt: preset.prompt_hint,
    selectedEmotion: preset.id,
  });
});

// Callback: change motion (new format with sticker ID)
bot.action(/^change_motion:(.+)$/, async (ctx) => {
  console.log("=== change_motion:ID callback ===");
  console.log("callback_data:", ctx.match?.[0]);
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  console.log("stickerId:", stickerId);

  // Get sticker from DB by ID
  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, source_photo_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  console.log("sticker from DB:", sticker?.user_id, "telegram_file_id:", !!sticker?.telegram_file_id);

  if (!sticker?.telegram_file_id) {
    console.log(">>> ERROR: no telegram_file_id for sticker", stickerId);
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  // Verify sticker belongs to user
  if (sticker.user_id !== user.id) {
    return;
  }

  // Get or create active session
  let session = await getActiveSession(user.id);
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_motion", is_active: true, env: config.appEnv })
      .select()
      .single();
    session = newSession;
  }

  if (!session?.id) return;

  await supabase
    .from("sessions")
    .update({
      state: "wait_motion",
      is_active: true,
      last_sticker_file_id: sticker.telegram_file_id,
      current_photo_file_id: sticker.source_photo_file_id,
      pending_generation_type: null,
    })
    .eq("id", session.id);

  await sendMotionKeyboard(ctx, lang);
});

// Callback: change motion (old format - fallback)
bot.action("change_motion", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.last_sticker_file_id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  await supabase
    .from("sessions")
    .update({ state: "wait_motion", is_active: true, pending_generation_type: null })
    .eq("id", session.id);

  await sendMotionKeyboard(ctx, lang);
});

// Callback: motion selection
bot.action(/^motion_(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.last_sticker_file_id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  const motionId = ctx.match[1];
  const presets = await getMotionPresets();
  const preset = presets.find((p) => p.id === motionId);
  if (!preset) return;

  if (preset.id === "custom") {
    await supabase
      .from("sessions")
      .update({ state: "wait_custom_motion", is_active: true })
      .eq("id", session.id);
    await ctx.reply(await getText(lang, "motion.custom_prompt"));
    return;
  }

  const motionTemplate = await getPromptTemplate("motion");
  const promptFinal = buildPromptFromTemplate(motionTemplate, preset.prompt_hint);
  await startGeneration(ctx, user, session, lang, {
    generationType: "motion",
    promptFinal,
    emotionPrompt: preset.prompt_hint,
    selectedEmotion: preset.id,
  });
});

// Callback: add text to sticker
bot.action(/^add_text:(.+)$/, async (ctx) => {
  console.log("=== add_text:ID callback ===");
  console.log("callback_data:", ctx.match?.[0]);
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  console.log("stickerId:", stickerId);

  // Get sticker from DB by ID
  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, source_photo_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  console.log("sticker from DB:", sticker?.user_id, "telegram_file_id:", !!sticker?.telegram_file_id);

  if (!sticker?.telegram_file_id) {
    console.log(">>> ERROR: no telegram_file_id for sticker", stickerId);
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  // Verify sticker belongs to user
  if (sticker.user_id !== user.id) {
    return;
  }

  // Get or create active session
  let session = await getActiveSession(user.id);
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_text_overlay", is_active: true, env: config.appEnv })
      .select()
      .single();
    session = newSession;
  }

  if (!session?.id) return;

  console.log("add_text: updating session", session.id, "from state:", session.state, "to wait_text_overlay");
  const { error: updateErr } = await supabase
    .from("sessions")
    .update({
      state: "wait_text_overlay",
      is_active: true,
      last_sticker_file_id: sticker.telegram_file_id,
      user_input: stickerId,
      pending_generation_type: null,
    })
    .eq("id", session.id);

  if (updateErr) {
    console.error("add_text: session update FAILED:", updateErr.message, updateErr.code);
    // Fallback: try without user_input in case column doesn't accept this value
    const { error: retryErr } = await supabase
      .from("sessions")
      .update({
        state: "wait_text_overlay",
        is_active: true,
        last_sticker_file_id: sticker.telegram_file_id,
        pending_generation_type: null,
      })
      .eq("id", session.id);
    if (retryErr) {
      console.error("add_text: retry update also FAILED:", retryErr.message);
    } else {
      console.log("add_text: retry succeeded (without user_input)");
    }
  } else {
    console.log("add_text: session updated to wait_text_overlay OK");
  }

  // Verify the update persisted
  const { data: verify } = await supabase
    .from("sessions")
    .select("state, is_active")
    .eq("id", session.id)
    .maybeSingle();
  console.log("add_text: verify after update — state:", verify?.state, "is_active:", verify?.is_active);

  await ctx.reply(lang === "ru"
    ? "✏️ Напиши текст для стикера (до 30 символов):"
    : "✏️ Type the text for the sticker (up to 30 characters):");
});

// Callback: toggle white border on sticker (post-processing, no credits)
bot.action(/^toggle_border:(.+)$/, async (ctx) => {
  console.log("=== toggle_border:ID callback ===");
  console.log("callback_data:", ctx.match?.[0]);
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  console.log("stickerId:", stickerId);

  // Get sticker from DB by ID
  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  console.log("toggle_border sticker from DB:", sticker?.user_id, "telegram_file_id:", !!sticker?.telegram_file_id);

  if (!sticker?.telegram_file_id) {
    console.log(">>> ERROR: no telegram_file_id for sticker", stickerId);
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  // Verify sticker belongs to user
  if (sticker.user_id !== user.id) {
    return;
  }

  try {
    // Show processing indicator
    const processingMsg = await ctx.reply(lang === "ru" ? "🔲 Добавляю обводку..." : "🔲 Adding border...");

    // Download current sticker via Telegram API
    const filePath = await getFilePath(sticker.telegram_file_id);
    const stickerBuffer = await downloadFile(filePath);
    console.log("toggle_border: downloaded sticker, size:", stickerBuffer.length);

    // Add white border via image processing
    const borderedBuffer = await addWhiteBorder(stickerBuffer);
    console.log("toggle_border: bordered buffer size:", borderedBuffer.length);

    // Build buttons (same as post-generation)
    const replyMarkup = await buildStickerButtons(lang, stickerId);

    // Send bordered sticker
    const newFileId = await sendSticker(telegramId, borderedBuffer, replyMarkup);
    console.log("toggle_border: sent bordered sticker, new file_id:", newFileId?.substring(0, 30) + "...");

    // Update telegram_file_id in DB
    if (newFileId) {
      await supabase
        .from("stickers")
        .update({ telegram_file_id: newFileId })
        .eq("id", stickerId);
      console.log("toggle_border: updated sticker telegram_file_id");
    }

    // Delete processing message
    try {
      await ctx.deleteMessage(processingMsg.message_id);
    } catch (e) {
      // ignore
    }

    // Upload bordered version to storage (background, non-critical)
    const storagePath = `stickers/${user.id}/bordered_${Date.now()}.webp`;
    supabase.storage
      .from(config.supabaseStorageBucket)
      .upload(storagePath, borderedBuffer, { contentType: "image/webp", upsert: true })
      .then(() => console.log("toggle_border: storage upload done"))
      .catch((err: any) => console.error("toggle_border: storage upload failed:", err));

  } catch (err: any) {
    console.error("toggle_border error:", err);
    await ctx.reply(await getText(lang, "error.technical"));
  }
});

// ============================================
// AI Assistant callbacks
// ============================================

// Callback: assistant picks a style from the examples keyboard
// Assistant: style preview — show sticker + description + OK button
bot.action(/^assistant_style_preview:(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user?.id) return;
    const lang = user.lang || "en";
    const isRu = lang === "ru";

    const styleId = ctx.match[1];
    const preset = await getStylePresetV2ById(styleId);
    if (!preset) return;

    // Delete style list message
    try { await ctx.deleteMessage(); } catch {}

    // Send sticker example
    let stickerMsgId = 0;
    try {
      const fileId = await getStyleStickerFileId(preset.id);
      if (fileId) {
        const stickerMsg = await ctx.replyWithSticker(fileId);
        stickerMsgId = stickerMsg.message_id;
      }
    } catch (err: any) {
      console.error("[assistant_style_preview] Failed to send sticker:", err.message);
    }

    // Show description + OK button
    const styleName = isRu ? preset.name_ru : preset.name_en;
    const description = preset.description_ru || preset.prompt_hint;
    const text = `${preset.emoji} *${styleName}*\n\n${description}`;

    const keyboard = {
      inline_keyboard: [[
        { text: "✅ ОК", callback_data: `assistant_style_preview_ok:${styleId}:${stickerMsgId}` },
      ]],
    };

    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch (err) {
    console.error("[assistant_style_preview] error:", err);
  }
});

// Assistant: style preview OK — apply style
bot.action(/^assistant_style_preview_ok:([^:]+):(\d+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const styleId = ctx.match[1];
  const stickerMsgId = parseInt(ctx.match[2], 10);
  const telegramId = ctx.from?.id;
  if (!telegramId || !styleId) return;

  // Delete sticker preview
  if (stickerMsgId > 0) {
    await ctx.telegram.deleteMessage(ctx.chat!.id, stickerMsgId).catch(() => {});
  }
  // Delete description message
  try { await ctx.deleteMessage(); } catch {}

  // Delegate to existing assistant_pick_style logic
  try {
    const user = await getUser(telegramId);
    if (!user?.id) return;
    const lang = user.lang || "en";

    const preset = await getStylePresetV2ById(styleId);
    const styleName = preset
      ? (lang === "ru" ? preset.name_ru : preset.name_en)
      : styleId;

    const aSession = await getActiveAssistantSession(user.id);
    if (aSession) {
      await updateAssistantSession(aSession.id, { style: styleName });
      console.log("assistant_style_preview_ok:", styleId, "→", styleName, "aSession:", aSession.id);

      const messages: AssistantMessage[] = Array.isArray(aSession.messages) ? [...aSession.messages] : [];
      messages.push({ role: "user", content: `[User selected style: ${styleName}]` });

      const systemPrompt = await getAssistantSystemPrompt(messages, { ...aSession, style: styleName } as AssistantSessionRow);
      const result = await callAIChat(messages, systemPrompt);
      messages.push({ role: "assistant", content: result.text });

      await updateAssistantSession(aSession.id, { style: styleName, messages });

      const replyText = result.text || (lang === "ru"
        ? `Отлично, стиль: ${styleName}! Какую эмоцию хочешь передать?`
        : `Great, style: ${styleName}! What emotion should the sticker express?`);
      await ctx.reply(replyText, getMainMenuKeyboard(lang));
    } else {
      await ctx.reply(lang === "ru"
        ? `Стиль: ${styleName}. Нажми «1 стикер», чтобы начать.`
        : `Style: ${styleName}. Tap «1 sticker» to start.`);
    }
  } catch (err: any) {
    console.error("assistant_style_preview_ok error:", err.message);
  }
});

bot.action(/^assistant_pick_style:(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const styleId = ctx.match[1];
  const telegramId = ctx.from?.id;
  if (!telegramId || !styleId) return;

  try {
    const user = await getUser(telegramId);
    if (!user?.id) return;
    const lang = user.lang || "en";

    // Get style name
    const preset = await getStylePresetV2ById(styleId);
    const styleName = preset
      ? (lang === "ru" ? preset.name_ru : preset.name_en)
      : styleId;

    // Update assistant session with chosen style
    const aSession = await getActiveAssistantSession(user.id);
    if (aSession) {
      await updateAssistantSession(aSession.id, { style: styleName });
      console.log("assistant_pick_style:", styleId, "→", styleName, "aSession:", aSession.id);

      // Build response through AI to continue flow naturally
      const messages: AssistantMessage[] = Array.isArray(aSession.messages) ? [...aSession.messages] : [];
      messages.push({ role: "user", content: `[User selected style: ${styleName}]` });

      const systemPrompt = await getAssistantSystemPrompt(messages, { ...aSession, style: styleName } as AssistantSessionRow);
      const result = await callAIChat(messages, systemPrompt);
      messages.push({ role: "assistant", content: result.text });

      await updateAssistantSession(aSession.id, { style: styleName, messages });

      const replyText = result.text || (lang === "ru"
        ? `Отлично, стиль: ${styleName}! Какую эмоцию хочешь передать?`
        : `Great, style: ${styleName}! What emotion should the sticker express?`);
      await ctx.reply(replyText, getMainMenuKeyboard(lang));
    } else {
      // No active assistant session — just acknowledge
      await ctx.reply(lang === "ru"
        ? `Стиль: ${styleName}. Нажми «1 стикер», чтобы начать.`
        : `Style: ${styleName}. Tap «1 sticker» to start.`);
    }
  } catch (err: any) {
    console.error("assistant_pick_style callback error:", err.message);
  }
});

// Callback: assistant confirm — user presses [✅ Confirm] button
bot.action("assistant_confirm", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);

  if (!session?.id || !session.state?.startsWith("assistant_")) return;

  // Check if user qualifies for trial credit — route through AI for grant/deny decision
  const qualifiesForTrial = (user.credits || 0) === 0
    && !user.has_purchased
    && (user.total_generations || 0) <= 2;

  if (qualifiesForTrial) {
    const aSession = await getActiveAssistantSession(user.id);
    if (!aSession) {
      await handleAssistantConfirm(ctx, user, session.id, lang);
      return;
    }

    // Check duplicate: already received trial credit
    const { count: userTrialCount } = await supabase
      .from("assistant_sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("env", config.appEnv)
      .like("goal", "%[trial: grant%");
    const alreadyGranted = (userTrialCount || 0) > 0;

    if (alreadyGranted) {
      // Already got trial — go straight to generation (will show paywall if no credits)
      await handleAssistantConfirm(ctx, user, session.id, lang);
      return;
    }

    // Inject "user confirmed" into AI conversation so it can call grant_trial_credit
    const messages: AssistantMessage[] = Array.isArray(aSession.messages) ? [...aSession.messages] : [];
    messages.push({ role: "user", content: lang === "ru" ? "Подтверждаю" : "Confirm" });

    const systemPrompt = await getAssistantSystemPrompt(messages, aSession, {
      credits: user.credits || 0,
      hasPurchased: !!user.has_purchased,
      totalGenerations: user.total_generations || 0,
      utmSource: user.utm_source,
      utmMedium: user.utm_medium,
    });

    try {
      console.log("[assistant_confirm] Trial-eligible user, routing through AI...");
      const result = await callAIChat(messages, systemPrompt);
      console.log("[assistant_confirm] AI response:", result.toolCall?.name || "no tool", "text:", result.text?.length || 0);
      messages.push({ role: "assistant", content: result.text || "" });

      const { action, updatedSession } = await processAssistantResult(result, aSession, messages);
      console.log("[assistant_confirm] action:", action);

      let replyText = result.text;
      if (!replyText && result.toolCall) {
        replyText = generateFallbackReply(action, updatedSession, lang);
        messages[messages.length - 1] = { role: "assistant", content: replyText };
        await updateAssistantSession(aSession.id, { messages });
      }

      if (action === "grant_credit" || action === "deny_credit") {
        // Re-fetch user to get fresh credits (user may have purchased during conversation)
        const freshUserConfirm = await getUser(user.telegram_id);
        if (freshUserConfirm && (freshUserConfirm.credits || 0) > 0) {
          console.log("[assistant_confirm] User has credits after re-fetch:", freshUserConfirm.credits, "— generating");
          if (replyText) await ctx.reply(replyText);
          await handleAssistantConfirm(ctx, freshUserConfirm, session.id, lang);
        } else {
          await handleTrialCreditAction(ctx, action, result, freshUserConfirm || user, session, replyText, lang);
        }
      } else if (action === "confirm") {
        // AI called confirm_and_generate instead of grant_trial_credit — retry with explicit instruction
        console.log("[assistant_confirm] AI called confirm but user is trial-eligible — retrying with explicit instruction");
        messages.push({
          role: "user",
          content: "[SYSTEM: You called confirm_and_generate but this user has 0 credits and never purchased. You MUST call grant_trial_credit(decision, confidence, reason) instead. Decide: grant or deny based on the conversation above.]",
        });
        const retryResult = await callAIChat(messages, systemPrompt);
        console.log("[assistant_confirm] Retry AI response:", retryResult.toolCall?.name || "no tool", "confidence:", retryResult.toolCall?.args?.confidence);
        const retryMessages = [...messages, { role: "assistant" as const, content: retryResult.text || "" }];
        const { action: retryAction } = await processAssistantResult(retryResult, aSession, retryMessages);

        if (retryAction === "grant_credit" || retryAction === "deny_credit") {
          const freshUserConfirm = await getUser(user.telegram_id);
          const retryReplyText = retryResult.text || replyText;
          if (freshUserConfirm && (freshUserConfirm.credits || 0) > 0) {
            if (retryReplyText) await ctx.reply(retryReplyText);
            await handleAssistantConfirm(ctx, freshUserConfirm, session.id, lang);
          } else {
            await handleTrialCreditAction(ctx, retryAction, retryResult, freshUserConfirm || user, session, retryReplyText, lang);
          }
        } else {
          // Retry also failed — fallback to paywall
          console.log("[assistant_confirm] Retry also returned:", retryAction, "— falling back to paywall");
          if (replyText) await ctx.reply(replyText);
          await handleAssistantConfirm(ctx, user, session.id, lang);
        }
      } else {
        // AI returned something else — show text + paywall as fallback
        if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
      }
    } catch (err: any) {
      console.error("[assistant_confirm] AI error for trial user:", err.message);
      // Fallback: go to normal confirm (will show paywall)
      await handleAssistantConfirm(ctx, user, session.id, lang);
    }
    return;
  }

  await handleAssistantConfirm(ctx, user, session.id, lang);
});

// ============================================================
// Assistant Ideas — callback handlers
// ============================================================

// Generate sticker with selected idea
bot.action(/^asst_idea_gen:(\d+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const session = await getActiveSession(user.id);
  if (!session?.sticker_ideas_state) {
    console.error("[asst_idea_gen] No sticker_ideas_state, session:", session?.id, "state:", session?.state);
    await ctx.reply(lang === "ru" ? "⚠️ Сессия устарела. Пришли фото заново." : "⚠️ Session expired. Send a photo again.");
    return;
  }

  const state = session.sticker_ideas_state as { styleId: string; ideaIndex: number; ideas: StickerIdea[] };
  const ideaIndex = parseInt(ctx.match[1], 10);
  const idea = state.ideas[ideaIndex];
  if (!idea) return;

  const preset = await getStylePresetV2ById(state.styleId);
  if (!preset) return;

  console.log("[asst_idea_gen] Generating idea:", ideaIndex, idea.titleEn, "style:", preset.id);
  console.log("[asst_idea_gen] prompt_hint:", preset.prompt_hint);
  console.log("[asst_idea_gen] promptModification:", idea.promptModification);

  // Build prompt via prompt_generator agent
  const userText = `${preset.prompt_hint}, ${idea.promptModification}`;
  console.log("[asst_idea_gen] userText (input to generatePrompt):", userText);
  const promptResult = await generatePrompt(userText);
  const promptFinal = promptResult.ok && promptResult.prompt
    ? promptResult.prompt
    : `${preset.prompt_hint}. ${idea.promptModification}`;
  console.log("[asst_idea_gen] promptFinal:", promptFinal);

  // Save last used style for future ideas
  await supabase.from("users").update({ last_style_id: state.styleId }).eq("id", user.id);

  await startGeneration(ctx, user, session, lang, {
    generationType: "style",
    promptFinal,
    userInput: `[assistant_idea] ${preset.name_en}: ${idea.titleEn}`,
    selectedStyleId: preset.id,
  });
});

// Next idea — always generate a new one via text-only LLM
bot.action(/^asst_idea_next:(\d+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const session = await getActiveSession(user.id);
  if (!session?.sticker_ideas_state) {
    console.error("[asst_idea_next] No sticker_ideas_state, session:", session?.id, "state:", session?.state);
    await ctx.reply(lang === "ru" ? "⚠️ Сессия устарела. Пришли фото заново." : "⚠️ Session expired. Send a photo again.");
    return;
  }

  const state = session.sticker_ideas_state as { styleId: string; ideaIndex: number; ideas: StickerIdea[]; holidayId?: string | null; photoDescription?: string };

  const preset = await getStylePresetV2ById(state.styleId);
  if (!preset) return;

  try { await ctx.deleteMessage(); } catch {}
  const loadingMsg = await ctx.reply(
    lang === "ru" ? "💡 Придумываю идею..." : "💡 Coming up with an idea..."
  );

  let newIdea: StickerIdea;
  try {
    // Get holiday modifier if ideas are holiday-themed
    let holidayMod: string | undefined;
    if (state.holidayId) {
      const { data: ht } = await supabase.from("holiday_themes").select("prompt_modifier").eq("id", state.holidayId).maybeSingle();
      holidayMod = ht?.prompt_modifier;
    }

    const shownIdeas = state.ideas.map(i => i.titleEn);
    newIdea = await generateNextIdea({
      photoDescription: state.photoDescription || "",
      stylePresetId: state.styleId,
      lang,
      shownIdeas,
      holidayModifier: holidayMod,
    });
  } catch (err: any) {
    console.error("[asst_idea_next] generateNextIdea error:", err.message);
    const defaults = getDefaultIdeas(lang);
    const shown = new Set(state.ideas.map(i => i.titleEn?.toLowerCase()));
    newIdea = defaults.find(d => !shown.has(d.titleEn.toLowerCase())) || defaults[0];
  }

  const newIdeas = [...state.ideas, newIdea];
  const newIndex = newIdeas.length - 1;
  const newState = { ...state, ideaIndex: newIndex, ideas: newIdeas };
  await supabase.from("sessions").update({
    sticker_ideas_state: newState, is_active: true,
  }).eq("id", session.id);

  try { await ctx.deleteMessage(loadingMsg.message_id); } catch {}

  await showStickerIdeaCard(ctx, {
    idea: newIdea,
    ideaIndex: newIndex,
    totalIdeas: 0, // unlimited
    style: preset,
    lang,
    currentHolidayId: state.holidayId,
  });
});

// Show style selection buttons
bot.action(/^asst_idea_style:(\d+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const ideaIndex = parseInt(ctx.match[1], 10);
  const allPresets = await getStylePresetsV2();
  const isRu = lang === "ru";

  // Build style buttons (3 per row)
  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < allPresets.length; i += 3) {
    const row: ReturnType<typeof Markup.button.callback>[] = [];
    for (let j = i; j < Math.min(i + 3, allPresets.length); j++) {
      const p = allPresets[j];
      row.push(Markup.button.callback(
        `${p.emoji} ${isRu ? p.name_ru : p.name_en}`,
        `asst_idea_restyle:${p.id}:${ideaIndex}`
      ));
    }
    buttons.push(row);
  }
  // Back button
  buttons.push([Markup.button.callback(
    isRu ? "⬅️ Назад" : "⬅️ Back",
    `asst_idea_back:${ideaIndex}`
  )]);

  try { await ctx.deleteMessage(); } catch {}
  await ctx.reply(
    isRu ? "🎨 Выбери стиль:" : "🎨 Choose a style:",
    Markup.inlineKeyboard(buttons)
  );
});

// Back to idea card from style selection
bot.action(/^asst_idea_back:(\d+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const session = await getActiveSession(user.id);
  const state = session?.sticker_ideas_state as { styleId: string; ideaIndex: number; ideas: StickerIdea[]; holidayId?: string | null } | null;
  if (!state?.ideas?.length) {
    try { await ctx.deleteMessage(); } catch {}
    await ctx.reply(lang === "ru" ? "⚠️ Сессия устарела. Пришли фото заново." : "⚠️ Session expired. Send a photo again.");
    return;
  }

  const ideaIndex = parseInt(ctx.match[1], 10);
  const preset = await getStylePresetV2ById(state.styleId);
  if (!preset) return;

  try { await ctx.deleteMessage(); } catch {}
  await showStickerIdeaCard(ctx, {
    idea: state.ideas[ideaIndex],
    ideaIndex,
    totalIdeas: 0,
    style: preset,
    lang,
    currentHolidayId: state.holidayId,
  });
});

// Restyle: change style, keep same ideas, show current idea with new style
// Restyle: show style preview (sticker example + description + OK button)
bot.action(/^asst_idea_restyle:([^:]+):(\d+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";
  const isRu = lang === "ru";

  const styleId = ctx.match[1];
  const ideaIndex = parseInt(ctx.match[2], 10);

  const preset = await getStylePresetV2ById(styleId);
  if (!preset) return;

  // Delete the style list message
  try { await ctx.deleteMessage(); } catch {}

  // Send sticker example (if available)
  let stickerMsgId = 0;
  try {
    const fileId = await getStyleStickerFileId(preset.id);
    if (fileId) {
      const stickerMsg = await ctx.replyWithSticker(fileId);
      stickerMsgId = stickerMsg.message_id;
    }
  } catch (err: any) {
    console.error("[asst_idea_restyle] Failed to send sticker:", err.message);
  }

  // Show description + OK button
  const styleName = isRu ? preset.name_ru : preset.name_en;
  const description = preset.description_ru || preset.prompt_hint;
  const text = `${preset.emoji} *${styleName}*\n\n${description}`;

  const okText = "✅ ОК";
  const keyboard = {
    inline_keyboard: [[
      { text: okText, callback_data: `asst_idea_restyle_ok:${styleId}:${ideaIndex}:${stickerMsgId}` },
    ]],
  };

  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
});

// Restyle OK: apply selected style and return to idea card
bot.action(/^asst_idea_restyle_ok:([^:]+):(\d+):(\d+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const styleId = ctx.match[1];
  const ideaIndex = parseInt(ctx.match[2], 10);
  const stickerMsgId = parseInt(ctx.match[3], 10);

  const session = await getActiveSession(user.id);
  if (!session?.sticker_ideas_state) {
    console.error("[asst_idea_restyle_ok] No sticker_ideas_state, session:", session?.id);
    await ctx.reply(lang === "ru" ? "⚠️ Сессия устарела. Пришли фото заново." : "⚠️ Session expired. Send a photo again.");
    return;
  }

  const preset = await getStylePresetV2ById(styleId);
  if (!preset) return;

  const state = session.sticker_ideas_state as { styleId: string; ideaIndex: number; ideas: StickerIdea[]; holidayId?: string | null };

  // Update style in session
  const newState = { ...state, styleId };
  await supabase.from("sessions").update({
    sticker_ideas_state: newState,
    is_active: true,
  }).eq("id", session.id);

  // Delete sticker preview
  if (stickerMsgId > 0) {
    await ctx.telegram.deleteMessage(ctx.chat!.id, stickerMsgId).catch(() => {});
  }

  // Delete description message (current message with OK button)
  try { await ctx.deleteMessage(); } catch {}

  // Show idea card with new style
  await showStickerIdeaCard(ctx, {
    idea: state.ideas[ideaIndex],
    ideaIndex,
    totalIdeas: 0,
    style: preset,
    lang,
    currentHolidayId: state.holidayId,
  });
});

// Holiday OFF — generate 1 normal idea, reset holiday, keep photoDescription
bot.action(/^asst_idea_holiday_off:(\d+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const session = await getActiveSession(user.id);
  if (!session?.sticker_ideas_state) {
    await ctx.reply(lang === "ru" ? "⚠️ Сессия устарела. Пришли фото заново." : "⚠️ Session expired. Send a photo again.");
    return;
  }

  const state = session.sticker_ideas_state as { styleId: string; ideaIndex: number; ideas: StickerIdea[]; holidayId?: string | null; photoDescription?: string };

  try { await ctx.deleteMessage(); } catch {}
  const loadingMsg = await ctx.reply(
    lang === "ru" ? "💡 Придумываю идею..." : "💡 Coming up with an idea..."
  );

  let idea: StickerIdea;
  try {
    idea = await generateNextIdea({
      photoDescription: state.photoDescription || "",
      stylePresetId: state.styleId,
      lang,
      shownIdeas: [], // fresh start without holiday
    });
    console.log("[asst_idea_holiday_off] Generated normal idea:", idea.titleEn);
  } catch (err: any) {
    console.error("[asst_idea_holiday_off] Error:", err.message);
    idea = getDefaultIdeas(lang)[0];
  }

  const newState = { styleId: state.styleId, ideaIndex: 0, ideas: [idea], photoDescription: state.photoDescription, holidayId: null };
  await supabase.from("sessions").update({
    sticker_ideas_state: newState,
    state: "assistant_wait_idea",
    is_active: true,
  }).eq("id", session.id);

  try { await ctx.deleteMessage(loadingMsg.message_id); } catch {}

  const preset = await getStylePresetV2ById(state.styleId);
  if (!preset) return;

  await showStickerIdeaCard(ctx, {
    idea, ideaIndex: 0, totalIdeas: 0, style: preset, lang,
    currentHolidayId: null,
  });
});

// Holiday theme ON — generate 1 holiday idea, keep photoDescription
bot.action(/^asst_idea_holiday:([^:]+):(\d+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const holidayId = ctx.match[1];
  const session = await getActiveSession(user.id);
  if (!session?.sticker_ideas_state) {
    await ctx.reply(lang === "ru" ? "⚠️ Сессия устарела. Пришли фото заново." : "⚠️ Session expired. Send a photo again.");
    return;
  }

  const state = session.sticker_ideas_state as { styleId: string; ideaIndex: number; ideas: StickerIdea[]; holidayId?: string | null; photoDescription?: string };

  // Get holiday theme
  const { data: holiday } = await supabase.from("holiday_themes").select("*").eq("id", holidayId).maybeSingle();
  if (!holiday) return;

  try { await ctx.deleteMessage(); } catch {}
  const loadingMsg = await ctx.reply(
    lang === "ru" ? `${holiday.emoji} Придумываю праздничную идею...` : `${holiday.emoji} Coming up with a holiday idea...`
  );

  let idea: StickerIdea;
  try {
    idea = await generateNextIdea({
      photoDescription: state.photoDescription || "",
      stylePresetId: state.styleId,
      lang,
      shownIdeas: [], // fresh start for holiday
      holidayModifier: holiday.prompt_modifier,
    });
    console.log("[asst_idea_holiday] Generated holiday idea:", idea.titleEn, "for", holidayId);
  } catch (err: any) {
    console.error("[asst_idea_holiday] Error:", err.message);
    idea = getDefaultIdeas(lang)[0];
  }

  const newState = { styleId: state.styleId, ideaIndex: 0, ideas: [idea], photoDescription: state.photoDescription, holidayId };
  await supabase.from("sessions").update({
    sticker_ideas_state: newState,
    state: "assistant_wait_idea",
    is_active: true,
  }).eq("id", session.id);

  try { await ctx.deleteMessage(loadingMsg.message_id); } catch {}

  const preset = await getStylePresetV2ById(state.styleId);
  if (!preset) return;

  await showStickerIdeaCard(ctx, {
    idea, ideaIndex: 0, totalIdeas: 0, style: preset, lang,
    currentHolidayId: holidayId,
  });
});

// Custom idea — switch to assistant chat
bot.action("asst_idea_custom", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const session = await getActiveSession(user.id);
  if (!session?.id) return;

  // Switch to assistant_chat mode
  await supabase.from("sessions").update({
    state: "assistant_chat",
    is_active: true,
  }).eq("id", session.id);

  try { await ctx.deleteMessage(); } catch {}
  await ctx.reply(
    lang === "ru"
      ? "✏️ Опиши свою идею для стикера — стиль, эмоцию, позу:"
      : "✏️ Describe your sticker idea — style, emotion, pose:",
    getMainMenuKeyboard(lang)
  );
});

// Skip ideas — switch to normal assistant dialog
bot.action("asst_idea_skip", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const session = await getActiveSession(user.id);
  if (!session?.id) return;

  // Switch to assistant_chat mode
  await supabase.from("sessions").update({
    state: "assistant_chat",
    is_active: true,
  }).eq("id", session.id);

  try { await ctx.deleteMessage(); } catch {}
  await ctx.reply(
    lang === "ru"
      ? "👋 Хорошо! Опиши какой стикер хочешь — стиль, эмоцию, позу:"
      : "👋 OK! Describe what sticker you want — style, emotion, pose:",
    getMainMenuKeyboard(lang)
  );
});

// Callback: assistant restart — start new assistant dialog from post-generation button
bot.action("assistant_restart", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  await startAssistantDialog(ctx, user, lang);
});

// Callback: assistant new photo — user chose to use new photo
bot.action("assistant_new_photo", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.id) return;

  const aSession = await getActiveAssistantSession(user.id);
  const newPhotoFileId = aSession?.pending_photo_file_id;
  if (!newPhotoFileId) {
    await ctx.reply(lang === "ru" ? "Фото не найдено, пришли ещё раз." : "Photo not found, please send again.");
    return;
  }
  const photos = Array.isArray(session.photos) ? session.photos : [];
  photos.push(newPhotoFileId);

  // Update photo and notify assistant
  const messages: AssistantMessage[] = Array.isArray(aSession!.messages) ? [...aSession!.messages] : [];
  messages.push({ role: "user", content: "[User sent a new photo and chose to use it]" });

  const systemPrompt = await getAssistantSystemPrompt(messages, aSession!);

  try {
    const result = await callAIChat(messages, systemPrompt);
    messages.push({ role: "assistant", content: result.text });

    // Process tool call if any
    let toolUpdates: Partial<AssistantSessionRow> = {};
    let toolAction = "none";
    if (result.toolCall) {
      const { updates, action: ta } = handleToolCall(result.toolCall, aSession!);
      toolUpdates = updates;
      toolAction = ta;
    }

    await updateAssistantSession(aSession!.id, {
      messages,
      pending_photo_file_id: null,
      ...toolUpdates,
    });

    await supabase
      .from("sessions")
      .update({
        photos,
        current_photo_file_id: newPhotoFileId,
        state: "assistant_chat",
        is_active: true,
      })
      .eq("id", session.id);

    if (toolAction === "show_examples") {
      const styleId = result.toolCall?.args?.style_id;
      await handleShowStyleExamples(ctx, styleId, lang);
      if (result.text) await ctx.reply(result.text, getMainMenuKeyboard(lang));
    } else {
      await ctx.reply(result.text, getMainMenuKeyboard(lang));
    }
  } catch (err: any) {
    console.error("Assistant new photo error:", err.message);
    await supabase
      .from("sessions")
      .update({ photos, current_photo_file_id: newPhotoFileId })
      .eq("id", session.id);

    const msg = lang === "ru"
      ? "Фото обновлено! Продолжаем — опиши стиль стикера."
      : "Photo updated! Let's continue — describe the sticker style.";
    await ctx.reply(msg, getMainMenuKeyboard(lang));
  }
});

// Callback: assistant keep photo — user chose to keep current photo
bot.action("assistant_keep_photo", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
  const msg = lang === "ru" ? "Хорошо, работаем с текущим фото!" : "Ok, keeping the current photo!";
  await ctx.reply(msg);
});

// Callback: buy_credits
bot.action("buy_credits", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) return;

  await sendBuyCreditsMenu(ctx, user);
});

// Callback: rate:<rating_id>:<score>
bot.action(/^rate:(.+):(\d)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const ratingId = ctx.match[1];
  const score = parseInt(ctx.match[2]);
  
  const { error } = await supabase
    .from("sticker_ratings")
    .update({ 
      rating: score, 
      rated_at: new Date().toISOString() 
    })
    .eq("id", ratingId)
    .is("rating", null); // Только если ещё не оценено
  
  if (!error) {
    const thankYouText = "⭐".repeat(score) + " Спасибо за оценку! 🙏";
    await ctx.editMessageText(thankYouText);
  }
});

// Callback: make_example (admin only - from alert channel)
bot.action(/^make_example:(.+)$/, async (ctx) => {
  console.log("=== make_example callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // Check if admin
  if (!config.adminIds.includes(telegramId)) {
    console.log("User not admin:", telegramId);
    return;
  }

  const stickerId = ctx.match[1];
  console.log("stickerId:", stickerId);

  // Get sticker to check style_preset_id
  const { data: sticker } = await supabase
    .from("stickers")
    .select("id, style_preset_id, is_example")
    .eq("id", stickerId)
    .maybeSingle();

  if (!sticker) {
    console.log("Sticker not found");
    await ctx.editMessageText("❌ Стикер не найден");
    return;
  }

  if (!sticker.style_preset_id) {
    console.log("Sticker has no style_preset_id");
    await ctx.editMessageText("❌ У стикера нет стиля");
    return;
  }

  if (sticker.is_example) {
    console.log("Sticker already an example");
    await ctx.editMessageText("✅ Уже является примером");
    return;
  }

  // Mark as example
  const { error } = await supabase
    .from("stickers")
    .update({ is_example: true })
    .eq("id", stickerId);

  if (error) {
    console.error("Failed to mark as example:", error);
    await ctx.editMessageText("❌ Ошибка сохранения");
    return;
  }

  console.log("Marked as example:", stickerId, "style:", sticker.style_preset_id);
  await ctx.editMessageText(`✅ Добавлен как пример для стиля "${sticker.style_preset_id}"`);
});

// Callback: pack_make_example (admin only — from alert channel, pack preview "Сделать примером")
bot.action(/^pack_make_example:(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId || !config.adminIds.includes(telegramId)) return;

  const styleId = ctx.match[1];
  const msg = ctx.callbackQuery?.message as any;
  const photo = msg?.photo;
  if (!Array.isArray(photo) || photo.length === 0) {
    await ctx.editMessageText("❌ Нет фото в сообщении");
    return;
  }
  const fileId = photo[photo.length - 1]?.file_id;
  if (!fileId) {
    await ctx.editMessageText("❌ Не удалось получить file_id");
    return;
  }

  const { error } = await supabase
    .from("style_presets_v2")
    .update({ pack_example_file_id: fileId })
    .eq("id", styleId);

  if (error) {
    console.error("[pack_make_example] Update failed:", error);
    await ctx.editMessageText("❌ Ошибка сохранения");
    return;
  }
  await ctx.editMessageText(`✅ Сохранено как пример пака для стиля "${styleId}"`);
});

// Callback: admin_discount — admin sends discount offer to user from alert channel
bot.action(/^admin_discount:(\d+):(\d+)$/, async (ctx) => {
  console.log("=== admin_discount callback ===");
  safeAnswerCbQuery(ctx);
  const adminTelegramId = ctx.from?.id;
  if (!adminTelegramId) return;

  // Only admins can use this
  if (!config.adminIds.includes(adminTelegramId)) {
    console.log("[admin_discount] Not admin:", adminTelegramId);
    return;
  }

  const targetTelegramId = parseInt(ctx.match[1], 10);
  const discountPercent = parseInt(ctx.match[2], 10);
  console.log("[admin_discount] targetTelegramId:", targetTelegramId, "discount:", discountPercent + "%");

  // Get target user
  const user = await getUser(targetTelegramId);
  if (!user?.id) {
    console.log("[admin_discount] User not found:", targetTelegramId);
    await ctx.editMessageText(`❌ Пользователь ${targetTelegramId} не найден`);
    return;
  }

  const lang = user.lang || "en";
  const uname = user.username || targetTelegramId;

  // Find discount packs matching the percent
  const discountSuffix = `-${discountPercent}%`;
  const discountPacks = CREDIT_PACKS.filter(
    (p: any) => p.hidden && p.label_en.endsWith(discountSuffix)
  );

  if (discountPacks.length === 0) {
    console.log("[admin_discount] No packs found for discount:", discountPercent + "%");
    await ctx.editMessageText(`❌ Нет пакетов для скидки ${discountPercent}%`);
    return;
  }

  // Build message text
  const messageText = lang === "ru"
    ? `🔥 Специальное предложение для тебя!\n\nСкидка ${discountPercent}% на все пакеты стикеров 🎉\n\n💰 Выбирай:`
    : `🔥 Special offer just for you!\n\n${discountPercent}% off on all sticker packs 🎉\n\n💰 Choose your pack:`;

  // Build inline buttons for discount packs (plain objects for direct API call)
  const inlineKeyboard: { text: string; callback_data: string }[][] = [];
  for (const pack of discountPacks) {
    const label = lang === "ru" ? pack.label_ru : pack.label_en;
    const unit = lang === "ru" ? "стикеров" : "stickers";
    inlineKeyboard.push([{
      text: `${label}: ${pack.credits} ${unit} — ${pack.price}⭐ (${pack.price_rub}₽)`,
      callback_data: `pack_${pack.credits}_${pack.price}`,
    }]);
  }

  // Add "Buy Stars for ₽" button (RU only)
  if (lang === "ru") {
    (inlineKeyboard as any[]).push([{ text: "💵 Купить Stars за ₽", url: "https://t.me/StarsZakupBot?start=ref_r_0477825983" }]);
  }

  // Send discount message to user
  try {
    await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      chat_id: targetTelegramId,
      text: messageText,
      reply_markup: { inline_keyboard: inlineKeyboard },
    });

    console.log("[admin_discount] Discount message sent to:", targetTelegramId);

    // Update button in alert channel to "✅ Sent"
    await ctx.editMessageText(`✅ Скидка ${discountPercent}% отправлена @${uname}`);
  } catch (err: any) {
    const errMsg = err.response?.data?.description || err.message;
    console.error("[admin_discount] Failed to send to user:", errMsg);

    if (errMsg?.includes("bot was blocked") || errMsg?.includes("chat not found")) {
      await ctx.editMessageText(`❌ Не удалось отправить @${uname} — бот заблокирован`);
    } else {
      await ctx.editMessageText(`❌ Ошибка отправки @${uname}: ${errMsg}`);
    }
  }
});

// Callback: admin_send_outreach — send personalized outreach message to user
bot.action(/^admin_send_outreach:(.+)$/, async (ctx) => {
  console.log("=== admin_send_outreach callback ===");
  safeAnswerCbQuery(ctx);
  const adminTelegramId = ctx.from?.id;
  if (!adminTelegramId || !config.adminIds.includes(adminTelegramId)) return;

  const outreachId = ctx.match[1];

  // Load outreach from DB
  const { data: outreach } = await supabase
    .from("user_outreach")
    .select("*")
    .eq("id", outreachId)
    .single();

  if (!outreach) {
    await ctx.answerCbQuery("❌ Outreach не найден");
    return;
  }

  if (outreach.status !== "draft") {
    await ctx.answerCbQuery(`Уже отправлено (${outreach.status})`);
    return;
  }

  const user = await getUser(outreach.telegram_id);
  const uname = user?.username || outreach.telegram_id;

  // Send message to user with reply button
  try {
    const replyButtonUrl = `https://t.me/${config.supportBotUsername}?start=outreach_${outreachId}`;

    await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      chat_id: outreach.telegram_id,
      text: outreach.message_text,
      reply_markup: {
        inline_keyboard: [[
          { text: "💬 Ответить", url: replyButtonUrl },
        ]],
      },
    });

    // Update status to sent
    await supabase
      .from("user_outreach")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", outreachId);

    console.log("[Outreach] Sent to:", outreach.telegram_id);

    // Update alert message
    await ctx.editMessageText(`✅ Outreach отправлен @${uname}\n\n"${outreach.message_text}"`);
  } catch (err: any) {
    const errMsg = err.response?.data?.description || err.message;
    console.error("[Outreach] Failed to send:", errMsg);

    if (errMsg?.includes("bot was blocked") || errMsg?.includes("chat not found")) {
      await ctx.editMessageText(`❌ Не удалось отправить @${uname} — бот заблокирован`);
    } else {
      await ctx.editMessageText(`❌ Ошибка отправки @${uname}: ${errMsg}`);
    }
  }
});

// Callback: admin_regen_outreach — regenerate outreach message
bot.action(/^admin_regen_outreach:(.+)$/, async (ctx) => {
  console.log("=== admin_regen_outreach callback ===");
  safeAnswerCbQuery(ctx);
  const adminTelegramId = ctx.from?.id;
  if (!adminTelegramId || !config.adminIds.includes(adminTelegramId)) return;

  const outreachId = ctx.match[1];

  // Load outreach from DB
  const { data: outreach } = await supabase
    .from("user_outreach")
    .select("*")
    .eq("id", outreachId)
    .single();

  if (!outreach || outreach.status !== "draft") {
    await ctx.answerCbQuery("❌ Нельзя перегенерировать");
    return;
  }

  // Get user info for regeneration
  const user = await getUser(outreach.telegram_id);
  if (!user) {
    await ctx.answerCbQuery("❌ Пользователь не найден");
    return;
  }

  const lang = user.lang || "en";

  // Regenerate via AI
  try {
    const systemPrompt = await getText(lang, "outreach.system_prompt");
    const userContext = `Name: ${user.first_name || "unknown"}\nUsername: ${user.username || "none"}\nLanguage: ${lang}\nSource: ${user.utm_source || "organic"}/${user.utm_medium || "none"}`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`,
      {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userContext }] }],
      },
      { headers: { "x-goog-api-key": config.geminiApiKey } }
    );

    const newText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!newText) {
      await ctx.answerCbQuery("❌ AI не сгенерировал текст");
      return;
    }

    // Update in DB
    await supabase
      .from("user_outreach")
      .update({ message_text: newText })
      .eq("id", outreachId);

    // Update alert message with new preview
    const uname = user.username || outreach.telegram_id;
    const utmInfo = user.utm_source ? `\n📢 Источник: ${user.utm_source}${user.utm_medium ? "/" + user.utm_medium : ""}` : "";
    const alertText =
      `🆕 *Новый пользователь*\n\n` +
      `👤 @${escapeMarkdownForAlert(uname)} (${outreach.telegram_id})` +
      `\n🌐 Язык: ${user.language_code || "unknown"}${utmInfo}\n\n` +
      `✉️ *Outreach (обновлён):*\n"${escapeMarkdownForAlert(newText)}"`;

    await ctx.editMessageText(alertText, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔥 -10%", callback_data: `admin_discount:${outreach.telegram_id}:10` },
            { text: "🔥 -15%", callback_data: `admin_discount:${outreach.telegram_id}:15` },
            { text: "🔥 -25%", callback_data: `admin_discount:${outreach.telegram_id}:25` },
          ],
          [
            { text: "✉️ Отправить", callback_data: `admin_send_outreach:${outreachId}` },
            { text: "🔄 Заново", callback_data: `admin_regen_outreach:${outreachId}` },
          ],
        ],
      },
    });

    console.log("[Outreach] Regenerated for:", outreach.telegram_id);
  } catch (err: any) {
    console.error("[Outreach] Regen failed:", err.response?.data || err.message);
    await ctx.answerCbQuery("❌ Ошибка перегенерации");
  }
});

// Callback: admin_reply_outreach — admin wants to reply to user's outreach response
bot.action(/^admin_reply_outreach:(.+)$/, async (ctx) => {
  console.log("=== admin_reply_outreach callback ===");
  safeAnswerCbQuery(ctx);
  const adminTelegramId = ctx.from?.id;
  if (!adminTelegramId || !config.adminIds.includes(adminTelegramId)) return;

  const outreachId = ctx.match[1];

  // Load outreach from DB
  const { data: outreach } = await supabase
    .from("user_outreach")
    .select("*")
    .eq("id", outreachId)
    .single();

  if (!outreach) {
    await ctx.answerCbQuery("❌ Outreach не найден");
    return;
  }

  const user = await getUser(outreach.telegram_id);
  const uname = user?.username || String(outreach.telegram_id);

  // Send prompt to admin's DM
  try {
    const promptText =
      `✏️ *Напиши ответ для @${escapeMarkdownForAlert(uname)}:*\n\n` +
      `📨 Outreach: "${escapeMarkdownForAlert((outreach.message_text || "").slice(0, 200))}"\n` +
      `💬 Его ответ: "${escapeMarkdownForAlert((outreach.reply_text || "").slice(0, 300))}"\n\n` +
      `Отправь следующее сообщение — оно уйдёт пользователю\\.\n` +
      `Или /cancel для отмены\\.`;

    await ctx.telegram.sendMessage(adminTelegramId, promptText, {
      parse_mode: "MarkdownV2",
    });

    // Save pending state
    pendingAdminReplies.set(adminTelegramId, {
      outreachId,
      userTelegramId: outreach.telegram_id,
      username: uname,
    });

    console.log("[AdminReply] Waiting for admin reply, outreachId:", outreachId);
  } catch (err: any) {
    console.error("[AdminReply] Can't DM admin:", err.message);
    // If bot can't write to admin DM, admin hasn't started the bot
    try {
      await ctx.answerCbQuery("❌ Сначала напиши /start боту в личку", { show_alert: true });
    } catch {}
  }
});

// Callback: retry_generation — retry failed generation from error message
bot.action(/^retry_generation:(.+)$/, async (ctx) => {
  console.log("=== retry_generation callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const sessionId = ctx.match[1];
  console.log("[retry_generation] sessionId:", sessionId, "telegramId:", telegramId);

  const user = await getUser(telegramId);
  if (!user?.id) {
    console.log("[retry_generation] User not found:", telegramId);
    return;
  }

  const lang = user.lang || "en";

  // Get the original session
  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!session) {
    console.log("[retry_generation] Session not found:", sessionId);
    const notFoundText = lang === "ru"
      ? "❌ Сессия не найдена. Отправь новое фото."
      : "❌ Session not found. Send a new photo.";
    await ctx.editMessageText(notFoundText);
    return;
  }

  if (!session.prompt_final) {
    console.log("[retry_generation] No prompt_final in session:", sessionId);
    const noPromptText = lang === "ru"
      ? "❌ Не удалось повторить. Отправь новое фото."
      : "❌ Cannot retry. Send a new photo.";
    await ctx.editMessageText(noPromptText);
    return;
  }

  // Update error message to show retry in progress
  const retryingText = lang === "ru"
    ? "🔄 Повторяю генерацию..."
    : "🔄 Retrying generation...";
  await ctx.editMessageText(retryingText).catch(() => {});

  try {
    // Re-run startGeneration with the same parameters
    await startGeneration(ctx, user, session, lang, {
      generationType: session.generation_type || "style",
      promptFinal: session.prompt_final,
      userInput: session.user_input,
      selectedStyleId: session.selected_style_id,
      selectedEmotion: session.selected_emotion,
      emotionPrompt: session.emotion_prompt,
      textPrompt: session.text_prompt,
    });
    console.log("[retry_generation] Generation restarted for session:", sessionId);
  } catch (err: any) {
    console.error("[retry_generation] Failed:", err.message);
    const failText = lang === "ru"
      ? "❌ Не удалось повторить генерацию. Попробуй позже или отправь новое фото."
      : "❌ Retry failed. Try again later or send a new photo.";
    await ctx.reply(failText);
  }
});

// ============================================================
// Pack Ideas — AI-powered sticker pack idea generator
// ============================================================

interface StickerIdea {
  emoji: string;
  titleRu: string;
  titleEn: string;
  descriptionRu: string;
  descriptionEn: string;
  promptModification: string;
  hasText: boolean;
  textSuggestion?: string | null;
  textPlacement?: "speech_bubble" | "sign" | "bottom_caption" | null;
  category: string;
  generated?: boolean;
}

// --- Pack Ideas: randomization pools ---
const IDEA_THEME_POOL = [
  "everyday reactions",
  "work & study life",
  "food & drinks",
  "relationships & love",
  "gaming & internet culture",
  "celebrations & holidays",
  "passive-aggressive responses",
  "motivational & inspiring",
  "sarcastic comebacks",
  "party & nightlife",
  "morning & evening routine",
  "pet owner life",
  "introvert vs extrovert",
  "sports & fitness",
  "weather & seasons",
  "shopping & money",
  "travel & vacation",
  "procrastination & deadlines",
  "self-care & relaxation",
  "friendship & loyalty",
  "awkward situations",
  "nostalgia & childhood",
  "compliments & flirting",
  "apologies & forgiveness",
];

const IDEA_TONE_POOL = [
  "wholesome & cute",
  "sarcastic & edgy",
  "meme energy",
  "chill & minimal",
  "chaotic & absurd",
  "dramatic & expressive",
];

function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function generatePackIdeas(opts: {
  stickerFileId: string;
  stylePresetId: string | null;
  lang: string;
  existingStickers: string[];
}): Promise<StickerIdea[]> {
  const { stickerFileId, stylePresetId, lang, existingStickers } = opts;

  // Download sticker image for AI analysis
  const filePath = await getFilePath(stickerFileId);
  const fileBuffer = await downloadFile(filePath);
  const base64 = fileBuffer.toString("base64");
  const mimeType = filePath.endsWith(".webp") ? "image/webp" : filePath.endsWith(".png") ? "image/png" : "image/jpeg";

  // Get style info
  let styleName = stylePresetId || "custom";
  let styleHint = "";
  if (stylePresetId) {
    const presets = await getStylePresets();
    const preset = presets.find((p: any) => p.id === stylePresetId);
    if (preset) {
      styleName = preset.name_en || preset.id;
      styleHint = preset.prompt_hint || "";
    }
  }

  const existingList = existingStickers.length > 0
    ? existingStickers.map((s, i) => `${i + 1}. ${s}`).join("\n")
    : "None yet (this is the first sticker)";

  const textLang = lang === "ru" ? "Russian" : "English";

  // Randomize themes and tone for diverse results
  const selectedThemes = shuffleArray(IDEA_THEME_POOL).slice(0, 4);
  const selectedTone = IDEA_TONE_POOL[Math.floor(Math.random() * IDEA_TONE_POOL.length)];

  console.log("[PackIdeas] Themes:", selectedThemes.join(", "), "| Tone:", selectedTone);

  const systemPrompt = `You are a professional sticker pack designer. Analyze the sticker image and create a set of 8 unique ideas for additional stickers in the same style to build a complete sticker pack.

The user's sticker style: ${styleName} (${styleHint})
Pack vibe: ${selectedTone}
Themes to explore: ${selectedThemes.join(", ")}

Already existing stickers in the pack (DO NOT repeat similar ideas):
${existingList}

CRITICAL — Preserving character appearance:
- Carefully analyze the character's OUTFIT, ACCESSORIES, HAIRSTYLE, and KEY VISUAL FEATURES in the sticker image
- EVERY idea's promptModification MUST explicitly describe the character wearing the SAME outfit/clothing as in the original sticker
- Do NOT change the character's clothes, hat, glasses, hairstyle, or other defining features unless the idea is specifically in the "outfit" category
- Example: if the character wears a red hoodie and sneakers, every promptModification should include "wearing red hoodie and sneakers"

Rules:
1. Each idea MUST be from a DIFFERENT category — no two ideas share the same category
2. Distribute ideas across the given themes (at least 1 per theme: ${selectedThemes.join(", ")})
3. Match the pack vibe: ${selectedTone}
4. For text ideas:
   - Suggest short text (1-3 words) in ${textLang}
   - Text should be creative and unexpected — avoid cliché like "OK", "Hello", "Thanks", "LOL"
   - Think of funny, niche, or culturally relevant phrases. Inside jokes, meme references, emotional outbursts, sarcastic comments work great.
   - Specify placement: speech_bubble, sign, or bottom_caption
5. promptModification must be in English, detailed enough for image generation. ALWAYS include the character's original outfit description.
6. Keep the same character/subject from the original sticker — same face, body, outfit, accessories
7. titleRu and descriptionRu must be in Russian, titleEn and descriptionEn in English
8. Be CREATIVE and SURPRISING — avoid generic/obvious ideas. Think of situations, micro-moments, and niche scenarios that feel relatable.

Return a JSON array of exactly 8 ideas in this format:
[{
  "emoji": "😂",
  "titleRu": "Хохочет до слёз",
  "titleEn": "Laughing hard",
  "descriptionRu": "Персонаж смеётся, держась за живот",
  "descriptionEn": "Character laughing hysterically, holding belly",
  "promptModification": "laughing hysterically, holding belly, tears of joy, mouth wide open",
  "hasText": false,
  "textSuggestion": null,
  "textPlacement": null,
  "category": "emotion"
}]

Categories: emotion, reaction, action, scene, text_meme, greeting, farewell, sarcasm, motivation, celebration, question, flirt, tired, proud, confusion, surprise`;

  // Use GPT-4o when OpenAI key is set, otherwise fallback to Gemini
  if (config.openaiApiKey) {
    try {
      const imageUrl = `data:${mimeType};base64,${base64}`;
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: "Analyze this sticker and generate 8 unique ideas for a sticker pack. Return a JSON array of exactly 8 ideas." },
                {
                  type: "image_url",
                  image_url: { url: imageUrl },
                },
              ],
            },
          ],
          response_format: { type: "json_object" },
          max_tokens: 4096,
          temperature: 1.2,
        },
        {
          headers: {
            "Authorization": `Bearer ${config.openaiApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 60_000, // 60s timeout for GPT-4o vision call
        }
      );

      const text = response.data?.choices?.[0]?.message?.content;
      if (!text) {
        console.error("[PackIdeas] GPT-4o returned no content");
        return getDefaultIdeas(lang);
      }

      const parsed = JSON.parse(text);

      // GPT-4o returns various formats: array, {ideas:[]}, {items:[]}, {json:[]}, {data:[]}, or single object
      let ideas: any[];
      if (Array.isArray(parsed)) {
        ideas = parsed;
      } else if (typeof parsed === "object" && parsed !== null) {
        // Try known wrapper keys
        const wrapped = parsed.ideas || parsed.items || parsed.json || parsed.data || parsed.sticker_ideas || parsed.stickerIdeas;
        if (Array.isArray(wrapped)) {
          ideas = wrapped;
        } else if (parsed.emoji && parsed.promptModification) {
          // Single idea object returned — wrap in array
          ideas = [parsed];
        } else {
          // Last resort: find first array value in the object
          const firstArray = Object.values(parsed).find((v) => Array.isArray(v)) as any[] | undefined;
          ideas = firstArray || [];
        }
      } else {
        ideas = [];
      }

      if (ideas.length === 0) {
        console.error("[PackIdeas] GPT-4o unexpected format, no ideas extracted:", text.slice(0, 300));
        return getDefaultIdeas(lang);
      }

      console.log("[PackIdeas] GPT-4o generated", ideas.length, "ideas");

      // If GPT-4o returned fewer than 8, pad with default ideas
      if (ideas.length < 8) {
        console.log("[PackIdeas] Padding with default ideas:", 8 - ideas.length, "needed");
        const defaults = getDefaultIdeas(lang);
        const existingTitles = new Set(ideas.map((i: any) => i.titleEn?.toLowerCase()));
        for (const d of defaults) {
          if (ideas.length >= 8) break;
          if (!existingTitles.has(d.titleEn?.toLowerCase())) {
            ideas.push(d);
          }
        }
      }

      return ideas.slice(0, 8);
    } catch (err: any) {
      console.error("[PackIdeas] GPT-4o Error:", err.response?.data || err.message);
      return getDefaultIdeas(lang);
    }
  }

  // Fallback: Gemini when OPENAI_API_KEY is not set
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [
              { text: "Analyze this sticker and generate 8 unique ideas for a sticker pack." },
              {
                inlineData: {
                  mimeType,
                  data: base64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 1.2,
        },
      },
      {
        headers: { "x-goog-api-key": config.geminiApiKey },
      }
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error("[PackIdeas] Gemini returned no text");
      return getDefaultIdeas(lang);
    }

    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.error("[PackIdeas] Unexpected format:", text.slice(0, 200));
      return getDefaultIdeas(lang);
    }

    console.log("[PackIdeas] Gemini generated", parsed.length, "ideas");
    return parsed.slice(0, 8);
  } catch (err: any) {
    console.error("[PackIdeas] Gemini Error:", err.response?.data || err.message);
    return getDefaultIdeas(lang);
  }
}

function getDefaultIdeas(lang: string): StickerIdea[] {
  return [
    { emoji: "😂", titleRu: "Хохочет", titleEn: "Laughing", descriptionRu: "Смеётся от души", descriptionEn: "Laughing out loud", promptModification: "laughing hysterically, tears of joy, mouth wide open", hasText: false, textSuggestion: null, textPlacement: null, category: "emotion" },
    { emoji: "😢", titleRu: "Грустит", titleEn: "Sad", descriptionRu: "Грустный, слёзы", descriptionEn: "Feeling sad, teary", promptModification: "looking sad, single tear rolling down cheek, pouty expression", hasText: false, textSuggestion: null, textPlacement: null, category: "emotion" },
    { emoji: "😡", titleRu: "Злится", titleEn: "Angry", descriptionRu: "Злой, в ярости", descriptionEn: "Angry, furious", promptModification: "angry expression, furrowed brows, clenched fists, red face", hasText: false, textSuggestion: null, textPlacement: null, category: "emotion" },
    { emoji: "👋", titleRu: "Машет рукой", titleEn: "Waving", descriptionRu: "Приветливо машет", descriptionEn: "Waving hello", promptModification: "waving hand cheerfully, friendly smile, saying hello", hasText: false, textSuggestion: null, textPlacement: null, category: "action" },
    { emoji: "👍", titleRu: "Класс!", titleEn: "Thumbs up", descriptionRu: "Показывает палец вверх", descriptionEn: "Giving thumbs up", promptModification: "giving thumbs up, confident smile, approving gesture", hasText: false, textSuggestion: null, textPlacement: null, category: "action" },
    { emoji: "💬", titleRu: "Привет!", titleEn: "Hi!", descriptionRu: "С речевым пузырём", descriptionEn: "With speech bubble", promptModification: "cheerful expression, waving, with speech bubble", hasText: true, textSuggestion: lang === "ru" ? "Привет!" : "Hi!", textPlacement: "speech_bubble", category: "text_meme" },
    { emoji: "💬", titleRu: "ОК", titleEn: "OK", descriptionRu: "Показывает ОК", descriptionEn: "Saying OK", promptModification: "calm confident expression, OK hand gesture", hasText: true, textSuggestion: "OK", textPlacement: "speech_bubble", category: "text_meme" },
    { emoji: "☕", titleRu: "Утро с кофе", titleEn: "Morning coffee", descriptionRu: "Пьёт кофе утром", descriptionEn: "Drinking morning coffee", promptModification: "holding a coffee cup, sleepy but happy expression, morning vibes", hasText: false, textSuggestion: null, textPlacement: null, category: "scene" },
  ];
}

// ============================================================
// Sticker Ideas from Photo — generate ideas before first sticker
// ============================================================

// Generate first idea WITH photo analysis — returns 1 idea + text description of person(s)
async function generateFirstIdeaWithPhoto(opts: {
  photoFileId: string;
  stylePresetId: string;
  lang: string;
  holidayModifier?: string;
}): Promise<{ idea: StickerIdea; photoDescription: string }> {
  const { photoFileId, stylePresetId, lang, holidayModifier } = opts;

  const preset = await getStylePresetV2ById(stylePresetId);
  const styleName = preset ? preset.name_en : stylePresetId;
  const styleHint = preset ? preset.prompt_hint : "";
  const textLang = lang === "ru" ? "Russian" : "English";

  // Download and compress photo to 256px
  const filePath = await getFilePath(photoFileId);
  const fileBuffer = await downloadFile(filePath);
  const resizedBuffer = await sharp(fileBuffer)
    .resize(256, 256, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  const base64 = resizedBuffer.toString("base64");
  console.log("[FirstIdea] Photo compressed:", fileBuffer.length, "->", resizedBuffer.length, "bytes");

  const systemPrompt = `You are a professional sticker pack designer. Analyze the user's PHOTO.

1. Write a detailed DESCRIPTION of the person(s): face shape, skin tone, hair color/style, facial hair, glasses, clothing, accessories, body type, age range, vibe/energy.
   If MULTIPLE people — describe each person and their relationship/interaction.

2. Suggest 1 unique sticker idea in the style: ${styleName} (${styleHint}).
   The idea should match the person's appearance and vibe.
${holidayModifier ? `\nIMPORTANT THEME: ${holidayModifier}\n` : ''}
Rules:
- promptModification must describe what the character is DOING (emotion + pose + action). Do NOT describe the style.
- promptModification must be in English, detailed enough for image generation
- titleRu/descriptionRu in Russian, titleEn/descriptionEn in English
- Be CREATIVE — avoid generic ideas
- For text ideas: suggest short text (1-3 words) in ${textLang}

Return JSON:
{
  "photoDescription": "detailed text description of person(s)...",
  "idea": {
    "emoji": "😂",
    "titleRu": "Хохочет до слёз",
    "titleEn": "Laughing hard",
    "descriptionRu": "Персонаж смеётся, держась за живот",
    "descriptionEn": "Character laughing hysterically, holding belly",
    "promptModification": "laughing hysterically, holding belly, tears of joy, mouth wide open",
    "hasText": false,
    "textSuggestion": null,
    "textPlacement": null,
    "category": "emotion"
  }
}

Categories: emotion, reaction, action, scene, text_meme, greeting, farewell, sarcasm, motivation, celebration`;

  if (!config.openaiApiKey) {
    console.log("[FirstIdea] No OpenAI key, using default");
    const defaults = getDefaultIdeas(lang);
    return { idea: defaults[0], photoDescription: "" };
  }

  const imageUrl = `data:image/jpeg;base64,${base64}`;
  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this photo. Return JSON with photoDescription and 1 sticker idea." },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1500,
      temperature: 1.0,
    },
    {
      headers: {
        "Authorization": `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    }
  );

  const text = response.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("GPT returned no content");

  const parsed = JSON.parse(text);
  const photoDescription = parsed.photoDescription || parsed.photo_description || "";
  const idea = parsed.idea || parsed;
  console.log("[FirstIdea] Got description:", photoDescription.slice(0, 100), "...");
  console.log("[FirstIdea] Got idea:", idea.titleEn);

  return { idea, photoDescription };
}

// Generate next idea WITHOUT photo — text-only, fast (~2-4s)
async function generateNextIdea(opts: {
  photoDescription: string;
  stylePresetId: string;
  lang: string;
  shownIdeas: string[];
  holidayModifier?: string;
}): Promise<StickerIdea> {
  const { photoDescription, stylePresetId, lang, shownIdeas, holidayModifier } = opts;

  const preset = await getStylePresetV2ById(stylePresetId);
  const styleName = preset ? preset.name_en : stylePresetId;
  const styleHint = preset ? preset.prompt_hint : "";
  const textLang = lang === "ru" ? "Russian" : "English";

  const systemPrompt = `You are a professional sticker pack designer.

Person description (from photo analysis):
${photoDescription}

Style: ${styleName} (${styleHint})
${holidayModifier ? `\nIMPORTANT THEME: ${holidayModifier}\n` : ''}
Already shown ideas (DO NOT repeat similar):
${shownIdeas.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Suggest 1 NEW unique sticker idea, different from all shown above.
Match the idea to the person's appearance and vibe described above.

Rules:
- promptModification must describe what the character is DOING (emotion + pose + action). Do NOT describe the style.
- promptModification must be in English, detailed enough for image generation
- titleRu/descriptionRu in Russian, titleEn/descriptionEn in English
- Be CREATIVE — avoid generic ideas. Think of relatable micro-moments and surprising scenarios.
- For text ideas: suggest short text (1-3 words) in ${textLang}
- Pick a DIFFERENT category from what was already shown

Return JSON:
{
  "emoji": "😂",
  "titleRu": "...",
  "titleEn": "...",
  "descriptionRu": "...",
  "descriptionEn": "...",
  "promptModification": "...",
  "hasText": false,
  "textSuggestion": null,
  "textPlacement": null,
  "category": "emotion"
}

Categories: emotion, reaction, action, scene, text_meme, greeting, farewell, sarcasm, motivation, celebration`;

  if (!config.openaiApiKey) {
    const defaults = getDefaultIdeas(lang);
    const shown = new Set(shownIdeas.map(t => t.toLowerCase()));
    return defaults.find(d => !shown.has(d.titleEn.toLowerCase())) || defaults[0];
  }

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Generate 1 new unique sticker idea. Return JSON." },
      ],
      response_format: { type: "json_object" },
      max_tokens: 800,
      temperature: 1.1,
    },
    {
      headers: {
        "Authorization": `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    }
  );

  const text = response.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("GPT returned no content");

  const parsed = JSON.parse(text);
  const idea = parsed.idea || parsed;
  console.log("[NextIdea] Generated:", idea.titleEn, "category:", idea.category);
  return idea;
}

// Show sticker idea card with inline buttons
async function showStickerIdeaCard(ctx: any, opts: {
  idea: StickerIdea;
  ideaIndex: number;
  totalIdeas: number;
  style: StylePresetV2;
  lang: string;
  currentHolidayId?: string | null;
}) {
  const { idea, ideaIndex, totalIdeas, style, lang, currentHolidayId } = opts;
  const isRu = lang === "ru";

  const text = [
    `💡 ${isRu ? "Идея" : "Idea"} ${ideaIndex + 1}`,
    ``,
    `🎨 ${isRu ? "Стиль" : "Style"}: ${style.emoji} ${isRu ? style.name_ru : style.name_en}`,
    `${idea.emoji} ${isRu ? idea.titleRu : idea.titleEn}`,
    `${isRu ? idea.descriptionRu : idea.descriptionEn}`,
  ].join("\n");

  // Build keyboard rows
  const rows: any[][] = [];

  rows.push([Markup.button.callback(
    isRu ? `🎨 Сгенерить (1💎)` : `🎨 Generate (1💎)`,
    `asst_idea_gen:${ideaIndex}`
  )]);

  // Holiday button + Next idea
  const holiday = await getActiveHoliday();
  console.log("[showStickerIdeaCard] holiday:", holiday?.id, "currentHolidayId:", currentHolidayId);
  const holidayNextRow: any[] = [];
  if (holiday) {
    const isHolidayActive = currentHolidayId === holiday.id;
    const holidayName = isRu ? holiday.name_ru : holiday.name_en;
    const holidayLabel = isHolidayActive
      ? `${holiday.emoji} ${holidayName}: on`
      : `${holiday.emoji} ${holidayName}: off`;
    const holidayCallback = isHolidayActive
      ? `asst_idea_holiday_off:${ideaIndex}`
      : `asst_idea_holiday:${holiday.id}:${ideaIndex}`;
    holidayNextRow.push(Markup.button.callback(holidayLabel, holidayCallback));
  }
  holidayNextRow.push(Markup.button.callback(
    isRu ? "➡️ Другая" : "➡️ Next",
    `asst_idea_next:${ideaIndex}`
  ));
  rows.push(holidayNextRow);

  rows.push([Markup.button.callback(
    isRu ? "🔄 Другой стиль" : "🔄 Change style",
    `asst_idea_style:${ideaIndex}`
  )]);

  rows.push([Markup.button.callback(
    isRu ? "✏️ Своя идея" : "✏️ Custom idea",
    "asst_idea_custom"
  )]);

  rows.push([Markup.button.callback(
    isRu ? "⏭️ Пропустить" : "⏭️ Skip",
    "asst_idea_skip"
  )]);

  await ctx.reply(text, Markup.inlineKeyboard(rows));
}

async function generateCustomIdea(opts: {
  stickerFileId: string;
  stylePresetId: string | null;
  lang: string;
  userConcept: string;
}): Promise<StickerIdea> {
  const { stickerFileId, stylePresetId, lang, userConcept } = opts;

  const filePath = await getFilePath(stickerFileId);
  const fileBuffer = await downloadFile(filePath);
  const base64 = fileBuffer.toString("base64");
  const mimeType = filePath.endsWith(".webp") ? "image/webp" : filePath.endsWith(".png") ? "image/png" : "image/jpeg";

  let styleName = stylePresetId || "custom";
  let styleHint = "";
  if (stylePresetId) {
    const presets = await getStylePresets();
    const preset = presets.find((p: any) => p.id === stylePresetId);
    if (preset) {
      styleName = preset.name_en || preset.id;
      styleHint = preset.prompt_hint || "";
    }
  }

  const textLang = lang === "ru" ? "Russian" : "English";

  const systemPrompt = `You are a professional sticker pack designer.
Analyze the sticker image and generate exactly 1 detailed sticker idea based on the user's concept: "${userConcept}".

Style: ${styleName} (${styleHint})

CRITICAL — Preserving character appearance:
- Analyze the character's OUTFIT, ACCESSORIES, HAIRSTYLE in the image
- promptModification MUST describe the character wearing the SAME outfit as in the image
- Do NOT change clothes, hat, glasses, hairstyle or other features

Creative expansion:
- Expand the user's concept into a vivid, detailed scene
- Think about HOW the character expresses this concept (pose, expression, props, scene)
- If the concept implies text (like "спасибо", "ору") — add it as hasText with textSuggestion

Return a single JSON object:
{
  "emoji": "😴",
  "titleRu": "Устал",
  "titleEn": "Tired",
  "descriptionRu": "Персонаж зевает, глаза полузакрыты",
  "descriptionEn": "Character yawning, half-closed eyes",
  "promptModification": "yawning with half-closed eyes, slouching posture, wearing [SAME OUTFIT AS IMAGE]",
  "hasText": false,
  "textSuggestion": null,
  "textPlacement": null,
  "category": "emotion"
}

titleRu and descriptionRu must be in ${textLang === "Russian" ? "Russian" : "English"}.
Categories: emotion, action, scene, text_meme, holiday, outfit`;

  if (config.openaiApiKey) {
    try {
      const imageUrl = `data:${mimeType};base64,${base64}`;
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: `Generate 1 sticker idea for the concept: "${userConcept}". Return a single JSON object.` },
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
          response_format: { type: "json_object" },
          max_tokens: 1024,
        },
        {
          headers: {
            "Authorization": `Bearer ${config.openaiApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 30_000,
        }
      );

      const text = response.data?.choices?.[0]?.message?.content;
      if (!text) {
        console.error("[CustomIdea] GPT-4o-mini returned no content");
        return getDefaultIdeaForConcept(userConcept, lang);
      }

      const parsed = JSON.parse(text);

      // Extract single idea from various formats
      let idea: any;
      if (Array.isArray(parsed)) {
        idea = parsed[0];
      } else if (parsed.emoji && parsed.promptModification) {
        idea = parsed;
      } else {
        // Try to find idea in wrapper
        const wrapped = parsed.idea || parsed.ideas || parsed.item || parsed.json || parsed.data;
        idea = Array.isArray(wrapped) ? wrapped[0] : wrapped;
      }

      if (!idea?.emoji || !idea?.promptModification) {
        console.error("[CustomIdea] Could not extract idea:", text.slice(0, 200));
        return getDefaultIdeaForConcept(userConcept, lang);
      }

      console.log("[CustomIdea] Generated idea:", idea.titleEn);
      return idea;
    } catch (err: any) {
      console.error("[CustomIdea] GPT error:", err.response?.data || err.message);
      return getDefaultIdeaForConcept(userConcept, lang);
    }
  }

  // Fallback: simple idea from concept
  return getDefaultIdeaForConcept(userConcept, lang);
}

function getDefaultIdeaForConcept(concept: string, lang: string): StickerIdea {
  return {
    emoji: "✨",
    titleRu: concept,
    titleEn: concept,
    descriptionRu: `Стикер на тему: ${concept}`,
    descriptionEn: `Sticker about: ${concept}`,
    promptModification: `${concept}, expressive pose and facial expression`,
    hasText: false,
    textSuggestion: null,
    textPlacement: null,
    category: "emotion",
  };
}

function formatIdeaMessage(idea: StickerIdea, index: number, total: number, lang: string): string {
  const title = lang === "ru" ? idea.titleRu : idea.titleEn;
  const desc = lang === "ru" ? idea.descriptionRu : idea.descriptionEn;
  const textHint = idea.hasText && idea.textSuggestion
    ? `\n✏️ ${lang === "ru" ? "Текст" : "Text"}: "${idea.textSuggestion}"`
    : "";

  return `💡 ${lang === "ru" ? "Идея" : "Idea"} ${index + 1}/${total}\n\n`
    + `${idea.emoji} <b>${title}</b>\n`
    + `${desc}${textHint}`;
}

function getIdeaKeyboard(index: number, total: number, lang: string) {
  const generateText = lang === "ru" ? "🎨 Сгенерить (1💎)" : "🎨 Generate (1💎)";
  const nextText = lang === "ru" ? "➡️ Следующая" : "➡️ Next";
  const customText = lang === "ru" ? "✏️ Своя идея" : "✏️ Custom idea";
  const doneText = lang === "ru" ? "✅ Хватит" : "✅ Done";

  const buttons: any[][] = [
    [
      { text: generateText, callback_data: `idea_generate:${index}` },
      { text: nextText, callback_data: "idea_next" },
    ],
    [{ text: customText, callback_data: "custom_idea" }],
    [{ text: doneText, callback_data: "idea_done" }],
  ];

  return { inline_keyboard: buttons };
}

// Callback: Pack Ideas button
bot.action(/^pack_ideas:(.+)$/, async (ctx) => {
  console.log("=== pack_ideas callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];

  // Get sticker info
  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, style_preset_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  if (!sticker?.telegram_file_id) {
    console.log("[PackIdeas] No sticker found:", stickerId);
    return;
  }

  if (sticker.user_id !== user.id) return;

  // Get or create session
  let session = await getActiveSession(user.id);
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "confirm_sticker", is_active: true, env: config.appEnv })
      .select()
      .single();
    session = newSession;
  }
  if (!session?.id) return;

  // Show thinking message
  const thinkingText = lang === "ru" ? "💡 Придумываю идеи для пака..." : "💡 Thinking of ideas for your pack...";
  const thinkingMsg = await ctx.reply(thinkingText);

  // Gather existing stickers context for deduplication
  const existingStickers: string[] = [];
  if (session.generated_from_ideas?.length) {
    const ideas: StickerIdea[] = session.pack_ideas || [];
    for (const ideaId of session.generated_from_ideas) {
      const idx = parseInt(ideaId.replace("idea_", ""), 10);
      if (ideas[idx]) {
        existingStickers.push(ideas[idx].titleEn);
      }
    }
  }
  if (session.selected_style_id) {
    existingStickers.unshift(`Style: ${session.selected_style_id} (initial sticker)`);
  }
  if (session.selected_emotion) {
    existingStickers.push(`Emotion: ${session.selected_emotion}`);
  }

  // Generate ideas via AI
  let ideas: StickerIdea[];
  try {
    ideas = await generatePackIdeas({
      stickerFileId: sticker.telegram_file_id,
      stylePresetId: sticker.style_preset_id,
      lang,
      existingStickers,
    });
    console.log("[PackIdeas] Generated", ideas.length, "ideas");
  } catch (err: any) {
    console.error("[PackIdeas] generatePackIdeas threw:", err.message);
    ideas = getDefaultIdeas(lang);
    console.log("[PackIdeas] Using default ideas");
  }

  // Save ideas to session (keep state as confirm_sticker — state is ENUM, no browsing_ideas value)
  const { error: updateErr } = await supabase.from("sessions").update({
    pack_ideas: ideas,
    current_idea_index: 0,
    is_active: true,
  }).eq("id", session.id);

  if (updateErr) {
    console.error("[PackIdeas] Session update FAILED:", updateErr.message, updateErr.code, updateErr.details);
  } else {
    console.log("[PackIdeas] Session updated OK, ideas saved to DB");
  }

  // Delete thinking message
  try {
    await ctx.deleteMessage(thinkingMsg.message_id);
  } catch {}

  // Show first idea — embed idea data in callback_data for resilience
  const text = formatIdeaMessage(ideas[0], 0, ideas.length, lang);
  const keyboard = getIdeaKeyboard(0, ideas.length, lang);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
});

// Callback: Generate sticker from idea
bot.action(/^idea_generate:(\d+)$/, async (ctx) => {
  console.log("=== idea_generate callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  console.log("[idea_generate] session:", session?.id, "state:", session?.state, "pack_ideas:", !!session?.pack_ideas, "pack_ideas type:", typeof session?.pack_ideas);

  if (!session?.pack_ideas) {
    console.log("[idea_generate] pack_ideas is null/undefined — session update likely failed");
    await ctx.reply(lang === "ru" ? "⚠️ Идеи не найдены. Нажми 💡 Идеи для пака ещё раз." : "⚠️ Ideas not found. Press 💡 Pack ideas again.");
    return;
  }

  const ideaIndex = parseInt(ctx.match[1], 10);
  const ideas: StickerIdea[] = session.pack_ideas;
  const idea = ideas[ideaIndex];

  if (!idea) {
    console.log("[PackIdeas] Invalid idea index:", ideaIndex, "total ideas:", ideas.length);
    return;
  }

  console.log("[idea_generate] Generating idea:", ideaIndex, idea.titleEn, "category:", idea.category);

  // Build prompt: use base emotion template + idea's prompt modification
  const emotionTemplate = await getPromptTemplate("emotion");
  let promptFinal: string;
  if (emotionTemplate) {
    promptFinal = buildPromptFromTemplate(emotionTemplate, idea.promptModification);
  } else {
    promptFinal = idea.promptModification;
  }

  // IMPORTANT: Tell Gemini to ignore any baked-in text from the source sticker
  // (previous generation might have text on a sign/speech bubble that bleeds through)
  promptFinal += "\nIMPORTANT: If the input image contains any text, signs, speech bubbles, or captions — REMOVE them completely. Do NOT copy or preserve any text from the input image. Only add text if explicitly requested below.";

  // Handle text overlay
  let textPrompt: string | null = null;
  let generationType: "style" | "emotion" | "motion" | "text" = "emotion";

  if (idea.hasText && idea.textSuggestion) {
    if (idea.textPlacement === "bottom_caption") {
      textPrompt = idea.textSuggestion;
      generationType = "text";
    } else {
      // Text in prompt (speech bubble / sign)
      const textInPrompt = idea.textPlacement === "speech_bubble"
        ? `with speech bubble saying "${idea.textSuggestion}"`
        : `holding a sign that reads "${idea.textSuggestion}"`;
      promptFinal += `. ${textInPrompt}`;
    }
  }

  // Mark idea as generated
  ideas[ideaIndex].generated = true;
  const generatedFromIdeas = [...(session.generated_from_ideas || []), `idea_${ideaIndex}`];

  const { error: ideaUpdateErr } = await supabase.from("sessions").update({
    pack_ideas: ideas,
    current_idea_index: ideaIndex + 1,
    generated_from_ideas: generatedFromIdeas,
  }).eq("id", session.id);
  if (ideaUpdateErr) {
    console.error("[idea_generate] Session update failed:", ideaUpdateErr.message);
  }

  // Update the idea message to show it's being generated
  try {
    const generatingText = lang === "ru"
      ? `💡 Идея ${ideaIndex + 1}/${ideas.length}\n\n${idea.emoji} <b>${idea.titleRu}</b>\n\n⏳ Генерация...`
      : `💡 Idea ${ideaIndex + 1}/${ideas.length}\n\n${idea.emoji} <b>${idea.titleEn}</b>\n\n⏳ Generating...`;
    await ctx.editMessageText(generatingText, { parse_mode: "HTML" });
  } catch {}

  // Start generation using existing pipeline
  await startGeneration(ctx, user, session, lang, {
    generationType,
    promptFinal,
    textPrompt,
    selectedStyleId: session.selected_style_id,
    selectedEmotion: idea.titleEn,
    emotionPrompt: idea.promptModification,
  });

  // Alert for analytics
  sendAlert({
    type: "idea_generated",
    message: "Sticker from pack idea",
    details: {
      user: `@${user.username || telegramId}`,
      ideaTitle: idea.titleEn,
      ideaCategory: idea.category,
      hasText: idea.hasText,
      ideaIndex,
      totalIdeas: ideas.length,
      generatedCount: generatedFromIdeas.length,
    },
  }).catch(console.error);
});

// Callback: Next idea
bot.action("idea_next", async (ctx) => {
  console.log("=== idea_next callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  console.log("[idea_next] session:", session?.id, "pack_ideas:", !!session?.pack_ideas, "current_idea_index:", session?.current_idea_index);

  if (!session?.pack_ideas) {
    console.log("[idea_next] No pack_ideas in session, aborting");
    return;
  }

  const ideas: StickerIdea[] = session.pack_ideas;
  const nextIndex = (session.current_idea_index || 0) + 1;
  console.log("[idea_next] nextIndex:", nextIndex, "total:", ideas.length);

  if (nextIndex >= ideas.length) {
    // All ideas shown
    const generated = ideas.filter((i: StickerIdea) => i.generated).length;
    const text = lang === "ru"
      ? `🎉 Все ${ideas.length} идей показаны!\nСгенерировано: ${generated} из ${ideas.length}`
      : `🎉 All ${ideas.length} ideas shown!\nGenerated: ${generated} of ${ideas.length}`;

    try {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: lang === "ru" ? "🔄 Новые идеи" : "🔄 More ideas", callback_data: "idea_more" }],
            [{ text: lang === "ru" ? "📷 Новое фото" : "📷 New photo", callback_data: "new_photo" }],
          ],
        },
      });
    } catch (err: any) {
      console.error("[idea_next] editMessage (all shown) failed:", err.message);
    }
    return;
  }

  const { error: idxErr } = await supabase.from("sessions").update({
    current_idea_index: nextIndex,
  }).eq("id", session.id);
  if (idxErr) console.error("[idea_next] index update failed:", idxErr.message);

  // Edit current message with next idea
  const text = formatIdeaMessage(ideas[nextIndex], nextIndex, ideas.length, lang);
  const keyboard = getIdeaKeyboard(nextIndex, ideas.length, lang);
  console.log("[idea_next] Editing message with idea", nextIndex);
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    console.log("[idea_next] Message edited OK");
  } catch (err: any) {
    console.error("[idea_next] editMessage failed:", err.message);
    // Fallback: send new message
    try {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
      console.log("[idea_next] Sent as new message instead");
    } catch (err2: any) {
      console.error("[idea_next] reply also failed:", err2.message);
    }
  }
});

// Callback: Done browsing ideas
bot.action("idea_done", async (ctx) => {
  console.log("=== idea_done callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";

  const text = lang === "ru"
    ? "🎉 Отлично! Ты можешь продолжить создавать стикеры или начать с нового фото."
    : "🎉 Great! You can keep creating stickers or start with a new photo.";

  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: lang === "ru" ? "📷 Новое фото" : "📷 New photo", callback_data: "new_photo" }],
          [{ text: lang === "ru" ? "💡 Ещё идеи" : "💡 More ideas", callback_data: "idea_more" }],
        ],
      },
    });
  } catch {}
});

// Callback: Generate more ideas
bot.action("idea_more", async (ctx) => {
  console.log("=== idea_more callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.id) return;

  // Need a sticker to analyze — use last_sticker_file_id
  const stickerFileId = session.last_sticker_file_id;
  if (!stickerFileId) {
    await ctx.reply(lang === "ru" ? "⚠️ Сначала сгенерируй стикер" : "⚠️ Generate a sticker first");
    return;
  }

  // Show thinking
  const thinkingText = lang === "ru" ? "💡 Придумываю новые идеи..." : "💡 Coming up with new ideas...";
  try {
    await ctx.editMessageText(thinkingText);
  } catch {}

  // Gather all previously generated ideas for dedup
  const existingStickers: string[] = [];
  const prevIdeas: StickerIdea[] = session.pack_ideas || [];
  for (const idea of prevIdeas) {
    existingStickers.push(idea.titleEn);
  }
  if (session.selected_style_id) {
    existingStickers.unshift(`Style: ${session.selected_style_id}`);
  }

  let ideas: StickerIdea[];
  try {
    ideas = await generatePackIdeas({
      stickerFileId,
      stylePresetId: session.selected_style_id,
      lang,
      existingStickers,
    });
    console.log("[idea_more] Generated", ideas.length, "new ideas");
  } catch (err: any) {
    console.error("[idea_more] generatePackIdeas failed:", err.message);
    ideas = getDefaultIdeas(lang);
  }

  const { error: updateErr } = await supabase.from("sessions").update({
    pack_ideas: ideas,
    current_idea_index: 0,
  }).eq("id", session.id);
  if (updateErr) console.error("[idea_more] session update failed:", updateErr.message);

  // Show first new idea
  const text = formatIdeaMessage(ideas[0], 0, ideas.length, lang);
  const keyboard = getIdeaKeyboard(0, ideas.length, lang);
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (editErr: any) {
    // "message is not modified" — happens when same default ideas are shown
    console.log("[idea_more] editMessage failed:", editErr.message?.slice(0, 100));
    try {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    } catch (replyErr: any) {
      console.error("[idea_more] reply also failed:", replyErr.message);
    }
  }
});

// Callback: Custom idea — ask user for a word/phrase
bot.action("custom_idea", async (ctx) => {
  console.log("=== custom_idea callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.id) return;

  // Set waiting flag
  const { error } = await supabase.from("sessions").update({
    waiting_custom_idea: true,
  }).eq("id", session.id);
  if (error) console.error("[custom_idea] session update failed:", error.message);

  const prompt = lang === "ru"
    ? "✏️ <b>Напиши слово или фразу — я придумаю идею!</b>\n\nНапример: <i>устал, злой, с кофе, танцует, ору, спасибо, утро понедельника</i>"
    : "✏️ <b>Type a word or phrase — I'll create an idea!</b>\n\nExamples: <i>tired, angry, with coffee, dancing, LOL, thank you, Monday morning</i>";

  try {
    await ctx.editMessageText(prompt, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: lang === "ru" ? "↩️ Назад к идеям" : "↩️ Back to ideas", callback_data: "idea_back" }],
        ],
      },
    });
  } catch {
    await ctx.reply(prompt, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: lang === "ru" ? "↩️ Назад к идеям" : "↩️ Back to ideas", callback_data: "idea_back" }],
        ],
      },
    });
  }
});

// Callback: Generate sticker from custom idea
bot.action("idea_generate_custom", async (ctx) => {
  console.log("=== idea_generate_custom callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);

  if (!session?.custom_idea) {
    await ctx.reply(lang === "ru" ? "⚠️ Идея не найдена. Попробуй ещё раз." : "⚠️ Idea not found. Try again.");
    return;
  }

  const idea: StickerIdea = session.custom_idea;
  console.log("[idea_generate_custom] Generating custom idea:", idea.titleEn);

  // Build prompt
  const emotionTemplate = await getPromptTemplate("emotion");
  let promptFinal: string;
  if (emotionTemplate) {
    promptFinal = buildPromptFromTemplate(emotionTemplate, idea.promptModification);
  } else {
    promptFinal = idea.promptModification;
  }

  // IMPORTANT: Tell Gemini to ignore any baked-in text from the source sticker
  promptFinal += "\nIMPORTANT: If the input image contains any text, signs, speech bubbles, or captions — REMOVE them completely. Do NOT copy or preserve any text from the input image. Only add text if explicitly requested below.";

  // Handle text overlay
  let textPrompt: string | null = null;
  let generationType: "style" | "emotion" | "motion" | "text" = "emotion";

  if (idea.hasText && idea.textSuggestion) {
    if (idea.textPlacement === "bottom_caption") {
      textPrompt = idea.textSuggestion;
      generationType = "text";
    } else {
      const textInPrompt = idea.textPlacement === "speech_bubble"
        ? `with speech bubble saying "${idea.textSuggestion}"`
        : `holding a sign that reads "${idea.textSuggestion}"`;
      promptFinal += `. ${textInPrompt}`;
    }
  }

  // Clear custom_idea flag
  await supabase.from("sessions").update({
    custom_idea: null,
    waiting_custom_idea: false,
  }).eq("id", session.id);

  // Show generating status
  try {
    const generatingText = lang === "ru"
      ? `✏️ <b>${idea.titleRu}</b>\n\n⏳ Генерация...`
      : `✏️ <b>${idea.titleEn}</b>\n\n⏳ Generating...`;
    await ctx.editMessageText(generatingText, { parse_mode: "HTML" });
  } catch {}

  // Start generation
  await startGeneration(ctx, user, session, lang, {
    generationType,
    promptFinal,
    textPrompt,
    selectedStyleId: session.selected_style_id,
    selectedEmotion: idea.titleEn,
    emotionPrompt: idea.promptModification,
  });

  sendAlert({
    type: "idea_generated",
    message: "Sticker from custom idea",
    details: {
      user: `@${user.username || telegramId}`,
      ideaTitle: idea.titleEn,
      ideaCategory: idea.category,
      source: "custom",
    },
  }).catch(console.error);
});

// Callback: Back to idea browsing
bot.action("idea_back", async (ctx) => {
  console.log("=== idea_back callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.id) return;

  // Clear custom idea flags
  await supabase.from("sessions").update({
    waiting_custom_idea: false,
    custom_idea: null,
  }).eq("id", session.id);

  const ideas: StickerIdea[] = session.pack_ideas || [];
  const currentIndex = session.current_idea_index || 0;

  if (ideas.length === 0) {
    try {
      await ctx.editMessageText(
        lang === "ru" ? "💡 Нажми «Идеи для пака» чтобы сгенерировать идеи." : "💡 Press «Pack ideas» to generate ideas.",
        { parse_mode: "HTML" }
      );
    } catch {}
    return;
  }

  const safeIndex = Math.min(currentIndex, ideas.length - 1);
  const text = formatIdeaMessage(ideas[safeIndex], safeIndex, ideas.length, lang);
  const keyboard = getIdeaKeyboard(safeIndex, ideas.length, lang);
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  }
});

// ============================================================
// End of Pack Ideas handlers
// ============================================================

// Callback: style_example - show first example
bot.action(/^style_example:(.+)$/, async (ctx) => {
  console.log("=== style_example callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const styleId = ctx.match[1];
  console.log("styleId:", styleId);

  // Get style name
  const presets = await getStylePresets();
  const preset = presets.find(p => p.id === styleId);
  const styleName = preset 
    ? (lang === "ru" ? preset.name_ru : preset.name_en)
    : styleId;

  // Get first example
  const example = await getStyleExample(styleId, 0);
  const totalExamples = await countStyleExamples(styleId);
  
  console.log("example found:", !!example, "total:", totalExamples);

  if (!example) {
    // No examples - show message
    const noExamplesText = await getText(lang, "style.no_examples");
    const backText = await getText(lang, "btn.back_to_styles");
    await ctx.editMessageText(noExamplesText, {
      reply_markup: {
        inline_keyboard: [[{ text: backText, callback_data: "back_to_styles" }]]
      }
    });
    return;
  }

  // Show first example sticker
  const titleText = await getText(lang, "style.example_title", { style: styleName });
  const moreText = await getText(lang, "btn.more");
  const backText = await getText(lang, "btn.back_to_styles");

  // Delete old message
  await ctx.deleteMessage().catch(() => {});

  // Send sticker
  const stickerMsg = await ctx.replyWithSticker(example.telegram_file_id);

  // Build buttons: [More] if there are more, always [Back]
  const buttons: any[][] = [];
  if (totalExamples > 1) {
    buttons.push([
      { text: moreText, callback_data: `style_example_more:${styleId}:1` },
      { text: backText, callback_data: "back_to_styles" }
    ]);
  } else {
    buttons.push([{ text: backText, callback_data: "back_to_styles" }]);
  }

  const captionMsg = await ctx.reply(titleText, {
    reply_markup: { inline_keyboard: buttons }
  });

  // Auto-delete after 30 seconds
  const chatId = ctx.chat?.id;
  if (chatId) {
    setTimeout(() => {
      ctx.telegram.deleteMessage(chatId, stickerMsg.message_id).catch(() => {});
      ctx.telegram.deleteMessage(chatId, captionMsg.message_id).catch(() => {});
    }, 30000);
  }
});

// Callback: style_example_more - show next example (offset)
bot.action(/^style_example_more:(.+):(\d+)$/, async (ctx) => {
  console.log("=== style_example_more callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const styleId = ctx.match[1];
  const offset = parseInt(ctx.match[2], 10);
  console.log("styleId:", styleId, "offset:", offset);

  // Max 3 examples
  if (offset >= 3) {
    const noMoreText = await getText(lang, "style.no_more_examples");
    const backText = await getText(lang, "btn.back_to_styles");
    await ctx.editMessageText(noMoreText, {
      reply_markup: {
        inline_keyboard: [[{ text: backText, callback_data: "back_to_styles" }]]
      }
    });
    return;
  }

  // Get style name
  const presets = await getStylePresets();
  const preset = presets.find(p => p.id === styleId);
  const styleName = preset 
    ? (lang === "ru" ? preset.name_ru : preset.name_en)
    : styleId;

  // Get next example
  const example = await getStyleExample(styleId, offset);
  const totalExamples = await countStyleExamples(styleId);
  
  console.log("example found:", !!example, "total:", totalExamples, "offset:", offset);

  if (!example) {
    // No more examples
    const noMoreText = await getText(lang, "style.no_more_examples");
    const backText = await getText(lang, "btn.back_to_styles");
    await ctx.editMessageText(noMoreText, {
      reply_markup: {
        inline_keyboard: [[{ text: backText, callback_data: "back_to_styles" }]]
      }
    });
    return;
  }

  // Delete old message
  await ctx.deleteMessage().catch(() => {});

  // Send sticker
  const stickerMsg = await ctx.replyWithSticker(example.telegram_file_id);

  // Build buttons
  const titleText = await getText(lang, "style.example_title", { style: styleName });
  const moreText = await getText(lang, "btn.more");
  const backText = await getText(lang, "btn.back_to_styles");

  const buttons: any[][] = [];
  const nextOffset = offset + 1;
  
  // Show "More" if there are more examples AND we haven't shown 3 yet
  if (totalExamples > nextOffset && nextOffset < 3) {
    buttons.push([
      { text: moreText, callback_data: `style_example_more:${styleId}:${nextOffset}` },
      { text: backText, callback_data: "back_to_styles" }
    ]);
  } else {
    buttons.push([{ text: backText, callback_data: "back_to_styles" }]);
  }

  const captionMsg = await ctx.reply(titleText, {
    reply_markup: { inline_keyboard: buttons }
  });

  // Auto-delete after 30 seconds
  const chatId = ctx.chat?.id;
  if (chatId) {
    setTimeout(() => {
      ctx.telegram.deleteMessage(chatId, stickerMsg.message_id).catch(() => {});
      ctx.telegram.deleteMessage(chatId, captionMsg.message_id).catch(() => {});
    }, 30000);
  }
});

// Callback: back_to_styles - return to style selection
bot.action("back_to_styles", async (ctx) => {
  console.log("=== back_to_styles callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";

  // Delete current message
  await ctx.deleteMessage().catch(() => {});

  await sendStyleKeyboardFlat(ctx, lang);
});

// Callback: onboarding emotion selection
bot.action(/^onboarding_emotion:(.+):(.+)$/, async (ctx) => {
  console.log("=== onboarding_emotion callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const stickerId = ctx.match[1];
  const emotionId = ctx.match[2];
  console.log("stickerId:", stickerId, "emotionId:", emotionId);

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";

  // Check if user is in onboarding step 1
  if (user.onboarding_step !== 1) {
    console.log("User not in onboarding step 1, skipping");
    return;
  }

  // Get sticker to find source photo and telegram_file_id
  const { data: sticker } = await supabase
    .from("stickers")
    .select("source_photo_file_id, user_id, telegram_file_id")
    .eq("id", stickerId)
    .maybeSingle();

  if (!sticker?.source_photo_file_id || sticker.user_id !== user.id) {
    console.log("Sticker not found or doesn't belong to user");
    return;
  }

  // Get or create session
  let session = await getActiveSession(user.id);
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_emotion", is_active: true, env: config.appEnv })
      .select()
      .single();
    session = newSession;
  }
  if (!session?.id) return;

  // Update session with photo, sticker file_id, and emotion
  await supabase
    .from("sessions")
    .update({
      state: "wait_emotion",
      is_active: true,
      current_photo_file_id: sticker.source_photo_file_id,
      last_sticker_file_id: sticker.telegram_file_id || null,
      selected_emotion: emotionId,
    })
    .eq("id", session.id);

  // Get emotion preset
  const { data: emotionPreset } = await supabase
    .from("emotion_presets")
    .select("prompt_hint")
    .eq("id", emotionId)
    .maybeSingle();

  const emotionHint = emotionPreset?.prompt_hint || emotionId;

  // Use prompt template from DB (same as regular emotion change)
  const emotionTemplate = await getPromptTemplate("emotion");
  const promptFinal = buildPromptFromTemplate(emotionTemplate, emotionHint);

  // Start generation
  await startGeneration(ctx, user, session, lang, {
    generationType: "emotion",
    promptFinal,
    emotionPrompt: emotionHint,
    selectedEmotion: emotionId,
  });

  // Delete onboarding message
  await ctx.deleteMessage().catch(() => {});
});

// Callback: skip onboarding
bot.action("onboarding_skip", async (ctx) => {
  console.log("=== onboarding_skip callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";

  // Skip onboarding
  await supabase.rpc("skip_onboarding", { p_user_id: user.id });

  const skipText = lang === "ru"
    ? "Хорошо! Когда захочешь добавить эмоцию — нажми кнопку под стикером 😊"
    : "Okay! When you want to add an emotion — click the button under the sticker 😊";

  await ctx.editMessageText(skipText);
});

// Callback: new_photo (after onboarding)
bot.action("new_photo", async (ctx) => {
  console.log("=== new_photo callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";

  // Create new session
  await supabase
    .from("sessions")
    .update({ is_active: false })
    .eq("user_id", user.id);

  await supabase
    .from("sessions")
    .insert({ user_id: user.id, state: "wait_photo", is_active: true, env: config.appEnv });

  const text = lang === "ru"
    ? "📷 Отправь фото — сделаем новый стикер!"
    : "📷 Send a photo — let's create a new sticker!";

  await ctx.editMessageText(text);
});

// Callback: cancel
bot.action("cancel", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  const lang = user?.lang || "en";

  const cancelText = await getText(lang, "btn.canceled");
  safeAnswerCbQuery(ctx, cancelText);
  await ctx.deleteMessage().catch(() => {});

  if (!user?.id) return;

  const session = await getActiveSession(user.id);
  if (session?.state === "wait_buy_credit") {
    const nextState = 
      session.pending_generation_type === "emotion" ? "wait_emotion" :
      session.pending_generation_type === "motion" ? "wait_motion" :
      session.pending_generation_type === "text" ? "wait_text_overlay" : "wait_style";
    await supabase
      .from("sessions")
      .update({ state: nextState, is_active: true })
      .eq("id", session.id);

    await ctx.reply(await getText(lang, "payment.canceled"));
  }
});

// Callback: pack_N_PRICE (e.g., pack_5_30)
bot.action(/^pack_(\d+)_(\d+)$/, async (ctx) => {
  const startTime = Date.now();
  console.log("=== PAYMENT: pack_select START ===");
  console.log("timestamp:", new Date().toISOString());
  
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  console.log("telegramId:", telegramId);
  if (!telegramId) {
    console.log("PAYMENT ERROR: no telegramId");
    return;
  }

  const user = await getUser(telegramId);
  console.log("getUser took:", Date.now() - startTime, "ms");
  if (!user?.id) {
    console.log("PAYMENT ERROR: user not found");
    return;
  }
  console.log("user_id:", user.id, "username:", user.username);

  const lang = user.lang || "en";
  const match = ctx.match;
  const credits = parseInt(match[1], 10);
  const price = parseInt(match[2], 10);
  console.log("pack selected: credits=", credits, "price=", price);

  // Validate pack
  const pack = CREDIT_PACKS.find((p) => p.credits === credits && p.price === price);
  if (!pack) {
    console.log("PAYMENT ERROR: invalid pack");
    await ctx.reply(await getText(lang, "payment.invalid_pack"));
    return;
  }
  // Block trialOnly pack for users who already purchased
  if ((pack as any).trialOnly && user.has_purchased) {
    console.log("PAYMENT ERROR: trialOnly pack blocked, user already purchased");
    await ctx.reply(lang === "ru" ? "Этот пакет доступен только для первой покупки." : "This pack is only available for your first purchase.");
    return;
  }
  console.log("pack validated:", pack.label_en);

  // Cancel old active transactions
  const cancelStart = Date.now();
  await supabase
    .from("transactions")
    .update({ state: "canceled", is_active: false })
    .eq("user_id", user.id)
    .eq("is_active", true);
  console.log("cancel old transactions took:", Date.now() - cancelStart, "ms");

  // Create new transaction
  const createStart = Date.now();
  const { data: transaction, error: createError } = await supabase
    .from("transactions")
    .insert({
      user_id: user.id,
      amount: credits,
      price: price,
      state: "created",
      is_active: true,
      env: config.appEnv,
    })
    .select("*")
    .single();
  console.log("create transaction took:", Date.now() - createStart, "ms");

  if (!transaction) {
    console.log("PAYMENT ERROR: transaction not created, error:", createError);
    await ctx.reply(await getText(lang, "payment.error_create"));
    return;
  }
  console.log("transaction created:", transaction.id);

  // Send invoice via Telegram Stars
  try {
    const invoicePayload = `[${transaction.id}]`;
    const title = await getText(lang, "payment.invoice_title", { credits });
    const description = await getText(lang, "payment.invoice_description", { credits });
    const label = await getText(lang, "payment.invoice_label");

    console.log("sending invoice: payload=", invoicePayload, "price=", price);
    const invoiceStart = Date.now();
    const response = await axios.post(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendInvoice`,
      {
        chat_id: telegramId,
        title,
        description,
        payload: invoicePayload,
        currency: "XTR",
        prices: [{ label, amount: price }],
      }
    );
    console.log("sendInvoice took:", Date.now() - invoiceStart, "ms");
    console.log("sendInvoice response ok:", response.data?.ok);
    console.log("=== PAYMENT: pack_select COMPLETE ===");
    console.log("total time:", Date.now() - startTime, "ms");
  } catch (err: any) {
    console.error("=== PAYMENT ERROR: sendInvoice failed ===");
    console.error("error:", err.response?.data || err.message);
    console.error("total time:", Date.now() - startTime, "ms");
    await ctx.reply(await getText(lang, "payment.error_invoice"));
  }
});

// Pre-checkout query handler
// OPTIMIZED: No DB queries - instant response to avoid Telegram timeout (10s limit)
// All validation happens in successful_payment
bot.on("pre_checkout_query", async (ctx) => {
  const startTime = Date.now();
  console.log("=== PAYMENT: pre_checkout_query START ===");
  console.log("timestamp:", new Date().toISOString());
  
  const query = ctx.preCheckoutQuery;
  console.log("query_id:", query.id);
  console.log("from:", ctx.from?.id, ctx.from?.username);
  console.log("payload:", query.invoice_payload);
  console.log("amount:", query.total_amount);
  console.log("currency:", query.currency);

  // Instant OK response - no DB queries to avoid timeout
  await ctx.answerPreCheckoutQuery(true);
  
  console.log("=== PAYMENT: pre_checkout_query OK ===");
  console.log("total time:", Date.now() - startTime, "ms");
});

// Successful payment handler
bot.on("successful_payment", async (ctx) => {
  const startTime = Date.now();
  console.log("=== PAYMENT: successful_payment START ===");
  console.log("timestamp:", new Date().toISOString());
  
  const payment = ctx.message.successful_payment;
  const invoicePayload = payment.invoice_payload;

  console.log("from:", ctx.from?.id, ctx.from?.username);
  console.log("charge_id:", payment.telegram_payment_charge_id);
  console.log("provider_charge_id:", payment.provider_payment_charge_id);
  console.log("amount:", payment.total_amount);
  console.log("currency:", payment.currency);
  console.log("payload:", invoicePayload);

  // Extract transaction ID
  const transactionId = invoicePayload.replace(/[\[\]]/g, "");
  console.log("transactionId:", transactionId);

  // Idempotency guard: if this charge was already processed, skip
  const checkStart = Date.now();
  const { data: existingCharge } = await supabase
    .from("transactions")
    .select("id, state")
    .eq("telegram_payment_charge_id", payment.telegram_payment_charge_id)
    .maybeSingle();
  console.log("idempotency check took:", Date.now() - checkStart, "ms");
  console.log("existingCharge:", existingCharge?.id, existingCharge?.state);

  if (existingCharge?.state === "done") {
    console.log(">>> SKIP: Payment already processed by charge id:", payment.telegram_payment_charge_id);
    console.log("=== PAYMENT: successful_payment SKIPPED (duplicate) ===");
    return;
  }

  // Atomic update: only one request can successfully change state from "created" to "done"
  // Note: We skip "processed" state now - pre_checkout_query no longer updates DB
  const updateStart = Date.now();
  const { data: updatedTransactions, error: updateError } = await supabase
    .from("transactions")
    .update({
      state: "done",
      is_active: false,
      telegram_payment_charge_id: payment.telegram_payment_charge_id,
      provider_payment_charge_id: payment.provider_payment_charge_id,
    })
    .eq("id", transactionId)
    .eq("state", "created")  // Changed from "processed" - now direct created -> done
    .is("telegram_payment_charge_id", null)
    .select("*");
  console.log("update transaction took:", Date.now() - updateStart, "ms");

  if (updateError) {
    console.log("PAYMENT ERROR: update to done failed:", updateError);
  }

  const transaction = updatedTransactions?.[0];
  console.log("update result - transaction found:", !!transaction, "id:", transaction?.id);

  if (!transaction) {
    // Already processed or not found - this prevents double crediting
    console.log(">>> SKIP: Transaction already processed or not found:", transactionId);
    console.log("=== PAYMENT: successful_payment SKIPPED (no transaction) ===");
    return;
  }

  // Get user and add credits
  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", transaction.user_id)
    .maybeSingle();

  // NOTE: Credits are added by Supabase trigger "on_transaction_done" -> "add_credits_on_transaction"
  // which fires AFTER UPDATE on transactions table when state becomes "done".
  // We do NOT add credits here to avoid double crediting.
  // The trigger is also used by other bots via n8n workflow.

  // First purchase bonus: +2 credits
  const isFirstPurchase = user && !user.has_purchased;
  const bonusCredits = isFirstPurchase ? 2 : 0;
  
  if (isFirstPurchase) {
    console.log("First purchase detected! Adding bonus:", bonusCredits);
    
    // Add bonus credits via transaction
    await supabase.from("transactions").insert({
      user_id: user.id,
      amount: bonusCredits,
      price: 0,
      state: "done",
      is_active: false,
      env: config.appEnv,
    });
    
    // Set has_purchased = true
    await supabase
      .from("users")
      .update({ has_purchased: true })
      .eq("id", user.id);
  }

  // Re-fetch user to get updated balance (after trigger executed + bonus)
  const { data: updatedUser } = await supabase
    .from("users")
    .select("*")
    .eq("id", transaction.user_id)
    .maybeSingle();

  const finalUser = updatedUser || user;
  console.log("user after trigger:", finalUser?.id, "credits:", finalUser?.credits, "added:", transaction.amount, "bonus:", bonusCredits);

  if (finalUser) {
    const lang = finalUser.lang || "en";
    const currentCredits = finalUser.credits || 0;

    // Show payment success message
    await ctx.reply(await getText(lang, "payment.success", {
      amount: transaction.amount,
      balance: currentCredits,
    }));

    // Show bonus message if first purchase
    if (isFirstPurchase) {
      await ctx.reply(await getText(lang, "paywall.bonus_applied"));
    }

    // Send payment notification (async, non-blocking)
    sendNotification({
      type: "new_payment",
      message: `👤 @${finalUser.username || finalUser.telegram_id}\n📦 Пакет: ${transaction.amount} кредитов\n⭐ Сумма: ${transaction.price} Stars${isFirstPurchase ? "\n🎁 Первая покупка! +2 бонус" : ""}`,
    }).catch(console.error);

    // Check if there's a pending session waiting for credits (paywall or normal)
    const session = await getActiveSession(finalUser.id);
    const isWaitingForCredits = session?.state === "wait_buy_credit" || session?.state === "wait_first_purchase";
    console.log("[payment] session:", session?.id, "state:", session?.state, "is_active:", session?.is_active, "prompt_final:", !!session?.prompt_final, "credits_spent:", session?.credits_spent, "isWaitingForCredits:", isWaitingForCredits);
    
    // === AI Assistant: paid after paywall — trigger generation with assistant params ===
    if (isWaitingForCredits && !session.prompt_final) {
      // Check if there's a completed/active assistant session with params
      const { data: aSessionForPayment } = await supabase
        .from("assistant_sessions")
        .select("*")
        .eq("session_id", session.id)
        .in("status", ["active", "completed"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (aSessionForPayment?.style) {
        const params = getAssistantParams(aSessionForPayment);
        const userText = `${params.style}, ${params.emotion}, ${params.pose}`;
        const promptResult = await generatePrompt(userText);
        const promptFinal = promptResult.ok && promptResult.prompt
          ? promptResult.prompt
          : buildAssistantPrompt(params);
        console.log("[payment] assistant generatePrompt ok:", promptResult.ok, "used fallback:", !(promptResult.ok && promptResult.prompt));

        // Save prompt and start generation
        await supabase
          .from("sessions")
          .update({ prompt_final: promptFinal, user_input: `[assistant] ${params.style}, ${params.emotion}, ${params.pose}` })
          .eq("id", session.id);

        // Keep assistant session active so user can continue dialog after generation
        // (closed on new dialog, manual switch, or timeout)

        // Now fall through to the normal auto-continue logic below
        session.prompt_final = promptFinal;
      }
    }

    if (isWaitingForCredits && session.prompt_final) {
      const creditsNeeded = session.credits_spent || 1;
      console.log("[payment] auto-continue: creditsNeeded:", creditsNeeded, "currentCredits:", currentCredits);

      if (currentCredits >= creditsNeeded) {
        const nextState =
          session.pending_generation_type === "emotion" ? "processing_emotion" :
          session.pending_generation_type === "motion" ? "processing_motion" :
          session.pending_generation_type === "text" ? "processing_text" : "processing";

        // Auto-continue generation: deduct credits atomically
        const { data: deducted } = await supabase
          .rpc("deduct_credits", { p_user_id: finalUser.id, p_amount: creditsNeeded });

        if (deducted) {
          await supabase
            .from("sessions")
            .update({ 
              state: nextState, 
              is_active: true,
              generation_type: session.pending_generation_type || null,
            })
            .eq("id", session.id);

          await enqueueJob(session.id, finalUser.id);

          // Alert: generation after payment
          const isAssistantPayment = session.user_input?.startsWith("[assistant]");
          sendAlert({
            type: "generation_started",
            message: "Generation after payment",
            details: {
              mode: isAssistantPayment ? "🤖 assistant" : "✋ manual",
              user: `@${finalUser.username || finalUser.telegram_id}`,
              style: session.selected_style_id || "-",
              emotion: session.selected_emotion || session.emotion_prompt || "-",
              prompt: (session.prompt_final || "").slice(0, 200),
            },
          }).catch(console.error);

          await sendProgressStart(ctx, session.id, lang);
        } else {
          console.error("Auto-continue failed: not enough credits after payment");
        }
      } else {
        await ctx.reply(await getText(lang, "payment.need_more", {
          needed: creditsNeeded - currentCredits,
        }));
      }
    } else if (session && !isWaitingForCredits) {
      // Session exists but not in paywall state — try to auto-continue anyway
      console.log("[payment] session not in paywall state:", session.state, "— checking fallbacks");

      // Fallback 1: session has prompt_final (startGeneration paywall update may have failed)
      if (session.prompt_final && session.current_photo_file_id) {
        const creditsNeeded = session.credits_spent || 1;
        console.log("[payment] fallback: session has prompt_final, auto-continuing. creditsNeeded:", creditsNeeded);

        if (currentCredits >= creditsNeeded) {
          const nextState =
            session.pending_generation_type === "emotion" ? "processing_emotion" :
            session.pending_generation_type === "motion" ? "processing_motion" :
            session.pending_generation_type === "text" ? "processing_text" : "processing";

          const { data: deductedFb } = await supabase
            .rpc("deduct_credits", { p_user_id: finalUser.id, p_amount: creditsNeeded });

          if (deductedFb) {
            await supabase
              .from("sessions")
              .update({ 
                state: nextState, 
                is_active: true,
                generation_type: session.pending_generation_type || null,
              })
              .eq("id", session.id);

            await enqueueJob(session.id, finalUser.id);
            await sendProgressStart(ctx, session.id, lang);
            console.log("[payment] fallback: generation started, state:", nextState);
          } else {
            console.error("[payment] fallback: deduct failed");
          }
        }
      }

      // Fallback 2: assistant session with collected params (no prompt_final yet)
      if (!session.prompt_final) {
        const aSessionFallback = await getActiveAssistantSession(finalUser.id);
        if (aSessionFallback && allParamsCollected(aSessionFallback) && session.current_photo_file_id) {
          console.log("[payment] assistant fallback: params collected, auto-generating");
          const params = getAssistantParams(aSessionFallback);
          const userText = `${params.style}, ${params.emotion}, ${params.pose}`;
          const promptResult = await generatePrompt(userText);
          const promptFinal = promptResult.ok && promptResult.prompt
            ? promptResult.prompt
            : buildAssistantPrompt(params);
          console.log("[payment] fallback generatePrompt ok:", promptResult.ok);

          await supabase
            .from("sessions")
            .update({
              state: "processing",
              is_active: true,
              prompt_final: promptFinal,
              user_input: `[assistant] ${params.style}, ${params.emotion}, ${params.pose}`,
              selected_style_id: "assistant",
              credits_spent: 1,
            })
            .eq("id", session.id);

          const { data: deductedFb } = await supabase
            .rpc("deduct_credits", { p_user_id: finalUser.id, p_amount: 1 });

          if (deductedFb) {
            await enqueueJob(session.id, finalUser.id);
            await sendProgressStart(ctx, session.id, lang);
            console.log("[payment] assistant fallback: generation started");
          } else {
            console.error("[payment] assistant fallback: deduct failed");
          }
        }
      }
    }
    console.log("=== PAYMENT: successful_payment COMPLETE ===");
    console.log("total time:", Date.now() - startTime, "ms");
  }
});

// Webhook endpoint
app.post(config.webhookPath, async (req, res) => {
  if (config.telegramWebhookSecret) {
    const secret = req.header("x-telegram-bot-api-secret-token");
    if (secret !== config.telegramWebhookSecret) {
      return res.status(401).send({ ok: false });
    }
  }

  await bot.handleUpdate(req.body);
  res.status(200).send({ ok: true });
});

app.get("/health", (_, res) => res.status(200).send("OK"));

const server = app.listen(config.port, () => {
  console.log(`API running on :${config.port}`);
});

// ============================================
// ABANDONED CART PROCESSING
// ============================================

const ABANDONED_CART_DELAY_MS = 15 * 60 * 1000; // 15 minutes
const ABANDONED_CART_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Map original price to discounted price (10% off)
const DISCOUNT_MAP: Record<number, number> = {
  150: 135, // Лайт: 150 -> 135
  300: 270, // Бро: 300 -> 270
};

async function processAbandonedCarts() {
  try {
    const cutoffTime = new Date(Date.now() - ABANDONED_CART_DELAY_MS).toISOString();
    
    // Find transactions older than 30 minutes without reminder
    const { data: abandoned, error } = await supabase
      .from("transactions")
      .select("*, users(*)")
      .eq("state", "created")
      .eq("reminder_sent", false)
      .gt("price", 0)
      .lt("created_at", cutoffTime)
      .limit(10); // Process in batches

    if (error) {
      console.error("processAbandonedCarts query error:", error);
      return;
    }

    if (!abandoned?.length) {
      return;
    }

    console.log(`Processing ${abandoned.length} abandoned carts`);

    for (const tx of abandoned) {
      const user = tx.users;
      if (!user?.telegram_id) continue;

      const lang = user.lang || "en";
      const discountedPrice = DISCOUNT_MAP[tx.price];
      
      // Skip if no discount available for this price
      if (!discountedPrice) {
        console.log(`No discount for price ${tx.price}, skipping`);
        // Mark as sent to avoid re-processing
        await supabase
          .from("transactions")
          .update({ reminder_sent: true, reminder_sent_at: new Date().toISOString() })
          .eq("id", tx.id);
        continue;
      }

      // Determine pack name
      const packName = tx.amount === 10 
        ? (lang === "ru" ? "Лайт" : "Light")
        : tx.amount === 30 
          ? (lang === "ru" ? "Бро" : "Bro")
          : `${tx.amount}`;

      // Build message
      const message = lang === "ru"
        ? `🛒 Ты выбрал пакет "${packName}", но не завершил оплату.\n\nСпециально для тебя — скидка 10%:\n${tx.amount} стикеров за ${discountedPrice}⭐ вместо ${tx.price}⭐\n\nПредложение действует 24 часа ⏰`
        : `🛒 You selected the "${packName}" pack but didn't complete the payment.\n\nSpecial offer for you — 10% off:\n${tx.amount} stickers for ${discountedPrice}⭐ instead of ${tx.price}⭐\n\nOffer valid for 24 hours ⏰`;

      const buttonText = lang === "ru"
        ? `Оплатить со скидкой ${discountedPrice}⭐`
        : `Pay with discount ${discountedPrice}⭐`;

      try {
        await bot.telegram.sendMessage(
          user.telegram_id,
          message,
          Markup.inlineKeyboard([
            [Markup.button.callback(buttonText, `pack_${tx.amount}_${discountedPrice}`)]
          ])
        );

        console.log(`Sent abandoned cart reminder to ${user.username || user.telegram_id}`);

        // Mark reminder as sent
        await supabase
          .from("transactions")
          .update({ reminder_sent: true, reminder_sent_at: new Date().toISOString() })
          .eq("id", tx.id);

      } catch (err: any) {
        console.error(`Failed to send reminder to ${user.telegram_id}:`, err.message);
        // Still mark as sent to avoid retry spam
        await supabase
          .from("transactions")
          .update({ reminder_sent: true, reminder_sent_at: new Date().toISOString() })
          .eq("id", tx.id);
      }
    }
  } catch (err) {
    console.error("processAbandonedCarts error:", err);
  }
}

const ABANDONED_CART_ALERT_DELAY_MS = 15 * 60 * 1000; // 15 minutes

async function processAbandonedCartAlerts() {
  try {
    const cutoffTime = new Date(Date.now() - ABANDONED_CART_ALERT_DELAY_MS).toISOString();
    
    // Find transactions older than 15 minutes without alert
    const { data: abandoned, error } = await supabase
      .from("transactions")
      .select("*, users(*)")
      .eq("state", "created")
      .eq("alert_sent", false)
      .gt("price", 0)
      .lt("created_at", cutoffTime)
      .limit(10); // Process in batches

    if (error) {
      console.error("processAbandonedCartAlerts query error:", error);
      return;
    }

    if (!abandoned?.length) {
      return;
    }

    console.log(`Processing ${abandoned.length} abandoned cart alerts`);

    for (const tx of abandoned) {
      const user = tx.users;
      if (!user?.telegram_id) continue;

      const minutesSince = Math.round((Date.now() - new Date(tx.created_at).getTime()) / 60000);
      
      // Determine pack name
      const packName = tx.amount === 10 ? "Лайт" : tx.amount === 30 ? "Бро" : `${tx.amount} кредитов`;

      const message = `👤 @${user.username || 'no_username'} (${user.telegram_id})
📦 Пакет: ${packName} (${tx.amount} кредитов)
💰 Сумма: ${tx.price}⭐
⏱ Прошло: ${minutesSince} мин`;

      try {
        await sendNotification({
          type: "abandoned_cart",
          message,
          buttons: [[{
            text: "Написать пользователю",
            url: `https://t.me/${config.supportBotUsername}?start=reply_${user.telegram_id}`
          }]]
        });

        console.log(`Sent abandoned cart alert for ${user.username || user.telegram_id}`);

        // Mark alert as sent
        await supabase
          .from("transactions")
          .update({ alert_sent: true, alert_sent_at: new Date().toISOString() })
          .eq("id", tx.id);

      } catch (err: any) {
        console.error(`Failed to send alert for ${user.telegram_id}:`, err.message);
        // Still mark as sent to avoid retry spam
        await supabase
          .from("transactions")
          .update({ alert_sent: true, alert_sent_at: new Date().toISOString() })
          .eq("id", tx.id);
      }
    }
  } catch (err) {
    console.error("processAbandonedCartAlerts error:", err);
  }
}

// Start abandoned cart processing interval
// ============================================
// EXPIRED ASSISTANT SESSIONS
// ============================================

const ASSISTANT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function processExpiredAssistantSessions() {
  try {
    // Expire old assistant_sessions rows
    const expiredCount = await expireOldAssistantSessions(ASSISTANT_SESSION_TTL_MS);
    if (expiredCount > 0) {
      console.log(`Expired ${expiredCount} assistant sessions (30 min timeout)`);
    }

    // Also expire the corresponding sessions rows
    const cutoff = new Date(Date.now() - ASSISTANT_SESSION_TTL_MS).toISOString();
    await supabase
      .from("sessions")
      .update({ state: "expired", is_active: false })
      .in("state", ["assistant_wait_photo", "assistant_chat"])
      .eq("is_active", true)
      .lt("updated_at", cutoff);
  } catch (err) {
    console.error("processExpiredAssistantSessions error:", err);
  }
}

function startAbandonedCartProcessor() {
  console.log("Starting abandoned cart processor (every 5 minutes)");
  
  // Run immediately on start
  processAbandonedCartAlerts();  // 15 min alert to team
  processAbandonedCarts();       // 30 min discount to user
  processExpiredAssistantSessions(); // 30 min timeout for assistant sessions
  
  // Then run every 5 minutes
  setInterval(() => {
    processAbandonedCartAlerts();
    processAbandonedCarts();
    processExpiredAssistantSessions();
  }, ABANDONED_CART_CHECK_INTERVAL_MS);
}

async function startBot() {
  if (config.publicBaseUrl) {
    const baseUrl = config.publicBaseUrl.replace(/\/$/, "");
    const webhookUrl = `${baseUrl}${config.webhookPath}`;

    await bot.telegram.setWebhook(
      webhookUrl,
      config.telegramWebhookSecret ? { secret_token: config.telegramWebhookSecret } : undefined
    );

    console.log(`Webhook set: ${webhookUrl}`);
  } else {
    console.log("Deleting webhook...");
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log("Webhook deleted. Launching long polling (drop pending updates)...");
    await bot.launch({ dropPendingUpdates: true });
    console.log("Bot launched with long polling");
  }
}

startBot().then(() => {
  // Start background processors after bot is ready
  startAbandonedCartProcessor();
}).catch(async (err) => {
  console.error("Failed to start bot:", err);
  await sendAlert({
    type: "api_error",
    message: err?.message || String(err),
    stack: err?.stack,
  });
  process.exit(1);
});

// Handle uncaught exceptions
process.on("uncaughtException", async (err) => {
  console.error("Uncaught exception:", err);
  await sendAlert({
    type: "api_error",
    message: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

process.on("unhandledRejection", async (reason: any) => {
  console.error("Unhandled rejection:", reason);
  await sendAlert({
    type: "api_error",
    message: reason?.message || String(reason),
    stack: reason?.stack,
  });
});

// Graceful shutdown for webhook mode (bot.stop() is for polling only)
function gracefulShutdown(signal: string) {
  console.log(`${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
  setTimeout(() => {
    console.log("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

