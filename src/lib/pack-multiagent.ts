/**
 * Multi-agent pack generation pipeline (OpenAI).
 * Concept → Boss; then Captions and Scenes in parallel; then Assembly → Critic.
 * Used only in test bot; admin-only "Сгенерировать пак" button.
 */

import axios from "axios";
import { config } from "../config";
import { getAppConfig } from "./app-config";

/** Number of stickers in pack (docs/28-02-pack-sticker-count-9-to-16.md, docs/final-promt-16.md). */
const PACK_STICKER_COUNT = 16;

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
  /** Visual commitment: 1-based scene numbers with visible outfit change (≥5). */
  outfit_change_scenes?: number[];
  /** Visual commitment: 1-based scene numbers with distinctive props (≥5). */
  prop_scenes?: number[];
  /** Visual commitment: 1-based scene numbers for hero/power moment (exactly 2). */
  hero_scenes?: number[];
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
  /** Captions — план → 16 подписей RU + EN */
  captions: "pack_openai_model_captions",
  /** Scenes — план → 16 scene_descriptions с {subject} */
  scenes: "pack_openai_model_scenes",
  /** Critic — полный спек → pass/fail + reasons + suggestions (строгий gate) */
  critic: "pack_openai_model_critic",
} as const;

const OPENAI_TIMEOUT_MS = 300_000;

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
  options?: { temperature?: number; agentLabel?: string; maxCompletionTokens?: number }
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
  if (typeof options?.maxCompletionTokens === "number" && options.maxCompletionTokens > 0) {
    body.max_completion_tokens = options.maxCompletionTokens;
  }
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

// --- Brief & Plan — idea generator + strict plan ---
const BRIEF_AND_PLAN_SYSTEM = `## Role
You create sticker pack concepts people WANT to SEND.
If something is correct but boring — it is WRONG.

---

## CORE PRINCIPLE
Shareability > correctness.
Risk > comfort.
Recognition > beauty.

---

## BRIEF RULES
- One clear social situation.
- One emotional tension.
- One uncomfortable or revealing truth.

---

## ANTI-COMFORT RULE (CRITICAL)
At least 80% of moments must feel slightly awkward,
too honest, or socially risky to send.

---

## STRUCTURE
Create EXACTLY 16 moments forming one pack.

---

## VISUAL COMMITMENT STEP (CRITICAL)
Before writing moments, explicitly commit to:
- which scene numbers include visible outfit changes (at least 5)
- which scene numbers include distinctive, eye-catching props (at least 5)
- which scene number is the hero / power moment (exactly 2)

This commitment must be part of the plan
and must be followed exactly by Scenes.

---

## ROLE-SWITCH LOGIC
When the role changes (work / care / self / power),
a corresponding outfit or gear change is REQUIRED.

---

## SELF-CHECK
If this pack would not make someone say
"oh no… that's me" — regenerate.

---

## OUTPUT (CRITICAL)
Output EXACTLY one JSON. No prose.
Field values: short phrases. Moments: max 8–10 words each.

Brief keys: subject_type, setting, persona, tone, timeline ("one_day"), situation_types, shareability_hook, title_hint, visual_anchors (array; first item = outfit or "none" if N/A).

Plan keys: id, pack_template_id, subject_mode (MUST be exactly "single" or "multi", never "photo"), name_ru, name_en, carousel_description_ru, carousel_description_en, mood, sort_order, segment_id, story_arc, tone, moments (array of EXACTLY 16 strings), outfit_change_scenes (array of 1-based scene numbers, at least 5), prop_scenes (array of 1-based scene numbers, at least 5), hero_scenes (array of exactly 2 1-based scene numbers).`;

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
    moments: (raw.moments ?? []).slice(0, PACK_STICKER_COUNT),
    outfit_change_scenes: raw.outfit_change_scenes,
    prop_scenes: raw.prop_scenes,
    hero_scenes: raw.hero_scenes,
  };
  return { brief, plan };
}

