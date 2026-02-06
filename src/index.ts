import express from "express";
import { Telegraf, Markup } from "telegraf";
import axios from "axios";
import { config } from "./config";
import { supabase } from "./lib/supabase";
import { getText } from "./lib/texts";
import { sendAlert, sendNotification } from "./lib/alerts";

const bot = new Telegraf(config.telegramBotToken);
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
    .not("telegram_file_id", "is", null);
  
  return count || 0;
}

// ============================================
// Styles v2: Groups + Substyles (isolated)
// ============================================

// Feature flag helper - enabled for all users
function useStylesV2(telegramId: number): boolean {
  return true;
}

// Interfaces for v2
interface StyleGroup {
  id: string;
  emoji: string;
  name_ru: string;
  name_en: string;
  sort_order: number;
  is_active: boolean;
  show_in_onboarding: boolean;
}

interface StylePresetV2 {
  id: string;
  group_id: string;
  emoji: string;
  name_ru: string;
  name_en: string;
  prompt_hint: string;
  sort_order: number;
  is_active: boolean;
  show_in_onboarding: boolean;
}

// Cache for style_groups
let styleGroupsCache: { data: StyleGroup[]; timestamp: number } | null = null;
const STYLE_GROUPS_CACHE_TTL = 5 * 60 * 1000;

// Cache for style_presets_v2
let stylePresetsV2Cache: { data: StylePresetV2[]; timestamp: number } | null = null;
const STYLE_PRESETS_V2_CACHE_TTL = 5 * 60 * 1000;

async function getStyleGroups(): Promise<StyleGroup[]> {
  const now = Date.now();
  if (styleGroupsCache && now - styleGroupsCache.timestamp < STYLE_GROUPS_CACHE_TTL) {
    return styleGroupsCache.data;
  }

  const { data } = await supabase
    .from("style_groups")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");

  if (data) {
    styleGroupsCache = { data, timestamp: now };
  }
  return data || [];
}

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

async function buildStyleGroupsButtons(lang: string, isOnboarding: boolean = false): Promise<any[][]> {
  const allGroups = await getStyleGroups();
  // Filter groups for onboarding users (hide groups with show_in_onboarding = false)
  const groups = isOnboarding 
    ? allGroups.filter(g => g.show_in_onboarding !== false)
    : allGroups;
  const customText = await getText(lang, "btn.custom_style");
  
  // 2 columns for groups
  const buttons: any[][] = [];
  for (let i = 0; i < groups.length; i += 2) {
    const row: any[] = [];
    row.push({ text: `${groups[i].emoji} ${lang === "ru" ? groups[i].name_ru : groups[i].name_en}`, callback_data: `style_group:${groups[i].id}` });
    if (groups[i + 1]) {
      row.push({ text: `${groups[i + 1].emoji} ${lang === "ru" ? groups[i + 1].name_ru : groups[i + 1].name_en}`, callback_data: `style_group:${groups[i + 1].id}` });
    }
    buttons.push(row);
  }
  
  // Custom style button
  buttons.push([{ text: customText, callback_data: "style_custom_v2" }]);
  
  return buttons;
}

async function sendStyleGroupsKeyboard(ctx: any, lang: string, messageId?: number, isOnboarding: boolean = false) {
  const buttons = await buildStyleGroupsButtons(lang, isOnboarding);
  const text = await getText(lang, "style.select_group");

  if (messageId) {
    await ctx.telegram.editMessageText(
      ctx.chat?.id,
      messageId,
      undefined,
      text,
      { reply_markup: { inline_keyboard: buttons } }
    ).catch((err: any) => console.error("sendStyleGroupsKeyboard error:", err?.message));
  } else {
    await ctx.reply(text, Markup.inlineKeyboard(buttons));
  }
}

