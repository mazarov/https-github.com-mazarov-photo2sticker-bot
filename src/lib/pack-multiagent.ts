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
  concept: "gpt-4.1",
  boss: "gpt-4.1",
  captions: "gpt-4.1",
  scenes: "gpt-4.1-vision",
  critic: "gpt-3.5-turbo",
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

// --- Concept agent (v2 reinforced) ---
const CONCEPT_SYSTEM = `You are a pack concept interpreter. Turn an abstract user request and photo context into a clear, visually readable brief that requires no guessing downstream.

Output strict JSON with keys: subject_type, setting, persona, tone, timeline, situation_types (array of 3-5 strings), shareability_hook (one phrase: who will share and why), title_hint (suggested pack title), visual_anchors (array of 2-4 strings).

Rules:
- subject_type must strictly match the photo: single_male | single_female | couple | unknown.
- timeline is always "one_day".
- situation_types must be concrete events of a day, not emotions. OK: "first coffee", "waiting for a reply". Forbidden: "happy", "tired", "in love".
- Never suggest couple dynamics for a single-subject photo.
- visual_anchors (2–4 items) are mandatory. They define how the theme is visually recognizable: clothing/vibe, light/time of day, simple readable visual cues.
- If a theme cannot be visually recognized in a sticker, simplify it.
- Do not invent complex locations or props — stickers require minimal visuals.`;

async function runConcept(request: string, subjectType: SubjectType): Promise<ConceptBrief> {
  const model = await getModelForAgent("concept");
  const userMessage = `User request: ${request}\n\nPhoto context (subject_type): ${subjectType}\n\nOutput the brief as JSON.`;
  return openAiChatJson<ConceptBrief>(model, CONCEPT_SYSTEM, userMessage);
}

// --- Boss agent (v2 reinforced) ---
const BOSS_SYSTEM = `You are a sticker pack planner. Convert the brief into a clear plan of 9 distinct moments of one day.

Output strict JSON with keys: id (snake_case slug, e.g. everyday_office_chaos_v1), pack_template_id (e.g. couple_v1 for single/couple), subject_mode (single or multi), name_ru, name_en, carousel_description_ru, carousel_description_en, mood (everyday|reactions|affection|sarcasm|...), sort_order (number, e.g. 200), segment_id (e.g. home, affection_support), story_arc (one phrase), tone, day_structure (optional array of 9: morning|midday|evening), moments (array of exactly 9 strings).

Rules:
- moments must be exactly 9 events of a single day. Each moment must differ by action or situation, not be an emotion.
- Forbidden in moments: emotions ("happy", "angry"), states ("tired", "in love").
- Moments must naturally suggest different captions and poses. If moments feel similar, replace them — do not paraphrase.
- id must be a unique snake_case slug.`;

async function runBoss(brief: ConceptBrief): Promise<BossPlan> {
  const model = await getModelForAgent("boss");
  const userMessage = `Brief:\n${JSON.stringify(brief, null, 2)}\n\nOutput the pack plan as JSON.`;
  return openAiChatJson<BossPlan>(model, BOSS_SYSTEM, userMessage);
}

// --- Captions agent (v2 reinforced) ---
const CAPTIONS_SYSTEM = `You are a caption writer for sticker packs. Write captions that a user would actually send in chat instead of typing.

Output strict JSON with keys: labels (array of 9 strings, RU), labels_en (array of 9 strings, EN).

ABSOLUTE RULES:
- A caption is the sender's inner message.
- FORBIDDEN: action descriptions, narration, reports, stage directions, emojis, hashtags, decorative punctuation. If it reads like a screenplay line or UI log — it is wrong.

FORMAT & LENGTH:
- One short line only. Max 15–20 characters (RU and EN). Shorter is always better.
- Strict order: moments[0] → moments[8].

REQUIRED:
- At least 2 hook captions — lines people want to forward.
- Always first-person. Match pack tone, but sendability > style.

SELF-CHECK (MANDATORY): Before outputting each caption, ask: (1) Would I actually send this in chat? (2) Is this a thought, not a description? (3) Does it fit on a sticker without shrinking? If any answer is "no" — rewrite.`;

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

