/**
 * Multi-agent pack generation pipeline (OpenAI).
 * Concept → Boss → Captions → Scenes → Assembly → Critic.
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

// --- Captions output ---
export interface CaptionsOutput {
  labels: string[];
  labels_en: string[];
}

// --- Scenes output ---
export interface ScenesOutput {
  scene_descriptions: string[];
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
  scene_descriptions: string[];
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

// --- Модели агентов: ключи app_config (таблица app_config) ---
// В БД в app_config добавлять строки key = один из ключей ниже, value = модель (например gpt-4o-mini).
// Так сразу видно, какая строка за какого агента отвечает.
export const PACK_AGENT_APP_CONFIG_KEYS = {
  /** Concept — запрос + фото → бриф (setting, persona, tone, situation_types) */
  concept: "pack_openai_model_concept",
  /** Boss — бриф → план пака (id, name_ru/en, moments[9], day_structure) */
  boss: "pack_openai_model_boss",
  /** Captions — план → 9 подписей RU + EN */
  captions: "pack_openai_model_captions",
  /** Scenes — план + подписи → 9 scene_descriptions с {subject} */
  scenes: "pack_openai_model_scenes",
  /** Critic — полный спек → pass/fail + reasons + suggestions (строгий gate) */
  critic: "pack_openai_model_critic",
} as const;

const PACK_AGENT_DEFAULT_MODELS: Record<keyof typeof PACK_AGENT_APP_CONFIG_KEYS, string> = {
  concept: "gpt-5.2",
  boss: "gpt-5.2",
  captions: "gpt-5.2",
  scenes: "gpt-5.2",
  critic: "gpt-5.2",
};

const OPENAI_TIMEOUT_MS = 90_000;

async function getModelForAgent(agent: keyof typeof PACK_AGENT_APP_CONFIG_KEYS): Promise<string> {
  const key = PACK_AGENT_APP_CONFIG_KEYS[agent];
  const defaultModel = PACK_AGENT_DEFAULT_MODELS[agent];
  const value = await getAppConfig(key, defaultModel);
  return value?.trim() || defaultModel;
}

async function openAiChatJson<T>(
  model: string,
  systemPrompt: string,
  userMessage: string,
  options?: { temperature?: number; maxTokens?: number }
): Promise<T> {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not set; pack pipeline requires OpenAI.");
  }

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      timeout: OPENAI_TIMEOUT_MS,
    }
  );

  const text = response.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI returned no content");
  return JSON.parse(text) as T;
}

// --- Concept agent ---
const CONCEPT_SYSTEM = `You are a pack concept interpreter. Given a user's abstract request and photo context (who is in the photo), output a structured brief for a sticker pack planner.

Output strict JSON with keys: subject_type, setting, persona, tone, timeline, situation_types (array of 3-5 strings), shareability_hook (one phrase: who will share and why), title_hint (suggested pack title).

Rules:
- subject_type must match photo context: single_male, single_female, couple, or unknown.
- timeline is always "one_day".
- situation_types = events/situations (e.g. morning chaos, first coffee, call, lunch), not emotions.
- Persona and setting must fit the character(s) in the photo. Do not suggest couple scenes if photo has one person.`;

async function runConcept(request: string, subjectType: SubjectType): Promise<ConceptBrief> {
  const model = await getModelForAgent("concept");
  const userMessage = `User request: ${request}\n\nPhoto context (subject_type): ${subjectType}\n\nOutput the brief as JSON.`;
  return openAiChatJson<ConceptBrief>(model, CONCEPT_SYSTEM, userMessage);
}

// --- Boss agent ---
const BOSS_SYSTEM = `You are a sticker pack planner. Given a brief, output a pack plan.

Output strict JSON with keys: id (snake_case slug, e.g. everyday_office_chaos_v1), pack_template_id (e.g. couple_v1 for single/couple), subject_mode (single or multi), name_ru, name_en, carousel_description_ru, carousel_description_en, mood (everyday|reactions|affection|sarcasm|...), sort_order (number, e.g. 200), segment_id (e.g. home, affection_support), story_arc (one phrase), tone, day_structure (optional array of 9: morning|midday|evening), moments (array of exactly 9 strings: moment names, events not emotions, e.g. "day starting, stretch", "first coffee pause").

Rules:
- 9 moments = 9 events of one day; variety; no 9× same emotion.
- id must be unique slug (snake_case).`;

async function runBoss(brief: ConceptBrief): Promise<BossPlan> {
  const model = await getModelForAgent("boss");
  const userMessage = `Brief:\n${JSON.stringify(brief, null, 2)}\n\nOutput the pack plan as JSON.`;
  return openAiChatJson<BossPlan>(model, BOSS_SYSTEM, userMessage);
}

// --- Captions agent ---
const CAPTIONS_SYSTEM = `You are a caption writer for sticker packs. Given a pack plan, output 9 labels (RU) and 9 labels_en (EN).

Output strict JSON with keys: labels (array of 9 strings, RU), labels_en (array of 9 strings, EN).

Rules:
- Captions = inner thoughts / internal comment, not emotion labels. Not "Happy" but "Love that for me.", "Of course.", "We move."
- Short, natural in chat, in the plan's tone. Order strictly by moments[0]..moments[8].`;