async function sendSubstylesKeyboard(ctx: any, lang: string, groupId: string, messageId?: number, isOnboarding: boolean = false) {
  const groups = await getStyleGroups();
  const group = groups.find(g => g.id === groupId);
  if (!group) return;

  const allSubstyles = await getStylePresetsV2(groupId);
  // Filter substyles for onboarding users
  const substyles = isOnboarding
    ? allSubstyles.filter(s => s.show_in_onboarding !== false)
    : allSubstyles;
  const backText = await getText(lang, "btn.back_to_groups");
  const exampleText = await getText(lang, "btn.example");
  
  // Substyle button + Example button in one row
  const buttons: any[][] = substyles.map(s => [
    Markup.button.callback(
      `${s.emoji} ${lang === "ru" ? s.name_ru : s.name_en}`,
      `style_v2:${s.id}`
    ),
    Markup.button.callback(exampleText, `style_example_v2:${s.id}:${groupId}`)
  ]);
  
  // Back button
  buttons.push([Markup.button.callback(backText, `style_groups_back:${groupId}`)]);

  const groupName = lang === "ru" ? group.name_ru : group.name_en;
  const text = await getText(lang, "style.select_substyle", { emoji: group.emoji, name: groupName });
  
  if (messageId) {
    await ctx.telegram.editMessageText(
      ctx.chat?.id,
      messageId,
      undefined,
      text,
      { reply_markup: { inline_keyboard: buttons } }
    ).catch((err: any) => console.error("editMessageText error:", err?.message));
  } else {
    await ctx.reply(text, Markup.inlineKeyboard(buttons));
  }
}

