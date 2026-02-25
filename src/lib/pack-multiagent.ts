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
- Captions = what the SENDER would write in a chat as their own message. Inner thought / reaction, NOT a description of what the character is doing.
- FORBIDDEN: narration, status updates, stage directions (e.g. "Recording...", "Докладываю...", "Reactions received.", "Записываю на нейтральном фоне"). If it reads like a script or report, it is wrong.
- REQUIRED: short, chat-ready lines the user would send as a sticker (e.g. "Love that for me.", "Of course.", "С 23-м. Держись."). At least 1–2 lines must be punchy, quotable "hook" lines people would forward.
- LENGTH: each caption must be one short line. Max 15–20 characters for both RU and EN. Very brief — a few words only. Long phrases are forbidden; they don't fit on a sticker.
- Order strictly by moments[0]..moments[8]. Tone from the plan, but always first-person sendable.`;

export interface CriticFeedbackContext {
  suggestions: string[];
  reasons?: string[];
  previousSpec?: PackSpecRow;
}

async function runCaptions(plan: BossPlan, criticFeedback?: CriticFeedbackContext): Promise<CaptionsOutput> {
  const model = await getModelForAgent("captions");
  let userMessage = `Plan:\n${JSON.stringify(plan, null, 2)}\n\nOutput labels and labels_en as JSON.`;
  if (criticFeedback?.suggestions?.length || criticFeedback?.reasons?.length || criticFeedback?.previousSpec) {
    const parts: string[] = [];
    parts.push("CRITICAL: Write only what the sender would send in a chat as a sticker. No narration, no description of actions (e.g. no 'докладываю', 'записываю', 'reactions received').");
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
    userMessage += "\n\n" + parts.join("\n\n");
  }
  return openAiChatJson<CaptionsOutput>(model, CAPTIONS_SYSTEM, userMessage);
}

// --- Scenes agent ---
const SCENES_SYSTEM = `You are a scene writer for sticker pack image generation. Given a pack plan and labels, output 9 scene_descriptions.

Output strict JSON with key: scene_descriptions (array of 9 strings).

CRITICAL: scene_descriptions are VISUAL ONLY. Do NOT include any caption text, label text, or quotes in the scene description. Labels (captions) are stored separately and added to the sticker later — they must never appear inside scene_descriptions. Describe only: pose, expression, gaze, background, action. No text, no speech, no written words in the scene.

Each scene: one sentence with placeholder {subject}, chest-up, mid-motion. Format: "{subject} [framing], [body position], [small action] — [moment in one phrase]".
Rules:
- Background must be SIMPLE: neutral wall, plain background, soft blur, or single-tone. No busy interiors, detailed furniture, or cluttered environments — the background is removed for stickers, so keep it minimal (e.g. "against neutral wall", "plain background", "soft bokeh").
- 2-3 scenes with gaze at camera; at most one with closed eyes.
- One day, one environment; when theme requires costume (e.g. military, profession) or setting (barracks, office), specify in EVERY scene.
- Expression intensity ~70%; no static photo pose; variety across 3×3 grid.`;

async function runScenes(
  plan: BossPlan,
  captions: CaptionsOutput,
  criticFeedback?: CriticFeedbackContext
): Promise<ScenesOutput> {
  const model = await getModelForAgent("scenes");
  let userMessage = `Plan:\n${JSON.stringify(plan, null, 2)}\n\nLabels (RU): ${JSON.stringify(captions.labels)}\nLabels (EN): ${JSON.stringify(captions.labels_en)}\n\nOutput scene_descriptions as JSON.`;
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
    userMessage += "\n\n" + parts.join("\n\n");
  }
  return openAiChatJson<ScenesOutput>(model, SCENES_SYSTEM, userMessage);
}

// --- Critic agent ---
const CRITIC_SYSTEM = `You are the quality gate for sticker packs. You must reject any pack that is not truly sendable and coherent.

Evaluate the FULL pack spec: both labels (captions) AND scene_descriptions. You must check captions and scenes separately.

Output strict JSON with keys: pass (boolean), reasons (array of strings: what's wrong or what works), suggestions (array of 1-3 concrete improvement strings for the team). Write reasons and suggestions in Russian (на русском языке). Example: "подпись 4 описательная — заменить на внутреннюю реплику", "в сцене 7 нет взгляда в камеру", "в сцене 3 сложный фон — сделать нейтральный".

Reject (pass=false) when:
- Captions: generic or descriptive (not inner thoughts); too long (max 15–20 characters per label, RU and EN); typos or nonsense; weak virality (no clear share/hook).
- Scenes: complex or busy backgrounds (must be simple/neutral — background is cut out for stickers); broken one-day continuity or inconsistent setting; missing costume/environment when theme requires it (e.g. military, office); missing gaze-at-camera where needed (2–3 scenes).

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

/** Progress stage keys for admin pack loading (passed to onProgress). */
export type PackPipelineStage =
  | "concept"
  | "boss"
  | "captions"
  | "scenes"
  | "critic"
  | "captions_rework"
  | "scenes_rework"
  | "critic_2";

/**
 * Run the full pipeline: Concept → Boss → Captions → Scenes → Assembly → Critic.
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

  try {
    const brief = await runConcept(request, subjectType);
    await onProgress?.("concept");
    const plan = await runBoss(brief);
    await onProgress?.("boss");

    let captions: CaptionsOutput = await runCaptions(plan);
    await onProgress?.("captions");
    let scenes: ScenesOutput = await runScenes(plan, captions);
    await onProgress?.("scenes");
    let spec = assembleSpec(plan, captions, scenes);

    for (let iter = 0; iter < maxIterations; iter++) {
      await onProgress?.(iter === 0 ? "critic" : "critic_2");
      // #region agent log
      const maxLenRu = Math.max(0, ...(spec.labels || []).map((l) => String(l).length));
      const maxLenEn = Math.max(0, ...(spec.labels_en || []).map((l) => String(l).length));
      fetch('http://127.0.0.1:7242/ingest/cee87e10-8efc-4a8c-a815-18fbbe1210d8',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5edd11'},body:JSON.stringify({sessionId:'5edd11',location:'pack-multiagent.ts:beforeCritic',message:'spec before Critic',data:{iter:iter+1,maxLabelLenRu:maxLenRu,maxLabelLenEn:maxLenEn,sampleRu:(spec.labels||[])[0],sampleEn:(spec.labels_en||[])[0]},timestamp:Date.now(),hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      const critic = await runCritic(spec);
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
      captions = await runCaptions(plan, criticContext);
      await onProgress?.("captions_rework");
      scenes = await runScenes(plan, captions, criticContext);
      await onProgress?.("scenes_rework");
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
  const captions = await runCaptions(plan, hasContext ? criticContext : undefined);
  const scenes = await runScenes(plan, captions, hasContext ? criticContext : undefined);
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