async function runCaptions(plan: BossPlan, criticSuggestions?: string[]): Promise<CaptionsOutput> {
  const model = await getModelForAgent("captions");
  let userMessage = `Plan:\n${JSON.stringify(plan, null, 2)}\n\nOutput labels and labels_en as JSON.`;
  if (criticSuggestions?.length) {
    userMessage += `\n\nCritic feedback (apply these fixes):\n${criticSuggestions.join("\n")}`;
  }
  return openAiChatJson<CaptionsOutput>(model, CAPTIONS_SYSTEM, userMessage);
}

// --- Scenes agent ---
const SCENES_SYSTEM = `You are a scene writer for sticker pack image generation. Given a pack plan and labels, output 9 scene_descriptions.

Output strict JSON with key: scene_descriptions (array of 9 strings).

Each scene: one sentence with placeholder {subject}, chest-up, mid-motion. Format: "{subject} [framing], [body position], [small action] — [moment in one phrase]".
Rules:
- 2-3 scenes with gaze at camera; at most one with closed eyes.
- One day, one environment; when theme requires costume (e.g. military, profession) or setting (barracks, office), specify in EVERY scene.
- Expression intensity ~70%; no static photo pose; variety across 3×3 grid.`;

async function runScenes(
  plan: BossPlan,
  captions: CaptionsOutput,
  criticSuggestions?: string[]
): Promise<ScenesOutput> {
  const model = await getModelForAgent("scenes");
  let userMessage = `Plan:\n${JSON.stringify(plan, null, 2)}\n\nLabels (RU): ${JSON.stringify(captions.labels)}\nLabels (EN): ${JSON.stringify(captions.labels_en)}\n\nOutput scene_descriptions as JSON.`;
  if (criticSuggestions?.length) {
    userMessage += `\n\nCritic feedback (apply these fixes):\n${criticSuggestions.join("\n")}`;
  }
  return openAiChatJson<ScenesOutput>(model, SCENES_SYSTEM, userMessage);
}

// --- Critic agent ---
const CRITIC_SYSTEM = `You are the quality gate for sticker packs. You must reject any pack that is not truly sendable and coherent.

Evaluate the full pack spec. Output strict JSON with keys: pass (boolean), reasons (array of strings: what's wrong or what works), suggestions (array of 1-3 concrete improvement strings for the team, e.g. "caption 4 is descriptive, replace with inner thought", "scene 7 missing gaze at camera").

Reject (pass=false) when:
- Generic or descriptive captions (not inner thoughts).
- Broken one-day continuity or inconsistent setting.
- Missing costume/environment in scenes when theme requires it (e.g. military, office).
- Typos or nonsense in labels.
- Weak virality: no clear share moment or hook.

Be strict. Pass only when the pack is truly sendable and coherent. Do not soften the verdict.`;

async function runCritic(spec: PackSpecRow): Promise<CriticOutput> {
  const model = await getModelForAgent("critic");
  const userMessage = `Full pack spec:\n${JSON.stringify(spec, null, 2)}\n\nOutput pass, reasons, and suggestions as JSON.`;
  return openAiChatJson<CriticOutput>(model, CRITIC_SYSTEM, userMessage, { temperature: 0.3 });
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

/**
 * Run the full pipeline: Concept → Boss → Captions → Scenes → Assembly → Critic.
 * On Critic fail, re-run Captions and Scenes with suggestions (max iterations).
 * Does NOT insert into DB; caller must ensure unique id and insert.
 */
export async function runPackGenerationPipeline(
  request: string,
  subjectType: SubjectType,
  options?: { maxCriticIterations?: number }
): Promise<PackGenerationResult> {
  const maxIterations = options?.maxCriticIterations ?? 2;

  try {
    const brief = await runConcept(request, subjectType);
    const plan = await runBoss(brief);

    let captions: CaptionsOutput = await runCaptions(plan);
    let scenes: ScenesOutput = await runScenes(plan, captions);
    let spec = assembleSpec(plan, captions, scenes);

    for (let iter = 0; iter < maxIterations; iter++) {
      const critic = await runCritic(spec);
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
      captions = await runCaptions(plan, critic.suggestions);
      scenes = await runScenes(plan, captions, critic.suggestions);
      spec = assembleSpec(plan, captions, scenes);
    }

    return { ok: false, error: "Critic did not pass after max iterations" };
  } catch (err: any) {
    const message = err?.response?.data?.error?.message || err?.message || String(err);
    console.error("[pack-multiagent] pipeline error:", message);
    return { ok: false, error: message };
  }
}

/**
 * One rework iteration: Captions(plan, suggestions) → Scenes → Assembly → Critic.
 * Used when admin taps "Переделать" to iterate without re-running Concept/Boss.
 */
export async function reworkOneIteration(
  plan: BossPlan,
  suggestions: string[]
): Promise<{ spec: PackSpecRow; critic: CriticOutput }> {
  const captions = await runCaptions(plan, suggestions.length ? suggestions : undefined);
  const scenes = await runScenes(plan, captions, suggestions.length ? suggestions : undefined);
  const spec = assembleSpec(plan, captions, scenes);
  const critic = await runCritic(spec);
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
