/**
 * Multi-agent pack generation pipeline (OpenAI).
 * Concept → Boss; then Captions and Scenes in parallel; then Assembly → Critic.
 * Used only in test bot; admin-only "Сгенерировать пак" button.
 */

import axios from "axios";
import { config } from "../config";
import { getAppConfig } from "./app-config";

// --- Subject type for photo context (from Gemini detector) ---
export type SubjectType = "single_male" | "single_female" | "couple" | "unknown";

// --- Concept output ---
export interface ConceptBrief {
  subject_type: SubjectType;
  setting: string;
  persona: string;
  tone: string;
  timeline: "one_day";
  situation_types: string[];
  shareability_hook: string;
  title_hint: string;
  /** 2–4 items: how the theme is visually recognizable (clothing, light, simple cues). */
  visual_anchors?: string[];
}

// --- Boss output ---
export interface BossPlan {
  id: string;
  pack_template_id: string;
  subject_mode: "single" | "multi";
  name_ru: string;
  name_en: string;
  carousel_description_ru: string;
  carousel_description_en: string;
  mood: string;
  sort_order: number;
  segment_id: string;
  story_arc: string;
  tone: string;
  day_structure?: string[];
  moments: string[];
}

/** Плоский вывод объединённого агента Brief & Plan (поля брифa + плана в одном JSON). */
export type BriefAndPlanRaw = ConceptBrief & BossPlan;

// --- Captions output ---
export interface CaptionsOutput {
  labels: string[];
  labels_en: string[];
}

// --- Scenes output (только EN; RU по локали убрано — не генерируем) ---
export interface ScenesOutput {
  /** Сцены на английском — сохраняются в БД и используются при генерации. */
  scene_descriptions: string[];
  /** Не генерируется; пустой массив для совместимости. */
  scene_descriptions_ru?: string[];
}

// --- Critic output ---
export interface CriticOutput {
  pass: boolean;
  reasons: string[];
  suggestions: string[];
}

// --- Assembled row (pack_content_sets format) ---
export interface PackSpecRow {
  id: string;
  pack_template_id: string;
  name_ru: string;
  name_en: string;
  carousel_description_ru: string;
  carousel_description_en: string;
  labels: string[];
  labels_en: string[];
  /** Сцены на английском — сохраняются в БД и в генерации. */
  scene_descriptions: string[];
  /** Сцены на русском — только для UI (формат превью админу); в БД не сохраняются. */
  scene_descriptions_ru?: string[];
  sort_order: number;
  is_active: boolean;
  mood: string;
  sticker_count: number;
  subject_mode: "single" | "multi";
  cluster: boolean;
  segment_id: string;
}

// --- Pipeline result ---
export interface PackGenerationResult {
  ok: boolean;
  spec?: PackSpecRow;
  plan?: BossPlan;
  packId?: string;
  error?: string;
  criticReasons?: string[];
  criticSuggestions?: string[];
}

/**
 * Сохранение итоговых данных в БД (для справки при вызове пайплайна из index.ts).
 *
 * 1) В сессию (sessions) — после пайплайна, пока пак на согласовании:
 *    pending_rejected_pack_spec = result.spec (PackSpecRow)
 *    pending_pack_plan = result.plan (BossPlan)
 *    pending_critic_suggestions = result.criticSuggestions
 *    pending_critic_reasons = result.criticReasons
 *
 * 2) В таблицу pack_content_sets — при нажатии "Сохранить" или при "Сгенерировать и сохранить":
 *
 *    await supabase.from(config.packContentSetsTable).insert({
 *      id: spec.id,
 *      pack_template_id: spec.pack_template_id,
 *      name_ru: spec.name_ru,
 *      name_en: spec.name_en,
 *      carousel_description_ru: spec.carousel_description_ru,
 *      carousel_description_en: spec.carousel_description_en,
 *      labels: spec.labels,
 *      labels_en: spec.labels_en,
 *      scene_descriptions: spec.scene_descriptions,
 *      sort_order: spec.sort_order,
 *      is_active: spec.is_active,
 *      mood: spec.mood,
 *      sticker_count: spec.sticker_count,
 *      subject_mode: subjectModeToSave,  // из сессии по фото или из spec
 *      cluster: spec.cluster,
 *      segment_id: spec.segment_id,
 *    });
 *
 * Перед insert вызывать ensureUniquePackId(spec), если id может дублироваться.
 * После успешного сохранения пака — обнулить в сессии: pending_rejected_pack_spec, pending_pack_plan, pending_critic_suggestions, pending_critic_reasons.
 */

// --- Модели агентов: ключи app_config (таблица app_config) ---
// В БД в app_config добавлять строки key = один из ключей ниже, value = модель (например gpt-4o-mini).
// Так сразу видно, какая строка за какого агента отвечает.
export const PACK_AGENT_APP_CONFIG_KEYS = {
  /** Brief & Plan — запрос + фото → бриф и план пака в одном вызове (объединённый Concept + Boss) */
  brief_and_plan: "pack_openai_model_brief_and_plan",
  /** Captions — план → 9 подписей RU + EN */
  captions: "pack_openai_model_captions",
  /** Scenes — план → 9 scene_descriptions с {subject} */
  scenes: "pack_openai_model_scenes",
  /** Critic — полный спек → pass/fail + reasons + suggestions (строгий gate) */
  critic: "pack_openai_model_critic",
} as const;

