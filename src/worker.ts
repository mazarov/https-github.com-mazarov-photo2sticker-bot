import axios from "axios";
import os from "os";
import FormData from "form-data";
import sharp from "sharp";
import { config } from "./config";
import { supabase } from "./lib/supabase";
import { getFilePath, downloadFile, sendMessage, sendSticker, sendPhoto, editMessageText, deleteMessage, getMe } from "./lib/telegram";
import { getText } from "./lib/texts";
import { sendAlert, sendNotification, sendPackPreviewAlert, sendPackCompletedLandingAlert } from "./lib/alerts";
// chromaKey logic removed — rembg handles background removal directly
import { getAppConfig } from "./lib/app-config";
import { addTextToSticker, fitStickerIn512WithMargin, addWhiteBorder } from "./lib/image-utils";
import {
  appendSubjectLock,
  buildSubjectLockBlock,
  detectSubjectProfileFromImageBuffer,
  getSubjectWordForPrompt,
  isSubjectLockEnabled,
  isSubjectModePackFilterEnabled,
  isSubjectPostcheckEnabled,
  isSubjectProfileEnabled,
  normalizeSubjectMode,
  normalizeSubjectGender,
  normalizeSubjectSourceKind,
  type SubjectProfile,
  type SubjectSourceKind,
} from "./lib/subject-profile";

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Supabase Storage 500 / fetch failed / timeout — retry once after delay. */
function isTransientStorageError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const msg = String((e as { message?: string }).message ?? e);
  const code = (e as { code?: number; status?: number }).code ?? (e as { code?: number; status?: number }).status;
  return code === 500 || /fetch failed|timeout|ECONNRESET|ETIMEDOUT/i.test(msg);
}

/** Telegram sendPhoto limit: 10 MB. Resize pack preview if over limit. */
const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

async function resizeBufferUnderMax(buffer: Buffer, maxBytes: number): Promise<Buffer> {
  if (buffer.length <= maxBytes) return buffer;
  const meta = await sharp(buffer).metadata();
  const w = meta.width || 1024;
  const h = meta.height || 1024;
  let scale = 0.9;
  for (let i = 0; i < 12; i++) {
    const out = await sharp(buffer)
      .resize(Math.round(w * scale), Math.round(h * scale), { fit: "inside" })
      .png()
      .toBuffer();
    if (out.length <= maxBytes) return out;
    scale *= 0.85;
  }
  return buffer;
}