async function sendStyleKeyboard(ctx: any, lang: string, messageId?: number) {
  const presets = await getStylePresets();
  const exampleText = await getText(lang, "btn.example");

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
  for (const preset of presets) {
    // Skip "custom" preset - no example for it
    if (preset.id === "custom") {
      buttons.push([
        Markup.button.callback(
          `${preset.emoji} ${lang === "ru" ? preset.name_ru : preset.name_en}`,
          `style_${preset.id}`
        )
      ]);
      continue;
    }
    
    // Style button + Example button in one row
    buttons.push([
      Markup.button.callback(
        `${preset.emoji} ${lang === "ru" ? preset.name_ru : preset.name_en}`,
        `style_${preset.id}`
      ),
      Markup.button.callback(exampleText, `style_example:${preset.id}`)
    ]);
  }

  const text = await getText(lang, "photo.ask_style");
  
  if (messageId) {
    await ctx.telegram.editMessageText(
      ctx.chat?.id,
      messageId,
      undefined,
      text,
      { reply_markup: { inline_keyboard: buttons } }
    ).catch(() => {});
  } else {
    await ctx.reply(text, Markup.inlineKeyboard(buttons));
  }
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
  }
) {
  const creditsNeeded = 1;

  console.log("=== startGeneration ===");
  console.log("user.id:", user?.id);
  console.log("user.credits:", user?.credits, "type:", typeof user?.credits);
  console.log("user.onboarding_step:", user.onboarding_step);
  console.log("generationType:", options.generationType);
  console.log("creditsNeeded:", creditsNeeded);

  // Check if user has enough credits
  if (user.credits < creditsNeeded) {
    sendAlert({
      type: "not_enough_credits",
      message: "Not enough credits!",
      details: {
        user: `@${user.username || user.telegram_id}`,
        type: options.generationType,
        style: options.selectedStyleId || "-",
        credits: user.credits,
        needed: creditsNeeded,
      },
    }).catch(console.error);

    await supabase
      .from("sessions")
      .update({
        state: "wait_buy_credit",
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

    await ctx.reply(await getText(lang, "photo.not_enough_credits", {
      needed: creditsNeeded,
      balance: user.credits,
    }));
    await sendBuyCreditsMenu(ctx, user);
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

  await sendProgressStart(ctx, session.id, lang);
}

// Credit packages: { credits, price_in_stars, label_ru, label_en, price_rub, adminOnly?, hidden? }
const CREDIT_PACKS = [
  { credits: 1, price: 1, price_rub: 1, label_ru: "🔧 Тест", label_en: "🔧 Test", adminOnly: true },
  { credits: 10, price: 150, price_rub: 150, label_ru: "🧪 Лайт", label_en: "🧪 Light" },
  { credits: 30, price: 300, price_rub: 300, label_ru: "⭐ Бро", label_en: "⭐ Bro" },
  // Hidden discount packs for abandoned carts (not shown in UI, used via direct callback)
  { credits: 10, price: 135, price_rub: 135, label_ru: "🧪 Лайт -10%", label_en: "🧪 Light -10%", hidden: true },
  { credits: 30, price: 270, price_rub: 270, label_ru: "⭐ Бро -10%", label_en: "⭐ Bро -10%", hidden: true },
];

// Helper: get user by telegram_id
async function getUser(telegramId: number) {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  return data;
}

// Helper: get active session
async function getActiveSession(userId: string) {
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .maybeSingle();
  if (error) {
    console.log("getActiveSession error:", error);
  }
  if (data) return data;

  // Fallback: some DB setups flip is_active to false on update
  console.log("getActiveSession fallback for user:", userId);
  const { data: fallback } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .neq("state", "canceled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return fallback;
}

// Helper: send buy credits menu
async function sendBuyCreditsMenu(ctx: any, user: any, messageText?: string) {
  const lang = user.lang || "en";
  const text = messageText || await getText(lang, "payment.balance", { credits: user.credits });
  const isAdmin = config.adminIds.includes(user.telegram_id);

  // Filter packs: hide adminOnly (unless admin) and hidden packs
  const availablePacks = CREDIT_PACKS.filter(p => !p.hidden && (!p.adminOnly || isAdmin));

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

// /start command
bot.start(async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  let user = await getUser(telegramId);
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru")
      ? "ru"
      : "en";

    console.log("New user - language_code:", ctx.from?.language_code, "-> lang:", lang);

    const { data: created, error: insertError } = await supabase
      .from("users")
      .insert({ 
        telegram_id: telegramId, 
        lang, 
        credits: 0,
        username: ctx.from?.username || null,
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

    // Give 2 free credits for onboarding (trigger will add to user.credits)
    if (user?.id) {
      await supabase.from("transactions").insert({
        user_id: user.id,
        amount: 2,
        price: 0,
        state: "done",
        is_active: false,
      });

      // Send notification (async, non-blocking)
      sendNotification({
        type: "new_user",
        message: `@${ctx.from?.username || "no\\_username"} (${telegramId})\n🌐 Язык: ${lang}`,
      }).catch(console.error);
    }
  } else {
    // Update username if changed (user may change their Telegram username)
    const currentUsername = ctx.from?.username || null;
    if (user.username !== currentUsername) {
      await supabase
        .from("users")
        .update({ username: currentUsername })
        .eq("id", user.id);
      user.username = currentUsername;
    }
  }

  if (user?.id) {
    // Cancel all active sessions
    await supabase
      .from("sessions")
      .update({ state: "canceled", is_active: false })
      .eq("user_id", user.id)
      .eq("is_active", true);

    // Create new session
    await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_photo", is_active: true })
      .select();
  }

  const lang = user?.lang || "en";
  const greeting = isNewUser
    ? await getText(lang, "start.greeting_new")
    : await getText(lang, "start.greeting_return", { credits: user?.credits || 0 });

  await ctx.reply(greeting);
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

  const photos = Array.isArray(session.photos) ? session.photos : [];
  photos.push(photo.file_id);

  const { error } = await supabase
    .from("sessions")
    .update({ photos, state: "wait_style", is_active: true, current_photo_file_id: photo.file_id })
    .eq("id", session.id);
  if (error) {
    console.error("Failed to update session to wait_style:", error);
  }

  // Show v2 groups for all users
  if (useStylesV2(telegramId)) {
    const isOnboarding = (user.onboarding_step ?? 99) < 2;
    console.log("[Styles v2] Showing groups for user:", telegramId, "isOnboarding:", isOnboarding);
    const groups = await getStyleGroups();
    console.log("[Styles v2] Groups count:", groups.length);
    await sendStyleGroupsKeyboard(ctx, lang, undefined, isOnboarding);
  } else {
    await sendStyleKeyboard(ctx, lang);
  }
});

// Text handler (style description)
bot.on("text", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  if (ctx.message.text?.startsWith("/")) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.id) {
    await ctx.reply(await getText(lang, "start.need_start"));
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

// Callback: style selection
bot.action(/^style_([^:]+)$/, async (ctx) => {
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
// Styles v2 handlers (isolated, only for enabled users)
// ============================================

// Callback: style group selected (v2)
bot.action(/^style_group:(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    
    // Double-check feature flag
    if (!useStylesV2(telegramId)) {
      console.log("style_group callback for non-v2 user, ignoring");
      return;
    }

    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const isOnboarding = (user.onboarding_step ?? 99) < 2;
    const session = await getActiveSession(user.id);
    if (!session?.id || session.state !== "wait_style") return;

    const groupId = ctx.match[1];
    console.log("[Styles v2] Group selected:", groupId, "isOnboarding:", isOnboarding);

    // Update session with selected group for analytics
    await supabase
      .from("sessions")
      .update({ selected_style_group: groupId })
      .eq("id", session.id);

    // Show substyles (filtered for onboarding)
    await sendSubstylesKeyboard(ctx, lang, groupId, ctx.callbackQuery?.message?.message_id, isOnboarding);
  } catch (err) {
    console.error("Style group callback error:", err);
  }
});

// Callback: substyle selected (v2)
bot.action(/^style_v2:(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    // Double-check feature flag
    if (!useStylesV2(telegramId)) {
      console.log("style_v2 callback for non-v2 user, ignoring");
      return;
    }

    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const session = await getActiveSession(user.id);
    if (!session?.id || session.state !== "wait_style") return;

    const styleId = ctx.match[1];
    console.log("[Styles v2] Substyle selected:", styleId);

    const preset = await getStylePresetV2ById(styleId);
    if (!preset) {
      console.log("[Styles v2] Preset not found:", styleId);
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

    if (!useStylesV2(telegramId)) return;

    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const isOnboarding = (user.onboarding_step ?? 99) < 2;
    
    // Just navigate back - no state check needed
    const messageId = ctx.callbackQuery?.message?.message_id;
    await ctx.telegram.editMessageText(
      ctx.chat?.id,
      messageId,
      undefined,
      await getText(lang, "style.select_group"),
      { reply_markup: { inline_keyboard: await buildStyleGroupsButtons(lang, isOnboarding) } }
    ).catch((err: any) => console.error("Back to groups error:", err?.message));
  } catch (err) {
    console.error("Style groups back callback error:", err);
  }
});

// Callback: example for v2 substyle
bot.action(/^style_example_v2:(.+):(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    if (!useStylesV2(telegramId)) return;

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

// Callback: back to substyles (from example)
bot.action(/^back_to_substyles_v2:(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    if (!useStylesV2(telegramId)) return;

    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const isOnboarding = (user.onboarding_step ?? 99) < 2;
    const groupId = ctx.match[1];

    // Delete current message and show substyles (filtered for onboarding)
    await ctx.deleteMessage().catch(() => {});
    await sendSubstylesKeyboard(ctx, lang, groupId, undefined, isOnboarding);
  } catch (err) {
    console.error("Back to substyles v2 error:", err);
  }
});

// Callback: more examples v2
bot.action(/^style_example_v2_more:(.+):(.+):(\d+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    if (!useStylesV2(telegramId)) return;

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

    if (!useStylesV2(telegramId)) return;

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

  try {
    if (!user.sticker_set_name) {
      // Try to create new sticker set
      try {
        await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/createNewStickerSet`, {
          user_id: telegramId,
          name: stickerSetName,
          title: packTitle,
          stickers: [
            {
              sticker: sticker.telegram_file_id,
              format: "static",
              emoji_list: ["🔥"],
            },
          ],
        });
      } catch (createErr: any) {
        // If name is occupied, try with timestamp
        if (createErr.response?.data?.description?.includes("already occupied")) {
          console.log("Sticker set name occupied, trying with timestamp...");
          stickerSetName = `p2s_${telegramId}_${Date.now()}_by_${botUsername}`.toLowerCase();
          await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/createNewStickerSet`, {
            user_id: telegramId,
            name: stickerSetName,
            title: packTitle,
            stickers: [
              {
                sticker: sticker.telegram_file_id,
                format: "static",
                emoji_list: ["🔥"],
              },
            ],
          });
        } else {
          throw createErr;
        }
      }

      await supabase.from("users").update({ sticker_set_name: stickerSetName }).eq("id", user.id);
    } else {
      await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/addStickerToSet`, {
        user_id: telegramId,
        name: stickerSetName,
        sticker: {
          sticker: sticker.telegram_file_id,
          format: "static",
          emoji_list: ["🔥"],
        },
      });
    }

    await ctx.reply(await getText(lang, "sticker.added_to_pack", {
      link: `https://t.me/addstickers/${stickerSetName}`,
    }));
  } catch (err: any) {
    console.error("Add to pack error:", err.response?.data || err.message);
    await sendAlert({
      type: "api_error",
      message: `Add to pack failed: ${err.response?.data?.description || err.message}`,
      details: { 
        userId: user.id,
        telegramId,
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

  try {
    if (!user.sticker_set_name) {
      // Try to create new sticker set
      try {
        await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/createNewStickerSet`, {
          user_id: telegramId,
          name: stickerSetName,
          title: packTitle,
          stickers: [
            {
              sticker: session.last_sticker_file_id,
              format: "static",
              emoji_list: ["🔥"],
            },
          ],
        });
      } catch (createErr: any) {
        // If name is occupied, try with timestamp
        if (createErr.response?.data?.description?.includes("already occupied")) {
          console.log("Sticker set name occupied, trying with timestamp...");
          stickerSetName = `p2s_${telegramId}_${Date.now()}_by_${botUsername}`.toLowerCase();
          await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/createNewStickerSet`, {
            user_id: telegramId,
            name: stickerSetName,
            title: packTitle,
            stickers: [
              {
                sticker: session.last_sticker_file_id,
                format: "static",
                emoji_list: ["🔥"],
              },
            ],
          });
        } else {
          throw createErr;
        }
      }

      await supabase.from("users").update({ sticker_set_name: stickerSetName }).eq("id", user.id);
    } else {
      await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/addStickerToSet`, {
        user_id: telegramId,
        name: stickerSetName,
        sticker: {
          sticker: session.last_sticker_file_id,
          format: "static",
          emoji_list: ["🔥"],
        },
      });
    }

    await ctx.reply(await getText(lang, "sticker.added_to_pack", {
      link: `https://t.me/addstickers/${stickerSetName}`,
    }));
  } catch (err: any) {
    console.error("Add to pack error:", err.response?.data || err.message);
    await sendAlert({
      type: "api_error",
      message: `Add to pack failed: ${err.response?.data?.description || err.message}`,
      details: { 
        userId: user.id,
        telegramId,
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
      .insert({ user_id: user.id, state: "wait_style", is_active: true })
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

  // Show v2 groups for enabled users
  if (useStylesV2(telegramId)) {
    const isOnboarding = (user.onboarding_step ?? 99) < 2;
    await sendStyleGroupsKeyboard(ctx, lang, undefined, isOnboarding);
  } else {
    await sendStyleKeyboard(ctx, lang);
  }
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

  // Show v2 groups for enabled users
  if (useStylesV2(telegramId)) {
    const isOnboarding = (user.onboarding_step ?? 99) < 2;
    await sendStyleGroupsKeyboard(ctx, lang, undefined, isOnboarding);
  } else {
    await sendStyleKeyboard(ctx, lang);
  }
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
      .insert({ user_id: user.id, state: "wait_emotion", is_active: true })
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
      .insert({ user_id: user.id, state: "wait_motion", is_active: true })
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
      .insert({ user_id: user.id, state: "wait_text", is_active: true })
      .select()
      .single();
    session = newSession;
  }

  if (!session?.id) return;

  await supabase
    .from("sessions")
    .update({
      state: "wait_text",
      is_active: true,
      last_sticker_file_id: sticker.telegram_file_id,
      current_photo_file_id: sticker.source_photo_file_id,
      pending_generation_type: null,
    })
    .eq("id", session.id);

  await ctx.reply(await getText(lang, "text.prompt"));
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

  // Show v2 groups for enabled users
  if (useStylesV2(telegramId)) {
    const isOnboarding = (user.onboarding_step ?? 99) < 2;
    await sendStyleGroupsKeyboard(ctx, lang, undefined, isOnboarding);
  } else {
    await sendStyleKeyboard(ctx, lang);
  }
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

  // Get sticker to find source photo
  const { data: sticker } = await supabase
    .from("stickers")
    .select("source_photo_file_id, user_id")
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
      .insert({ user_id: user.id, state: "wait_emotion", is_active: true })
      .select()
      .single();
    session = newSession;
  }
  if (!session?.id) return;

  // Update session with photo and emotion
  await supabase
    .from("sessions")
    .update({
      state: "wait_emotion",
      is_active: true,
      current_photo_file_id: sticker.source_photo_file_id,
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

  // Start generation
  await startGeneration(ctx, user, session, lang, {
    generationType: "emotion",
    promptFinal: `Add ${emotionHint} expression to this sticker character`,
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
    .insert({ user_id: user.id, state: "wait_photo", is_active: true });

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
    const nextState = session.pending_generation_type === "emotion" ? "wait_emotion" : "wait_style";
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

  // Re-fetch user to get updated balance (after trigger executed)
  const { data: updatedUser } = await supabase
    .from("users")
    .select("*")
    .eq("id", transaction.user_id)
    .maybeSingle();

  const finalUser = updatedUser || user;
  console.log("user after trigger:", finalUser?.id, "credits:", finalUser?.credits, "added:", transaction.amount);

  if (finalUser) {
    const lang = finalUser.lang || "en";
    const currentCredits = finalUser.credits || 0;

    await ctx.reply(await getText(lang, "payment.success", {
      amount: transaction.amount,
      balance: currentCredits,
    }));

    // Send payment notification (async, non-blocking)
    sendNotification({
      type: "new_payment",
      message: `👤 @${finalUser.username || finalUser.telegram_id}\n📦 Пакет: ${transaction.amount} кредитов\n⭐ Сумма: ${transaction.price} Stars`,
    }).catch(console.error);

    // Check if there's a pending session waiting for credits
    const session = await getActiveSession(finalUser.id);
    if (session?.state === "wait_buy_credit" && session.prompt_final) {
      const creditsNeeded = session.credits_spent || 1;

      if (currentCredits >= creditsNeeded) {
        const nextState =
          session.pending_generation_type === "emotion" ? "processing_emotion" : "processing";

        // Auto-continue generation: deduct credits atomically
        const { data: deducted } = await supabase
          .rpc("deduct_credits", { p_user_id: finalUser.id, p_amount: creditsNeeded });

        if (deducted) {
          await supabase
            .from("sessions")
            .update({ state: nextState, is_active: true })
            .eq("id", session.id);

          await enqueueJob(session.id, finalUser.id);

          await sendProgressStart(ctx, session.id, lang);
        } else {
          console.error("Auto-continue failed: not enough credits after payment");
        }
      } else {
        await ctx.reply(await getText(lang, "payment.need_more", {
          needed: creditsNeeded - currentCredits,
        }));
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

app.listen(config.port, () => {
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
function startAbandonedCartProcessor() {
  console.log("Starting abandoned cart processor (every 5 minutes)");
  
  // Run immediately on start
  processAbandonedCartAlerts();  // 15 min alert to team
  processAbandonedCarts();       // 30 min discount to user
  
  // Then run every 5 minutes
  setInterval(() => {
    processAbandonedCartAlerts();
    processAbandonedCarts();
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
    await bot.telegram.deleteWebhook();
    await bot.launch();
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

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