const OPENAI_TIMEOUT_MS = 90_000;

/** Модель берётся только из app_config (ключи PACK_AGENT_APP_CONFIG_KEYS). Дефолтов в коде нет. */
async function getModelForAgent(agent: keyof typeof PACK_AGENT_APP_CONFIG_KEYS): Promise<string> {
  const key = PACK_AGENT_APP_CONFIG_KEYS[agent];
  const value = (await getAppConfig(key, ""))?.trim();
  if (!value || value === "__") {
    throw new Error(`Pack agent "${agent}": set app_config.${key} to a valid OpenAI model (e.g. gpt-4.1).`);
  }
  return value;
}

/**
 * OpenAI chat with JSON response. System prompt is sent first so it can be cached by the API
 * (OpenAI prompt caching applies to static prefix; see docs/26-02-pack-agents-slim-context-tz.md Level 3).
 */
async function openAiChatJson<T>(
  model: string,
  systemPrompt: string,
  userMessage: string,
  options?: { temperature?: number; agentLabel?: string }
): Promise<T> {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not set; pack pipeline requires OpenAI.");
  }

  const agent = options?.agentLabel ?? "unknown";
  console.log("[pack-multiagent] OpenAI request", {
    agent,
    model,
    systemLen: systemPrompt.length,
    userLen: userMessage.length,
    userPreview: userMessage.slice(0, 500),
  });

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    response_format: { type: "json_object" },
    temperature: options?.temperature ?? 1,
  };
  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    body,
    {
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      timeout: OPENAI_TIMEOUT_MS,
    }
  );

  const choice = response.data?.choices?.[0];
  const text = choice?.message?.content;
  const finishReason = choice?.finish_reason ?? "unknown";
  const usage = response.data?.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;

  if (!text) {
    const refusal = (choice?.message as any)?.refusal ?? null;
    const detail = `finish_reason=${finishReason}${refusal ? ` refusal=${String(refusal).slice(0, 200)}` : ""}`;
    console.error("[pack-multiagent] OpenAI no content", { agent, finish_reason: finishReason, refusal: refusal != null, usage });
    throw new Error(`OpenAI returned no content (${detail})`);
  }

  console.log("[pack-multiagent] OpenAI response", {
    agent,
    finish_reason: finishReason,
    prompt_tokens: usage?.prompt_tokens,
    completion_tokens: usage?.completion_tokens,
    total_tokens: usage?.total_tokens,
    contentLen: text.length,
    contentPreview: text.slice(0, 600),
  });
  return JSON.parse(text) as T;
}

// --- Brief & Plan agent (Concept + Boss in one call) ---
const BRIEF_AND_PLAN_SYSTEM = `## Role
Interpret the user request into a compact sticker pack brief
and immediately expand it into a plan of exactly 9 distinct moments of one day.

You output ONE JSON with brief and plan.

---

## Part 1 — Brief (Concept)

Rules:
- One day, one theme.
- Concrete lived situations only.
- Do NOT describe poses, scenes, camera framing, or appearance.

### Costume Lock (CRITICAL)
If the concept implies a profession or role visually defined by clothing
(e.g. soldier, war correspondent, doctor, pilot, chef):

- Define ONE fixed outfit for the entire pack.
- Describe it at a high level only.
- This outfit MUST remain the same across all moments.

If no such role is implied, explicitly state: outfit = "none".

### Holiday Visual Anchors (MANDATORY)
If the theme is a holiday or celebration (e.g. March 8, Valentine's Day, birthday):
- Define 2–4 REQUIRED visual anchors (objects, not environments).
- Examples: flowers, bouquet, gift box, card, ribbon, envelope, candle.
- These anchors represent the holiday visually.
- They must be simple, handheld, and easy to isolate.
- Put outfit (or "none") first in visual_anchors, then these objects.
At least HALF of the scenes must include one of these visual anchors.
Distribute anchors across the day, not only in consecutive moments.
Do NOT replace celebration with neutral daily activities.
If a moment feels like a normal workday, rewrite it.

### Human Imperfection (MANDATORY)
Include ONE human tension that would feel
slightly embarrassing, confusing, or socially uncomfortable
to share in a private chat.

This tension MUST NOT be resolved.
This tension MUST visibly surface in at least one moment.

---

## Part 2 — Plan (9 Moments)

Rules:
- Exactly 9 moments.
- Same day, same environment.
- Avoid a perfect or inspirational arc.
- Balance energy: calm, awkward, tense, overreactive.

### Holiday: Celebratory Moments Quota (MANDATORY)
If the theme is a holiday:
- At least 4 of the 9 moments must be explicitly celebratory.
- Celebratory means: receiving, holding, reacting to, or thinking about a gift or attention.
- Do NOT replace celebration with neutral daily activities.

### Anti-Postcard Rule (CRITICAL)
At least 2 moments MUST be clearly uncomfortable,
self-exposing, or socially imperfect.

If a moment feels safe to post publicly,
it is NOT anti-postcard enough.

Do NOT smooth or justify these moments.

---

## OUTPUT HARD LIMITS (CRITICAL)

- Output EXACTLY one JSON object.
- Total JSON length MUST be under 600 characters.
- If the limit is exceeded:
  - Prioritize moments and visual_anchors.
  - Keep names and carousel descriptions minimal.
- Field values MUST be short phrases, not sentences.
- Moments: max 8–10 words each.
- No prose. No explanations. No commentary.

---

## OUTPUT SCHEMA

Brief keys:
- subject_type (single_male | single_female | couple | unknown)
- setting
- persona
- tone
- timeline ("one_day")
- situation_types (array)
- shareability_hook
- title_hint
- visual_anchors (array, first = outfit or "none")

Plan keys:
- id (snake_case)
- pack_template_id
- subject_mode (single | multi)
- name_ru
- name_en
- carousel_description_ru
- carousel_description_en
- mood
- sort_order (number)
- segment_id
- story_arc (short phrase, may include mismatch)
- tone
- moments (array of EXACTLY 9 strings)`;

