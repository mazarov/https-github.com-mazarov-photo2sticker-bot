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
      // Use 1: some models (e.g. gpt-4.1, o1) only support default temperature 1
      temperature: options?.temperature ?? 1,
    },
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
  if (!text) {
    const finishReason = choice?.finish_reason ?? "unknown";
    const refusal = (choice?.message as any)?.refusal ?? null;
    const detail = `finish_reason=${finishReason}${refusal ? ` refusal=${String(refusal).slice(0, 200)}` : ""}`;
    console.error("[pack-multiagent] OpenAI no content", { finish_reason: finishReason, refusal: refusal != null });
    throw new Error(`OpenAI returned no content (${detail})`);
  }
  return JSON.parse(text) as T;
}

// --- Concept agent: FINAL (Costume Lock, fast & strict) ---
const CONCEPT_SYSTEM = `Interpret the user request into a clear, structured sticker pack concept.

You define: the theme of the day; emotional range; human tension; whether a fixed outfit is required.

Core Rules:
- One day, one theme.
- Think in moments people remember, not activities.
- Prefer concrete situations over abstract moods.
- Do NOT describe poses, scenes, or camera framing.
- Do NOT describe appearance or facial features.
- subject_type must match the photo: single_male | single_female | couple | unknown.
- Never suggest couple dynamics for a single-subject photo.

Costume Lock (CRITICAL):
If the concept implies a profession or role that is visually recognizable by clothing (e.g. soldier, war correspondent, doctor, pilot, chef):
- You MUST define one fixed outfit for the entire pack. The outfit must stay the same across all scenes. Describe at a high level only.
- Examples: "casual military field uniform", "doctor's scrubs", "pilot uniform".
If no such role is implied, explicitly state: Outfit: none.

Human Imperfection (MANDATORY):
Include one subtle human tension: confusion, hesitation, emotional mismatch, overreaction, mild disappointment, or awkwardness. Do NOT resolve it. Do NOT smooth it out.

OUTPUT (STRICT): Output ONLY these fields. No explanations. No prose. No extra text.
- Theme (1 short line → setting)
- Emotional range (max 6 words → tone)
- Human tension (1 short line → persona/shareability_hook)
- Outfit (one phrase or "none" → first visual_anchor)

Output strict JSON with keys: subject_type, setting, persona, tone, timeline (always "one_day"), situation_types (array of 3-5 concrete situations), shareability_hook, title_hint, visual_anchors (first item = outfit or "none").`;

async function runConcept(request: string, subjectType: SubjectType): Promise<ConceptBrief> {
  const model = await getModelForAgent("concept");
  const userMessage = `User request: ${request}\n\nPhoto context (subject_type): ${subjectType}\n\nOutput the brief as JSON.`;
  return openAiChatJson<ConceptBrief>(model, CONCEPT_SYSTEM, userMessage);
}

// --- Boss agent: FINAL (Anti-Postcard enforced, ultra-short) ---
const BOSS_SYSTEM = `Turn the concept into a plan of exactly 9 distinct moments of one day.

Planning Rules:
- Each moment must be clearly different. All moments belong to the same day and environment.
- Avoid a perfect or motivational arc. Balance energy: calm, awkward, tense, overreactive.
- moments must be exactly 9; each differs by situation, not emotion. Forbidden: emotions ("happy", "angry"), states ("tired", "in love").

Anti-Postcard Rule (CRITICAL):
At least 2 of the 9 moments must be clearly uncomfortable, self-exposing, mildly embarrassing, or socially imperfect. If a moment feels safe to post publicly, it is NOT anti-postcard enough. Do NOT smooth or reframe these moments positively.

OUTPUT (STRICT): Output ONLY the final list of 9 moments. Exactly 9 lines. Each line: max 8–10 words. No explanations. No commentary. No restating rules.

Output strict JSON with keys: id (snake_case slug), pack_template_id (e.g. couple_v1), subject_mode (single or multi), name_ru, name_en, carousel_description_ru, carousel_description_en, mood, sort_order (number), segment_id, story_arc (one phrase), tone, day_structure (optional array of 9), moments (array of exactly 9 strings).`;

async function runBoss(brief: ConceptBrief): Promise<BossPlan> {
  const model = await getModelForAgent("boss");
  const userMessage = `Brief:\n${JSON.stringify(brief, null, 2)}\n\nOutput the pack plan as JSON.`;
  return openAiChatJson<BossPlan>(model, BOSS_SYSTEM, userMessage);
}

// --- Captions agent: FINAL (sendable, self-ironic) ---
const CAPTIONS_SYSTEM = `Write short captions users would actually send in a private chat. Captions are inner reactions or replies, NOT descriptions of actions.

Hard Rules:
- First-person only. EXACTLY 9 captions. 15–20 characters per caption. No emojis. No narration. No explanations. One caption per line (order: moments[0]→[8]).
- FORBIDDEN: action descriptions, stage directions, screenplay tone.

Preferred Tone (IMPORTANT): Slight self-irony beats positivity. If a caption sounds confident out loud, rewrite it as something you would admit privately. For awkward moments: confusion > confidence, honesty > optimism, resignation > enthusiasm.

Avoid: Postcard phrasing. Motivational tone. "Everything is great" energy.

OUTPUT (STRICT): Output ONLY 9 captions (RU and EN). No alternatives. No extra text.

Output strict JSON with keys: labels (array of 9 strings, RU), labels_en (array of 9 strings, EN).`;

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