async function runConceptAndPlan(request: string, subjectType: SubjectType): Promise<{ brief: ConceptBrief; plan: BossPlan }> {
  const model = await getModelForAgent("brief_and_plan");
  const userMessage = `User request: ${request}\n\nPhoto context (subject_type): ${subjectType}\n\nOutput the combined brief and plan as a single JSON.`;
  const raw = await openAiChatJson<BriefAndPlanRaw | { brief: ConceptBrief; plan: BossPlan }>(model, BRIEF_AND_PLAN_SYSTEM, userMessage, {
    agentLabel: "brief_and_plan",
    maxCompletionTokens: 16000,
  });
  // Модель может вернуть вложенный { brief, plan } или плоский объект со всеми полями
  if (raw && typeof raw === "object" && "plan" in raw && raw.plan && typeof raw.plan === "object" && "moments" in raw.plan) {
    const plan = raw.plan as BossPlan;
    plan.moments = (plan.moments ?? []).slice(0, PACK_STICKER_COUNT);
    const brief = "brief" in raw && raw.brief && typeof raw.brief === "object" ? (raw.brief as ConceptBrief) : mapRawToBriefAndPlan(raw as unknown as BriefAndPlanRaw).brief;
    return { brief, plan };
  }
  return mapRawToBriefAndPlan(raw as unknown as BriefAndPlanRaw);
}

/** Normalize plan.subject_mode from subjectType (model sometimes returns "photo" or wrong value). */
function normalizePlanSubjectMode(plan: BossPlan, subjectType: SubjectType): void {
  const mode = subjectType === "couple" ? "multi" : "single";
  if (plan.subject_mode !== "single" && plan.subject_mode !== "multi") {
    plan.subject_mode = mode;
  }
}

/** Subject gender for Captions (RU grammar) and Scenes (who we describe). */
function subjectGenderFromType(subjectType: SubjectType): "male" | "female" | "neutral" {
  if (subjectType === "single_male") return "male";
  if (subjectType === "single_female") return "female";
  return "neutral";
}

/** Parse subject type from theme request text when user explicitly mentions men/male or women/female. Overrides session when theme says e.g. "(Men)", "Single male.", "subject_type = single_male". */
export function parseSubjectTypeFromThemeRequest(request: string): SubjectType | null {
  if (!request || typeof request !== "string") return null;
  const maleHints = /\b(man|men|male|single_male|single male|мужчин|мужск|для мужчин)\b|\(men\)|\(m\)|^he\s|\she\s|subject_type\s*=\s*single_male/i;
  const femaleHints = /\b(woman|women|female|single_female|single female|женщин|женск|для женщин)\b|\(women\)|\(w\)|^she\s|\sshe\s|subject_type\s*=\s*single_female/i;
  const hasMale = maleHints.test(request);
  const hasFemale = femaleHints.test(request);
  if (hasMale && !hasFemale) return "single_male";
  if (hasFemale && !hasMale) return "single_female";
  return null;
}

// --- Captions — shareability filter ---
const CAPTIONS_SYSTEM = `## Role
You write captions people hesitate to send — and send anyway.

---

## CORE RULE
A caption is a CHAT REPLY, not a description or thought.

---

## VALUES
Honesty > politeness.
Recognition > explanation.
Risk > safety.

---

## FORMAT
- 2–5 words
- chat-like, first-person
- broken grammar allowed
- ellipses and unfinished thoughts encouraged
- RU captions: 2-15 characters max
- EN captions: 2-18 characters max

---

## TONE EXAMPLES (reference only, do NOT copy)
RU: "ну всё, я легла" / "а можно не надо" / "это не я" / "справлюсь. наверное" / "не трогай"
EN: "handled." / "not now" / "oh no, that's me" / "fine. totally fine" / "leave me alone"

---

## INDEX BINDING (CRITICAL)
Caption N must be the chat reply for moment N only.
labels[0] = reply for moment 1, labels[1] = reply for moment 2, … labels[15] = reply for moment 16.
Do not assign captions by mood slot — assign by matching the situation in that moment.

## STRUCTURE (16 captions in 4 blocks)
1–4:   Quiet, grounded (but still tied to moments 1–4)
5–8:   Everyday, relatable (tied to moments 5–8)
9–12:  Sharp, reactive (tied to moments 9–12)
13–16: Decisive, closing (tied to moments 13–16)

Avoid same intensity across all 16. Each caption must fit its moment.

---

## FORBIDDEN
- describing actions
- explaining emotions
- motivational or inspirational tone
- literary or poetic language
- neutral or polite statements

---

## REQUIRED
- captions must feel slightly exposing
- captions must work without context
- captions must trigger recognition or tension

---

## CAPTION SHARPNESS RULE
Reject captions that feel descriptive or passive.
Prefer reactions that sound like a reflex.

---

## BAN ABSTRACT REACTIONS
Avoid captions like "logic", "silence", "small smile".
Use concrete, sendable reactions, not abstract labels.

---

## SENDABILITY GATE (CRITICAL)
If a caption feels 100% comfortable to send —
it is INVALID.

If a caption makes you hesitate for half a second —
it is GOOD.

---

## SELF-CHECK
Ask: "Would a real person type this in a chat?"
If no — rewrite.

---

## OUTPUT (CRITICAL)
EXACTLY 16 captions. Order is binding: labels[i] and labels_en[i] are the chat reply for moment i+1 only.
Output as JSON:
- labels (array of 16 RU strings, index 0 = moment 1, … index 15 = moment 16)
- labels_en (array of 16 EN strings, same order)`;