function mapRawToBriefAndPlan(raw: BriefAndPlanRaw): { brief: ConceptBrief; plan: BossPlan } {
  const brief: ConceptBrief = {
    subject_type: raw.subject_type,
    setting: raw.setting,
    persona: raw.persona,
    tone: raw.tone,
    timeline: raw.timeline ?? "one_day",
    situation_types: raw.situation_types ?? [],
    shareability_hook: raw.shareability_hook,
    title_hint: raw.title_hint,
    visual_anchors: raw.visual_anchors,
  };
  const plan: BossPlan = {
    id: raw.id,
    pack_template_id: raw.pack_template_id,
    subject_mode: raw.subject_mode,
    name_ru: raw.name_ru,
    name_en: raw.name_en,
    carousel_description_ru: raw.carousel_description_ru,
    carousel_description_en: raw.carousel_description_en,
    mood: raw.mood,
    sort_order: raw.sort_order,
    segment_id: raw.segment_id,
    story_arc: raw.story_arc,
    tone: raw.tone,
    day_structure: raw.day_structure,
    moments: raw.moments ?? [],
  };
  return { brief, plan };
}

async function runConceptAndPlan(request: string, subjectType: SubjectType): Promise<{ brief: ConceptBrief; plan: BossPlan }> {
  const model = await getModelForAgent("brief_and_plan");
  const userMessage = `User request: ${request}\n\nPhoto context (subject_type): ${subjectType}\n\nOutput the combined brief and plan as a single JSON.`;
  const raw = await openAiChatJson<BriefAndPlanRaw | { brief: ConceptBrief; plan: BossPlan }>(model, BRIEF_AND_PLAN_SYSTEM, userMessage, { agentLabel: "brief_and_plan" });
  // Модель может вернуть вложенный { brief, plan } или плоский объект со всеми полями
  if (raw && typeof raw === "object" && "plan" in raw && raw.plan && typeof raw.plan === "object" && "moments" in raw.plan) {
    const plan = raw.plan as BossPlan;
    const brief = "brief" in raw && raw.brief && typeof raw.brief === "object" ? (raw.brief as ConceptBrief) : mapRawToBriefAndPlan(raw as unknown as BriefAndPlanRaw).brief;
    return { brief, plan };
  }
  return mapRawToBriefAndPlan(raw as unknown as BriefAndPlanRaw);
}

// --- Captions agent ---
const CAPTIONS_SYSTEM = `## Role
Write captions users would actually send in a private chat.

Captions are inner reactions or replies,
NOT descriptions of actions.

---

## HARD RULES (STRICT)
- EXACTLY 9 captions
- First-person only
- Very short captions.
- Target ~12–16 characters.
- Shorter is safer than longer.
- No emojis
- No narration
- One caption per line
- No alternatives
- No explanations

---

## TONE
Slight self-irony beats positivity. If a caption sounds confident out loud, rewrite as something you'd admit privately.
NOTE: Moments already include awkward / anti-postcard beats. Do NOT normalize them.

---

## SELF-CHECK (MANDATORY)
Before outputting:
- Ensure captions are very short and chat-like.
- Do NOT aim for exact character counts.

---

## OUTPUT
Output ONLY 9 captions, one per line.
Output as JSON: labels (array of 9 RU strings), labels_en (array of 9 EN strings).`;

export interface CriticFeedbackContext {
  suggestions: string[];
  reasons?: string[];
  previousSpec?: PackSpecRow;
}

// Slim + flat context per agent (docs/26-02-pack-agents-slim-context-tz.md: Level 1 + Level 2)
function formatCaptionsUserMessage(plan: BossPlan, criticFeedback?: CriticFeedbackContext): string {
  const moments = Array.isArray(plan.moments) ? plan.moments : [];
  const lines: string[] = ["MOMENTS:"];
  moments.forEach((m, i) => {
    lines.push(`${i + 1}. ${m}`);
  });
  lines.push("", `TONE: ${plan.tone ?? ""}`, "", "Output labels and labels_en as JSON.");
  let msg = lines.join("\n");
  if (criticFeedback?.suggestions?.length || criticFeedback?.reasons?.length || criticFeedback?.previousSpec) {
    const parts: string[] = [];
    parts.push("CRITICAL: Write only what the sender would send in a chat as a sticker. No narration, no description of actions.");
    if (criticFeedback.reasons?.length) {
      parts.push("Critic reasons (what was wrong):\n" + criticFeedback.reasons.join("\n"));
    }
    if (criticFeedback.previousSpec && (criticFeedback.previousSpec.labels?.length || criticFeedback.previousSpec.labels_en?.length)) {
      parts.push(
        "Previous version (rejected — improve this):\nlabels (RU): " +
          JSON.stringify(criticFeedback.previousSpec.labels) +
          "\nlabels_en (EN): " +
          JSON.stringify(criticFeedback.previousSpec.labels_en)
      );
    }
    if (criticFeedback.suggestions?.length) {
      parts.push("Critic suggestions (apply these fixes):\n" + criticFeedback.suggestions.join("\n"));
    }
    msg += "\n\n" + parts.join("\n\n");
  }
  return msg;
}