// --- Scenes agent: Visual Scene Writer (Subject-Locked, Anti-Postcard) ---
const SCENES_SYSTEM = `You are a scene writer for sticker image generation. Create clean visual descriptions for the SAME person from the reference photo across 9 different moments.

SUBJECT LOCK (CRITICAL):
- {subject} ALWAYS refers to the SAME real person from the input photo.
- Every scene description MUST start with {subject}. {subject} must appear EXACTLY ONCE per scene.
- Never replace {subject} with pronouns or descriptions. Never introduce additional people.
- You do NOT describe appearance. The reference photo defines how {subject} looks. You only describe pose, posture, gesture, gaze, and tension.
- If {subject} is missing, duplicated, or replaced — the output is invalid.

Controlled Exaggeration: Emotion must be expressed through body posture, imbalance or asymmetry, gesture and hand tension, pauses and frozen moments. Do NOT exaggerate facial features. Do NOT describe appearance, age, or traits.

Scene Variety Requirement (MANDATORY): Across the 9 scenes you MUST include:
- 1 scene with visible hesitation or doubt
- 1 scene with mild overreaction
- 1 scene built around awkward pause or frozen stillness
- 1 scene that feels slightly self-exposing or embarrassing
These scenes must remain visually imperfect. Do NOT beautify or neutralize them.

Anti-Postcard Execution: For awkward or imperfect scenes: allow imbalance, asymmetry, being caught mid-reaction, uncomfortable but relatable body language. Avoid confident, polished, or posed stances in these scenes.

Existing Rules (REQUIRED): Chest-up framing only. One day, one environment. Identity lock (no appearance description). Prop-safe: max 1 prop per scene, fully visible, centered. Background: plain, neutral wall, single-tone, soft gradient only — no interiors, furniture, streets, bokeh. 2–3 scenes with gaze into the camera. Clean cut-out friendly composition. No captions, quotes, speech, UI, signs in the description.

Scene Format: Each scene = exactly ONE sentence. Max 18–22 words. No subordinate clauses. Start with {subject}, chest-up framing, one clear pose or body position, one contained action or pause. Example: "{subject} chest-up, torso slightly leaned back, hands frozen mid-gesture, subtle tension in shoulders".

Final Validation: (1) Sentence starts with {subject}? (2) {subject} exactly once? (3) Same person as reference? (4) Emotion by body, not appearance? (5) Clean cut-out friendly? If any "no" — rewrite.

Goal: 9 visually distinct, emotionally varied scenes that move the SAME person through awkward, human moments people recognize and want to share in private chats.

Output strict JSON with one key: scene_descriptions (array of 9 strings). Each string = one sentence, 18–22 words max, no subordinate clauses. Every element must start with {subject}. No extra text outside the JSON.`;