export interface CriticFeedbackContext {
  suggestions: string[];
  reasons?: string[];
  previousSpec?: PackSpecRow;
}

// Slim + flat context per agent (docs/26-02-pack-agents-slim-context-tz.md: Level 1 + Level 2)
function formatCaptionsUserMessage(plan: BossPlan, subjectType: SubjectType, criticFeedback?: CriticFeedbackContext): string {
  const moments = Array.isArray(plan.moments) ? plan.moments : [];
  const lines: string[] = ["MOMENTS:"];
  moments.forEach((m, i) => {
    lines.push(`${i + 1}. ${m}`);
  });
  const gender = subjectGenderFromType(subjectType);
  lines.push("", `TONE: ${plan.tone ?? ""}`);
  if (gender === "male") {
    lines.push(
      "",
      "SUBJECT: male (CRITICAL). Russian labels MUST use masculine verb forms. WRONG: сделала, надела, отправила, села, оставила, закрыла. RIGHT: сделал, надел, отправил, сел, оставил, закрыл. Every past-tense verb in labels must end in -л (masculine), never -ла (feminine)."
    );
  } else if (gender === "female") {
    lines.push(
      "",
      "SUBJECT: female (CRITICAL). Russian labels MUST use feminine grammatical forms: e.g. видела, поняла, сделала — NOT masculine (видел, понял, сделал)."
    );
  }
  lines.push("", "Write one caption per moment: caption 1 for moment 1, caption 2 for moment 2, … caption 16 for moment 16. Output labels and labels_en as JSON.");
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
  subjectType: SubjectType,
  criticFeedback?: CriticFeedbackContext,
  visualAnchors?: string[]
): string {
  const moments = Array.isArray(plan.moments) ? plan.moments : [];
  const lines: string[] = ["MOMENTS:"];
  moments.forEach((m, i) => {
    lines.push(`${i + 1}. ${m}`);
  });
  const gender = subjectGenderFromType(subjectType);
  lines.push("", `SUBJECT_MODE: ${plan.subject_mode ?? "single"}`);
  if (gender !== "neutral") {
    lines.push(`SUBJECT_GENDER: ${gender}. The person in the photo is ${gender === "male" ? "male" : "female"} — describe posture, expression, and styling to match. Do NOT write "man", "woman", "male", or "female" in the scene text; use only {subject}.`);
  }
  lines.push(`OUTFIT: ${outfit}`);
  if (Array.isArray(plan.outfit_change_scenes) && plan.outfit_change_scenes.length > 0) {
    lines.push("", `OUTFIT_CHANGE_SCENES (must show visible clothing change): ${plan.outfit_change_scenes.join(", ")}`);
  }
  if (Array.isArray(plan.prop_scenes) && plan.prop_scenes.length > 0) {
    lines.push("", `PROP_SCENES (must include eye-catching, non-routine prop): ${plan.prop_scenes.join(", ")}`);
  }
  if (Array.isArray(plan.hero_scenes) && plan.hero_scenes.length > 0) {
    lines.push("", `HERO_SCENES (must stand out by posture, presence, or iconic prop): ${plan.hero_scenes.join(", ")}`);
  }
  if (Array.isArray(visualAnchors) && visualAnchors.length > 0) {
    lines.push("", `VISUAL_ANCHORS: ${visualAnchors.join(", ")}`);
  }
  lines.push("", "Write one scene per moment: scene 1 for moment 1, scene 2 for moment 2, … scene 16 for moment 16. Output scene_descriptions as JSON.");
  let msg = lines.join("\n");
  if (criticFeedback?.suggestions?.length || criticFeedback?.reasons?.length || criticFeedback?.previousSpec) {
    const parts: string[] = [];
    if (criticFeedback.reasons?.length) {
      parts.push("Critic reasons (what was wrong):\n" + criticFeedback.reasons.join("\n"));
    }
    if (criticFeedback.previousSpec?.scene_descriptions?.length) {
      const compactPrevious = criticFeedback.previousSpec.scene_descriptions
        .slice(0, PACK_STICKER_COUNT)
        .map((s, i) => `${i + 1}. ${String(s).slice(0, 120)}`)
        .join("\n");
      parts.push("Previous version (rejected — improve this):\n" + compactPrevious);
    }
    if (criticFeedback.suggestions?.length) {
      parts.push("Critic suggestions (apply these fixes):\n" + criticFeedback.suggestions.join("\n"));
    }
    msg += "\n\n" + parts.join("\n\n");
  }
  return msg;
}