function formatScenesUserMessage(
  plan: BossPlan,
  outfit: string,
  criticFeedback?: CriticFeedbackContext,
  visualAnchors?: string[]
): string {
  const moments = Array.isArray(plan.moments) ? plan.moments : [];
  const lines: string[] = ["MOMENTS:"];
  moments.forEach((m, i) => {
    lines.push(`${i + 1}. ${m}`);
  });
  lines.push("", `SUBJECT_MODE: ${plan.subject_mode ?? "single"}`, `OUTFIT: ${outfit}`);
  if (Array.isArray(visualAnchors) && visualAnchors.length > 0) {
    lines.push("", `VISUAL_ANCHORS: ${visualAnchors.join(", ")}`);
  }
  lines.push("", "Output scene_descriptions as JSON.");
  let msg = lines.join("\n");
  if (criticFeedback?.suggestions?.length || criticFeedback?.reasons?.length || criticFeedback?.previousSpec) {
    const parts: string[] = [];
    if (criticFeedback.reasons?.length) {
      parts.push("Critic reasons (what was wrong):\n" + criticFeedback.reasons.join("\n"));
    }
    if (criticFeedback.previousSpec?.scene_descriptions?.length) {
      parts.push(
        "Previous version (rejected — improve this):\nscene_descriptions: " + JSON.stringify(criticFeedback.previousSpec.scene_descriptions)
      );
    }
    if (criticFeedback.suggestions?.length) {
      parts.push("Critic suggestions (apply these fixes):\n" + criticFeedback.suggestions.join("\n"));
    }
    msg += "\n\n" + parts.join("\n\n");
  }
  return msg;
}

function formatCriticUserMessage(spec: PackSpecRow): string {
  const lines: string[] = ["CAPTIONS (RU):"];
  (spec.labels ?? []).forEach((l, i) => {
    lines.push(`${i + 1}. ${l}`);
  });
  lines.push("", "CAPTIONS (EN):");
  (spec.labels_en ?? []).forEach((l, i) => {
    lines.push(`${i + 1}. ${l}`);
  });
  lines.push("", "SCENES (EN):");
  (spec.scene_descriptions ?? []).forEach((s, i) => {
    lines.push(`${i + 1}. ${s}`);
  });
  if (Array.isArray(spec.scene_descriptions_ru) && spec.scene_descriptions_ru.length > 0) {
    lines.push("", "SCENES (RU):");
    spec.scene_descriptions_ru.forEach((s, i) => {
      lines.push(`${i + 1}. ${s}`);
    });
  }
  lines.push("", "Output pass, reasons, and suggestions as JSON.");
  return lines.join("\n");
}

async function runCaptions(plan: BossPlan, criticFeedback?: CriticFeedbackContext): Promise<CaptionsOutput> {
  const model = await getModelForAgent("captions");
  const userMessage = formatCaptionsUserMessage(plan, criticFeedback);
  return openAiChatJson<CaptionsOutput>(model, CAPTIONS_SYSTEM, userMessage, { agentLabel: "captions" });
}

// --- Scenes agent (docs/pack-batch-flow-9-scenes-rules.md) ---
const SCENES_SYSTEM = `## Role
Write visual scene descriptions for image generation. ENGLISH ONLY. Scenes are for image generation only.

You describe ONLY how the same person from the reference photo moves and reacts.

---

## SUBJECT LOCK (CRITICAL)
- Each scene MUST start with \`{subject}\`
- \`{subject}\` appears EXACTLY once per scene
- NEVER use pronouns instead of \`{subject}\`
- NEVER introduce new people

---

## SCENE RULES
- Chest-up framing only
- One clear pose or body state
- Emotion through posture or tension, not facial traits
- Max 1 prop, fully visible
- Simple background only (flat, gradient, wall)

### Holiday theme
If holiday theme is active:
- Avoid work-related devices (laptops, work tasks).
- Phones are allowed only for messages or calls, not work or browsing.

### Holiday visual anchors
If VISUAL_ANCHORS are given in the user message (holiday objects):
- Use at least one anchor in at least half of the scenes.
- Anchor must be clearly visible and fully inside the frame.
- Do NOT hide or partially crop the anchor.

---

## LENGTH & STYLE (CRITICAL)
Each scene: EXACTLY one sentence. 12–18 words. One body action, one posture.
No metaphors. No cinematic language. Functional visual description only.
NOTE: Moments already include awkward / anti-postcard beats. Allow imbalance, hesitation, frozen mid-reaction; do NOT beautify.

---

## FORBIDDEN
- Emotions as words
- Metaphors
- Cinematic language
- Adverbs: suddenly, awkwardly, nervously
- Explanations or humor
Describe only visible body state.

### If holiday theme
- Avoid scenes that could belong to a normal workday.
- If the scene feels non-celebratory, rewrite it.

---

## OUTPUT (MANDATORY)
Output ONLY scene_descriptions (EN). Exactly 9 items. No Russian.`;