// Retry helper with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; baseDelayMs?: number; name?: string } = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 2000, name = "operation" } = options;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isRetryable = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND"].includes(err.code) 
        || (err.response?.status && err.response.status >= 500);
      
      if (!isRetryable || attempt === maxAttempts) {
        throw err;
      }
      
      const delay = baseDelayMs * attempt;
      console.log(`${name} attempt ${attempt}/${maxAttempts} failed (${err.code || err.response?.status}), retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw new Error("Unreachable");
}

const WORKER_ID = `${os.hostname()}-${process.pid}-${Date.now()}`;
console.log(`Worker started: ${WORKER_ID}`);
if (!config.alertChannelId) {
  console.warn("[Config] Alert channel: NOT SET — set ALERT_CHANNEL_ID (or PROD_ALERT_CHANNEL_ID when APP_ENV=test). Pack/alerts will be skipped.");
} else {
  console.log("[Config] Alert channel: configured");
}

let workerBotUsernameCache: string | null = null;
async function getWorkerBotUsername(): Promise<string> {
  if (workerBotUsernameCache) return workerBotUsernameCache;
  try {
    const me = await getMe();
    if (me?.username) {
      workerBotUsernameCache = me.username;
      return workerBotUsernameCache;
    }
  } catch (e: any) {
    console.warn("[Worker] getMe failed, fallback to BOT_USERNAME:", e.message);
  }
  workerBotUsernameCache = config.botUsername || "sticq_bot";
  return workerBotUsernameCache;
}

function getMimeTypeByTelegramPath(filePath: string): string {
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".png")) return "image/png";
  return "image/jpeg";
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

function isSubjectPostcheckMismatch(
  expectedMode: "single" | "multi" | "unknown",
  detectedMode: "single" | "multi" | "unknown",
  detectedCount: number | null
): boolean {
  if (expectedMode === "unknown") return false;
  if (expectedMode === "single") {
    if (detectedMode === "multi") return true;
    if (typeof detectedCount === "number" && detectedCount > 1) return true;
    return false;
  }
  if (expectedMode === "multi") {
    if (detectedMode === "single") return true;
    if (typeof detectedCount === "number" && detectedCount <= 1) return true;
    return false;
  }
  return false;
}

function getSessionSubjectProfileForSource(
  session: any,
  sourceFileId: string,
  sourceKind: SubjectSourceKind
): SubjectProfile | null {
  const sessionSourceId = session?.object_source_file_id || session?.subject_source_file_id || null;
  const sessionSourceKind = normalizeSubjectSourceKind(session?.object_source_kind ?? session?.subject_source_kind);
  if (!sessionSourceId || sessionSourceId !== sourceFileId || sessionSourceKind !== sourceKind) {
    return null;
  }

  const parsedCount = Number(session?.object_count ?? session?.subject_count);
  const parsedConfidence = Number(session?.object_confidence ?? session?.subject_confidence);
  const subjectGenderVal = normalizeSubjectGender(session?.object_gender ?? session?.subject_gender) ?? null;

  return {
    subjectMode: normalizeSubjectMode(session?.object_mode ?? session?.subject_mode),
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

async function ensureSubjectProfileForSource(
  session: any,
  sourceFileId: string,
  sourceKind: SubjectSourceKind,
  sourceBuffer: Buffer,
  sourceMime: string
): Promise<SubjectProfile | null> {
  const profileEnabled = await isSubjectProfileEnabled();
  if (!profileEnabled) return null;

  const existing = getSessionSubjectProfileForSource(session, sourceFileId, sourceKind);
  if (existing) return existing;

  const detectedAt = new Date().toISOString();
  const detectorModel = await getAppConfig("gemini_model_subject_detector", "gemini-2.0-flash");
  console.log("[subject-profile] detector model:", detectorModel, {
    sessionId: session.id,
    sourceKind,
    sourceFileId: sourceFileId.substring(0, 30) + "...",
  });
  const detected = await detectSubjectProfileFromImageBuffer(sourceBuffer, sourceMime);

  const nextProfile: SubjectProfile = {
    subjectMode: detected.subjectMode,
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

  console.log("[subject-profile] worker updated profile:", {
    sessionId: session.id,
    sourceKind,
    subjectMode: nextProfile.subjectMode,
    subjectCount: nextProfile.subjectCount,
    subjectGender: nextProfile.subjectGender,
  });
  sendAlert({
    type: "subject_profile_detected",
    message: "Subject profile saved (worker)",
    details: {
      sessionId: session.id,
      sourceKind,
      subjectMode: nextProfile.subjectMode,
      subjectCount: nextProfile.subjectCount ?? "-",
      subjectGender: nextProfile.subjectGender ?? "-",
      subjectConfidence: nextProfile.subjectConfidence ?? "-",
    },
  }).catch(() => {});

  return nextProfile;
}

/**
 * Call rembg HTTP API to remove background.
 * Returns buffer with transparent background, or undefined if failed.
 */
async function callRembg(imageBuffer: Buffer, rembgUrl: string | undefined, imageSizeKb: number): Promise<Buffer | undefined> {
  if (!rembgUrl) return undefined;
  
  try {
    // Configurable model via app_config: rembg_model (prod) / rembg_model_test (test)
    const modelConfigKey = config.appEnv === "test" ? "rembg_model_test" : "rembg_model";
    const rembgModel = await getAppConfig(modelConfigKey, "isnet-general-use");
    
    // Resize image for rembg processing (max 1024px — preserve quality)
    const rembgBuffer = await sharp(imageBuffer)
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    const rembgSizeKb = Math.round(rembgBuffer.length / 1024);
    console.log(`[rembg] Starting request to ${rembgUrl} model=${rembgModel} (resized: ${rembgSizeKb} KB, original: ${imageSizeKb} KB)`);
    
    // Health check
    try {
      const healthStart = Date.now();
      const healthRes = await axios.get(`${rembgUrl}/health`, { timeout: 5000 });
      console.log(`[rembg] Health check OK (${Date.now() - healthStart}ms):`, healthRes.data);
    } catch (healthErr: any) {
      console.error(`[rembg] Health check FAILED: ${healthErr.code || healthErr.message}`);
    }
    
    const rembgForm = new FormData();
    rembgForm.append("image", rembgBuffer, {
      filename: "image.png",
      contentType: "image/png",
    });
    // Pass model as form field (supported by rembg HTTP server)
    rembgForm.append("model", rembgModel);
    
    let attemptNum = 0;
    const rembgRes = await retryWithBackoff(
      () => {
        attemptNum++;
        const attemptStart = Date.now();
        console.log(`[rembg] Attempt ${attemptNum}/2 starting... model=${rembgModel}`);
        return axios.post(`${rembgUrl}/remove-background`, rembgForm, {
          headers: rembgForm.getHeaders(),
          responseType: "arraybuffer",
          timeout: 90000,
        }).then(res => {
          console.log(`[rembg] Attempt ${attemptNum} completed in ${Date.now() - attemptStart}ms`);
          return res;
        });
      },
      { maxAttempts: 2, baseDelayMs: 3000, name: "rembg" }
    );
    const processingTime = rembgRes.headers?.['x-processing-time-ms'] || 'unknown';
    console.log(`[rembg] SUCCESS server_processing=${processingTime}ms`);
    return Buffer.from(rembgRes.data);
  } catch (rembgErr: any) {
    console.error(`[rembg] FAILED: ${rembgErr.code || 'none'} — ${rembgErr.message}`);
    return undefined;
  }
}

async function callPixian(imageBuffer: Buffer, imageSizeKb: number): Promise<Buffer | undefined> {
  try {
    console.log(`[Pixian] Starting request (${imageSizeKb} KB)`);
    const pixianForm = new FormData();
    pixianForm.append("image", imageBuffer, {
      filename: "image.png",
      contentType: "image/png",
    });

    const startTime = Date.now();
    const pixianRes = await retryWithBackoff(
      () => axios.post("https://api.pixian.ai/api/v2/remove-background", pixianForm, {
        auth: {
          username: config.pixianUsername,
          password: config.pixianPassword,
        },
        headers: pixianForm.getHeaders(),
        responseType: "arraybuffer",
        timeout: 60000,
      }),
      { maxAttempts: 3, baseDelayMs: 2000, name: "Pixian" }
    );
    const duration = Date.now() - startTime;
    console.log(`[Pixian] SUCCESS (took ${duration}ms)`);
    return Buffer.from(pixianRes.data);
  } catch (err: any) {
    console.error(`[Pixian] FAILED: ${err.response?.status || err.code || 'none'} — ${err.message}`);
    return undefined;
  }
}

// ============================================
// Pack generation functions
// ============================================

/**
 * Generate a sticker sheet via Gemini and send preview to user.
 */
async function runPackPreviewJob(job: any) {
  console.log("[PackPreview] Starting job:", job.id, "batch:", job.pack_batch_id);

  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", job.session_id)
    .maybeSingle();
  if (!session) throw new Error("Session not found");

  const { data: user } = await supabase
    .from("users")
    .select("telegram_id, lang, username, credits")
    .eq("id", session.user_id)
    .maybeSingle();
  if (!user?.telegram_id) throw new Error("User telegram_id not found");

  const lang = user.lang || "en";
  const telegramId = user.telegram_id;

  const { data: batch } = await supabase
    .from("pack_batches")
    .select("*")
    .eq("id", job.pack_batch_id)
    .maybeSingle();
  if (!batch) throw new Error("Pack batch not found");

  const templateId = batch.template_id || session.pack_template_id || null;
  let template: any = null;
  let baseContentSet: any = null;
  if (session.pack_content_set_id) {
    const { data: selectedSet } = await supabase
      .from("pack_content_sets")
      .select("id, pack_template_id, sticker_count, labels, labels_en, scene_descriptions, is_active, subject_mode")
      .eq("id", session.pack_content_set_id)
      .maybeSingle();
    if (selectedSet?.is_active) {
      baseContentSet = selectedSet;
      console.log("[PackPreview] Using selected content set:", session.pack_content_set_id);
    }
  }
  if (!baseContentSet && templateId) {
    const { data: firstSet } = await supabase
      .from("pack_content_sets")
      .select("id, pack_template_id, sticker_count, labels, labels_en, scene_descriptions, is_active, subject_mode")
      .eq("pack_template_id", templateId)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (firstSet) {
      baseContentSet = firstSet;
      console.log("[PackPreview] Fallback to first active content set:", firstSet.id);
    }
  }
  if (baseContentSet) {
    template = {
      id: baseContentSet.pack_template_id || templateId || "unknown_template",
      sticker_count: baseContentSet.sticker_count || 4,
      labels: baseContentSet.labels || [],
      labels_en: baseContentSet.labels_en || baseContentSet.labels || [],
      scene_descriptions: baseContentSet.scene_descriptions || [],
      collage_file_id: null,
      collage_url: null,
    };
  }
  if (!template) throw new Error("Pack content set not found");

  // Scene descriptions: from content set if session has one, else from template
  const stickerCountForScenes = template.sticker_count || 4;
  let sceneDescriptionsSource: string[] = template.scene_descriptions || [];
  console.log("[PackPreview] session.pack_content_set_id:", session.pack_content_set_id ?? "(not set)");
  if (session.pack_content_set_id) {
    const { data: contentSet, error: contentSetErr } = await supabase
      .from("pack_content_sets")
      .select("scene_descriptions, is_active")
      .eq("id", session.pack_content_set_id)
      .maybeSingle();
    if (contentSetErr) {
      console.warn("[PackPreview] Content set fetch error:", contentSetErr.message);
    } else if (!contentSet) {
      console.warn("[PackPreview] Content set not found:", session.pack_content_set_id);
    } else if (!contentSet.is_active) {
      console.warn("[PackPreview] Content set inactive:", session.pack_content_set_id);
    } else if (!Array.isArray(contentSet.scene_descriptions) || contentSet.scene_descriptions.length !== stickerCountForScenes) {
      console.warn("[PackPreview] Content set scene_descriptions length mismatch: got", contentSet.scene_descriptions?.length ?? 0, "expected", stickerCountForScenes);
    } else {
      sceneDescriptionsSource = contentSet.scene_descriptions;
      console.log("[PackPreview] Using scene_descriptions from content set:", session.pack_content_set_id);
    }
  }

  // Unified flow: session.prompt_final = same as single sticker (agent + composition suffix from API).
  // Fallback when empty: preset.prompt_hint only.
  const promptFinalRaw = (session.prompt_final ?? "").trim();
  console.log("[PackPreview] session.prompt_final from DB, length:", promptFinalRaw.length, "preview:", promptFinalRaw.slice(0, 150));
  let styleBlock = promptFinalRaw;
  let selectedStyleName = "";
  let selectedStylePromptHint = "";
  if (session.selected_style_id) {
    const { data: stylePreset } = await supabase
      .from("style_presets_v2")
      .select("id,name_ru,name_en,prompt_hint,is_active")
      .eq("id", session.selected_style_id)
      .eq("is_active", true)
      .maybeSingle();
    if (stylePreset) {
      selectedStyleName = lang === "ru" ? stylePreset.name_ru : stylePreset.name_en;
      selectedStylePromptHint = (stylePreset.prompt_hint || "").trim();
      const rawHint = selectedStylePromptHint;
      if (rawHint && !styleBlock) {
        styleBlock = rawHint;
        console.log("[PackPreview] Fallback: style from preset (no prompt_final):", stylePreset.id, selectedStyleName);
      } else if (styleBlock) {
        console.log("[PackPreview] Using unified prompt_final (same as single sticker):", stylePreset.id, selectedStyleName);
      }
    }
  }

  // Download user photo
  const photoFileId = session.current_photo_file_id;
  if (!photoFileId) throw new Error("No photo in session");

  const filePath = await getFilePath(photoFileId);
  const photoBuffer = await downloadFile(filePath);
  const photoBase64 = photoBuffer.toString("base64");
  const photoMime = getMimeTypeByTelegramPath(filePath);

  const lockEnabled = await isSubjectLockEnabled();
  let packSubjectProfile = getSessionSubjectProfileForSource(session, photoFileId, "photo");
  if (!packSubjectProfile) {
    packSubjectProfile = await ensureSubjectProfileForSource(session, photoFileId, "photo", photoBuffer, photoMime);
  }
  const subjectLockBlock =
    lockEnabled && packSubjectProfile ? buildSubjectLockBlock(packSubjectProfile) : "";
  const styleBlockWithSubject = subjectLockBlock
    ? appendSubjectLock(styleBlock, subjectLockBlock)
    : styleBlock;
  const subjectModeForPrompt = packSubjectProfile?.subjectMode || normalizeSubjectMode(session.object_mode ?? session.subject_mode);
  const subjectFilterEnabled = await isSubjectModePackFilterEnabled();
  if (subjectFilterEnabled) {
    const setSubjectMode = normalizePackSetSubjectMode(baseContentSet?.subject_mode);
    const subjectMode = subjectModeForPrompt;
    if (!isPackSetCompatibleWithSubject(setSubjectMode, subjectMode)) {
      console.warn("[PackPreview] blocked by subject-mode compatibility:", {
        setSubjectMode,
        subjectMode,
        contentSetId: baseContentSet?.id,
        sessionId: session.id,
      });

      await supabase
        .from("users")
        .update({ credits: (user.credits || 0) + 1 })
        .eq("id", session.user_id);

      await supabase
        .from("pack_batches")
        .update({ status: "failed", credits_spent: 0, updated_at: new Date().toISOString() })
        .eq("id", batch.id);

      await supabase
        .from("sessions")
        .update({ state: "wait_pack_carousel", is_active: true, progress_message_id: null, progress_chat_id: null })
        .eq("id", session.id);

      if (session.progress_message_id && session.progress_chat_id) {
        try { await deleteMessage(session.progress_chat_id, session.progress_message_id); } catch {}
      }

      await sendMessage(
        telegramId,
        lang === "ru"
          ? "Набор поз не подходит под текущее количество персонажей. Выбери совместимый набор."
          : "This pose set is not compatible with the current subject count. Please choose a compatible set."
      );
      await sendAlert({
        type: "pack_preview_failed",
        message: "Pack preview rejected by subject_mode compatibility",
        details: {
          user: `@${user.username || telegramId}`,
          batchId: batch.id,
          setSubjectMode,
          subjectMode,
          contentSetId: baseContentSet?.id || "-",
        },
      });
      return;
    }
  }

  // Download collage/style reference image if available
  let collageBase64: string | null = null;
  let collageMime = "image/png";
  if (template.collage_file_id || template.collage_url) {
    try {
      let collageBuf: Buffer;
      if (template.collage_file_id) {
        const collagePath = await getFilePath(template.collage_file_id);
        collageBuf = await downloadFile(collagePath);
      } else {
        const resp = await axios.get(template.collage_url, { responseType: "arraybuffer", timeout: 15000 });
        collageBuf = Buffer.from(resp.data);
      }
      collageBase64 = collageBuf.toString("base64");
      collageMime = template.collage_url?.endsWith(".png") ? "image/png" : "image/jpeg";
      console.log("[PackPreview] Collage loaded, size:", Math.round(collageBuf.length / 1024), "KB");
    } catch (collageErr: any) {
      console.warn("[PackPreview] Failed to load collage, proceeding without:", collageErr.message);
    }
  }

  // Build prompt
  const stickerCount = template.sticker_count || 4;
  const cols = Math.ceil(Math.sqrt(stickerCount));
  const rows = Math.ceil(stickerCount / cols);
  const subjectWord = getSubjectWordForPrompt(packSubjectProfile);
  console.log("[PackPreview] {subject} ->", subjectWord, "| packSubjectProfile.subjectGender:", packSubjectProfile?.subjectGender ?? "null", "| subjectMode:", packSubjectProfile?.subjectMode);
  const sceneDescriptions: string[] = sceneDescriptionsSource.map((desc: string) =>
    desc.replace(/\{subject\}/gi, subjectWord)
  );
  const sceneList = sceneDescriptions
    .map((desc: string, i: number) => `${i + 1}. ${desc}`)
    .join("\n");
  const sceneCardinalityGuard =
    subjectModeForPrompt === "single"
      ? `SUBJECT COUNT ENFORCEMENT:
- The source contains exactly ONE main person.
- Every scene MUST depict the same single person only.
- If a scene description implies a couple or another person ("man and woman", "couple", "both", etc.), reinterpret it as a SOLO action with festive props/facial expression only.
- Never add a second person, partner, or any prominent secondary character.`
      : subjectModeForPrompt === "multi"
        ? `SUBJECT COUNT ENFORCEMENT:
- Keep the same two main people from source in every scene.
- Do not add extra people or replace either person.`
        : "";
  // Pack-only task: grid layout, scenes, format rules. Style + composition = styleBlock (same as single sticker).
  const packTaskBlock = `[TASK — PACK GRID ONLY]
Create a ${cols}x${rows} grid of images (${stickerCount} cells total).
Each cell = ONE image with a DISTINCT pose/emotion from the list below. Every cell MUST have visible margins (at least 15% empty space on each side of the character) — no tight cropping; background removal requires this.

Scenes (one per cell, left-to-right, top-to-bottom):
${sceneList}

${sceneCardinalityGuard ? `${sceneCardinalityGuard}\n` : ""}

CRITICAL RULES FOR THE GRID:
The character(s) must look EXACTLY like the person(s) in the reference photo.
${selectedStylePromptHint ? `0. STYLE (apply in every cell): ${selectedStylePromptHint}\n` : ""}1. Do NOT draw any outline, border, stroke, or contour around the character(s). Raw clean edges only — the image will be background-removed; hand-drawn outlines get damaged. No sticker-style borders, white outlines, or decorative edges.
2. Background MUST be flat uniform BRIGHT MAGENTA (#FF00FF) in EVERY cell. Any objects in the scene (fridge, furniture, props) must be on this same flat background — no walls, no room interior, no extra environment behind objects.
3. Each character must be fully visible within its cell with nothing cropped. Hands, arms, fingers, and wrists must be FULLY inside the cell with clear margin — never crop at wrists or hands. If a pose would extend limbs past the cell edge, draw the character smaller or choose a pose that keeps all limbs inside.
4. MANDATORY PADDING: The character must be SURROUNDED by visible magenta background on EVERY side — TOP, BOTTOM, LEFT, RIGHT. Leave at least 15% empty space (margin) on ALL four edges. The BOTTOM must have the same margin as the top — do NOT push the subject, blanket, or props to the bottom edge. For raised arms or wide gestures use 20% or more. Tight framing with no margin on any side breaks background removal.
5. SEAMLESS GRID: The image must be one continuous surface — magenta background flows from cell to cell with NO visible division. Do NOT draw white lines, grid lines, stripes, or any separator between the 9 images. We split the image programmatically; you must not add any marking or line between cells.
6. LIKENESS: In EVERY cell — EYE COLOR must match the reference EXACTLY (same hue and intensity). Preserve freckles, moles, beauty marks, birthmarks, face shape, skin tone. Do NOT change eye color or omit distinctive features that appear in the reference.
7. Style must be IDENTICAL across all cells — same art style, proportions, colors.
8. Do NOT add any text, labels, or captions in the cells. Text will be added programmatically later.`;

  const hasCollage = !!collageBase64;
  const prompt = hasCollage
    ? `${styleBlockWithSubject ? `${styleBlockWithSubject}\n\n` : ""}[REFERENCE IMAGE]
The first image is a reference pack. Match its visual style (rendering, proportions, colors). Do not add outlines, strokes, or borders around the character.

${packTaskBlock}`
    : `${styleBlockWithSubject ? `${styleBlockWithSubject}\n\n` : ""}${packTaskBlock}`;

  const packPromptChars = prompt.length;
  const packPromptTokensApprox = Math.ceil(packPromptChars / 4);
  console.log("[PackPreview] Prompt (first 400):", prompt.substring(0, 400), hasCollage ? "(with collage ref)" : "(no collage)");
  console.log("[PackPreview] Full prompt length:", packPromptChars, "chars, ~", packPromptTokensApprox, "tokens (Gemini limit ~1M input tokens)");
  console.log("[PackPreview] Full prompt:\n" + prompt);

  // Build image parts for Gemini
  const imageParts: any[] = [];
  if (collageBase64) {
    imageParts.push({ inlineData: { mimeType: collageMime, data: collageBase64 } });
  }
  imageParts.push({ inlineData: { mimeType: photoMime, data: photoBase64 } });

  // Call Gemini (model and output resolution from app_config)
  const model = await getAppConfig("gemini_model_pack", "gemini-2.5-flash-image");
  const imageSize = await getAppConfig("gemini_image_size_pack", "1K");
  console.log("[PackPreview] Using model:", model, "imageSize:", imageSize);

  const PACK_PREVIEW_GEMINI_MAX_ATTEMPTS = 3;
  const PACK_PREVIEW_GEMINI_RETRY_DELAY_MS = 12000;

  let geminiRes: any = null;
  let lastErrorMsg = "";
  for (let attempt = 1; attempt <= PACK_PREVIEW_GEMINI_MAX_ATTEMPTS; attempt++) {
    try {
      geminiRes = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          contents: [{
            role: "user",
            parts: [
              { text: prompt },
              ...imageParts,
            ],
          }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: "1:1", imageSize },
          },
        },
        {
          headers: { "x-goog-api-key": config.geminiApiKey },
          timeout: 120000,
        }
      );
      break;
    } catch (err: any) {
      lastErrorMsg = err.response?.data?.error?.message || err.message;
      const status = err.response?.status;
      const apiError = err.response?.data?.error;
      console.error("[PackPreview] Gemini error (attempt " + attempt + "/" + PACK_PREVIEW_GEMINI_MAX_ATTEMPTS + "):", lastErrorMsg, status ? `[HTTP ${status}]` : "", apiError ? JSON.stringify(apiError) : "");
      const isRetryable = /high demand|try again later/i.test(lastErrorMsg);
      if (attempt < PACK_PREVIEW_GEMINI_MAX_ATTEMPTS && isRetryable) {
        console.log("[PackPreview] Retrying in", PACK_PREVIEW_GEMINI_RETRY_DELAY_MS / 1000, "s...");
        await new Promise((r) => setTimeout(r, PACK_PREVIEW_GEMINI_RETRY_DELAY_MS));
      } else {
        break;
      }
    }
  }

  if (!geminiRes) {
    const errorMsg = lastErrorMsg || "Unknown error";
    console.error("[PackPreview] Gemini failed after", PACK_PREVIEW_GEMINI_MAX_ATTEMPTS, "attempts");

    // Refund 1 credit
    await supabase
      .from("users")
      .update({ credits: (user.credits || 0) + 1 })
      .eq("id", session.user_id);

    await supabase
      .from("pack_batches")
      .update({ status: "failed", credits_spent: 0, updated_at: new Date().toISOString() })
      .eq("id", batch.id);

    await supabase
      .from("sessions")
      .update({ state: "canceled", is_active: false, progress_message_id: null, progress_chat_id: null })
      .eq("id", session.id);

    // Clear progress
    if (session.progress_message_id && session.progress_chat_id) {
      try { await deleteMessage(session.progress_chat_id, session.progress_message_id); } catch {}
    }

    await sendMessage(telegramId, await getText(lang, "pack.preview_failed"));

    await sendAlert({
      type: "pack_preview_failed",
      message: `Pack preview Gemini error: ${errorMsg}`,
      details: {
        user: `@${user.username || telegramId}`,
        batchId: batch.id,
        model,
      },
    });
    return; // graceful exit, not throwing
  }

  // Check block
  const blockReason = geminiRes.data?.promptFeedback?.blockReason;
  if (blockReason) {
    console.error("[PackPreview] Gemini blocked:", blockReason);
    await supabase.from("users").update({ credits: (user.credits || 0) + 1 }).eq("id", session.user_id);
    await supabase.from("pack_batches").update({ status: "failed", credits_spent: 0, updated_at: new Date().toISOString() }).eq("id", batch.id);
    await supabase.from("sessions").update({ state: "canceled", is_active: false, progress_message_id: null, progress_chat_id: null }).eq("id", session.id);
    if (session.progress_message_id && session.progress_chat_id) {
      try { await deleteMessage(session.progress_chat_id, session.progress_message_id); } catch {}
    }
    await sendMessage(telegramId, await getText(lang, "pack.preview_failed"));
    await sendAlert({ type: "pack_preview_failed", message: `Gemini blocked: ${blockReason}`, details: { user: `@${user.username || telegramId}`, batchId: batch.id } });
    return;
  }

  // Extract image
  const imageBase64 = geminiRes.data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData?.data || null;
  if (!imageBase64) {
    console.error("[PackPreview] Gemini returned no image");
    await supabase.from("users").update({ credits: (user.credits || 0) + 1 }).eq("id", session.user_id);
    await supabase.from("pack_batches").update({ status: "failed", credits_spent: 0, updated_at: new Date().toISOString() }).eq("id", batch.id);
    await supabase.from("sessions").update({ state: "canceled", is_active: false, progress_message_id: null, progress_chat_id: null }).eq("id", session.id);
    if (session.progress_message_id && session.progress_chat_id) {
      try { await deleteMessage(session.progress_chat_id, session.progress_message_id); } catch {}
    }
    await sendMessage(telegramId, await getText(lang, "pack.preview_failed"));
    await sendAlert({ type: "pack_preview_failed", message: "Gemini returned no image", details: { user: `@${user.username || telegramId}`, batchId: batch.id } });
    return;
  }

  const sheetBuffer = Buffer.from(imageBase64, "base64");
  console.log("[PackPreview] Sheet generated, size:", Math.round(sheetBuffer.length / 1024), "KB");

  // Send raw sheet as preview (no full-sheet rembg). Assemble will do per-cell rembg.
  let bufferToSend = sheetBuffer;
  if (sheetBuffer.length > TELEGRAM_PHOTO_MAX_BYTES) {
    bufferToSend = Buffer.from(await resizeBufferUnderMax(sheetBuffer, TELEGRAM_PHOTO_MAX_BYTES));
    console.log("[PackPreview] Resized for Telegram limit, size:", Math.round(bufferToSend.length / 1024), "KB");
  }

  // Keep progress message in chat; send preview as a separate message (user paid for it)
  const remainingCredits = stickerCount - 1;
  const caption = await getText(lang, "pack.preview_caption", {
    count: stickerCount,
    price: remainingCredits,
  });
  const approveBtn = await getText(lang, "btn.approve_pack", { price: remainingCredits });
  const regenerateBtn = await getText(lang, "btn.regenerate_pack");
  const sessionRef = Number.isInteger(Number(session.session_rev))
    ? `${session.id}:${session.session_rev}`
    : session.id;

  const previewResult = await sendPhoto(telegramId, bufferToSend, caption, {
    inline_keyboard: [
      [{ text: approveBtn, callback_data: `pack_approve:${sessionRef}` }],
      [{ text: regenerateBtn, callback_data: `pack_regenerate:${sessionRef}` }],
    ],
  });

  const sheetFileId = previewResult?.file_id || "";
  console.log("[PackPreview] Preview sent, file_id:", sheetFileId?.substring(0, 30));

  if (session.selected_style_id) {
    sendPackPreviewAlert(session.selected_style_id, bufferToSend, {
      user: `@${user.username || telegramId}`,
      batchId: batch.id,
    }).catch((err) => console.warn("[PackPreview] sendPackPreviewAlert failed:", err?.message));
  }

  await supabase
    .from("sessions")
    .update({
      state: "wait_pack_approval",
      pack_sheet_file_id: sheetFileId,
      pack_sheet_cleaned: false,
      pack_batch_id: batch.id,
      is_active: true,
      progress_message_id: null,
      progress_chat_id: null,
    })
    .eq("id", session.id);

  console.log("[PackPreview] Job complete, waiting for user approval");
}

/**
 * Download the previously generated sheet, cut into cells,
 * remove background, overlay text labels, and assemble Telegram sticker set.
 */
async function runPackAssembleJob(job: any) {
  console.log("[PackAssemble] Starting job:", job.id, "batch:", job.pack_batch_id);

  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", job.session_id)
    .maybeSingle();
  if (!session) throw new Error("Session not found");

  const { data: user } = await supabase
    .from("users")
    .select("telegram_id, lang, username, credits")
    .eq("id", session.user_id)
    .maybeSingle();
  if (!user?.telegram_id) throw new Error("User telegram_id not found");

  const lang = user.lang || "en";
  const telegramId = user.telegram_id;

  const { data: batch } = await supabase
    .from("pack_batches")
    .select("*")
    .eq("id", job.pack_batch_id)
    .maybeSingle();
  if (!batch) throw new Error("Pack batch not found");

  const templateId = batch.template_id || session.pack_template_id || null;
  let template: any = null;
  let baseContentSet: any = null;
  if (session.pack_content_set_id) {
    const { data: selectedSet } = await supabase
      .from("pack_content_sets")
      .select("id, pack_template_id, sticker_count, labels, labels_en, scene_descriptions, is_active, subject_mode")
      .eq("id", session.pack_content_set_id)
      .maybeSingle();
    if (selectedSet?.is_active) {
      baseContentSet = selectedSet;
      console.log("[PackAssemble] Using selected content set:", session.pack_content_set_id);
    }
  }
  if (!baseContentSet && templateId) {
    const { data: firstSet } = await supabase
      .from("pack_content_sets")
      .select("id, pack_template_id, sticker_count, labels, labels_en, scene_descriptions, is_active, subject_mode")
      .eq("pack_template_id", templateId)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (firstSet) {
      baseContentSet = firstSet;
      console.log("[PackAssemble] Fallback to first active content set:", firstSet.id);
    }
  }
  if (baseContentSet) {
    template = {
      id: baseContentSet.pack_template_id || templateId || "unknown_template",
      sticker_count: baseContentSet.sticker_count || 4,
      labels: baseContentSet.labels || [],
      labels_en: baseContentSet.labels_en || baseContentSet.labels || [],
      scene_descriptions: baseContentSet.scene_descriptions || [],
    };
  }
  if (!template) throw new Error("Pack content set not found");

  // Labels: from content set if session has one, else from template
  let labelsSource: string[] = (lang === "ru" ? template.labels : (template.labels_en || template.labels)) || [];
  if (session.pack_content_set_id) {
    const { data: contentSet } = await supabase
      .from("pack_content_sets")
      .select("labels, labels_en, is_active")
      .eq("id", session.pack_content_set_id)
      .maybeSingle();
    if (contentSet?.is_active && Array.isArray(contentSet.labels) && contentSet.labels.length === (template.sticker_count || 4)) {
      labelsSource = lang === "ru" ? (contentSet.labels || []) : (contentSet.labels_en || contentSet.labels || []);
      console.log("[PackAssemble] Using labels from content set:", session.pack_content_set_id);
    }
  }

  // Helper: update progress message
  async function updatePackProgress(text: string) {
    if (!session.progress_message_id || !session.progress_chat_id) return;
    try {
      await editMessageText(session.progress_chat_id, session.progress_message_id, text);
    } catch {}
  }

  const sheetFileId = session.pack_sheet_file_id;
  if (!sheetFileId) throw new Error("No sheet file_id in session");
  const sheetPath = await getFilePath(sheetFileId);
  const sheetBuffer = await downloadFile(sheetPath);
  console.log("[PackAssemble] Sheet downloaded, size:", Math.round(sheetBuffer.length / 1024), "KB");

  // Get sheet dimensions and calculate cell sizes
  const sheetMeta = await sharp(sheetBuffer).metadata();
  const sheetW = sheetMeta.width || 1024;
  const sheetH = sheetMeta.height || 1024;
  const stickerCount = template.sticker_count || 4;
  // User already paid 1 credit for preview, so on assemble failure
  // we refund only the second payment (N-1 credits).
  const assembleRefundAmount = Math.max(0, stickerCount - 1);
  const cols = Math.ceil(Math.sqrt(stickerCount));
  const rows = Math.ceil(stickerCount / cols);
  const cellW = Math.floor(sheetW / cols);
  const cellH = Math.floor(sheetH / rows);

  console.log(`[PackAssemble] Sheet ${sheetW}x${sheetH}, grid ${cols}x${rows}, cell ${cellW}x${cellH}`);

  // Cut sheet into individual cells
  const cells: Buffer[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx >= stickerCount) break;
      const cell = await sharp(sheetBuffer)
        .extract({ left: c * cellW, top: r * cellH, width: cellW, height: cellH })
        .png()
        .toBuffer();
      cells.push(cell);
    }
  }
  console.log(`[PackAssemble] Cut ${cells.length} cells`);

  await updatePackProgress(await getText(lang, "pack.progress_removing_bg"));

  const rembgUrl = process.env.REMBG_URL;
  const bgConfigKey = config.appEnv === "test" ? "bg_removal_primary_test" : "bg_removal_primary";
  const bgPrimary = await getAppConfig(bgConfigKey, "rembg");
  console.log(`[PackAssemble] BG primary service: ${bgPrimary}`);
  if (!rembgUrl && bgPrimary !== "pixian") {
    console.warn("[PackAssemble] REMBG_URL is not configured; rembg primary may fail");
  }

  const noBgCells = await Promise.all(
    cells.map(async (cellBuf, i) => {
      const sizeKb = Math.round(cellBuf.length / 1024);
      let result: Buffer | undefined;
      if (bgPrimary === "pixian") {
        result = await callPixian(cellBuf, sizeKb);
        if (!result && rembgUrl) result = await callRembg(cellBuf, rembgUrl, sizeKb);
      } else {
        result = await callRembg(cellBuf, rembgUrl, sizeKb);
        if (!result) result = await callPixian(cellBuf, sizeKb);
      }
      return result || null;
    })
  );

  // Count successes
  const successCells = noBgCells.filter(b => b !== null) as Buffer[];
  const failedCount = noBgCells.filter(b => b === null).length;
  console.log(`[PackAssemble] BG removal done: ${successCells.length} success, ${failedCount} failed`);

  if (successCells.length === 0) {
    // Total failure — refund all credits
    const refundAmount = assembleRefundAmount;
    await supabase.from("users").update({ credits: (user.credits || 0) + refundAmount }).eq("id", session.user_id);
    await supabase.from("pack_batches").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", batch.id);
    await supabase.from("sessions").update({ state: "canceled", is_active: false, progress_message_id: null, progress_chat_id: null }).eq("id", session.id);
    if (session.progress_message_id && session.progress_chat_id) {
      try { await deleteMessage(session.progress_chat_id, session.progress_message_id); } catch {}
    }
    await sendMessage(telegramId, await getText(lang, "pack.failed", { refund: refundAmount }));
    await sendAlert({ type: "pack_failed", message: "All BG removal failed", details: { user: `@${user.username || telegramId}`, batchId: batch.id } });
    return;
  }

  // Update progress: adding labels
  await updatePackProgress(await getText(lang, "pack.progress_finishing"));

  // Process each cell: keep Gemini/rembg output as-is, then add optional label overlay.
  const labels: string[] = labelsSource;
  const stickerBuffers: Buffer[] = [];

  for (let i = 0; i < noBgCells.length; i++) {
    const cellBuf = noBgCells[i];
    if (!cellBuf) continue;

    try {
      // Fit content into 512x512 with ~5% margin at edges (so sticker doesn't fill the whole frame)
      let processed = await fitStickerIn512WithMargin(cellBuf, 0.05);
      // Label overlay via addTextToSticker (same font/badge as "add text" for single sticker)
      const label = (labels[i] || "").trim();
      if (label) {
        processed = await addTextToSticker(processed, label, "bottom");
      }
      // Programmatic white border (same as single-sticker "toggle border")
      processed = await addWhiteBorder(processed);
      stickerBuffers.push(processed);
    } catch (procErr: any) {
      console.error(`[PackAssemble] Error processing cell ${i}:`, procErr.message);
    }
  }

  console.log(`[PackAssemble] Processed ${stickerBuffers.length} stickers`);

  if (stickerBuffers.length === 0) {
    const refundAmount = assembleRefundAmount;
    await supabase.from("users").update({ credits: (user.credits || 0) + refundAmount }).eq("id", session.user_id);
    await supabase.from("pack_batches").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", batch.id);
    await supabase.from("sessions").update({ state: "canceled", is_active: false, progress_message_id: null, progress_chat_id: null }).eq("id", session.id);
    if (session.progress_message_id && session.progress_chat_id) {
      try { await deleteMessage(session.progress_chat_id, session.progress_message_id); } catch {}
    }
    await sendMessage(telegramId, await getText(lang, "pack.failed", { refund: refundAmount }));
    await sendAlert({ type: "pack_failed", message: "All sticker processing failed", details: { user: `@${user.username || telegramId}`, batchId: batch.id } });
    return;
  }

  // Update progress: creating sticker set
  await updatePackProgress(await getText(lang, "pack.progress_assembling_set"));

  // Create Telegram sticker set name according to Bot API constraints:
  // - only [a-z0-9_]
  // - must end with `_by_<bot_username>`
  // - max length 64 chars
  const rawBotUsername = (await getWorkerBotUsername()).toLowerCase();
  const normalizedBotUsername = rawBotUsername.replace(/^@/, "").replace(/[^a-z0-9_]/g, "") || "sticq_bot";
  const suffix = `_by_${normalizedBotUsername}`;
  const rawPrefix = `p2s_pack_${String(telegramId)}_${Math.floor(Date.now() / 1000)}`.toLowerCase().replace(/[^a-z0-9_]/g, "");
  const maxPrefixLen = Math.max(1, 64 - suffix.length);
  const prefix = rawPrefix.slice(0, maxPrefixLen);
  const setName = `${prefix}${suffix}`;
  console.log("[PackAssemble] Sticker set name:", setName, "len:", setName.length);
  const packTitle = lang === "ru" ? `${template.name_ru} — Stickers` : `${template.name_en} — Stickers`;

  try {
    // Create set with first sticker
    const firstStickerForm = new FormData();
    firstStickerForm.append("user_id", String(telegramId));
    firstStickerForm.append("name", setName);
    firstStickerForm.append("title", packTitle);
    firstStickerForm.append("stickers", JSON.stringify([{
      sticker: "attach://sticker0",
      format: "static",
      emoji_list: ["🔥"],
    }]));
    firstStickerForm.append("sticker0", stickerBuffers[0], {
      filename: "sticker.webp",
      contentType: "image/webp",
    });

    await axios.post(
      `https://api.telegram.org/bot${config.telegramBotToken}/createNewStickerSet`,
      firstStickerForm,
      { headers: firstStickerForm.getHeaders(), timeout: 30000 }
    );
    console.log("[PackAssemble] Sticker set created:", setName);

    // Add remaining stickers
    for (let i = 1; i < stickerBuffers.length; i++) {
      const addForm = new FormData();
      addForm.append("user_id", String(telegramId));
      addForm.append("name", setName);
      addForm.append("sticker", JSON.stringify({
        sticker: "attach://stickerfile",
        format: "static",
        emoji_list: ["🔥"],
      }));
      addForm.append("stickerfile", stickerBuffers[i], {
        filename: "sticker.webp",
        contentType: "image/webp",
      });

      try {
        await axios.post(
          `https://api.telegram.org/bot${config.telegramBotToken}/addStickerToSet`,
          addForm,
          { headers: addForm.getHeaders(), timeout: 15000 }
        );
        console.log(`[PackAssemble] Added sticker ${i + 1}/${stickerBuffers.length}`);
      } catch (addErr: any) {
        console.error(`[PackAssemble] Failed to add sticker ${i + 1}:`, addErr.response?.data || addErr.message);
      }
    }
  } catch (createErr: any) {
    console.error("[PackAssemble] Failed to create sticker set:", createErr.response?.data || createErr.message);
    const refundAmount = assembleRefundAmount;
    await supabase.from("users").update({ credits: (user.credits || 0) + refundAmount }).eq("id", session.user_id);
    await supabase.from("pack_batches").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", batch.id);
    await supabase.from("sessions").update({ state: "canceled", is_active: false, progress_message_id: null, progress_chat_id: null }).eq("id", session.id);
    if (session.progress_message_id && session.progress_chat_id) {
      try { await deleteMessage(session.progress_chat_id, session.progress_message_id); } catch {}
    }
    await sendMessage(telegramId, await getText(lang, "pack.failed", { refund: refundAmount }));
    await sendAlert({
      type: "pack_failed",
      message: `Sticker set creation failed: ${createErr.response?.data?.description || createErr.message}`,
      details: { user: `@${user.username || telegramId}`, batchId: batch.id, setName },
    });
    return;
  }

  // Notify user first — pack is already in Telegram; Storage/DB must not block delivery
  const link = `https://t.me/addstickers/${setName}`;
  const isPartial = stickerBuffers.length < stickerCount;
  const doneKey = isPartial ? "pack.done_partial" : "pack.done";
  const doneText = await getText(lang, doneKey, {
    count: stickerBuffers.length,
    total: stickerCount,
    link,
  });

  await supabase
    .from("pack_batches")
    .update({
      status: stickerBuffers.length === stickerCount ? "done" : "partial",
      completed_count: stickerBuffers.length,
      failed_count: stickerCount - stickerBuffers.length,
      sticker_set_name: setName,
      updated_at: new Date().toISOString(),
    })
    .eq("id", batch.id);

  if (session.progress_message_id && session.progress_chat_id) {
    try { await deleteMessage(session.progress_chat_id, session.progress_message_id); } catch {}
  }

  await sendMessage(telegramId, doneText, {
    inline_keyboard: [
      [{ text: lang === "ru" ? "📦 Добавить пак" : "📦 Add pack", url: link }],
    ],
  });

  await supabase
    .from("sessions")
    .update({
      state: "confirm_sticker",
      is_active: false,
      progress_message_id: null,
      progress_chat_id: null,
    })
    .eq("id", session.id);

  const alertType = isPartial ? "pack_partial" : "pack_completed";
  await sendAlert({
    type: alertType,
    message: `Pack ${isPartial ? "partial" : "completed"}: ${stickerBuffers.length}/${stickerCount}`,
    details: {
      user: `@${user.username || telegramId}`,
      batchId: batch.id,
      setName,
      link,
    },
  });

  if (!isPartial && stickerBuffers.length > 0) {
    sendPackCompletedLandingAlert(batch.id, stickerBuffers[0], {
      user: `@${user.username || telegramId}`,
      setName,
      contentSetId: session.pack_content_set_id ?? undefined,
      styleId: session.selected_style_id ?? undefined,
    }).catch((err) => console.warn("[PackAssemble] sendPackCompletedLandingAlert failed:", err?.message));
  }

  console.log("[PackAssemble] Job complete! Set:", setName);

  // Save sticker records + Storage upload in background (best-effort; do not block or throw)
  const storagePrefix = `stickers/${session.user_id}/${batch.id}`;
  const packTimestamp = Date.now();
  const bucket = config.supabaseStorageBucket;
  console.log("[PackAssemble] Storage upload starting: bucket=" + bucket + " prefix=" + storagePrefix + " url=" + config.supabaseUrl);
  let storageUploaded = 0;
  for (let i = 0; i < stickerBuffers.length; i++) {
    let resultStoragePath: string | null = null;
    const path = `${storagePrefix}/${packTimestamp}_${i}.webp`;
    const doUpload = () =>
      supabase.storage
        .from(bucket)
        .upload(path, stickerBuffers[i], { contentType: "image/webp", upsert: true });
    try {
      let { error } = await doUpload();
      if (error && isTransientStorageError(error)) {
        await sleep(2000);
        const retry = await doUpload();
        error = retry.error;
      }
      if (!error) {
        resultStoragePath = path;
        storageUploaded++;
      } else {
        const errPayload = typeof error === "object" && error !== null ? JSON.stringify(error) : String(error);
        console.warn("[PackAssemble] Storage upload failed for index", i, error?.message || error, "payload:", errPayload);
      }
    } catch (e) {
      if (isTransientStorageError(e)) {
        await sleep(2000);
        try {
          const { error: retryErr } = await doUpload();
          if (!retryErr) {
            resultStoragePath = path;
            storageUploaded++;
          } else console.warn("[PackAssemble] Storage upload failed for index (retry)", i, retryErr.message);
        } catch (e2) {
          const msg = (e2 as Error)?.message || String(e2);
          const payload = (e2 as { response?: { data?: unknown } })?.response?.data;
          console.warn("[PackAssemble] Storage upload failed for index (retry throw)", i, msg, payload ? "response:" + JSON.stringify(payload) : "");
        }
      } else {
        const msg = (e as Error)?.message || String(e);
        const payload = (e as { response?: { data?: unknown } })?.response?.data;
        console.warn("[PackAssemble] Storage upload failed for index (throw)", i, msg, payload ? "response:" + JSON.stringify(payload) : "");
      }
    }
    try {
      await supabase.from("stickers").insert({
        user_id: session.user_id,
        session_id: session.id,
        source_photo_file_id: session.current_photo_file_id,
        result_storage_path: resultStoragePath,
        sticker_set_name: setName,
        pack_batch_id: batch.id,
        pack_index: i,
        style_preset_id: session.selected_style_id || null,
        env: config.appEnv,
      });
    } catch (e) {
      console.warn("[PackAssemble] DB insert failed for index", i, (e as Error).message || String(e));
    }
  }
  console.log("[PackAssemble] Storage:", storageUploaded + "/" + stickerBuffers.length, "uploaded, set:", setName);
}