function formatCriticUserMessage(spec: PackSpecRow, subjectType?: SubjectType): string {
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
  if (subjectType === "single_male" || subjectType === "single_female") {
    lines.push("", `SUBJECT_TYPE: ${subjectType}. Check RU captions use correct grammatical gender.`);
  }
  lines.push("", "Output pass, reasons, and suggestions as JSON.");
  return lines.join("\n");
}

async function runCaptions(plan: BossPlan, subjectType: SubjectType, criticFeedback?: CriticFeedbackContext): Promise<CaptionsOutput> {
  const model = await getModelForAgent("captions");
  const userMessage = formatCaptionsUserMessage(plan, subjectType, criticFeedback);
  return openAiChatJson<CaptionsOutput>(model, CAPTIONS_SYSTEM, userMessage, {
    agentLabel: "captions",
    maxCompletionTokens: 16000,
  });
}

// --- Scenes — visual "WOW" engine, executes plan ---
const SCENES_SYSTEM = `## Role
You execute the plan exactly.
You do NOT decide what to include — you perform it. ENGLISH ONLY.

---

## CORE RULE
Flat realism is forbidden.
Scenes must exaggerate emotion by 10–20%.

---

## EXECUTION RULES (CRITICAL)
- Scene numbers marked as outfit changes MUST show
  visually obvious clothing changes
  (jacket on/off, layer added/removed).
  Minor adjustments do NOT count.
- Scene numbers marked as distinctive props MUST include
  eye-catching, non-routine items.
- The hero scene MUST visually stand out through posture,
  presence, or iconic prop.
  No fantasy, no costumes.

---

## CONSISTENCY RULE
Face, body, and identity remain consistent.
Clothing, outer layers, and gear may change
to signal role or power shifts.

---

## ANTI-NEUTRAL RULE
At least 4 scenes must feel awkward,
uncomfortable, frozen, or overreactive.

---

## ANTI-DEVICE RULE
No more than 3 scenes with phones or laptops.

---

## PROP USAGE LIMIT (CRITICAL)
No more than 6 scenes may include eye-catching or playful props.
Remaining scenes must rely on posture, face, or stillness only.
Props are a special effect, not the base.

---

## STATE VARIATION RULE
Across the pack, the subject must visibly shift between:
- confused
- skeptical
- amused
- firm
- withdrawn
- relaxed
Outfit or styling alone does not count as variation.

---

## NO REPEATED GIMMICKS
Do not reuse the same visual trick
(red lipstick emphasis, raised eyebrow exaggeration, props)
more than twice across the pack.

---

## SELF-CHECK
If a scene looks like stock photography — discard it.
If a scene feels "nice" — push it further.

---

## RENDER CONTEXT (CRITICAL)
These scenes will be rendered as stickers:
- Flat background (no environment). Background will be removed later.
- Do NOT describe rooms, doors, furniture, or walls.
- Props must be handheld or on-body only.

---

## FRAMING
- Default: chest-up (mid-torso to head).
- For OUTFIT_CHANGE_SCENES: half-body (waist-up) allowed so clothing changes are clearly visible.

---

## SUBJECT LOCK (CRITICAL)
- Each scene MUST start with \`{subject}\`
- \`{subject}\` appears EXACTLY once per scene
- NEVER use pronouns instead of {subject}
- NEVER introduce other people
- FORBIDDEN in scene text: the words "man", "woman", "male", "female", "boy", "girl", "dark-bob woman", "young man", etc. Do NOT name the gender in the description. Use ONLY \`{subject}\` for the person. SUBJECT_GENDER (in the user message) tells you who to describe so posture and styling match; the scene output must contain only \`{subject}\`, e.g. "{subject} chest-up, arms crossed, ..." not "{subject} woman chest-up ..."

---

## TECHNICAL
- One clear body state. Max 1 prop. Simple or flat background only.
- EXACTLY one sentence per scene. 12–18 words.
- No speech, thought, or narrative verbs. Purely visual.

---

## OUTPUT (CRITICAL)
Output ONLY scene_descriptions (array of EXACTLY 16 EN strings). Order is binding: scene_descriptions[0] = visual for moment 1, … scene_descriptions[15] = visual for moment 16.`;