async function runScenes(
  plan: BossPlan,
  outfit: string,
  criticFeedback?: CriticFeedbackContext,
  visualAnchors?: string[]
): Promise<ScenesOutput> {
  const model = await getModelForAgent("scenes");
  const userMessage = formatScenesUserMessage(plan, outfit, criticFeedback, visualAnchors);
  const raw = await openAiChatJson<{ scene_descriptions: string[] }>(model, SCENES_SYSTEM, userMessage, { agentLabel: "scenes" });
  const sceneDescriptions = Array.isArray(raw.scene_descriptions) ? raw.scene_descriptions.slice(0, 9) : [];
  return { scene_descriptions: sceneDescriptions };
}

// --- Critic agent ---
const CRITIC_SYSTEM = `## Role
Act as a strict quality gate for format and usability.

---

## YOU MUST CHECK
- Exactly 9 captions
- Exactly 9 scenes (EN)
- Each scene starts with {subject} and has it exactly once
- Scene uniqueness
- Rule compliance

### If holiday theme
- Check that visual anchors appear in at least half of the scenes.
- Suggest specific scene indices if anchors are missing.

---

## TASTE CHECK (SOFT)
If everything feels emotionally safe or postcard-like, suggest more awkward or self-ironic moments. Do NOT fail for this alone.

If a holiday pack feels like a normal day with devices or neutral routines, suggest replacing neutral scenes with celebratory ones (by index). Do NOT fail for this alone.

---

## OUTPUT LIMITS (CRITICAL)
Reasons:
- Max 3 bullets
- Max 12 words per bullet

Suggestions:
- Max 3 bullets
- Max 12 words per bullet

No prose.
No restating rules.
No explanations.`;

async function runCritic(spec: PackSpecRow): Promise<CriticOutput> {
  const model = await getModelForAgent("critic");
  const userMessage = formatCriticUserMessage(spec);
  return openAiChatJson<CriticOutput>(model, CRITIC_SYSTEM, userMessage, { temperature: 1, agentLabel: "critic" });
}