async function runJob(job: any) {
  // Route pack jobs to dedicated handlers
  if (job.pack_batch_id) {
    const { data: batch } = await supabase
      .from("pack_batches")
      .select("status")
      .eq("id", job.pack_batch_id)
      .maybeSingle();
    
    if (batch?.status === "approved" || batch?.status === "processing") {
      return runPackAssembleJob(job);
    } else {
      return runPackPreviewJob(job);
    }
  }

  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", job.session_id)
    .maybeSingle();

  if (!session) {
    throw new Error("Session not found");
  }

  const { data: user } = await supabase
    .from("users")
    .select("telegram_id, lang, sticker_set_name, username, credits, total_generations, onboarding_step")
    .eq("id", session.user_id)
    .maybeSingle();

  const telegramId = user?.telegram_id;
  const lang = user?.lang || "en";
  if (!telegramId) {
    throw new Error("User telegram_id not found");
  }

  async function updateProgress(step: 1 | 2 | 3 | 4 | 5 | 6 | 7) {
    if (!session.progress_message_id || !session.progress_chat_id) return;
    try {
      await editMessageText(
        session.progress_chat_id,
        session.progress_message_id,
        await getText(lang, `progress.step${step}`)
      );
    } catch (err) {
      // ignore edit errors
    }
  }

  async function clearProgress() {
    if (!session.progress_message_id || !session.progress_chat_id) return;
    try {
      await deleteMessage(session.progress_chat_id, session.progress_message_id);
    } catch (err) {
      // ignore delete errors
    }
  }

  const photos = Array.isArray(session.photos) ? session.photos : [];
  // Determine generation type: trust state over generation_type column (state is always correct)
  const generationType =
    session.state === "processing_emotion" ? "emotion" : 
    session.state === "processing_motion" ? "motion" :
    session.state === "processing_text" ? "text" :
    session.generation_type || "style";

  const sourceFileId =
    generationType === "emotion" || generationType === "motion" || generationType === "text"
      ? session.last_sticker_file_id
      : session.current_photo_file_id || photos[photos.length - 1];

  // Debug logging for source file
  console.log("[Worker] Source file debug:", {
    generationType,
    sourceFileId: sourceFileId?.substring(0, 30) + "...",
    "session.current_photo_file_id": session.current_photo_file_id?.substring(0, 30) + "...",
    "session.last_sticker_file_id": session.last_sticker_file_id?.substring(0, 30) + "...",
    "photos.length": photos.length,
    "photos[last]": photos[photos.length - 1]?.substring(0, 30) + "...",
  });

  if (!sourceFileId) {
    throw new Error("No source file for generation");
  }

  await updateProgress(2);
  const filePath = await getFilePath(sourceFileId);
  const fileBuffer = await downloadFile(filePath);

  const base64 = fileBuffer.toString("base64");
  const mimeType = getMimeTypeByTelegramPath(filePath);
  const sourceKind: SubjectSourceKind =
    generationType === "emotion" || generationType === "motion" || generationType === "text"
      ? "sticker"
      : "photo";
  const lockEnabled = await isSubjectLockEnabled();
  let subjectProfile = getSessionSubjectProfileForSource(session, sourceFileId, sourceKind);
  if (!subjectProfile) {
    subjectProfile = await ensureSubjectProfileForSource(session, sourceFileId, sourceKind, fileBuffer, mimeType);
  }
  const promptForGeneration =
    lockEnabled && subjectProfile
      ? appendSubjectLock(session.prompt_final || "", buildSubjectLockBlock(subjectProfile))
      : (session.prompt_final || "");

  await updateProgress(3);
  console.log("Calling Gemini image generation...");
  console.log("generationType:", generationType);
  console.log("session.generation_type:", session.generation_type);
  console.log("session.state:", session.state);
  const promptChars = promptForGeneration.length;
  const promptTokensApprox = Math.ceil(promptChars / 4); // ~4 chars per token
  console.log("Full prompt length:", promptChars, "chars, ~", promptTokensApprox, "tokens (Gemini limit ~1M input tokens)");
  console.log("Full prompt:", promptForGeneration);
  console.log("text_prompt:", session.text_prompt);

  // Model selection from app_config (changeable at runtime via Supabase, cached 60s)
  const model = 
    generationType === "emotion" ? await getAppConfig("gemini_model_emotion", "gemini-2.5-flash-image") :
    generationType === "motion"  ? await getAppConfig("gemini_model_motion",  "gemini-2.5-flash-image") :
    await getAppConfig("gemini_model_style", "gemini-3-pro-image-preview");
  console.log("Using model:", model, "generationType:", generationType);

  const callGeminiImage = async (promptText: string) =>
    axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        contents: [
          {
            role: "user",
            parts: [
              { text: promptText },
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
          responseModalities: ["IMAGE", "TEXT"],
          imageConfig: { aspectRatio: "1:1" },
        },
      },
      {
        headers: { "x-goog-api-key": config.geminiApiKey },
      }
    );

  let geminiRes;
  try {
    geminiRes = await callGeminiImage(promptForGeneration);
  } catch (err: any) {
    const errorData = err.response?.data;
    const errorMessage = errorData?.error?.message || err.message || err.code || "Unknown error";
    const errorStatus = err.response?.status;
    
    console.error("=== Gemini API Error ===");
    console.error("Status:", errorStatus);
    console.error("Message:", errorMessage);
    console.error("Code:", err.code);
    console.error("Full response:", JSON.stringify(errorData || {}, null, 2));
    
    await sendAlert({
      type: "gemini_error",
      message: errorMessage,
      details: { 
        user: `@${user?.username || telegramId}`,
        sessionId: session.id, 
        generationType,
        styleGroup: session.selected_style_group || "-",
        styleId: session.selected_style_id || "-",
        userInput: (session.user_input || "").slice(0, 100),
        status: errorStatus,
        errorCode: err.code,
        errorData: JSON.stringify(errorData || {}).slice(0, 300),
      },
    });
    throw new Error(`Gemini API failed: ${errorMessage}`);
  }

  // Check for content moderation block
  const blockReason = geminiRes.data?.promptFeedback?.blockReason;
  if (blockReason) {
    console.error("Gemini blocked:", blockReason);
    await sendAlert({
      type: "generation_failed",
      message: `Gemini blocked: ${blockReason}`,
      details: { 
        user: `@${user?.username || telegramId}`,
        sessionId: session.id, 
        generationType,
        styleId: session.selected_style_id || "-",
        userInput: (session.user_input || "").slice(0, 100),
        blockReason,
      },
    });

    // Send user-friendly message with retry button and refund
    const lang = user?.lang || "en";
    const blockedMsg = lang === "ru"
      ? "⚠️ Не удалось обработать это фото в выбранном стиле.\n\nПопробуй другое фото или другой стиль.\nКредит возвращён на баланс."
      : "⚠️ Could not process this photo with the chosen style.\n\nTry a different photo or style.\nCredit has been refunded.";
    const retryBtnBlocked = lang === "ru" ? "🔄 Повторить" : "🔄 Retry";
    const retrySessionRef = Number.isInteger(Number(session.session_rev))
      ? `${session.id}:${session.session_rev}`
      : session.id;
    await sendMessage(telegramId, blockedMsg, {
      inline_keyboard: [[
        { text: retryBtnBlocked, callback_data: `retry_generation:${retrySessionRef}` },
      ]],
    });

    // Refund credits
    const creditsToRefund = session.credits_spent || 1;
    await supabase
      .from("users")
      .update({ credits: (user?.credits || 0) + creditsToRefund })
      .eq("id", session.user_id);

    // Mark job as done (not error — handled gracefully)
    return;
  }

  let imageBase64 =
    geminiRes.data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData?.data || null;
  let finalPromptUsed = promptForGeneration;

  if (!imageBase64) {
    console.error("Gemini response:", JSON.stringify(geminiRes.data, null, 2));
    const geminiText = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No text response";
    await sendAlert({
      type: "generation_failed",
      message: "Gemini returned no image",
      details: { 
        user: `@${user?.username || telegramId}`,
        sessionId: session.id, 
        generationType,
        styleGroup: session.selected_style_group || "-",
        styleId: session.selected_style_id || "-",
        userInput: (session.user_input || "").slice(0, 100),
        geminiResponse: geminiText.slice(0, 200),
      },
    });
    throw new Error("Gemini returned no image");
  }

  const postcheckEnabled = await isSubjectPostcheckEnabled();
  if (postcheckEnabled && subjectProfile?.subjectMode && subjectProfile.subjectMode !== "unknown") {
    const firstGeneratedBuffer = Buffer.from(imageBase64, "base64");
    const detected = await detectSubjectProfileFromImageBuffer(firstGeneratedBuffer, "image/png");
    const mismatch = isSubjectPostcheckMismatch(
      subjectProfile.subjectMode,
      detected.subjectMode,
      detected.subjectCount
    );

    if (mismatch) {
      console.warn("[subject-postcheck] mismatch detected, retrying once:", {
        sessionId: session.id,
        expectedMode: subjectProfile.subjectMode,
        detectedMode: detected.subjectMode,
        detectedCount: detected.subjectCount,
      });

      await sendAlert({
        type: "generation_failed",
        message: "Subject postcheck mismatch on first output, retrying",
        details: {
          user: `@${user?.username || telegramId}`,
          sessionId: session.id,
          expectedMode: subjectProfile.subjectMode,
          detectedMode: detected.subjectMode,
          detectedCount: detected.subjectCount ?? "-",
          generationType,
        },
      });

      const retryPrompt = `${promptForGeneration}\n\n[SUBJECT POSTCHECK RETRY]\nCRITICAL: Previous output had subject-count mismatch. Keep EXACT source subject count. Do NOT add or remove people.`;
      let retryRes: any;
      try {
        retryRes = await callGeminiImage(retryPrompt);
      } catch (retryErr: any) {
        const retryMsg = retryErr.response?.data?.error?.message || retryErr.message || "retry_failed";
        throw new Error(`Subject postcheck retry failed: ${retryMsg}`);
      }

      const retryBlockReason = retryRes.data?.promptFeedback?.blockReason;
      if (retryBlockReason) {
        throw new Error(`Subject postcheck retry blocked: ${retryBlockReason}`);
      }

      const retryImageBase64 =
        retryRes.data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData?.data || null;
      if (!retryImageBase64) {
        throw new Error("Subject postcheck retry returned no image");
      }

      const retryGeneratedBuffer = Buffer.from(retryImageBase64, "base64");
      const retryDetected = await detectSubjectProfileFromImageBuffer(retryGeneratedBuffer, "image/png");
      const retryMismatch = isSubjectPostcheckMismatch(
        subjectProfile.subjectMode,
        retryDetected.subjectMode,
        retryDetected.subjectCount
      );
      if (retryMismatch) {
        throw new Error(
          `Subject postcheck mismatch after retry: expected=${subjectProfile.subjectMode} actual=${retryDetected.subjectMode} count=${retryDetected.subjectCount ?? "null"}`
        );
      }

      imageBase64 = retryImageBase64;
      finalPromptUsed = retryPrompt;
      console.log("[subject-postcheck] retry accepted:", {
        sessionId: session.id,
        expectedMode: subjectProfile.subjectMode,
        detectedMode: retryDetected.subjectMode,
        detectedCount: retryDetected.subjectCount,
      });
    }
  }

  console.log("Image generated successfully");

  await updateProgress(4);
  const generatedBuffer = Buffer.from(imageBase64, "base64");

  await updateProgress(5);
  // ============================================================
  // Background removal — configurable primary service
  // app_config key: bg_removal_primary (prod) / bg_removal_primary_test (test)
  // Values: "rembg" | "pixian"
  // ============================================================
  const imageSizeKb = Math.round(generatedBuffer.length / 1024);
  const rembgUrl = process.env.REMBG_URL;
  const bgConfigKey = config.appEnv === "test" ? "bg_removal_primary_test" : "bg_removal_primary";
  const bgPrimary = await getAppConfig(bgConfigKey, "rembg");
  
  let noBgBuffer: Buffer | undefined;
  const startTime = Date.now();

  console.log(`[bgRemoval] Primary service: ${bgPrimary}, image size: ${imageSizeKb} KB`);

  if (bgPrimary === "pixian") {
    // Primary: Pixian, fallback: rembg
    noBgBuffer = await callPixian(generatedBuffer, imageSizeKb);
    if (!noBgBuffer) {
      console.log(`[bgRemoval] Pixian failed, falling back to rembg`);
      noBgBuffer = await callRembg(generatedBuffer, rembgUrl, imageSizeKb);
    }
  } else {
    // Primary: rembg, fallback: Pixian
    noBgBuffer = await callRembg(generatedBuffer, rembgUrl, imageSizeKb);
    if (!noBgBuffer) {
      console.log(`[bgRemoval] rembg failed, falling back to Pixian`);
      noBgBuffer = await callPixian(generatedBuffer, imageSizeKb);
    }
  }

  if (!noBgBuffer) {
    const duration = Date.now() - startTime;
    console.error("=== Background removal failed (all methods) ===");
    console.error("Duration:", duration, "ms");
    
    await sendAlert({
      type: "rembg_failed",
      message: `Background removal failed: all methods exhausted`,
      details: { 
        user: `@${user?.username || telegramId}`,
        sessionId: session.id,
        generationType,
        styleId: session.selected_style_id || "-",
        imageSizeKb,
        durationMs: duration,
        bgPrimary,
        rembgConfigured: !!rembgUrl,
      },
    });
    throw new Error(`Background removal failed: all methods exhausted`);
  }

  const bgDuration = Date.now() - startTime;
  console.log(`[bgRemoval] Total background removal took ${bgDuration}ms`);

  await updateProgress(6);

  // At this point noBgBuffer is guaranteed to be set (or we threw above)
  const cleanedBuffer = noBgBuffer!;

  // Safety padding: add 5% transparent border so trim never eats into character
  // (Gemini sometimes generates characters touching image edges)
  const meta = await sharp(cleanedBuffer).metadata();
  const safetyPad = Math.round(Math.max(meta.width || 0, meta.height || 0) * 0.05);
  const paddedBuffer = await sharp(cleanedBuffer)
    .extend({
      top: safetyPad, bottom: safetyPad, left: safetyPad, right: safetyPad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();

  // Trim transparent borders and fit into 512x512 with 15px padding
  const stickerBuffer = await sharp(paddedBuffer)
    .trim({ threshold: 2 })
    .resize(482, 482, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .extend({
      top: 15, bottom: 15, left: 15, right: 15,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: 95 })
    .toBuffer();

  await updateProgress(7);
  const filePathStorage = `stickers/${session.user_id}/${session.id}/${Date.now()}.webp`;

  // Insert sticker record first to get ID for callback_data
  // For all generation types, source_photo_file_id = sourceFileId:
  // - style: sourceFileId = original photo (AgAC)
  // - emotion/motion/text: sourceFileId = previous sticker (CAAC)
  const savedSourcePhotoFileId = sourceFileId;
  console.log("[Worker] Saving sticker with source_photo_file_id:", {
    generationType,
    savedSourcePhotoFileId: savedSourcePhotoFileId?.substring(0, 30) + "...",
    "session.current_photo_file_id": session.current_photo_file_id?.substring(0, 30) + "...",
    sourceFileId: sourceFileId?.substring(0, 30) + "...",
  });
  
  const timerLabel = (name: string) => `${name}:${job.id.substring(0, 8)}`;
  console.time(timerLabel("step7_insert"));
  // Determine idea_source from session (if sticker generated from pack idea)
  const ideaSource = (() => {
    if (session.pack_ideas?.length > 0 && session.generated_from_ideas?.length > 0) {
      const ideas = session.generated_from_ideas || [];
      return ideas[ideas.length - 1] || null;
    }
    return null;
  })();

  const { data: stickerRecord } = await supabase
    .from("stickers")
    .insert({
      user_id: session.user_id,
      session_id: session.id,
      source_photo_file_id: savedSourcePhotoFileId,
      user_input: session.user_input || null,
      generated_prompt: finalPromptUsed || null,
      result_storage_path: filePathStorage,
      sticker_set_name: user?.sticker_set_name || null,
      style_preset_id: session.selected_style_id || null,  // For style examples
      idea_source: ideaSource,
      env: config.appEnv,
    })
    .select("id")
    .single();
  console.timeEnd(timerLabel("step7_insert"));

  const stickerId = stickerRecord?.id;
  console.log("stickerId after insert:", stickerId);

  // Onboarding logic - determine UI based on onboarding_step
  // Skip hardcoded onboarding for assistant mode — AI handles the guidance
  // Skip for avatar_demo — it's a free preview, not a real generation
  const isAvatarDemo = generationType === "avatar_demo";
  const isAssistantMode = session.selected_style_id === "assistant";
  const onboardingStep = user.onboarding_step ?? 99;
  const isOnboardingFirstSticker = !isAssistantMode && !isAvatarDemo && onboardingStep === 0 && generationType === "style";
  const isOnboardingEmotion = !isAssistantMode && !isAvatarDemo && onboardingStep === 1 && generationType === "emotion";
  
  console.log("onboarding_step:", onboardingStep, "isOnboardingFirstSticker:", isOnboardingFirstSticker, "isOnboardingEmotion:", isOnboardingEmotion);

  const addToPackText = await getText(lang, "btn.add_to_pack");
  const changeEmotionText = await getText(lang, "btn.change_emotion");
  const changeMotionText = await getText(lang, "btn.change_motion");
  const addTextText = await getText(lang, "btn.add_text");
  const toggleBorderText = await getText(lang, "btn.toggle_border");
  const packIdeasText = lang === "ru" ? "💡 Идеи для пака" : "💡 Pack ideas";

  // Use sticker ID in callback_data for message binding
  const replyMarkup = {
    inline_keyboard: [
      [{ text: addToPackText, callback_data: stickerId ? `add_to_pack:${stickerId}` : "add_to_pack" }],
      [
        { text: changeEmotionText, callback_data: stickerId ? `change_emotion:${stickerId}` : "change_emotion" },
        { text: changeMotionText, callback_data: stickerId ? `change_motion:${stickerId}` : "change_motion" },
      ],
      [
        { text: toggleBorderText, callback_data: stickerId ? `toggle_border:${stickerId}` : "toggle_border" },
        { text: addTextText, callback_data: stickerId ? `add_text:${stickerId}` : "add_text" },
      ],
      [
        { text: packIdeasText, callback_data: stickerId ? `pack_ideas:${stickerId}` : "pack_ideas" },
      ],
    ],
  };

  // Send sticker with full button set (including first-time users)
  console.time(timerLabel("step7_sendSticker"));
  const stickerFileId = await sendSticker(telegramId, stickerBuffer, replyMarkup);
  console.timeEnd(timerLabel("step7_sendSticker"));

  // Update telegram_file_id IMMEDIATELY after sending (before user can click buttons)
  console.log("Updating sticker with telegram_file_id:", stickerId, "fileId:", stickerFileId?.substring(0, 30) + "...");
  if (stickerId && stickerFileId) {
    await supabase
      .from("stickers")
      .update({ telegram_file_id: stickerFileId })
      .eq("id", stickerId);
    console.log("sticker telegram_file_id updated successfully");
  } else {
    console.log(">>> WARNING: skipped telegram_file_id update, stickerId:", stickerId, "stickerFileId:", !!stickerFileId);
  }

  // Advance onboarding_step (for both assistant and manual mode)
  // Skip for avatar_demo — don't touch onboarding state
  if (!isAvatarDemo && onboardingStep < 2) {
    const newStep = Math.min(onboardingStep + 1, 2);
    await supabase
      .from("users")
      .update({ onboarding_step: newStep })
      .eq("id", session.user_id);
    console.log("onboarding_step updated to", newStep);
  }

  // Post-generation CTA: show after first sticker (both assistant and manual mode)
  // Only for style generation (not emotion/motion iterations)
  if (!isAvatarDemo && onboardingStep <= 1 && generationType === "style" && stickerId) {
    const onboardingText = lang === "ru"
      ? "👇 Попробуй прямо сейчас:\n😊 **Изменить эмоцию** — сделай грустного, злого, влюблённого\n🏃 **Добавить движение** — танец, прыжок, бег\n💡 **Идеи для пака** — AI подберёт идеи для целого стикерпака!"
      : "👇 Try it now:\n😊 **Change emotion** — make it sad, angry, in love\n🏃 **Add motion** — dance, jump, run\n💡 **Pack ideas** — AI will suggest ideas for a whole sticker pack!";
    
    await sendMessage(telegramId, onboardingText);
    console.log("post-generation CTA sent, onboardingStep:", onboardingStep);

    // Mark onboarding complete
    if (onboardingStep < 2) {
      await supabase
        .from("users")
        .update({ onboarding_step: 2 })
        .eq("id", session.user_id);
      console.log("onboarding_step updated to 2 (complete)");
    }
  }

  // Avatar demo: send action CTA + "send your own photo" prompt
  if (isAvatarDemo) {
    const ctaText = lang === "ru"
      ? "🎉 Вот что получилось!\n\n👇 Попробуй прямо сейчас:\n😊 **Изменить эмоцию** — сделай грустного, злого, влюблённого\n🏃 **Добавить движение** — танец, прыжок, бег\n💡 **Идеи для пака** — AI подберёт идеи для целого стикерпака!\n\n📸 Пришли своё фото — результат будет ещё лучше!"
      : "🎉 Here's what I got!\n\n👇 Try it now:\n😊 **Change emotion** — make it sad, angry, in love\n🏃 **Add motion** — dance, jump, run\n💡 **Pack ideas** — AI will suggest ideas for a whole sticker pack!\n\n📸 Send your own photo — the result will be even better!";
    await sendMessage(telegramId, ctaText);
    console.log("[AvatarDemo] CTA sent to user:", telegramId);
  }

  // Send sticker notification (async, non-blocking)
  const emotionText = session.selected_emotion || "-";
  const motionText = generationType === "motion" ? (session.selected_emotion || "-") : "-";
  const textText = session.text_prompt ? `"${session.text_prompt}"` : "-";
  
  sendNotification({
    type: "new_sticker",
    message: [
      `👤 @${user.username || telegramId} (${telegramId})`,
      `💰 Кредиты: ${user.credits}`,
      `🎨 Стиль: ${session.selected_style_id || "-"}`,
      `😊 Эмоция: ${emotionText}`,
      `🏃 Движение: ${motionText}`,
      `✍️ Текст: ${textText}`,
    ].join("\n"),
    sourceImageBuffer: fileBuffer,
    resultImageBuffer: stickerBuffer,
    stickerId: stickerId || undefined,  // For "Make example" button
    styleId: session.selected_style_id || undefined,
  }).catch(console.error);

  // Send rating request — DISABLED (temporarily, to reduce noise)
  const skipRating = true; // was: isOnboardingFirstSticker || isAvatarDemo;
  const ratingDelay = isOnboardingEmotion ? 30000 : 3000;  // 30s for onboarding, 3s normally
  if (stickerId && !skipRating) {
    setTimeout(async () => {
      try {
        // Create rating record
        const { data: ratingRecord } = await supabase
          .from("sticker_ratings")
          .insert({
            sticker_id: stickerId,
            session_id: session.id,
            user_id: session.user_id,
            telegram_id: telegramId,
            generation_type: generationType,
            style_id: session.selected_style_id,
            style_preset_id: session.selected_style_id || null,  // For analytics
            emotion_id: session.selected_emotion,
            prompt_final: session.prompt_final,
          })
          .select("id")
          .single();

        if (!ratingRecord?.id) {
          console.error("Failed to create rating record");
          return;
        }

        const ratingText = lang === "ru" 
          ? "Как вам результат? Оцените от 1 до 5:"
          : "How do you like it? Rate from 1 to 5:";
        
        const issueButtonText = lang === "ru"
          ? "💬 Написать о проблеме"
          : "💬 Report an issue";

        const supportUrl = `https://t.me/p2s_support_bot?start=issue_${stickerId}`;
        console.log("Rating buttons for sticker:", stickerId, "rating:", ratingRecord.id);
        console.log("Support URL:", supportUrl);
        
        const ratingMsg = await sendMessage(telegramId, ratingText, {
          inline_keyboard: [
            [
              { text: "⭐1", callback_data: `rate:${ratingRecord.id}:1` },
              { text: "⭐2", callback_data: `rate:${ratingRecord.id}:2` },
              { text: "⭐3", callback_data: `rate:${ratingRecord.id}:3` },
              { text: "⭐4", callback_data: `rate:${ratingRecord.id}:4` },
              { text: "⭐5", callback_data: `rate:${ratingRecord.id}:5` },
            ],
            [
              { text: issueButtonText, url: supportUrl }
            ]
          ]
        });

        // Save message_id for potential deletion
        if (ratingMsg?.message_id) {
          await supabase
            .from("sticker_ratings")
            .update({ message_id: ratingMsg.message_id, chat_id: telegramId })
            .eq("id", ratingRecord.id);
        }
        
        console.log("Rating request sent to", telegramId);
      } catch (err) {
        console.error("Failed to send rating request:", err);
      }
    }, ratingDelay);
  }

  await clearProgress();

  // Auto-show next pack idea if we were browsing ideas
  if (ideaSource && session.pack_ideas?.length > 0) {
    // Re-fetch session to get the latest current_idea_index
    // (index.ts updates it BEFORE creating the job, but worker reads session at job start — can be stale)
    const { data: freshSession } = await supabase
      .from("sessions")
      .select("current_idea_index, pack_ideas")
      .eq("id", session.id)
      .maybeSingle();
    const ideas = freshSession?.pack_ideas || session.pack_ideas;
    const nextIndex = freshSession?.current_idea_index ?? session.current_idea_index ?? 0;
    console.log(`[Worker] Next idea: fresh_index=${freshSession?.current_idea_index}, stale_index=${session.current_idea_index}, using=${nextIndex}`);
    if (nextIndex < ideas.length) {
      const idea = ideas[nextIndex];
      const title = lang === "ru" ? idea.titleRu : idea.titleEn;
      const desc = lang === "ru" ? idea.descriptionRu : idea.descriptionEn;
      const textHint = idea.hasText && idea.textSuggestion
        ? `\n✏️ ${lang === "ru" ? "Текст" : "Text"}: "${idea.textSuggestion}"`
        : "";
      const text = `💡 ${lang === "ru" ? "Идея" : "Idea"} ${nextIndex + 1}/${ideas.length}\n\n`
        + `${idea.emoji} <b>${title}</b>\n`
        + `${desc}${textHint}`;

      const generateText = lang === "ru" ? "🎨 Сгенерить (1💎)" : "🎨 Generate (1💎)";
      const nextText = lang === "ru" ? "➡️ Следующая" : "➡️ Next";
      const doneText = lang === "ru" ? "✅ Хватит" : "✅ Done";

      try {
        await sendMessage(telegramId, text, {
          inline_keyboard: [
            [
              { text: generateText, callback_data: `idea_generate:${nextIndex}` },
              { text: nextText, callback_data: "idea_next" },
            ],
            [{ text: doneText, callback_data: "idea_done" }],
          ],
        });
      } catch (err) {
        console.error("[Worker] Failed to show next idea:", err);
      }
    } else {
      // All ideas exhausted
      const generated = ideas.filter((i: any) => i.generated).length;
      const allDoneText = lang === "ru"
        ? `🎉 Все ${ideas.length} идей показаны!\nСгенерировано: ${generated} из ${ideas.length}`
        : `🎉 All ${ideas.length} ideas shown!\nGenerated: ${generated} of ${ideas.length}`;
      try {
        await sendMessage(telegramId, allDoneText, {
          inline_keyboard: [
            [{ text: lang === "ru" ? "🔄 Новые идеи" : "🔄 More ideas", callback_data: "idea_more" }],
            [{ text: lang === "ru" ? "📷 Новое фото" : "📷 New photo", callback_data: "new_photo" }],
          ],
        });
      } catch (err) {
        console.error("[Worker] Failed to show all-done:", err);
      }
    }
  }

  // Upload to storage in background (non-critical, can be slow)
  console.time(timerLabel("step7_upload"));
  supabase.storage
    .from(config.supabaseStorageBucket)
    .upload(filePathStorage, stickerBuffer, { contentType: "image/webp", upsert: true })
    .then(() => console.timeEnd(timerLabel("step7_upload")))
    .catch((err) => {
      console.timeEnd(timerLabel("step7_upload"));
      console.error("Storage upload failed:", err);
    });

  const nextState = "confirm_sticker";

  await supabase
    .from("sessions")
    .update({
      state: nextState,
      is_active: true,
      last_sticker_file_id: stickerFileId,
      last_sticker_storage_path: filePathStorage,
      progress_message_id: null,
      progress_chat_id: null,
    })
    .eq("id", session.id);
}

async function poll() {
  while (true) {
    // Atomic job claim using PostgreSQL FOR UPDATE SKIP LOCKED
    const { data: jobs, error } = await supabase.rpc("claim_job", {
      p_worker_id: WORKER_ID,
      p_env: config.appEnv,
    });

    if (error) {
      console.error("Error claiming job:", error.message);
      await sleep(config.jobPollIntervalMs);
      continue;
    }

    const job = jobs?.[0];
    if (!job) {
      await sleep(config.jobPollIntervalMs);
      continue;
    }

    console.log(`Job ${job.id} claimed by ${WORKER_ID}`);

    try {
      await runJob(job);
      await supabase
        .from("jobs")
        .update({ status: "done", completed_at: new Date().toISOString() })
        .eq("id", job.id);
    } catch (err: any) {
      console.error("Job failed:", job.id, err?.message || err);

      await supabase
        .from("jobs")
        .update({
          status: "error",
          error: String(err?.message || err),
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      // Refund credits on error (skip for pack jobs — they handle their own refunds)
      if (job.pack_batch_id) {
        console.log("[Poll] Pack job error handled internally, skipping generic refund");
        continue;
      }
      try {
        const { data: session } = await supabase
          .from("sessions")
          .select("user_id, photos, credits_spent, session_rev")
          .eq("id", job.session_id)
          .maybeSingle();

        if (session?.user_id) {
          const creditsToRefund = session.credits_spent || 1;

          const { data: refundUser } = await supabase
            .from("users")
            .select("credits, telegram_id, lang")
            .eq("id", session.user_id)
            .maybeSingle();

          if (refundUser) {
            // Refund credits
            await supabase
              .from("users")
              .update({ credits: (refundUser.credits || 0) + creditsToRefund })
              .eq("id", session.user_id);

            // Notify user with retry button
            if (refundUser.telegram_id) {
              const rlang = refundUser.lang || "en";
              const errorText = rlang === "ru"
                ? "❌ Произошла ошибка при генерации стикера.\n\nКредиты возвращены на баланс."
                : "❌ An error occurred during sticker generation.\n\nCredits have been refunded.";
              const retryBtn = rlang === "ru" ? "🔄 Повторить" : "🔄 Retry";
              const retrySessionRef = Number.isInteger(Number(session.session_rev))
                ? `${job.session_id}:${session.session_rev}`
                : job.session_id;
              await sendMessage(refundUser.telegram_id, errorText, {
                inline_keyboard: [[
                  { text: retryBtn, callback_data: `retry_generation:${retrySessionRef}` },
                ]],
              });
            }
          }
        }
      } catch (refundErr) {
        console.error("Failed to refund credits:", refundErr);
      }
    }
  }
}

// Handle uncaught exceptions
process.on("uncaughtException", async (err) => {
  console.error("Uncaught exception:", err);
  await sendAlert({
    type: "worker_error",
    message: err.message,
    stack: err.stack,
    details: { workerId: WORKER_ID },
  });
  process.exit(1);
});

process.on("unhandledRejection", async (reason: any) => {
  console.error("Unhandled rejection:", reason);
  await sendAlert({
    type: "worker_error",
    message: reason?.message || String(reason),
    stack: reason?.stack,
    details: { workerId: WORKER_ID },
  });
});

poll().catch(async (e) => {
  console.error(e);
  await sendAlert({
    type: "worker_error",
    message: e?.message || String(e),
    stack: e?.stack,
    details: { workerId: WORKER_ID },
  });
  process.exit(1);
});