async function runScenes(
  plan: BossPlan,
  outfit: string,
  subjectType: SubjectType,
  criticFeedback?: CriticFeedbackContext,
  visualAnchors?: string[]
): Promise<ScenesOutput> {
  const model = await getModelForAgent("scenes");
  const userMessage = formatScenesUserMessage(plan, outfit, subjectType, criticFeedback, visualAnchors);
  const raw = await openAiChatJson<{ scene_descriptions: string[] }>(model, SCENES_SYSTEM, userMessage, {
    agentLabel: "scenes",
    maxCompletionTokens: 16000,
  });
  const sceneDescriptions = Array.isArray(raw.scene_descriptions) ? raw.scene_descriptions.slice(0, PACK_STICKER_COUNT) : [];
  return { scene_descriptions: sceneDescriptions };
}

// --- Critic — no mercy mode ---
const CRITIC_SYSTEM = `## Role
You reject anything that would not be shared.

---

## PASS CONDITIONS
- At least 60% of stickers feel emotionally risky
- At least 5 stickers feel awkward, too honest, or exposing
- Captions are short, sharp, and chat-like
- Scenes exaggerate emotion beyond realism
- Outfit changes, props, and hero scene match the plan exactly

---

## FAIL CONDITIONS
- Neutral or polite reactions
- "Nice", safe, or generic vibes
- Descriptive or explanatory captions
- Planned outfit or prop scenes not executed
- Hero scene does not stand out visually

---

## STANDARD
If the pack feels "fine" — FAIL IT.
If it feels "a bit much" — APPROVE IT.

Prefer rejecting good packs
over approving boring ones.

---

## TECHNICAL CHECK
- Each scene must work as an isolated chest-up (or waist-up) sticker; no background-dependent staging (rooms, doors, large furniture).
- No more than 3 scenes with the same body posture (e.g. arms crossed, hands on hips).
- Do NOT fail by "too many chest-up scenes": chest-up is the default framing in this pipeline.

---

## EMOTIONAL ARC CHECK
- Pack must have variety: quiet + everyday + sharp + decisive. If all 16 feel the same intensity — FAIL.
- At least 2–3 quiet/grounded, 2–3 everyday, 2–3 sharp, 2–3 decisive or closing.

---

## CAPTION–SCENE MATCH (CRITICAL)
- Caption N must match the situation/emotion of scene N. If caption 5 describes a different moment than what scene 5 shows — FAIL.
- Reject if captions feel generic or shuffled (could apply to any sticker in the pack).

---

## FORMAT CHECK (CRITICAL)
- Exactly 16 captions, exactly 16 scenes
- All scenes start with {subject} exactly once

---

## GENDER CHECK (when SUBJECT_TYPE is given)
If SUBJECT_TYPE = single_male: Russian captions MUST use masculine verb forms (сделал, надел, отправил, сел, оставил, закрыл). FAIL if any caption uses feminine -ла forms (сделала, надела, отправила, села, оставила, закрыла). Suggest: "Fix caption N: use masculine form."
If SUBJECT_TYPE = single_female: Russian captions MUST use feminine forms. FAIL if masculine forms used for a female subject.

---

## OUTPUT
JSON only: pass (boolean), reasons (array, max 3 items, max 12 words each), suggestions (array, max 3 items, max 12 words each). No prose.`;

async function runCritic(spec: PackSpecRow, subjectType?: SubjectType): Promise<CriticOutput> {
  const model = await getModelForAgent("critic");
  const userMessage = formatCriticUserMessage(spec, subjectType);
  return openAiChatJson<CriticOutput>(model, CRITIC_SYSTEM, userMessage, {
    temperature: 1,
    agentLabel: "critic",
    maxCompletionTokens: 16000,
  });
}