// --- Partial rework: parse indices from Critic feedback ---
const CAPTION_INDEX_REG = /(?:caption|подпись|label|подписи)\s*[№#]?\s*(\d+)/gi;
const SCENE_INDEX_REG = /(?:scene|сцен[аы]|moment|момент)\s*[№#]?\s*(\d+)/gi;

function parseCriticIndices(reasons: string[] | undefined, suggestions: string[] | undefined): { captionIndices: number[]; sceneIndices: number[] } {
  const text = [...(reasons ?? []), ...(suggestions ?? [])].join(" ");
  const toZeroBased = (n: number) => (n >= 1 && n <= 9 ? n - 1 : n >= 0 && n <= 8 ? n : -1);
  const captionSet = new Set<number>();
  let m: RegExpExecArray | null;
  CAPTION_INDEX_REG.lastIndex = 0;
  while ((m = CAPTION_INDEX_REG.exec(text)) !== null) {
    const idx = toZeroBased(parseInt(m[1], 10));
    if (idx >= 0) captionSet.add(idx);
  }
  const sceneSet = new Set<number>();
  SCENE_INDEX_REG.lastIndex = 0;
  while ((m = SCENE_INDEX_REG.exec(text)) !== null) {
    const idx = toZeroBased(parseInt(m[1], 10));
    if (idx >= 0) sceneSet.add(idx);
  }
  return {
    captionIndices: Array.from(captionSet).sort((a, b) => a - b),
    sceneIndices: Array.from(sceneSet).sort((a, b) => a - b),
  };
}

/** Regenerate only captions at given 0-based indices. Returns arrays in same order as indices. */
async function runCaptionsForIndices(
  plan: BossPlan,
  criticContext: CriticFeedbackContext,
  indices: number[]
): Promise<{ labels: string[]; labels_en: string[] }> {
  if (indices.length === 0) return { labels: [], labels_en: [] };
  const model = await getModelForAgent("captions");
  const prev = criticContext.previousSpec;
  const moments = Array.isArray(plan.moments) ? plan.moments : [];
  const flatPlan = "MOMENTS:\n" + moments.map((m, i) => `${i + 1}. ${m}`).join("\n") + "\n\nTONE: " + (plan.tone ?? "");
  const userMessage =
    `The critic rejected specific captions. Regenerate ONLY the captions at 0-based indices: ${JSON.stringify(indices)}.\n\n` +
    `${flatPlan}\n\n` +
    (prev
      ? `Previous labels (RU): ${JSON.stringify(prev.labels)}\nPrevious labels_en (EN): ${JSON.stringify(prev.labels_en)}\n\n`
      : "") +
    `Critic reasons: ${(criticContext.reasons ?? []).join(" ")}\nCritic suggestions: ${criticContext.suggestions.join(" ")}\n\n` +
    `Output JSON with keys: labels (array of ${indices.length} strings, RU, in order of indices), labels_en (array of ${indices.length} strings, EN). Each caption 15–20 characters.`;
  const raw = await openAiChatJson<{ labels: string[]; labels_en: string[] }>(model, CAPTIONS_SYSTEM, userMessage, { agentLabel: "captions_rework" });
  const labels = Array.isArray(raw.labels) ? raw.labels.slice(0, indices.length) : [];
  const labels_en = Array.isArray(raw.labels_en) ? raw.labels_en.slice(0, indices.length) : [];
  return { labels, labels_en };
}

/** Regenerate only scene_descriptions at given 0-based indices. Returns array in same order as indices. */
async function runScenesForIndices(
  plan: BossPlan,
  outfit: string,
  criticContext: CriticFeedbackContext,
  indices: number[],
  visualAnchors?: string[]
): Promise<{ scene_descriptions: string[] }> {
  if (indices.length === 0) return { scene_descriptions: [] };
  const model = await getModelForAgent("scenes");
  const prev = criticContext.previousSpec;
  const moments = Array.isArray(plan.moments) ? plan.moments : [];
  let flatPlan =
    "MOMENTS:\n" +
    moments.map((m, i) => `${i + 1}. ${m}`).join("\n") +
    "\n\nSUBJECT_MODE: " +
    (plan.subject_mode ?? "single") +
    "\nOUTFIT: " +
    outfit;
  if (Array.isArray(visualAnchors) && visualAnchors.length > 0) {
    flatPlan += "\nVISUAL_ANCHORS: " + visualAnchors.join(", ");
  }
  const userMessage =
    `The critic rejected specific scenes. Regenerate ONLY the scene_descriptions at 0-based indices: ${JSON.stringify(indices)}.\n\n` +
    `${flatPlan}\n\n` +
    (prev?.scene_descriptions?.length
      ? `Previous scene_descriptions: ${JSON.stringify(prev.scene_descriptions)}\n\n`
      : "") +
    `Critic reasons: ${(criticContext.reasons ?? []).join(" ")}\nCritic suggestions: ${criticContext.suggestions.join(" ")}\n\n` +
    `Output JSON with one key: scene_descriptions (array of ${indices.length} strings, in order of indices). Each sentence 12–18 words, start with {subject}. No subordinate clauses.`;
  const raw = await openAiChatJson<{ scene_descriptions: string[] }>(model, SCENES_SYSTEM, userMessage, { agentLabel: "scenes_rework" });
  const scene_descriptions = Array.isArray(raw.scene_descriptions) ? raw.scene_descriptions.slice(0, indices.length) : [];
  return { scene_descriptions };
}

// --- Validation (docs/pack-batch-flow-9-scenes-rules.md) ---
const CAPTION_MIN_CHARS = 15;
const CAPTION_MAX_CHARS = 20;
const SCENE_MIN_WORDS = 12;
const SCENE_MAX_WORDS = 18;

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function countSubjectOccurrences(s: string): number {
  return (s.match(/\{subject\}/g) ?? []).length;
}

export function validateBatchSpec(spec: PackSpecRow): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const labels = spec.labels ?? [];
  const labelsEn = spec.labels_en ?? [];
  const scenes = spec.scene_descriptions ?? [];
  labels.forEach((l, i) => {
    const len = String(l).length;
    if (len < CAPTION_MIN_CHARS || len > CAPTION_MAX_CHARS) {
      errors.push(`Caption[${i}] RU length ${len} (expected ${CAPTION_MIN_CHARS}-${CAPTION_MAX_CHARS})`);
    }
  });
  labelsEn.forEach((l, i) => {
    const len = String(l).length;
    if (len < CAPTION_MIN_CHARS || len > CAPTION_MAX_CHARS) {
      errors.push(`Caption[${i}] EN length ${len} (expected ${CAPTION_MIN_CHARS}-${CAPTION_MAX_CHARS})`);
    }
  });
  scenes.forEach((s, i) => {
    const n = countSubjectOccurrences(s);
    if (n !== 1) {
      errors.push(`Scene[${i}] {subject} count ${n} (expected 1)`);
    }
    const w = countWords(s);
    if (w < SCENE_MIN_WORDS || w > SCENE_MAX_WORDS) {
      errors.push(`Scene[${i}] word count ${w} (expected ${SCENE_MIN_WORDS}-${SCENE_MAX_WORDS})`);
    }
  });
  return { ok: errors.length === 0, errors };
}

// --- Assembly: plan + captions + scenes → row ---
function assembleSpec(plan: BossPlan, captions: CaptionsOutput, scenes: ScenesOutput): PackSpecRow {
  return {
    id: plan.id,
    pack_template_id: plan.pack_template_id,
    name_ru: plan.name_ru,
    name_en: plan.name_en,
    carousel_description_ru: plan.carousel_description_ru,
    carousel_description_en: plan.carousel_description_en,
    labels: Array.isArray(captions.labels) ? captions.labels.slice(0, 9) : [],
    labels_en: Array.isArray(captions.labels_en) ? captions.labels_en.slice(0, 9) : [],
    scene_descriptions: Array.isArray(scenes.scene_descriptions) ? scenes.scene_descriptions.slice(0, 9) : [],
    scene_descriptions_ru: Array.isArray(scenes.scene_descriptions_ru) ? scenes.scene_descriptions_ru.slice(0, 9) : undefined,
    sort_order: Number(plan.sort_order) || 200,
    is_active: true,
    mood: plan.mood || "everyday",
    sticker_count: 9,
    subject_mode: plan.subject_mode,
    cluster: false,
    segment_id: plan.segment_id || "home",
  };
}

function normalizeSubjectType(
  subjectMode: string,
  subjectGender: string | null
): SubjectType {
  const mode = String(subjectMode || "").toLowerCase();
  const gender = String(subjectGender || "").toLowerCase();
  if (mode === "multi") return "couple";
  if (mode === "single") {
    if (gender === "female" || gender === "woman") return "single_female";
    if (gender === "male" || gender === "man") return "single_male";
  }
  return "unknown";
}

/** Progress stage keys for admin pack loading (passed to onProgress). */
export type PackPipelineStage =
  | "brief_and_plan"
  | "captions"
  | "scenes"
  | "critic"
  | "captions_rework"
  | "scenes_rework"
  | "critic_2";

/**
 * Run the full pipeline: Brief & Plan → Captions ∥ Scenes → Assembly → Critic.
 * On Critic fail, re-run Captions and Scenes with suggestions (max iterations).
 * Does NOT insert into DB; caller must ensure unique id and insert.
 * Optional onProgress(stage) is called after each step for loading UI.
 */
export async function runPackGenerationPipeline(
  request: string,
  subjectType: SubjectType,
  options?: { maxCriticIterations?: number; onProgress?: (stage: PackPipelineStage) => void | Promise<void> }
): Promise<PackGenerationResult> {
  const maxIterations = options?.maxCriticIterations ?? 2;
  const onProgress = options?.onProgress;

  const stageLabel = (stage: PackPipelineStage) => `[pack-multiagent] ${stage}`;
  const wrapStage = async <T>(stage: PackPipelineStage, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      throw new Error(`${stage}: ${msg}`);
    }
  };
  try {
    const t0 = Date.now();
    const { brief, plan } = await wrapStage("brief_and_plan", () => runConceptAndPlan(request, subjectType));
    console.log(stageLabel("brief_and_plan"), "done in", Date.now() - t0, "ms");
    await onProgress?.("brief_and_plan");

    const outfit = brief?.visual_anchors?.[0] ?? "none";
    const t2 = Date.now();
    let captions: CaptionsOutput;
    let scenes: ScenesOutput;
    [captions, scenes] = await Promise.all([
      wrapStage("captions", () => runCaptions(plan)),
      wrapStage("scenes", () => runScenes(plan, outfit, undefined, brief.visual_anchors)),
    ]);
    console.log("[pack-multiagent] captions + scenes (parallel) done in", Date.now() - t2, "ms");
    await onProgress?.("captions");
    await onProgress?.("scenes");
    let spec = assembleSpec(plan, captions, scenes);
    const validation = validateBatchSpec(spec);
    if (!validation.ok) {
      console.warn("[pack-multiagent] batch spec validation:", validation.errors);
    }

    for (let iter = 0; iter < maxIterations; iter++) {
      await onProgress?.(iter === 0 ? "critic" : "critic_2");
      // #region agent log
      const maxLenRu = Math.max(0, ...(spec.labels || []).map((l) => String(l).length));
      const maxLenEn = Math.max(0, ...(spec.labels_en || []).map((l) => String(l).length));
      fetch('http://127.0.0.1:7242/ingest/cee87e10-8efc-4a8c-a815-18fbbe1210d8',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5edd11'},body:JSON.stringify({sessionId:'5edd11',location:'pack-multiagent.ts:beforeCritic',message:'spec before Critic',data:{iter:iter+1,maxLabelLenRu:maxLenRu,maxLabelLenEn:maxLenEn,sampleRu:(spec.labels||[])[0],sampleEn:(spec.labels_en||[])[0]},timestamp:Date.now(),hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      const tCritic = Date.now();
      const critic = await wrapStage(iter === 0 ? "critic" : "critic_2", () => runCritic(spec));
      console.log(stageLabel(iter === 0 ? "critic" : "critic_2"), "done in", Date.now() - tCritic, "ms");
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/cee87e10-8efc-4a8c-a815-18fbbe1210d8',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5edd11'},body:JSON.stringify({sessionId:'5edd11',location:'pack-multiagent.ts:criticResult',message:'Critic result',data:{pass:critic.pass,reasonsCount:(critic.reasons||[]).length,firstReason:(critic.reasons||[])[0],suggestionsCount:(critic.suggestions||[]).length},timestamp:Date.now(),hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      console.log("[pack-multiagent] Critic iteration", iter + 1, "pass:", critic.pass, "reasons:", critic.reasons, "suggestions:", critic.suggestions);
      if (critic.pass) {
        return { ok: true, spec, plan, packId: spec.id };
      }
      if (iter === maxIterations - 1) {
        return {
          ok: false,
          error: "Pack rejected by Critic",
          criticReasons: critic.reasons,
          criticSuggestions: critic.suggestions,
          spec,
          plan,
        };
      }
      const criticContext: CriticFeedbackContext = {
        suggestions: critic.suggestions ?? [],
        reasons: critic.reasons,
        previousSpec: spec,
      };
      const { captionIndices, sceneIndices } = parseCriticIndices(critic.reasons, critic.suggestions);
      const usePartialCaptions = captionIndices.length > 0 && captionIndices.length <= 6;
      const usePartialScenes = sceneIndices.length > 0 && sceneIndices.length <= 6;
      const tRework = Date.now();
      const [captionsRework, scenesRework] = await Promise.all([
        usePartialCaptions
          ? wrapStage("captions_rework", () => runCaptionsForIndices(plan, criticContext, captionIndices)).then((partial) => {
              const nextLabels = [...(spec.labels ?? [])];
              const nextLabelsEn = [...(spec.labels_en ?? [])];
              captionIndices.forEach((idx, j) => {
                if (partial.labels[j] != null) nextLabels[idx] = partial.labels[j];
                if (partial.labels_en[j] != null) nextLabelsEn[idx] = partial.labels_en[j];
              });
              return { labels: nextLabels.slice(0, 9), labels_en: nextLabelsEn.slice(0, 9) };
            })
          : wrapStage("captions_rework", () => runCaptions(plan, criticContext)),
        usePartialScenes
          ? wrapStage("scenes_rework", () => runScenesForIndices(plan, outfit, criticContext, sceneIndices, brief.visual_anchors)).then((partial) => {
              const nextScenes = [...(spec.scene_descriptions ?? [])];
              sceneIndices.forEach((idx, j) => {
                if (partial.scene_descriptions[j] != null) nextScenes[idx] = partial.scene_descriptions[j];
              });
              return { scene_descriptions: nextScenes.slice(0, 9), scene_descriptions_ru: spec.scene_descriptions_ru ? spec.scene_descriptions_ru.slice(0, 9) : [] };
            })
          : wrapStage("scenes_rework", () => runScenes(plan, outfit, criticContext, brief.visual_anchors)),
      ]);
      captions = captionsRework as CaptionsOutput;
      scenes = scenesRework as ScenesOutput;
      console.log(
        "[pack-multiagent] rework done in",
        Date.now() - tRework,
        "ms",
        usePartialCaptions || usePartialScenes ? { captionIndices: usePartialCaptions ? captionIndices : "full", sceneIndices: usePartialScenes ? sceneIndices : "full" } : "(full)"
      );
      await onProgress?.("captions_rework");
      await onProgress?.("scenes_rework");
      spec = assembleSpec(plan, captions, scenes);
      const reworkValidation = validateBatchSpec(spec);
      if (!reworkValidation.ok) {
        console.warn("[pack-multiagent] batch spec validation (after rework):", reworkValidation.errors);
      }
    }

    return { ok: false, error: "Critic did not pass after max iterations" };
  } catch (err: any) {
    const message = err?.response?.data?.error?.message || err?.message || String(err);
    console.error("[pack-multiagent] pipeline error:", message);
    return { ok: false, error: message };
  }
}

/**
 * One rework iteration: Captions(plan, suggestions, previousSpec, reasons?) → Scenes → Assembly → Critic.
 * Used when admin taps "Переделать" to iterate without re-running Concept/Boss.
 * Agents receive previous context: reasons + suggestions and the rejected spec (labels, scene_descriptions).
 */
export async function reworkOneIteration(
  plan: BossPlan,
  suggestions: string[],
  previousSpec?: PackSpecRow | null,
  reasons?: string[] | null
): Promise<{ spec: PackSpecRow; critic: CriticOutput }> {
  const criticContext: CriticFeedbackContext = {
    suggestions: suggestions?.length ? suggestions : [],
    reasons: reasons?.length ? reasons : undefined,
    previousSpec: previousSpec ?? undefined,
  };
  const hasContext =
    criticContext.suggestions.length > 0 ||
    (criticContext.reasons?.length ?? 0) > 0 ||
    !!criticContext.previousSpec;
  const outfit = "none";
  const [captions, scenes] = await Promise.all([
    runCaptions(plan, hasContext ? criticContext : undefined),
    runScenes(plan, outfit, hasContext ? criticContext : undefined),
  ]);
  const spec = assembleSpec(plan, captions, scenes);
  const critic = await runCritic(spec);
  console.log("[pack-multiagent] Rework Critic pass:", critic.pass, "reasons:", critic.reasons, "suggestions:", critic.suggestions);
  return { spec, critic };
}

/** Build minimal BossPlan from PackSpecRow when pending_pack_plan was not persisted (e.g. migration 113 not applied). */
export function specToMinimalPlan(spec: PackSpecRow): BossPlan {
  return {
    id: spec.id,
    pack_template_id: spec.pack_template_id,
    subject_mode: spec.subject_mode,
    name_ru: spec.name_ru,
    name_en: spec.name_en,
    carousel_description_ru: spec.carousel_description_ru,
    carousel_description_en: spec.carousel_description_en,
    mood: spec.mood || "everyday",
    sort_order: Number(spec.sort_order) || 200,
    segment_id: spec.segment_id || "home",
    story_arc: "",
    tone: "",
    moments: Array.isArray(spec.labels) && spec.labels.length >= 9
      ? spec.labels.slice(0, 9)
      : Array(9).fill("moment"),
  };
}

/**
 * Derive SubjectType from session (subject_mode + subject_gender).
 * Use when we have already run subject detection on the user's photo.
 */
export function subjectTypeFromSession(session: {
  subject_mode?: string;
  object_mode?: string;
  subject_gender?: string | null;
  object_gender?: string | null;
}): SubjectType {
  const mode = session?.object_mode ?? session?.subject_mode ?? "unknown";
  const gender = session?.object_gender ?? session?.subject_gender ?? null;
  return normalizeSubjectType(mode, gender);
}
