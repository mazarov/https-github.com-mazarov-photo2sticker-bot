import express from "express";
import { Telegraf, Markup, Input } from "telegraf";
import axios from "axios";
import sharp from "sharp";
import FormData from "form-data";
import { randomUUID } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { execSync } from "child_process";
import { config, getGeminiGenerateContentUrl, getGeminiRouteInfo } from "./config";
import { supabase } from "./lib/supabase";
import { getText } from "./lib/texts";
import { sendAlert, sendNotification } from "./lib/alerts";
import { getFilePath, downloadFile, sendSticker, getStickerSet } from "./lib/telegram";
import { addWhiteBorder, addTextToSticker, assembleGridTo1024 } from "./lib/image-utils";
import { getAppConfig } from "./lib/app-config";
import { sendYandexConversion, getMetrikaTargetForPack } from "./lib/yandex-metrika";
import {
  appendSubjectLock,
  buildSubjectLockBlock,
  detectSubjectProfileFromImageBuffer,
  isSubjectLockEnabled,
  isSubjectModePackFilterEnabled,
  isSubjectProfileEnabled,
  normalizeSubjectMode,
  normalizeSubjectGender,
  normalizeSubjectSourceKind,
  resolveGenerationSource,
  type SubjectProfile,
  type SubjectSourceKind,
} from "./lib/subject-profile";
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
import {
  runPackGenerationPipeline,
  reworkOneIteration,
  specToMinimalPlan,
  parseSubjectTypeFromThemeRequest,
  subjectTypeFromSession,
  type PackSpecRow,
  type BossPlan,
  type CriticOutput,
} from "./lib/pack-multiagent";

const bot = new Telegraf(config.telegramBotToken, {
  // Multi-agent pack generation can include several LLM passes (critic + rework).
  // Keep handler alive long enough so admin flow does not crash mid-iteration.
  handlerTimeout: 600_000, // 10 min
});

const traceContext = new AsyncLocalStorage<{ traceId: string }>();

function resolveRuntimeGitSha(): string {
  const envSha = String(process.env.APP_GIT_SHA || process.env.GIT_SHA || "").trim();
  if (envSha) return envSha;
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

bot.use(async (ctx, next) => {
  const state = (ctx.state as Record<string, unknown> | undefined) || undefined;
  const existingTraceId = typeof state?.trace_id === "string" ? (state.trace_id as string) : null;
  const traceId = existingTraceId || randomUUID().split("-")[0];
  if (state && !existingTraceId) state.trace_id = traceId;
  return await traceContext.run({ traceId }, async () => {
    console.log("[trace.start]", {
      trace_id: traceId,
      updateType: ctx.updateType || null,
      telegramId: ctx.from?.id || null,
    });
    return await next();
  });
});

const geminiRoute = getGeminiRouteInfo();
console.log("[GeminiRoute][API]", geminiRoute);

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

// Admin flow: «Сделать примером» — выбор набора из pack_content_sets, затем ссылка на стикерпак → sticker_pack_example/{id}/example.webp (4x4 grid, не pack/content — тот для лендинга)
const adminPackContentExampleFlow = new Map<number, { step: 2; contentSetId: string }>();

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

// Cache for pack content sets (active rows)
let packContentSetsCache: { data: any[]; timestamp: number } | null = null;
const PACK_CONTENT_SETS_CACHE_TTL = 30 * 1000; // 30 seconds

let packSegmentsCache: { data: { id: string; sort_order: number }[]; timestamp: number } | null = null;
const PACK_SEGMENTS_CACHE_TTL = 60 * 1000; // 60 seconds

function safeAnswerCbQuery(ctx: any, payload?: any) {
  if (typeof ctx?.answerCbQuery !== "function") return;
  ctx.answerCbQuery(payload).catch((err: any) => {
    console.warn("answerCbQuery failed:", err?.description || err?.message || err);
  });
}

function getOrCreateTraceId(ctx: any): string {
  const fromStore = traceContext.getStore()?.traceId;
  const state = (ctx?.state as Record<string, unknown> | undefined) || undefined;
  const existingTraceId = typeof state?.trace_id === "string" ? (state.trace_id as string) : null;
  const traceId = existingTraceId || fromStore || randomUUID().split("-")[0];
  if (state && !existingTraceId) state.trace_id = traceId;
  return traceId;
}

function resolveTelegramChatId(ctx: any): number | undefined {
  return (
    (ctx?.chat?.id as number | undefined)
    || ((ctx?.callbackQuery as any)?.message?.chat?.id as number | undefined)
    || ((ctx?.message as any)?.chat?.id as number | undefined)
  );
}

async function getPackSegments(): Promise<{ id: string; sort_order: number }[]> {
  const now = Date.now();
  if (packSegmentsCache && now - packSegmentsCache.timestamp < PACK_SEGMENTS_CACHE_TTL) {
    return packSegmentsCache.data;
  }
  const { data, error } = await supabase
    .from("pack_segments")
    .select("id, sort_order")
    .order("sort_order", { ascending: true });
  if (error) {
    console.warn("[pack_segments] load error:", error.message);
    return packSegmentsCache?.data || [];
  }
  const rows = Array.isArray(data) ? data : [];
  packSegmentsCache = { data: rows, timestamp: now };
  return rows;
}

async function getActivePackContentSets(): Promise<any[]> {
  const now = Date.now();
  if (packContentSetsCache && now - packContentSetsCache.timestamp < PACK_CONTENT_SETS_CACHE_TTL) {
    return packContentSetsCache.data;
  }

  const { data, error } = await supabase
    .from(config.packContentSetsTable)
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.warn("[pack_content_sets] load error:", error.message);
    return packContentSetsCache?.data || [];
  }

  let rows = Array.isArray(data) ? data : [];
  const segments = await getPackSegments();
  const segmentOrderById = new Map<string, number>(segments.map((s) => [s.id, s.sort_order]));
  rows = rows.slice().sort((a, b) => {
    const orderA = segmentOrderById.get(a?.segment_id) ?? 999;
    const orderB = segmentOrderById.get(b?.segment_id) ?? 999;
    if (orderA !== orderB) return orderA - orderB;
    return (a?.sort_order ?? 0) - (b?.sort_order ?? 0);
  });
  packContentSetsCache = { data: rows, timestamp: now };
  return rows;
}

function clearPackContentSetsCache(): void {
  packContentSetsCache = null;
}

/** Ensure pack id is unique in pack_content_sets_test; append _v2, _v3 if needed. */
async function ensureUniquePackId(spec: PackSpecRow): Promise<PackSpecRow> {
  const normalized = normalizeSpecSegmentId(spec);
  let candidate = normalized.id;
  for (let i = 0; i < 20; i++) {
    const { data } = await supabase
      .from(config.packContentSetsTable)
      .select("id")
      .eq("id", candidate)
      .maybeSingle();
    if (!data) return { ...normalized, id: candidate };
    candidate = `${normalized.id}_v${i + 2}`;
  }
  return { ...normalized, id: candidate };
}

/** Translate sticker captions from English to Russian (for pack_content_sets.labels). Returns same-length array or empty on error. */
async function translateLabelsEnToRu(labelsEn: string[]): Promise<string[]> {
  if (!Array.isArray(labelsEn) || labelsEn.length === 0) return [];
  try {
    const response = await axios.post(
      getGeminiGenerateContentUrl("gemini-2.0-flash"),
      {
        contents: [{ role: "user", parts: [{ text: `Translate these ${labelsEn.length} short sticker captions from English to Russian. Keep the same tone and approximate length. Return ONLY a JSON array of ${labelsEn.length} strings, no other text.\n\n${JSON.stringify(labelsEn)}` }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
      },
      { headers: { "x-goog-api-key": config.geminiApiKey }, timeout: 15000 }
    );
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return [];
    const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : (parsed?.labels ?? []);
    return arr.slice(0, labelsEn.length).map((s: unknown) => String(s ?? "").trim()).filter(Boolean);
  } catch (e) {
    console.warn("[pack_admin] translateLabelsEnToRu failed:", (e as Error)?.message);
    return [];
  }
}

/** Ensure spec has Russian labels for pack_content_sets; if missing or same as EN, translate from labels_en. */
async function ensureSpecLabelsRu(spec: PackSpecRow): Promise<PackSpecRow> {
  const en = spec.labels_en ?? [];
  const ru = spec.labels ?? [];
  if (en.length === 0) return spec;
  const ruMissingOrShort = !Array.isArray(ru) || ru.length < en.length;
  const ruSameAsEn =
    ru.length === en.length &&
    en.every((e, i) => (ru[i] ?? "").trim().toLowerCase() === (e ?? "").trim().toLowerCase());
  const ruHasBlanks = ru.length > 0 && !ru.every((s) => String(s ?? "").trim());
  if (!ruMissingOrShort && !ruSameAsEn && !ruHasBlanks) return spec;
  const translated = await translateLabelsEnToRu(en);
  if (translated.length === 0) return spec;
  return { ...spec, labels: translated };
}

/** Valid segment_id values (FK pack_segments). Boss/LLM may return other strings — normalize to avoid insert error. */
const VALID_PACK_SEGMENT_IDS = new Set([
  "reactions",
  "sarcasm",
  "home",
  "events",
  "affection_support",
  "after_dark",
  "boundaries",
]);

function normalizeSpecSegmentId(spec: PackSpecRow): PackSpecRow {
  const sid = String(spec?.segment_id || "").trim().toLowerCase();
  const valid = sid && VALID_PACK_SEGMENT_IDS.has(sid) ? sid : "home";
  if (valid !== (spec.segment_id || "")) {
    console.log("[pack_admin] segment_id normalized:", spec.segment_id, "->", valid);
  }
  return { ...spec, segment_id: valid };
}

function getPackContentSetsForTemplate(contentSets: any[], templateId: string): any[] {
  if (!Array.isArray(contentSets)) return [];
  return contentSets.filter((set) => String(set?.pack_template_id || "") === String(templateId));
}

/** Effective pack template for carousel: holiday overrides default. */
function getEffectivePackTemplateId(session: { pack_holiday_id?: string | null; pack_template_id?: string | null }): string {
  return String(session.pack_holiday_id || session.pack_template_id || "couple_v1");
}

/** Admin row removed from carousel: no "Сгенерировать пак" / "Список наборов" in pack carousel. */
function getPackCarouselAdminRow(_telegramId: number, _sessionId?: string): { text: string; callback_data: string }[] {
  return [];
}

/** Escape Telegram Markdown special chars so DB content (name_ru/en, carousel_description_*) does not break parse_mode: "Markdown". */
function escapeMarkdownForTelegram(text: string): string {
  return String(text ?? "").replace(/\\/g, "\\\\").replace(/[_*`\[\]]/g, "\\$&");
}

/** Форматирует причины и предложения Critic для показа админу (при отклонении). */
function formatCriticBlock(reasons: string[] | undefined, suggestions: string[] | undefined, isRu: boolean): string {
  const parts: string[] = [];
  if (reasons?.length) {
    parts.push((isRu ? "Причины отклонения:\n" : "Rejection reasons:\n") + reasons.map((r) => "• " + r).join("\n"));
  }
  if (suggestions?.length) {
    parts.push((isRu ? "Предложения:\n" : "Suggestions:\n") + suggestions.map((s) => "• " + s).join("\n"));
  }
  const out = parts.length ? "\n\n" + parts.join("\n\n") : "";
  return out.length > 3500 ? out.slice(0, 3497) + "…" : out;
}

/** Форматирует подписи и сцены пака для показа админу на языке пользователя (isRu → RU, иначе EN). Сцены: в UI на языке пользователя; в БД сохраняются только scene_descriptions (EN). Лимит ~2500 символов. */
function formatPackSpecPreview(
  spec: { labels?: string[]; labels_en?: string[]; scene_descriptions?: string[]; scene_descriptions_ru?: string[] },
  isRu: boolean,
  maxLen: number = 2400
): string {
  const lines: string[] = [];
  const labels = Array.isArray(spec.labels) ? spec.labels : [];
  const labelsEn = Array.isArray(spec.labels_en) ? spec.labels_en : [];
  const scenesEn = Array.isArray(spec.scene_descriptions) ? spec.scene_descriptions : [];
  const scenesRu = Array.isArray(spec.scene_descriptions_ru) ? spec.scene_descriptions_ru : [];
  const captions = isRu ? labels : labelsEn;
  const scenes = isRu && scenesRu.length === scenesEn.length ? scenesRu : scenesEn;
  if (captions.length) {
    lines.push(isRu ? "Подписи:" : "Labels:");
    captions.forEach((l, i) => lines.push(`${i + 1}. ${l}`));
  }
  if (scenes.length) {
    if (lines.length) lines.push("");
    lines.push(isRu ? "Сцены:" : "Scenes:");
    scenes.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  const out = lines.length ? "\n\n" + lines.join("\n") : "";
  if (out.length > maxLen) return out.slice(0, maxLen - 1) + "…";
  return out;
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
  render_mode?: "stylize" | "photoreal" | string | null;
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

/** Pack carousel: holiday theme for packs (e.g. march_8). Shown only if id exists and is_active. */
async function getPackHolidayTheme(): Promise<HolidayTheme | null> {
  const { data, error } = await supabase
    .from("holiday_themes")
    .select("*")
    .eq("id", "march_8")
    .eq("is_active", true)
    .maybeSingle();
  if (error) console.error("[getPackHolidayTheme] error:", error.message);
  console.log("[getPackHolidayTheme] result:", data ? { id: data.id, is_active: data.is_active } : "null", "error:", error?.message ?? "none");
  return data;
}

async function sendStyleKeyboardFlat(
  ctx: any,
  lang: string,
  messageId?: number,
  options?: {
    extraButtons?: any[][];
    headerText?: string;
    selectedStyleId?: string | null;
  }
) {
  const allPresets = await getStylePresetsV2();

  // 2 styles per row
  const buttons: any[][] = [];
  for (let i = 0; i < allPresets.length; i += 2) {
    const row: any[] = [];
    for (let j = i; j < Math.min(i + 2, allPresets.length); j++) {
      const isSelected = options?.selectedStyleId && options.selectedStyleId === allPresets[j].id;
      row.push({
        text: `${isSelected ? "✅ " : ""}${allPresets[j].emoji} ${lang === "ru" ? allPresets[j].name_ru : allPresets[j].name_en}`,
        callback_data: `style_preview:${allPresets[j].id}`,
      });
    }
    buttons.push(row);
  }

  if (options?.extraButtons?.length) {
    buttons.push(...options.extraButtons);
  }

  const text = options?.headerText || await getText(lang, "photo.ask_style");
  const chatId = resolveTelegramChatId(ctx);

  if (messageId && chatId) {
    try {
      await ctx.telegram.editMessageText(
        chatId,
        messageId,
        undefined,
        text,
        { reply_markup: { inline_keyboard: buttons } }
      );
      return;
    } catch (err: any) {
      const msg = String(err?.message || "");
      console.error("sendStyleKeyboardFlat error:", msg);
      // Sticker messages cannot be edited to text, but we can still replace inline keyboard in-place.
      try {
        await ctx.telegram.editMessageReplyMarkup(
          chatId,
          messageId,
          undefined,
          { inline_keyboard: buttons }
        );
        return;
      } catch (markupErr: any) {
        console.warn("sendStyleKeyboardFlat reply_markup fallback error:", markupErr?.message || markupErr);
      }
      // Last fallback for stale/non-editable messages: send a fresh style list.
      if (msg.includes("message can't be edited") || msg.includes("message to edit not found")) {
        await ctx.reply(text, Markup.inlineKeyboard(buttons)).catch(() => {});
        return;
      }
    }
  }
  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}

/** Action menu after photo: 4 actions (photo->sticker, replace face, change style, make pack). */
async function sendActionMenu(
  ctx: any,
  lang: string,
  sessionId: string,
  sessionRev: number
) {
  const sessionRef = formatCallbackSessionRef(sessionId, sessionRev);
  const photoStickerCb = appendSessionRefIfFits("action_photo_sticker", sessionRef);
  const replaceFaceCb = appendSessionRefIfFits("action_replace_face", sessionRef);
  const makeStickerCb = appendSessionRefIfFits("action_make_sticker", sessionRef);
  const makePackCb = appendSessionRefIfFits("action_make_pack", sessionRef);

  const text = await getText(lang, "action.choose");
  const buttons = [
    [{ text: await getText(lang, "action.photo_sticker"), callback_data: photoStickerCb }],
    [{ text: await getText(lang, "action.make_sticker"), callback_data: makeStickerCb }],
    [{ text: await getText(lang, "action.replace_face"), callback_data: replaceFaceCb }],
    [{ text: await getText(lang, "action.make_pack"), callback_data: makePackCb }],
  ];
  await ctx.reply(text, Markup.inlineKeyboard(buttons));
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

/** Папка в Storage для примеров наборов (карусель бота). Отдельно от pack/content/ (лендинг). */
const PACK_EXAMPLE_STORAGE_PREFIX = "sticker_pack_example/";

/** Имя файла примера набора: одна сетка 1024×1024 из стикеров пака. */
const PACK_EXAMPLE_FILENAME = "example.webp";
const PACK_EXAMPLE_GRID_COLS = 4;
const PACK_EXAMPLE_GRID_ROWS = 4;
const PACK_EXAMPLE_GRID_STICKERS = PACK_EXAMPLE_GRID_COLS * PACK_EXAMPLE_GRID_ROWS;

/** Путь в бакете: sticker_pack_example/{contentSetId}/example.webp (сетка из стикеров). Совпадает с публичным URL Storage. */
function getPackContentSetExampleStoragePath(contentSetId: string): string {
  return `${PACK_EXAMPLE_STORAGE_PREFIX}${contentSetId}/${PACK_EXAMPLE_FILENAME}`;
}

/** Public URL для примера набора. Используется в карусели паков в боте. Для отображения в Telegram URL должен быть доступен с интернета — при внутреннем supabaseUrl задайте SUPABASE_PUBLIC_STORAGE_URL. */
function getPackContentSetExamplePublicUrl(contentSetId: string): string {
  const bucket = config.supabaseStorageBucketExamples || "stickers-examples";
  const path = getPackContentSetExampleStoragePath(contentSetId);
  const base = (config.supabasePublicStorageUrl || config.supabaseUrl || "").replace(/\/$/, "");
  return `${base}/storage/v1/object/public/${bucket}/${path}`;
}

/** Возвращает URL примера набора только если файл в Storage существует; иначе null (в карусели показываем только текст). */
async function getPackContentSetExampleUrlIfExists(contentSetId: string): Promise<string | null> {
  const url = getPackContentSetExamplePublicUrl(contentSetId);
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.log("[pack_example] HEAD not ok", { contentSetId, status: res.status, url });
      return null;
    }
    console.log("[pack_example] HEAD ok", { contentSetId, url });
    return url;
  } catch (e) {
    console.log("[pack_example] HEAD failed", { contentSetId, err: (e as Error)?.message, url });
    return null;
  }
}

/** Скачивает картинку примера по URL и возвращает буфер; при ошибке или не-image — null. Нужно для sendPhoto буфером, т.к. Telegram по URL может получить «wrong type of the web page content». */
async function fetchPackExampleAsBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) {
      console.log("[pack_example] GET not image", { contentType: ct.slice(0, 50), url });
      return null;
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    console.log("[pack_example] GET failed", { err: (e as Error)?.message, url });
    return null;
  }
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
  const telegramId = ctx.from?.id;
  let sessionRef: string | null = null;
  if (telegramId) {
    const user = await getUser(telegramId);
    if (user?.id) {
      const session = await getActiveSession(user.id);
      if (session?.id && session.state?.startsWith("assistant_")) {
        sessionRef = formatCallbackSessionRef(session.id, session.session_rev);
      }
    }
  }

  // 3 styles per row (unified layout)
  const buttons: any[][] = [];
  for (let i = 0; i < allPresets.length; i += 3) {
    const row: any[] = [];
    for (let j = i; j < Math.min(i + 3, allPresets.length); j++) {
      const isSelected = selectedStyleId && selectedStyleId === allPresets[j].id;
      row.push(Markup.button.callback(
        `${isSelected ? "✅ " : ""}${allPresets[j].emoji} ${isRu ? allPresets[j].name_ru : allPresets[j].name_en}`,
        appendSessionRefIfFits(`assistant_style_preview:${allPresets[j].id}`, sessionRef)
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

const EMOTION_EXAMPLES_STORAGE_PREFIX = "emotion-examples/";

/** First emotion preset (by sort_order) that has an example file in Storage (emotion-examples/{id}.webp). */
async function getFirstEmotionPresetWithExample(presets: EmotionPreset[]): Promise<EmotionPreset | null> {
  if (!presets.length) return null;
  const bucket = config.supabaseStorageBucketExamples;
  const { data: files } = await supabase.storage.from(bucket).list(EMOTION_EXAMPLES_STORAGE_PREFIX.replace(/\/$/, "")).catch(() => ({ data: null }));
  const names = new Set((files || []).map((f: { name?: string }) => f.name).filter(Boolean));
  for (const p of presets) {
    if (names.has(`${p.id}.webp`)) return p;
  }
  return null;
}

async function sendEmotionKeyboard(
  ctx: any,
  lang: string,
  options?: {
    sessionId?: string | null;
    sessionRev?: number | null;
    messageId?: number;
    backCallbackData?: string | null;
  }
) {
  const presets = await getEmotionPresets();
  const sessionRef = formatCallbackSessionRef(options?.sessionId, options?.sessionRev);

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < presets.length; i += 2) {
    const row: ReturnType<typeof Markup.button.callback>[] = [];
    const emotionCbLeft = appendSessionRefIfFits(`emotion_${presets[i].id}`, sessionRef);
    row.push(
      Markup.button.callback(
        `${presets[i].emoji} ${lang === "ru" ? presets[i].name_ru : presets[i].name_en}`,
        emotionCbLeft
      )
    );
    if (presets[i + 1]) {
      const emotionCbRight = appendSessionRefIfFits(`emotion_${presets[i + 1].id}`, sessionRef);
      row.push(
        Markup.button.callback(
          `${presets[i + 1].emoji} ${lang === "ru" ? presets[i + 1].name_ru : presets[i + 1].name_en}`,
          emotionCbRight
        )
      );
    }
    buttons.push(row);
  }

  if (options?.backCallbackData) {
    buttons.push([
      Markup.button.callback(lang === "ru" ? "↩️ Назад" : "↩️ Back", options.backCallbackData),
    ]);
  }

  const caption = await getText(lang, "emotion.choose");
  const replyMarkup = Markup.inlineKeyboard(buttons);
  const chatId = resolveTelegramChatId(ctx);

  if (options?.messageId && chatId) {
    try {
      await ctx.telegram.editMessageText(
        chatId,
        options.messageId,
        undefined,
        caption,
        { reply_markup: replyMarkup.reply_markup }
      );
      return;
    } catch (err: any) {
      console.warn("[sendEmotionKeyboard] edit failed, fallback to reply:", err?.message || err);
      // Sticker messages cannot be edited to text, but we can still remove old inline buttons.
      try {
        await ctx.telegram.editMessageReplyMarkup(
          chatId,
          options.messageId,
          undefined,
          { inline_keyboard: [] }
        );
      } catch {}
    }
  }

  const firstWithExample = await getFirstEmotionPresetWithExample(presets);
  if (firstWithExample) {
    const { data: urlData } = supabase.storage
      .from(config.supabaseStorageBucketExamples)
      .getPublicUrl(`${EMOTION_EXAMPLES_STORAGE_PREFIX}${firstWithExample.id}.webp`);
    const photoUrl = urlData?.publicUrl;
    if (photoUrl) {
      await ctx.replyWithPhoto(photoUrl, { caption, reply_markup: replyMarkup.reply_markup });
      return;
    }
  }

  await ctx.reply(caption, replyMarkup);
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

async function sendMotionKeyboard(
  ctx: any,
  lang: string,
  options?: {
    sessionId?: string | null;
    sessionRev?: number | null;
    messageId?: number;
    backCallbackData?: string | null;
  }
) {
  const presets = await getMotionPresets();
  const sessionRef = formatCallbackSessionRef(options?.sessionId, options?.sessionRev);

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < presets.length; i += 2) {
    const row: ReturnType<typeof Markup.button.callback>[] = [];
    const motionCbLeft = appendSessionRefIfFits(`motion_${presets[i].id}`, sessionRef);
    row.push(
      Markup.button.callback(
        `${presets[i].emoji} ${lang === "ru" ? presets[i].name_ru : presets[i].name_en}`,
        motionCbLeft
      )
    );
    if (presets[i + 1]) {
      const motionCbRight = appendSessionRefIfFits(`motion_${presets[i + 1].id}`, sessionRef);
      row.push(
        Markup.button.callback(
          `${presets[i + 1].emoji} ${lang === "ru" ? presets[i + 1].name_ru : presets[i + 1].name_en}`,
          motionCbRight
        )
      );
    }
    buttons.push(row);
  }

  if (options?.backCallbackData) {
    buttons.push([
      Markup.button.callback(lang === "ru" ? "↩️ Назад" : "↩️ Back", options.backCallbackData),
    ]);
  }

  const text = await getText(lang, "motion.choose");
  const keyboard = Markup.inlineKeyboard(buttons);
  const chatId = resolveTelegramChatId(ctx);
  if (options?.messageId && chatId) {
    try {
      await ctx.telegram.editMessageText(
        chatId,
        options.messageId,
        undefined,
        text,
        { reply_markup: keyboard.reply_markup }
      );
      return;
    } catch (err: any) {
      console.warn("[sendMotionKeyboard] edit failed, fallback to reply:", err?.message || err);
      // Sticker messages cannot be edited to text, but we can still remove old inline buttons.
      try {
        await ctx.telegram.editMessageReplyMarkup(
          chatId,
          options.messageId,
          undefined,
          { inline_keyboard: [] }
        );
      } catch {}
    }
  }

  await ctx.reply(text, keyboard);
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

function sanitizeEmotionPrompt(prompt: string): string {
  if (!prompt) return prompt;
  const withoutStyleResetLine = prompt.replace(
    /(^|\n)\s*Create a high-quality character illustration\.\s*(?=\n|$)/gi,
    "$1"
  );
  return withoutStyleResetLine.replace(/\n{3,}/g, "\n\n").trim();
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
      getGeminiGenerateContentUrl(agent.model),
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

async function sendProgressStart(
  ctx: any,
  sessionId: string,
  lang: string,
  existingMessageId?: number | null,
) {
  const progressText = await getText(lang, "progress.step1");

  if (existingMessageId && ctx.chat?.id) {
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        existingMessageId,
        undefined,
        progressText,
      );
    } catch {
      // edit may fail if text is identical — not critical
    }
    await supabase
      .from("sessions")
      .update({ progress_message_id: existingMessageId, progress_chat_id: ctx.chat.id })
      .eq("id", sessionId);
    return;
  }

  const msg = await ctx.reply(progressText);
  if (msg?.message_id && ctx.chat?.id) {
    await supabase
      .from("sessions")
      .update({ progress_message_id: msg.message_id, progress_chat_id: ctx.chat.id })
      .eq("id", sessionId);
  }
}

async function sendEarlyProgress(ctx: any, lang: string): Promise<number | null> {
  try {
    const text = lang === "ru" ? "⏳ Запускаю генерацию..." : "⏳ Starting generation...";
    const msg = await ctx.reply(text);
    return msg?.message_id || null;
  } catch {
    return null;
  }
}

function deleteEarlyProgress(ctx: any, messageId?: number | null) {
  if (messageId && ctx.chat?.id) {
    ctx.telegram.deleteMessage(ctx.chat.id, messageId).catch(() => {});
  }
}

// Shared composition/background rules — same for single sticker and pack (unified prompt flow)
const COMPOSITION_SUFFIX = `\n\nCRITICAL COMPOSITION AND BACKGROUND RULES:\n1. Background MUST be flat uniform BRIGHT MAGENTA (#FF00FF). This exact color is required for automated background removal. No other background colors allowed.\n2. If the pose has extended arms or wide gestures — zoom out to include them fully. Better to make the character slightly smaller than to crop any body part.`;

// Pack only: composition without magenta, 15%, and full-visibility rule (all in CRITICAL RULES FOR THE GRID in worker).
const COMPOSITION_SUFFIX_PACK = `\n\nCRITICAL COMPOSITION AND BACKGROUND RULES:\n1. If the pose has extended arms or wide gestures — zoom out to include them fully. Better to make the character slightly smaller than to crop any body part.`;

function ensureSingleSuffix(prompt: string, suffix: string): string {
  const base = String(prompt || "");
  if (!suffix) return base;
  let withoutSuffix = base;
  while (withoutSuffix.includes(suffix)) {
    withoutSuffix = withoutSuffix.replace(suffix, "");
  }
  return `${withoutSuffix.trimEnd()}${suffix}`;
}

type RenderMode = "stylize" | "photoreal";

function normalizeRenderMode(value: unknown): RenderMode {
  return String(value || "").trim().toLowerCase() === "photoreal" ? "photoreal" : "stylize";
}

function buildRenderModePolicy(mode: RenderMode): string {
  if (mode === "photoreal") {
    return `[RENDER MODE: PHOTOREAL]
Keep photorealistic rendering.
Do NOT convert to illustration, cartoon, anime, manga, manhwa, chibi, 3D toon, or painterly style.
Preserve natural skin texture, realistic lighting, camera-like details, and photo-like material appearance.`;
  }

  return `[RENDER MODE: STYLIZE]
Apply STRONG style transfer to the target style.
Keep identity (facial features/person) but DO NOT preserve source artistic rendering.
Re-render the image fully in the target style language (linework, shading, proportions, color treatment).`;
}

function applyRenderModePolicy(prompt: string, mode: RenderMode): string {
  const cleanPrompt = String(prompt || "").trim();
  if (/\[RENDER MODE:\s*(PHOTOREAL|STYLIZE)\]/i.test(cleanPrompt)) {
    return cleanPrompt;
  }
  const policy = buildRenderModePolicy(mode);
  return cleanPrompt ? `${policy}\n\n${cleanPrompt}` : policy;
}

function getMimeTypeByTelegramPath(filePath: string): string {
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".png")) return "image/png";
  return "image/jpeg";
}

function getSessionSubjectProfileForSource(
  session: any,
  sourceFileId: string,
  sourceKind: SubjectSourceKind
): SubjectProfile | null {
  const sessionMode = normalizeSubjectMode(session?.object_mode ?? session?.subject_mode);
  const sessionSourceFileId = session?.object_source_file_id || session?.subject_source_file_id || null;
  const sessionSourceKind = normalizeSubjectSourceKind(session?.object_source_kind ?? session?.subject_source_kind);
  if (!sessionSourceFileId || sessionSourceFileId !== sourceFileId || sessionSourceKind !== sourceKind) {
    return null;
  }

  const parsedCount = Number(session?.object_count ?? session?.subject_count);
  const parsedConfidence = Number(session?.object_confidence ?? session?.subject_confidence);
  const subjectGenderVal = normalizeSubjectGender(session?.object_gender ?? session?.subject_gender) ?? null;

  return {
    subjectMode: sessionMode,
    subjectCount: Number.isFinite(parsedCount) && parsedCount > 0 ? Math.floor(parsedCount) : null,
    subjectConfidence:
      Number.isFinite(parsedConfidence) && parsedConfidence >= 0
        ? Math.max(0, Math.min(1, Number(parsedConfidence.toFixed(3))))
        : null,
    subjectGender: subjectGenderVal,
    sourceFileId,
    sourceKind,
    detectedAt: session?.object_detected_at || session?.subject_detected_at || new Date().toISOString(),
  };
}

async function persistSubjectAndObjectProfile(sessionId: string, profile: SubjectProfile, detectedAt: string): Promise<void> {
  const payload = {
    subject_mode: profile.subjectMode,
    subject_count: profile.subjectCount,
    subject_confidence: profile.subjectConfidence,
    subject_gender: profile.subjectGender ?? null,
    subject_source_file_id: profile.sourceFileId,
    subject_source_kind: profile.sourceKind,
    subject_detected_at: detectedAt,
    object_mode: profile.subjectMode,
    object_count: profile.subjectCount,
    object_confidence: profile.subjectConfidence,
    object_gender: profile.subjectGender ?? null,
    object_source_file_id: profile.sourceFileId,
    object_source_kind: profile.sourceKind,
    object_detected_at: detectedAt,
  };

  const { error } = await supabase.from("sessions").update(payload).eq("id", sessionId);
  if (!error) return;

  const unknownColumn =
    error.code === "42703" ||
    /column .*(object_|subject_gender|object_gender)/.test(String(error.message || "").toLowerCase());
  if (!unknownColumn) {
    console.warn("[subject-profile] failed to persist profile:", error.message);
    return;
  }

  const { error: legacyError } = await supabase
    .from("sessions")
    .update({
      subject_mode: profile.subjectMode,
      subject_count: profile.subjectCount,
      subject_confidence: profile.subjectConfidence,
      subject_source_file_id: profile.sourceFileId,
      subject_source_kind: profile.sourceKind,
      subject_detected_at: detectedAt,
    })
    .eq("id", sessionId);
  if (legacyError) {
    console.warn("[subject-profile] failed to persist legacy profile:", legacyError.message);
  }
}

async function ensureSubjectProfileForGeneration(
  session: any,
  generationType: "style" | "emotion" | "motion" | "text" | "replace_subject"
): Promise<SubjectProfile | null> {
  const profileEnabled = await isSubjectProfileEnabled();
  if (!profileEnabled) {
    console.log("[subject-profile] skipped (subject_profile_enabled/object_profile* off) session:", session.id);
    return null;
  }

  const { sourceFileId, sourceKind } = resolveGenerationSource(session, generationType);
  if (!sourceFileId) return null;

  const existingProfile = getSessionSubjectProfileForSource(session, sourceFileId, sourceKind);
  if (existingProfile) return existingProfile;

  const detectedAt = new Date().toISOString();
  try {
    const filePath = await getFilePath(sourceFileId);
    const fileBuffer = await downloadFile(filePath);
    const mimeType = getMimeTypeByTelegramPath(filePath);
    const sourceFileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
    const detected = await detectSubjectProfileFromImageBuffer(fileBuffer, mimeType, sourceFileUrl);

    const subjectMode = detected.subjectMode;
    const nextProfile: SubjectProfile = {
      subjectMode,
      subjectCount: detected.subjectCount,
      subjectConfidence: detected.subjectConfidence,
      subjectGender: detected.subjectGender ?? null,
      sourceFileId,
      sourceKind,
      detectedAt,
    };

    await persistSubjectAndObjectProfile(session.id, nextProfile, detectedAt);

    Object.assign(session, {
      subject_mode: nextProfile.subjectMode,
      subject_count: nextProfile.subjectCount,
      subject_confidence: nextProfile.subjectConfidence,
      subject_gender: nextProfile.subjectGender ?? null,
      subject_source_file_id: nextProfile.sourceFileId,
      subject_source_kind: nextProfile.sourceKind,
      subject_detected_at: nextProfile.detectedAt,
      object_mode: nextProfile.subjectMode,
      object_count: nextProfile.subjectCount,
      object_confidence: nextProfile.subjectConfidence,
      object_gender: nextProfile.subjectGender ?? null,
      object_source_file_id: nextProfile.sourceFileId,
      object_source_kind: nextProfile.sourceKind,
      object_detected_at: nextProfile.detectedAt,
    });

    console.log("[subject-profile] updated for session:", session.id, {
      sourceKind,
      subjectMode: nextProfile.subjectMode,
      subjectCount: nextProfile.subjectCount,
      subjectGender: nextProfile.subjectGender,
    });
    // Алерт subject_profile_detected шлём только из воркера (один раз на джоб), чтобы не дублировать.
    return nextProfile;
  } catch (err: any) {
    console.warn("[subject-profile] failed to resolve profile:", err?.message || err);
    const fallbackProfile: SubjectProfile = {
      subjectMode: "unknown",
      subjectCount: null,
      subjectConfidence: null,
      subjectGender: null,
      sourceFileId,
      sourceKind,
      detectedAt,
    };

    await persistSubjectAndObjectProfile(session.id, fallbackProfile, detectedAt);

    Object.assign(session, {
      subject_mode: fallbackProfile.subjectMode,
      subject_count: fallbackProfile.subjectCount,
      subject_confidence: fallbackProfile.subjectConfidence,
      subject_gender: fallbackProfile.subjectGender ?? null,
      subject_source_file_id: fallbackProfile.sourceFileId,
      subject_source_kind: fallbackProfile.sourceKind,
      subject_detected_at: fallbackProfile.detectedAt,
      object_mode: fallbackProfile.subjectMode,
      object_count: fallbackProfile.subjectCount,
      object_confidence: fallbackProfile.subjectConfidence,
      object_gender: fallbackProfile.subjectGender ?? null,
      object_source_file_id: fallbackProfile.sourceFileId,
      object_source_kind: fallbackProfile.sourceKind,
      object_detected_at: fallbackProfile.detectedAt,
    });
    // Алерт subject_profile_detected шлём только из воркера, чтобы не дублировать.
    return fallbackProfile;
  }
}

async function applySubjectLockToPrompt(
  session: any,
  generationType: "style" | "emotion" | "motion" | "text" | "replace_subject",
  prompt: string
): Promise<string> {
  const ensuredProfile = await ensureSubjectProfileForGeneration(session, generationType);
  const lockEnabled = await isSubjectLockEnabled();
  if (!lockEnabled) return prompt;

  const { sourceFileId, sourceKind } = resolveGenerationSource(session, generationType);
  if (!sourceFileId) return prompt;

  const profile =
    ensuredProfile ||
    getSessionSubjectProfileForSource(session, sourceFileId, sourceKind) ||
    null;
  if (!profile) return prompt;

  const lockBlock = buildSubjectLockBlock(profile);
  return appendSubjectLock(prompt, lockBlock);
}

function normalizePackSetSubjectMode(value: any): "single" | "multi" | "any" {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "single") return "single";
  if (normalized === "multi") return "multi";
  return "any";
}

function isPackSetCompatibleWithSubject(
  setSubjectMode: "single" | "multi" | "any",
  subjectMode: "single" | "multi" | "unknown"
): boolean {
  if (subjectMode === "unknown") return true;
  if (setSubjectMode === "any") return true;
  return setSubjectMode === subjectMode;
}

function filterPackContentSetsBySubjectMode(contentSets: any[], subjectMode: "single" | "multi" | "unknown"): any[] {
  if (!Array.isArray(contentSets)) return [];
  if (subjectMode === "unknown") return contentSets;
  return contentSets.filter((set) => {
    const setMode = normalizePackSetSubjectMode(set?.subject_mode);
    return isPackSetCompatibleWithSubject(setMode, subjectMode);
  });
}

function getEffectiveSubjectMode(session: any): "single" | "multi" | "unknown" {
  return normalizeSubjectMode(session?.object_mode ?? session?.subject_mode);
}

async function startGeneration(
  ctx: any,
  user: any,
  session: any,
  lang: string,
  options: {
    generationType: "style" | "emotion" | "motion" | "text" | "replace_subject";
    promptFinal: string;
    styleSourceKind?: "photo" | "sticker";
    userInput?: string | null;
    emotionPrompt?: string | null;
    selectedStyleId?: string | null;
    selectedEmotion?: string | null;
    textPrompt?: string | null;
    assistantParams?: { style: string; emotion: string; pose: string } | null;
    earlyProgressMessageId?: number | null;
  }
) {
  const traceId = getOrCreateTraceId(ctx);
  logSessionTrace("generation.start", {
    userId: user?.id || null,
    generationType: options.generationType,
    sessionBefore: sessionTraceSnapshot(session),
  }, traceId);
  const creditsNeeded = 1;
  const isPackFlowState =
    String(session?.state || "").startsWith("wait_pack_")
    || ["generating_pack_preview", "generating_pack_theme", "processing_pack"].includes(String(session?.state || ""));
  const isSingleFlowGeneration = !isPackFlowState;
  const processingStates = new Set(["processing", "processing_emotion", "processing_motion", "processing_text"]);

  if (processingStates.has(String(session?.state || ""))) {
    deleteEarlyProgress(ctx, options.earlyProgressMessageId);
    await ctx.reply(lang === "ru"
      ? "⏳ Генерация уже запущена. Подожди несколько секунд."
      : "⏳ Generation is already running. Please wait a few seconds.");
    return;
  }

  const expectedRevRaw = Number(session?.session_rev || 1);
  const expectedRev = Number.isFinite(expectedRevRaw) && expectedRevRaw > 0 ? expectedRevRaw : 1;
  const { data: claimedSession, error: claimErr } = await supabase
    .from("sessions")
    .update({
      session_rev: expectedRev + 1,
      is_active: true,
    })
    .eq("id", session.id)
    .eq("session_rev", expectedRev)
    .select("*")
    .maybeSingle();

  if (claimErr) {
    console.error("[startGeneration] claim failed:", claimErr.message);
    deleteEarlyProgress(ctx, options.earlyProgressMessageId);
    await ctx.reply(lang === "ru"
      ? "⚠️ Не удалось запустить генерацию. Попробуй ещё раз."
      : "⚠️ Failed to start generation. Please try again.");
    return;
  }
  if (!claimedSession) {
    deleteEarlyProgress(ctx, options.earlyProgressMessageId);
    const freshSession = await getSessionByIdForUser(user.id, session.id);
    if (processingStates.has(String(freshSession?.state || ""))) {
      await ctx.reply(lang === "ru"
        ? "⏳ Генерация уже запущена. Подожди несколько секунд."
        : "⏳ Generation is already running. Please wait a few seconds.");
      return;
    }
    await ctx.reply(lang === "ru"
      ? "⚠️ Сессия обновилась, нажми кнопку ещё раз."
      : "⚠️ Session was updated, please tap again.");
    return;
  }
  session = claimedSession;
  logSessionTrace("generation.claim_ok", {
    userId: user?.id || null,
    generationType: options.generationType,
    sessionAfterClaim: sessionTraceSnapshot(session),
  }, traceId);
  if (isSingleFlowGeneration) {
    console.log("[single.gen.api] claim_ok", {
      sessionId: session.id,
      userId: user?.id,
      state: session.state,
      generationType: options.generationType,
      sessionRev: session.session_rev,
      flowKind: session.flow_kind || "unknown",
    });
  }

  if (options.generationType === "style" && options.selectedStyleId && options.selectedStyleId !== "assistant") {
    const stylePreset = await getStylePresetV2ById(options.selectedStyleId);
    const renderMode = normalizeRenderMode(stylePreset?.render_mode);
    options.promptFinal = applyRenderModePolicy(options.promptFinal, renderMode);
    console.log("[style.render_mode]", {
      sessionId: session.id,
      selectedStyleId: options.selectedStyleId,
      renderMode,
    });
  }
  const effectiveStyleSourceKind =
    options.generationType === "style"
      ? (options.styleSourceKind || (String(session?.style_source_kind || "").toLowerCase() === "sticker" ? "sticker" : "photo"))
      : null;
  if (effectiveStyleSourceKind) {
    session.style_source_kind = effectiveStyleSourceKind;
  }

  options.promptFinal = await applySubjectLockToPrompt(session, options.generationType, options.promptFinal);
  if (options.generationType === "emotion") {
    options.promptFinal = sanitizeEmotionPrompt(options.promptFinal);
  }
  options.promptFinal = ensureSingleSuffix(options.promptFinal, COMPOSITION_SUFFIX);

  console.log("=== startGeneration ===");
  console.log("user.id:", user?.id);
  console.log("user.credits:", user?.credits, "type:", typeof user?.credits);
  console.log("user.has_purchased:", user.has_purchased);
  console.log("user.onboarding_step:", user.onboarding_step);
  console.log("generationType:", options.generationType);
  console.log("creditsNeeded:", creditsNeeded);

  // Check if user has enough credits
  if (user.credits < creditsNeeded) {
    deleteEarlyProgress(ctx, options.earlyProgressMessageId);
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
        ...(effectiveStyleSourceKind ? { style_source_kind: effectiveStyleSourceKind } : {}),
        credits_spent: creditsNeeded,
        is_active: true,
      })
      .eq("id", session.id);
    logSessionTrace("generation.insufficient_credits_transition", {
      userId: user?.id || null,
      generationType: options.generationType,
      sessionId: session.id,
      toState: targetState,
      error: paywallUpdateErr?.message || null,
    }, traceId);
    if (paywallUpdateErr) {
      console.error("[startGeneration] Paywall state update FAILED:", paywallUpdateErr.message);
    } else {
      console.log("[startGeneration] Paywall state update OK");
    }

    if (isPaywall) {
      const paywallText = lang === "ru"
        ? "Стикер почти готов! 🔥\n\nРазблокируй генерацию, купив пакет кредитов."
        : "Sticker almost ready! 🔥\n\nUnlock generation by purchasing a credit package.";
      await ctx.reply(paywallText);
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
    if (isSingleFlowGeneration) {
      console.log("[single.gen.api] paywall_or_insufficient", {
        sessionId: session.id,
        userId: user?.id,
        generationType: options.generationType,
        targetState,
        credits: user.credits,
        needed: creditsNeeded,
        hasPurchased: user.has_purchased,
      });
    }
    return;
  }

  // Deduct credits atomically (prevents race condition)
  const { data: deducted, error: deductError } = await supabase
    .rpc("deduct_credits", { p_user_id: user.id, p_amount: creditsNeeded });
  
  if (deductError || !deducted) {
    deleteEarlyProgress(ctx, options.earlyProgressMessageId);
    console.error("Atomic deduct failed - race condition detected:", deductError?.message || "not enough credits");
    await ctx.reply(await getText(lang, "photo.not_enough_credits", {
      needed: creditsNeeded,
      balance: 0,
    }));
    await sendBuyCreditsMenu(ctx, user);
    if (isSingleFlowGeneration) {
      console.log("[single.gen.api] deduct_failed", {
        sessionId: session.id,
        userId: user?.id,
        generationType: options.generationType,
        error: deductError?.message || "not_enough_credits",
      });
    }
    return;
  }
  if (isSingleFlowGeneration) {
    console.log("[single.gen.api] deduct_ok", {
      sessionId: session.id,
      userId: user?.id,
      generationType: options.generationType,
      amount: creditsNeeded,
    });
  }

  // Increment total_generations
  await supabase.rpc("increment_generations", { p_user_id: user.id });

  const nextState = 
    options.generationType === "emotion" ? "processing_emotion" :
    options.generationType === "motion" ? "processing_motion" :
    options.generationType === "text" ? "processing_text" : "processing";
  logSessionTrace("generation.processing_transition_planned", {
    userId: user?.id || null,
    generationType: options.generationType,
    sessionId: session.id,
    fromState: session.state,
    toState: nextState,
  }, traceId);

  await supabase
    .from("sessions")
    .update({
      user_input: options.userInput || session.user_input || null,
      prompt_final: options.promptFinal,
      emotion_prompt: options.emotionPrompt || null,
      selected_style_id: options.selectedStyleId || session.selected_style_id || null,
      selected_emotion: options.selectedEmotion || null,
      ...(effectiveStyleSourceKind ? { style_source_kind: effectiveStyleSourceKind } : {}),
      text_prompt: options.textPrompt || null,
      generation_type: options.generationType,
      credits_spent: creditsNeeded,
      state: nextState,
      is_active: true,
    })
    .eq("id", session.id);
  logSessionTrace("generation.processing_transition_applied", {
    userId: user?.id || null,
    generationType: options.generationType,
    sessionId: session.id,
    toState: nextState,
  }, traceId);
  if (isSingleFlowGeneration) {
    console.log("[single.gen.api] session_updated_processing", {
      sessionId: session.id,
      userId: user?.id,
      generationType: options.generationType,
      nextState,
      selectedStyleId: options.selectedStyleId || session.selected_style_id || null,
      selectedEmotion: options.selectedEmotion || null,
      hasTextPrompt: Boolean(options.textPrompt),
      promptLen: (options.promptFinal || "").length,
    });
  }

  await enqueueJob(session.id, user.id, false);
  if (isSingleFlowGeneration) {
    console.log("[single.gen.api] enqueue_ok", {
      sessionId: session.id,
      userId: user?.id,
      generationType: options.generationType,
    });
  }

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
      case "replace_subject": return lang === "ru" ? "Заменить лицо в стикере" : "Replace face in sticker";
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
    photoFileId: session.current_photo_file_id || undefined,
  }).catch(console.error);

  await sendProgressStart(ctx, session.id, lang, options.earlyProgressMessageId);
}

// Credit packages: { credits, bonus_credits?, price_in_stars, label_ru, label_en, price_rub, adminOnly?, trialOnly?, hidden? }
// 1 pack = 16 credits (1 preview + 15 approve). Credits aligned to pack count.
const CREDIT_PACKS = [
  { credits: 1, price: 1, price_rub: 1, label_ru: "🔧 Тест", label_en: "🔧 Test", adminOnly: true },
  { credits: 9, bonus_credits: 8, price: 98, price_rub: 102, label_ru: "🎁 Попробуй", label_en: "🎁 Try", trialOnly: true },
  { credits: 17, price: 150, price_rub: 156, label_ru: "⭐ Старт", label_en: "⭐ Start" },
  { credits: 32, price: 350, price_rub: 364, label_ru: "💎 Поп", label_en: "💎 Pop" },
  { credits: 112, price: 1000, price_rub: 1040, label_ru: "👑 Про", label_en: "👑 Pro" },
  { credits: 256, price: 2250, price_rub: 2340, label_ru: "🚀 Макс", label_en: "🚀 Max" },
  // Hidden discount packs (not shown in UI, used via direct callback for promos, abandoned carts, admin discounts)
  // -10%
  { credits: 9, bonus_credits: 8, price: 88, price_rub: 92, label_ru: "🎁 Попробуй -10%", label_en: "🎁 Try -10%", hidden: true, trialOnly: true },
  { credits: 17, price: 135, price_rub: 140, label_ru: "⭐ Старт -10%", label_en: "⭐ Start -10%", hidden: true },
  { credits: 32, price: 315, price_rub: 328, label_ru: "💎 Поп -10%", label_en: "💎 Pop -10%", hidden: true },
  { credits: 112, price: 900, price_rub: 936, label_ru: "👑 Про -10%", label_en: "👑 Pro -10%", hidden: true },
  { credits: 256, price: 2025, price_rub: 2106, label_ru: "🚀 Макс -10%", label_en: "🚀 Max -10%", hidden: true },
  // -15%
  { credits: 9, bonus_credits: 8, price: 83, price_rub: 87, label_ru: "🎁 Попробуй -15%", label_en: "🎁 Try -15%", hidden: true, trialOnly: true },
  { credits: 17, price: 128, price_rub: 133, label_ru: "⭐ Старт -15%", label_en: "⭐ Start -15%", hidden: true },
  { credits: 32, price: 298, price_rub: 309, label_ru: "💎 Поп -15%", label_en: "💎 Pop -15%", hidden: true },
  { credits: 112, price: 850, price_rub: 884, label_ru: "👑 Про -15%", label_en: "👑 Pro -15%", hidden: true },
  { credits: 256, price: 1913, price_rub: 1989, label_ru: "🚀 Макс -15%", label_en: "🚀 Max -15%", hidden: true },
  // -25%
  { credits: 9, bonus_credits: 8, price: 74, price_rub: 77, label_ru: "🎁 Попробуй -25%", label_en: "🎁 Try -25%", hidden: true, trialOnly: true },
  { credits: 17, price: 113, price_rub: 117, label_ru: "⭐ Старт -25%", label_en: "⭐ Start -25%", hidden: true },
  { credits: 32, price: 263, price_rub: 273, label_ru: "💎 Поп -25%", label_en: "💎 Pop -25%", hidden: true },
  { credits: 112, price: 750, price_rub: 780, label_ru: "👑 Про -25%", label_en: "👑 Pro -25%", hidden: true },
  { credits: 256, price: 1688, price_rub: 1755, label_ru: "🚀 Макс -25%", label_en: "🚀 Max -25%", hidden: true },
];

function getPackTotalCredits(pack: any): number {
  return Number(pack?.credits || 0) + Number(pack?.bonus_credits || 0);
}

const PAYMENT_ACTIVE_TX_TTL_MS = 15 * 60 * 1000;

/**
 * Build balance info string for check_balance tool.
 * Returned as context for AI to use in conversation.
 */
function buildBalanceInfo(user: any, lang: string): string {
  const packs = CREDIT_PACKS
    .filter((p: any) => !p.adminOnly && !p.hidden)
    .map((p: any) => {
      const totalCredits = getPackTotalCredits(p);
      return `• ${totalCredits} credits — ${p.price}⭐ (${(p.price / totalCredits).toFixed(1)}⭐/стикер) ${lang === "ru" ? p.label_ru : p.label_en}`;
    })
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
async function buildStickerButtons(
  lang: string,
  stickerId: string,
  options?: { sessionId?: string | null; sessionRev?: number | null }
) {
  const addToPackText = await getText(lang, "btn.add_to_pack");
  const changeEmotionText = lang === "ru" ? "😊 Эмоция" : await getText(lang, "btn.change_emotion");
  const changeMotionText = lang === "ru" ? "🏃 Движение" : await getText(lang, "btn.change_motion");
  const addTextText = lang === "ru" ? "✏️ Текст" : await getText(lang, "btn.add_text");
  const toggleBorderText = lang === "ru" ? "🔲 Обводка" : await getText(lang, "btn.toggle_border");
  const replaceFaceText = await getText(lang, "btn.replace_face");
  const changeStyleText = await getText(lang, "btn.change_style");
  const removeBgText = lang === "ru" ? "🖼 Вырезать фон" : "🖼 Remove background";
  const packIdeasText = lang === "ru" ? "💡 Идеи" : "💡 Pack ideas";

  const sessionRef = formatCallbackSessionRef(options?.sessionId, options?.sessionRev);
  const styleCb = appendSessionRefIfFits(`change_style:${stickerId}`, sessionRef);
  const emotionCb = appendSessionRefIfFits(`change_emotion:${stickerId}`, sessionRef);
  const motionCb = appendSessionRefIfFits(`change_motion:${stickerId}`, sessionRef);
  const replaceFaceCb = appendSessionRefIfFits(`replace_face:${stickerId}`, sessionRef);
  const removeBgCb = appendSessionRefIfFits(`remove_bg:${stickerId}`, sessionRef);

  return {
    inline_keyboard: [
      [{ text: addToPackText, callback_data: `add_to_pack:${stickerId}` }],
      [{ text: changeStyleText, callback_data: styleCb }],
      [
        { text: changeEmotionText, callback_data: emotionCb },
        { text: changeMotionText, callback_data: motionCb },
      ],
      [
        { text: toggleBorderText, callback_data: `toggle_border:${stickerId}` },
        { text: addTextText, callback_data: `add_text:${stickerId}` },
      ],
      [
        { text: replaceFaceText, callback_data: replaceFaceCb },
        { text: removeBgText, callback_data: removeBgCb },
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

// Helper: get persistent menu keyboard (2 rows). Single-sticker entry is always visible in row1.
function getMainMenuKeyboard(lang: string, telegramId?: number) {
  const isAdmin = telegramId != null && config.adminIds.includes(telegramId);
  const showAdminGenerate = isAdmin;
  const showAdminMakeExample = isAdmin;
  const row1 =
    lang === "ru"
      ? showAdminMakeExample
        ? ["⚡ Действия", "🔄 Сгенерировать пак", "⭐ Сделать примером"]
        : showAdminGenerate
          ? ["⚡ Действия", "🔄 Сгенерировать пак"]
          : ["⚡ Действия"]
      : showAdminMakeExample
        ? ["⚡ Actions", "🔄 Generate pack", "⭐ Make as example"]
        : showAdminGenerate
          ? ["⚡ Actions", "🔄 Generate pack"]
          : ["⚡ Actions"];
  const row2 =
    lang === "ru"
      ? ["💰 Ваш баланс", "💬 Поддержка"]
      : ["💰 Your balance", "💬 Support"];
  return Markup.keyboard([row1, row2]).resize().persistent();
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

  // Cancel ALL non-canceled sessions (is_active may already be false due to DB bug — see known-issues #1)
  await supabase
    .from("sessions")
    .update({ state: "canceled", is_active: false })
    .eq("user_id", user.id)
    .eq("env", config.appEnv)
    .neq("state", "canceled");

  // Create new session with assistant state
  const lastPhotoFromSessions = await getLatestSessionPhotoFileId(user.id);
  const lastPhotoFromUser = user.last_photo_file_id || null;
  const lastPhoto = lastPhotoFromSessions || lastPhotoFromUser || null;
  console.log("startAssistantDialog: photo source", {
    userId: user.id,
    source: lastPhotoFromSessions ? "sessions" : (lastPhotoFromUser ? "users.last_photo_file_id" : "none"),
    hasPhoto: !!lastPhoto,
  });
  // Keep users.last_photo_file_id in sync with the latest session photo to avoid stale ideas.
  if (lastPhotoFromSessions && lastPhotoFromSessions !== lastPhotoFromUser) {
    const { error: syncErr } = await supabase
      .from("users")
      .update({ last_photo_file_id: lastPhotoFromSessions })
      .eq("id", user.id);
    if (syncErr) {
      console.warn("startAssistantDialog: failed to sync users.last_photo_file_id:", syncErr.message);
    } else {
      user.last_photo_file_id = lastPhotoFromSessions;
      console.log("startAssistantDialog: synced users.last_photo_file_id from latest session photo");
    }
  }
  const { data: newSession, error: sessionError } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      state: lastPhoto ? "wait_style" : "assistant_wait_photo",
      is_active: true,
      flow_kind: "assistant",
      style_source_kind: "photo",
      env: config.appEnv,
      current_photo_file_id: lastPhoto,
      photos: lastPhoto ? [lastPhoto] : [],
    })
    .select()
    .single();

  if (sessionError || !newSession) {
    console.error("startAssistantDialog: Failed to create session:", sessionError?.message || "no data");
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
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
    hasPhoto: !!lastPhoto,
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
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }

  // Template greeting — no AI call, instant response (~0.5s instead of 3-5s)
  const firstName = ctx.from?.first_name || "";
  const isReturning = previousGoal || (user.total_generations || 0) > 0;

  let greeting: string;
  if (lastPhoto) {
    // Photo already available — style selection will be shown right after greeting
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

  await ctx.reply(greeting, getMainMenuKeyboard(lang, ctx?.from?.id));

  // If photo already exists — show style selection immediately
  if (lastPhoto) {
    console.log("startAssistantDialog: lastPhoto exists, showing style selection");
    await sendStyleKeyboardFlat(ctx, lang, undefined, { selectedStyleId: newSession.selected_style_id || null });
  }
}

/**
 * Handle assistant confirmation: start generation or show paywall.
 */
async function handleAssistantConfirm(ctx: any, user: any, sessionId: string, lang: string) {
  // Get assistant session for params
  const aSession = await getActiveAssistantSession(user.id);
  if (!aSession) {
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }

  // Re-fetch sessions row for generation
  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (!session) {
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
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
  // Authoritative photo state for LLM (avoid stale "Has photo: false" from old base prompt).
  let hasPhoto = false;
  if (aSession.session_id) {
    const { data: s } = await supabase
      .from("sessions")
      .select("current_photo_file_id")
      .eq("id", aSession.session_id)
      .maybeSingle();
    hasPhoto = !!s?.current_photo_file_id;
  }
  if (!hasPhoto) {
    hasPhoto = !!aSession.pending_photo_file_id;
  }

  return basePrompt + buildStateInjection(aSession, {
    availableStyles,
    trialBudgetRemaining,
    trafficSource,
    hasPhoto,
  });
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

function shouldResumeAssistantChatAfterPhoto(aSession: AssistantSessionRow): boolean {
  const hasCollectedParams = Boolean(
    aSession.style ||
    aSession.emotion ||
    aSession.pose ||
    (aSession.goal && String(aSession.goal).trim())
  );
  const messages: AssistantMessage[] = Array.isArray(aSession.messages) ? aSession.messages : [];
  const nonSystemMessages = messages.filter(m => m.role !== "system").length;
  // Fresh dialog before first real user intent usually has only greeting.
  // When there is real conversation context, return to requirements collection.
  return hasCollectedParams || nonSystemMessages >= 3;
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

const SESSION_FALLBACK_ACTIVE_STATES = [
  // Assistant
  "assistant_wait_photo",
  "assistant_chat",
  // Single sticker flow
  "wait_photo",
  "wait_action",
  "wait_style",
  // Legacy states kept only for runtime migration to wait_style.
  "wait_custom_style",
  "wait_custom_style_v2",
  "wait_custom_emotion",
  "wait_custom_motion",
  "wait_text_overlay",
  "wait_replace_face_sticker",
  "wait_edit_sticker",
  "wait_edit_photo",
  "wait_edit_action",
  "wait_emotion",
  "wait_motion",
  "confirm_sticker",
  // Pack flow
  "wait_pack_photo",
  "wait_pack_carousel",
  "wait_pack_preview_payment",
  "wait_pack_generate_request",
  "wait_pack_approval",
  "wait_pack_rework_feedback",
  "generating_pack_preview",
  "generating_pack_theme",
  "processing_pack",
  // Generic generation states
  "processing",
  "processing_emotion",
  "processing_motion",
  "processing_text",
  // Payment/waiting states
  "wait_first_purchase",
  "wait_buy_credit",
];

function detectSessionFlow(session: any): "assistant" | "pack" | "single" | "unknown" {
  const state = String(session?.state || "");
  const flowKind = String(session?.flow_kind || "");
  if (flowKind === "assistant" || state.startsWith("assistant_")) return "assistant";
  if (flowKind === "pack" || state.startsWith("wait_pack_") || ["generating_pack_preview", "generating_pack_theme", "processing_pack"].includes(state)) return "pack";
  if (flowKind === "single" || state.startsWith("wait_") || state.startsWith("processing") || state === "confirm_sticker") return "single";
  return "unknown";
}

function sessionTraceSnapshot(session: any) {
  return {
    id: session?.id || null,
    state: session?.state || null,
    flow: detectSessionFlow(session),
    flow_kind: session?.flow_kind || null,
    is_active: session?.is_active ?? null,
    session_rev: session?.session_rev ?? null,
  };
}

function logSessionTrace(event: string, details: Record<string, unknown>, traceId?: string | null) {
  const resolvedTraceId = traceId || traceContext.getStore()?.traceId || null;
  console.log("[session.trace]", { trace_id: resolvedTraceId, event, ...details });
}

// Helper: get active session
async function getActiveSession(userId: string, traceId?: string | null) {
  logSessionTrace("getActiveSession.start", { userId }, traceId);
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .eq("env", config.appEnv)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.log("getActiveSession error:", error.message, error.code);
    logSessionTrace("getActiveSession.error", { userId, error: error.message, code: error.code }, traceId);
  }
  if (data) {
    logSessionTrace("getActiveSession.primary_hit", { userId, session: sessionTraceSnapshot(data) }, traceId);
    return data;
  }

  // Fallback: some DB setups flip is_active to false on update
  console.log("getActiveSession fallback for user:", userId);
  const recentCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: fallbackByUpdatedAt } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .in("state", SESSION_FALLBACK_ACTIVE_STATES)
    .gte("updated_at", recentCutoff)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fallbackByUpdatedAt) {
    console.log(
      "getActiveSession fallback found (updated_at):",
      fallbackByUpdatedAt.id,
      "state:",
      fallbackByUpdatedAt.state,
      "is_active:",
      fallbackByUpdatedAt.is_active
    );
    logSessionTrace("getActiveSession.fallback_updated_at_hit", { userId, session: sessionTraceSnapshot(fallbackByUpdatedAt) }, traceId);
    return fallbackByUpdatedAt;
  }

  // Some environments may keep updated_at null/unchanged.
  // Secondary fallback by recent created_at prevents false "need /start" in active flows.
  const { data: fallbackByCreatedAt } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .in("state", SESSION_FALLBACK_ACTIVE_STATES)
    .gte("created_at", recentCutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fallbackByCreatedAt) {
    console.log(
      "getActiveSession fallback found (created_at):",
      fallbackByCreatedAt.id,
      "state:",
      fallbackByCreatedAt.state,
      "is_active:",
      fallbackByCreatedAt.is_active
    );
    logSessionTrace("getActiveSession.fallback_created_at_hit", { userId, session: sessionTraceSnapshot(fallbackByCreatedAt) }, traceId);
  }

  if (!fallbackByCreatedAt) {
    logSessionTrace("getActiveSession.miss", { userId }, traceId);
  }

  return fallbackByCreatedAt;
}

async function getPendingPaymentSession(userId: string, traceId?: string | null) {
  logSessionTrace("getPendingPaymentSession.start", { userId }, traceId);
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .in("state", ["wait_buy_credit", "wait_first_purchase"])
    .order("updated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logSessionTrace("getPendingPaymentSession.error", { userId, error: error.message, code: error.code }, traceId);
  }
  logSessionTrace("getPendingPaymentSession.result", { userId, session: sessionTraceSnapshot(data) }, traceId);
  return data;
}

const PACK_FLOW_STATES = ["wait_pack_photo", "wait_pack_carousel", "wait_pack_preview_payment", "wait_pack_generate_request", "generating_pack_preview", "generating_pack_theme", "wait_pack_approval", "wait_pack_rework_feedback", "processing_pack"] as const;

/** States used in SQL IN(...). Excludes generating_pack_theme until migration 121 is applied (invalid enum on prod otherwise breaks getPackFlowSession and holiday button). */
const PACK_FLOW_STATES_FOR_QUERY = PACK_FLOW_STATES.filter((s) => s !== "generating_pack_theme") as unknown as string[];

/** Get session that is in pack flow (for pack callbacks when user may have is_active assistant session). */
async function getPackFlowSession(userId: string, traceId?: string | null) {
  const { data } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .in("state", PACK_FLOW_STATES_FOR_QUERY)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  logSessionTrace("getPackFlowSession.result", { userId, session: sessionTraceSnapshot(data) }, traceId);
  return data;
}

const ASSISTANT_FLOW_RECOVERY_STATES = [
  "assistant_wait_photo",
  "assistant_chat",
] as const;

async function getAssistantFlowRecoverySession(userId: string, traceId?: string | null) {
  logSessionTrace("getAssistantFlowRecoverySession.start", { userId }, traceId);
  const activeAssistant = await getActiveAssistantSession(userId);
  if (activeAssistant?.session_id) {
    const linkedSession = await getSessionByIdForUser(userId, activeAssistant.session_id, traceId);
    if (linkedSession?.id && (linkedSession.flow_kind === "assistant" || String(linkedSession.state || "").startsWith("assistant_"))) {
      logSessionTrace("getAssistantFlowRecoverySession.active_assistant_link_hit", {
        userId,
        assistantSessionId: activeAssistant.id,
        linkedSession: sessionTraceSnapshot(linkedSession),
      }, traceId);
      return linkedSession;
    }
  }

  const recentAssistant = await getRecentAssistantSession(userId, 30 * 60 * 1000);
  if (recentAssistant?.session_id) {
    const linkedRecentSession = await getSessionByIdForUser(userId, recentAssistant.session_id, traceId);
    if (linkedRecentSession?.id && (linkedRecentSession.flow_kind === "assistant" || String(linkedRecentSession.state || "").startsWith("assistant_"))) {
      logSessionTrace("getAssistantFlowRecoverySession.recent_assistant_link_hit", {
        userId,
        assistantSessionId: recentAssistant.id,
        linkedSession: sessionTraceSnapshot(linkedRecentSession),
      }, traceId);
      return linkedRecentSession;
    }
  }

  const recentCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .eq("flow_kind", "assistant")
    .in("state", ASSISTANT_FLOW_RECOVERY_STATES as unknown as string[])
    .gte("updated_at", recentCutoff)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  logSessionTrace("getAssistantFlowRecoverySession.query_result", { userId, session: sessionTraceSnapshot(data) }, traceId);
  return data;
}

/**
 * Resolve session for inbound photo messages.
 * First use generic active-session resolution, then fallback to latest pack-flow session.
 */
async function resolveSessionForIncomingPhoto(userId: string, traceId?: string | null) {
  logSessionTrace("resolveSessionForIncomingPhoto.start", { userId }, traceId);
  const activeSession = await getActiveSession(userId, traceId);
  if (activeSession?.id) {
    logSessionTrace("resolveSessionForIncomingPhoto.pick_active", { userId, session: sessionTraceSnapshot(activeSession) }, traceId);
    return activeSession;
  }

  // Strong fallback: pick the latest non-assistant active-like session first.
  // This protects manual flows from being hijacked by stale assistant recovery sessions.
  const NON_ASSISTANT_FALLBACK_STATES = SESSION_FALLBACK_ACTIVE_STATES.filter(
    (s) => !String(s).startsWith("assistant_")
  );
  const { data: latestNonAssistantSession } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .in("state", NON_ASSISTANT_FALLBACK_STATES as unknown as string[])
    .order("updated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestNonAssistantSession?.id) {
    console.log(
      "Photo router fallback: using latest non-assistant session:",
      latestNonAssistantSession.id,
      "state:",
      latestNonAssistantSession.state
    );
    logSessionTrace("resolveSessionForIncomingPhoto.pick_non_assistant_fallback", {
      userId,
      session: sessionTraceSnapshot(latestNonAssistantSession),
    }, traceId);
    return latestNonAssistantSession;
  }

  // Replace-face fallback (fresh-only):
  // only recover recent replace-face/edit sessions so stale old sessions do not
  // hijack "new photo" flow in action menu.
  const REPLACE_FACE_RECOVERY_STATES = [
    "wait_replace_face_sticker",
    "wait_edit_sticker",
    "wait_edit_photo",
    "wait_edit_action",
  ];
  const replaceFaceRecentCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: replaceFaceSession } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .in("state", REPLACE_FACE_RECOVERY_STATES as unknown as string[])
    .gte("created_at", replaceFaceRecentCutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (replaceFaceSession?.id) {
    logSessionTrace("resolveSessionForIncomingPhoto.pick_replace_face_fallback", {
      userId,
      session: sessionTraceSnapshot(replaceFaceSession),
    }, traceId);
    return replaceFaceSession;
  }

  // Prefer latest single-flow session before assistant recovery to avoid hijacking
  // fresh manual states (wait_action/wait_style/etc.) by stale assistant leftovers.
  const { data: latestSingleSession } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .eq("flow_kind", "single")
    .in("state", SESSION_FALLBACK_ACTIVE_STATES)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestSingleSession?.id) {
    console.log(
      "Photo router fallback: using latest single session:",
      latestSingleSession.id,
      "state:",
      latestSingleSession.state
    );
    logSessionTrace("resolveSessionForIncomingPhoto.pick_single_fallback", {
      userId,
      session: sessionTraceSnapshot(latestSingleSession),
    }, traceId);
    return latestSingleSession;
  }

  // Last-resort: sessions in replace-face or wait_action, order by created_at only.
  // Some DB setups may have null updated_at, causing earlier fallbacks to miss.
  const REPLACE_FACE_OR_ACTION_STATES = [
    "wait_replace_face_sticker",
    "wait_edit_photo",
    "wait_action",
  ];
  const { data: lastResortSession } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .in("state", REPLACE_FACE_OR_ACTION_STATES as unknown as string[])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastResortSession?.id) {
    console.log(
      "Photo router fallback: using last-resort session (created_at):",
      lastResortSession.id,
      "state:",
      lastResortSession.state
    );
    logSessionTrace("resolveSessionForIncomingPhoto.pick_last_resort_created", {
      userId,
      session: sessionTraceSnapshot(lastResortSession),
    }, traceId);
    return lastResortSession;
  }

  const packSession = await getPackFlowSession(userId, traceId);
  if (packSession?.id) {
    console.log(
      "Photo router fallback: using latest pack session:",
      packSession.id,
      "state:",
      packSession.state
    );
    logSessionTrace("resolveSessionForIncomingPhoto.pick_pack_fallback", {
      userId,
      session: sessionTraceSnapshot(packSession),
    }, traceId);
    return packSession;
  }

  const assistantSession = await getAssistantFlowRecoverySession(userId, traceId);
  if (assistantSession?.id) {
    console.log(
      "Photo router fallback: using assistant recovery session:",
      assistantSession.id,
      "state:",
      assistantSession.state
    );
    logSessionTrace("resolveSessionForIncomingPhoto.pick_assistant_fallback", {
      userId,
      session: sessionTraceSnapshot(assistantSession),
    }, traceId);
    return assistantSession;
  }

  logSessionTrace("resolveSessionForIncomingPhoto.miss", { userId }, traceId);
  return null;
}

async function getPackFlowSessionById(userId: string, sessionId?: string | null) {
  if (!sessionId) return null;
  const { data } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .in("state", PACK_FLOW_STATES_FOR_QUERY)
    .maybeSingle();
  return data;
}

function parseCallbackSessionRef(raw?: string | null): { sessionId: string | null; rev: number | null } {
  if (!raw) return { sessionId: null, rev: null };
  const parts = raw.split(":");
  const sessionId = parts[0] || null;
  if (parts.length < 2) return { sessionId, rev: null };
  const maybeRev = Number(parts[parts.length - 1]);
  return Number.isInteger(maybeRev) && maybeRev > 0 ? { sessionId, rev: maybeRev } : { sessionId, rev: null };
}

/** Parse session_id from pack admin callback_data (e.g. "pack_admin_pack_save:uuid" → uuid). Used so Save/Cancel/Rework act on the session that holds the result. */
function parsePackAdminSessionId(callbackData?: string | null): string | null {
  if (!callbackData || typeof callbackData !== "string") return null;
  const parts = callbackData.split(":");
  return parts.length >= 2 && parts[1]?.trim() ? parts[1].trim() : null;
}

function formatCallbackSessionRef(sessionId?: string | null, sessionRev?: number | null): string | null {
  if (!sessionId) return null;
  const rev = Number(sessionRev);
  if (Number.isInteger(rev) && rev > 0) return `${sessionId}:${rev}`;
  return sessionId;
}

function appendSessionRefIfFits(baseCallbackData: string, sessionRef?: string | null): string {
  if (!sessionRef) return baseCallbackData;
  const withRef = `${baseCallbackData}:${sessionRef}`;
  // Telegram callback_data limit is 64 bytes.
  return withRef.length <= 64 ? withRef : baseCallbackData;
}

async function isStrictSessionRevEnabled(): Promise<boolean> {
  const value = await getAppConfig("strict_session_rev_enabled", "false");
  return String(value).toLowerCase() === "true";
}

async function isSessionRouterEnabled(): Promise<boolean> {
  const value = await getAppConfig("session_router_enabled", "false");
  return String(value).toLowerCase() === "true";
}

async function rejectSessionEvent(
  ctx: any,
  lang: string,
  event: string,
  reasonCode: "session_not_found" | "wrong_state" | "stale_callback"
) {
  const message =
    reasonCode === "session_not_found"
      ? (lang === "ru" ? "Сессия не найдена. Начни заново с нового действия." : "Session not found. Please start the action again.")
      : reasonCode === "stale_callback"
        ? (lang === "ru" ? "Кнопка устарела. Используй последнее сообщение." : "This button is stale. Please use the latest message.")
        : (lang === "ru" ? "Это действие сейчас недоступно." : "This action is unavailable right now.");
  console.warn("[session.reject]", { event, reasonCode, userId: ctx.from?.id, callbackData: (ctx.callbackQuery as any)?.data });
  await ctx.answerCbQuery(message, { show_alert: false }).catch(() => {});
}

async function getSessionByIdForUser(userId: string, sessionId?: string | null, traceId?: string | null) {
  if (!sessionId) return null;
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .maybeSingle();
  logSessionTrace("getSessionByIdForUser.result", {
    userId,
    sessionId,
    error: error?.message || null,
    session: sessionTraceSnapshot(data),
  }, traceId);
  return data;
}

async function getLatestAssistantFlowSession(userId: string) {
  const { data } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .eq("flow_kind", "assistant")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function resolveSessionForCallback(
  userId: string,
  explicitSessionId?: string | null,
  fallback?: () => Promise<any | null>,
  traceId?: string | null
) {
  logSessionTrace("resolveSessionForCallback.start", { userId, explicitSessionId: explicitSessionId || null }, traceId);
  if (explicitSessionId) {
    const session = await getSessionByIdForUser(userId, explicitSessionId, traceId);
    logSessionTrace("resolveSessionForCallback.pick_explicit", { userId, session: sessionTraceSnapshot(session) }, traceId);
    return session;
  }
  const routerEnabled = await isSessionRouterEnabled();
  if (routerEnabled) {
    logSessionTrace("resolveSessionForCallback.router_enabled_block", { userId }, traceId);
    return null;
  }
  if (fallback) {
    const session = await fallback();
    logSessionTrace("resolveSessionForCallback.pick_custom_fallback", { userId, session: sessionTraceSnapshot(session) }, traceId);
    return session;
  }
  const session = await getActiveSession(userId, traceId);
  logSessionTrace("resolveSessionForCallback.pick_active_default", { userId, session: sessionTraceSnapshot(session) }, traceId);
  return session;
}

async function rejectPackEvent(
  ctx: any,
  lang: string,
  event: string,
  reasonCode: "session_not_found" | "wrong_state" | "stale_callback"
) {
  const message =
    reasonCode === "session_not_found"
      ? (lang === "ru"
        ? "Сессия не найдена. Нажми «📦 Пак стикеров» и попробуй снова."
        : "Session not found. Tap “📦 Sticker pack” and try again.")
      : reasonCode === "stale_callback"
        ? (lang === "ru"
          ? "Кнопка устарела. Используй актуальное сообщение."
          : "This button is stale. Please use the latest message.")
        : (lang === "ru"
          ? "Это действие сейчас недоступно в текущем шаге."
          : "This action is not available in the current step.");
  console.warn("[pack.reject]", { event, reasonCode, userId: ctx.from?.id, callbackData: (ctx.callbackQuery as any)?.data });
  await ctx.answerCbQuery(message, { show_alert: true }).catch(() => {});
}

async function callTelegramBotMethodOrThrow(method: string, payload: Record<string, unknown>) {
  const res = await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, payload, { timeout: 15000 });
  if (!res.data?.ok) {
    const description = res.data?.description || `${method} failed`;
    const error: any = new Error(description);
    error.response = { data: res.data };
    throw error;
  }
  return res.data?.result;
}

async function getStickerSetSnapshot(name: string): Promise<{ count: number; hasFileId: (fileId: string) => boolean } | null> {
  try {
    const res = await axios.get(`https://api.telegram.org/bot${config.telegramBotToken}/getStickerSet`, {
      params: { name },
      timeout: 15000,
    });
    if (!res.data?.ok) return null;
    const stickers = Array.isArray(res.data?.result?.stickers) ? res.data.result.stickers : [];
    return {
      count: stickers.length,
      hasFileId: (fileId: string) => stickers.some((s: any) => s?.file_id === fileId),
    };
  } catch {
    return null;
  }
}

async function waitForStickerInSet(
  name: string,
  fileId: string,
  beforeCount: number | null
): Promise<{ ok: boolean; count: number | null; matchedBy: "file_id" | "count" | null }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const snap = await getStickerSetSnapshot(name);
    if (snap) {
      if (snap.hasFileId(fileId)) {
        return { ok: true, count: snap.count, matchedBy: "file_id" };
      }
      if (beforeCount !== null && snap.count > beforeCount) {
        return { ok: true, count: snap.count, matchedBy: "count" };
      }
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  const finalSnap = await getStickerSetSnapshot(name);
  return { ok: false, count: finalSnap?.count ?? null, matchedBy: null };
}

type PackUiLockStage = "preview" | "assemble";

async function lockPackUiForProcessing(ctx: any, session: any, lang: string, stage: PackUiLockStage) {
  const callbackMsgId = (ctx.callbackQuery as any)?.message?.message_id as number | undefined;
  const callbackChatId = (ctx.callbackQuery as any)?.message?.chat?.id as number | undefined;
  const targetMessageId = callbackMsgId || session?.ui_message_id || session?.progress_message_id;
  const targetChatId = callbackChatId || session?.ui_chat_id || session?.progress_chat_id;
  if (!targetMessageId || !targetChatId) return;

  const lockText = stage === "preview"
    ? (lang === "ru" ? "⏳ Генерирую превью..." : "⏳ Generating preview...")
    : (lang === "ru" ? "⏳ Собираю стикерпак..." : "⏳ Assembling sticker pack...");

  try {
    await ctx.telegram.editMessageReplyMarkup(targetChatId, targetMessageId, undefined, {
      inline_keyboard: [[{ text: lockText, callback_data: "noop" }]],
    });
  } catch (err: any) {
    console.warn("[pack.ui_lock] Failed to lock keyboard:", err?.message || err);
  }

  const { error } = await supabase
    .from("sessions")
    .update({
      ui_message_id: targetMessageId,
      ui_chat_id: targetChatId,
    })
    .eq("id", session.id);
  if (error) {
    console.warn("[pack.ui_lock] Failed to persist ui refs:", error.message);
  }
}

async function resolvePackSessionForEvent(
  userId: string,
  expectedStates: string[],
  explicitSessionId?: string | null
): Promise<{ session: any | null; reasonCode?: "session_not_found" | "wrong_state" }> {
  const routerEnabled = await isSessionRouterEnabled();
  const session = explicitSessionId
    ? await getPackFlowSessionById(userId, explicitSessionId)
    : (routerEnabled ? null : await getPackFlowSession(userId));
  if (!session) return { session: null, reasonCode: "session_not_found" };
  if (!expectedStates.includes(session.state)) return { session, reasonCode: "wrong_state" };
  return { session };
}

/** Get session for style selection (wait_style or wait_pack_preview_payment). Prefers pack session when active is assistant. */
async function getSessionForStyleSelection(userId: string) {
  const styleStates = ["wait_style", "wait_pack_preview_payment"];
  const session = await getActiveSession(userId);
  if (session && styleStates.includes(session.state)) {
    return session;
  }

  // Fallback for DB setups where is_active may be unreliable:
  // explicitly pick the latest session in style-selection states.
  const { data: latestStyleSession } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .in("state", styleStates)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestStyleSession) {
    return latestStyleSession;
  }

  // Final fallback for pack flow.
  const packSession = await getPackFlowSession(userId);
  if (packSession?.state === "wait_pack_preview_payment") {
    return packSession;
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
        if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang, ctx?.from?.id));
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
        if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang, ctx?.from?.id));
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
      if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang, ctx?.from?.id));
    }
  }
}

// Helper: send buy credits menu
async function sendBuyCreditsMenu(ctx: any, user: any, messageText?: string) {
  const lang = user.lang || "en";
  const existingPhoto = user.last_photo_file_id || null;
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
    const totalCredits = getPackTotalCredits(pack);
    buttons.push([
      Markup.button.callback(
        `${label}: ${totalCredits} ${unit} — ${pack.price}⭐ (${pack.price_rub}₽)`,
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

// Helper: parse start payload into UTM fields + yclid
// Format: source_medium_campaign_content_yclid
// yclid detection: last segment, fully numeric, length > 8
function parseStartPayload(payload: string): {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  yclid: string | null;
} {
  if (!payload) return { source: null, medium: null, campaign: null, content: null, yclid: null };

  const parts = payload.split("_");
  const knownSources = ["ya", "yandex", "gads", "google", "fb", "ig", "vk", "tg", "web"];
  const knownMediums = ["cpc", "cpm", "organic", "social", "referral"];

  if (parts.length >= 2 && knownSources.includes(parts[0]) && knownMediums.includes(parts[1])) {
    // Detect yclid: last segment, fully numeric, length > 8
    let yclid: string | null = null;
    const lastPart = parts[parts.length - 1];
    if (parts.length >= 3 && /^\d{9,}$/.test(lastPart)) {
      yclid = lastPart;
      parts.pop();
    }

    return {
      source: parts[0],
      medium: parts[1],
      campaign: parts[2] || null,
      content: parts[3] || null,
      yclid,
    };
  }

  return { source: payload, medium: null, campaign: null, content: null, yclid: null };
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
      getGeminiGenerateContentUrl("gemini-2.0-flash"),
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
  await ctx.reply(greetingText, getMainMenuKeyboard(lang, ctx?.from?.id));

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

  const startPayload = getStartPayload(ctx);
  const rawText = ctx.message?.text ?? "";
  console.log("[start] telegramId:", telegramId, "raw message length:", rawText.length, "payload length:", startPayload?.length ?? 0, "payload preview:", startPayload ? startPayload.slice(0, 50) + (startPayload.length > 50 ? "..." : "") : "(empty)");

  let user = await getUser(telegramId);
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    const languageCode = ctx.from?.language_code || "";
    const lang = languageCode.toLowerCase().startsWith("ru") ? "ru" : "en";
    console.log("[locale] New user", { telegramId, language_code: languageCode || "(empty)", resolved_lang: lang });

    const utm = parseStartPayload(startPayload);
    if (startPayload) {
      console.log("[start] New user - parsed utm:", JSON.stringify(utm));
    }

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
        yclid: utm.yclid,
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
    console.log("[locale] Returning user", {
      telegramId,
      db_lang: user.lang ?? "(null)",
      db_language_code: user.language_code ?? "(null)",
      telegram_language_code: currentLangCode || "(empty)",
      resolved_lang: currentLang,
    });
    const updates: Record<string, any> = {};

    if (user.username !== currentUsername) updates.username = currentUsername;
    // Не перезаписываем lang у returning user по telegram — язык уже выбран при регистрации/ранее; только сохраняем language_code для аналитики.
    if (user.language_code !== currentLangCode) updates.language_code = currentLangCode || null;

    // Update UTM + yclid for returning users if they came via a new start link
    if (startPayload) {
      const utm = parseStartPayload(startPayload);
      console.log("[start] Returning user - parsed utm:", JSON.stringify(utm), "current user.utm_source:", user.utm_source, "user.yclid:", user.yclid ? "set" : "empty");
      if (!user.utm_source && utm.source) {
        updates.start_payload = startPayload;
        updates.utm_source = utm.source;
        updates.utm_medium = utm.medium;
        updates.utm_campaign = utm.campaign;
        updates.utm_content = utm.content;
      }
      // First-click: сохраняем yclid только если ещё не был записан
      if (utm.yclid && !user.yclid) {
        updates.yclid = utm.yclid;
      }
    }

    if (Object.keys(updates).length > 0) {
      console.log("[start] Returning user - applying updates:", Object.keys(updates));
      const { error: updateErr } = await supabase.from("users").update(updates).eq("id", user.id);
      if (updateErr) console.error("[start] User update error:", updateErr);
      else Object.assign(user, updates);
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
        await ctx.reply(text, getMainMenuKeyboard(lang, ctx?.from?.id));
        return;
      }
    }

    // Default entrypoint: action menu flow (wait_photo or wait_action + sendActionMenu)
    const lastPhotoFromSessions = await getLatestSessionPhotoFileId(user.id);
    const existingPhoto = lastPhotoFromSessions || user.last_photo_file_id || null;
    if (lastPhotoFromSessions && !user.last_photo_file_id) {
      await supabase.from("users").update({ last_photo_file_id: lastPhotoFromSessions }).eq("id", user.id);
      user.last_photo_file_id = lastPhotoFromSessions;
    }

    const activeAssistant = await getActiveAssistantSession(user.id);
    if (activeAssistant) {
      await updateAssistantSession(activeAssistant.id, { status: "completed" });
    }
    await supabase.from("sessions").update({ is_active: false }).eq("user_id", user.id).eq("is_active", true).eq("env", config.appEnv);

    if (!existingPhoto) {
      const { data: newSession, error: sessErr } = await supabase
        .from("sessions")
        .insert({
          user_id: user.id,
          state: "wait_photo",
          is_active: true,
          flow_kind: "single",
          session_rev: 1,
          env: config.appEnv,
        })
        .select()
        .single();
      if (sessErr || !newSession) {
        await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
        return;
      }
      const greetingText = isNewUser
        ? await getText(lang, "start.greeting_new")
        : await getText(lang, "start.greeting_return", { credits: String(user.credits || 0) });
      await ctx.reply(greetingText, getMainMenuKeyboard(lang, ctx?.from?.id));
      return;
    }

    const { data: newSession, error: sessErr } = await supabase
      .from("sessions")
      .insert({
        user_id: user.id,
        state: "wait_action",
        is_active: true,
        flow_kind: "single",
        session_rev: 1,
        current_photo_file_id: existingPhoto,
        photos: [existingPhoto],
        env: config.appEnv,
      })
      .select()
      .single();
    if (sessErr || !newSession) {
      await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
      return;
    }
    await ctx.reply(lang === "ru" ? "⚡ Открываю действия..." : "⚡ Opening actions...", getMainMenuKeyboard(lang, ctx?.from?.id));
    await sendActionMenu(ctx, lang, newSession.id, newSession.session_rev || 1);
  } else {
    const lang = "en";
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
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
  await ctx.reply(text, getMainMenuKeyboard(lang, ctx?.from?.id));
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
  const sessionCurrent = session?.current_photo_file_id || null;
  const sessionPhotos = Array.isArray(session?.photos) ? session.photos : [];
  const sessionLast = sessionPhotos.length > 0 ? sessionPhotos[sessionPhotos.length - 1] : null;
  return sessionCurrent || sessionLast || user?.last_photo_file_id || null;
}

/**
 * Resolve authoritative "working photo" for any flow.
 * Priority: session.current_photo_file_id -> session.photos[last] -> user.last_photo_file_id.
 */
function resolveWorkingPhoto(session: any, user: any): { hasWorkingPhoto: boolean; workingPhotoFileId: string | null } {
  const sessionCurrent = session?.current_photo_file_id || null;
  const sessionPhotos = Array.isArray(session?.photos) ? session.photos : [];
  const sessionLast = sessionPhotos.length > 0 ? sessionPhotos[sessionPhotos.length - 1] : null;
  const workingPhotoFileId = sessionCurrent || sessionLast || user?.last_photo_file_id || null;
  return {
    hasWorkingPhoto: !!workingPhotoFileId,
    workingPhotoFileId,
  };
}

/**
 * Latest known photo for the user from recent sessions.
 * Used as a fallback source-of-truth when users.last_photo_file_id lags behind.
 */
async function getLatestSessionPhotoFileId(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("sessions")
    .select("id, state, current_photo_file_id, photos, updated_at")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(12);
  if (error) {
    console.warn("[photo_source] getLatestSessionPhotoFileId query error:", error.message);
    return null;
  }
  const rows = Array.isArray(data) ? data : [];
  for (const row of rows) {
    const current = row?.current_photo_file_id || null;
    const photos = Array.isArray(row?.photos) ? row.photos : [];
    const tail = photos.length > 0 ? photos[photos.length - 1] : null;
    const candidate = current || tail;
    if (candidate) {
      console.log("[photo_source] latest session photo selected", {
        userId,
        sessionId: row?.id ?? null,
        sessionState: row?.state ?? null,
        source: current ? "current_photo_file_id" : "photos_tail",
      });
      return candidate;
    }
  }
  return null;
}

// Photo handler
bot.on("photo", async (ctx) => {
  const traceId = getOrCreateTraceId(ctx);
  const telegramId = ctx.from?.id;
  console.log("Photo received, telegramId:", telegramId);
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const photo = ctx.message.photo?.[ctx.message.photo.length - 1];
  if (!photo) return;
  const previousLastPhotoFileId = user.last_photo_file_id || null;
  logSessionTrace("photo.incoming", {
    telegramId,
    userId: user.id,
    previousLastPhotoExists: Boolean(previousLastPhotoFileId),
  }, traceId);
  const session = await resolveSessionForIncomingPhoto(user.id, traceId);
  console.log("Photo handler - session:", session?.id, "state:", session?.state);
  logSessionTrace("photo.resolved_session", { userId: user.id, session: sessionTraceSnapshot(session) }, traceId);
  if (!session?.id) {
    console.warn("Photo handler: no session found, creating recovery wait_action session");
    logSessionTrace("photo.recovery.no_session", { userId: user.id, previousLastPhotoExists: Boolean(previousLastPhotoFileId) }, traceId);
    await supabase
      .from("sessions")
      .update({ is_active: false })
      .eq("user_id", user.id)
      .eq("env", config.appEnv)
      .eq("is_active", true);

    // Save last photo on user for reuse across sessions
    const { error: lastPhotoErr } = await supabase.from("users")
      .update({ last_photo_file_id: photo.file_id })
      .eq("id", user.id);
    if (lastPhotoErr) {
      console.error("Failed to update last_photo_file_id (recovery):", lastPhotoErr.message);
    } else {
      console.log("last_photo_file_id updated for user (recovery):", user.id);
    }

    if (previousLastPhotoFileId && previousLastPhotoFileId !== photo.file_id) {
      // Preserve choose-new-or-keep flow when we still know the previous photo.
      const { data: recoverySession, error: sessErr } = await supabase
        .from("sessions")
        .insert({
          user_id: user.id,
          state: "wait_action",
          is_active: true,
          flow_kind: "single",
          session_rev: 1,
          current_photo_file_id: previousLastPhotoFileId,
          pending_photo_file_id: photo.file_id,
          photos: [previousLastPhotoFileId, photo.file_id],
          env: config.appEnv,
        })
        .select("*")
        .single();
      if (sessErr || !recoverySession?.id) {
        console.error("Photo recovery session create failed:", sessErr?.message);
        logSessionTrace("photo.recovery.create_confirm_failed", { userId: user.id, error: sessErr?.message || null }, traceId);
        await ctx.reply(await getText(lang, "error.technical"));
        return;
      }
      logSessionTrace("photo.recovery.create_confirm_ok", {
        userId: user.id,
        session: sessionTraceSnapshot(recoverySession),
      }, traceId);
      const sessionRef = formatCallbackSessionRef(recoverySession.id, recoverySession.session_rev);
      await ctx.reply(
        lang === "ru"
          ? "Вижу новое фото! С каким продолжаем работу?"
          : "I see a new photo! Which one should we use?",
        Markup.inlineKeyboard([
          [Markup.button.callback(lang === "ru" ? "✅ Новое фото" : "✅ New photo", appendSessionRefIfFits("single_new_photo", sessionRef))],
          [Markup.button.callback(lang === "ru" ? "❌ Оставить текущее" : "❌ Keep current", appendSessionRefIfFits("single_keep_photo", sessionRef))],
        ])
      );
      return;
    }

    const { data: recoverySession, error: sessErr } = await supabase
      .from("sessions")
      .insert({
        user_id: user.id,
        state: "wait_action",
        is_active: true,
        flow_kind: "single",
        session_rev: 1,
        current_photo_file_id: photo.file_id,
        photos: [photo.file_id],
        env: config.appEnv,
      })
      .select("*")
      .single();
    if (sessErr || !recoverySession?.id) {
      console.error("Photo recovery action session create failed:", sessErr?.message);
      logSessionTrace("photo.recovery.create_action_failed", { userId: user.id, error: sessErr?.message || null }, traceId);
      await ctx.reply(await getText(lang, "error.technical"));
      return;
    }
    logSessionTrace("photo.recovery.create_action_ok", {
      userId: user.id,
      session: sessionTraceSnapshot(recoverySession),
    }, traceId);
    await sendActionMenu(ctx, lang, recoverySession.id, recoverySession.session_rev || 1);
    return;
  }

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
  const packStatesForReactivation = [
    "wait_pack_photo",
    "wait_pack_carousel",
    "wait_pack_preview_payment",
    "wait_pack_generate_request",
    "wait_pack_approval",
    "wait_pack_rework_feedback",
    "generating_pack_preview",
    "generating_pack_theme",
    "processing_pack",
  ];
  if (packStatesForReactivation.includes(String(session.state || "")) && !session.is_active) {
    console.log("Pack photo: reactivating fallback session:", session.id);
    logSessionTrace("photo.pack.reactivate", { userId: user.id, session: sessionTraceSnapshot(session) }, traceId);
    await supabase.from("sessions").update({ is_active: true }).eq("id", session.id);
    session.is_active = true;
  }

  sendAlert({
    type: "photo_uploaded",
    message: "User uploaded photo",
    details: {
      user: `@${user.username || user.telegram_id}`,
      sessionId: session.id,
      state: session.state,
    },
    photoFileId: photo.file_id,
  }).catch(console.error);

  // === AI Assistant: re-route to assistant_wait_photo if assistant is active after generation ===
  // Skip re-route for pack flow, replace-face flow — they handle photos independently
  const skipAssistantRerouteStates = [
    "processing", "processing_emotion", "processing_motion", "processing_text",
    "generating_pack_preview", "generating_pack_theme", "processing_pack",
    "wait_replace_face", "wait_replace_face_sticker", "wait_edit_photo",
  ];
  if (!session.state?.startsWith("assistant_") && !session.state?.startsWith("wait_pack_") && !skipAssistantRerouteStates.includes(String(session.state || ""))) {
    const activeAssistant = await getActiveAssistantSession(user.id);
    if (activeAssistant && activeAssistant.status === "active") {
      console.log("Assistant photo re-route: state was", session.state, "→ switching to assistant_wait_photo");
      logSessionTrace("photo.reroute_to_assistant_wait_photo", {
        userId: user.id,
        from: sessionTraceSnapshot(session),
        assistantSessionId: activeAssistant.id,
      }, traceId);
      await supabase.from("sessions")
        .update({ state: "assistant_wait_photo", is_active: true })
        .eq("id", session.id);
      session.state = "assistant_wait_photo";
      session.is_active = true;
    }
  }

  // === Replace-face flow: waiting for identity photo (and optionally sticker) ===
  if (["wait_replace_face", "wait_edit_photo", "wait_replace_face_sticker"].includes(String(session.state || ""))) {
    const stickerId = session.edit_replace_sticker_id || null;
    if (!stickerId) {
      const photos = Array.isArray(session.photos) ? session.photos : [];
      photos.push(photo.file_id);
      const nextRev = (session.session_rev || 1) + 1;
      await supabase
        .from("sessions")
        .update({
          state: "wait_replace_face_sticker",
          photos,
          current_photo_file_id: photo.file_id,
          flow_kind: "single",
          is_active: true,
          session_rev: nextRev,
        })
        .eq("id", session.id);
      logSessionTrace("photo.wait_replace_face.need_sticker", {
        userId: user.id,
        sessionId: session.id,
        nextRev,
      }, traceId);
      await ctx.reply(await getText(lang, "action.replace_face_send_sticker"));
      return;
    }

    const { data: sticker } = await supabase
      .from("stickers")
      .select("telegram_file_id, style_preset_id")
      .eq("id", stickerId)
      .maybeSingle();

    if (!sticker?.telegram_file_id) {
      await ctx.reply(await getText(lang, "error.no_stickers_added"));
      return;
    }

    const photos = Array.isArray(session.photos) ? session.photos : [];
    photos.push(photo.file_id);
    const nextRev = (session.session_rev || 1) + 1;

    await supabase
      .from("sessions")
      .update({
        photos,
        current_photo_file_id: photo.file_id,
        last_sticker_file_id: sticker.telegram_file_id,
        edit_replace_sticker_id: stickerId,
        selected_style_id: sticker.style_preset_id || session.selected_style_id || null,
        is_active: true,
        session_rev: nextRev,
      })
      .eq("id", session.id);

    const { data: freshSession } = await supabase
      .from("sessions")
      .select("*")
      .eq("id", session.id)
      .maybeSingle();
    const patchedSession = freshSession || {
      ...session,
      current_photo_file_id: photo.file_id,
      last_sticker_file_id: sticker.telegram_file_id,
      selected_style_id: sticker.style_preset_id || session.selected_style_id || null,
      session_rev: nextRev,
    };

    const replacePrompt =
      "You are given two references: (1) identity photo, (2) sticker reference. " +
      "Generate one sticker with identity from photo and pose/expression/style from sticker reference. " +
      "Keep one subject only, preserve the same vibe and composition, no text, no borders or outlines.";

    const earlyMsgId = await sendEarlyProgress(ctx, lang);
    await startGeneration(ctx, user, patchedSession, lang, {
      generationType: "replace_subject",
      promptFinal: replacePrompt,
      selectedStyleId: sticker.style_preset_id || session.selected_style_id || null,
      userInput: lang === "ru" ? "Замена лица в стикере" : "Replace face in sticker",
      earlyProgressMessageId: earlyMsgId,
    });
    return;
  }

  // === wait_action: new photo — update and show action menu again ===
  if (session.state === "wait_action") {
    const photos = Array.isArray(session.photos) ? session.photos : [];
    photos.push(photo.file_id);
    const nextRev = (session.session_rev || 1) + 1;
    await supabase
      .from("sessions")
      .update({
        photos,
        current_photo_file_id: photo.file_id,
        is_active: true,
        session_rev: nextRev,
      })
      .eq("id", session.id);
    logSessionTrace("photo.wait_action.updated", {
      userId: user.id,
      sessionId: session.id,
      toState: "wait_action",
      nextRev,
      flow: detectSessionFlow(session),
    }, traceId);
    void ensureSubjectProfileForGeneration(
      { ...session, current_photo_file_id: photo.file_id, photos },
      "style"
    ).catch((err) => console.warn("[wait_action] subject profile failed:", err?.message || err));
    await sendActionMenu(ctx, lang, session.id, nextRev);
    return;
  }

  // === Global replacement photo router (all user flows) ===
  // Rule: if a working photo already exists in the current flow, ask whether to use new or keep current.
  const hardProcessingStates = [
    "processing",
    "processing_emotion",
    "processing_motion",
    "processing_text",
    "generating_pack_preview",
    "processing_pack",
  ];
  const { hasWorkingPhoto, workingPhotoFileId } = resolveWorkingPhoto(session, user);
  const isHardProcessing = hardProcessingStates.includes(String(session.state || ""));
  if (hasWorkingPhoto && !isHardProcessing) {
    const flowType =
      session.state?.startsWith("assistant_")
        ? "assistant"
        : (
            session.state?.startsWith("wait_pack_")
            || ["generating_pack_preview", "generating_pack_theme", "processing_pack"].includes(String(session.state || ""))
          )
          ? "pack"
          : "single";
    const flowLabel = flowType === "assistant"
      ? (lang === "ru" ? "стикером" : "sticker")
      : flowType === "pack"
      ? (lang === "ru" ? "паком" : "pack")
      : (lang === "ru" ? "стикером" : "sticker");
    const nextPhotos = [...(Array.isArray(session.photos) ? session.photos : []), photo.file_id];
    const nextRev = (session.session_rev || 1) + 1;
    await supabase
      .from("sessions")
      .update({
        photos: nextPhotos,
        current_photo_file_id: session.current_photo_file_id || workingPhotoFileId,
        pending_photo_file_id: photo.file_id,
        is_active: true,
        session_rev: nextRev,
      })
      .eq("id", session.id);
    logSessionTrace("photo.pending_photo_prompted", {
      userId: user.id,
      sessionId: session.id,
      flowType,
      previousWorkingPhotoExists: Boolean(workingPhotoFileId),
      nextRev,
    }, traceId);
    session.photos = nextPhotos;
    session.pending_photo_file_id = photo.file_id;
    session.session_rev = nextRev;

    if (flowType === "assistant") {
      const aSession = await getActiveAssistantSession(user.id);
      if (aSession) await updateAssistantSession(aSession.id, { pending_photo_file_id: photo.file_id });
    }

    const sessionRef = formatCallbackSessionRef(session.id, session.session_rev);
    const newCb = flowType === "assistant"
      ? appendSessionRefIfFits("assistant_new_photo", sessionRef)
      : flowType === "pack"
      ? appendSessionRefIfFits("pack_new_photo", sessionRef)
      : appendSessionRefIfFits("single_new_photo", sessionRef);
    const keepCb = flowType === "assistant"
      ? appendSessionRefIfFits("assistant_keep_photo", sessionRef)
      : flowType === "pack"
      ? appendSessionRefIfFits("pack_keep_photo", sessionRef)
      : appendSessionRefIfFits("single_keep_photo", sessionRef);

    await ctx.reply(
      lang === "ru"
        ? `Вижу новое фото! С каким продолжаем работу над ${flowLabel}?`
        : `I see a new photo! Which one should we use for the ${flowLabel}?`,
      Markup.inlineKeyboard([
        [Markup.button.callback(lang === "ru" ? "✅ Новое фото" : "✅ New photo", newCb)],
        [Markup.button.callback(lang === "ru" ? "❌ Оставить текущее" : "❌ Keep current", keepCb)],
      ])
    );
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

      if (shouldResumeAssistantChatAfterPhoto(aSession)) {
        console.log("Assistant photo: returning to requirements collection (assistant_chat)");
        await supabase
          .from("sessions")
          .update({
            photos,
            current_photo_file_id: photo.file_id,
            state: "assistant_chat",
            is_active: true,
            flow_kind: "assistant",
            session_rev: (session.session_rev || 1) + 1,
          })
          .eq("id", session.id);

        const messages: AssistantMessage[] = Array.isArray(aSession.messages) ? [...aSession.messages] : [];
        messages.push({ role: "user", content: "[User sent a photo]" });
        const replyText = generateFallbackReply("normal", aSession, lang);
        messages.push({ role: "assistant", content: replyText });
        await updateAssistantSession(aSession.id, { messages, pending_photo_file_id: null });
        await ctx.reply(replyText, getMainMenuKeyboard(lang, ctx?.from?.id));
        return;
      }

    // Initial assistant flow without enough dialog context:
    // show style selection after photo.
    console.log("Assistant photo: showing style selection");

    const step1Rev = (session.session_rev || 1) + 1;
    const { error: updateErr1 } = await supabase
      .from("sessions")
      .update({
        photos,
        current_photo_file_id: photo.file_id,
        state: "wait_style",
        style_source_kind: "photo",
        is_active: true,
        session_rev: step1Rev,
      })
      .eq("id", session.id);
    if (updateErr1) console.error("[assistant_photo] session update error:", updateErr1.message);

    void ensureSubjectProfileForGeneration(
      { ...session, current_photo_file_id: photo.file_id, photos },
      "style"
    ).catch((err) => console.warn("[assistant_photo] subject profile failed:", err?.message || err));

    await sendStyleKeyboardFlat(ctx, lang, undefined, { selectedStyleId: session.selected_style_id || null });
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

      void ensureSubjectProfileForGeneration(
        { ...newSession, current_photo_file_id: photo.file_id, photos },
        "style"
      ).catch((err) => console.warn("[assistant_wait_photo] subject profile failed:", err?.message || err));

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
          if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang, ctx?.from?.id));
        } catch (err: any) {
          console.error("[AvatarDemo] Assistant AI error:", err.message);
          const fallback = lang === "ru"
            ? "Отличное фото! Опиши стиль стикера (например: аниме, мультяшный, минимализм)"
            : "Great photo! Describe the sticker style (e.g.: anime, cartoon, minimal)";
          await ctx.reply(fallback, getMainMenuKeyboard(lang, ctx?.from?.id));
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
        flow_kind: "pack",
        session_rev: (session.session_rev || 1) + 1,
      })
      .eq("id", session.id);

    // Run subject (gender) detection on upload so subject_gender is in DB before carousel/generation
    void ensureSubjectProfileForGeneration(
      { ...session, current_photo_file_id: photo.file_id, photos: packPhotos },
      "style"
    ).catch((err) => console.warn("[pack_photo] subject profile on upload failed:", err?.message || err));

    // Send style selector (pack flow: always show Back to poses)
    await sendPackStyleSelectionStep(ctx, lang, session.selected_style_id, undefined, { useBackButton: true, sessionId: session.id });
    return;
  }

  // === Pack flow: new photo during style/payment or approval step ===
  // Keep the current pack flow and ask which photo to use.
  if (session.state === "wait_pack_preview_payment" || session.state === "wait_pack_approval") {
    const packPhotos = Array.isArray(session.photos) ? session.photos : [];
    const sessionRef = formatCallbackSessionRef(session.id, session.session_rev);
    await supabase
      .from("sessions")
      .update({
        photos: [...packPhotos, photo.file_id],
        pending_photo_file_id: photo.file_id,
        is_active: true,
      })
      .eq("id", session.id);

    await ctx.reply(
      lang === "ru"
        ? "Вижу новое фото! С каким продолжаем пак?"
        : "I see a new photo! Which one should we use for the pack?",
      Markup.inlineKeyboard([
        [Markup.button.callback(
          lang === "ru" ? "✅ Новое фото" : "✅ New photo",
          appendSessionRefIfFits("pack_new_photo", sessionRef)
        )],
        [Markup.button.callback(
          lang === "ru" ? "❌ Оставить текущее" : "❌ Keep current",
          appendSessionRefIfFits("pack_keep_photo", sessionRef)
        )],
      ])
    );
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
          style_source_kind: "photo",
        })
        .eq("id", session.id);
      if (upErr) console.error("Valentine photo update error:", upErr);
      await ctx.reply(await getText(lang, "photo.processing"));
      const userInput = preset.prompt_hint;
      const promptResult = await generatePrompt(userInput);
      const generatedPrompt = promptResult.ok && !promptResult.retry ? promptResult.prompt || userInput : userInput;
      Object.assign(session, {
        photos,
        current_photo_file_id: photo.file_id,
        state: "wait_style",
        style_source_kind: "photo",
        selected_style_id: preset.id,
      });
      await startGeneration(ctx, user, session, lang, {
        generationType: "style",
        promptFinal: generatedPrompt,
        styleSourceKind: "photo",
        userInput,
        selectedStyleId: preset.id,
      });
      return;
    }
  }

  const { error } = await supabase
    .from("sessions")
    .update({ photos, state: "wait_action", is_active: true, current_photo_file_id: photo.file_id, style_source_kind: "photo" })
    .eq("id", session.id);
  if (error) {
    console.error("Failed to update session to wait_action:", error);
  }

  // Run subject (gender) detection on upload so subject_gender is in DB before style selection
  void ensureSubjectProfileForGeneration(
    { ...session, current_photo_file_id: photo.file_id, photos },
    "style"
  ).catch((err) => console.warn("[single_photo] subject profile on upload failed:", err?.message || err));

  const nextRev = (session.session_rev || 1) + 1;
  await supabase.from("sessions").update({ session_rev: nextRev }).eq("id", session.id);
  await sendActionMenu(ctx, lang, session.id, nextRev);
});

// ============================================
// Persistent menu handlers (Reply Keyboard)
// ============================================

// Menu: ⚡ Действия / ⚡ Actions — open action menu for latest photo
bot.hears(["⚡ Действия", "⚡ Actions"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }

  const lang = user.lang || "en";
  const lastPhotoFromSessions = await getLatestSessionPhotoFileId(user.id);
  const existingPhoto = lastPhotoFromSessions || user.last_photo_file_id || null;
  if (lastPhotoFromSessions && !user.last_photo_file_id) {
    await supabase.from("users").update({ last_photo_file_id: lastPhotoFromSessions }).eq("id", user.id);
    user.last_photo_file_id = lastPhotoFromSessions;
  }

  const activeAssistant = await getActiveAssistantSession(user.id);
  if (activeAssistant) {
    await updateAssistantSession(activeAssistant.id, { status: "completed" });
  }
  await supabase.from("sessions").update({ is_active: false }).eq("user_id", user.id).eq("is_active", true).eq("env", config.appEnv);

  if (!existingPhoto) {
    const { data: newSession, error: sessErr } = await supabase
      .from("sessions")
      .insert({
        user_id: user.id,
        state: "wait_photo",
        is_active: true,
        flow_kind: "single",
        session_rev: 1,
        env: config.appEnv,
      })
      .select()
      .single();
    if (sessErr || !newSession) {
      await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
      return;
    }
    await ctx.reply(await getText(lang, "photo.need_photo"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }

  const { data: newSession, error: sessErr } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      state: "wait_action",
      is_active: true,
      flow_kind: "single",
      session_rev: 1,
      current_photo_file_id: existingPhoto,
      photos: [existingPhoto],
      env: config.appEnv,
    })
    .select()
    .single();
  if (sessErr || !newSession) {
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }

  await sendActionMenu(ctx, lang, newSession.id, newSession.session_rev || 1);
});

// Menu: ✨ Создать стикер — launch or continue AI assistant dialog
bot.hears(["✨ Создать стикер", "✨ Create sticker"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }

  const lang = user.lang || "en";

  // Always start a fresh assistant dialog.
  // startAssistantDialog cancels all previous sessions before creating a new one.
  await startAssistantDialog(ctx, user, lang);
});

// Menu: 🎨 Изменить стикер — separate flow for editing an existing sticker
bot.hears(["🎨 Изменить стикер", "🎨 Edit sticker"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }

  const lang = user.lang || "en";
  // Edit flow must start from a single source of truth session.
  // Deactivate all active sessions to avoid picking pack/assistant session in routers.
  await supabase
    .from("sessions")
    .update({ is_active: false })
    .eq("user_id", user.id)
    .eq("env", config.appEnv)
    .eq("is_active", true);
  await closeAllActiveAssistantSessions(user.id, "abandoned");

  const { data: session, error } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      state: "wait_edit_sticker",
      flow_kind: "single",
      is_active: true,
      session_rev: 1,
      env: config.appEnv,
    })
    .select("*")
    .single();

  if (error || !session?.id) {
    console.error("edit_sticker: failed to create session:", error?.message);
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }

  await ctx.reply(await getText(lang, "edit.send_sticker"), getMainMenuKeyboard(lang, ctx?.from?.id));
});

// Menu: 🎨 Стили — manual style selection mode
bot.hears(["🎨 Стили", "🎨 Styles"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"), getMainMenuKeyboard(lang, ctx?.from?.id));
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
    await ctx.reply(await getText(lang, "photo.need_photo"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }

  // Always set state to wait_style + copy photo if needed
  const sessionUpdate: any = { state: "wait_style", is_active: true, style_source_kind: "photo" };
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

// Menu: 💰 Ваш баланс — show balance + credit packs
bot.hears(["💰 Ваш баланс", "💰 Your balance"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  const fastLang = isRu ? "ru" : "en";
  const userPromise = getUser(telegramId);
  const openingMsg = await ctx.reply(
    isRu ? "💰 Открываю баланс..." : "💰 Opening balance...",
    getMainMenuKeyboard(fastLang, ctx?.from?.id)
  ).catch(() => null);

  const user = await userPromise;
  if (!user) {
    await ctx.reply(await getText(fastLang, "start.need_start"), getMainMenuKeyboard(fastLang, ctx?.from?.id));
    return;
  }

  if (openingMsg?.message_id) {
    await ctx.deleteMessage(openingMsg.message_id).catch(() => {});
  }
  await sendBuyCreditsMenu(ctx, user);
});

// Menu: 💬 Поддержка
bot.hears(["💬 Поддержка", "💬 Support"], async (ctx) => {
  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  const lang = isRu ? "ru" : "en";
  const helpText = isRu
    ? "📷 Отправь фото — получи стикер\n💰 Каждый стикер = 1 кредит\n🎨 Выбирай стили и эмоции\n\nВопросы? @p2s_support_bot"
    : "📷 Send photo — get sticker\n💰 Each sticker = 1 credit\n🎨 Choose styles and emotions\n\nQuestions? @p2s_support_bot";
  await ctx.reply(helpText, getMainMenuKeyboard(lang, ctx?.from?.id));
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
  options?: { useBackButton?: boolean; sessionId?: string | null }
) {
  const stylePrompt = await getPackStylePrompt(lang, selectedStyleId);
  const previewBtn = await getText(lang, "btn.preview_pack");
  const backBtn = await getText(lang, "pack.back_to_poses");
  const cancelBtn = await getText(lang, "btn.cancel_pack");

  let headerText = stylePrompt;
  const telegramId = ctx.from?.id;
  let targetSessionId: string | null = options?.sessionId || null;
  if (telegramId) {
    const user = await getUser(telegramId);
    if (user) {
      const session = options?.sessionId
        ? await getPackFlowSessionById(user.id, options.sessionId)
        : await getPackFlowSession(user.id);
      targetSessionId = session?.id || targetSessionId;
      const targetSessionRef = formatCallbackSessionRef(targetSessionId, session?.session_rev);
      if (session?.pack_content_set_id) {
        const { data: contentSet } = await supabase
          .from(config.packContentSetsTable)
          .select("name_ru, name_en")
          .eq("id", session.pack_content_set_id)
          .maybeSingle();
        if (contentSet) {
          const setName = lang === "ru" ? contentSet.name_ru : contentSet.name_en;
          headerText += "\n\n" + (await getText(lang, "pack.selected_set", { name: setName }));
        }
      }
      const bottomButton = options?.useBackButton
        ? [{ text: `◀️ ${backBtn}`, callback_data: targetSessionRef ? `pack_back_to_carousel:${targetSessionRef}` : "pack_back_to_carousel" }]
        : [{ text: cancelBtn, callback_data: targetSessionRef ? `pack_cancel:${targetSessionRef}` : "pack_cancel" }];

      return sendStyleKeyboardFlat(ctx, lang, messageId, {
        headerText,
        selectedStyleId: selectedStyleId ?? undefined,
        extraButtons: [
          [{ text: previewBtn, callback_data: targetSessionRef ? `pack_preview_pay:${targetSessionRef}` : "pack_preview_pay" }],
          bottomButton,
        ],
      });
    }
  }

  const bottomButton = options?.useBackButton
    ? [{ text: `◀️ ${backBtn}`, callback_data: targetSessionId ? `pack_back_to_carousel:${targetSessionId}` : "pack_back_to_carousel" }]
    : [{ text: cancelBtn, callback_data: targetSessionId ? `pack_cancel:${targetSessionId}` : "pack_cancel" }];

  return sendStyleKeyboardFlat(ctx, lang, messageId, {
    headerText,
    selectedStyleId: selectedStyleId ?? undefined,
    extraButtons: [
      [{ text: previewBtn, callback_data: targetSessionId ? `pack_preview_pay:${targetSessionId}` : "pack_preview_pay" }],
      bottomButton,
    ],
  });
}

function isResumablePackSessionState(state?: string | null): boolean {
  return ["wait_pack_photo", "wait_pack_carousel", "wait_pack_preview_payment"].includes(state || "");
}

// Shared: entry into pack flow (menu button, /start, or broadcast "Попробовать")
async function handlePackMenuEntry(
  ctx: any,
  options?: { source?: "menu" | "start" | "broadcast"; autoPackEntry?: boolean }
) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }
  const lang = user.lang || "en";
  const source = options?.source || "menu";
  const autoPackEntry = Boolean(options?.autoPackEntry);
  console.log("[pack_flow] handlePackMenuEntry entry", { userId: user.id, source, autoPackEntry });
  let openingMsg: { message_id?: number } | null = null;
  if (source === "menu" || source === "start") {
    const openingText = lang === "ru" ? "⏳ Открываю конструктор пака..." : "⏳ Opening pack builder...";
    openingMsg = await ctx.reply(openingText, getMainMenuKeyboard(lang, ctx?.from?.id)).catch(() => null);
  }
  try {
    const activeSession = await getActiveSession(user.id);
    console.log("[pack_flow] after getActiveSession in pack_entry", { userId: user.id, sessionId: activeSession?.id ?? null, sessionState: activeSession?.state ?? null });
    const isProcessingState = activeSession?.state === "generating_pack_preview" || activeSession?.state === "generating_pack_theme" || activeSession?.state === "processing_pack";
    const processingStaleMinutes = 10;
    const processingUpdatedAt = activeSession?.updated_at ? new Date(activeSession.updated_at).getTime() : 0;
    const processingIsStale = !activeSession?.updated_at || (Date.now() - processingUpdatedAt > processingStaleMinutes * 60 * 1000);
    if (activeSession && isProcessingState && !processingIsStale) {
      const processingMsg = lang === "ru"
        ? "Сейчас идет обработка текущего пака. Подожди немного, я сообщу, когда все будет готово."
        : "Your current pack is still processing. Please wait a bit - I will notify you when it's ready.";
      await ctx.reply(processingMsg, getMainMenuKeyboard(lang, ctx?.from?.id));
      console.log(
        `[pack_entry] skipped due to active processing: source=${source} auto_pack_entry=${autoPackEntry} session=${activeSession.id} state=${activeSession.state}`
      );
      return;
    }
    if (activeSession && isProcessingState && processingIsStale) {
      console.log("[pack_flow] pack_entry not skipping: processing session is stale", { sessionId: activeSession.id, state: activeSession.state, updated_at: activeSession.updated_at });
    }
    const existingPhoto = activeSession?.current_photo_file_id || user.last_photo_file_id || null;
    console.log(
      `[pack_entry] start: source=${source} auto_pack_entry=${autoPackEntry} user=${user.id} has_photo=${Boolean(existingPhoto)}`
    );

    // Close any active assistant session to prevent ideas from showing
    const activeAssistant = await getActiveAssistantSession(user.id);
    if (activeAssistant) {
      await updateAssistantSession(activeAssistant.id, { status: "completed" });
    }

    // Source of truth for pack catalog in current DB: pack_content_sets.
    const contentSets = await getActivePackContentSets();
    if (!contentSets?.length) {
      const isAdmin = config.adminIds.includes(telegramId);
      const msg =
        lang === "ru"
          ? isAdmin
            ? "Наборов пока нет. Используйте «Сгенерировать пак» в меню, чтобы создать первый."
            : "Наборы пока не готовы."
          : isAdmin
            ? "No sets yet. Use «Generate pack» in the menu to create the first one."
            : "Sets not ready yet.";
      await ctx.reply(msg, getMainMenuKeyboard(lang, ctx?.from?.id));
      return;
    }
    const templateId = String(contentSets[0].pack_template_id || "couple_v1");

    const existingPackSession = await getPackFlowSession(user.id);
    console.log("[pack_flow] existingPackSession in pack_entry", { userId: user.id, existingId: existingPackSession?.id ?? null, existingState: existingPackSession?.state ?? null });
    const canResumeCarousel =
      existingPackSession?.id &&
      isResumablePackSessionState(existingPackSession.state) &&
      getPackContentSetsForTemplate(contentSets, getEffectivePackTemplateId(existingPackSession)).length > 0;
    if (canResumeCarousel) {
      if (existingPackSession.state === "wait_pack_carousel") {
        await renderPackCarouselForSession(ctx, existingPackSession, lang);
        return;
      }
      if (existingPackSession.state === "wait_pack_preview_payment") {
        await sendPackStyleSelectionStep(ctx, lang, existingPackSession.selected_style_id, undefined, {
          useBackButton: true,
          sessionId: existingPackSession.id,
        });
        return;
      }
      await ctx.reply(await getText(lang, "pack.send_photo"), getMainMenuKeyboard(lang, ctx?.from?.id));
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
        flow_kind: "pack",
        session_rev: 1,
        pack_template_id: templateId,
        pack_holiday_id: null,
        pack_carousel_index: 0,
        selected_style_id: selectedPackStyleId,
        current_photo_file_id: existingPhoto,
        photos: existingPhoto ? [existingPhoto] : [],
        env: config.appEnv,
      })
      .select()
      .single();
    if (sessErr || !session) {
      console.log("[pack_flow] pack_entry session insert failed", { userId: user.id, err: sessErr?.message });
      await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
      return;
    }
    console.log("[pack_flow] pack_entry session created", { userId: user.id, sessionId: session.id, state: session.state });

    let visibleSets = contentSets;
    const subjectFilterEnabled = await isSubjectModePackFilterEnabled();
    if (existingPhoto && subjectFilterEnabled) {
      // Do not block initial pack entry on detector call.
      void ensureSubjectProfileForGeneration(session, "style").catch((err) =>
        console.warn("[pack_entry] subject profile warmup failed:", err?.message || err)
      );
    }
    if (subjectFilterEnabled) {
      const subjectMode = getEffectiveSubjectMode(session);
      visibleSets = filterPackContentSetsBySubjectMode(contentSets, subjectMode);
    }
    if (!visibleSets.length) {
      await ctx.reply(
        lang === "ru" ? "Нет совместимых наборов для текущего фото." : "No compatible sets for the current source.",
        getMainMenuKeyboard(lang, ctx?.from?.id)
      );
      return;
    }

    const set = visibleSets[0];
    if (openingMsg?.message_id && ctx.chat?.id) {
      await ctx.telegram.deleteMessage(ctx.chat.id, openingMsg.message_id).catch(() => {});
    }
    const { carouselCaption, keyboard } = await buildPackCarouselCard(set, session, lang, {
      visibleSetsLength: visibleSets.length,
      currentIndex: 0,
      telegramId,
    });
    const exampleUrl = await getPackContentSetExampleUrlIfExists(set.id);
    console.log("[pack_carousel] show first card", { contentSetId: set.id, hasExampleUrl: !!exampleUrl, exampleUrlPreview: exampleUrl?.slice(0, 80) ?? null });
    if (ctx.chat?.id) {
      try {
        await showPackCarouselCard(ctx.telegram, supabase, {
          chatId: ctx.chat.id,
          carouselCaption,
          keyboard,
          exampleUrl,
          existingHasPhoto: false,
          sessionId: session.id,
        });
        await ctx.reply(lang === "ru" ? "📦 Листайте наборы выше" : "📦 Browse sets above", getMainMenuKeyboard(lang, ctx?.from?.id)).catch(() => {});
      } catch (e) {
        console.log("[pack_carousel] show first card failed", { contentSetId: set.id, err: (e as Error)?.message });
        const fallbackCaption = `${lang === "ru" ? set.name_ru : set.name_en}\n${lang === "ru" ? (set.carousel_description_ru || set.name_ru) : (set.carousel_description_en || set.name_en)}`;
        const sent = await ctx.telegram.sendMessage(ctx.chat.id, fallbackCaption, { reply_markup: keyboard });
        await supabase.from("sessions").update({
          progress_message_id: sent.message_id,
          progress_chat_id: ctx.chat.id,
          ui_message_id: sent.message_id,
          ui_chat_id: ctx.chat.id,
        }).eq("id", session.id);
        await ctx.reply(lang === "ru" ? "📦 Листайте наборы выше" : "📦 Browse sets above", getMainMenuKeyboard(lang, ctx?.from?.id)).catch(() => {});
      }
    }
  } catch (err: any) {
    console.error("[pack_entry] handlePackMenuEntry error:", err?.message || err, err?.stack?.split("\n").slice(0, 4));
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id)).catch(() => {});
  }
}

// Menu: 📦 Создать пак / 📦 Пак стикеров — show template CTA screen
bot.hears(["📦 Создать пак", "📦 Create pack", "📦 Пак стикеров", "📦 Sticker pack"], async (ctx) => {
  const telegramId = ctx.from?.id;
  const text = ctx.message?.text?.trim() ?? "";
  console.log("[pack_flow] hears menu button", { telegramId, text, source: "menu" });
  await handlePackMenuEntry(ctx, { source: "menu", autoPackEntry: false });
});

// Menu: 🔄 Сгенерировать пак (admin only, test) — create session wait_pack_generate_request, ask for theme (docs/20-02-admin-generate-pack-menu-button.md)
// When no content sets exist yet, admin can still generate the first pack (template_id default, pack_content_set_id null).
bot.hears(["🔄 Сгенерировать пак", "🔄 Generate pack"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId || !config.adminIds.includes(telegramId)) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const contentSets = await getActivePackContentSets();
  const templateId = contentSets?.length
    ? String(contentSets[0].pack_template_id || "couple_v1")
    : "couple_v1";
  const contentSetId = contentSets?.length ? contentSets[0].id : null;

  await supabase
    .from("sessions")
    .update({ is_active: false })
    .eq("user_id", user.id)
    .eq("is_active", true)
    .eq("env", config.appEnv);

  const { data: session, error: sessErr } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      state: "wait_pack_generate_request",
      is_active: true,
      flow_kind: "pack",
      session_rev: 1,
      pack_template_id: templateId,
      ...(contentSetId != null && { pack_content_set_id: contentSetId }),
      subject_mode: "single",
      subject_gender: "female",
      env: config.appEnv,
    })
    .select()
    .single();

  if (sessErr || !session) {
    console.error("[pack_admin] generate-from-menu session insert failed:", sessErr?.message);
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, telegramId));
    return;
  }

  await ctx.reply(
    lang === "ru"
      ? "Введите тему пака одной фразой (например: офисный юмор, 23 февраля Z стиль). Контекст фото берётся из текущей сессии."
      : "Enter the pack theme in one phrase (e.g. office humor, Feb 23 Z style). Photo context is taken from the current session.",
    getMainMenuKeyboard(lang, telegramId)
  );
});

// Menu: ⭐ Сделать примером (admin only) — выбор набора, ссылка на стикерпак → sticker_pack_example/{id}/example.webp (карусель бота; pack/content — для лендинга)
bot.hears(["⭐ Сделать примером", "⭐ Make as example"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId || !config.adminIds.includes(telegramId)) return;

  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  const lang = isRu ? "ru" : "en";
  const contentSets = await getActivePackContentSets();
  if (!contentSets.length) {
    await ctx.reply(isRu ? "Нет активных наборов в pack_content_sets." : "No active pack content sets.", getMainMenuKeyboard(lang, telegramId));
    return;
  }
  const caption = isRu ? "Выбери набор (для карусели паков):" : "Choose pack set (for pack carousel):";
  const rows = contentSets.map((set) => {
    const label = (lang === "ru" ? set.name_ru : set.name_en) || set.id;
    return [{ text: label, callback_data: `admin_pack_content_example:${set.id}` }];
  });
  await ctx.reply(caption, { reply_markup: { inline_keyboard: rows } });
});

// Callback: выбор набора для «Сделать примером» — переходим к шагу «ссылка на стикерпак»
bot.action(/^admin_pack_content_example:(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId || !config.adminIds.includes(telegramId)) return;

  const contentSetId = ctx.match[1]?.trim();
  if (!contentSetId) return;
  const { data: row } = await supabase.from(config.packContentSetsTable).select("id").eq("id", contentSetId).eq("is_active", true).maybeSingle();
  if (!row) {
    await ctx.reply("Набор не найден или неактивен.").catch(() => {});
    return;
  }
  adminPackContentExampleFlow.set(telegramId, { step: 2, contentSetId });
  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  await ctx.reply(
    isRu ? "Пришли ссылку на стикерпак (https://t.me/addstickers/...)" : "Send sticker pack link (https://t.me/addstickers/...)",
    getMainMenuKeyboard(isRu ? "ru" : "en", telegramId)
  );
});

// Broadcast "Попробовать" — same as tapping "Пак стикеров"
bot.action("broadcast_try_pack", async (ctx) => {
  safeAnswerCbQuery(ctx);
  await handlePackMenuEntry(ctx, { source: "broadcast", autoPackEntry: false });
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

  const { data: contentSetsForTemplate, error: contentSetsErr } = await supabase
    .from(config.packContentSetsTable)
    .select("id")
    .eq("pack_template_id", templateId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (contentSetsErr) {
    console.error("[pack_start] Failed to load template content sets:", contentSetsErr.message);
  }
  if (!contentSetsForTemplate?.length) {
    await ctx.reply(
      lang === "ru" ? "Шаблон не найден." : "Template not found.",
      getMainMenuKeyboard(lang, ctx?.from?.id)
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
      flow_kind: "pack",
      session_rev: 1,
      pack_template_id: templateId,
      pack_content_set_id: contentSetsForTemplate[0].id,
      selected_style_id: selectedPackStyleId,
      current_photo_file_id: existingPhoto,
      photos: existingPhoto ? [existingPhoto] : [],
      env: config.appEnv,
    })
    .select()
    .single();

  if (sessErr || !session) {
    console.error("Failed to create pack session:", sessErr?.message);
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }

  if (existingPhoto) {
    // Photo already available — skip to style selection (pack flow: always Back to poses)
    await sendPackStyleSelectionStep(ctx, lang, session.selected_style_id, undefined, { useBackButton: true, sessionId: session.id });
  } else {
    // No photo — ask user to send one
    await ctx.reply(await getText(lang, "pack.send_photo"), getMainMenuKeyboard(lang, ctx?.from?.id));
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
  const existingPhoto = user.last_photo_file_id || null;
  const templateId = ctx.match[1];

  const allContentSets = await getActivePackContentSets();
  const contentSets = getPackContentSetsForTemplate(allContentSets, templateId);
  if (!contentSets?.length) {
    await ctx.reply(lang === "ru" ? "Наборы пока не готовы." : "Sets not ready yet.", getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }

  const existingPackSession = await getPackFlowSession(user.id);
  if (
    existingPackSession?.id &&
    existingPackSession.pack_template_id === templateId &&
    isResumablePackSessionState(existingPackSession.state)
  ) {
    await renderPackCarouselForSession(ctx, existingPackSession, lang, { bumpSessionRev: true });
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
      flow_kind: "pack",
      session_rev: 1,
      pack_template_id: templateId,
      pack_holiday_id: null,
      pack_carousel_index: 0,
      selected_style_id: selectedPackStyleId,
      current_photo_file_id: existingPhoto,
      photos: existingPhoto ? [existingPhoto] : [],
      env: config.appEnv,
    })
    .select()
    .single();
  if (sessErr || !session) {
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }

  let visibleSets = contentSets;
  const subjectFilterEnabled = await isSubjectModePackFilterEnabled();
  if (existingPhoto && subjectFilterEnabled) {
    // Do not block initial pack entry on detector call.
    void ensureSubjectProfileForGeneration(session, "style").catch((err) =>
      console.warn("[pack_show_carousel] subject profile warmup failed:", err?.message || err)
    );
  }
  if (subjectFilterEnabled) {
    const subjectMode = getEffectiveSubjectMode(session);
    visibleSets = filterPackContentSetsBySubjectMode(contentSets, subjectMode);
  }
  if (!visibleSets.length) {
    await ctx.reply(
      lang === "ru" ? "Нет совместимых наборов для текущего фото." : "No compatible sets for the current source.",
      getMainMenuKeyboard(lang, ctx?.from?.id)
    );
    return;
  }

  const set = visibleSets[0];
  const setName = lang === "ru" ? set.name_ru : set.name_en;
  const setDesc = lang === "ru" ? (set.carousel_description_ru || set.name_ru) : (set.carousel_description_en || set.name_en);
  const carouselCaption = `*${escapeMarkdownForTelegram(setName)}*\n${escapeMarkdownForTelegram(setDesc)}`;
  const tryBtn = await getText(lang, "pack.carousel_try_btn", { name: setName });
  const adminRow = getPackCarouselAdminRow(telegramId, session.id);
  const keyboard = {
    inline_keyboard: [
      [
        { text: "◀️", callback_data: "pack_carousel_prev" },
        { text: `1/${visibleSets.length}`, callback_data: "pack_carousel_noop" },
        { text: "▶️", callback_data: "pack_carousel_next" },
      ],
      [{ text: tryBtn, callback_data: `pack_try:${set.id}` }],
      ...(adminRow.length ? [adminRow] : []),
    ],
  };
  await ctx.editMessageText(carouselCaption, { parse_mode: "Markdown", reply_markup: keyboard });
  await supabase
    .from("sessions")
    .update({
      progress_message_id: ctx.callbackQuery?.message?.message_id,
      progress_chat_id: ctx.chat?.id,
      ui_message_id: ctx.callbackQuery?.message?.message_id,
      ui_chat_id: ctx.chat?.id,
    })
    .eq("id", session.id);
});

bot.action("pack_carousel_noop", (ctx) => safeAnswerCbQuery(ctx));

bot.action("pack_carousel_prev", async (ctx) => {
  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  safeAnswerCbQuery(ctx, isRu ? "↩️ Листаю наборы..." : "↩️ Switching sets...");
  await updatePackCarouselCard(ctx, -1);
});
bot.action("pack_carousel_next", async (ctx) => {
  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  safeAnswerCbQuery(ctx, isRu ? "↪️ Листаю наборы..." : "↪️ Switching sets...");
  await updatePackCarouselCard(ctx, 1);
});

bot.action(/^pack_holiday:(.+)$/, async (ctx) => {
  const holidayId = ctx.match[1];
  if (holidayId !== "march_8") return;
  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  safeAnswerCbQuery(ctx, isRu ? "🌷 Включаю праздничные наборы..." : "🌷 Switching to holiday sets...");
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";
  const session = await getPackFlowSession(user.id);
  if (!session || session.state !== "wait_pack_carousel") return;
  const { error } = await supabase.from("sessions").update({ pack_holiday_id: holidayId, pack_carousel_index: 0 }).eq("id", session.id);
  if (error) {
    console.warn("[pack_holiday] update failed:", error.message);
    return;
  }
  const updated = { ...session, pack_holiday_id: holidayId, pack_carousel_index: 0 };
  await renderPackCarouselForSession(ctx, updated, lang, { resetCarouselIndex: true, bumpSessionRev: true });
});

bot.action("pack_holiday_off", async (ctx) => {
  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  safeAnswerCbQuery(ctx, isRu ? "Возвращаю обычные наборы..." : "Switching back to regular sets...");
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";
  const session = await getPackFlowSession(user.id);
  if (!session || session.state !== "wait_pack_carousel") return;
  const { error } = await supabase.from("sessions").update({ pack_holiday_id: null, pack_carousel_index: 0 }).eq("id", session.id);
  if (error) {
    console.warn("[pack_holiday_off] update failed:", error.message);
    return;
  }
  const updated = { ...session, pack_holiday_id: null, pack_carousel_index: 0 };
  await renderPackCarouselForSession(ctx, updated, lang, { resetCarouselIndex: true, bumpSessionRev: true });
});

// Admin-only: показать список наборов из pack_content_sets для выбора (вместо ввода id вручную).
bot.action(/^pack_admin_set_list(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId || !config.adminIds.includes(telegramId)) return;
  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";
  const rawPayload = ctx.match?.[1] ?? null;
  const explicitSessionId = typeof rawPayload === "string" && rawPayload.length > 0 ? rawPayload.trim() : null;

  let session: any = null;
  if (explicitSessionId) {
    const byId = await getSessionByIdForUser(user.id, explicitSessionId);
    if (byId?.id && byId.env === config.appEnv && byId.state === "wait_pack_carousel") session = byId;
  }
  if (!session) {
    const resolved = await resolvePackSessionForEvent(user.id, ["wait_pack_carousel"], explicitSessionId);
    session = resolved.session;
  }
  if (!session?.id || session.state !== "wait_pack_carousel") {
    await ctx.reply(lang === "ru" ? "Сессия не найдена или не в карусели. Открой карусель паков и нажми «Список наборов» снова." : "Session not found or not in carousel. Open pack carousel and tap «Список наборов» again.");
    return;
  }

  const templateId = getEffectivePackTemplateId(session);
  const allSets = await getActivePackContentSets();
  let visibleSets = getPackContentSetsForTemplate(allSets, templateId);
  const existingPhoto = session.current_photo_file_id || (await supabase.from("users").select("last_photo_file_id").eq("id", user.id).single().then((r) => r.data?.last_photo_file_id)) || null;
  const subjectFilterEnabled = await isSubjectModePackFilterEnabled();
  if (subjectFilterEnabled && existingPhoto) {
    const subjectMode = getEffectiveSubjectMode(session);
    visibleSets = filterPackContentSetsBySubjectMode(visibleSets, subjectMode);
  }
  if (!visibleSets.length) {
    await ctx.reply(lang === "ru" ? "Нет наборов для текущего шаблона/праздника." : "No sets for current template/holiday.");
    return;
  }

  const listCaption = lang === "ru" ? "Выбери набор:" : "Choose a set:";
  const rows = visibleSets.map((set) => {
    const label = (lang === "ru" ? set.name_ru : set.name_en) || set.id || "";
    return [{ text: label, callback_data: `pack_try:${set.id}` }];
  });
  await ctx.reply(listCaption, { reply_markup: { inline_keyboard: rows } });
});

// Admin-only (test bot): start pack generation flow — ask for theme. When session id is in callback, load by id (no state filter) to avoid RLS/timing issues.
bot.action(/^pack_admin_generate(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  const callbackData = (ctx.callbackQuery as any)?.data ?? "";
  console.log("[pack_flow] callback pack_admin_generate", { telegramId, callbackData });
  if (!telegramId || !config.adminIds.includes(telegramId)) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";
  const rawPayload = ctx.match?.[1] ?? null;
  const explicitSessionId = typeof rawPayload === "string" && rawPayload.length > 0 ? rawPayload.trim() : null;

  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/cee87e10-8efc-4a8c-a815-18fbbe1210d8',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5edd11'},body:JSON.stringify({sessionId:'5edd11',location:'index.ts:pack_admin_generate',message:'pack_admin_generate entry',data:{hypothesisId:'A_C',telegramId,userId:user.id,explicitSessionId,appEnv:config.appEnv,callbackData:(ctx.callbackQuery as any)?.data},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  let session: any = null;
  let reasonCode: "session_not_found" | "wrong_state" | undefined;
  if (explicitSessionId) {
    const byId = await getSessionByIdForUser(user.id, explicitSessionId);
    console.log("[pack_flow] pack_admin_generate byId", { userId: user.id, explicitSessionId, byIdId: byId?.id ?? null, byIdState: byId?.state ?? null });
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/cee87e10-8efc-4a8c-a815-18fbbe1210d8',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5edd11'},body:JSON.stringify({sessionId:'5edd11',location:'index.ts:pack_admin_generate',message:'after getSessionByIdForUser',data:{hypothesisId:'A_E',byIdFound:!!byId,byIdId:byId?.id,byIdUserId:byId?.user_id,byIdEnv:byId?.env,byIdState:byId?.state,reasonCode},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (byId?.id && byId.env === config.appEnv && byId.state === "wait_pack_carousel") {
      session = byId;
    } else if (byId?.id) {
      reasonCode = "wrong_state";
    } else {
      reasonCode = "session_not_found";
    }
  }
  if (!session) {
    const resolved = await resolvePackSessionForEvent(user.id, ["wait_pack_carousel"], explicitSessionId);
    session = resolved.session;
    console.log("[pack_flow] pack_admin_generate resolvePackSessionForEvent", { userId: user.id, sessionId: session?.id ?? null, sessionState: session?.state ?? null, reasonCode: resolved.reasonCode });
    if (!session?.id || resolved.reasonCode === "wrong_state") {
      await rejectPackEvent(ctx, lang, "pack_admin_generate", reasonCode || resolved.reasonCode || "session_not_found");
      return;
    }
  }

  // One active session per user — deactivate others so getActiveSession() returns this one when user sends theme.
  await supabase
    .from("sessions")
    .update({ is_active: false })
    .eq("user_id", user.id)
    .eq("env", config.appEnv);
  const { error: updateErr } = await supabase
    .from("sessions")
    .update({ state: "wait_pack_generate_request", is_active: true })
    .eq("id", session.id);
  if (updateErr) {
    console.warn("[pack_admin_generate] Failed to set wait_pack_generate_request:", updateErr.message, "sessionId:", session.id);
    await ctx.reply(lang === "ru" ? "Не удалось обновить сессию. Нажми «Сгенерировать пак» ещё раз." : "Failed to update session. Tap «Сгенерировать пак» again.");
    return;
  }
  console.log("[pack_flow] pack_admin_generate set wait_pack_generate_request", { userId: user.id, sessionId: session.id });

  await ctx.reply(
    lang === "ru"
      ? "Введите тему пака одной фразой (например: офисный юмор, 23 февраля Z стиль). Контекст фото берётся из текущей сессии."
      : "Enter the pack theme in one phrase (e.g. office humor, Feb 23 Z style). Photo context is taken from the current session."
  );
});

// Admin (test bot): Save — save pending pack to DB (buttons "Сохранить" and legacy "Save anyway"). Session id in callback_data ties to the message.
bot.action(/^(pack_admin_pack_save|pack_admin_save_rejected)(:.+)?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId || !config.adminIds.includes(telegramId)) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const callbackData = (ctx.callbackQuery as any)?.data;
  const explicitSessionId = parsePackAdminSessionId(callbackData);
  const session = explicitSessionId
    ? await getSessionByIdForUser(user.id, explicitSessionId)
    : (await getActiveSession(user.id)) ?? (await getPackFlowSession(user.id)) ?? null;
  if (!session?.id) {
    await ctx.reply(lang === "ru" ? "Сессия не найдена." : "Session not found.");
    return;
  }

  const spec = session.pending_rejected_pack_spec as PackSpecRow | null;
  if (!spec?.id) {
    await ctx.reply(lang === "ru" ? "Нет пака для сохранения." : "No pack to save.");
    await supabase.from("sessions").update({ pending_rejected_pack_spec: null, pending_pack_plan: null, pending_critic_suggestions: null, pending_critic_reasons: null }).eq("id", session.id);
    return;
  }

  const uniqueSpec = await ensureUniquePackId(spec);
  const specToSave = await ensureSpecLabelsRu(uniqueSpec);

  // Чтобы новый пак появился в карусели паков, используем тот же pack_template_id, что у существующих паков (карусель фильтрует по первому паку в списке).
  const existingSets = await getActivePackContentSets();
  const carouselTemplateId = existingSets[0]?.pack_template_id ?? "couple_v1";

  // subject_mode из сессии (по фото), иначе из spec: чтобы для 2 человек сохранялся multi, а не single от Boss.
  const sessionSubjectMode = getEffectiveSubjectMode(session);
  const subjectModeToSave = sessionSubjectMode !== "unknown" ? sessionSubjectMode : (specToSave.subject_mode ?? "any");

  const { error: insertErr } = await supabase.from(config.packContentSetsTable).insert({
    id: specToSave.id,
    pack_template_id: carouselTemplateId,
    name_ru: specToSave.name_ru,
    name_en: specToSave.name_en,
    carousel_description_ru: specToSave.carousel_description_ru,
    carousel_description_en: specToSave.carousel_description_en,
    labels: specToSave.labels,
    labels_en: specToSave.labels_en,
    scene_descriptions: specToSave.scene_descriptions,
    sort_order: specToSave.sort_order,
    is_active: specToSave.is_active,
    mood: specToSave.mood,
    sticker_count: specToSave.sticker_count,
    subject_mode: subjectModeToSave,
    cluster: specToSave.cluster,
    segment_id: specToSave.segment_id,
  });

  await supabase.from("sessions").update({ pending_rejected_pack_spec: null, pending_pack_plan: null, pending_critic_suggestions: null, pending_critic_reasons: null }).eq("id", session.id);

  if (insertErr) {
    await ctx.reply((lang === "ru" ? "❌ Ошибка записи: " : "❌ Insert error: ") + insertErr.message);
    return;
  }

  clearPackContentSetsCache();
  const successText = (lang === "ru" ? "✅ Пак сохранён: " : "✅ Pack saved: ") + specToSave.id;
  try {
    await ctx.editMessageText(successText).catch(() => ctx.reply(successText));
  } catch {
    await ctx.reply(successText);
  }
});

// Admin (test bot): Cancel — clear pending pack, do not save. Session id in callback_data ties to the message.
bot.action(/^pack_admin_pack_cancel(:.+)?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId || !config.adminIds.includes(telegramId)) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const callbackData = (ctx.callbackQuery as any)?.data;
  const explicitSessionId = parsePackAdminSessionId(callbackData);
  const session = explicitSessionId
    ? await getSessionByIdForUser(user.id, explicitSessionId)
    : (await getActiveSession(user.id)) ?? (await getPackFlowSession(user.id)) ?? null;
  if (!session?.id) return;

  await supabase
    .from("sessions")
    .update({ pending_rejected_pack_spec: null, pending_pack_plan: null, pending_critic_suggestions: null, pending_critic_reasons: null })
    .eq("id", session.id);

  const msg = lang === "ru" ? "❌ Отменено. Пак не сохранён." : "❌ Cancelled. Pack not saved.";
  try {
    await ctx.editMessageText(msg);
  } catch {
    await ctx.reply(msg);
  }
});

// Admin (test bot): Rework — передаём фидбек Critic агентам Captions и Scenes; session id в callback_data привязывает кнопку к сессии с результатом.
bot.action(/^pack_admin_pack_rework(:.+)?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId || !config.adminIds.includes(telegramId)) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const callbackData = (ctx.callbackQuery as any)?.data;
  const explicitSessionId = parsePackAdminSessionId(callbackData);
  let session = explicitSessionId
    ? await getSessionByIdForUser(user.id, explicitSessionId)
    : (await getActiveSession(user.id)) ?? (await getPackFlowSession(user.id)) ?? null;
  if (!session?.id) {
    await ctx.reply(lang === "ru" ? "Сессия не найдена." : "Session not found.");
    return;
  }

  let plan = session.pending_pack_plan as BossPlan | null;
  let suggestions: string[] = Array.isArray(session.pending_critic_suggestions) ? session.pending_critic_suggestions : [];
  let reasons: string[] = Array.isArray((session as any).pending_critic_reasons) ? (session as any).pending_critic_reasons : [];

  let reworkPlan: BossPlan | null = plan?.id ? plan : null;
  if (!reworkPlan?.id) {
    const spec = session.pending_rejected_pack_spec as PackSpecRow | null;
    if (spec?.id) {
      reworkPlan = specToMinimalPlan(spec);
    }
  }

  // Architectural: only use session from callback. If data missing, one retry (replica lag); no substitution with another session.
  if (!reworkPlan?.id && explicitSessionId) {
    await new Promise((r) => setTimeout(r, 400));
    session = (await getSessionByIdForUser(user.id, explicitSessionId)) ?? session;
    plan = session?.pending_pack_plan as BossPlan | null;
    suggestions = Array.isArray(session?.pending_critic_suggestions) ? session.pending_critic_suggestions : [];
    reasons = Array.isArray((session as any)?.pending_critic_reasons) ? (session as any).pending_critic_reasons : [];
    reworkPlan = plan?.id ? plan : null;
    if (!reworkPlan?.id) {
      const spec = session?.pending_rejected_pack_spec as PackSpecRow | null;
      if (spec?.id) reworkPlan = specToMinimalPlan(spec);
    }
  }

  if (!reworkPlan?.id) {
    console.warn("[pack_admin_pack_rework] No plan: sessionId=", (session as any)?.id, "explicitSessionId=", explicitSessionId, "hasPendingSpec=", !!(session as any)?.pending_rejected_pack_spec);
    const msgStale = lang === "ru"
      ? "Кнопка устарела. Используй последнее сообщение с результатом пака (кнопки Сохранить / Переделать)."
      : "Button is stale. Use the latest message with the pack result (Save / Rework buttons).";
    const msgNoPlan = lang === "ru"
      ? "Нет плана для переделки. Запустите генерацию заново."
      : "No plan for rework. Run generation again.";
    await ctx.reply(explicitSessionId ? msgNoPlan : msgStale);
    return;
  }

  // Если Critic в прошлый раз одобрил — фидбека нет; ждём текст от пользователя (что изменить), не стартуем rework сразу.
  const hasCriticFeedback = (reasons?.length ?? 0) > 0 || (suggestions?.length ?? 0) > 0;
  if (!hasCriticFeedback) {
    const { error: updateErr } = await supabase
      .from("sessions")
      .update({ state: "wait_pack_rework_feedback", is_active: true })
      .eq("id", session.id);
    if (updateErr) {
      await ctx.reply((lang === "ru" ? "❌ Ошибка: " : "❌ Error: ") + updateErr.message);
      return;
    }
    await ctx.reply(
      lang === "ru"
        ? "Опиши текстом, что изменить в паке (подписи или сцены). Отправь одно сообщение — оно уйдёт агентам как фидбек."
        : "Describe in text what to change in the pack (captions or scenes). Send one message — it will be passed to the agents as feedback."
    );
    return;
  }

  const statusMsg = await ctx.reply(
    lang === "ru"
      ? "⏳ Передаю фидбек Critic агентам, до 2 итераций переделки…"
      : "⏳ Passing Critic feedback to agents, up to 2 rework iterations…"
  ).catch(() => null);

  try {
    let previousSpec: PackSpecRow | null = (session.pending_rejected_pack_spec as PackSpecRow | null) ?? null;
    let reworkSuggestions = suggestions;
    let reworkReasons = (reasons?.length ?? 0) > 0 ? reasons : undefined;
    const reworkSubjectType = subjectTypeFromSession(session);
    let result = await reworkOneIteration(reworkPlan, reworkSubjectType, reworkSuggestions, previousSpec, reworkReasons);
    let spec = result.spec;
    let critic = result.critic;
    if (!critic.pass) {
      previousSpec = spec;
      reworkSuggestions = critic.suggestions ?? [];
      reworkReasons = critic.reasons ?? [];
      result = await reworkOneIteration(reworkPlan, reworkSubjectType, reworkSuggestions, previousSpec, reworkReasons.length ? reworkReasons : undefined);
      spec = result.spec;
      critic = result.critic;
    }

    await supabase
      .from("sessions")
      .update({
        pending_rejected_pack_spec: spec as any,
        pending_pack_plan: reworkPlan as any,
        pending_critic_suggestions: (critic.suggestions ?? []) as any,
        pending_critic_reasons: (critic.reasons ?? []) as any,
      })
      .eq("id", session.id);

    const summaryRaw =
      (lang === "ru" ? "Пак после переделки.\n\n" : "Pack after rework.\n\n") +
      (critic.pass
        ? (lang === "ru" ? "✅ Critic одобрил.\n\n" : "✅ Critic approved.\n\n")
        : (lang === "ru"
            ? "⚠️ Critic не одобрил. Ниже — его фидбек для следующей итерации (кнопка «Переделать» отдаст его агентам).\n\n"
            : "⚠️ Critic did not approve. Below is his feedback for the next iteration (Rework will pass it to the agents).\n\n")) +
      (lang === "ru" ? "ID: " : "ID: ") +
      spec.id +
      "\n" +
      (lang === "ru" ? "Название: " : "Name: ") +
      (lang === "ru" ? spec.name_ru : spec.name_en) +
      formatPackSpecPreview(spec, lang === "ru") +
      (critic.pass ? "" : formatCriticBlock(critic.reasons, critic.suggestions, lang === "ru"));
    const summary = summaryRaw.length > 4090 ? summaryRaw.slice(0, 4087) + "…" : summaryRaw;

    const saveBtn = lang === "ru" ? "✅ Сохранить" : "✅ Save";
    const cancelBtn = lang === "ru" ? "❌ Отменить" : "❌ Cancel";
    const reworkBtn = lang === "ru" ? "🔄 Переделать" : "🔄 Rework";
    const sid = session.id;
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: saveBtn, callback_data: `pack_admin_pack_save:${sid}` }, { text: cancelBtn, callback_data: `pack_admin_pack_cancel:${sid}` }],
          [{ text: reworkBtn, callback_data: `pack_admin_pack_rework:${sid}` }],
        ],
      },
    };

    if (statusMsg?.message_id && ctx.chat?.id) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, summary, keyboard).catch(() => ctx.reply(summary, keyboard));
    } else {
      await ctx.reply(summary, keyboard);
    }
  } catch (err: any) {
    const msg = (lang === "ru" ? "❌ Ошибка переделки: " : "❌ Rework error: ") + (err?.message || String(err));
    if (statusMsg?.message_id && ctx.chat?.id) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, msg).catch(() => ctx.reply(msg));
    } else {
      await ctx.reply(msg);
    }
  }
});

/** Единая точка: контент одной карточки карусели паков (подпись + клавиатура). */
async function buildPackCarouselCard(
  set: { id: string; name_ru: string; name_en: string; carousel_description_ru?: string; carousel_description_en?: string },
  session: any,
  lang: string,
  opts: { visibleSetsLength: number; currentIndex: number; telegramId?: number }
): Promise<{ carouselCaption: string; keyboard: { inline_keyboard: { text: string; callback_data: string }[][] } }> {
  const setName = lang === "ru" ? set.name_ru : set.name_en;
  const setDesc = lang === "ru" ? (set.carousel_description_ru || set.name_ru) : (set.carousel_description_en || set.name_en);
  const carouselCaption = `*${escapeMarkdownForTelegram(setName)}*\n${escapeMarkdownForTelegram(setDesc)}`;
  const tryBtn = await getText(lang, "pack.carousel_try_btn", { name: setName });
  const adminRow = getPackCarouselAdminRow(opts.telegramId ?? 0, session.id);
  const keyboard = {
    inline_keyboard: [
      [
        { text: "◀️", callback_data: "pack_carousel_prev" },
        { text: `${opts.currentIndex + 1}/${opts.visibleSetsLength}`, callback_data: "pack_carousel_noop" },
        { text: "▶️", callback_data: "pack_carousel_next" },
      ],
      [{ text: tryBtn, callback_data: `pack_try:${set.id}` }],
      ...(adminRow.length ? [adminRow] : []),
    ],
  };
  return { carouselCaption, keyboard };
}

/** Единая точка: отобразить карточку карусели (редактирование существующего сообщения или отправка нового). При ошибке показа фото — fallback на текст. */
async function showPackCarouselCard(
  telegram: { editMessageMedia: any; editMessageCaption: any; deleteMessage: any; sendPhoto: any; sendMessage: any; editMessageText: any },
  supabaseClient: any,
  params: {
    chatId: number;
    messageId?: number;
    carouselCaption: string;
    keyboard: { inline_keyboard: { text: string; callback_data: string }[][] };
    exampleUrl: string | null;
    existingHasPhoto: boolean;
    sessionId: string;
  }
): Promise<void> {
  const { chatId, messageId, carouselCaption, keyboard, exampleUrl, existingHasPhoto, sessionId } = params;
  const exampleBuffer = exampleUrl ? await fetchPackExampleAsBuffer(exampleUrl) : null;
  const hasExamplePhoto = !!exampleBuffer;
  const markdownOpts = { parse_mode: "Markdown" as const, reply_markup: keyboard };
  console.log("[pack_carousel] showPackCarouselCard", { hasMessageId: messageId != null, hasExampleUrl: !!exampleUrl, hasExamplePhoto, existingHasPhoto });

  const updateSessionProgress = (msgId: number) => {
    void supabaseClient
      .from("sessions")
      .update({
        progress_message_id: msgId,
        progress_chat_id: chatId,
        ui_message_id: msgId,
        ui_chat_id: chatId,
      })
      .eq("id", sessionId);
  };

  if (messageId != null) {
    if (hasExamplePhoto && exampleBuffer) {
      const photoInput = Input.fromBuffer(exampleBuffer, "example.webp");
      if (existingHasPhoto) {
        try {
          await telegram.editMessageMedia(chatId, messageId, undefined, {
            type: "photo",
            media: photoInput,
            caption: carouselCaption,
            parse_mode: "Markdown",
          }, { reply_markup: keyboard });
        } catch {
          await telegram.editMessageCaption(chatId, messageId, undefined, carouselCaption, markdownOpts);
        }
      } else {
        try {
          await telegram.deleteMessage(chatId, messageId);
          const sent = await telegram.sendPhoto(chatId, photoInput, { caption: carouselCaption, ...markdownOpts });
          updateSessionProgress(sent.message_id);
          return;
        } catch (e) {
          console.log("[pack_carousel] sendPhoto failed (replace photo with text)", { err: (e as Error)?.message });
          const sent = await telegram.sendMessage(chatId, carouselCaption, markdownOpts);
          updateSessionProgress(sent.message_id);
          return;
        }
      }
    } else {
      if (existingHasPhoto) {
        await telegram.deleteMessage(chatId, messageId);
        const sent = await telegram.sendMessage(chatId, carouselCaption, markdownOpts);
        updateSessionProgress(sent.message_id);
        return;
      }
      await telegram.editMessageText(chatId, messageId, undefined, carouselCaption, markdownOpts);
    }
    updateSessionProgress(messageId);
    return;
  }

  if (hasExamplePhoto && exampleBuffer) {
    try {
      const photoInput = Input.fromBuffer(exampleBuffer, "example.webp");
      const sent = await telegram.sendPhoto(chatId, photoInput, { caption: carouselCaption, ...markdownOpts });
      updateSessionProgress(sent.message_id);
      return;
    } catch (e) {
      console.log("[pack_carousel] sendPhoto failed (no messageId)", { err: (e as Error)?.message });
    }
  }
  const sent = await telegram.sendMessage(chatId, carouselCaption, markdownOpts);
  updateSessionProgress(sent.message_id);
}

async function updatePackCarouselCard(ctx: any, delta: number) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";
  const session = await getPackFlowSession(user.id);
  if (!session || session.state !== "wait_pack_carousel") return;
  const effectiveTemplateId = getEffectivePackTemplateId(session);
  if (!effectiveTemplateId) return;

  const allContentSets = await getActivePackContentSets();
  const contentSets = getPackContentSetsForTemplate(allContentSets, effectiveTemplateId);
  if (!contentSets?.length) return;

  const subjectFilterEnabled = await isSubjectModePackFilterEnabled();
  const subjectMode = getEffectiveSubjectMode(session);
  const visibleSets = subjectFilterEnabled
    ? filterPackContentSetsBySubjectMode(contentSets, subjectMode)
    : contentSets;
  if (!visibleSets.length) {
    await ctx.reply(
      lang === "ru" ? "Нет совместимых наборов для текущего фото." : "No compatible sets for the current source.",
      getMainMenuKeyboard(lang, ctx?.from?.id)
    );
    return;
  }

  const currentIndex = (session.pack_carousel_index ?? 0) + delta;
  const idx = ((currentIndex % visibleSets.length) + visibleSets.length) % visibleSets.length;
  const set = visibleSets[idx];
  await supabase.from("sessions").update({ pack_carousel_index: idx }).eq("id", session.id);

  const { carouselCaption, keyboard } = await buildPackCarouselCard(set, session, lang, {
    visibleSetsLength: visibleSets.length,
    currentIndex: idx,
    telegramId,
  });
  const exampleUrl = await getPackContentSetExampleUrlIfExists(set.id);
  const chatId = ctx.callbackQuery?.message?.chat?.id as number | undefined;
  const msgId = ctx.callbackQuery?.message?.message_id as number | undefined;
  const hasPhoto = !!(ctx.callbackQuery?.message?.photo?.length);
  if (!chatId) return;

  try {
    await showPackCarouselCard(ctx.telegram, supabase, {
      chatId,
      messageId: msgId,
      carouselCaption,
      keyboard,
      exampleUrl,
      existingHasPhoto: hasPhoto,
      sessionId: session.id,
    });
  } catch (_) {}
}

async function renderPackCarouselForSession(
  ctx: any,
  session: any,
  lang: string,
  options?: { resetCarouselIndex?: boolean; bumpSessionRev?: boolean }
) {
  const allContentSets = await getActivePackContentSets();
  const effectiveTemplateId = getEffectivePackTemplateId(session);
  const contentSets = getPackContentSetsForTemplate(allContentSets, effectiveTemplateId);
  if (!contentSets?.length) {
    const isHolidayEmpty = Boolean(session.pack_holiday_id);
    const msg = isHolidayEmpty
      ? (lang === "ru" ? "Нет наборов для этого праздника. Выключите праздник или выберите другой раздел." : "No sets for this holiday. Turn off holiday or choose another section.")
      : (lang === "ru" ? "Список наборов обновился. Нажмите «Создать пак» ещё раз." : "Pack list was updated. Tap «Create pack» again.");
    await ctx.reply(msg, getMainMenuKeyboard(lang, ctx?.from?.id)).catch(() => {});
    return;
  }

  const subjectFilterEnabled = await isSubjectModePackFilterEnabled();
  const subjectMode = getEffectiveSubjectMode(session);
  const visibleSets = subjectFilterEnabled
    ? filterPackContentSetsBySubjectMode(contentSets, subjectMode)
    : contentSets;
  if (!visibleSets.length) {
    await ctx.reply(
      lang === "ru" ? "Нет совместимых наборов для текущего фото." : "No compatible sets for the current source.",
      getMainMenuKeyboard(lang, ctx?.from?.id)
    );
    return;
  }

  const shouldResetIndex = options?.resetCarouselIndex === true;
  const rawIndex = shouldResetIndex ? 0 : Number(session.pack_carousel_index ?? 0);
  const safeIndex = Number.isFinite(rawIndex)
    ? ((rawIndex % visibleSets.length) + visibleSets.length) % visibleSets.length
    : 0;
  const set = visibleSets[safeIndex];
  const nextRev = options?.bumpSessionRev === true ? (session.session_rev || 1) + 1 : (session.session_rev || 1);
  const baseSessionPatch: any = {
    state: "wait_pack_carousel",
    pack_carousel_index: safeIndex,
    is_active: true,
    flow_kind: "pack",
  };
  if (options?.bumpSessionRev === true) baseSessionPatch.session_rev = nextRev;
  await supabase.from("sessions").update(baseSessionPatch).eq("id", session.id);

  const { carouselCaption, keyboard } = await buildPackCarouselCard(set, session, lang, {
    visibleSetsLength: visibleSets.length,
    currentIndex: safeIndex,
    telegramId: (ctx.from as any)?.id,
  });
  const exampleUrl = await getPackContentSetExampleUrlIfExists(set.id);
  const callbackMsg = (ctx.callbackQuery as any)?.message;
  const callbackMsgId = callbackMsg?.message_id as number | undefined;
  const callbackChatId = callbackMsg?.chat?.id as number | undefined;
  const hasPhoto = !!(callbackMsg?.photo?.length);

  if (callbackChatId && callbackMsgId) {
    try {
      await showPackCarouselCard(ctx.telegram, supabase, {
        chatId: callbackChatId,
        messageId: callbackMsgId,
        carouselCaption,
        keyboard,
        exampleUrl,
        existingHasPhoto: hasPhoto,
        sessionId: session.id,
      });
      return;
    } catch (_) {}
  }

  if (session.progress_message_id && session.progress_chat_id && (ctx.callbackQuery as any)?.message?.message_id) {
    try {
      await ctx.telegram.editMessageText(session.progress_chat_id, session.progress_message_id, undefined, carouselCaption, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
      return;
    } catch (_) {}
  }

  if (ctx.chat?.id) {
    try {
      await showPackCarouselCard(ctx.telegram, supabase, {
        chatId: ctx.chat.id,
        carouselCaption,
        keyboard,
        exampleUrl,
        existingHasPhoto: false,
        sessionId: session.id,
      });
      await ctx.reply(lang === "ru" ? "📦 Листайте наборы выше" : "📦 Browse sets above", getMainMenuKeyboard(lang, ctx?.from?.id)).catch(() => {});
    } catch (_) {
      const fallbackCaption = `${lang === "ru" ? set.name_ru : set.name_en}\n${lang === "ru" ? (set.carousel_description_ru || set.name_ru) : (set.carousel_description_en || set.name_en)}`;
      const sent = await ctx.telegram.sendMessage(ctx.chat.id, fallbackCaption, { reply_markup: keyboard });
      void supabase.from("sessions").update({
        progress_message_id: sent.message_id,
        progress_chat_id: ctx.chat.id,
        ui_message_id: sent.message_id,
        ui_chat_id: ctx.chat.id,
      }).eq("id", session.id);
      await ctx.reply(lang === "ru" ? "📦 Листайте наборы выше" : "📦 Browse sets above", getMainMenuKeyboard(lang, ctx?.from?.id)).catch(() => {});
    }
  }
}

bot.action(/^pack_try:(.+)$/, async (ctx) => {
  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  safeAnswerCbQuery(ctx, isRu ? "✨ Открываю выбор стиля..." : "✨ Opening style selection...");
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";
  const contentSetId = ctx.match[1];

  const session = await getPackFlowSession(user.id);
  if (!session || session.state !== "wait_pack_carousel") return;

  const { data: selectedContentSet } = await supabase
    .from(config.packContentSetsTable)
    .select("id, pack_template_id, subject_mode")
    .eq("id", contentSetId)
    .maybeSingle();
  if (!selectedContentSet) {
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }
  const effectiveTemplateId = getEffectivePackTemplateId(session);
  if (selectedContentSet.pack_template_id !== effectiveTemplateId) {
    await ctx.answerCbQuery(lang === "ru" ? "Этот набор уже устарел. Выбери из текущей карусели." : "This set is stale. Please pick from the current carousel.", { show_alert: false }).catch(() => {});
    return;
  }

  const existingPhoto = session.current_photo_file_id || (await supabase.from("users").select("last_photo_file_id").eq("id", user.id).single().then((r) => r.data?.last_photo_file_id)) || null;
  const subjectFilterEnabled = await isSubjectModePackFilterEnabled();
  if (existingPhoto && subjectFilterEnabled) {
    const subjectMode = getEffectiveSubjectMode(session);
    const setSubjectMode = normalizePackSetSubjectMode(selectedContentSet.subject_mode);
    if (subjectMode !== "unknown" && !isPackSetCompatibleWithSubject(setSubjectMode, subjectMode)) {
      await ctx.answerCbQuery(
        lang === "ru"
          ? "Этот набор не подходит под текущее количество персонажей. Выбери другой набор."
          : "This set is not compatible with current subject count. Please choose another set.",
        { show_alert: true }
      ).catch(() => {});
      return;
    }

    // Warm subject profile in background to keep the "Try with ..." click responsive.
    const draftSession = { ...session, current_photo_file_id: existingPhoto, photos: [existingPhoto] };
    void ensureSubjectProfileForGeneration(draftSession, "style").catch((err) =>
      console.warn("[pack_try] subject profile warmup failed:", err?.message || err)
    );
  }

  const initialState = existingPhoto ? "wait_pack_preview_payment" : "wait_pack_photo";

  await supabase
    .from("sessions")
    .update({
      state: initialState,
      pack_content_set_id: contentSetId,
      pack_carousel_index: session.pack_carousel_index ?? 0,
      current_photo_file_id: existingPhoto || null,
      photos: existingPhoto ? [existingPhoto] : [],
      is_active: true,
      flow_kind: "pack",
      session_rev: (session.session_rev || 1) + 1,
    })
    .eq("id", session.id);

  if (existingPhoto) {
    await sendPackStyleSelectionStep(ctx, lang, session.selected_style_id, session.progress_message_id ?? undefined, { useBackButton: true, sessionId: session.id });
  } else {
    await ctx.reply(await getText(lang, "pack.send_photo"), getMainMenuKeyboard(lang, ctx?.from?.id));
  }
});

// Callback: pack_back_to_carousel — back from style selection to pose carousel (same message)
bot.action(/^pack_back_to_carousel(?::(.+))?$/, async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);
  const { session, reasonCode } = await resolvePackSessionForEvent(
    user.id,
    ["wait_pack_preview_payment", "wait_pack_carousel"],
    explicitSessionId
  );
  if (!session || reasonCode === "wrong_state") {
    await rejectPackEvent(ctx, lang, "pack_back_to_carousel", reasonCode || "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectPackEvent(ctx, lang, "pack_back_to_carousel", "stale_callback");
    return;
  }
  safeAnswerCbQuery(ctx, lang === "ru" ? "↩️ Открываю наборы..." : "↩️ Opening sets...");
  await renderPackCarouselForSession(ctx, session, lang, { bumpSessionRev: true });
});

// Callback: pack_preview_pay — user pays 1 credit for preview
bot.action(/^pack_preview_pay(?::(.+))?$/, async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const { session, reasonCode } = await resolvePackSessionForEvent(
    user.id,
    ["wait_pack_preview_payment", "generating_pack_preview", "wait_pack_carousel"],
    explicitSessionId
  );
  if (!session || reasonCode === "wrong_state") {
    await rejectPackEvent(ctx, lang, "pack_preview_pay", reasonCode || "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectPackEvent(ctx, lang, "pack_preview_pay", "stale_callback");
    return;
  }

  if (session.state === "wait_pack_carousel") {
    const msg = lang === "ru"
      ? "Сначала выбери набор поз и нажми «Попробовать с ...»."
      : "First choose a pose set and tap “Try with ...”.";
    await ctx.answerCbQuery(msg, { show_alert: true }).catch(() => {});
    return;
  }

  if (session.state !== "wait_pack_preview_payment") {
    await rejectPackEvent(ctx, lang, "pack_preview_pay", "wrong_state");
    return;
  }
  safeAnswerCbQuery(ctx, lang === "ru" ? "🚀 Запускаю превью..." : "🚀 Starting preview...");

  const clickSessionRev = (session.session_rev || 1) + 1;
  const { error: prelockErr } = await supabase
    .from("sessions")
    .update({
      state: "generating_pack_preview",
      is_active: true,
      flow_kind: "pack",
      session_rev: clickSessionRev,
    })
    .eq("id", session.id);
  if (prelockErr) {
    console.error("[pack_preview_pay] prelock session update failed:", prelockErr.message);
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }

  const lockedSession = {
    ...session,
    state: "generating_pack_preview",
    session_rev: clickSessionRev,
    is_active: true,
    flow_kind: "pack",
  };
  await lockPackUiForProcessing(ctx, lockedSession, lang, "preview");

  const progressMsg = await ctx.reply(await getText(lang, "pack.progress_generating"));
  if (progressMsg?.message_id && ctx.chat?.id) {
    await supabase
      .from("sessions")
      .update({
        progress_message_id: progressMsg.message_id,
        progress_chat_id: ctx.chat.id,
        ui_message_id: progressMsg.message_id,
        ui_chat_id: ctx.chat.id,
      })
      .eq("id", session.id);
  }

  const rollbackPreviewStart = async (restoreStyleUi: boolean) => {
    const rollbackRev = clickSessionRev + 1;
    await supabase
      .from("sessions")
      .update({
        state: "wait_pack_preview_payment",
        is_active: true,
        flow_kind: "pack",
        session_rev: rollbackRev,
      })
      .eq("id", session.id);

    if (restoreStyleUi) {
      await sendPackStyleSelectionStep(ctx, lang, session.selected_style_id, undefined, { useBackButton: true, sessionId: session.id });
    }
  };

  // Same prompt as single sticker: for pack we omit style at start (style only in GRID rule 0 in worker); keep subject lock + COMPOSITION. LIKENESS only in worker GRID p.6.
  let packPromptFinal: string | null = null;
  let packStyleUserInput: string | null = null;
  if (session.selected_style_id) {
    const preset = await getStylePresetV2ById(session.selected_style_id);
    if (preset?.prompt_hint) {
      packStyleUserInput = preset.prompt_hint;
      packPromptFinal = await applySubjectLockToPrompt(session, "style", "");
      packPromptFinal = ensureSingleSuffix(packPromptFinal, COMPOSITION_SUFFIX_PACK);
    }
  }

  // sticker_count source: content set only.
  let packSize = 4;
  let selectedSetSubjectMode: "single" | "multi" | "any" = "any";
  if (session.pack_content_set_id) {
    const { data: selectedContentSet, error: setErr } = await supabase
      .from(config.packContentSetsTable)
      .select("sticker_count, subject_mode")
      .eq("id", session.pack_content_set_id)
      .maybeSingle();
    if (setErr) {
      console.warn("[pack_preview_pay] content set load failed:", setErr.message);
    }
    if (selectedContentSet?.sticker_count) {
      packSize = Number(selectedContentSet.sticker_count) || 4;
    }
    if (selectedContentSet?.subject_mode) {
      selectedSetSubjectMode = normalizePackSetSubjectMode(selectedContentSet.subject_mode);
    }
  }
  if (!session.pack_content_set_id) {
    const { data: firstContentSet, error: firstSetErr } = await supabase
      .from(config.packContentSetsTable)
      .select("sticker_count")
      .eq("pack_template_id", session.pack_template_id)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (firstSetErr) {
      console.warn("[pack_preview_pay] fallback content set load failed:", firstSetErr.message);
    }
    packSize = Number(firstContentSet?.sticker_count) || 4;
  }

  const subjectFilterEnabled = await isSubjectModePackFilterEnabled();
  if (subjectFilterEnabled) {
    const styleSession = { ...session };
    await ensureSubjectProfileForGeneration(styleSession, "style");
    const subjectMode = getEffectiveSubjectMode(styleSession);
    if (!isPackSetCompatibleWithSubject(selectedSetSubjectMode, subjectMode)) {
      await rollbackPreviewStart(true);
      await ctx.reply(
        lang === "ru"
          ? "Выбранный набор не подходит под текущее количество персонажей. Вернись к выбору поз и выбери другой набор."
          : "Selected set is not compatible with current subject count. Go back to poses and choose another set.",
        getMainMenuKeyboard(lang, ctx?.from?.id)
      );
      return;
    }
  }

  // Check credits
  if ((user.credits || 0) < 1) {
    await rollbackPreviewStart(false);
    await ctx.reply(await getText(lang, "pack.not_enough_credits"), getMainMenuKeyboard(lang, ctx?.from?.id));
    await sendBuyCreditsMenu(ctx, user);
    return;
  }

  // Deduct 1 credit atomically
  const { data: deducted } = await supabase.rpc("deduct_credits", {
    p_user_id: user.id,
    p_amount: 1,
  });

  if (!deducted) {
    await rollbackPreviewStart(false);
    await ctx.reply(await getText(lang, "pack.not_enough_credits"), getMainMenuKeyboard(lang, ctx?.from?.id));
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
    await rollbackPreviewStart(true);
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }

  // Update session (must set prompt_final so worker uses correct style)
  const sessionUpdate = {
    state: "generating_pack_preview",
    pack_batch_id: batch.id,
    prompt_final: packPromptFinal,
    user_input: packStyleUserInput,
    is_active: true,
    flow_kind: "pack",
    session_rev: clickSessionRev,
  };
  const { error: updateErr } = await supabase
    .from("sessions")
    .update(sessionUpdate)
    .eq("id", session.id);
  if (updateErr) {
    console.error("[pack_preview_pay] Session update failed:", updateErr.message);
    const { data: refUser } = await supabase.from("users").select("credits").eq("id", user.id).maybeSingle();
    await supabase.from("users").update({ credits: (refUser?.credits || 0) + 1 }).eq("id", user.id);
    await rollbackPreviewStart(true);
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
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
bot.action(/^pack_approve(?::(.+))?$/, async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const { session, reasonCode } = await resolvePackSessionForEvent(
    user.id,
    ["wait_pack_approval"],
    explicitSessionId
  );
  if (!session || reasonCode === "wrong_state") {
    await rejectPackEvent(ctx, lang, "pack_approve", reasonCode || "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectPackEvent(ctx, lang, "pack_approve", "stale_callback");
    return;
  }
  safeAnswerCbQuery(ctx, lang === "ru" ? "📦 Запускаю сборку пака..." : "📦 Starting pack assembly...");

  // Get sticker count from selected content set (or first active set for template id).
  let stickerCount = 4;
  if (session.pack_content_set_id) {
    const { data: selectedContentSet, error: setErr } = await supabase
      .from(config.packContentSetsTable)
      .select("sticker_count")
      .eq("id", session.pack_content_set_id)
      .maybeSingle();
    if (setErr) {
      console.warn("[pack_approve] content set load failed:", setErr.message);
    }
    if (selectedContentSet?.sticker_count) {
      stickerCount = Number(selectedContentSet.sticker_count) || 4;
    }
  }
  if (!session.pack_content_set_id) {
    const { data: firstContentSet, error: firstSetErr } = await supabase
      .from(config.packContentSetsTable)
      .select("sticker_count")
      .eq("pack_template_id", session.pack_template_id)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (firstSetErr) {
      console.warn("[pack_approve] fallback content set load failed:", firstSetErr.message);
    }
    stickerCount = Number(firstContentSet?.sticker_count) || 4;
  }
  const remainingCredits = stickerCount - 1; // already paid 1 for preview

  // Check credits
  if ((user.credits || 0) < remainingCredits) {
    await ctx.reply(await getText(lang, "pack.not_enough_credits"), getMainMenuKeyboard(lang, ctx?.from?.id));
    await sendBuyCreditsMenu(ctx, user);
    return;
  }

  // Deduct remaining credits
  const { data: deducted } = await supabase.rpc("deduct_credits", {
    p_user_id: user.id,
    p_amount: remainingCredits,
  });

  if (!deducted) {
    await ctx.reply(await getText(lang, "pack.not_enough_credits"), getMainMenuKeyboard(lang, ctx?.from?.id));
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
    .update({
      state: "processing_pack",
      is_active: true,
      flow_kind: "pack",
      session_rev: (session.session_rev || 1) + 1,
    })
    .eq("id", session.id);
  await lockPackUiForProcessing(ctx, session, lang, "assemble");

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
      .update({
        progress_message_id: msg.message_id,
        progress_chat_id: ctx.chat.id,
        ui_message_id: msg.message_id,
        ui_chat_id: ctx.chat.id,
      })
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
bot.action(/^pack_regenerate(?::(.+))?$/, async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const { session, reasonCode } = await resolvePackSessionForEvent(
    user.id,
    ["wait_pack_approval"],
    explicitSessionId
  );
  if (!session || reasonCode === "wrong_state") {
    await rejectPackEvent(ctx, lang, "pack_regenerate", reasonCode || "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectPackEvent(ctx, lang, "pack_regenerate", "stale_callback");
    return;
  }
  safeAnswerCbQuery(ctx, lang === "ru" ? "🔄 Запускаю новое превью..." : "🔄 Starting a new preview...");

  // Check credits
  if ((user.credits || 0) < 1) {
    await ctx.reply(await getText(lang, "pack.not_enough_credits"), getMainMenuKeyboard(lang, ctx?.from?.id));
    await sendBuyCreditsMenu(ctx, user);
    return;
  }

  // Deduct 1 credit
  const { data: deducted } = await supabase.rpc("deduct_credits", {
    p_user_id: user.id,
    p_amount: 1,
  });

  if (!deducted) {
    await ctx.reply(await getText(lang, "pack.not_enough_credits"), getMainMenuKeyboard(lang, ctx?.from?.id));
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
      flow_kind: "pack",
      session_rev: (session.session_rev || 1) + 1,
    })
    .eq("id", session.id);
  await lockPackUiForProcessing(ctx, session, lang, "preview");

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
      .update({
        progress_message_id: msg.message_id,
        progress_chat_id: ctx.chat.id,
        ui_message_id: msg.message_id,
        ui_chat_id: ctx.chat.id,
      })
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
  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  safeAnswerCbQuery(ctx, isRu ? "↩️ Возвращаю к выбору стиля..." : "↩️ Returning to style selection...");
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const session = await getPackFlowSession(user.id);
  if (!session || session.state !== "wait_pack_approval") return;

  await supabase
    .from("sessions")
    .update({
      state: "wait_pack_preview_payment",
      is_active: true,
      flow_kind: "pack",
      session_rev: (session.session_rev || 1) + 1,
    })
    .eq("id", session.id);
  try { await ctx.deleteMessage(); } catch {}
  await sendPackStyleSelectionStep(ctx, lang, session.selected_style_id, undefined, { useBackButton: true, sessionId: session.id });
});

// Callback: pack_cancel — user cancels pack
bot.action(/^pack_cancel(?::(.+))?$/, async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const { session, reasonCode } = await resolvePackSessionForEvent(
    user.id,
    ["wait_pack_approval", "wait_pack_preview_payment", "wait_pack_carousel"],
    explicitSessionId
  );
  if (!session || reasonCode === "wrong_state") {
    await rejectPackEvent(ctx, lang, "pack_cancel", reasonCode || "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectPackEvent(ctx, lang, "pack_cancel", "stale_callback");
    return;
  }
  safeAnswerCbQuery(ctx, lang === "ru" ? "🛑 Отменяю..." : "🛑 Cancelling...");

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
    .update({
      state: "canceled",
      is_active: false,
      flow_kind: "pack",
      session_rev: (session.session_rev || 1) + 1,
    })
    .eq("id", session.id);

  await ctx.reply(await getText(lang, "pack.cancelled"), getMainMenuKeyboard(lang, ctx?.from?.id));
});

// Callback: pack_new_photo — user chose to continue pack with newly sent photo
bot.action(/^pack_new_photo(?::(.+))?$/, async (ctx) => {
  const traceId = getOrCreateTraceId(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const { session, reasonCode } = await resolvePackSessionForEvent(
    user.id,
    ["wait_pack_photo", "wait_pack_carousel", "wait_pack_preview_payment", "wait_pack_approval"],
    explicitSessionId
  );
  if (!session || reasonCode === "wrong_state") {
    await rejectPackEvent(ctx, lang, "pack_new_photo", reasonCode || "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectPackEvent(ctx, lang, "pack_new_photo", "stale_callback");
    return;
  }
  safeAnswerCbQuery(ctx, lang === "ru" ? "📷 Применяю новое фото..." : "📷 Applying new photo...");

  const newPhotoFileId = session.pending_photo_file_id;
  if (!newPhotoFileId) {
    await ctx.reply(lang === "ru" ? "Фото не найдено, пришли ещё раз." : "Photo not found, please send again.");
    return;
  }
  const photos = Array.isArray(session.photos) ? session.photos : [];
  if (!photos.includes(newPhotoFileId)) photos.push(newPhotoFileId);
  const nextRev = (session.session_rev || 1) + 1;

  await supabase
    .from("sessions")
    .update({
      photos,
      current_photo_file_id: newPhotoFileId,
      pending_photo_file_id: null,
      state: "wait_action",
      style_source_kind: "photo",
      pack_batch_id: null,
      pack_sheet_file_id: null,
      is_active: true,
      flow_kind: "single",
      session_rev: nextRev,
    })
    .eq("id", session.id);

  logSessionTrace("pack_new_photo.transition_to_wait_action", {
    userId: user.id,
    sessionId: session.id,
    fromState: session.state,
    toState: "wait_action",
    flow_kind: "single",
    nextRev,
  }, traceId);

  // Run subject (gender) detection for the newly selected photo so subject_gender is in DB
  void ensureSubjectProfileForGeneration(
    { ...session, current_photo_file_id: newPhotoFileId, photos },
    "style"
  ).catch((err) => console.warn("[pack_new_photo] subject profile failed:", err?.message || err));

  await sendActionMenu(ctx, lang, session.id, nextRev);
});

// Callback: pack_keep_photo — user keeps current photo and continues pack flow
bot.action(/^pack_keep_photo(?::(.+))?$/, async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const { session, reasonCode } = await resolvePackSessionForEvent(
    user.id,
    ["wait_pack_photo", "wait_pack_carousel", "wait_pack_preview_payment", "wait_pack_approval"],
    explicitSessionId
  );
  if (!session || reasonCode === "wrong_state") {
    await rejectPackEvent(ctx, lang, "pack_keep_photo", reasonCode || "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectPackEvent(ctx, lang, "pack_keep_photo", "stale_callback");
    return;
  }
  safeAnswerCbQuery(ctx, lang === "ru" ? "📌 Оставляю текущее фото..." : "📌 Keeping current photo...");

  const { workingPhotoFileId } = resolveWorkingPhoto(session, user);
  await supabase
    .from("sessions")
    .update({
      current_photo_file_id: session.current_photo_file_id || workingPhotoFileId,
      pending_photo_file_id: null,
      is_active: true,
      flow_kind: "pack",
      session_rev: (session.session_rev || 1) + 1,
    })
    .eq("id", session.id);

  if (session.state === "wait_pack_carousel") {
    const refreshedSession = {
      ...session,
      current_photo_file_id: session.current_photo_file_id || workingPhotoFileId,
      pending_photo_file_id: null,
      is_active: true,
      flow_kind: "pack",
      session_rev: (session.session_rev || 1) + 1,
    };
    await renderPackCarouselForSession(ctx, refreshedSession, lang);
    return;
  }

  if (session.state === "wait_pack_approval") {
    await ctx.reply(
      lang === "ru"
        ? "Оставляем текущее фото. Можешь одобрить превью или перегенерировать."
        : "Keeping current photo. You can approve the preview or regenerate."
    );
    return;
  }

  await sendPackStyleSelectionStep(ctx, lang, session.selected_style_id, undefined, { useBackButton: true, sessionId: session.id });
});

// Callback: single_new_photo — use newly sent photo in single flow
bot.action(/^single_new_photo(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "single_new_photo", "session_not_found");
    return;
  }
  if (session.state?.startsWith("assistant_") || session.state?.startsWith("wait_pack_") || ["generating_pack_preview", "generating_pack_theme", "processing_pack"].includes(session.state)) {
    await rejectSessionEvent(ctx, lang, "single_new_photo", "wrong_state");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    // Photo-switch decisions can race with async session updates.
    // If there is still a pending photo in this exact session, allow processing.
    if (!(session.pending_photo_file_id && explicitSessionId && explicitSessionId === session.id)) {
      await rejectSessionEvent(ctx, lang, "single_new_photo", "stale_callback");
      return;
    }
    console.warn("[single_new_photo] stale_callback bypassed due to pending_photo_file_id", {
      sessionId: session.id,
      callbackRev,
      currentRev: session.session_rev,
    });
  }

  const newPhotoFileId = session.pending_photo_file_id;
  if (!newPhotoFileId) {
    await ctx.reply(lang === "ru" ? "Фото не найдено, пришли ещё раз." : "Photo not found, please send again.");
    return;
  }

  const photos = Array.isArray(session.photos) ? session.photos : [];
  if (!photos.includes(newPhotoFileId)) photos.push(newPhotoFileId);
  const nextRev = (session.session_rev || 1) + 1;
  await supabase
    .from("sessions")
    .update({
      photos,
      current_photo_file_id: newPhotoFileId,
      pending_photo_file_id: null,
      state: "wait_action",
      style_source_kind: "photo",
      is_active: true,
      flow_kind: "single",
      session_rev: nextRev,
    })
    .eq("id", session.id);

  void ensureSubjectProfileForGeneration(
    { ...session, current_photo_file_id: newPhotoFileId, photos },
    "style"
  ).catch((err) => console.warn("[single_new_photo] subject profile failed:", err?.message || err));

  await sendActionMenu(ctx, lang, session.id, nextRev);
});

// Callback: single_keep_photo — keep current photo in single flow
bot.action(/^single_keep_photo(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUser(telegramId);
  if (!user) return;
  const lang = user.lang || "en";

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "single_keep_photo", "session_not_found");
    return;
  }
  if (session.state?.startsWith("assistant_") || session.state?.startsWith("wait_pack_") || ["generating_pack_preview", "generating_pack_theme", "processing_pack"].includes(session.state)) {
    await rejectSessionEvent(ctx, lang, "single_keep_photo", "wrong_state");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    if (!(session.pending_photo_file_id && explicitSessionId && explicitSessionId === session.id)) {
      await rejectSessionEvent(ctx, lang, "single_keep_photo", "stale_callback");
      return;
    }
    console.warn("[single_keep_photo] stale_callback bypassed due to pending_photo_file_id", {
      sessionId: session.id,
      callbackRev,
      currentRev: session.session_rev,
    });
  }

  await supabase
    .from("sessions")
    .update({
      pending_photo_file_id: null,
      state: "wait_action",
      is_active: true,
      flow_kind: "single",
      session_rev: (session.session_rev || 1) + 1,
    })
    .eq("id", session.id);

  await ctx.reply(lang === "ru" ? "Оставляем текущее фото." : "Keeping current photo.");
  await sendActionMenu(ctx, lang, session.id, (session.session_rev || 1) + 1);
});

/** Admin flow «Сделать примером»: набор выбран кнопкой (step 2), обрабатываем ссылку → sticker_pack_example/{id}/example.webp (4x4). */
async function handleAdminPackContentExampleText(ctx: any, telegramId: number, text: string): Promise<void> {
  const flow = adminPackContentExampleFlow.get(telegramId)!;
  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  const contentSetId = flow.contentSetId;
  const link = text.trim();
  const match = link.match(/(?:https?:\/\/)?t\.me\/addstickers\/([a-zA-Z0-9_]+)/i) || link.match(/addstickers\/([a-zA-Z0-9_]+)/i);
  if (!match) {
    await ctx.reply(isRu ? "Неверная ссылка. Нужен формат https://t.me/addstickers/ИмяПака или /cancel" : "Invalid link. Use https://t.me/addstickers/Name or /cancel");
    return;
  }
  const shortName = match[1];
  console.log("[admin_pack_content_example] start", { contentSetId, shortName, telegramId });

  const statusMsg = await ctx.reply(isRu ? "⏳ Скачиваю стикеры и загружаю в sticker_pack_example/..." : "⏳ Downloading stickers and uploading to sticker_pack_example/...").catch(() => null);
  try {
    const bucket = config.supabaseStorageBucketExamples;
    if (!bucket) {
      console.error("[admin_pack_content_example] SUPABASE_STORAGE_BUCKET_EXAMPLES not set");
      await ctx.reply("❌ Не настроен бакет примеров (SUPABASE_STORAGE_BUCKET_EXAMPLES).");
      return;
    }
    const set = await getStickerSet(shortName);
    const stickersRaw = (set as { stickers: { file_id: string; is_animated?: boolean; is_video?: boolean }[] }).stickers;
    const stickers = stickersRaw
      .filter((s: any) => !s.is_animated && !s.is_video)
      .slice(0, PACK_EXAMPLE_GRID_STICKERS);
    if (stickers.length === 0) {
      await ctx.reply(isRu ? "В наборе нет статичных стикеров или набор пуст." : "No static stickers in set or set is empty.");
      adminPackContentExampleFlow.delete(telegramId);
      return;
    }
    const buffers: Buffer[] = [];
    for (const s of stickers) {
      const filePath = await getFilePath(s.file_id);
      const buf = await downloadFile(filePath);
      buffers.push(buf);
    }
    const grid = await assembleGridTo1024(buffers, PACK_EXAMPLE_GRID_COLS, PACK_EXAMPLE_GRID_ROWS);
    const storagePath = getPackContentSetExampleStoragePath(contentSetId);
    const { error: uploadErr } = await supabase.storage.from(bucket).upload(storagePath, grid, { contentType: "image/webp", upsert: true });
    if (uploadErr) {
      console.error("[admin_pack_content_example] upload failed", storagePath, uploadErr.message);
      if (statusMsg?.message_id) await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(`❌ Ошибка загрузки в Storage: ${uploadErr.message}`);
      return;
    }
    clearPackContentSetsCache();
    adminPackContentExampleFlow.delete(telegramId);
    if (statusMsg?.message_id) await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
    await ctx.reply(isRu ? `✅ Пример для набора «${contentSetId}» сохранён (сетка 1024×1024 в sticker_pack_example/).` : `✅ Example for set «${contentSetId}» saved (1024×1024 grid in sticker_pack_example/).`);
  } catch (err: any) {
    console.error("[admin_pack_content_example] Error:", err?.message || err, err);
    if (statusMsg?.message_id) await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
    await ctx.reply(`❌ ${err?.message || "Error"}`);
  }
}

// Sticker handler (edit existing sticker flow)
bot.on("sticker", async (ctx) => {
  const traceId = getOrCreateTraceId(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";
  const sticker = (ctx.message as any)?.sticker;
  const stickerFileId = sticker?.file_id as string | undefined;

  const { data: recentSessionsAtEntry } = await supabase
    .from("sessions")
    .select("id,state,is_active,flow_kind,session_rev,created_at,updated_at,current_photo_file_id,edit_replace_sticker_id,last_sticker_file_id")
    .eq("user_id", user.id)
    .eq("env", config.appEnv)
    .order("created_at", { ascending: false })
    .limit(10);
  console.log("[replace_face.debug][sticker.entry]", {
    trace_id: traceId,
    telegramId,
    userId: user.id,
    stickerFileId: stickerFileId || null,
    isAnimated: Boolean(sticker?.is_animated),
    isVideo: Boolean(sticker?.is_video),
    sessions: (recentSessionsAtEntry || []).map((s: any) => ({
      id: s.id,
      state: s.state,
      is_active: s.is_active,
      flow_kind: s.flow_kind,
      session_rev: s.session_rev,
      current_photo_file_id: s.current_photo_file_id ? "set" : null,
      edit_replace_sticker_id: s.edit_replace_sticker_id || null,
      last_sticker_file_id: s.last_sticker_file_id ? "set" : null,
      created_at: s.created_at || null,
      updated_at: s.updated_at || null,
    })),
  });

  // Architectural behavior:
  // incoming sticker is interpreted as explicit intent to start edit-sticker flow.
  // We only block when generation is currently running.
  const hardProcessingStates = new Set([
    "processing",
    "processing_emotion",
    "processing_motion",
    "processing_text",
    "generating_pack_preview",
    "generating_pack_theme",
    "processing_pack",
  ]);

  // Priority: check for wait_replace_face FIRST (before getActiveSession),
  // because getActiveSession may return a different session (e.g. wait_action from /start)
  // and sticker would be routed to edit-sticker flow instead of replace-face.
  const { data: replaceFaceSession, error: replaceFaceSessionErr } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", user.id)
    .eq("env", config.appEnv)
    .in("state", ["wait_replace_face_sticker"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (replaceFaceSessionErr) {
    console.error("[replace_face.debug][sticker.replace_face_query_error]", {
      trace_id: traceId,
      userId: user.id,
      error: replaceFaceSessionErr.message,
      code: (replaceFaceSessionErr as any)?.code || null,
    });
  }
  let sessionSource = replaceFaceSession?.id ? "replace_face_query" : "none";
  let session: any = replaceFaceSession || null;
  if (!session?.id) {
    session = await getActiveSession(user.id, traceId);
    if (session?.id) sessionSource = "getActiveSession";
  }
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({
        user_id: user.id,
        state: "wait_edit_sticker",
        flow_kind: "single",
        is_active: true,
        session_rev: 1,
        env: config.appEnv,
      })
      .select("*")
      .single();
    session = newSession;
    if (session?.id) sessionSource = "create_wait_edit_sticker";
  }
  if (!session?.id) {
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang, ctx?.from?.id));
    return;
  }
  if (hardProcessingStates.has(String(session.state || ""))) {
    await ctx.reply(
      lang === "ru"
        ? "⏳ Сейчас идёт генерация. Дождись результата и отправь стикер снова."
        : "⏳ Generation is in progress. Wait for the result and send the sticker again."
    );
    return;
  }
  console.log("[replace_face.debug][sticker.session_selected]", {
    trace_id: traceId,
    userId: user.id,
    sessionSource,
    session: sessionTraceSnapshot(session),
    stickerFileId: stickerFileId || null,
  });

  // === wait_replace_face: user sent sticker to replace face in (photo = identity) ===
  if (["wait_replace_face", "wait_replace_face_sticker"].includes(String(session.state || "")) && stickerFileId) {
    const identityPhotoFileId = session.current_photo_file_id || null;
    console.log("[replace_face.debug][sticker.replace_face_branch]", {
      trace_id: traceId,
      userId: user.id,
      sessionId: session.id,
      sessionState: session.state,
      identityPhotoFileId: identityPhotoFileId ? "set" : null,
      sessionRev: session.session_rev || null,
      stickerFileId,
    });
    if (!identityPhotoFileId) {
      await ctx.reply(await getText(lang, "photo.need_photo"));
      return;
    }
    if (sticker?.is_animated || sticker?.is_video) {
      await ctx.reply(lang === "ru" ? "Пока только статичные стикеры." : "Only static stickers for now.");
      return;
    }
    const insertPayload: any = {
      user_id: user.id,
      session_id: session.id,
      source_photo_file_id: stickerFileId,
      telegram_file_id: stickerFileId,
      env: config.appEnv,
      generation_type: "imported",
    };
    const { data: importedSticker, error: insertErr } = await supabase.from("stickers").insert(insertPayload).select("id").single();
    if (insertErr || !importedSticker?.id) {
      console.error("[wait_replace_face_sticker] insert failed:", insertErr?.message);
      await ctx.reply(await getText(lang, "error.technical"));
      return;
    }
    const stickerId = importedSticker.id as string;
    const nextRev = (session.session_rev || 1) + 1;
    await supabase
      .from("sessions")
      .update({
        state: "wait_replace_face_sticker",
        edit_replace_sticker_id: stickerId,
        last_sticker_file_id: stickerFileId,
        flow_kind: "single",
        is_active: true,
        session_rev: nextRev,
      })
      .eq("id", session.id);

    const { data: stickerRow } = await supabase.from("stickers").select("style_preset_id").eq("id", stickerId).maybeSingle();
    const { data: freshSession } = await supabase
      .from("sessions")
      .select("*")
      .eq("id", session.id)
      .maybeSingle();
    const patchedSession = freshSession || {
      ...session,
      current_photo_file_id: identityPhotoFileId,
      last_sticker_file_id: stickerFileId,
      edit_replace_sticker_id: stickerId,
      selected_style_id: stickerRow?.style_preset_id || session.selected_style_id || null,
      session_rev: nextRev,
      state: "wait_replace_face_sticker",
    };
    const replacePrompt =
      "You are given two references: (1) identity photo, (2) sticker reference. " +
      "Generate one sticker with identity from photo and pose/expression/style from sticker reference. " +
      "Keep one subject only, preserve the same vibe and composition, no text, no borders or outlines.";
    const earlyMsgId = await sendEarlyProgress(ctx, lang);
    await startGeneration(ctx, user, patchedSession, lang, {
      generationType: "replace_subject",
      promptFinal: replacePrompt,
      selectedStyleId: patchedSession.selected_style_id || null,
      userInput: lang === "ru" ? "Замена лица в стикере" : "Replace face in sticker",
      earlyProgressMessageId: earlyMsgId,
    });
    return;
  }

  if (String(session.state || "").startsWith("assistant_")) {
    await closeAllActiveAssistantSessions(user.id, "abandoned");
  }

  if (!stickerFileId) return;

  if (sticker?.is_animated || sticker?.is_video) {
    await ctx.reply(
      lang === "ru"
        ? "Пока поддерживаются только статичные стикеры (не animated/video)."
        : "Only static stickers are supported for now (no animated/video)."
    );
    return;
  }

  const nextRev = (session.session_rev || 1) + 1;
  await supabase
    .from("sessions")
    .update({
      state: "wait_edit_action",
      is_active: true,
      flow_kind: "single",
      session_rev: nextRev,
      last_sticker_file_id: stickerFileId,
      edit_sticker_file_id: stickerFileId,
      // Keep for replace_face recovery after asking user for photo.
      edit_replace_sticker_id: null,
    })
    .eq("id", session.id);

  const insertPayload: any = {
    user_id: user.id,
    session_id: session.id,
    source_photo_file_id: stickerFileId,
    user_input: null,
    generated_prompt: null,
    result_storage_path: null,
    sticker_set_name: user.sticker_set_name || null,
    telegram_file_id: stickerFileId,
    env: config.appEnv,
    generation_type: "imported",
  };
  // Backward-compat: DB may not have generation_type yet.
  let importedSticker: any = null;
  let insertErr: any = null;
  const firstInsert = await supabase.from("stickers").insert(insertPayload).select("id").single();
  importedSticker = firstInsert.data;
  insertErr = firstInsert.error;
  if (insertErr && (String(insertErr.message || "").toLowerCase().includes("generation_type") || insertErr.code === "42703")) {
    delete insertPayload.generation_type;
    const fallbackInsert = await supabase.from("stickers").insert(insertPayload).select("id").single();
    importedSticker = fallbackInsert.data;
    insertErr = fallbackInsert.error;
  }
  if (insertErr || !importedSticker?.id) {
    console.error("[edit_sticker] failed to insert imported sticker:", insertErr?.message || insertErr);
    await ctx.reply(await getText(lang, "error.technical"));
    return;
  }

  const stickerId = importedSticker.id as string;
  await supabase
    .from("sessions")
    .update({ edit_replace_sticker_id: stickerId })
    .eq("id", session.id);

  const replyMarkup = await buildStickerButtons(lang, stickerId, { sessionId: session.id, sessionRev: nextRev });
  await ctx.reply(await getText(lang, "edit.what_to_do"), { reply_markup: replyMarkup });
});

// Text handler (style description)
bot.on("text", async (ctx) => {
  const telegramId = ctx.from?.id;
  const msgText = ctx.message?.text?.trim() ?? "";
  console.log("[pack_flow] text handler entered", { telegramId, textLen: msgText.length, textPreview: msgText.slice(0, 60) });
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

  // === Admin: «Сделать примером» flow (pack_content_sets → pack link → sticker_pack_example/{id}/example.webp) ===
  if (config.adminIds.includes(telegramId) && adminPackContentExampleFlow.has(telegramId)) {
    const text = ctx.message?.text?.trim() ?? "";
    console.log("[admin_pack_content_example] text in flow", { telegramId, textPreview: text.slice(0, 50) });
    if (text === "/cancel") {
      adminPackContentExampleFlow.delete(telegramId);
      await ctx.reply("❌ Отменено.");
      return;
    }
    await handleAdminPackContentExampleText(ctx, telegramId, text);
    return;
  }

  if (ctx.message.text?.startsWith("/")) return;

  // Skip menu button texts — they are handled by bot.hears() above
  const menuButtons = [
    "✨ Создать стикер", "✨ Create sticker",
    "🎨 Изменить стикер", "🎨 Edit sticker",
    "🎨 Стили", "🎨 Styles", // legacy, button hidden
    "📦 Создать пак", "📦 Create pack",
    "🔄 Сгенерировать пак", "🔄 Generate pack",
    "⭐ Сделать примером", "⭐ Make as example",
    "💰 Ваш баланс", "💰 Your balance",
    "💬 Поддержка", "💬 Support",
  ];
  if (menuButtons.includes(ctx.message.text?.trim())) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  // Резолв сессии для текста (см. docs/done/02/16-02-session-architecture-requirements): getActiveSession, затем flow-aware fallback при null, затем уточнение для pack-theme.
  let session = await getActiveSession(user.id);
  // #region agent log
  console.log("[pack_text_resolve] after getActiveSession", { userId: user.id, telegramId, sessionId: session?.id ?? null, sessionState: session?.state ?? null, isTest: config.appEnv === "test", isAdmin: config.adminIds.includes(telegramId) });
  // #endregion
  const recoverableTextStates = [
    "wait_text_overlay",
    "wait_text",
    // Legacy custom style states are recoverable to migrate users back to wait_style.
    "wait_custom_style",
    "wait_custom_style_v2",
    "wait_custom_emotion",
    "wait_custom_motion",
    "assistant_chat",
    "assistant_wait_photo",
  ];

  if (!session?.id) {
    // Generic fallback for text-input states (single/assistant/manual text steps),
    // because some environments occasionally flip is_active=false unexpectedly.
    const recentCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const shortCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min for add_text flow

    // Priority 1: wait_text_overlay (user just clicked "Add text" — must not be hijacked by assistant)
    const { data: waitTextSession } = await supabase
      .from("sessions")
      .select("*")
      .eq("user_id", user.id)
      .eq("env", config.appEnv)
      .eq("state", "wait_text_overlay")
      .gte("updated_at", shortCutoff)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    let recoveredSession = waitTextSession;
    if (!recoveredSession?.id) {
      const { data: textFlowSession } = await supabase
        .from("sessions")
        .select("*")
        .eq("user_id", user.id)
        .eq("env", config.appEnv)
        .in("state", recoverableTextStates)
        .gte("updated_at", recentCutoff)
        .order("updated_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      recoveredSession = textFlowSession;
    }
    if (!recoveredSession?.id) {
      // Legacy custom-idea flow uses a separate waiting flag without dedicated state.
      const { data: customIdeaSession } = await supabase
        .from("sessions")
        .select("*")
        .eq("user_id", user.id)
        .eq("env", config.appEnv)
        .eq("waiting_custom_idea", true)
        .gte("updated_at", recentCutoff)
        .order("updated_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      recoveredSession = customIdeaSession || null;
    }
    if (!recoveredSession?.id) {
      // Assistant idea-card flow: session has sticker_ideas_state but may have state/updated_at quirks.
      const { data: assistantIdeaSession } = await supabase
        .from("sessions")
        .select("*")
        .eq("user_id", user.id)
        .eq("env", config.appEnv)
        .not("sticker_ideas_state", "is", null)
        .neq("state", "canceled")
        .gte("created_at", recentCutoff)
        .order("updated_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      recoveredSession = assistantIdeaSession || null;
    }
    if (!recoveredSession?.id) {
      // Fallback: any recent assistant session (flow_kind or state).
      const { data: assistantSession } = await supabase
        .from("sessions")
        .select("*")
        .eq("user_id", user.id)
        .eq("env", config.appEnv)
        .eq("flow_kind", "assistant")
        .neq("state", "canceled")
        .gte("created_at", recentCutoff)
        .order("updated_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      recoveredSession = assistantSession || null;
    }
    if (recoveredSession?.id) {
      session = recoveredSession;
      console.log("[pack_text_resolve] recovered text-flow session", {
        userId: user.id,
        telegramId,
        sessionId: session.id,
        sessionState: session.state,
        isActive: session.is_active,
      });
    }
  }
  if (!session?.id) {
    if (config.adminIds.includes(telegramId)) {
      // Include wait_pack_carousel: after "Сгенерировать пак" session is in carousel until user taps "Сгенерировать" (then wait_pack_generate_request). Theme can be sent from carousel in some flows.
      const { data: packSession, error: packSessionErr } = await supabase
        .from("sessions")
        .select("*")
        .eq("user_id", user.id)
        .eq("env", config.appEnv)
        .in("state", ["wait_pack_generate_request", "wait_pack_rework_feedback", "wait_pack_carousel"])
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      console.log("[pack_flow] fallback query (theme states)", { userId: user.id, packSessionId: packSession?.id ?? null, packSessionState: packSession?.state ?? null, queryErr: packSessionErr?.message ?? null });
      if (packSession?.id) {
        session = packSession;
      }
      if (!session?.id) {
        const packFlow = await getPackFlowSession(user.id);
        console.log("[pack_flow] getPackFlowSession after fallback miss", { userId: user.id, packFlowId: packFlow?.id ?? null, packFlowState: packFlow?.state ?? null });
        if (packFlow?.id && (packFlow.state === "wait_pack_carousel" || packFlow.state === "wait_pack_generate_request")) {
          session = packFlow;
        }
      }
      // #region agent log
      console.log("[pack_text_resolve] after fallback (session was null)", { sessionId: session?.id ?? null, sessionState: session?.state ?? null, hadPackSession: !!packSession?.id });
      // #endregion
    }
  }
  if (!session?.id) {
    // #region agent log
    console.log("[pack_text_resolve] replying need_start (no session)", { userId: user.id, telegramId });
    // #endregion
    await ctx.reply(await getText(lang, "start.need_start"));
    return;
  }

  // Уточнение резолва (flow-aware): если сессия не в pack-flow, но есть паковая сессия, ожидающая тему — подставляем её (getActiveSession мог вернуть другую по updated_at).
  const packThemeStates = ["wait_pack_generate_request", "wait_pack_carousel", "wait_pack_rework_feedback"];
  const textFlowStates = new Set(recoverableTextStates);
  const assistantTextStates = new Set(["assistant_chat", "assistant_wait_photo"]);
  // Single text flows must never be hijacked by admin pack refinement.
  const protectSingleTextFlow =
    textFlowStates.has(String(session?.state || ""))
    || assistantTextStates.has(String(session?.state || ""))
    || Boolean(session?.waiting_custom_idea)
    || String(session?.flow_kind || "") === "single"
    || String(session?.flow_kind || "") === "assistant";
  const needRefinement =
    session?.id
    && config.adminIds.includes(telegramId)
    && !packThemeStates.includes(session.state)
    && !protectSingleTextFlow;
  if (needRefinement) {
    const { data: packForTheme } = await supabase
      .from("sessions")
      .select("*")
      .eq("user_id", user.id)
      .eq("env", config.appEnv)
      .in("state", ["wait_pack_generate_request", "wait_pack_carousel"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (packForTheme?.id) session = packForTheme;
    // #region agent log
    console.log("[pack_text_resolve] after refinement", { refined: !!packForTheme?.id, sessionId: session?.id, sessionState: session?.state });
    // #endregion
  }
  // #region agent log
  console.log("[pack_text_resolve] before pack_theme check", { sessionId: session?.id, sessionState: session?.state, wouldBePackTheme: (config.adminIds.includes(telegramId) && (session.state === "wait_pack_generate_request" || session.state === "wait_pack_carousel")), textLen: ctx.message?.text?.length ?? 0 });
  // #endregion

  // === Admin pack rework: user sent feedback (Critic approved, user tapped Rework and described what to change) ===
  const isPackReworkFeedback =
    config.adminIds.includes(telegramId) &&
    session.state === "wait_pack_rework_feedback";
  if (isPackReworkFeedback) {
    const userFeedback = ctx.message.text?.trim() || "";
    if (!userFeedback) {
      await ctx.reply(lang === "ru" ? "Напиши, что изменить (одним сообщением)." : "Describe what to change (in one message).");
      return;
    }
    const plan = session.pending_pack_plan as BossPlan | null;
    if (!plan?.id) {
      await supabase.from("sessions").update({ state: "wait_pack_carousel" }).eq("id", session.id);
      await ctx.reply(lang === "ru" ? "План не найден. Используй кнопку Переделать снова с последнего результата." : "Plan not found. Use the Rework button again from the latest result.");
      return;
    }
    const statusMsg = await ctx.reply(lang === "ru" ? "⏳ Переделываю по твоему фидбеку…" : "⏳ Reworking with your feedback…").catch(() => null);
    try {
      const result = await reworkOneIteration(plan, subjectTypeFromSession(session), [userFeedback], undefined, undefined);
      const spec = result.spec;
      const critic = result.critic;
      await supabase
        .from("sessions")
        .update({
          state: "wait_pack_carousel",
          pending_rejected_pack_spec: spec as any,
          pending_pack_plan: plan as any,
          pending_critic_suggestions: (critic.suggestions ?? []) as any,
          pending_critic_reasons: (critic.reasons ?? []) as any,
        })
        .eq("id", session.id);
      const summaryRaw =
        (lang === "ru" ? "Пак после переделки по твоему фидбеку.\n\n" : "Pack after rework with your feedback.\n\n") +
        (critic.pass ? (lang === "ru" ? "✅ Critic одобрил.\n\n" : "✅ Critic approved.\n\n") : (lang === "ru" ? "⚠️ Critic не одобрил.\n\n" : "⚠️ Critic did not approve.\n\n")) +
        (lang === "ru" ? "ID: " : "ID: ") + spec.id + "\n" + (lang === "ru" ? "Название: " : "Name: ") + (lang === "ru" ? spec.name_ru : spec.name_en) +
        formatPackSpecPreview(spec, lang === "ru") +
        (critic.pass ? "" : formatCriticBlock(critic.reasons, critic.suggestions, lang === "ru"));
      const summary = summaryRaw.length > 4090 ? summaryRaw.slice(0, 4087) + "…" : summaryRaw;
      const saveBtn = lang === "ru" ? "✅ Сохранить" : "✅ Save";
      const cancelBtn = lang === "ru" ? "❌ Отменить" : "❌ Cancel";
      const reworkBtn = lang === "ru" ? "🔄 Переделать" : "🔄 Rework";
      const sid = session.id;
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: saveBtn, callback_data: `pack_admin_pack_save:${sid}` }, { text: cancelBtn, callback_data: `pack_admin_pack_cancel:${sid}` }],
            [{ text: reworkBtn, callback_data: `pack_admin_pack_rework:${sid}` }],
          ],
        },
      };
      if (statusMsg?.message_id && ctx.chat?.id) {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, summary, keyboard).catch(() => ctx.reply(summary, keyboard));
      } else {
        await ctx.reply(summary, keyboard);
      }
    } catch (err: any) {
      await supabase.from("sessions").update({ state: "wait_pack_carousel" }).eq("id", session.id);
      const msg = (lang === "ru" ? "❌ Ошибка переделки: " : "❌ Rework error: ") + (err?.message || String(err));
      if (statusMsg?.message_id && ctx.chat?.id) {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, msg).catch(() => ctx.reply(msg));
      } else {
        await ctx.reply(msg);
      }
    }
    return;
  }

  // === Admin pack generation: theme text → run pipeline → insert ===
  const isAdminPackThemeRequest =
    config.adminIds.includes(telegramId) &&
    (session.state === "wait_pack_generate_request" || session.state === "wait_pack_carousel");
  if (isAdminPackThemeRequest) {
    const request = ctx.message.text?.trim() || "";
    if (!request) {
      await ctx.reply(lang === "ru" ? "Введите тему одной фразой." : "Enter the theme in one phrase.");
      return;
    }

    // Layer 1 — one run per user: if this user already has a session in generating_pack_theme, do not start another.
    // If that session is stale (updated > 15 min ago), treat as crashed and allow new run; reset stale to wait_pack_carousel.
    const GENERATING_PACK_THEME_STALE_MS = 15 * 60 * 1000; // 15 min
    const { data: alreadyGenerating, error: alreadyErr } = await supabase
      .from("sessions")
      .select("id, updated_at")
      .eq("user_id", user.id)
      .eq("env", config.appEnv)
      .eq("state", "generating_pack_theme")
      .limit(1)
      .maybeSingle();
    if (alreadyErr) {
      console.warn("[pack_admin] Layer 1 check failed (apply migration 121 if missing enum):", alreadyErr.message);
    }
    if (alreadyGenerating?.id) {
      // Only skip if the SAME session is already generating (duplicate theme submit). Another session in generating_pack_theme = stuck, allow current one.
      if (alreadyGenerating.id === session.id) {
        console.log("[pack_admin] Skip: same session already in generating_pack_theme (duplicate)", { sessionId: session.id });
        await ctx.reply(lang === "ru" ? "⏳ Генерация пака уже идёт. Дождись окончания." : "⏳ Pack generation already in progress. Wait for it to finish.");
        return;
      }
      const updatedAt = alreadyGenerating.updated_at ? new Date(alreadyGenerating.updated_at).getTime() : 0;
      const isStale = Date.now() - updatedAt > GENERATING_PACK_THEME_STALE_MS;
      await supabase
        .from("sessions")
        .update({ state: "wait_pack_carousel", is_active: false })
        .eq("id", alreadyGenerating.id);
      console.log("[pack_admin] Other session in generating_pack_theme reset to wait_pack_carousel (stale or blocking), proceeding with theme", {
        resetSessionId: alreadyGenerating.id,
        currentSessionId: session.id,
        isStale,
      });
    }

    // Layer 2 — conditional lock: only update if session is still in theme state (prevents double-run on same session from Telegram retries).
    const { data: locked, error: lockErr } = await supabase
      .from("sessions")
      .update({ state: "generating_pack_theme", is_active: true })
      .eq("id", session.id)
      .in("state", ["wait_pack_generate_request", "wait_pack_carousel"])
      .select("id")
      .maybeSingle();
    if (lockErr || !locked?.id) {
      console.warn("[pack_admin] Lock failed or no row updated (state already changed or race):", { sessionId: session.id, lockErr: lockErr?.message });
      await ctx.reply(lang === "ru" ? "Не удалось заблокировать сессию. Подожди минуту и попробуй снова." : "Could not lock session. Wait a minute and try again.");
      return;
    }
    session.state = "generating_pack_theme";

    const adminPackStageLabels: Record<string, { ru: string; en: string }> = {
      brief_and_plan: { ru: "Brief & Plan", en: "Brief & Plan" },
      captions: { ru: "Captions", en: "Captions" },
      scenes: { ru: "Scenes", en: "Scenes" },
      critic: { ru: "Critic", en: "Critic" },
      captions_rework: { ru: "Captions (итерация 2)", en: "Captions (iteration 2)" },
      scenes_rework: { ru: "Scenes (итерация 2)", en: "Scenes (iteration 2)" },
      critic_2: { ru: "Critic (2)", en: "Critic (2)" },
    };
    const statusMsg = await ctx.reply(lang === "ru" ? "⏳ Brief & Plan…" : "⏳ Brief & Plan…");
    const chatId = ctx.chat!.id;
    const progressMsgId = (statusMsg as any).message_id;
    const onProgress = async (stage: string) => {
      const labels = adminPackStageLabels[stage];
      const text = labels ? "⏳ " + (lang === "ru" ? labels.ru : labels.en) + "…" : "⏳ " + stage + "…";
      try {
        await ctx.telegram.editMessageText(chatId, progressMsgId, undefined, text);
      } catch {}
    };
    let result: Awaited<ReturnType<typeof runPackGenerationPipeline>>;
    try {
      const subjectType = parseSubjectTypeFromThemeRequest(request) ?? subjectTypeFromSession(session);
      // Keep the initial pipeline bounded: one Critic pass in-handler, then optional manual rework by button.
      result = await runPackGenerationPipeline(request, subjectType, { maxCriticIterations: 1, onProgress });
    } finally {
      await supabase
        .from("sessions")
        .update({ state: "wait_pack_carousel", is_active: true })
        .eq("id", session.id);
    }

    if (!result.ok && !result.spec) {
      const errText = result.error || "Unknown error";
      await ctx.telegram.editMessageText(ctx.chat!.id, (statusMsg as any).message_id, undefined, "❌ " + errText).catch(() => ctx.reply("❌ " + errText));
      return;
    }

    if (!result.ok && result.criticReasons?.length) {
      console.log("[pack_admin] Critic rejection (internal):", { reasons: result.criticReasons, suggestions: result.criticSuggestions });
    }

    // После пайплайна всегда показываем результат админу и три кнопки: Сохранить, Отменить, Переделать.
    if (result.spec && config.adminIds.includes(telegramId)) {
      const { error: updateErr } = await supabase
        .from("sessions")
        .update({
          pending_rejected_pack_spec: result.spec as any,
          pending_pack_plan: (result.plan ?? null) as any,
          pending_critic_suggestions: (result.criticSuggestions ?? []) as any,
          pending_critic_reasons: (result.criticReasons ?? []) as any,
        })
        .eq("id", session.id);
      if (updateErr) {
        console.error("[pack_admin] Failed to save pending pack to session:", session.id, updateErr.message, updateErr.code);
      }

      const summaryRaw =
        (lang === "ru" ? "Пак готов к согласованию.\n\n" : "Pack ready for approval.\n\n") +
        (result.ok
          ? (lang === "ru" ? "✅ Critic одобрил.\n\n" : "✅ Critic approved.\n\n")
          : (lang === "ru"
              ? "⚠️ Critic не одобрил (можно сохранить или переделать: фидбек Critic уйдёт агентам Captions/Scenes, те сгенерируют заново).\n\n"
              : "⚠️ Critic did not approve (you can save or rework: Critic feedback goes to Captions/Scenes agents for another iteration).\n\n")) +
        (lang === "ru" ? "ID: " : "ID: ") +
        result.spec.id +
        "\n" +
        (lang === "ru" ? "Название: " : "Name: ") +
        (lang === "ru" ? result.spec.name_ru : result.spec.name_en) +
        formatPackSpecPreview(result.spec, lang === "ru") +
        formatCriticBlock(result.criticReasons, result.criticSuggestions, lang === "ru");
      const summary = summaryRaw.length > 4090 ? summaryRaw.slice(0, 4087) + "…" : summaryRaw;

      const saveBtn = lang === "ru" ? "✅ Сохранить" : "✅ Save";
      const cancelBtn = lang === "ru" ? "❌ Отменить" : "❌ Cancel";
      const reworkBtn = lang === "ru" ? "🔄 Переделать" : "🔄 Rework";
      const sid = session.id;
      await ctx.telegram.editMessageText(ctx.chat!.id, (statusMsg as any).message_id, undefined, summary, {
        reply_markup: {
          inline_keyboard: [
            [{ text: saveBtn, callback_data: `pack_admin_pack_save:${sid}` }, { text: cancelBtn, callback_data: `pack_admin_pack_cancel:${sid}` }],
            [{ text: reworkBtn, callback_data: `pack_admin_pack_rework:${sid}` }],
          ],
        },
      }).catch(() => ctx.reply(summary));
      return;
    }

    if (!result.spec) {
      await ctx.telegram.editMessageText(ctx.chat!.id, (statusMsg as any).message_id, undefined, "❌ No spec returned.").catch(() => {});
      return;
    }

    const spec = await ensureUniquePackId(result.spec);
    const specToSave = await ensureSpecLabelsRu(spec);

    // subject_mode из сессии (по фото), иначе из spec: чтобы для 2 человек сохранялся multi.
    const sessionSubjectMode = getEffectiveSubjectMode(session);
    const subjectModeToSave = sessionSubjectMode !== "unknown" ? sessionSubjectMode : (specToSave.subject_mode ?? "any");

    const { error: insertErr } = await supabase.from(config.packContentSetsTable).insert({
      id: specToSave.id,
      pack_template_id: specToSave.pack_template_id,
      name_ru: specToSave.name_ru,
      name_en: specToSave.name_en,
      carousel_description_ru: specToSave.carousel_description_ru,
      carousel_description_en: specToSave.carousel_description_en,
      labels: specToSave.labels,
      labels_en: specToSave.labels_en,
      scene_descriptions: specToSave.scene_descriptions,
      sort_order: specToSave.sort_order,
      is_active: specToSave.is_active,
      mood: specToSave.mood,
      sticker_count: specToSave.sticker_count,
      subject_mode: subjectModeToSave,
      cluster: specToSave.cluster,
      segment_id: specToSave.segment_id,
    });

    if (insertErr) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        (statusMsg as any).message_id,
        undefined,
        (lang === "ru" ? "❌ Ошибка записи в БД: " : "❌ DB insert error: ") + insertErr.message
      ).catch(() => {});
      return;
    }

    clearPackContentSetsCache();

    const successText =
      (lang === "ru" ? "✅ Пак сохранён: " : "✅ Pack saved: ") +
      specToSave.id +
      (specToSave.id !== result.spec!.id ? ` (уникальный id: был ${result.spec!.id})` : "");
    await ctx.telegram.editMessageText(ctx.chat!.id, (statusMsg as any).message_id, undefined, successText).catch(() => ctx.reply(successText));
    return;
  }

  // === Pack states: ignore text input during pack flow ===
  if (session.state?.startsWith("wait_pack_") || session.state === "generating_pack_preview" || session.state === "generating_pack_theme" || session.state === "processing_pack") {
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
        if (result.text) await ctx.reply(result.text, getMainMenuKeyboard(lang, ctx?.from?.id));
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
            await ctx.reply(paramsPrompt, getMainMenuKeyboard(lang, ctx?.from?.id));
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
        if (r3.text) await ctx.reply(r3.text, getMainMenuKeyboard(lang, ctx?.from?.id));
      } else {
        const replyText = result.text || (lang === "ru"
          ? "Понял! Пришли фото для стикера 📸"
          : "Got it! Send me a photo for the sticker 📸");
        await ctx.reply(replyText, getMainMenuKeyboard(lang, ctx?.from?.id));
      }
    } catch (err: any) {
      console.error("Assistant wait_photo text AI error:", err.message);
      const reminder = lang === "ru"
        ? "Понял! А теперь пришли фото — из которого сделаем стикер 📸"
        : "Got it! Now send me a photo — I'll turn it into a sticker 📸";
      messages.push({ role: "assistant", content: reminder });

      await updateAssistantSession(aSession.id, { messages });

      await ctx.reply(reminder, getMainMenuKeyboard(lang, ctx?.from?.id));
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
                formatCallbackSessionRef(session.id, session.session_rev)
                  ? `assistant_confirm:${formatCallbackSessionRef(session.id, session.session_rev)}`
                  : "assistant_confirm"
              )],
            ])
          );
        } else if (action === "photo") {
          const hasPhotoNow = !!(session.current_photo_file_id || user.last_photo_file_id || updatedSession.pending_photo_file_id);
          if (hasPhotoNow) {
            // Guard: LLM may request photo due to stale context. Keep chat flow when photo exists.
            const guardReply = generateFallbackReply("normal", updatedSession, lang);
            messages[messages.length - 1] = { role: "assistant", content: guardReply };
            await updateAssistantSession(aSession.id, { messages });
            await ctx.reply(guardReply, getMainMenuKeyboard(lang, ctx?.from?.id));
          } else {
            // LLM wants a photo — switch state
            await supabase
              .from("sessions")
              .update({ state: "assistant_wait_photo", is_active: true })
              .eq("id", session.id);
            if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang, ctx?.from?.id));
          }
        } else if (action === "show_examples") {
          // Show style examples to help user choose
          const styleId = result.toolCall?.args?.style_id;
          await handleShowStyleExamples(ctx, styleId, lang);
          // Send LLM reply text after examples (if any)
          if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang, ctx?.from?.id));
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
              await ctx.reply(paramsPrompt, getMainMenuKeyboard(lang, ctx?.from?.id));
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
            if (reply2) await ctx.reply(reply2, getMainMenuKeyboard(lang, ctx?.from?.id));
          }
        } else {
          // Normal dialog step
          if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang, ctx?.from?.id));
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
        await ctx.reply(escapeMsg, getMainMenuKeyboard(lang, ctx?.from?.id));
      } else {
        // Level 2: soft fallback
        const retryMsg = lang === "ru"
          ? "Произошла ошибка, попробуй написать ещё раз."
          : "Something went wrong, please try again.";
        await ctx.reply(retryMsg, getMainMenuKeyboard(lang, ctx?.from?.id));
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
      const replyMarkup = await buildStickerButtons(lang, btnStickerId, {
        sessionId: session.id,
        sessionRev: session.session_rev,
      });

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

  // Legacy recovery: custom style flow is removed.
  if (session.state === "wait_custom_style" || session.state === "wait_custom_style_v2") {
    await supabase
      .from("sessions")
      .update({
        state: "wait_style",
        is_active: true,
        style_source_kind: "photo",
        session_rev: (session.session_rev || 1) + 1,
      })
      .eq("id", session.id);
    await sendStyleKeyboardFlat(ctx, lang);
    await ctx.reply(lang === "ru"
      ? "✍️ Свой стиль больше недоступен. Выбери стиль из списка."
      : "✍️ Custom style is no longer available. Please choose a style from the list.");
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
        ? "Нажми «Создать стикер», чтобы создать новый стикер."
        : "Tap «Create sticker» to create a new sticker.";
      await ctx.reply(msg, getMainMenuKeyboard(lang, ctx?.from?.id));
    }
    return;
  }

  const photos = Array.isArray(session.photos) ? session.photos : [];
  const currentPhotoId = session.current_photo_file_id || photos[photos.length - 1];
  if (!currentPhotoId) {
    await ctx.reply(await getText(lang, "photo.need_photo"));
    return;
  }

  // Custom free-text style is removed: user should pick a preset style.
  await sendStyleKeyboardFlat(ctx, lang);
  await ctx.reply(lang === "ru"
    ? "✍️ Текстовый ввод стиля отключен. Выбери стиль из списка кнопок."
    : "✍️ Text style input is disabled. Please choose a style from the preset list.");
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

    // Custom style flow is removed.
    if (preset.id === "custom") {
      const currentMessageId = (ctx.callbackQuery as any)?.message?.message_id as number | undefined;
      await sendStyleKeyboardFlat(ctx, lang, currentMessageId, { selectedStyleId: session.selected_style_id || null });
      await ctx.reply(lang === "ru"
        ? "✍️ Свой стиль больше недоступен. Выбери стиль из списка."
        : "✍️ Custom style is no longer available. Please choose a style from the list.");
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
    const styleSourceKind: "photo" | "sticker" =
      String(session?.style_source_kind || "").toLowerCase() === "sticker" && session?.last_sticker_file_id
        ? "sticker"
        : "photo";

    await startGeneration(ctx, user, session, lang, {
      generationType: "style",
      promptFinal: generatedPrompt,
      styleSourceKind,
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
    const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
    safeAnswerCbQuery(ctx, isRu ? "🎨 Открываю стиль..." : "🎨 Opening style...");
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const session = await getSessionForStyleSelection(user.id);
    if (!session?.id) {
      await rejectSessionEvent(ctx, lang, "style_preview", "session_not_found");
      return;
    }
    if (!["wait_style", "wait_pack_preview_payment"].includes(session.state)) {
      await rejectSessionEvent(ctx, lang, "style_preview", "wrong_state");
      return;
    }

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

    const sessionRef = formatCallbackSessionRef(session.id, session.session_rev);
    const applyCallback = appendSessionRefIfFits(`style_v2:${preset.id}`, sessionRef);
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
    const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
    safeAnswerCbQuery(ctx, isRu ? "↩️ Возвращаю список стилей..." : "↩️ Returning to style list...");
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
      await sendPackStyleSelectionStep(ctx, lang, session.selected_style_id, undefined, { useBackButton: true, sessionId: session.id });
    } else {
      await sendStyleKeyboardFlat(ctx, lang, undefined, { selectedStyleId: session?.selected_style_id || null });
    }
  } catch (err) {
    console.error("[StylePreview] back_to_style_list error:", err);
  }
});

// Callback: substyle selected (v2)
bot.action(/^style_v2:([^:]+)(?::(.+))?$/, async (ctx) => {
  try {
    const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
    safeAnswerCbQuery(ctx, isRu ? "✅ Применяю стиль..." : "✅ Applying style...");
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const styleId = ctx.match[1];
    const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);
    const session = await resolveSessionForCallback(
      user.id,
      explicitSessionId,
      () => getSessionForStyleSelection(user.id)
    );
    if (!session?.id) {
      await rejectSessionEvent(ctx, lang, "style_v2", "session_not_found");
      return;
    }
    if (session.state !== "wait_style" && session.state !== "wait_pack_preview_payment") {
      await rejectSessionEvent(ctx, lang, "style_v2", "wrong_state");
      return;
    }
    const strictRevEnabled = await isStrictSessionRevEnabled();
    if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
      await rejectSessionEvent(ctx, lang, "style_v2", "stale_callback");
      return;
    }
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
        .update({
          selected_style_id: preset.id,
          is_active: true,
          flow_kind: "pack",
          session_rev: (session.session_rev || 1) + 1,
        })
        .eq("id", session.id);
      await supabase
        .from("users")
        .update({ last_style_id: preset.id })
        .eq("id", user.id);
      try { await ctx.deleteMessage(); } catch {}
      await sendPackStyleSelectionStep(ctx, lang, preset.id, undefined, { useBackButton: true, sessionId: session.id });
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
    if (!session?.id) return;
    const currentMessageId = (ctx.callbackQuery as any)?.message?.message_id as number | undefined;
    await sendStyleKeyboardFlat(ctx, lang, currentMessageId, { selectedStyleId: session.selected_style_id || null });
    await ctx.reply(lang === "ru"
      ? "✍️ Свой стиль больше недоступен. Выбери стиль из списка."
      : "✍️ Custom style is no longer available. Please choose a style from the list.");
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
    await callTelegramBotMethodOrThrow("createNewStickerSet", {
      user_id: telegramId,
      name,
      title: packTitle,
      stickers: [{ sticker: fileId, format: "static", emoji_list: ["🔥"] }],
    });
    await supabase.from("users").update({ sticker_set_name: name }).eq("id", user.id);
    console.log("add_to_pack: sticker set created:", name);
  };

  try {
    if (!user.sticker_set_name) {
      // Create new sticker set
      try {
        const beforeSnap = await getStickerSetSnapshot(stickerSetName);
        const beforeCount = beforeSnap?.count ?? null;
        await createStickerSet(stickerSetName, sticker.telegram_file_id);
        const verify = await waitForStickerInSet(stickerSetName, sticker.telegram_file_id, beforeCount);
        if (!verify.ok) {
          console.warn(`add_to_pack: post-create visibility check failed, continue (set=${stickerSetName}, count=${verify.count ?? "unknown"})`);
        }
      } catch (createErr: any) {
        // If name is occupied, try with timestamp
        if (createErr.response?.data?.description?.includes("already occupied")) {
          console.log("add_to_pack: name occupied, trying with timestamp...");
          stickerSetName = `p2s_${telegramId}_${Date.now()}_by_${botUsername}`.toLowerCase();
          const beforeSnap = await getStickerSetSnapshot(stickerSetName);
          const beforeCount = beforeSnap?.count ?? null;
          await createStickerSet(stickerSetName, sticker.telegram_file_id);
          const verify = await waitForStickerInSet(stickerSetName, sticker.telegram_file_id, beforeCount);
          if (!verify.ok) {
            console.warn(`add_to_pack: post-create-retry visibility check failed, continue (set=${stickerSetName}, count=${verify.count ?? "unknown"})`);
          }
        } else {
          throw createErr;
        }
      }
    } else {
      // Add to existing sticker set
      console.log("add_to_pack: adding to existing set:", stickerSetName);
      try {
        const beforeSnap = await getStickerSetSnapshot(stickerSetName);
        const beforeCount = beforeSnap?.count ?? null;
        await callTelegramBotMethodOrThrow("addStickerToSet", {
          user_id: telegramId,
          name: stickerSetName,
          sticker: { sticker: sticker.telegram_file_id, format: "static", emoji_list: ["🔥"] },
        });
        const verify = await waitForStickerInSet(stickerSetName, sticker.telegram_file_id, beforeCount);
        if (!verify.ok) {
          console.warn(`add_to_pack: post-add visibility check failed, continue (set=${stickerSetName}, count=${verify.count ?? "unknown"})`);
        }
        console.log("add_to_pack: sticker added to existing set");
      } catch (addErr: any) {
        const desc = (addErr.response?.data?.description || "").toLowerCase();
        // Pack was deleted or invalid — auto-recover by creating a new one
        if (desc.includes("stickerset_invalid") || desc.includes("sticker_set_invalid") || desc.includes("not found")) {
          console.log("add_to_pack: set invalid/deleted, recreating. Old:", stickerSetName);
          stickerSetName = `p2s_${telegramId}_by_${botUsername}`.toLowerCase();
          try {
            const beforeSnap = await getStickerSetSnapshot(stickerSetName);
            const beforeCount = beforeSnap?.count ?? null;
            await createStickerSet(stickerSetName, sticker.telegram_file_id);
            const verify = await waitForStickerInSet(stickerSetName, sticker.telegram_file_id, beforeCount);
            if (!verify.ok) {
              console.warn(`add_to_pack: post-recreate visibility check failed, continue (set=${stickerSetName}, count=${verify.count ?? "unknown"})`);
            }
          } catch (recreateErr: any) {
            if (recreateErr.response?.data?.description?.includes("already occupied")) {
              stickerSetName = `p2s_${telegramId}_${Date.now()}_by_${botUsername}`.toLowerCase();
              const beforeSnap = await getStickerSetSnapshot(stickerSetName);
              const beforeCount = beforeSnap?.count ?? null;
              await createStickerSet(stickerSetName, sticker.telegram_file_id);
              const verify = await waitForStickerInSet(stickerSetName, sticker.telegram_file_id, beforeCount);
              if (!verify.ok) {
                console.warn(`add_to_pack: post-recreate-retry visibility check failed, continue (set=${stickerSetName}, count=${verify.count ?? "unknown"})`);
              }
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
  if (await isSessionRouterEnabled()) {
    await rejectSessionEvent(ctx, lang, "add_to_pack_legacy", "session_not_found");
    return;
  }
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
    await callTelegramBotMethodOrThrow("createNewStickerSet", {
      user_id: telegramId,
      name,
      title: packTitle,
      stickers: [{ sticker: fileId, format: "static", emoji_list: ["🔥"] }],
    });
    await supabase.from("users").update({ sticker_set_name: name }).eq("id", user.id);
    console.log("add_to_pack(old): sticker set created:", name);
  };

  try {
    if (!user.sticker_set_name) {
      try {
        const beforeSnap = await getStickerSetSnapshot(stickerSetName);
        const beforeCount = beforeSnap?.count ?? null;
        await createStickerSet(stickerSetName, session.last_sticker_file_id);
        const verify = await waitForStickerInSet(stickerSetName, session.last_sticker_file_id, beforeCount);
        if (!verify.ok) {
          console.warn(`add_to_pack(old): post-create visibility check failed, continue (set=${stickerSetName}, count=${verify.count ?? "unknown"})`);
        }
      } catch (createErr: any) {
        if (createErr.response?.data?.description?.includes("already occupied")) {
          console.log("add_to_pack(old): name occupied, trying with timestamp...");
          stickerSetName = `p2s_${telegramId}_${Date.now()}_by_${botUsername}`.toLowerCase();
          const beforeSnap = await getStickerSetSnapshot(stickerSetName);
          const beforeCount = beforeSnap?.count ?? null;
          await createStickerSet(stickerSetName, session.last_sticker_file_id);
          const verify = await waitForStickerInSet(stickerSetName, session.last_sticker_file_id, beforeCount);
          if (!verify.ok) {
            console.warn(`add_to_pack(old): post-create-retry visibility check failed, continue (set=${stickerSetName}, count=${verify.count ?? "unknown"})`);
          }
        } else {
          throw createErr;
        }
      }
    } else {
      console.log("add_to_pack(old): adding to existing set:", stickerSetName);
      try {
        const beforeSnap = await getStickerSetSnapshot(stickerSetName);
        const beforeCount = beforeSnap?.count ?? null;
        await callTelegramBotMethodOrThrow("addStickerToSet", {
          user_id: telegramId,
          name: stickerSetName,
          sticker: { sticker: session.last_sticker_file_id, format: "static", emoji_list: ["🔥"] },
        });
        const verify = await waitForStickerInSet(stickerSetName, session.last_sticker_file_id, beforeCount);
        if (!verify.ok) {
          console.warn(`add_to_pack(old): post-add visibility check failed, continue (set=${stickerSetName}, count=${verify.count ?? "unknown"})`);
        }
        console.log("add_to_pack(old): sticker added to existing set");
      } catch (addErr: any) {
        const desc = (addErr.response?.data?.description || "").toLowerCase();
        if (desc.includes("stickerset_invalid") || desc.includes("sticker_set_invalid") || desc.includes("not found")) {
          console.log("add_to_pack(old): set invalid/deleted, recreating. Old:", stickerSetName);
          stickerSetName = `p2s_${telegramId}_by_${botUsername}`.toLowerCase();
          try {
            const beforeSnap = await getStickerSetSnapshot(stickerSetName);
            const beforeCount = beforeSnap?.count ?? null;
            await createStickerSet(stickerSetName, session.last_sticker_file_id);
            const verify = await waitForStickerInSet(stickerSetName, session.last_sticker_file_id, beforeCount);
            if (!verify.ok) {
              console.warn(`add_to_pack(old): post-recreate visibility check failed, continue (set=${stickerSetName}, count=${verify.count ?? "unknown"})`);
            }
          } catch (recreateErr: any) {
            if (recreateErr.response?.data?.description?.includes("already occupied")) {
              stickerSetName = `p2s_${telegramId}_${Date.now()}_by_${botUsername}`.toLowerCase();
              const beforeSnap = await getStickerSetSnapshot(stickerSetName);
              const beforeCount = beforeSnap?.count ?? null;
              await createStickerSet(stickerSetName, session.last_sticker_file_id);
              const verify = await waitForStickerInSet(stickerSetName, session.last_sticker_file_id, beforeCount);
              if (!verify.ok) {
                console.warn(`add_to_pack(old): post-recreate-retry visibility check failed, continue (set=${stickerSetName}, count=${verify.count ?? "unknown"})`);
              }
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
bot.action(/^change_style:([^:]+)(?::(.+))?$/, async (ctx) => {
  console.log("=== change_style:ID callback ===");
  console.log("callback_data:", ctx.match?.[0]);
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);
  console.log("stickerId:", stickerId);

  // Get sticker from DB by ID
  const { data: sticker } = await supabase
    .from("stickers")
    .select("source_photo_file_id, telegram_file_id, user_id")
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

  // Get or create active session.
  // For sticker-targeted callbacks we can recover safely without explicit session_id,
  // because sticker ownership is already validated above.
  let session = explicitSessionId
    ? await getSessionByIdForUser(user.id, explicitSessionId)
    : await getActiveSession(user.id);
  if (!session?.id) {
    const { data: newSession, error: createSessionErr } = await supabase
      .from("sessions")
      .insert({
        user_id: user.id,
        state: "wait_style",
        is_active: true,
        flow_kind: "single",
        session_rev: 1,
        style_source_kind: "sticker",
        env: config.appEnv,
      })
      .select()
      .single();
    if (createSessionErr) {
      console.error("[change_style] failed to create session:", createSessionErr.message);
      await ctx.reply(await getText(lang, "error.technical"));
      return;
    }
    session = newSession;
  }

  if (!session?.id) return;
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "change_style", "stale_callback");
    return;
  }

  const sourcePhotoId = String(sticker.source_photo_file_id || "");
  const restoredPhotoFileId = sourcePhotoId.startsWith("AgAC")
    ? sourcePhotoId
    : (user.last_photo_file_id || null);
  if (!restoredPhotoFileId) {
    await ctx.reply(await getText(lang, "photo.need_photo"));
    return;
  }

  const nextRev = (session.session_rev || 1) + 1;
  await supabase
    .from("sessions")
    .update({
      state: "wait_style",
      is_active: true,
      current_photo_file_id: restoredPhotoFileId,
      last_sticker_file_id: sticker.telegram_file_id || session.last_sticker_file_id || null,
      style_source_kind: "sticker",
      prompt_final: null,
      user_input: null,
      pending_generation_type: null,
      selected_emotion: null,
      emotion_prompt: null,
      session_rev: nextRev,
    })
    .eq("id", session.id);

  const sessionRef = formatCallbackSessionRef(session.id, nextRev);
  const backCb = appendSessionRefIfFits(`back_to_sticker_menu:${stickerId}`, sessionRef);
  const currentMessageId = (ctx.callbackQuery as any)?.message?.message_id as number | undefined;
  await sendStyleKeyboardFlat(ctx, lang, currentMessageId, {
    selectedStyleId: session.selected_style_id || null,
    extraButtons: [[{ text: lang === "ru" ? "↩️ Назад" : "↩️ Back", callback_data: backCb }]],
  });
});

// Callback: change style (old format - fallback)
bot.action("change_style", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  if (await isSessionRouterEnabled()) {
    await rejectSessionEvent(ctx, lang, "change_style_legacy", "session_not_found");
    return;
  }
  const session = await getActiveSession(user.id);
  if (!session?.id) return;

  await supabase
    .from("sessions")
    .update({
      state: "wait_style",
      is_active: true,
      style_source_kind: "photo",
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
bot.action(/^change_emotion:([^:]+)(?::(.+))?$/, async (ctx) => {
  console.log("=== change_emotion:ID callback ===");
  console.log("callback_data:", ctx.match?.[0]);
  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  safeAnswerCbQuery(ctx, isRu ? "😊 Открываю эмоции..." : "😊 Opening emotions...");
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
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

  // Get or create active session.
  // For sticker-targeted callbacks we can recover safely without explicit session_id,
  // because sticker ownership is already validated above.
  let session = explicitSessionId
    ? await getSessionByIdForUser(user.id, explicitSessionId)
    : await getActiveSession(user.id);
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_emotion", is_active: true, flow_kind: "single", session_rev: 1, env: config.appEnv })
      .select()
      .single();
    session = newSession;
  }

  if (!session?.id) return;
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "change_emotion", "stale_callback");
    return;
  }

  await supabase
    .from("sessions")
    .update({
      state: "wait_emotion",
      is_active: true,
      flow_kind: "single",
      session_rev: (session.session_rev || 1) + 1,
      last_sticker_file_id: sticker.telegram_file_id,
      current_photo_file_id: sticker.source_photo_file_id,
      pending_generation_type: null,
    })
    .eq("id", session.id);

  const messageId = (ctx.callbackQuery as any)?.message?.message_id as number | undefined;
  const sessionRef = formatCallbackSessionRef(session.id, (session.session_rev || 1) + 1);
  const backCb = appendSessionRefIfFits(`back_to_sticker_menu:${stickerId}`, sessionRef);
  await sendEmotionKeyboard(ctx, lang, {
    sessionId: session.id,
    sessionRev: (session.session_rev || 1) + 1,
    messageId,
    backCallbackData: backCb,
  });
});

// Callback: change emotion (old format - fallback)
bot.action("change_emotion", async (ctx) => {
  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  safeAnswerCbQuery(ctx, isRu ? "😊 Открываю эмоции..." : "😊 Opening emotions...");
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  if (await isSessionRouterEnabled()) {
    await rejectSessionEvent(ctx, lang, "change_emotion_legacy", "session_not_found");
    return;
  }
  const session = await getActiveSession(user.id);
  if (!session?.last_sticker_file_id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  await supabase
    .from("sessions")
    .update({
      state: "wait_emotion",
      is_active: true,
      pending_generation_type: null,
      flow_kind: "single",
      session_rev: (session.session_rev || 1) + 1,
    })
    .eq("id", session.id);

  await sendEmotionKeyboard(ctx, lang, {
    sessionId: session.id,
    sessionRev: (session.session_rev || 1) + 1,
  });
});

// Callback: emotion selection (не матчим emotion_make_example — тот обрабатывается отдельно в алертах)
bot.action(/^emotion_(?!make_example)([^:]+)(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const emotionId = ctx.match[1];
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "emotion_select", "session_not_found");
    return;
  }
  if (session.state !== "wait_emotion" || !session.last_sticker_file_id) {
    await rejectSessionEvent(ctx, lang, "emotion_select", "wrong_state");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "emotion_select", "stale_callback");
    return;
  }
  const presets = await getEmotionPresets();
  const preset = presets.find((p) => p.id === emotionId);
  if (!preset) return;

  if (preset.id === "custom") {
    await supabase
      .from("sessions")
      .update({
        state: "wait_custom_emotion",
        is_active: true,
        flow_kind: "single",
        session_rev: (session.session_rev || 1) + 1,
      })
      .eq("id", session.id);
    await ctx.reply(await getText(lang, "emotion.custom_prompt"));
    return;
  }

  const earlyMsgId = await sendEarlyProgress(ctx, lang);
  const emotionTemplate = await getPromptTemplate("emotion");
  const promptFinal = buildPromptFromTemplate(emotionTemplate, preset.prompt_hint);
  await startGeneration(ctx, user, session, lang, {
    generationType: "emotion",
    promptFinal,
    emotionPrompt: preset.prompt_hint,
    selectedEmotion: preset.id,
    earlyProgressMessageId: earlyMsgId,
  });
});

// Callback: change motion (new format with sticker ID)
bot.action(/^change_motion:([^:]+)(?::(.+))?$/, async (ctx) => {
  console.log("=== change_motion:ID callback ===");
  console.log("callback_data:", ctx.match?.[0]);
  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  safeAnswerCbQuery(ctx, isRu ? "🏃 Открываю движения..." : "🏃 Opening motions...");
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);
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

  // Get or create active session.
  // For sticker-targeted callbacks we can recover safely without explicit session_id,
  // because sticker ownership is already validated above.
  let session = explicitSessionId
    ? await getSessionByIdForUser(user.id, explicitSessionId)
    : await getActiveSession(user.id);
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_motion", is_active: true, flow_kind: "single", session_rev: 1, env: config.appEnv })
      .select()
      .single();
    session = newSession;
  }

  if (!session?.id) return;
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "change_motion", "stale_callback");
    return;
  }

  await supabase
    .from("sessions")
    .update({
      state: "wait_motion",
      is_active: true,
      flow_kind: "single",
      session_rev: (session.session_rev || 1) + 1,
      last_sticker_file_id: sticker.telegram_file_id,
      current_photo_file_id: sticker.source_photo_file_id,
      pending_generation_type: null,
    })
    .eq("id", session.id);

  const messageId = (ctx.callbackQuery as any)?.message?.message_id as number | undefined;
  const sessionRef = formatCallbackSessionRef(session.id, (session.session_rev || 1) + 1);
  const backCb = appendSessionRefIfFits(`back_to_sticker_menu:${stickerId}`, sessionRef);
  await sendMotionKeyboard(ctx, lang, {
    sessionId: session.id,
    sessionRev: (session.session_rev || 1) + 1,
    messageId,
    backCallbackData: backCb,
  });
});

// Callback: back from submenu to the sticker action menu
bot.action(/^back_to_sticker_menu:([^:]+)(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);

  const { data: sticker } = await supabase
    .from("stickers")
    .select("id, user_id")
    .eq("id", stickerId)
    .maybeSingle();
  if (!sticker?.id || sticker.user_id !== user.id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  const session = explicitSessionId ? await getSessionByIdForUser(user.id, explicitSessionId) : await getActiveSession(user.id);
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && session?.id && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "back_to_sticker_menu", "stale_callback");
    return;
  }

  const replyMarkup = await buildStickerButtons(lang, stickerId, {
    sessionId: session?.id || null,
    sessionRev: Number(session?.session_rev || 1),
  });
  const menuText = await getText(lang, "edit.what_to_do");
  const messageId = (ctx.callbackQuery as any)?.message?.message_id as number | undefined;
  const chatId = (ctx.callbackQuery as any)?.message?.chat?.id as number | undefined;
  if (chatId && messageId) {
    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, menuText, { reply_markup: replyMarkup });
      return;
    } catch (err: any) {
      console.warn("[back_to_sticker_menu] edit failed, fallback to reply:", err?.message || err);
    }
  }
  await ctx.reply(menuText, { reply_markup: replyMarkup });
});

// Callback: change motion (old format - fallback)
bot.action("change_motion", async (ctx) => {
  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  safeAnswerCbQuery(ctx, isRu ? "🏃 Открываю движения..." : "🏃 Opening motions...");
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  if (await isSessionRouterEnabled()) {
    await rejectSessionEvent(ctx, lang, "change_motion_legacy", "session_not_found");
    return;
  }
  const session = await getActiveSession(user.id);
  if (!session?.last_sticker_file_id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  await supabase
    .from("sessions")
    .update({
      state: "wait_motion",
      is_active: true,
      pending_generation_type: null,
      flow_kind: "single",
      session_rev: (session.session_rev || 1) + 1,
    })
    .eq("id", session.id);

  await sendMotionKeyboard(ctx, lang, {
    sessionId: session.id,
    sessionRev: (session.session_rev || 1) + 1,
  });
});

// Callback: motion selection
bot.action(/^motion_([^:]+)(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const motionId = ctx.match[1];
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "motion_select", "session_not_found");
    return;
  }
  if (session.state !== "wait_motion" || !session.last_sticker_file_id) {
    await rejectSessionEvent(ctx, lang, "motion_select", "wrong_state");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "motion_select", "stale_callback");
    return;
  }
  const presets = await getMotionPresets();
  const preset = presets.find((p) => p.id === motionId);
  if (!preset) return;

  if (preset.id === "custom") {
    await supabase
      .from("sessions")
      .update({
        state: "wait_custom_motion",
        is_active: true,
        flow_kind: "single",
        session_rev: (session.session_rev || 1) + 1,
      })
      .eq("id", session.id);
    await ctx.reply(await getText(lang, "motion.custom_prompt"));
    return;
  }

  const earlyMsgId = await sendEarlyProgress(ctx, lang);
  const motionTemplate = await getPromptTemplate("motion");
  const promptFinal = buildPromptFromTemplate(motionTemplate, preset.prompt_hint);
  await startGeneration(ctx, user, session, lang, {
    generationType: "motion",
    promptFinal,
    emotionPrompt: preset.prompt_hint,
    selectedEmotion: preset.id,
    earlyProgressMessageId: earlyMsgId,
  });
});

// ========== Action menu callbacks (from wait_action) ==========
async function handleActionMenuCallback(ctx: any, action: "photo_sticker" | "remove_bg" | "replace_face" | "make_sticker" | "make_pack") {
  safeAnswerCbQuery(ctx);
  const traceId = getOrCreateTraceId(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  // action_* callbacks have a single optional capture group with sessionRef
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId, undefined, traceId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, `action_${action}`, "session_not_found");
    return;
  }
  const hardProcessingStates = new Set(["processing", "processing_emotion", "processing_motion", "processing_text", "generating_pack_preview", "generating_pack_theme", "processing_pack"]);
  const replaceFaceAllowedStates = new Set(["wait_action", "wait_style", "confirm_sticker", "wait_emotion", "wait_motion", "wait_text_overlay", "wait_replace_face", "wait_replace_face_sticker"]);
  if (
    (action !== "replace_face" && session.state !== "wait_action")
    || (action === "replace_face" && (!replaceFaceAllowedStates.has(String(session.state || "")) || hardProcessingStates.has(String(session.state || ""))))
  ) {
    await rejectSessionEvent(ctx, lang, `action_${action}`, "wrong_state");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, `action_${action}`, "stale_callback");
    return;
  }

  const photoFileId = session.current_photo_file_id || null;
  if (!photoFileId) {
    await ctx.reply(await getText(lang, "photo.need_photo"));
    return;
  }

  const nextRev = (session.session_rev || 1) + 1;

  if (action === "photo_sticker" || action === "remove_bg") {
    const isRu = lang === "ru";
    try {
      await ctx.reply(isRu ? "⏳ Убираю фон..." : "⏳ Removing background...");
      const filePath = await getFilePath(photoFileId);
      const fileBuffer = await downloadFile(filePath);
      const pngBuffer = await sharp(fileBuffer).png().toBuffer();
      const pixianForm = new FormData();
      pixianForm.append("image", pngBuffer, { filename: "image.png", contentType: "image/png" });
      const pixianRes = await axios.post("https://api.pixian.ai/api/v2/remove-background", pixianForm, {
        auth: { username: config.pixianUsername, password: config.pixianPassword },
        headers: pixianForm.getHeaders(),
        responseType: "arraybuffer",
        timeout: 60000,
      });
      const noBgBuffer = Buffer.from(pixianRes.data);
      const stickerBuffer = await sharp(noBgBuffer)
        .trim({ threshold: 2 })
        .resize(482, 482, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .extend({ top: 15, bottom: 15, left: 15, right: 15, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 95 })
        .toBuffer();
      const newFileId = await sendSticker(ctx.chat!.id, stickerBuffer);
      const insertPayload: any = {
        user_id: user.id,
        session_id: session.id,
        telegram_file_id: newFileId || null,
        source_photo_file_id: photoFileId,
        generation_type: "photo_sticker",
        env: config.appEnv,
      };

      let newSticker: { id: string } | null = null;
      let insertErr: any = null;
      const firstInsert = await supabase.from("stickers").insert(insertPayload).select("id").single();
      newSticker = firstInsert.data as { id: string } | null;
      insertErr = firstInsert.error;

      // Backward-compat: generation_type enum/value may differ between envs.
      if (insertErr && (String(insertErr.message || "").toLowerCase().includes("generation_type") || String(insertErr.message || "").toLowerCase().includes("invalid input value for enum"))) {
        insertPayload.generation_type = "remove_bg";
        const fallbackInsert = await supabase.from("stickers").insert(insertPayload).select("id").single();
        newSticker = fallbackInsert.data as { id: string } | null;
        insertErr = fallbackInsert.error;
      }
      if (insertErr && (String(insertErr.message || "").toLowerCase().includes("generation_type") || insertErr.code === "42703")) {
        delete insertPayload.generation_type;
        const lastInsert = await supabase.from("stickers").insert(insertPayload).select("id").single();
        newSticker = lastInsert.data as { id: string } | null;
        insertErr = lastInsert.error;
      }
      if (insertErr || !newSticker?.id) {
        console.error("[action_photo_sticker] failed to save sticker row:", insertErr?.message || insertErr);
        await ctx.reply(await getText(lang, "error.technical"));
        return;
      }

      if (newFileId) {
        await supabase.from("stickers").update({ telegram_file_id: newFileId }).eq("id", newSticker.id);
      }
      const replyMarkup = await buildStickerButtons(lang, newSticker.id);
      await ctx.reply(lang === "ru" ? "Фон удалён! Что дальше?" : "Background removed! What's next?", { reply_markup: replyMarkup });
    } catch (err: any) {
      console.error("[action_remove_bg] failed:", err?.message || err);
      await ctx.reply(lang === "ru" ? "❌ Не удалось убрать фон. Попробуй ещё раз." : "❌ Failed to remove background. Try again.");
    }
    return;
  }

  if (action === "replace_face") {
    const { data: beforeSessions } = await supabase
      .from("sessions")
      .select("id,state,is_active,flow_kind,session_rev,created_at,updated_at,current_photo_file_id,edit_replace_sticker_id")
      .eq("user_id", user.id)
      .eq("env", config.appEnv)
      .order("created_at", { ascending: false })
      .limit(8);
    console.log("[replace_face.debug][action_replace_face.before]", {
      trace_id: traceId,
      userId: user.id,
      explicitSessionId,
      callbackRev,
      session: sessionTraceSnapshot(session),
      sessions: (beforeSessions || []).map((s: any) => ({
        id: s.id,
        state: s.state,
        is_active: s.is_active,
        flow_kind: s.flow_kind,
        session_rev: s.session_rev,
        current_photo_file_id: s.current_photo_file_id ? "set" : null,
        edit_replace_sticker_id: s.edit_replace_sticker_id || null,
        created_at: s.created_at || null,
        updated_at: s.updated_at || null,
      })),
    });

    // Canonical replace-face entrypoint:
    // always create a fresh wait_replace_face session from latest known photo.
    // This avoids stale callback session ids hijacking the flow.
    const latestSessionPhotoFileId = await getLatestSessionPhotoFileId(user.id);
    const candidatePhotoFileId =
      session.current_photo_file_id
      || (Array.isArray(session.photos) && session.photos.length > 0 ? session.photos[session.photos.length - 1] : null)
      || latestSessionPhotoFileId
      || user.last_photo_file_id
      || null;
    if (!candidatePhotoFileId) {
      await ctx.reply(await getText(lang, "photo.need_photo"));
      return;
    }

    const { error: deactivateErr } = await supabase
      .from("sessions")
      .update({ is_active: false })
      .eq("user_id", user.id)
      .eq("env", config.appEnv);
    const { data: createdReplaceSession, error: createErr } = await supabase
      .from("sessions")
      .insert({
        user_id: user.id,
        state: "wait_replace_face_sticker",
        edit_replace_sticker_id: null,
        is_active: true,
        flow_kind: "single",
        session_rev: 1,
        current_photo_file_id: candidatePhotoFileId,
        photos: [candidatePhotoFileId],
        env: config.appEnv,
      })
      .select("id,state,is_active,flow_kind,session_rev,current_photo_file_id,edit_replace_sticker_id,created_at,updated_at")
      .single();
    if (createErr || !createdReplaceSession?.id) {
      console.error("[replace_face.debug][action_replace_face.create_failed]", {
        trace_id: traceId,
        userId: user.id,
        createErr: createErr?.message || null,
      });
      await ctx.reply(await getText(lang, "error.technical"));
      return;
    }

    const { data: afterSessions } = await supabase
      .from("sessions")
      .select("id,state,is_active,flow_kind,session_rev,created_at,updated_at,current_photo_file_id,edit_replace_sticker_id")
      .eq("user_id", user.id)
      .eq("env", config.appEnv)
      .order("created_at", { ascending: false })
      .limit(8);
    console.log("[replace_face.debug][action_replace_face.after]", {
      trace_id: traceId,
      userId: user.id,
      deactivateErr: deactivateErr?.message || null,
      promoteErr: null,
      expectedSessionId: createdReplaceSession.id,
      expectedNextRev: 1,
      sessionAfter: createdReplaceSession
        ? {
            id: createdReplaceSession.id,
            state: createdReplaceSession.state,
            is_active: createdReplaceSession.is_active,
            flow_kind: createdReplaceSession.flow_kind,
            session_rev: createdReplaceSession.session_rev,
            current_photo_file_id: createdReplaceSession.current_photo_file_id ? "set" : null,
            edit_replace_sticker_id: createdReplaceSession.edit_replace_sticker_id || null,
            created_at: createdReplaceSession.created_at || null,
            updated_at: createdReplaceSession.updated_at || null,
          }
        : null,
      sessions: (afterSessions || []).map((s: any) => ({
        id: s.id,
        state: s.state,
        is_active: s.is_active,
        flow_kind: s.flow_kind,
        session_rev: s.session_rev,
        current_photo_file_id: s.current_photo_file_id ? "set" : null,
        edit_replace_sticker_id: s.edit_replace_sticker_id || null,
        created_at: s.created_at || null,
        updated_at: s.updated_at || null,
      })),
    });

    await ctx.reply(await getText(lang, "action.replace_face_send_sticker"));
    return;
  }

  if (action === "make_sticker") {
    await supabase
      .from("sessions")
      .update({
        state: "wait_style",
        is_active: true,
        flow_kind: "single",
        style_source_kind: "photo",
        session_rev: nextRev,
      })
      .eq("id", session.id);
    await sendStyleKeyboardFlat(ctx, lang, undefined, { selectedStyleId: session.selected_style_id || null });
    return;
  }

  if (action === "make_pack") {
    await supabase.from("users").update({ last_photo_file_id: photoFileId }).eq("id", user.id);
    await handlePackMenuEntry(ctx, { source: "menu", autoPackEntry: false });
    return;
  }
}

bot.action(/^action_photo_sticker(?::(.+))?$/, (ctx) => handleActionMenuCallback(ctx, "photo_sticker"));
// Legacy alias for already sent buttons
bot.action(/^action_remove_bg(?::(.+))?$/, (ctx) => handleActionMenuCallback(ctx, "remove_bg"));
bot.action(/^action_replace_face(?::(.+))?$/, (ctx) => handleActionMenuCallback(ctx, "replace_face"));
bot.action(/^action_make_sticker(?::(.+))?$/, (ctx) => handleActionMenuCallback(ctx, "make_sticker"));
bot.action(/^action_make_pack(?::(.+))?$/, (ctx) => handleActionMenuCallback(ctx, "make_pack"));

// Callback: replace face in sticker (use user's latest photo as identity source)
bot.action(/^replace_face:([^:]+)(?::(.+))?$/, async (ctx) => {
  const traceId = getOrCreateTraceId(ctx);
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const stickerId = ctx.match[1];
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);
  console.log("[replace_face.debug][replace_face_callback.entry]", {
    trace_id: traceId,
    telegramId,
    userId: user.id,
    stickerId,
    explicitSessionId: explicitSessionId || null,
    callbackRev: callbackRev ?? null,
    rawCallbackData: (ctx.callbackQuery as any)?.data || null,
  });

  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, source_photo_file_id, user_id, style_preset_id")
    .eq("id", stickerId)
    .maybeSingle();
  if (!sticker?.telegram_file_id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }
  if (sticker.user_id !== user.id) return;

  let session = explicitSessionId
    ? await getSessionByIdForUser(user.id, explicitSessionId, traceId)
    : await getActiveSession(user.id, traceId);
  if (!session?.id) {
    // Fallback: callback_data often exceeds 64 chars (replace_face:uuid:uuid:rev) so session ref is dropped
    const { data: fallbackSession, error: fallbackSessionErr } = await supabase
      .from("sessions")
      .select("*")
      .eq("user_id", user.id)
      .eq("env", config.appEnv)
      .in("state", ["wait_replace_face_sticker", "wait_action", "wait_edit_sticker"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (fallbackSessionErr) {
      console.error("[replace_face.debug][replace_face_callback.fallback_query_error]", {
        trace_id: traceId,
        userId: user.id,
        error: fallbackSessionErr.message,
        code: (fallbackSessionErr as any)?.code || null,
      });
    }
    if (fallbackSession?.id) {
      session = fallbackSession;
    }
  }
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_replace_face_sticker", is_active: true, flow_kind: "single", session_rev: 1, env: config.appEnv })
      .select()
      .single();
    session = newSession;
  }
  if (!session?.id) return;
  console.log("[replace_face.debug][replace_face_callback.session]", {
    trace_id: traceId,
    userId: user.id,
    session: sessionTraceSnapshot(session),
    sessionCurrentPhoto: session.current_photo_file_id ? "set" : null,
    sessionPhotosCount: Array.isArray(session.photos) ? session.photos.length : 0,
    userLastPhoto: user.last_photo_file_id ? "set" : null,
  });
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "replace_face", "stale_callback");
    return;
  }

  const identityPhotoFileId = session.current_photo_file_id
    || (Array.isArray(session.photos) && session.photos.length > 0 ? session.photos[session.photos.length - 1] : null)
    || user.last_photo_file_id || null;

  if (!identityPhotoFileId) {
    await ctx.reply(await getText(lang, "edit.replace_face_no_photo"));
    return;
  }

  const nextRev = (session.session_rev || 1) + 1;
  await supabase
    .from("sessions")
    .update({ is_active: false })
    .eq("user_id", user.id)
    .eq("env", config.appEnv)
    .neq("id", session.id);
  await supabase
    .from("sessions")
    .update({
      state: "wait_replace_face_sticker",
      is_active: true,
      flow_kind: "single",
      edit_replace_sticker_id: stickerId,
      last_sticker_file_id: sticker.telegram_file_id,
      current_photo_file_id: identityPhotoFileId,
      selected_style_id: sticker.style_preset_id || session.selected_style_id || null,
      session_rev: nextRev,
    })
    .eq("id", session.id);

  const { data: freshSession } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", session.id)
    .maybeSingle();
  const patchedSession = freshSession || {
    ...session,
    current_photo_file_id: identityPhotoFileId,
    last_sticker_file_id: sticker.telegram_file_id,
    edit_replace_sticker_id: stickerId,
    selected_style_id: sticker.style_preset_id || session.selected_style_id || null,
    session_rev: nextRev,
  };

  const replacePrompt =
    "You are given two references: (1) identity photo, (2) sticker reference. " +
    "Generate one sticker with identity from photo and pose/expression/style from sticker reference. " +
    "Keep one subject only, preserve the same vibe and composition, no text, no borders or outlines.";

  const earlyMsgId = await sendEarlyProgress(ctx, lang);
  await startGeneration(ctx, user, patchedSession, lang, {
    generationType: "replace_subject",
    promptFinal: replacePrompt,
    selectedStyleId: sticker.style_preset_id || session.selected_style_id || null,
    userInput: lang === "ru" ? "Замена лица в стикере" : "Replace face in sticker",
    earlyProgressMessageId: earlyMsgId,
  });
});

// Callback: remove background from sticker (edit-sticker flow)
bot.action(/^remove_bg:([^:]+)(?::(.+))?$/, async (ctx) => {
  console.log("=== remove_bg:ID callback ===");
  const isRu = (ctx.from?.language_code || "").toLowerCase().startsWith("ru");
  safeAnswerCbQuery(ctx, isRu ? "🖼 Убираю фон..." : "🖼 Removing background...");
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const stickerId = ctx.match[1];

  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  if (!sticker?.telegram_file_id) {
    await ctx.reply(lang === "ru" ? "Стикер не найден." : "Sticker not found.");
    return;
  }
  if (sticker.user_id !== user.id) return;

  try {
    await ctx.reply(lang === "ru" ? "⏳ Убираю фон..." : "⏳ Removing background...");

    const filePath = await getFilePath(sticker.telegram_file_id);
    const fileBuffer = await downloadFile(filePath);
    const imageSizeKb = Math.round(fileBuffer.length / 1024);

    const pngBuffer = await sharp(fileBuffer).png().toBuffer();

    console.log(`[remove_bg] Calling Pixian, size: ${imageSizeKb} KB`);
    const pixianForm = new FormData();
    pixianForm.append("image", pngBuffer, { filename: "image.png", contentType: "image/png" });

    const pixianRes = await axios.post("https://api.pixian.ai/api/v2/remove-background", pixianForm, {
      auth: { username: config.pixianUsername, password: config.pixianPassword },
      headers: pixianForm.getHeaders(),
      responseType: "arraybuffer",
      timeout: 60000,
    });

    const noBgBuffer = Buffer.from(pixianRes.data);
    console.log(`[remove_bg] Pixian success, result: ${Math.round(noBgBuffer.length / 1024)} KB`);

    const stickerBuffer = await sharp(noBgBuffer)
      .trim({ threshold: 2 })
      .resize(482, 482, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .extend({ top: 15, bottom: 15, left: 15, right: 15, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 95 })
      .toBuffer();

    const newFileId = await sendSticker(ctx.chat!.id, stickerBuffer);

    const { data: newSticker } = await supabase
      .from("stickers")
      .insert({
        user_id: user.id,
        telegram_file_id: newFileId || null,
        source_photo_file_id: sticker.telegram_file_id,
        generation_type: "remove_bg",
        env: config.appEnv,
      })
      .select("id")
      .single();

    if (newSticker?.id && newFileId) {
      await supabase.from("stickers").update({ telegram_file_id: newFileId }).eq("id", newSticker.id);
    }

    const replyMarkup = await buildStickerButtons(lang, newSticker?.id || stickerId);
    await ctx.reply(lang === "ru" ? "Фон удалён! Что дальше?" : "Background removed! What's next?", { reply_markup: replyMarkup });
  } catch (err: any) {
    console.error("[remove_bg] failed:", err?.message || err);
    await ctx.reply(lang === "ru" ? "❌ Не удалось убрать фон. Попробуй ещё раз." : "❌ Failed to remove background. Try again.");
  }
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

  // Prefer session that owns this sticker (last_sticker_file_id set by worker after generation)
  const { data: ownerSession } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", user.id)
    .eq("env", config.appEnv)
    .eq("last_sticker_file_id", sticker.telegram_file_id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let session = ownerSession;
  if (!session?.id) {
    session = await getActiveSession(user.id);
  }
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({
        user_id: user.id,
        state: "wait_text_overlay",
        is_active: true,
        flow_kind: "single",
        session_rev: 1,
        env: config.appEnv,
      })
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
      flow_kind: "single",
      session_rev: (session.session_rev || 1) + 1,
      last_sticker_file_id: sticker.telegram_file_id,
      user_input: stickerId,
      pending_generation_type: null,
      updated_at: new Date().toISOString(),
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
        flow_kind: "single",
        session_rev: (session.session_rev || 1) + 1,
        last_sticker_file_id: sticker.telegram_file_id,
        pending_generation_type: null,
        updated_at: new Date().toISOString(),
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
bot.action(/^assistant_style_preview:([^:]+)(?::(.+))?$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user?.id) return;
    const lang = user.lang || "en";
    const isRu = lang === "ru";

    const styleId = ctx.match[1];
    const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);
    const session = explicitSessionId
      ? await getSessionByIdForUser(user.id, explicitSessionId)
      : await getLatestAssistantFlowSession(user.id);
    if (!session?.id) {
      await rejectSessionEvent(ctx, lang, "assistant_style_preview", "session_not_found");
      return;
    }
    if (!session.state?.startsWith("assistant_")) {
      await rejectSessionEvent(ctx, lang, "assistant_style_preview", "wrong_state");
      return;
    }
    const strictRevEnabled = await isStrictSessionRevEnabled();
    if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
      await rejectSessionEvent(ctx, lang, "assistant_style_preview", "stale_callback");
      return;
    }
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

    const sessionRef = formatCallbackSessionRef(session.id, session.session_rev);
    const keyboard = {
      inline_keyboard: [[
        { text: "✅ ОК", callback_data: appendSessionRefIfFits(`assistant_style_preview_ok:${styleId}:${stickerMsgId}`, sessionRef) },
      ]],
    };

    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch (err) {
    console.error("[assistant_style_preview] error:", err);
  }
});

// Assistant: style preview OK — apply style
bot.action(/^assistant_style_preview_ok:([^:]+):(\d+)(?::(.+))?$/, async (ctx) => {
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
    const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[3] || null);
    const session = explicitSessionId
      ? await getSessionByIdForUser(user.id, explicitSessionId)
      : await getLatestAssistantFlowSession(user.id);
    if (!session?.id) {
      await rejectSessionEvent(ctx, lang, "assistant_style_preview_ok", "session_not_found");
      return;
    }
    if (!session.state?.startsWith("assistant_")) {
      await rejectSessionEvent(ctx, lang, "assistant_style_preview_ok", "wrong_state");
      return;
    }
    const strictRevEnabled = await isStrictSessionRevEnabled();
    if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
      await rejectSessionEvent(ctx, lang, "assistant_style_preview_ok", "stale_callback");
      return;
    }

    const preset = await getStylePresetV2ById(styleId);
    const styleName = preset
      ? (lang === "ru" ? preset.name_ru : preset.name_en)
      : styleId;

    const aSession = await getActiveAssistantSession(user.id);
    if (aSession) {
      await updateAssistantSession(aSession.id, { style: styleName });
      await supabase.from("sessions").update({
        flow_kind: "assistant",
        session_rev: (session.session_rev || 1) + 1,
        is_active: true,
      }).eq("id", session.id);
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
      await ctx.reply(replyText, getMainMenuKeyboard(lang, ctx?.from?.id));
    } else {
      await ctx.reply(lang === "ru"
        ? `Стиль: ${styleName}. Нажми «Создать стикер», чтобы начать.`
        : `Style: ${styleName}. Tap «Create sticker» to start.`);
    }
  } catch (err: any) {
    console.error("assistant_style_preview_ok error:", err.message);
  }
});

bot.action(/^assistant_pick_style:([^:]+)(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const styleId = ctx.match[1];
  const telegramId = ctx.from?.id;
  if (!telegramId || !styleId) return;

  try {
    const user = await getUser(telegramId);
    if (!user?.id) return;
    const lang = user.lang || "en";
    const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);
    const session = explicitSessionId
      ? await getSessionByIdForUser(user.id, explicitSessionId)
      : await getLatestAssistantFlowSession(user.id);
    if (!session?.id) {
      await rejectSessionEvent(ctx, lang, "assistant_pick_style", "session_not_found");
      return;
    }
    if (!session.state?.startsWith("assistant_")) {
      await rejectSessionEvent(ctx, lang, "assistant_pick_style", "wrong_state");
      return;
    }
    const strictRevEnabled = await isStrictSessionRevEnabled();
    if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
      await rejectSessionEvent(ctx, lang, "assistant_pick_style", "stale_callback");
      return;
    }

    // Get style name
    const preset = await getStylePresetV2ById(styleId);
    const styleName = preset
      ? (lang === "ru" ? preset.name_ru : preset.name_en)
      : styleId;

    // Update assistant session with chosen style
    const aSession = await getActiveAssistantSession(user.id);
    if (aSession) {
      await updateAssistantSession(aSession.id, { style: styleName });
      await supabase.from("sessions").update({
        flow_kind: "assistant",
        session_rev: (session.session_rev || 1) + 1,
        is_active: true,
      }).eq("id", session.id);
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
      await ctx.reply(replyText, getMainMenuKeyboard(lang, ctx?.from?.id));
    } else {
      // No active assistant session — just acknowledge
      await ctx.reply(lang === "ru"
        ? `Стиль: ${styleName}. Нажми «Создать стикер», чтобы начать.`
        : `Style: ${styleName}. Tap «Create sticker» to start.`);
    }
  } catch (err: any) {
    console.error("assistant_pick_style callback error:", err.message);
  }
});

// Callback: assistant confirm — user presses [✅ Confirm] button
bot.action(/^assistant_confirm(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "assistant_confirm", "session_not_found");
    return;
  }
  if (!session.state?.startsWith("assistant_")) {
    await rejectSessionEvent(ctx, lang, "assistant_confirm", "wrong_state");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "assistant_confirm", "stale_callback");
    return;
  }

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
        if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang, ctx?.from?.id));
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
bot.action(/^asst_idea_gen:(\d+)(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx, "🚀 Starting generation...");
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "asst_idea_gen", "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "asst_idea_gen", "stale_callback");
    return;
  }
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

  // Atomic guard against double-clicks: only one callback may advance this revision.
  const currentRev = Number(session.session_rev || 1);
  const nextRev = currentRev + 1;
  const { data: revLockedSession } = await supabase
    .from("sessions")
    .update({
      session_rev: nextRev,
      flow_kind: "assistant",
      is_active: true,
    })
    .eq("id", session.id)
    .eq("session_rev", currentRev)
    .select("id, session_rev")
    .maybeSingle();
  if (!revLockedSession?.id) {
    await rejectSessionEvent(ctx, lang, "asst_idea_gen", "stale_callback");
    return;
  }

  // Immediate UI feedback while prompt is being prepared.
  const preparingMsg = await ctx.reply(
    lang === "ru" ? "⏳ Готовлю промпт..." : "⏳ Preparing prompt..."
  ).catch(() => null);

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

  if (preparingMsg?.message_id) {
    try { await ctx.deleteMessage(preparingMsg.message_id); } catch {}
  }

  await startGeneration(ctx, user, { ...session, session_rev: nextRev }, lang, {
    generationType: "style",
    promptFinal,
    userInput: `[assistant_idea] ${preset.name_en}: ${idea.titleEn}`,
    selectedStyleId: preset.id,
  });
});

// Next idea — always generate a new one via text-only LLM
bot.action(/^asst_idea_next:(\d+)(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "asst_idea_next", "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "asst_idea_next", "stale_callback");
    return;
  }
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
  const nextRev = (session.session_rev || 1) + 1;
  await supabase.from("sessions").update({
    sticker_ideas_state: newState,
    is_active: true,
    flow_kind: "assistant",
    session_rev: nextRev,
  }).eq("id", session.id);

  try { await ctx.deleteMessage(loadingMsg.message_id); } catch {}

  await showStickerIdeaCard(ctx, {
    idea: newIdea,
    ideaIndex: newIndex,
    totalIdeas: 0, // unlimited
    style: preset,
    lang,
    currentHolidayId: state.holidayId,
    sessionId: session.id,
    sessionRev: nextRev,
  });
});

// Show style selection buttons
bot.action(/^asst_idea_style:(\d+)(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const ideaIndex = parseInt(ctx.match[1], 10);
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "asst_idea_style", "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "asst_idea_style", "stale_callback");
    return;
  }
  const sessionRef = formatCallbackSessionRef(session.id, session.session_rev);
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
        appendSessionRefIfFits(`asst_idea_restyle:${p.id}:${ideaIndex}`, sessionRef)
      ));
    }
    buttons.push(row);
  }
  // Back button
  buttons.push([Markup.button.callback(
    isRu ? "⬅️ Назад" : "⬅️ Back",
    appendSessionRefIfFits(`asst_idea_back:${ideaIndex}`, sessionRef)
  )]);

  try { await ctx.deleteMessage(); } catch {}
  await ctx.reply(
    isRu ? "🎨 Выбери стиль:" : "🎨 Choose a style:",
    Markup.inlineKeyboard(buttons)
  );
});

// Back to idea card from style selection
bot.action(/^asst_idea_back:(\d+)(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "asst_idea_back", "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "asst_idea_back", "stale_callback");
    return;
  }
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
    sessionId: session.id,
    sessionRev: session.session_rev,
  });
});

// Restyle: change style, keep same ideas, show current idea with new style
// Restyle: show style preview (sticker example + description + OK button)
bot.action(/^asst_idea_restyle:([^:]+):(\d+)(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";
  const isRu = lang === "ru";

  const styleId = ctx.match[1];
  const ideaIndex = parseInt(ctx.match[2], 10);
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[3] || null);
  const session = explicitSessionId
    ? await getSessionByIdForUser(user.id, explicitSessionId)
    : await getLatestAssistantFlowSession(user.id);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "asst_idea_restyle", "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "asst_idea_restyle", "stale_callback");
    return;
  }
  const sessionRef = formatCallbackSessionRef(session.id, session.session_rev);

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
      { text: okText, callback_data: appendSessionRefIfFits(`asst_idea_restyle_ok:${styleId}:${ideaIndex}:${stickerMsgId}`, sessionRef) },
    ]],
  };

  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
});

// Restyle OK: apply selected style and return to idea card
bot.action(/^asst_idea_restyle_ok:([^:]+):(\d+):(\d+)(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const styleId = ctx.match[1];
  const ideaIndex = parseInt(ctx.match[2], 10);
  const stickerMsgId = parseInt(ctx.match[3], 10);

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[4] || null);
  const session = explicitSessionId
    ? await getSessionByIdForUser(user.id, explicitSessionId)
    : await getLatestAssistantFlowSession(user.id);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "asst_idea_restyle_ok", "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "asst_idea_restyle_ok", "stale_callback");
    return;
  }
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
  const nextRev = (session.session_rev || 1) + 1;
  await supabase.from("sessions").update({
    sticker_ideas_state: newState,
    is_active: true,
    flow_kind: "assistant",
    session_rev: nextRev,
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
    sessionId: session.id,
    sessionRev: nextRev,
  });
});

// Holiday OFF — generate 1 normal idea, reset holiday, keep photoDescription
bot.action(/^asst_idea_holiday_off:(\d+)(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[2] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "asst_idea_holiday_off", "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "asst_idea_holiday_off", "stale_callback");
    return;
  }
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
  const nextRev = (session.session_rev || 1) + 1;
  await supabase.from("sessions").update({
    sticker_ideas_state: newState,
    state: "assistant_wait_idea",
    is_active: true,
    flow_kind: "assistant",
    session_rev: nextRev,
  }).eq("id", session.id);

  try { await ctx.deleteMessage(loadingMsg.message_id); } catch {}

  const preset = await getStylePresetV2ById(state.styleId);
  if (!preset) return;

  await showStickerIdeaCard(ctx, {
    idea, ideaIndex: 0, totalIdeas: 0, style: preset, lang,
    currentHolidayId: null,
    sessionId: session.id,
    sessionRev: nextRev,
  });
});

// Holiday theme ON — generate 1 holiday idea, keep photoDescription
bot.action(/^asst_idea_holiday:([^:]+):(\d+)(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const holidayId = ctx.match[1];
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[3] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "asst_idea_holiday", "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "asst_idea_holiday", "stale_callback");
    return;
  }
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
  const nextRev = (session.session_rev || 1) + 1;
  await supabase.from("sessions").update({
    sticker_ideas_state: newState,
    state: "assistant_wait_idea",
    is_active: true,
    flow_kind: "assistant",
    session_rev: nextRev,
  }).eq("id", session.id);

  try { await ctx.deleteMessage(loadingMsg.message_id); } catch {}

  const preset = await getStylePresetV2ById(state.styleId);
  if (!preset) return;

  await showStickerIdeaCard(ctx, {
    idea, ideaIndex: 0, totalIdeas: 0, style: preset, lang,
    currentHolidayId: holidayId,
    sessionId: session.id,
    sessionRev: nextRev,
  });
});

// Custom idea — switch to assistant chat
bot.action(/^asst_idea_custom(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "asst_idea_custom", "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "asst_idea_custom", "stale_callback");
    return;
  }

  // Switch to assistant_chat mode
  await supabase.from("sessions").update({
    state: "assistant_chat",
    is_active: true,
    flow_kind: "assistant",
    session_rev: (session.session_rev || 1) + 1,
  }).eq("id", session.id);

  try { await ctx.deleteMessage(); } catch {}
  await ctx.reply(
    lang === "ru"
      ? "✏️ Опиши свою идею для стикера — стиль, эмоцию, позу:"
      : "✏️ Describe your sticker idea — style, emotion, pose:",
    getMainMenuKeyboard(lang, ctx?.from?.id)
  );
});

// Skip ideas — switch to normal assistant dialog
bot.action(/^asst_idea_skip(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "asst_idea_skip", "session_not_found");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "asst_idea_skip", "stale_callback");
    return;
  }

  // Switch to assistant_chat mode
  await supabase.from("sessions").update({
    state: "assistant_chat",
    is_active: true,
    flow_kind: "assistant",
    session_rev: (session.session_rev || 1) + 1,
  }).eq("id", session.id);

  try { await ctx.deleteMessage(); } catch {}
  await ctx.reply(
    lang === "ru"
      ? "👋 Хорошо! Опиши какой стикер хочешь — стиль, эмоцию, позу:"
      : "👋 OK! Describe what sticker you want — style, emotion, pose:",
    getMainMenuKeyboard(lang, ctx?.from?.id)
  );
});

// Callback: assistant restart — start new assistant dialog from post-generation button
bot.action(/^assistant_restart(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  if (explicitSessionId) {
    const session = await getSessionByIdForUser(user.id, explicitSessionId);
    if (!session?.id) {
      await rejectSessionEvent(ctx, lang, "assistant_restart", "session_not_found");
      return;
    }
    const strictRevEnabled = await isStrictSessionRevEnabled();
    if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
      await rejectSessionEvent(ctx, lang, "assistant_restart", "stale_callback");
      return;
    }
  }
  await startAssistantDialog(ctx, user, lang);
});

// Callback: assistant new photo — user chose to use new photo
bot.action(/^assistant_new_photo(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "assistant_new_photo", "session_not_found");
    return;
  }
  if (!session.state?.startsWith("assistant_")) {
    await rejectSessionEvent(ctx, lang, "assistant_new_photo", "wrong_state");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "assistant_new_photo", "stale_callback");
    return;
  }

  const aSession = await getActiveAssistantSession(user.id);
  const newPhotoFileId = session.pending_photo_file_id || aSession?.pending_photo_file_id;
  if (!newPhotoFileId) {
    await ctx.reply(lang === "ru" ? "Фото не найдено, пришли ещё раз." : "Photo not found, please send again.");
    return;
  }
  const photos = Array.isArray(session.photos) ? session.photos : [];
  if (!photos.includes(newPhotoFileId)) photos.push(newPhotoFileId);

  // Product rule: after switching to a new photo, return to action menu
  // (except replace-face flow handled in wait_replace_face branch of photo handler).
  const nextRev = (session.session_rev || 1) + 1;
  await supabase
    .from("sessions")
    .update({
      photos,
      current_photo_file_id: newPhotoFileId,
      pending_photo_file_id: null,
      state: "wait_action",
      style_source_kind: "photo",
      is_active: true,
      flow_kind: "single",
      session_rev: nextRev,
    })
    .eq("id", session.id);

  void ensureSubjectProfileForGeneration(
    { ...session, current_photo_file_id: newPhotoFileId, photos },
    "style"
  ).catch((err) => console.warn("[assistant_new_photo->wait_action] subject profile failed:", err?.message || err));

  if (aSession) {
    await updateAssistantSession(aSession.id, { pending_photo_file_id: null, status: "completed" });
  }
  await sendActionMenu(ctx, lang, session.id, nextRev);
  return;
});

// Callback: assistant keep photo — user chose to keep current photo
bot.action(/^assistant_keep_photo(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUser(telegramId);
  const lang = user?.lang || ((ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en");
  if (!user?.id) return;
  const { sessionId: explicitSessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "assistant_keep_photo", "session_not_found");
    return;
  }
  if (!session.state?.startsWith("assistant_")) {
    await rejectSessionEvent(ctx, lang, "assistant_keep_photo", "wrong_state");
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "assistant_keep_photo", "stale_callback");
    return;
  }
  const currentPhotoFileId = session.current_photo_file_id || user.last_photo_file_id || null;
  if (!currentPhotoFileId) {
    await ctx.reply(await getText(lang, "photo.need_photo"));
    return;
  }
  const nextRev = (session.session_rev || 1) + 1;
  await supabase
    .from("sessions")
    .update({
      state: "wait_action",
      current_photo_file_id: currentPhotoFileId,
      pending_photo_file_id: null,
      is_active: true,
      flow_kind: "single",
      session_rev: nextRev,
    })
    .eq("id", session.id);
  const aSession = await getActiveAssistantSession(user.id);
  if (aSession) {
    await updateAssistantSession(aSession.id, { pending_photo_file_id: null, status: "completed" });
  }
  const msg = lang === "ru" ? "Оставляем текущее фото." : "Keeping current photo.";
  await ctx.reply(msg);
  await sendActionMenu(ctx, lang, session.id, nextRev);
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

  // Get sticker to check style_preset_id and get file path for landing public_url
  const { data: sticker } = await supabase
    .from("stickers")
    .select("id, style_preset_id, is_example, result_storage_path")
    .eq("id", stickerId)
    .maybeSingle();

  if (!sticker) {
    console.log("Sticker not found");
    await ctx.editMessageCaption("❌ Стикер не найден").catch(() => {});
    return;
  }

  if (!sticker.style_preset_id) {
    console.log("Sticker has no style_preset_id");
    await ctx.editMessageCaption("❌ У стикера нет стиля").catch(() => {});
    return;
  }

  if (sticker.is_example) {
    console.log("Sticker already an example");
    await ctx.editMessageCaption("✅ Уже является примером").catch(() => {});
    return;
  }

  let publicUrl: string | null = null;
  const isTransientStorageErr = (e: unknown) => {
    if (!e || typeof e !== "object") return false;
    const msg = String((e as { message?: string }).message ?? e);
    const code = (e as { code?: number }).code;
    return code === 500 || /fetch failed|timeout|ECONNRESET|ETIMEDOUT/i.test(msg);
  };
  if (sticker.result_storage_path) {
    try {
      let fileData: Blob | null = null;
      let downloadErr: unknown = null;
      const doDownload = () =>
        supabase.storage.from(config.supabaseStorageBucket).download(sticker.result_storage_path!);
      let result = await doDownload();
      downloadErr = result.error;
      fileData = result.data;
      if (downloadErr && isTransientStorageErr(downloadErr)) {
        await new Promise((r) => setTimeout(r, 2000));
        result = await doDownload();
        downloadErr = result.error;
        fileData = result.data;
      }
      if (downloadErr || !fileData) {
        console.error("[make_example] Storage download failed:", downloadErr);
      } else {
        const examplesPath = `${stickerId}.webp`;
        let uploadErr: unknown = null;
        const doUpload = () =>
          supabase.storage
            .from(config.supabaseStorageBucketExamples)
            .upload(examplesPath, fileData!, { contentType: "image/webp", upsert: true });
        let uploadResult = await doUpload();
        uploadErr = uploadResult.error;
        if (uploadErr && isTransientStorageErr(uploadErr)) {
          await new Promise((r) => setTimeout(r, 2000));
          uploadResult = await doUpload();
          uploadErr = uploadResult.error;
        }
        if (uploadErr) {
          console.error("[make_example] Storage upload to examples bucket failed:", uploadErr);
        } else {
          const { data: urlData } = supabase.storage
            .from(config.supabaseStorageBucketExamples)
            .getPublicUrl(examplesPath);
          publicUrl = urlData?.publicUrl ?? null;
        }
      }
    } catch (err) {
      if (isTransientStorageErr(err)) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const { data: fileData, error: downloadErr } = await supabase.storage
            .from(config.supabaseStorageBucket)
            .download(sticker.result_storage_path);
          if (!downloadErr && fileData) {
            const examplesPath = `${stickerId}.webp`;
            const { error: uploadErr } = await supabase.storage
              .from(config.supabaseStorageBucketExamples)
              .upload(examplesPath, fileData, { contentType: "image/webp", upsert: true });
            if (!uploadErr) {
              const { data: urlData } = supabase.storage
                .from(config.supabaseStorageBucketExamples)
                .getPublicUrl(examplesPath);
              publicUrl = urlData?.publicUrl ?? null;
            }
          }
        } catch (e2) {
          console.error("[make_example] Upload to sticker-examples failed (retry):", e2);
        }
      } else {
        console.error("[make_example] Upload to sticker-examples failed:", err);
      }
    }
  }

  const { error } = await supabase
    .from("stickers")
    .update({ is_example: true, ...(publicUrl && { public_url: publicUrl }) })
    .eq("id", stickerId);

  if (error) {
    console.error("Failed to mark as example:", error);
    await ctx.editMessageCaption("❌ Ошибка сохранения").catch(() => {});
    return;
  }

  console.log("Marked as example:", stickerId, "style:", sticker.style_preset_id, publicUrl ? "public_url set" : "no public_url");
  await ctx.editMessageCaption(`✅ Добавлен как пример для стиля "${sticker.style_preset_id}"`).catch(() => {});
});

// Callback: emotion_make_example (admin only — from alert channel, "Сохранить пример для эмоции")
bot.action(/^emotion_make_example:(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId || !config.adminIds.includes(telegramId)) return;

  const emotionPresetId = ctx.match[1];
  const msg = ctx.callbackQuery?.message as any;
  const photo = msg?.photo;
  if (!Array.isArray(photo) || photo.length === 0) {
    await ctx.editMessageCaption("❌ Нет фото в сообщении").catch(() => {});
    return;
  }
  const fileId = photo[photo.length - 1]?.file_id;
  if (!fileId) {
    await ctx.editMessageCaption("❌ Не удалось получить file_id").catch(() => {});
    return;
  }

  try {
    const filePath = await getFilePath(fileId);
    const buffer = await downloadFile(filePath);
    const storagePath = `${EMOTION_EXAMPLES_STORAGE_PREFIX}${emotionPresetId}.webp`;
    const { error: uploadErr } = await supabase.storage
      .from(config.supabaseStorageBucketExamples)
      .upload(storagePath, buffer, { contentType: "image/webp", upsert: true });
    if (uploadErr) {
      console.error("[emotion_make_example] Storage upload failed:", uploadErr);
      await ctx.editMessageCaption("❌ Ошибка загрузки в Storage").catch(() => {});
      return;
    }
    emotionPresetsCache = null;
    await ctx.editMessageCaption(`✅ Сохранено как пример для эмоции "${emotionPresetId}"`).catch(() => {});
  } catch (err: any) {
    console.error("[emotion_make_example] Error:", err?.message || err);
    await ctx.editMessageCaption("❌ Ошибка: " + (err?.message || "unknown")).catch(() => {});
  }
});

// Callback: pack_make_example (admin only — from alert channel, pack preview "Сделать примером")
// Сообщение в алерте — фото с caption, поэтому редактируем caption, не text.
bot.action(/^pack_make_example:(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId || !config.adminIds.includes(telegramId)) return;

  const styleId = ctx.match[1];
  const msg = ctx.callbackQuery?.message as any;
  const photo = msg?.photo;
  if (!Array.isArray(photo) || photo.length === 0) {
    await ctx.editMessageCaption("❌ Нет фото в сообщении").catch(() => {});
    return;
  }
  const fileId = photo[photo.length - 1]?.file_id;
  if (!fileId) {
    await ctx.editMessageCaption("❌ Не удалось получить file_id").catch(() => {});
    return;
  }

  const { error } = await supabase
    .from("style_presets_v2")
    .update({ pack_example_file_id: fileId })
    .eq("id", styleId);

  if (error) {
    console.error("[pack_make_example] Update failed:", error);
    await ctx.editMessageCaption("❌ Ошибка сохранения").catch(() => {});
    return;
  }
  await ctx.editMessageCaption(`✅ Сохранено как пример пака для стиля "${styleId}"`).catch(() => {});
});

/** Стиль, с которым можно выкладывать пилюли в pack/content/. Только фото-реализм — чтобы в Hero не попал аниме/другой стиль. */
const LANDING_CONTENT_STYLE_ID = "photo_realistic";

// Callback: pack_landing (admin only — после сборки пака, кнопка "Показать на лендинге")
bot.action(/^pack_landing:(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId || !config.adminIds.includes(telegramId)) return;

  const batchId = ctx.match[1];
  const msg = ctx.callbackQuery?.message as any;
  const isPhoto = Array.isArray(msg?.photo) && msg.photo.length > 0;
  const edit = (text: string) =>
    isPhoto ? ctx.editMessageCaption(text).catch(() => {}) : ctx.editMessageText(text).catch(() => {});

  const { data: batch } = await supabase
    .from("pack_batches")
    .select("id, session_id")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch?.session_id) {
    await edit("❌ Батч не найден");
    return;
  }

  const { data: session } = await supabase
    .from("sessions")
    .select("pack_content_set_id, selected_style_id")
    .eq("id", batch.session_id)
    .maybeSingle();
  if (!session) {
    await edit("❌ Сессия не найдена");
    return;
  }

  const contentSetId = session.pack_content_set_id ?? null;
  const styleId = session.selected_style_id ?? null;
  const allowContentUpload = styleId === LANDING_CONTENT_STYLE_ID;

  if (contentSetId) {
    const { error: e1 } = await supabase
      .from(config.packContentSetsTable)
      .update({ cluster: true })
      .eq("id", contentSetId);
    if (e1) {
      console.error("[pack_landing] pack_content_sets update:", e1);
      await edit("❌ Ошибка: cluster");
      return;
    }
  }
  if (styleId) {
    const { error: e2 } = await supabase
      .from("style_presets_v2")
      .update({ landing: true })
      .eq("id", styleId);
    if (e2) {
      console.error("[pack_landing] style_presets_v2 update:", e2);
      await edit("❌ Ошибка: landing");
      return;
    }
  }

  const { data: stickers } = await supabase
    .from("stickers")
    .select("pack_index, result_storage_path")
    .eq("pack_batch_id", batchId)
    .not("result_storage_path", "is", null)
    .order("pack_index", { ascending: true });
  const bucket = config.supabaseStorageBucket;
  const examplesBucket = config.supabaseStorageBucketExamples;
  let copied = 0;
  if (Array.isArray(stickers) && stickers.length > 0 && bucket && examplesBucket) {
    for (const row of stickers) {
      const idx = row.pack_index ?? 0;
      const path = row.result_storage_path as string;
      const { data: blob, error: downErr } = await supabase.storage.from(bucket).download(path);
      if (downErr || !blob) continue;
      const buf = Buffer.from(await blob.arrayBuffer());
      const pos = idx + 1;
      if (contentSetId && allowContentUpload) {
        const dest = `pack/content/${contentSetId}/${pos}.webp`;
        const { error: upErr } = await supabase.storage.from(examplesBucket).upload(dest, buf, { contentType: "image/webp", upsert: true });
        if (!upErr) copied++;
      }
      if (styleId) {
        const dest = `pack/style/${styleId}/${pos}.webp`;
        const { error: upErr } = await supabase.storage.from(examplesBucket).upload(dest, buf, { contentType: "image/webp", upsert: true });
        if (!upErr) copied++;
      }
    }
  }

  const parts = [];
  if (contentSetId) {
    parts.push(`cluster=true (${contentSetId})`);
    if (!allowContentUpload) parts.push("пилюли не обновлены (нужен стиль photo_realistic)");
  }
  if (styleId) parts.push(`landing=true (${styleId})`);
  if (copied > 0) parts.push(`Storage: ${copied} файлов`);
  await edit(`✅ На лендинг: ${parts.join("; ") || "флаги обновлены"}`);
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
    (p: any) => p.hidden && p.label_en.endsWith(discountSuffix) && (!p.trialOnly || !user.has_purchased)
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
    const totalCredits = getPackTotalCredits(pack);
    inlineKeyboard.push([{
      text: `${label}: ${totalCredits} ${unit} — ${pack.price}⭐ (${pack.price_rub}₽)`,
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
      getGeminiGenerateContentUrl("gemini-2.0-flash"),
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

  const { sessionId, rev: callbackRev } = parseCallbackSessionRef(ctx.match[1]);
  if (!sessionId) return;
  console.log("[retry_generation] sessionId:", sessionId, "telegramId:", telegramId);

  const user = await getUser(telegramId);
  if (!user?.id) {
    console.log("[retry_generation] User not found:", telegramId);
    return;
  }

  const lang = user.lang || "en";

  // Get the original session
  const { data: sessionData } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .maybeSingle();
  let session = sessionData;

  if (!session) {
    console.log("[retry_generation] Session not found:", sessionId);
    const notFoundText = lang === "ru"
      ? "❌ Сессия не найдена. Отправь новое фото."
      : "❌ Session not found. Send a new photo.";
    await ctx.editMessageText(notFoundText);
    return;
  }
  const strictRevEnabled = await isStrictSessionRevEnabled();
  if (strictRevEnabled && callbackRev !== null && callbackRev !== Number(session.session_rev || 1)) {
    await rejectSessionEvent(ctx, lang, "retry_generation", "stale_callback");
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

  const processingStates = new Set(["processing", "processing_emotion", "processing_motion", "processing_text"]);
  if (processingStates.has(String(session.state || ""))) {
    const { data: activeJobs } = await supabase
      .from("jobs")
      .select("id,status")
      .eq("session_id", session.id)
      .in("status", ["queued", "running", "processing"])
      .limit(1);

    if (activeJobs && activeJobs.length > 0) {
      const stillRunningText = lang === "ru"
        ? "⏳ Генерация ещё выполняется. Подожди пару секунд и попробуй снова."
        : "⏳ Generation is still running. Please wait a few seconds and try again.";
      await ctx.editMessageText(stillRunningText).catch(() => {});
      return;
    }

    const retryReadyState =
      session.generation_type === "emotion" ? "wait_emotion" :
      session.generation_type === "motion" ? "wait_motion" :
      session.generation_type === "text" ? "wait_text_overlay" :
      session.generation_type === "replace_subject" ? "wait_replace_face_sticker" : "wait_style";

    await supabase
      .from("sessions")
      .update({
        state: retryReadyState,
        is_active: true,
        progress_message_id: null,
        progress_chat_id: null,
      })
      .eq("id", session.id);

    session = {
      ...session,
      state: retryReadyState,
    };
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
      styleSourceKind: String(session.style_source_kind || "").toLowerCase() === "sticker" ? "sticker" : "photo",
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
  const sourceFileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;

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
      getGeminiGenerateContentUrl("gemini-2.5-flash"),
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
                fileData: {
                  mimeType,
                  fileUri: sourceFileUrl,
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
  sessionId?: string | null;
  sessionRev?: number | null;
}) {
  const { idea, ideaIndex, totalIdeas, style, lang, sessionId, sessionRev } = opts;
  const isRu = lang === "ru";
  const sessionRef = formatCallbackSessionRef(sessionId, sessionRev);

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
    appendSessionRefIfFits(`asst_idea_gen:${ideaIndex}`, sessionRef)
  )]);

  rows.push([Markup.button.callback(
    isRu ? "➡️ Другая" : "➡️ Next",
    appendSessionRefIfFits(`asst_idea_next:${ideaIndex}`, sessionRef)
  )]);

  rows.push([Markup.button.callback(
    isRu ? "🔄 Другой стиль" : "🔄 Change style",
    appendSessionRefIfFits(`asst_idea_style:${ideaIndex}`, sessionRef)
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

function getIdeaKeyboard(
  index: number,
  total: number,
  lang: string,
  options?: { sessionId?: string | null; sessionRev?: number | null; backCallbackData?: string | null }
) {
  const generateText = lang === "ru" ? "🎨 Сгенерить (1💎)" : "🎨 Generate (1💎)";
  const nextText = lang === "ru" ? "➡️ Следующая" : "➡️ Next";
  const customText = lang === "ru" ? "✏️ Своя идея" : "✏️ Custom idea";
  const doneText = lang === "ru" ? "✅ Хватит" : "✅ Done";
  const sessionRef = formatCallbackSessionRef(options?.sessionId, options?.sessionRev);

  const buttons: any[][] = [
    [
      { text: generateText, callback_data: appendSessionRefIfFits(`idea_generate:${index}`, sessionRef) },
      { text: nextText, callback_data: appendSessionRefIfFits("idea_next", sessionRef) },
    ],
    [{ text: customText, callback_data: "custom_idea" }],
    [{ text: doneText, callback_data: "idea_done" }],
  ];
  if (options?.backCallbackData) {
    buttons.push([{ text: lang === "ru" ? "↩️ Назад" : "↩️ Back", callback_data: options.backCallbackData }]);
  }

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
    .select("telegram_file_id, source_photo_file_id, style_preset_id, user_id")
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

  // Reuse current message for submenu UX: edit in-place instead of sending a new message.
  const thinkingText = lang === "ru" ? "💡 Придумываю идеи для пака..." : "💡 Thinking of ideas for your pack...";
  const currentMessageId = (ctx.callbackQuery as any)?.message?.message_id as number | undefined;
  if (ctx.chat?.id && currentMessageId) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, currentMessageId, undefined, thinkingText);
    } catch {
      await ctx.reply(thinkingText);
    }
  } else {
    await ctx.reply(thinkingText);
  }

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
    last_sticker_file_id: sticker.telegram_file_id,
    current_photo_file_id: session.current_photo_file_id || sticker.source_photo_file_id || null,
    is_active: true,
  }).eq("id", session.id);

  if (updateErr) {
    console.error("[PackIdeas] Session update FAILED:", updateErr.message, updateErr.code, updateErr.details);
  } else {
    console.log("[PackIdeas] Session updated OK, ideas saved to DB");
  }

  // Show first idea — embed idea data in callback_data for resilience
  const sessionRef = formatCallbackSessionRef(session.id, session.session_rev);
  const backCb = appendSessionRefIfFits(`back_to_sticker_menu:${stickerId}`, sessionRef);
  const text = formatIdeaMessage(ideas[0], 0, ideas.length, lang);
  const keyboard = getIdeaKeyboard(0, ideas.length, lang, {
    sessionId: session.id,
    sessionRev: session.session_rev,
    backCallbackData: backCb,
  });
  if (ctx.chat?.id && currentMessageId) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, currentMessageId, undefined, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      return;
    } catch (err: any) {
      console.warn("[pack_ideas] edit first card failed, fallback to reply:", err?.message || err);
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
});

// Callback: Generate sticker from idea
bot.action(/^idea_generate:(\d+)(?::(.+))?$/, async (ctx) => {
  console.log("=== idea_generate callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const { sessionId: explicitSessionId } = parseCallbackSessionRef(ctx.match?.[2] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
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
bot.action(/^idea_next(?::(.+))?$/, async (ctx) => {
  console.log("=== idea_next callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const { sessionId: explicitSessionId } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  console.log("[idea_next] session:", session?.id, "pack_ideas:", !!session?.pack_ideas, "current_idea_index:", session?.current_idea_index);

  if (!session?.pack_ideas) {
    console.log("[idea_next] No pack_ideas in session, aborting");
    return;
  }

  const ideas: StickerIdea[] = session.pack_ideas;
  const nextIndex = (session.current_idea_index || 0) + 1;
  console.log("[idea_next] nextIndex:", nextIndex, "total:", ideas.length);

  if (nextIndex >= ideas.length) {
    const sessionRef = formatCallbackSessionRef(session.id, session.session_rev);
    let backCb: string | null = null;
    if (session.last_sticker_file_id) {
      const { data: lastSticker } = await supabase
        .from("stickers")
        .select("id")
        .eq("user_id", user.id)
        .eq("telegram_file_id", session.last_sticker_file_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastSticker?.id) {
        backCb = appendSessionRefIfFits(`back_to_sticker_menu:${lastSticker.id}`, sessionRef);
      }
    }
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
            [{ text: lang === "ru" ? "🔄 Новые идеи" : "🔄 More ideas", callback_data: appendSessionRefIfFits("idea_more", sessionRef) }],
            [{ text: lang === "ru" ? "📷 Новое фото" : "📷 New photo", callback_data: "new_photo" }],
            ...(backCb ? [[{ text: lang === "ru" ? "↩️ Назад" : "↩️ Back", callback_data: backCb }]] : []),
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
  const sessionRef = formatCallbackSessionRef(session.id, session.session_rev);
  let backCb: string | null = null;
  if (session.last_sticker_file_id) {
    const { data: lastSticker } = await supabase
      .from("stickers")
      .select("id")
      .eq("user_id", user.id)
      .eq("telegram_file_id", session.last_sticker_file_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastSticker?.id) {
      backCb = appendSessionRefIfFits(`back_to_sticker_menu:${lastSticker.id}`, sessionRef);
    }
  }
  const text = formatIdeaMessage(ideas[nextIndex], nextIndex, ideas.length, lang);
  const keyboard = getIdeaKeyboard(nextIndex, ideas.length, lang, {
    sessionId: session.id,
    sessionRev: session.session_rev,
    backCallbackData: backCb,
  });
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
bot.action(/^idea_more(?::(.+))?$/, async (ctx) => {
  console.log("=== idea_more callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const { sessionId: explicitSessionId } = parseCallbackSessionRef(ctx.match?.[1] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
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
  const keyboard = getIdeaKeyboard(0, ideas.length, lang, {
    sessionId: session.id,
    sessionRev: session.session_rev,
  });
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
      session.pending_generation_type === "text" ? "wait_text_overlay" :
      session.pending_generation_type === "replace_subject" ? "wait_replace_face_sticker" : "wait_style";
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

  const txLookupStart = Date.now();
  const { data: activeCreatedTx } = await supabase
    .from("transactions")
    .select("*")
    .eq("user_id", user.id)
    .eq("env", config.appEnv)
    .eq("state", "created")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log("active created tx lookup took:", Date.now() - txLookupStart, "ms");

  let transaction = activeCreatedTx;
  if (activeCreatedTx?.id) {
    const createdAtMs = new Date(activeCreatedTx.created_at || 0).getTime();
    const ageMs = Date.now() - createdAtMs;
    const isFresh = Number.isFinite(createdAtMs) && ageMs <= PAYMENT_ACTIVE_TX_TTL_MS;
    const samePack = Number(activeCreatedTx.amount) === credits && Number(activeCreatedTx.price) === price;

    if (isFresh && !samePack) {
      console.log("PAYMENT SWITCH: cancel fresh active tx and create new one", {
        activeTxId: activeCreatedTx.id,
        activeAmount: activeCreatedTx.amount,
        activePrice: activeCreatedTx.price,
        requestedAmount: credits,
        requestedPrice: price,
      });
      await supabase
        .from("transactions")
        .update({ state: "canceled", is_active: false })
        .eq("id", activeCreatedTx.id);
      transaction = null;
    }
    if (!isFresh) {
      await supabase
        .from("transactions")
        .update({ state: "canceled", is_active: false })
        .eq("id", activeCreatedTx.id);
      transaction = null;
    }
  }

  if (!transaction?.id) {
    // Create new transaction only when there is no fresh active "created" transaction.
    const createStart = Date.now();
    const { data: createdTx, error: createError } = await supabase
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

    if (!createdTx) {
      console.log("PAYMENT ERROR: transaction not created, error:", createError);
      await ctx.reply(await getText(lang, "payment.error_create"));
      return;
    }
    transaction = createdTx;
    console.log("transaction created:", transaction.id);
  } else {
    console.log("transaction reused:", transaction.id);
  }

  // Send invoice via Telegram Stars
  try {
    const invoicePayload = `[${transaction.id}]`;
    const totalCredits = getPackTotalCredits(pack);
    const title = await getText(lang, "payment.invoice_title", { credits: totalCredits });
    const description = await getText(lang, "payment.invoice_description", { credits: totalCredits });
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

  let transaction = updatedTransactions?.[0];
  console.log("update result - transaction found:", !!transaction, "id:", transaction?.id);

  // Recovery path: transaction might have been canceled by parallel callback before successful_payment.
  if (!transaction) {
    const { data: recovered } = await supabase
      .from("transactions")
      .update({
        state: "done",
        is_active: false,
        telegram_payment_charge_id: payment.telegram_payment_charge_id,
        provider_payment_charge_id: payment.provider_payment_charge_id,
      })
      .eq("id", transactionId)
      .is("telegram_payment_charge_id", null)
      .neq("state", "done")
      .select("*");
    transaction = recovered?.[0];
    console.log("recovery update result - transaction found:", !!transaction, "id:", transaction?.id);
  }

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

  const purchasedPack = CREDIT_PACKS.find(
    (p: any) => Number(p.credits) === Number(transaction.amount) && Number(p.price) === Number(transaction.price)
  );
  const bonusCredits = Number(purchasedPack?.bonus_credits || 0);
  const isFirstPurchase = Boolean(user && !user.has_purchased);

  if (bonusCredits > 0) {
    console.log("Pack bonus detected! Adding bonus:", bonusCredits);

    // Add bonus credits via transaction
    await supabase.from("transactions").insert({
      user_id: user.id,
      amount: bonusCredits,
      price: 0,
      state: "done",
      is_active: false,
      env: config.appEnv,
    });
  }

  if (isFirstPurchase) {
    // Mark first purchase regardless of selected pack.
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
    const creditedAmount = Number(transaction.amount || 0) + bonusCredits;

    // Show payment success message
    await ctx.reply(await getText(lang, "payment.success", {
      amount: creditedAmount,
      balance: currentCredits,
    }));

    // Send payment notification (async, non-blocking)
    sendNotification({
      type: "new_payment",
      message: `👤 @${finalUser.username || finalUser.telegram_id}\n📦 Пакет: ${creditedAmount} кредитов${bonusCredits > 0 ? ` (${transaction.amount}+${bonusCredits})` : ""}\n⭐ Сумма: ${transaction.price} Stars${isFirstPurchase ? "\n🆕 Первая покупка" : ""}`,
    }).catch(console.error);

    // Yandex Metrika offline conversion — по факту оплаты. yclid из users или из start_payload (fallback для пользователей, созданных до фикса парсера).
    const resolvedYclid = finalUser.yclid || (finalUser.start_payload ? parseStartPayload(finalUser.start_payload).yclid : null);
    if (resolvedYclid && transaction.price > 0 && !transaction.yandex_conversion_sent_at) {
      (async () => {
        try {
          if (!finalUser.yclid && finalUser.start_payload) {
            try {
              await supabase.from("users").update({ yclid: resolvedYclid }).eq("id", finalUser.id);
            } catch (_) {}
          }
          const priceRub = purchasedPack?.price_rub || Math.round(Number(transaction.price) * 1.04);
          const target = getMetrikaTargetForPack(Number(transaction.amount), purchasedPack?.trialOnly);
          await sendYandexConversion({
            yclid: resolvedYclid,
            target,
            revenue: priceRub,
            currency: "RUB",
            orderId: transaction.id,
          });
          await supabase
            .from("transactions")
            .update({
              yandex_conversion_sent_at: new Date().toISOString(),
              yandex_conversion_attempts: (transaction.yandex_conversion_attempts || 0) + 1,
            })
            .eq("id", transaction.id);
          console.log("[metrika] Conversion sent for yclid:", resolvedYclid, "tx:", transaction.id, "target:", target, "rub:", priceRub);
        } catch (err: any) {
          const status = err.response?.status;
          const body = err.response?.data;
          console.error("[metrika] Failed to send conversion:", err.message, "status:", status, "response:", body != null ? JSON.stringify(body).slice(0, 400) : "");
          try {
            await supabase
              .from("transactions")
              .update({
                yandex_conversion_error: String(err.message || "unknown").slice(0, 500),
                yandex_conversion_attempts: (transaction.yandex_conversion_attempts || 0) + 1,
              })
              .eq("id", transaction.id);
          } catch (_) {}
          sendAlert({
            type: "metrika_error",
            message: `[Metrika] Conversion failed for tx ${transaction.id}: ${err.message}`,
          }).catch(() => {});
        }
      })();
    } else if (transaction.price > 0) {
      const reason = !resolvedYclid ? "no yclid" : transaction.yandex_conversion_sent_at ? "already sent" : "unknown";
      console.log("[metrika] Conversion skipped, tx:", transaction.id, "reason:", reason);
    }

    // Check if there's a pending session waiting for credits (paywall or normal).
    // Use payment-specific fallback because such session may be marked inactive by racey updates.
    let session = await getActiveSession(finalUser.id);
    if (!session || (session.state !== "wait_buy_credit" && session.state !== "wait_first_purchase")) {
      const pendingPaymentSession = await getPendingPaymentSession(finalUser.id);
      if (pendingPaymentSession?.id) {
        session = pendingPaymentSession;
      }
    }
    const isWaitingForCredits = session?.state === "wait_buy_credit" || session?.state === "wait_first_purchase";
    if (isWaitingForCredits && session?.id && session.is_active !== true) {
      const { data: reactivated } = await supabase
        .from("sessions")
        .update({ is_active: true })
        .eq("id", session.id)
        .select("*")
        .maybeSingle();
      if (reactivated?.id) {
        session = reactivated;
      }
    }
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
            photoFileId: session.current_photo_file_id || undefined,
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

// Webhook endpoint: respond 200 immediately so proxy/Telegram don't abort; process update in background.
app.post(config.webhookPath, async (req, res) => {
  if (config.telegramWebhookSecret) {
    const secret = req.header("x-telegram-bot-api-secret-token");
    if (secret !== config.telegramWebhookSecret) {
      return res.status(401).send({ ok: false });
    }
  }

  const body = req.body;
  res.status(200).send({ ok: true });

  setImmediate(() => {
    bot.handleUpdate(body).catch((err) => {
      console.error("[webhook] handleUpdate error:", err?.message || err);
    });
  });
});

app.get("/health", (_, res) => res.status(200).send("OK"));

const server = app.listen(config.port, () => {
  console.log(`API running on :${config.port}`);
  console.log("[Build][API] git_sha:", resolveRuntimeGitSha(), "app_env:", config.appEnv);
  if (!config.alertChannelId) {
    console.warn("[Config] Alert channel: NOT SET — set ALERT_CHANNEL_ID (or PROD_ALERT_CHANNEL_ID when APP_ENV=test). Alerts will be skipped.");
  } else {
    console.log("[Config] Alert channel: configured");
  }
  console.log("[Config] APP_ENV=" + config.appEnv + " pack_admin_button=" + (config.adminIds.length > 0 ? "available for admin (adminIds=" + config.adminIds.length + ")" : "hidden"));
});

// ============================================
// ABANDONED CART PROCESSING
// ============================================

const ABANDONED_CART_DELAY_MS = 15 * 60 * 1000; // 15 minutes
const ABANDONED_CART_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Map original price to discounted price (10% off)
const DISCOUNT_MAP: Record<number, number> = {
  49: 44,
  75: 68,
  175: 158,
  500: 450,
  1125: 1013,
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

      const selectedPack = CREDIT_PACKS.find(
        (p: any) => !p.hidden && Number(p.credits) === Number(tx.amount) && Number(p.price) === Number(tx.price)
      );
      const packName = selectedPack
        ? (lang === "ru" ? selectedPack.label_ru : selectedPack.label_en)
        : `${tx.amount}`;
      const totalCredits = selectedPack ? getPackTotalCredits(selectedPack) : Number(tx.amount || 0);

      // Build message
      const message = lang === "ru"
        ? `🛒 Ты выбрал пакет "${packName}", но не завершил оплату.\n\nСпециально для тебя — скидка 10%:\n${totalCredits} стикеров за ${discountedPrice}⭐ вместо ${tx.price}⭐\n\nПредложение действует 24 часа ⏰`
        : `🛒 You selected the "${packName}" pack but didn't complete the payment.\n\nSpecial offer for you — 10% off:\n${totalCredits} stickers for ${discountedPrice}⭐ instead of ${tx.price}⭐\n\nOffer valid for 24 hours ⏰`;

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
      
      const selectedPack = CREDIT_PACKS.find(
        (p: any) => !p.hidden && Number(p.credits) === Number(tx.amount) && Number(p.price) === Number(tx.price)
      );
      const packName = selectedPack ? selectedPack.label_ru : `${tx.amount} кредитов`;
      const totalCredits = selectedPack ? getPackTotalCredits(selectedPack) : Number(tx.amount || 0);

      const message = `👤 @${user.username || 'no_username'} (${user.telegram_id})
📦 Пакет: ${packName} (${totalCredits} кредитов)
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