async function runScenes(plan: BossPlan, criticFeedback?: CriticFeedbackContext): Promise<ScenesOutput> {
  const model = await getModelForAgent("scenes");
  const hasCriticFeedback = criticFeedback?.suggestions?.length || criticFeedback?.reasons?.length || !!criticFeedback?.previousSpec;
  let userMessage = `Plan:\n${JSON.stringify(plan, null, 2)}\n\nOutput scene_descriptions as JSON.`;
  if (hasCriticFeedback && criticFeedback) {
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
  const raw = await openAiChatJson<{ scene_descriptions: string[] }>(model, SCENES_SYSTEM, userMessage, { maxTokens: 8192 });
  const sceneDescriptions = Array.isArray(raw.scene_descriptions) ? raw.scene_descriptions.slice(0, 9) : [];
  return { scene_descriptions: sceneDescriptions, scene_descriptions_ru: [] };
}

// --- Critic agent: FINAL (fast, strict, taste-aware) ---
const CRITIC_SYSTEM = `Act as a strict quality gate for format, rules, and usability.

You MUST check: Exactly 9 captions; caption length (15–20 chars); exactly 9 scenes; scene uniqueness; rule compliance; consistency across the pack.

Reject (pass=false) when: Captions are descriptive/narrative, exceed 15–20 characters, or violate first-person/no-emojis. Scenes break subject lock ({subject}), have complex backgrounds, or break one-day consistency.

Taste Check (SOFT, NON-BLOCKING): If all moments or captions feel emotionally safe or postcard-like, add a suggestion encouraging more awkward, self-ironic, or risky moments. Do NOT fail the pack for this alone.

Feedback Rules: Reference exact indices (e.g. "caption 4", "scene 7"). Be concrete. No vague creative advice. Write reasons and suggestions in Russian (на русском языке).

OUTPUT LIMITS (STRICT): Reasons — max 3 bullet points, max 20 words per bullet. Suggestions — max 3 bullet points, max 20 words per bullet. No explanations. No prose. No restating rules.

Output strict JSON with keys: pass (boolean), reasons (array of max 3 strings, Russian, each max 20 words), suggestions (array of max 3 strings, Russian, each max 20 words).`;

async function runCritic(spec: PackSpecRow): Promise<CriticOutput> {
  const model = await getModelForAgent("critic");
  const userMessage = `Full pack spec:\n${JSON.stringify(spec, null, 2)}\n\nOutput pass, reasons, and suggestions as JSON.`;
  return openAiChatJson<CriticOutput>(model, CRITIC_SYSTEM, userMessage, { temperature: 1, maxTokens: 8192 });
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
  const userMessage =
    `The critic rejected specific captions. Regenerate ONLY the captions at 0-based indices: ${JSON.stringify(indices)}.\n\n` +
    `Plan:\n${JSON.stringify(plan, null, 2)}\n\n` +
    (prev
      ? `Previous labels (RU): ${JSON.stringify(prev.labels)}\nPrevious labels_en (EN): ${JSON.stringify(prev.labels_en)}\n\n`
      : "") +
    `Critic reasons: ${(criticContext.reasons ?? []).join(" ")}\nCritic suggestions: ${criticContext.suggestions.join(" ")}\n\n` +
    `Output JSON with keys: labels (array of ${indices.length} strings, RU, in order of indices), labels_en (array of ${indices.length} strings, EN). Each caption 15–20 characters.`;
  const raw = await openAiChatJson<{ labels: string[]; labels_en: string[] }>(model, CAPTIONS_SYSTEM, userMessage);
  const labels = Array.isArray(raw.labels) ? raw.labels.slice(0, indices.length) : [];
  const labels_en = Array.isArray(raw.labels_en) ? raw.labels_en.slice(0, indices.length) : [];
  return { labels, labels_en };
}

/** Regenerate only scene_descriptions at given 0-based indices. Returns array in same order as indices. */
async function runScenesForIndices(
  plan: BossPlan,
  criticContext: CriticFeedbackContext,
  indices: number[]
): Promise<{ scene_descriptions: string[] }> {
  if (indices.length === 0) return { scene_descriptions: [] };
  const model = await getModelForAgent("scenes");
  const prev = criticContext.previousSpec;
  const userMessage =
    `The critic rejected specific scenes. Regenerate ONLY the scene_descriptions at 0-based indices: ${JSON.stringify(indices)}.\n\n` +
    `Plan:\n${JSON.stringify(plan, null, 2)}\n\n` +
    (prev?.scene_descriptions?.length
      ? `Previous scene_descriptions: ${JSON.stringify(prev.scene_descriptions)}\n\n`
      : "") +
    `Critic reasons: ${(criticContext.reasons ?? []).join(" ")}\nCritic suggestions: ${criticContext.suggestions.join(" ")}\n\n` +
    `Output JSON with one key: scene_descriptions (array of ${indices.length} strings, in order of indices). Each sentence 18–22 words, start with {subject}. No subordinate clauses.`;
  const raw = await openAiChatJson<{ scene_descriptions: string[] }>(model, SCENES_SYSTEM, userMessage, { maxTokens: 4096 });
  const scene_descriptions = Array.isArray(raw.scene_descriptions) ? raw.scene_descriptions.slice(0, indices.length) : [];
  return { scene_descriptions };
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
    const brief = await wrapStage("concept", () => runConcept(request, subjectType));
    console.log(stageLabel("concept"), "done in", Date.now() - t0, "ms");
    await onProgress?.("concept");
    const t1 = Date.now();
    const plan = await wrapStage("boss", () => runBoss(brief));
    console.log(stageLabel("boss"), "done in", Date.now() - t1, "ms");
    await onProgress?.("boss");

    const t2 = Date.now();
    let captions: CaptionsOutput;
    let scenes: ScenesOutput;
    [captions, scenes] = await Promise.all([
      wrapStage("captions", () => runCaptions(plan)),
      wrapStage("scenes", () => runScenes(plan)),
    ]);
    console.log("[pack-multiagent] captions + scenes (parallel) done in", Date.now() - t2, "ms");
    await onProgress?.("captions");
    await onProgress?.("scenes");
    let spec = assembleSpec(plan, captions, scenes);

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
          ? wrapStage("scenes_rework", () => runScenesForIndices(plan, criticContext, sceneIndices)).then((partial) => {
              const nextScenes = [...(spec.scene_descriptions ?? [])];
              sceneIndices.forEach((idx, j) => {
                if (partial.scene_descriptions[j] != null) nextScenes[idx] = partial.scene_descriptions[j];
              });
              return { scene_descriptions: nextScenes.slice(0, 9), scene_descriptions_ru: [] };
            })
          : wrapStage("scenes_rework", () => runScenes(plan, criticContext)),
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
  const [captions, scenes] = await Promise.all([
    runCaptions(plan, hasContext ? criticContext : undefined),
    runScenes(plan, hasContext ? criticContext : undefined),
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