// --- Partial rework: parse indices from Critic feedback ---
const CAPTION_INDEX_REG = /(?:caption|подпись|label|подписи)\s*[№#]?\s*(\d+)/gi;
const SCENE_INDEX_REG = /(?:scene|сцен[аы]|moment|момент)\s*[№#]?\s*(\d+)/gi;

function parseCriticIndices(reasons: string[] | undefined, suggestions: string[] | undefined): { captionIndices: number[]; sceneIndices: number[] } {
  const text = [...(reasons ?? []), ...(suggestions ?? [])].join(" ");
  const toZeroBased = (n: number) => (n >= 1 && n <= PACK_STICKER_COUNT ? n - 1 : n >= 0 && n < PACK_STICKER_COUNT ? n : -1);
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
  subjectType: SubjectType,
  criticContext: CriticFeedbackContext,
  indices: number[]
): Promise<{ labels: string[]; labels_en: string[] }> {
  if (indices.length === 0) return { labels: [], labels_en: [] };
  const model = await getModelForAgent("captions");
  const prev = criticContext.previousSpec;
  const moments = Array.isArray(plan.moments) ? plan.moments : [];
  const gender = subjectGenderFromType(subjectType);
  const selectedMoments = indices.map((idx) => `${idx}: ${moments[idx] ?? ""}`).join("\n");
  let flatPlan = "REJECTED_MOMENTS_BY_INDEX:\n" + selectedMoments + "\n\nTONE: " + (plan.tone ?? "");
  if (gender === "male") flatPlan += "\n\nSUBJECT: male. Russian labels MUST use masculine forms (видел, понял), NOT feminine (видела, поняла).";
  else if (gender === "female") flatPlan += "\n\nSUBJECT: female. Russian labels MUST use feminine forms (видела, поняла).";
  const userMessage =
    `The critic rejected specific captions. Regenerate ONLY the captions at 0-based indices: ${JSON.stringify(indices)}.\n\n` +
    `${flatPlan}\n\n` +
    (prev
      ? `Previous labels (RU): ${JSON.stringify(prev.labels)}\nPrevious labels_en (EN): ${JSON.stringify(prev.labels_en)}\n\n`
      : "") +
    `Critic reasons: ${(criticContext.reasons ?? []).join(" ")}\nCritic suggestions: ${criticContext.suggestions.join(" ")}\n\n` +
    `Output JSON with keys: labels (array of ${indices.length} strings, RU, in order of indices), labels_en (array of ${indices.length} strings, EN). RU: 2-15 chars each, EN: 2-18 chars each.`;
  const raw = await openAiChatJson<{ labels: string[]; labels_en: string[] }>(model, CAPTIONS_SYSTEM, userMessage, {
    agentLabel: "captions_rework",
    maxCompletionTokens: 16000,
  });
  const labels = Array.isArray(raw.labels) ? raw.labels.slice(0, indices.length) : [];
  const labels_en = Array.isArray(raw.labels_en) ? raw.labels_en.slice(0, indices.length) : [];
  return { labels, labels_en };
}

/** Regenerate only scene_descriptions at given 0-based indices. Returns array in same order as indices. */
async function runScenesForIndices(
  plan: BossPlan,
  outfit: string,
  subjectType: SubjectType,
  criticContext: CriticFeedbackContext,
  indices: number[],
  visualAnchors?: string[]
): Promise<{ scene_descriptions: string[] }> {
  if (indices.length === 0) return { scene_descriptions: [] };
  const model = await getModelForAgent("scenes");
  const prev = criticContext.previousSpec;
  const moments = Array.isArray(plan.moments) ? plan.moments : [];
  const gender = subjectGenderFromType(subjectType);
  const selectedMoments = indices.map((idx) => `${idx}: ${moments[idx] ?? ""}`).join("\n");
  const previousSelectedScenes = prev?.scene_descriptions?.length
    ? indices.map((idx) => `${idx}: ${prev.scene_descriptions[idx] ?? ""}`).join("\n")
    : "";
  let flatPlan =
    "REJECTED_MOMENTS_BY_INDEX:\n" +
    selectedMoments +
    "\n\nSUBJECT_MODE: " +
    (plan.subject_mode ?? "single");
  if (gender !== "neutral") {
    flatPlan += `\nSUBJECT_GENDER: ${gender}. Person is ${gender}. Do NOT write "man" or "woman" in scene text — use only {subject}.`;
  }
  flatPlan += "\nOUTFIT: " + outfit;
  if (Array.isArray(visualAnchors) && visualAnchors.length > 0) {
    flatPlan += "\nVISUAL_ANCHORS: " + visualAnchors.join(", ");
  }
  const userMessage =
    `The critic rejected specific scenes. Regenerate ONLY the scene_descriptions at 0-based indices: ${JSON.stringify(indices)}.\n\n` +
    `${flatPlan}\n\n` +
    (previousSelectedScenes
      ? `Previous scene_descriptions by same indices:\n${previousSelectedScenes}\n\n`
      : "") +
    `Critic reasons: ${(criticContext.reasons ?? []).join(" ")}\nCritic suggestions: ${criticContext.suggestions.join(" ")}\n\n` +
    `Output JSON with one key: scene_descriptions (array of ${indices.length} strings, in order of indices). Each sentence 12–18 words, start with {subject}. No subordinate clauses.`;
  const raw = await openAiChatJson<{ scene_descriptions: string[] }>(model, SCENES_SYSTEM, userMessage, {
    agentLabel: "scenes_rework",
    maxCompletionTokens: 16000,
  });
  const scene_descriptions = Array.isArray(raw.scene_descriptions) ? raw.scene_descriptions.slice(0, indices.length) : [];
  return { scene_descriptions };
}

// --- Validation (docs/pack-batch-flow-9-scenes-rules.md, 16 in docs/final-promt-16.md) ---
/** Caption hard limits for sticker readability in Telegram. */
const CAPTION_MIN_CHARS = 2;
const CAPTION_MAX_CHARS_RU = 15;
const CAPTION_MAX_CHARS_EN = 18;
const SCENE_MIN_WORDS = 12;
const SCENE_MAX_WORDS = 18;

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function countSubjectOccurrences(s: string): number {
  return (s.match(/\{subject\}/g) ?? []).length;
}

function normalizeCaptionLength(text: string, maxChars: number): string {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (raw.length <= maxChars) return raw;

  // First, try truncating by words while preserving readability.
  const words = raw.split(" ");
  let best = "";
  for (const w of words) {
    const candidate = best ? `${best} ${w}` : w;
    if (candidate.length > maxChars) break;
    best = candidate;
  }
  if (best.length >= CAPTION_MIN_CHARS) {
    return best.replace(/[.,;:!?…-]+$/g, "").trim();
  }

  // Fallback: hard cut.
  return raw.slice(0, maxChars).replace(/[.,;:!?…-]+$/g, "").trim();
}

function normalizeCaptions(captions: CaptionsOutput): CaptionsOutput {
  return {
    labels: (captions.labels ?? [])
      .slice(0, PACK_STICKER_COUNT)
      .map((c) => normalizeCaptionLength(c, CAPTION_MAX_CHARS_RU))
      .map((c) => (c.length < CAPTION_MIN_CHARS ? c.slice(0, CAPTION_MIN_CHARS) : c)),
    labels_en: (captions.labels_en ?? [])
      .slice(0, PACK_STICKER_COUNT)
      .map((c) => normalizeCaptionLength(c, CAPTION_MAX_CHARS_EN))
      .map((c) => (c.length < CAPTION_MIN_CHARS ? c.slice(0, CAPTION_MIN_CHARS) : c)),
  };
}

export function validateBatchSpec(spec: PackSpecRow): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const labels = spec.labels ?? [];
  const labelsEn = spec.labels_en ?? [];
  const scenes = spec.scene_descriptions ?? [];
  labels.forEach((l, i) => {
    const len = String(l).length;
    if (len < CAPTION_MIN_CHARS || len > CAPTION_MAX_CHARS_RU) {
      errors.push(`Caption[${i}] RU length ${len} (expected ${CAPTION_MIN_CHARS}-${CAPTION_MAX_CHARS_RU})`);
    }
  });
  labelsEn.forEach((l, i) => {
    const len = String(l).length;
    if (len < CAPTION_MIN_CHARS || len > CAPTION_MAX_CHARS_EN) {
      errors.push(`Caption[${i}] EN length ${len} (expected ${CAPTION_MIN_CHARS}-${CAPTION_MAX_CHARS_EN})`);
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
  const normalizedCaptions = normalizeCaptions(captions);
  return {
    id: plan.id,
    pack_template_id: plan.pack_template_id,
    name_ru: plan.name_ru,
    name_en: plan.name_en,
    carousel_description_ru: plan.carousel_description_ru,
    carousel_description_en: plan.carousel_description_en,
    labels: Array.isArray(normalizedCaptions.labels) ? normalizedCaptions.labels.slice(0, PACK_STICKER_COUNT) : [],
    labels_en: Array.isArray(normalizedCaptions.labels_en) ? normalizedCaptions.labels_en.slice(0, PACK_STICKER_COUNT) : [],
    scene_descriptions: Array.isArray(scenes.scene_descriptions) ? scenes.scene_descriptions.slice(0, PACK_STICKER_COUNT) : [],
    scene_descriptions_ru: Array.isArray(scenes.scene_descriptions_ru) ? scenes.scene_descriptions_ru.slice(0, PACK_STICKER_COUNT) : undefined,
    sort_order: Number(plan.sort_order) || 200,
    is_active: true,
    mood: plan.mood || "everyday",
    sticker_count: PACK_STICKER_COUNT,
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

    normalizePlanSubjectMode(plan, subjectType);

    const outfit = brief?.visual_anchors?.[0] ?? "none";
    const t2 = Date.now();
    let captions: CaptionsOutput;
    let scenes: ScenesOutput;
    [captions, scenes] = await Promise.all([
      wrapStage("captions", () => runCaptions(plan, subjectType)),
      wrapStage("scenes", () => runScenes(plan, outfit, subjectType, undefined, brief.visual_anchors)),
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
      const critic = await wrapStage(iter === 0 ? "critic" : "critic_2", () => runCritic(spec, subjectType));
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
      const usePartialCaptions = captionIndices.length > 0 && captionIndices.length <= 10;
      const usePartialScenes = sceneIndices.length > 0 && sceneIndices.length <= 10;
      const tRework = Date.now();
      const [captionsRework, scenesRework] = await Promise.all([
        usePartialCaptions
          ? wrapStage("captions_rework", () => runCaptionsForIndices(plan, subjectType, criticContext, captionIndices)).then((partial) => {
              const nextLabels = [...(spec.labels ?? [])];
              const nextLabelsEn = [...(spec.labels_en ?? [])];
              captionIndices.forEach((idx, j) => {
                if (partial.labels[j] != null) nextLabels[idx] = partial.labels[j];
                if (partial.labels_en[j] != null) nextLabelsEn[idx] = partial.labels_en[j];
              });
              return { labels: nextLabels.slice(0, PACK_STICKER_COUNT), labels_en: nextLabelsEn.slice(0, PACK_STICKER_COUNT) };
            })
          : wrapStage("captions_rework", () => runCaptions(plan, subjectType, criticContext)),
        usePartialScenes
          ? wrapStage("scenes_rework", () => runScenesForIndices(plan, outfit, subjectType, criticContext, sceneIndices, brief.visual_anchors)).then((partial) => {
              const nextScenes = [...(spec.scene_descriptions ?? [])];
              sceneIndices.forEach((idx, j) => {
                if (partial.scene_descriptions[j] != null) nextScenes[idx] = partial.scene_descriptions[j];
              });
              return { scene_descriptions: nextScenes.slice(0, PACK_STICKER_COUNT), scene_descriptions_ru: spec.scene_descriptions_ru ? spec.scene_descriptions_ru.slice(0, PACK_STICKER_COUNT) : [] };
            })
          : wrapStage("scenes_rework", () => runScenes(plan, outfit, subjectType, criticContext, brief.visual_anchors)),
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
  subjectType: SubjectType,
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
    runCaptions(plan, subjectType, hasContext ? criticContext : undefined),
    runScenes(plan, outfit, subjectType, hasContext ? criticContext : undefined),
  ]);
  const spec = assembleSpec(plan, captions, scenes);
  const critic = await runCritic(spec, subjectType);
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
    moments: Array.isArray(spec.labels) && spec.labels.length >= PACK_STICKER_COUNT
      ? spec.labels.slice(0, PACK_STICKER_COUNT)
      : Array(PACK_STICKER_COUNT).fill("moment"),
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