// --- Scenes agent (v4 Subject-Locked & Prop-Safe) ---
const SCENES_SYSTEM = `You are a scene writer for sticker image generation. Every scene is FOR THE CHARACTER FROM THE REFERENCE PHOTO. Your output will be combined with that photo so the generator draws the same person in each scene. Describe only the visual scene (pose, action, background) so identity from the photo is preserved.

CRITICAL — USE {subject} IN EVERY SCENE: The placeholder {subject} means "the character from the reference photo". You MUST start every scene description with the literal token {subject} so the system can bind it to the photo. Example: "{subject} chest-up, smiling toward camera, hands near chest — morning greeting". Never replace {subject} with a name, "woman", "man", or any description of appearance. The reference photo defines who the person is; {subject} is just the pointer to them.

IDENTITY LOCK: The same real person from the input photo must appear in all 9 scenes. NEVER describe facial features, age, ethnicity, hair color, eye color, or body type. Never introduce traits that could override the reference. The reference photo is the source of truth for appearance.

Output strict JSON with one key: scene_descriptions (array of exactly 9 strings). Each string = one sentence. No extra text outside the JSON.

EXAMPLE OUTPUT (how to return the data):
\`\`\`json
{
  "scene_descriptions": [
    "{subject} chest-up, slight smile, gaze at camera, hands relaxed — friendly hello",
    "{subject} chest-up, thoughtful expression, looking slightly left, hand near chin — thinking",
    "{subject} chest-up, laughing, eyes to camera, arms relaxed — joyful moment",
    "{subject} chest-up, calm neutral face, direct gaze, hands at sides — steady presence",
    "{subject} chest-up, gentle smile, looking right, one hand raised in wave — goodbye",
    "{subject} chest-up, surprised expression, eyes wide, hands near chest — pleasant surprise",
    "{subject} chest-up, confident smile, gaze at camera, arms crossed loosely — self-assured",
    "{subject} chest-up, soft expression, eyes closed, peaceful pose — relaxed moment",
    "{subject} chest-up, warm smile, direct gaze, thumbs up near chest — approval"
  ]
}
\`\`\`
Every element must start with {subject}. No other keys. Valid JSON only.

ABSOLUTE RULES

1. Visual only. Describe only: pose, expression, gaze, body position, simple contained action, background. Never: captions, quotes, speech, written words, UI, screens, signs.

2. Framing: Chest-up only. {subject} fully inside the frame. No object may touch or cross the frame edges. Subject centered with clear margins on all sides.

3. Background (STRICT WHITELIST). Allowed ONLY: plain background, neutral wall, single-tone background, soft gradient. FORBIDDEN: interiors, furniture, streets, bokeh/blur, lighting effects, complex shadows, readable or recognizable background objects. Backgrounds are removed later — keep them simple.

4. Gaze & expression: 2–3 scenes must include clear gaze into the camera. Max 1 scene with closed eyes. Expression intensity ~70%. Avoid static passport poses. Every scene must differ in pose or body action.

5. Consistency: One day, one environment. One outfit across all scenes if theme requires clothing or role. No hairstyle, clothing, or body changes between scenes. Visual anchors from the pack brief must appear in every scene.

6. Prop-safe. If a prop is used: max one prop per scene; solid, simple, high-contrast; fully visible, well inside the frame, centered near the subject. Preferred: held close to chest, on forearms, against body. FORBIDDEN placement: on tables, near frame edges, partially cropped, behind subject, overlapping frame. FORBIDDEN prop types: smoke/steam/vapor, crumbs/particles, splashes/liquids in motion, thin cables, transparent/reflective objects, multiple small scattered items. These break segmentation.

FORMAT (each scene): MUST start with the exact token {subject}, then chest-up framing, pose/body position, one simple contained action, end with a short moment hint after a dash. Example: "{subject} chest-up, confident upright posture, hands relaxed near chest — calm focus". Never write a scene without {subject} at the start. Keep actions compact. Each scene is for the character from the photo only.

FINAL SELF-CHECK: Before each scene, verify (1) the scene starts with {subject}, (2) it is for the same person as the reference photo with no physical traits that override the photo, (3) the scene can be cleanly cut out. If any is "no", rewrite. The reference photo defines the person. Your job is only to move them.`;

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

// --- Critic agent (v2 reinforced) ---
const CRITIC_SYSTEM = `You are the quality gate for sticker packs. Approve only truly sendable and coherent packs.

Output strict JSON with keys: pass (boolean), reasons (array of strings, in Russian), suggestions (array of 1-3 strings, in Russian).

Evaluate captions and scenes separately.

Reject (pass=false) when:
- Captions: descriptive or narrative; exceed 15–20 characters; don't read like a real message; lack at least one strong hook.
- Scenes: complex or noisy backgrounds; lack 2–3 gaze-at-camera scenes; break one-day or environment consistency; fail to visually communicate the theme.

REASONS & SUGGESTIONS (CRITICAL): reasons must be specific, index-based (e.g. "caption 4", "scene 7"), one problem per reason. suggestions must be 1–3 items, concrete and directive, fixable in one rewrite pass. Good example: "подпись 3 описательная — заменить на внутреннюю мысль". Bad: "подписи слабые". Write in Russian (на русском языке). Your feedback must allow Captions and Scenes to fix everything in a single iteration.`;

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
