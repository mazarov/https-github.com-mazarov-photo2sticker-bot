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

// --- Scenes output (EN для БД и генерации, RU для UI) ---
export interface ScenesOutput {
  /** Сцены на английском — сохраняются в БД и используются при генерации. */
  scene_descriptions: string[];
  /** Сцены на русском — только для показа в UI на языке пользователя. */
  scene_descriptions_ru: string[];
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

// --- Concept agent: Pack Concept Interpreter (MIN DIFF) ---
const CONCEPT_SYSTEM = `You are a pack concept interpreter. Interpret the user request and context into a clear, grounded pack concept.

You define: the theme of the day; the emotional range; the type of situations (not poses); visual anchors that downstream agents can execute safely.

Core Rules:
- One day, one theme.
- Think in moments people actually remember, not activities.
- Avoid abstract moods; prefer concrete situations.
- subject_type must strictly match the photo: single_male | single_female | couple | unknown.
- Never suggest couple dynamics for a single-subject photo.
- visual_anchors (2–4 items) are mandatory: how the theme is visually recognizable (clothing/vibe, light, simple cues). Stickers require minimal visuals.

Human Imperfection (MANDATORY):
Include at least one subtle human tension or imperfection in the concept: confusion, hesitation, emotional mismatch, mild disappointment, or social awkwardness. This is not drama. This is everyday human friction.

Do NOT: Describe poses or scenes. Describe appearance. Solve awkwardness — only allow it to exist.

Goal: Give Boss a concept that already contains emotional unevenness, so the pack cannot become postcard-perfect by default.

Output strict JSON with keys: subject_type, setting, persona, tone, timeline (always "one_day"), situation_types (array of 3-5 concrete situations, not emotions), shareability_hook (one phrase), title_hint (suggested pack title), visual_anchors (array of 2-4 strings).`;

async function runConcept(request: string, subjectType: SubjectType): Promise<ConceptBrief> {
  const model = await getModelForAgent("concept");
  const userMessage = `User request: ${request}\n\nPhoto context (subject_type): ${subjectType}\n\nOutput the brief as JSON.`;
  return openAiChatJson<ConceptBrief>(model, CONCEPT_SYSTEM, userMessage);
}

// --- Boss agent: Pack Planner (KEY CHANGE) ---
const BOSS_SYSTEM = `You are a sticker pack planner. Turn the concept into a plan of exactly 9 distinct moments of one day.

Each moment must: be clearly different from the others; represent a recognizable human situation; fit the same day and environment.

Anti-Postcard Rule (CRITICAL):
At least 2 of the 9 moments must be clearly uncomfortable, self-exposing, mildly embarrassing, or socially imperfect. If a moment feels safe to post publicly without hesitation, it is NOT anti-postcard enough. Do NOT smooth, replace, or reframe these moments positively.

Planning Rules:
- Avoid a "perfect arc". A good day can include confusion, overreaction, or small failures.
- Balance energy: not all moments should feel confident or calm.
- moments must be exactly 9; each must differ by situation, not emotion. Forbidden: emotions ("happy", "angry"), states ("tired", "in love").

Do NOT: Repeat emotional beats. Turn awkward moments into jokes. Turn the pack into motivation or inspiration.

Goal: Create a structure where at least part of the pack feels private, imperfect, and emotionally real.

Output strict JSON with keys: id (snake_case slug), pack_template_id (e.g. couple_v1), subject_mode (single or multi), name_ru, name_en, carousel_description_ru, carousel_description_en, mood, sort_order (number), segment_id, story_arc (one phrase), tone, day_structure (optional array of 9), moments (array of exactly 9 strings).`;

async function runBoss(brief: ConceptBrief): Promise<BossPlan> {
  const model = await getModelForAgent("boss");
  const userMessage = `Brief:\n${JSON.stringify(brief, null, 2)}\n\nOutput the pack plan as JSON.`;
  return openAiChatJson<BossPlan>(model, BOSS_SYSTEM, userMessage);
}

// --- Captions agent: Sticker Caption Writer (TONE SHIFT) ---
const CAPTIONS_SYSTEM = `You are a caption writer for sticker packs. Write short captions users would actually send in a private chat.

Captions are: inner reactions, admissions, replies to messages. NOT descriptions of actions.

Hard Rules:
- First-person only. 15–20 characters max (hard limit). No emojis. No narration. No explanations.
- Strict order: moments[0] → moments[8].
- FORBIDDEN: action descriptions, stage directions, screenplay tone.

Preferred Tone (IMPORTANT): Slight self-irony is preferred over positivity. If a caption sounds like something you would say confidently out loud, rewrite it as something you would admit privately in a chat.

For Awkward Moments: Confusion beats confidence. Honesty beats optimism. Quiet resignation beats enthusiasm.

Avoid: Postcard-style phrasing. Motivational tone. "Everything is great" energy.

Goal: Captions should feel like messages people hesitate to send — and then send anyway.

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

Scene Format: Each scene = one sentence. Start with {subject}, chest-up framing, one clear pose or body position, one contained action or pause. Example structure: "{subject} chest-up, torso slightly leaned back, hands frozen mid-gesture, subtle tension in shoulders".

Final Validation: Before outputting each scene check: (1) Sentence starts with {subject}? (2) {subject} exactly once? (3) Same person as reference? (4) Emotion by body, not appearance? (5) Clean cut-out friendly? If any "no" — rewrite.

Goal: 9 visually distinct, emotionally varied scenes that move the SAME person through awkward, human moments people recognize and want to share in private chats.

Output strict JSON with two keys: scene_descriptions (array of 9 strings in English), scene_descriptions_ru (array of 9 strings in Russian). Each string = one sentence. Every element must start with {subject}. No extra text outside the JSON.`;

async function runScenes(
  plan: BossPlan,
  captions: CaptionsOutput,
  criticFeedback?: CriticFeedbackContext
): Promise<ScenesOutput> {
  const model = await getModelForAgent("scenes");
  let userMessage = `Plan:\n${JSON.stringify(plan, null, 2)}\n\nLabels (RU): ${JSON.stringify(captions.labels)}\nLabels (EN): ${JSON.stringify(captions.labels_en)}\n\nOutput scene_descriptions and scene_descriptions_ru as JSON.`;
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
  const raw = await openAiChatJson<{ scene_descriptions: string[]; scene_descriptions_ru?: string[] }>(model, SCENES_SYSTEM, userMessage, { maxTokens: 8192 });
  const sceneDescriptions = Array.isArray(raw.scene_descriptions) ? raw.scene_descriptions.slice(0, 9) : [];
  const sceneDescriptionsRu = Array.isArray(raw.scene_descriptions_ru) ? raw.scene_descriptions_ru.slice(0, 9) : [];
  return { scene_descriptions: sceneDescriptions, scene_descriptions_ru: sceneDescriptionsRu };
}

// --- Critic agent: Quality Gate (SOFT TASTE CHECK) ---
const CRITIC_SYSTEM = `You are a strict quality gate for sticker packs. Check format, rules, and usability.

You must check: caption length and sendability; scene count and uniqueness; rule compliance; consistency across the pack.

Reject (pass=false) when:
- Captions: descriptive or narrative; exceed 15–20 characters; don't read like a real message; violate first-person or no-emojis rule.
- Scenes: break subject lock ({subject}); complex or noisy backgrounds; break one-day or environment consistency; fail visual variety or cut-out safety.

Taste Check (SOFT, NON-BLOCKING): If all moments or captions feel emotionally safe, polite, or postcard-like, add a suggestion encouraging more awkward, self-ironic, or risky moments. Do NOT fail the pack for this alone — use it as a taste improvement hint.

Feedback Rules: Be specific. Reference exact indices (e.g. "caption 4", "scene 7"). Suggest concrete fixes. Avoid vague creative advice. Write reasons and suggestions in Russian (на русском языке).

Goal: Protect both technical quality and emotional interest, without blocking valid but improvable packs.

Output strict JSON with keys: pass (boolean), reasons (array of strings, in Russian), suggestions (array of 1-3 strings, in Russian).`;

async function runCritic(spec: PackSpecRow): Promise<CriticOutput> {
  const model = await getModelForAgent("critic");
  const userMessage = `Full pack spec:\n${JSON.stringify(spec, null, 2)}\n\nOutput pass, reasons, and suggestions as JSON.`;
  return openAiChatJson<CriticOutput>(model, CRITIC_SYSTEM, userMessage, { temperature: 1, maxTokens: 8192 });
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
    let captions: CaptionsOutput = await wrapStage("captions", () => runCaptions(plan));
    console.log(stageLabel("captions"), "done in", Date.now() - t2, "ms");
    await onProgress?.("captions");
    const t3 = Date.now();
    let scenes: ScenesOutput = await wrapStage("scenes", () => runScenes(plan, captions));
    console.log(stageLabel("scenes"), "done in", Date.now() - t3, "ms");
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
      const tRework = Date.now();
      captions = await wrapStage("captions_rework", () => runCaptions(plan, criticContext));
      await onProgress?.("captions_rework");
      scenes = await wrapStage("scenes_rework", () => runScenes(plan, captions, criticContext));
      console.log(stageLabel("captions_rework") + " + scenes_rework done in", Date.now() - tRework, "ms");
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
