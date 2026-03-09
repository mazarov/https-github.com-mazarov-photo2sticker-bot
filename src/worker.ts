import axios from "axios";
import os from "os";
import FormData from "form-data";
import sharp from "sharp";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { config } from "./config";
import { supabase } from "./lib/supabase";
import { getFilePath, downloadFile, sendMessage, sendSticker, sendPhoto, editMessageText, deleteMessage, getMe } from "./lib/telegram";
import { getText } from "./lib/texts";
import { sendAlert, sendNotification, sendPackPreviewAlert, sendPackCompletedLandingAlert } from "./lib/alerts";
// chromaKey logic removed — rembg handles background removal directly
import { getAppConfig } from "./lib/app-config";
import { getGeminiGenerateContentUrlRuntime, getGeminiRouteInfoRuntime } from "./lib/gemini-route";
import { addTextToSticker, fitStickerIn512WithMargin, addWhiteBorder } from "./lib/image-utils";
import { createFaceSwapTask, waitForFaceSwapTask } from "./lib/facemint";
import {
  appendSubjectLock,
  buildSubjectLockBlock,
  detectSubjectProfileFromImageBuffer,
  getSubjectWordForPrompt,
  parseBooleanConfig,
  isSubjectLockEnabled,
  isSubjectModePackFilterEnabled,
  isSubjectPostcheckEnabled,
  isSubjectProfileEnabled,
  resolveGenerationSource,
  normalizeSubjectAgeGroup,
  normalizeSubjectMode,
  normalizeSubjectGender,
  normalizeSubjectSourceKind,
  type SubjectAgeProfile,
  type SubjectProfile,
  type SubjectSourceKind,
} from "./lib/subject-profile";

void getGeminiRouteInfoRuntime()
  .then((route) => console.log("[GeminiRoute][Worker]", route))
  .catch((err) => console.warn("[GeminiRoute][Worker] route resolve failed:", err?.message || err));

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

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function isConfigEnabled(value: string | null | undefined): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return false;

  // Support plain text values: true/false/1/0/yes/no.
  const normalized = raw.toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;

  // Support quoted/json values in app_config: "true", "false", true, false.
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "boolean") return parsed;
    if (typeof parsed === "number") return parsed !== 0;
    if (typeof parsed === "string") {
      const v = parsed.trim().toLowerCase();
      return ["true", "1", "yes", "y", "on"].includes(v);
    }
  } catch {
    // Not JSON — fall back to strict false.
  }

  return false;
}

/** Supabase Storage 500 / fetch failed / timeout — retry once after delay. */
function isTransientStorageError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const msg = String((e as { message?: string }).message ?? e);
  const code = (e as { code?: number; status?: number }).code ?? (e as { code?: number; status?: number }).status;
  return code === 500 || /fetch failed|timeout|ECONNRESET|ETIMEDOUT/i.test(msg);
}

/** Facemint needs publicly accessible URLs. Bucket stickers is private — use stickers-examples (public) for temp uploads. */

async function uploadBufferForFacemint(
  buffer: Buffer,
  storagePath: string,
  contentType: string
): Promise<string> {
  const bucket = config.supabaseStorageBucketExamples || "stickers-examples";
  const upload = () =>
    supabase.storage
      .from(bucket)
      .upload(storagePath, buffer, { contentType, upsert: true });

  let { error } = await upload();
  if (error && isTransientStorageError(error)) {
    await sleep(2000);
    const retry = await upload();
    error = retry.error;
  }
  if (error) {
    throw new Error(`Facemint input upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  if (!data?.publicUrl) {
    throw new Error("Facemint input upload failed: public URL is empty");
  }
  const publicUrl = config.supabasePublicStorageUrl
    ? data.publicUrl.replace(config.supabaseUrl, config.supabasePublicStorageUrl)
    : data.publicUrl;
  return publicUrl;
}

async function uploadTempStickerSourceAndGetPublicUrl(
  buffer: Buffer,
  session: any,
  sourceFileId: string,
  mimeType: string
): Promise<{ publicUrl: string; storagePath: string; bucket: string }> {
  const bucket = config.supabaseStorageBucketExamples || "stickers-examples";
  const ext = mimeType.includes("png") ? "png" : mimeType.includes("jpeg") ? "jpg" : "webp";
  const fileSafeId = String(sourceFileId || "source").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  const storagePath = `temp/sticker-sources/${session.user_id}/${session.id}/${Date.now()}_${fileSafeId}.${ext}`;
  const upload = () =>
    supabase.storage
      .from(bucket)
      .upload(storagePath, buffer, { contentType: mimeType || "image/webp", upsert: true });

  let { error } = await upload();
  if (error && isTransientStorageError(error)) {
    await sleep(2000);
    const retry = await upload();
    error = retry.error;
  }
  if (error) {
    throw new Error(`Temp sticker source upload failed: ${error.message}`);
  }
  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  if (!data?.publicUrl) {
    throw new Error("Temp sticker source upload failed: public URL is empty");
  }
  const publicUrl = config.supabasePublicStorageUrl
    ? data.publicUrl.replace(config.supabaseUrl, config.supabasePublicStorageUrl)
    : data.publicUrl;
  return { publicUrl, storagePath, bucket };
}

async function resolveStickerSourceUrl(
  session: any,
  sourceFileId: string,
  fileBuffer: Buffer,
  mimeType: string,
  telegramFallbackUrl: string
): Promise<{ sourceFileUrl: string; transport: "storage-result" | "storage-temp" | "telegram-fallback"; storagePath?: string | null }> {
  try {
    const { data: stickerRow } = await supabase
      .from("stickers")
      .select("result_storage_path")
      .eq("user_id", session.user_id)
      .eq("telegram_file_id", sourceFileId)
      .eq("env", config.appEnv)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const resultStoragePath = stickerRow?.result_storage_path || null;
    if (resultStoragePath) {
      const { data } = supabase.storage
        .from(config.supabaseStorageBucket)
        .getPublicUrl(resultStoragePath);
      if (data?.publicUrl) {
        const publicUrl = config.supabasePublicStorageUrl
          ? data.publicUrl.replace(config.supabaseUrl, config.supabasePublicStorageUrl)
          : data.publicUrl;
        return { sourceFileUrl: publicUrl, transport: "storage-result", storagePath: resultStoragePath };
      }
    }
  } catch (err: any) {
    console.warn("[Worker] resolveStickerSourceUrl: failed to load result_storage_path, fallback to temp upload:", err?.message || err);
  }

  try {
    const temp = await uploadTempStickerSourceAndGetPublicUrl(fileBuffer, session, sourceFileId, mimeType);
    return { sourceFileUrl: temp.publicUrl, transport: "storage-temp", storagePath: temp.storagePath };
  } catch (err: any) {
    console.warn("[Worker] resolveStickerSourceUrl: temp upload failed, fallback to telegram URL:", err?.message || err);
  }

  return { sourceFileUrl: telegramFallbackUrl, transport: "telegram-fallback", storagePath: null };
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

async function waitForPublicUrlReady(
  publicUrl: string,
  label: string,
  options: { maxAttempts?: number; baseDelayMs?: number } = {}
): Promise<boolean> {
  const { maxAttempts = 3, baseDelayMs = 350 } = options;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await axios.get(publicUrl, {
        timeout: 4000,
        responseType: "arraybuffer",
        headers: { Range: "bytes=0-0" },
        validateStatus: () => true,
      });
      const ok = res.status >= 200 && res.status < 400;
      if (ok) {
        if (attempt > 1) {
          console.log("[public-url-ready] recovered", { label, attempt, status: res.status, publicUrl });
        }
        return true;
      }
      console.warn("[public-url-ready] non-2xx/3xx", { label, attempt, status: res.status, publicUrl });
    } catch (err: any) {
      console.warn("[public-url-ready] request failed", {
        label,
        attempt,
        message: err?.message || err,
        publicUrl,
      });
    }

    if (attempt < maxAttempts) {
      const delay = baseDelayMs * attempt;
      await sleep(delay);
    }
  }
  return false;
}

function getRetryReadyState(generationType?: string | null): string {
  if (generationType === "emotion") return "wait_emotion";
  if (generationType === "motion") return "wait_motion";
  if (generationType === "text") return "wait_text_overlay";
  if (generationType === "replace_subject") return "wait_edit_action";
  return "wait_style";
}

const WORKER_ID = `${os.hostname()}-${process.pid}-${Date.now()}`;
console.log(`Worker started: ${WORKER_ID}`);
console.log("[Build][Worker] git_sha:", resolveRuntimeGitSha(), "app_env:", config.appEnv);
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

type RenderMode = "stylize" | "photoreal";

function normalizeRenderMode(value: unknown): RenderMode {
  return String(value || "").trim().toLowerCase() === "photoreal" ? "photoreal" : "stylize";
}

function buildRenderModePolicy(mode: RenderMode, options?: { includeTransferLine?: boolean }): string {
  if (mode === "photoreal") {
    return `[RENDER MODE: PHOTOREAL]
Keep photorealistic rendering.
Do NOT convert to illustration, cartoon, anime, manga, manhwa, chibi, 3D toon, or painterly style.
Preserve natural skin texture, realistic lighting, camera-like details, and photo-like material appearance.`;
  }
  const transferLine = options?.includeTransferLine
    ? "Apply STRONG style transfer to the target style.\n"
    : "";
  const stylizeCore = options?.includeTransferLine
    ? "Keep identity (facial features/person) but DO NOT preserve source artistic rendering.\nRe-render the image fully in the target style language (linework, shading, proportions, color treatment)."
    : "Keep identity (facial features/person).";
  return `[RENDER MODE: STYLIZE]
${transferLine}${stylizeCore}`;
}

function applyRenderModePolicy(prompt: string, mode: RenderMode, options?: { includeTransferLine?: boolean }): string {
  const cleanPrompt = String(prompt || "").trim();
  if (/\[RENDER MODE:\s*(PHOTOREAL|STYLIZE)\]/i.test(cleanPrompt)) {
    return cleanPrompt;
  }
  const policy = buildRenderModePolicy(mode, options);
  return cleanPrompt ? `${policy}\n\n${cleanPrompt}` : policy;
}

function applyStyleChildIdentityRule(prompt: string, variant: "default_identity" | "child_pose_only"): string {
  const source = String(prompt || "");
  if (variant === "child_pose_only") {
    return source
      .replace(/Keep identity \(facial features\/person\)\.?/gi, "Use the image only as a reference for pose and general appearance.\nDo not replicate the exact identity of the person.")
      .replace(
        /Keep identity \(facial features\/person\) but DO NOT preserve source artistic rendering\./gi,
        "Use the image only as a reference for pose and general appearance.\nDo not replicate the exact identity of the person.\nDO NOT preserve source artistic rendering."
      );
  }
  return source;
}

async function getStyleRenderMode(styleId?: string | null): Promise<RenderMode | null> {
  if (!styleId) return null;
  const { data, error } = await supabase
    .from("style_presets_v2")
    .select("render_mode")
    .eq("id", styleId)
    .maybeSingle();
  if (error) {
    const unknownColumn =
      error.code === "42703" ||
      /column .*render_mode/.test(String(error.message || "").toLowerCase());
    if (!unknownColumn) {
      console.warn("[style.render_mode] failed to fetch render_mode:", error.message);
    }
    return null;
  }
  return normalizeRenderMode((data as any)?.render_mode);
}

function extractGeminiImageBase64(responseData: any): string | null {
  const candidates = Array.isArray(responseData?.candidates) ? responseData.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const data = part?.inlineData?.data;
      if (typeof data === "string" && data.length > 0) return data;
    }
  }
  return null;
}

function sha256Hex(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function logLongValue(tag: string, value: string, chunkSize = 900): void {
  const text = String(value ?? "");
  if (!text) {
    console.log(`${tag}: <empty>`);
    return;
  }
  const total = Math.ceil(text.length / chunkSize);
  for (let i = 0; i < total; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, text.length);
    const part = text.slice(start, end);
    console.log(`${tag} [part ${i + 1}/${total}]`, part);
  }
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

function getSessionSubjectAgeProfileForSource(
  session: any,
  sourceFileId: string,
  sourceKind: SubjectSourceKind
): SubjectAgeProfile | null {
  const sessionSourceId = session?.subject_age_source_file_id || null;
  const sessionSourceKind = normalizeSubjectSourceKind(session?.subject_age_source_kind);
  if (!sessionSourceId || sessionSourceId !== sourceFileId || sessionSourceKind !== sourceKind) {
    return null;
  }
  const parsedConfidence = Number(session?.subject_age_confidence);
  return {
    subjectAgeGroup: normalizeSubjectAgeGroup(session?.subject_age_group),
    subjectAgeConfidence:
      Number.isFinite(parsedConfidence) && parsedConfidence >= 0
        ? Math.max(0, Math.min(1, Number(parsedConfidence.toFixed(3))))
        : null,
    sourceFileId,
    sourceKind,
    detectedAt: session?.subject_age_detected_at || new Date().toISOString(),
  };
}

async function isChildIdentityProtectionEnabled(): Promise<boolean> {
  const value = await getAppConfig("child_identity_protection_enabled", "false");
  return parseBooleanConfig(value);
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
    subject_age_group: (profile as any).subjectAgeGroup ?? "unknown",
    subject_age_confidence: (profile as any).subjectAgeConfidence ?? null,
    subject_age_source_file_id: profile.sourceFileId,
    subject_age_source_kind: profile.sourceKind,
    subject_age_detected_at: detectedAt,
  };

  const { error } = await supabase.from("sessions").update(payload).eq("id", sessionId);
  if (!error) return;

  const unknownColumn =
    error.code === "42703" ||
    /column .*(object_|subject_gender|object_gender|subject_age_)/.test(String(error.message || "").toLowerCase());
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
  sourceMime: string,
  sourceFileUrl?: string | null
): Promise<SubjectProfile | null> {
  const profileEnabled = await isSubjectProfileEnabled();
  const childIdentityEnabled = await isChildIdentityProtectionEnabled();
  if (!profileEnabled && !childIdentityEnabled) return null;

  const existing = getSessionSubjectProfileForSource(session, sourceFileId, sourceKind);
  if (existing) return existing;

  const detectedAt = new Date().toISOString();
  const detectorModel = await getAppConfig("gemini_model_subject_detector", "gemini-2.0-flash");
  console.log("[subject-profile] detector model:", detectorModel, {
    sessionId: session.id,
    sourceKind,
    sourceFileId: sourceFileId.substring(0, 30) + "...",
  });
  const detected = await detectSubjectProfileFromImageBuffer(sourceBuffer, sourceMime, sourceFileUrl || null);

  const nextProfile: SubjectProfile = {
    subjectMode: detected.subjectMode,
    subjectCount: detected.subjectCount,
    subjectConfidence: detected.subjectConfidence,
    subjectGender: detected.subjectGender ?? null,
    subjectAgeGroup: detected.subjectAgeGroup,
    subjectAgeConfidence: detected.subjectAgeConfidence,
    sourceFileId,
    sourceKind,
    detectedAt,
  } as SubjectProfile;

  await persistSubjectAndObjectProfile(session.id, nextProfile, detectedAt);

  Object.assign(session, {
    subject_mode: nextProfile.subjectMode,
    subject_count: nextProfile.subjectCount,
    subject_confidence: nextProfile.subjectConfidence,
    subject_gender: nextProfile.subjectGender ?? null,
    subject_age_group: (nextProfile as any).subjectAgeGroup,
    subject_age_confidence: (nextProfile as any).subjectAgeConfidence ?? null,
    subject_age_source_file_id: nextProfile.sourceFileId,
    subject_age_source_kind: nextProfile.sourceKind,
    subject_age_detected_at: nextProfile.detectedAt,
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
    subjectAgeGroup: (nextProfile as any).subjectAgeGroup,
    subjectAgeConfidence: (nextProfile as any).subjectAgeConfidence,
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
      subjectAgeGroup: (nextProfile as any).subjectAgeGroup ?? "unknown",
      subjectAgeConfidence: (nextProfile as any).subjectAgeConfidence ?? "-",
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
      .from(config.packContentSetsTable)
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
      .from(config.packContentSetsTable)
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
      .from(config.packContentSetsTable)
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
  const selectedStyleRenderMode = await getStyleRenderMode(session.selected_style_id || null);
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
  let photoFileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
  const photoMime = getMimeTypeByTelegramPath(filePath);
  const packGeminiRoute = await getGeminiRouteInfoRuntime();
  const packNeedsPublicSourceUrl = !packGeminiRoute.viaProxy;
  if (packNeedsPublicSourceUrl) {
    try {
      const temp = await uploadTempStickerSourceAndGetPublicUrl(photoBuffer, session, photoFileId, photoMime);
      photoFileUrl = temp.publicUrl;
      console.log("[PackPreview] Using temp public photo URL for direct Gemini route:", {
        storagePath: temp.storagePath,
        bucket: temp.bucket,
      });
    } catch (err: any) {
      console.warn("[PackPreview] Failed to upload temp photo source, fallback to Telegram URL:", err?.message || err);
    }
  }

  const lockEnabled = await isSubjectLockEnabled();
  let packSubjectProfile = getSessionSubjectProfileForSource(session, photoFileId, "photo");
  if (!packSubjectProfile) {
    packSubjectProfile = await ensureSubjectProfileForSource(
      session,
      photoFileId,
      "photo",
      photoBuffer,
      photoMime,
      photoFileUrl
    );
  }
  // Pack: one-character rule only in CRITICAL RULES FOR THE GRID; no SUBJECT LOCK block at start.
  const subjectLockBlock = "";
  let styleBlockWithSubject = styleBlock;
  // For photo-realistic style: avoid "illustration" so the model outputs a photo, not a drawing
  const isPhotoRealisticStyle =
    selectedStyleRenderMode === "photoreal" ||
    session.selected_style_id === "photo_realistic" ||
    /\bphoto-realistic\b|photo_realistic/i.test(styleBlock);
  if (isPhotoRealisticStyle) {
    styleBlockWithSubject = styleBlockWithSubject.replace(
      /\bcharacter illustration\b/gi,
      "photographic image"
    );
    if (!/output must be a photograph|must be a photo\b/i.test(styleBlockWithSubject)) {
      styleBlockWithSubject +=
        "\n\nOutput MUST be a photograph, not a drawing, illustration, or stylized art.";
    }
  }
  if (selectedStyleRenderMode) {
    styleBlockWithSubject = applyRenderModePolicy(styleBlockWithSubject, selectedStyleRenderMode);
  }
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
  let collageFileUrl: string | null = null;
  let collageMime = "image/png";
  if (template.collage_file_id || template.collage_url) {
    try {
      if (template.collage_file_id) {
        const collagePath = await getFilePath(template.collage_file_id);
        collageMime = getMimeTypeByTelegramPath(collagePath);
        if (packNeedsPublicSourceUrl) {
          const collageBuffer = await downloadFile(collagePath);
          const temp = await uploadTempStickerSourceAndGetPublicUrl(
            collageBuffer,
            session,
            template.collage_file_id,
            collageMime
          );
          collageFileUrl = temp.publicUrl;
          console.log("[PackPreview] Using temp public collage URL for direct Gemini route:", {
            storagePath: temp.storagePath,
            bucket: temp.bucket,
          });
        } else {
          collageFileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${collagePath}`;
        }
      } else {
        collageFileUrl = template.collage_url;
        collageMime = template.collage_url?.endsWith(".png") ? "image/png" : "image/jpeg";
      }
      console.log("[PackPreview] Collage reference ready:", {
        hasUrl: Boolean(collageFileUrl),
        mime: collageMime,
      });
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
  // Pack-only task: grid layout, scenes, format rules. Style + composition = styleBlock (same as single sticker).
  const packTaskBlock = `[TASK — PACK GRID ONLY]
Create a ${cols}x${rows} grid of images (${stickerCount} cells total).
Each cell = ONE image with a DISTINCT pose/emotion from the list below.

Scenes (one per cell, left-to-right, top-to-bottom):
${sceneList}

GAZE DIRECTION (MANDATORY): Each scene description may specify where the character is looking (e.g. "gaze at camera", "direct gaze at camera", "looking down", "eyes to the left"). You MUST follow the gaze direction specified in each scene. If a scene says "gaze at camera" or "eyes open, direct gaze at camera", that cell MUST show the character looking directly at the viewer/camera — do not substitute averted or downcast gaze. If a scene says "eyes closed", only that cell may have closed eyes. This is critical for sticker pack engagement.


CRITICAL RULES FOR THE GRID:
The character(s) must look EXACTLY like the person(s) in the reference photo.
${selectedStylePromptHint ? `0. STYLE (apply in every cell): ${selectedStylePromptHint}\n` : ""}1. Do NOT draw any outline, border, stroke, or contour around the character(s). Raw clean edges only — the image will be background-removed; hand-drawn outlines get damaged. No sticker-style borders, white outlines, or decorative edges.
2. Background MUST be flat uniform BRIGHT MAGENTA (#FF00FF) in EVERY cell. Any objects in the scene (fridge, furniture, props) must be on this same flat background — no walls, no room interior, no extra environment behind objects.
3. Each character must be fully visible within its cell with nothing cropped. Hands, arms, fingers, and wrists must be FULLY inside the cell with clear margin — never crop at wrists or hands. If a pose would extend limbs past the cell edge, draw the character smaller or choose a pose that keeps all limbs inside.
4. MANDATORY PADDING: The character must be SURROUNDED by visible magenta background on EVERY side — TOP, BOTTOM, LEFT, RIGHT. Leave at least 15% empty space (margin) on ALL four edges. The BOTTOM must have the same margin as the top — do NOT push the subject, blanket, or props to the bottom edge. For raised arms or wide gestures use 20% or more. Tight framing with no margin on any side breaks background removal.
5. SEAMLESS GRID: The image must be one continuous surface — magenta background flows from cell to cell with NO visible division. Do NOT draw white lines, grid lines, stripes, or any separator between the ${stickerCount} images. We split the image programmatically; you must not add any marking or line between cells.
6. LIKENESS: In EVERY cell — EYE COLOR must match the reference EXACTLY (same hue and intensity). Preserve freckles, moles, beauty marks, birthmarks, face shape, skin tone. Do NOT change eye color or omit distinctive features that appear in the reference.
7. Style must be IDENTICAL across all cells — same art style, proportions, colors.
8. Do NOT add any text, labels, or captions in the cells. Text will be added programmatically later.
9. FRAMING: All characters CHEST-UP (mid-torso to head). Head ~35–45% of cell height. Camera distance slightly closer than natural. Do NOT leave excessive "air" above the head; subject must dominate the frame while respecting padding. No full-body unless the pose requires it.
10. EXPRESSION: Realistic and subtle. No exaggerated facial muscles, cartoon emotions, or staged poses. Emotion intensity ~60–70% of maximum. Character caught mid-action, not posing for a photo. Consistent camera distance across all cells.`;

  const hasCollage = !!collageFileUrl;
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
  if (collageFileUrl) {
    imageParts.push({ fileData: { mimeType: collageMime, fileUri: collageFileUrl } });
  }
  imageParts.push({ fileData: { mimeType: photoMime, fileUri: photoFileUrl } });

  // Call Gemini (model and output resolution from app_config)
  const model = await getAppConfig("gemini_model_pack", "gemini-2.5-flash-image");
  const imageSize = await getAppConfig("gemini_image_size_pack", "1K");
  console.log("[PackPreview] Using model:", model, "imageSize:", imageSize);

  let geminiRes: any = null;
  let lastErrorMsg = "";
  try {
    geminiRes = await axios.post(
      await getGeminiGenerateContentUrlRuntime(model),
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
  } catch (err: any) {
    lastErrorMsg = err.response?.data?.error?.message || err.message;
    const status = err.response?.status;
    const apiError = err.response?.data?.error;
    console.error("[PackPreview] Gemini error:", lastErrorMsg, status ? `[HTTP ${status}]` : "", apiError ? JSON.stringify(apiError) : "");
  }

  if (!geminiRes) {
    const errorMsg = lastErrorMsg || "Unknown error";
    console.error("[PackPreview] Gemini request failed");

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
  let imageBase64 = extractGeminiImageBase64(geminiRes.data);
  if (!imageBase64) {
    const finishReason = geminiRes.data?.candidates?.[0]?.finishReason || "unknown";
    console.warn("[PackPreview] Gemini returned no image. finishReason:", finishReason);
  }
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
      .from(config.packContentSetsTable)
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
      .from(config.packContentSetsTable)
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
      .from(config.packContentSetsTable)
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
  const isSingleFlowGeneration =
    !job.pack_batch_id
    && session?.flow_kind !== "pack"
    && !String(session?.state || "").startsWith("wait_pack_")
    && !["generating_pack_preview", "generating_pack_theme", "processing_pack"].includes(String(session?.state || ""));
  const singleTrace = {
    jobId: job?.id,
    sessionId: session?.id,
    userId: session?.user_id,
    generationType,
    flowKind: session?.flow_kind || "unknown",
    state: session?.state || null,
  };
  if (isSingleFlowGeneration) {
    console.log("[single.gen.worker] job_start", singleTrace);
  }

  const { sourceFileId, sourceKind } = resolveGenerationSource(session, generationType);

  // Debug logging for source file
  console.log("[Worker] Source file debug:", {
    generationType,
    sourceFileId: sourceFileId?.substring(0, 30) + "...",
    styleSourceKind: session.style_source_kind || "photo(default)",
    resolvedSourceKind: sourceKind,
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
  const telegramSourceFileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
  const geminiRoute = await getGeminiRouteInfoRuntime();
  const needsPublicSourceUrl = !geminiRoute.viaProxy;

  const base64 = fileBuffer.toString("base64");
  const mimeType = getMimeTypeByTelegramPath(filePath);
  const sourceSha256 = sha256Hex(fileBuffer);
  let resolvedSource:
    { sourceFileUrl: string; transport: "storage-result" | "storage-temp" | "telegram-fallback"; storagePath?: string | null };
  if (needsPublicSourceUrl) {
    try {
      const temp = await uploadTempStickerSourceAndGetPublicUrl(fileBuffer, session, sourceFileId, mimeType);
      resolvedSource = {
        sourceFileUrl: temp.publicUrl,
        transport: "storage-temp",
        storagePath: temp.storagePath,
      };
    } catch (err: any) {
      console.warn("[Worker] direct Gemini route: temp source upload failed, fallback to default source resolver:", err?.message || err);
      resolvedSource =
        sourceKind === "sticker"
          ? await resolveStickerSourceUrl(session, sourceFileId, fileBuffer, mimeType, telegramSourceFileUrl)
          : { sourceFileUrl: telegramSourceFileUrl, transport: "telegram-fallback", storagePath: null };
    }
  } else {
    resolvedSource =
      sourceKind === "sticker"
        ? await resolveStickerSourceUrl(session, sourceFileId, fileBuffer, mimeType, telegramSourceFileUrl)
        : { sourceFileUrl: telegramSourceFileUrl, transport: "telegram-fallback", storagePath: null };
  }
  let sourceFileUrl = resolvedSource.sourceFileUrl;
  console.log("[Worker] source_file_url_resolved:", {
    generationType,
    sourceKind,
    transport: resolvedSource.transport,
    storagePath: resolvedSource.storagePath || null,
    sourceFileId: sourceFileId.substring(0, 30) + "...",
    sourceFileUrl,
  });
  let replaceReferenceBase64: string | null = null;
  let replaceReferenceMimeType: string | null = null;
  let replaceReferenceBuffer: Buffer | null = null;
  let replaceReferencePath: string | null = null;
  let replaceReferenceUrl: string | null = null;
  let replaceReferenceSha256: string | null = null;
  if (generationType === "replace_subject" && session.current_photo_file_id) {
    try {
      const refPath = await getFilePath(session.current_photo_file_id);
      replaceReferencePath = refPath;
      replaceReferenceUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${refPath}`;
      const refBuffer = await downloadFile(refPath);
      replaceReferenceBase64 = refBuffer.toString("base64");
      replaceReferenceMimeType = getMimeTypeByTelegramPath(refPath);
      replaceReferenceBuffer = refBuffer;
      replaceReferenceSha256 = sha256Hex(refBuffer);
      if (needsPublicSourceUrl) {
        try {
          const temp = await uploadTempStickerSourceAndGetPublicUrl(
            refBuffer,
            session,
            session.current_photo_file_id,
            replaceReferenceMimeType
          );
          replaceReferenceUrl = temp.publicUrl;
          console.log("[ReplaceSubject] using temp public reference URL for direct Gemini route:", {
            storagePath: temp.storagePath,
            bucket: temp.bucket,
          });
        } catch (uploadErr: any) {
          console.warn("[ReplaceSubject] failed to upload temp reference URL, fallback to Telegram URL:", uploadErr?.message || uploadErr);
        }
      }
      console.log("[ReplaceSubject] loaded identity photo reference:", {
        hasRef: true,
        refMime: replaceReferenceMimeType,
        refBytes: refBuffer.length,
      });
    } catch (err: any) {
      console.warn("[ReplaceSubject] failed to load identity photo, fallback to single input:", err?.message || err);
    }
  }
  const facemintReplaceFaceEnabled = generationType === "replace_subject"
    ? isConfigEnabled(await getAppConfig("facemint_replace_face_enabled", "false"))
    : false;
  if (generationType === "replace_subject") {
    console.log("[ReplaceSubject] facemint flag:", {
      facemintReplaceFaceEnabled,
      hasApiKey: Boolean(config.facemintApiKey),
    });
  }
  const lockEnabled = await isSubjectLockEnabled();
  let subjectProfile = getSessionSubjectProfileForSource(session, sourceFileId, sourceKind);
  if (!subjectProfile) {
    subjectProfile = await ensureSubjectProfileForSource(
      session,
      sourceFileId,
      sourceKind,
      fileBuffer,
      mimeType,
      sourceFileUrl
    );
  }
  let promptForGeneration =
    lockEnabled && subjectProfile
      ? appendSubjectLock(session.prompt_final || "", buildSubjectLockBlock(subjectProfile))
      : (session.prompt_final || "");
  // For photo-realistic style: avoid "illustration" so the model outputs a photo, not a drawing
  const selectedStyleRenderMode = await getStyleRenderMode(session.selected_style_id || null);
  const isPhotoRealistic =
    selectedStyleRenderMode === "photoreal" ||
    session.selected_style_id === "photo_realistic" ||
    /\bphoto-realistic\b|photo_realistic/i.test(promptForGeneration);
  if (isPhotoRealistic) {
    promptForGeneration = promptForGeneration.replace(/\bcharacter illustration\b/gi, "photographic image");
    if (!/output must be a photograph|must be a photo\b/i.test(promptForGeneration)) {
      promptForGeneration +=
        "\n\nOutput MUST be a photograph, not a drawing, illustration, or stylized art.";
    }
  }
  if (selectedStyleRenderMode) {
    promptForGeneration = applyRenderModePolicy(promptForGeneration, selectedStyleRenderMode, {
      includeTransferLine: generationType === "emotion" || generationType === "motion",
    });
  }
  if (generationType === "style" && await isChildIdentityProtectionEnabled()) {
    const ageProfile =
      getSessionSubjectAgeProfileForSource(session, sourceFileId, sourceKind) ||
      (subjectProfile
        ? {
            subjectAgeGroup: normalizeSubjectAgeGroup((subjectProfile as any).subjectAgeGroup),
            subjectAgeConfidence: (subjectProfile as any).subjectAgeConfidence ?? null,
            sourceFileId,
            sourceKind,
            detectedAt: subjectProfile.detectedAt,
          }
        : null);
    const identityRuleVariant: "default_identity" | "child_pose_only" =
      ageProfile?.subjectAgeGroup === "child" ? "child_pose_only" : "default_identity";
    promptForGeneration = applyStyleChildIdentityRule(promptForGeneration, identityRuleVariant);
    console.log("[style.identity_policy.worker]", {
      generationType,
      sourceKind,
      sourceFileId: `${sourceFileId.slice(0, 30)}...`,
      subjectAgeGroup: ageProfile?.subjectAgeGroup || "unknown",
      subjectAgeConfidence: ageProfile?.subjectAgeConfidence ?? null,
      identityRuleVariant,
    });
  }
  const isImportedSticker = Boolean(session.edit_sticker_file_id);
  if (isImportedSticker && (generationType === "emotion" || generationType === "motion")) {
    const changeType = generationType === "emotion" ? "emotion/facial expression" : "motion/body pose";
    const changeHint = session.selected_emotion || session.emotion_prompt || "";
    promptForGeneration =
      `You are an image editor. You are given an existing sticker.\n\n` +
      `YOUR TASK: Edit this sticker by changing ONLY the ${changeType} to: "${changeHint}".\n\n` +
      `EVERYTHING else MUST remain EXACTLY the same:\n` +
      `- Same character identity, face features, hair\n` +
      `- Same art style, line work, coloring technique (cartoon, anime, realistic, pixel art — whatever the input uses)\n` +
      `- Same clothing, accessories, props\n` +
      `- Same background and composition\n` +
      `- Same proportions and framing\n\n` +
      `CRITICAL RULES:\n` +
      `- Do NOT regenerate the sticker from scratch. Make a MINIMAL edit.\n` +
      `- Do NOT change the art style. If the input is photo-realistic — output must be photo-realistic. If cartoon — cartoon.\n` +
      `- Do NOT add any text or watermarks.\n` +
      `- The output must look like it belongs to the same sticker set as the input.\n` +
      `- Background MUST be flat bright magenta (#FF00FF).\n` +
      `- Keep the character fully visible with margins.`;
  }
  if (generationType === "replace_subject" && !facemintReplaceFaceEnabled) {
    let bgDescription = "";
    try {
      console.log("[ReplaceSubject] Analyzing sticker background...");
      const analyzeRes = await axios.post(
        await getGeminiGenerateContentUrlRuntime("gemini-2.0-flash"),
        {
          contents: [{
            role: "user",
            parts: [
              {
                text: `Describe this image in detail for reproduction. Focus on:\n` +
                  `1. BACKGROUND: color, patterns, shapes, gradients, textures, decorative elements\n` +
                  `2. TEXT/LABELS: exact text content, font style, position, color\n` +
                  `3. LOGOS/ICONS: shapes, colors, position\n` +
                  `4. CHARACTER: art style (cartoon/anime/realistic/pixel), pose, clothing, accessories\n` +
                  `5. COMPOSITION: layout, framing, aspect ratio\n\n` +
                  `Be very specific about colors (use hex if possible), positions (top/bottom/left/right), and sizes.\n` +
                  `Output a concise but complete description in 3-5 sentences.`,
              },
              { fileData: { mimeType, fileUri: sourceFileUrl } },
            ],
          }],
        },
        { headers: { "x-goog-api-key": config.geminiApiKey } }
      );
      bgDescription = analyzeRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      console.log("[ReplaceSubject] Background analysis:", bgDescription.substring(0, 200));
    } catch (err: any) {
      console.warn("[ReplaceSubject] Background analysis failed, proceeding without:", err?.message);
    }

    const bgBlock = bgDescription
      ? `\n\nDETAILED DESCRIPTION OF IMAGE 1 (you MUST reproduce all of this exactly):\n${bgDescription}`
      : "";

    promptForGeneration =
      `You are an illustrator recreating an existing image. You are given two images:\n` +
      `Image 1 — the original artwork to recreate.\n` +
      `Image 2 — a visual character reference.\n\n` +
      `TASK:\n` +
      `Recreate Image 1 while updating the main character so the character design is clearly inspired by Image 2. ` +
      `The result should feel recognizable as based on Image 2 when viewed side by side, while remaining fully rendered in the visual style of Image 1.${bgBlock}\n\n` +
      `STYLE RULES:\n` +
      `- Preserve the EXACT visual style of Image 1.\n` +
      `- If Image 1 is photorealistic, keep the result photorealistic.\n` +
      `- If Image 1 is cartoon, anime, illustration, or other stylized art, keep that same stylized rendering.\n` +
      `- Never switch style families and never create a pasted or collage-like result.\n\n` +
      `CHARACTER UPDATE RULES:\n` +
      `- Use Image 2 as the appearance reference for the main character.\n` +
      `- Transfer the most recognizable visual cues from Image 2: overall look, silhouette, hairstyle, hair color, age impression, and general proportions.\n` +
      `- Keep the same expression, emotion, pose, and body position from Image 1.\n` +
      `- The character should look like a natural redraw of Image 1, not a separate inserted element.\n\n` +
      `KEEP UNCHANGED FROM IMAGE 1:\n` +
      `- Background, colors, patterns, decorative elements, logos\n` +
      `- All text and labels\n` +
      `- Clothing, accessories, props\n` +
      `- Composition, framing, layout, dimensions\n` +
      `- Line work, coloring technique, shading style\n\n` +
      `CHANGE ONLY:\n` +
      `- The main character's appearance, guided by Image 2\n\n` +
      `CRITICAL:\n` +
      `- Output one single cohesive artwork with a consistent style everywhere.\n` +
      `- Keep the character clearly recognizable as inspired by Image 2.\n` +
      `- If Image 1 has a complex background, reproduce that background closely.`;
  }

  await updateProgress(3);
  const usedFacemintReplaceFace = facemintReplaceFaceEnabled && !!config.facemintApiKey;
  let imageBase64: string | null = null;
  let finalPromptUsed = promptForGeneration;
  let callGeminiImage: ((promptText: string, modelName: string, stage: string) => Promise<any>) | null = null;
  let activeModel = "";

  if (facemintReplaceFaceEnabled && !config.facemintApiKey) {
    console.warn("[ReplaceSubject][Facemint] enabled but FACEMINT_API_KEY is empty, fallback to Gemini");
  }

  if (usedFacemintReplaceFace) {
    if (!replaceReferenceBuffer) {
      throw new Error("Facemint replace_subject failed: identity photo is missing");
    }
    const stickerExt = mimeType === "image/webp" ? "webp" : mimeType === "image/png" ? "png" : "jpg";
    const refExt =
      replaceReferenceMimeType === "image/webp"
        ? "webp"
        : replaceReferenceMimeType === "image/png"
          ? "png"
          : "jpg";
    const prefix = `temp/facemint/${session.user_id}/${session.id}/${job.id}`;
    const stickerStoragePath = `${prefix}-source.${stickerExt}`;
    const faceStoragePath = `${prefix}-face.${refExt}`;
    const stickerUrl = await uploadBufferForFacemint(fileBuffer, stickerStoragePath, mimeType);
    const faceUrl = await uploadBufferForFacemint(
      replaceReferenceBuffer,
      faceStoragePath,
      replaceReferenceMimeType || "image/jpeg"
    );
    console.log("[ReplaceSubject][Facemint] upload done", {
      bucket: config.supabaseStorageBucketExamples || "stickers-examples",
      stickerUrl,
      faceUrl,
      stickerPath: stickerStoragePath,
      facePath: faceStoragePath,
    });

    const stickerMeta = await sharp(fileBuffer).metadata();
    const faceMeta = await sharp(replaceReferenceBuffer).metadata();
    console.log("[ReplaceSubject][Facemint] input images", {
      sticker: {
        bytes: fileBuffer.length,
        mime: mimeType,
        width: stickerMeta.width,
        height: stickerMeta.height,
        format: stickerMeta.format,
        url: stickerUrl,
      },
      face: {
        bytes: replaceReferenceBuffer.length,
        mime: replaceReferenceMimeType || "image/jpeg",
        width: faceMeta.width,
        height: faceMeta.height,
        format: faceMeta.format,
        url: faceUrl,
      },
    });

    console.log("[ReplaceSubject][Facemint] creating task");
    const { taskId, price } = await createFaceSwapTask({
      type: "image",
      media_url: stickerUrl,
      swap_list: [{ to_face: faceUrl }],
      resolution: 1,
      enhance: 1,
      nsfw_check: 0,
      face_recognition: 0.8,
      face_detection: 0.25,
    });
    console.log("[ReplaceSubject][Facemint] task created", { taskId, price });

    const task = await waitForFaceSwapTask(taskId, { timeoutMs: 120_000, pollIntervalMs: 2_000 });
    const resultUrl = task.result?.file_url;
    if (!resultUrl) {
      throw new Error("Facemint replace_subject failed: task completed without result file URL");
    }
    const resultRes = await axios.get<ArrayBuffer>(resultUrl, {
      responseType: "arraybuffer",
      timeout: 30_000,
    });
    const facemintBuffer = Buffer.from(resultRes.data);
    imageBase64 = facemintBuffer.toString("base64");
    finalPromptUsed = `[facemint replace_subject] task_id=${taskId}`;
    console.log("[ReplaceSubject][Facemint] task complete", { taskId, bytes: facemintBuffer.length });
  }

  if (!usedFacemintReplaceFace) {
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
  const primaryModel =
    generationType === "emotion" ? await getAppConfig("gemini_model_emotion", "gemini-2.5-flash-image") :
    generationType === "motion"  ? await getAppConfig("gemini_model_motion",  "gemini-2.5-flash-image") :
    generationType === "replace_subject" ? await getAppConfig("gemini_model_replace_face", "gemini-2.5-flash-image") :
    await getAppConfig("gemini_model_style", "gemini-3-pro-image-preview");
  activeModel = primaryModel;
  console.log("Using model:", activeModel, "generationType:", generationType);
  callGeminiImage = async (promptText: string, modelName: string, stage: string) => {
    if (needsPublicSourceUrl && /^https?:\/\//.test(sourceFileUrl)) {
      const sourceReady = await waitForPublicUrlReady(sourceFileUrl, "source_file_url");
      if (!sourceReady) {
        throw new Error("Source public URL is not reachable for Gemini");
      }
      if (generationType === "replace_subject" && replaceReferenceUrl && /^https?:\/\//.test(replaceReferenceUrl)) {
        const refReady = await waitForPublicUrlReady(replaceReferenceUrl, "replace_reference_url");
        if (!refReady) {
          throw new Error("Replace reference public URL is not reachable for Gemini");
        }
      }
    }
    if (isSingleFlowGeneration) {
      console.log("[single.gen.worker] model_call", {
        ...singleTrace,
        stage,
        model: modelName,
        promptLen: promptText.length,
      });
    }
    const requestBody = {
        contents: [
          {
            role: "user",
            parts: [
              { text: promptText },
              {
                fileData: {
                  mimeType,
                  fileUri: sourceFileUrl,
                },
              },
              ...(generationType === "replace_subject" && replaceReferenceUrl
                ? [{
                    fileData: {
                      mimeType: replaceReferenceMimeType || "image/jpeg",
                      fileUri: replaceReferenceUrl,
                    },
                  }]
                : []),
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE", "TEXT"],
          imageConfig: { aspectRatio: "1:1" },
        },
      };
    const requestUrl = await getGeminiGenerateContentUrlRuntime(modelName);
    const requestImagePayload = {
      sessionId: session.id,
      jobId: job.id,
      stage,
      model: modelName,
      requestUrl,
      generationType,
      promptLength: promptText.length,
      promptText,
      inputImage: {
        transport: "fileData",
        sourceUrlTransport: resolvedSource.transport,
        sourceStoragePath: resolvedSource.storagePath || null,
        fileId: sourceFileId,
        filePath,
        sourceFileUrl,
        mimeType,
        bytes: fileBuffer.length,
        sha256: sourceSha256,
      },
      replaceReferenceImage: replaceReferenceUrl
        ? {
            transport: "fileData",
            fileId: session.current_photo_file_id,
            filePath: replaceReferencePath,
            sourceFileUrl: replaceReferenceUrl,
            mimeType: replaceReferenceMimeType || "image/jpeg",
            bytes: replaceReferenceBuffer?.length || 0,
            sha256: replaceReferenceSha256,
          }
        : null,
    };

    logLongValue("[GeminiDebug] request_image_payload_json", JSON.stringify(requestImagePayload));
    const res = await axios.post(
      requestUrl,
      requestBody,
      {
        headers: { "x-goog-api-key": config.geminiApiKey },
      }
    );
    if (isSingleFlowGeneration) {
      const candidate = res.data?.candidates?.[0];
      const usage = res.data?.usageMetadata;
      const hasImage = Boolean(extractGeminiImageBase64(res.data));
      console.log("[single.gen.worker] model_result", {
        ...singleTrace,
        stage,
        model: modelName,
        finishReason: candidate?.finishReason || null,
        hasImage,
        promptTokens: usage?.promptTokenCount ?? null,
        totalTokens: usage?.totalTokenCount ?? null,
      });
    }
    return res;
  };

  if (!callGeminiImage) {
    throw new Error("Gemini image caller not initialized");
  }

  const isSourceUrlFetchError = (err: any): boolean => {
    const msg = String(err?.response?.data?.error?.message || err?.message || "").toLowerCase();
    return msg.includes("cannot fetch content from the provided url");
  };

  let geminiRes;
  try {
    geminiRes = await callGeminiImage(promptForGeneration, activeModel, "primary");
  } catch (_err: any) {
    let err = _err;
    if (needsPublicSourceUrl && isSourceUrlFetchError(err)) {
      try {
        const retryTemp = await uploadTempStickerSourceAndGetPublicUrl(
          fileBuffer,
          session,
          `${sourceFileId}_retry`,
          mimeType
        );
        sourceFileUrl = retryTemp.publicUrl;
        console.warn("[GeminiRetry] source URL fetch failed, retrying with refreshed temp URL:", {
          sessionId: session.id,
          jobId: job.id,
          generationType,
          oldSourceUrl: resolvedSource.sourceFileUrl,
          newSourceUrl: sourceFileUrl,
          newStoragePath: retryTemp.storagePath,
        });
        geminiRes = await callGeminiImage(promptForGeneration, activeModel, "primary_retry_source_url");
      } catch (retryErr: any) {
        err = retryErr;
      }
    }

    if (geminiRes) {
      // Retry succeeded, continue normal flow.
    } else {
    const errorData = err.response?.data;
    const errorMessage = errorData?.error?.message || err.message || err.code || "Unknown error";
    const errorStatus = err.response?.status;
    
    console.error("=== Gemini API Error ===");
    console.error("Status:", errorStatus);
    console.error("Message:", errorMessage);
    console.error("Code:", err.code);
    console.error("Full response:", JSON.stringify(errorData || {}, null, 2));
    if (isSingleFlowGeneration) {
      console.error("[single.gen.worker] model_error", {
        ...singleTrace,
        stage: "primary",
        model: activeModel,
        status: errorStatus || null,
        code: err.code || null,
        message: errorMessage,
      });
    }
    
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

  imageBase64 = extractGeminiImageBase64(geminiRes.data);

  if (!imageBase64) {
    const firstFinishReason = geminiRes.data?.candidates?.[0]?.finishReason || "unknown";
    console.warn("[Generation] No image from Gemini. finishReason:", firstFinishReason);
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
        finishReason: firstFinishReason,
        geminiResponse: geminiText.slice(0, 200),
      },
    });
    throw new Error("Gemini returned no image");
  }

  }

  if (!imageBase64) {
    throw new Error("Generation returned no image bytes");
  }
  const generatedImageBase64 = imageBase64;

  const postcheckEnabled = !usedFacemintReplaceFace && await isSubjectPostcheckEnabled();
  if (postcheckEnabled && subjectProfile?.subjectMode && subjectProfile.subjectMode !== "unknown") {
    const firstGeneratedBuffer = Buffer.from(generatedImageBase64, "base64");
    const detected = await detectSubjectProfileFromImageBuffer(firstGeneratedBuffer, "image/png");
    const mismatch = isSubjectPostcheckMismatch(
      subjectProfile.subjectMode,
      detected.subjectMode,
      detected.subjectCount
    );

    if (mismatch) {
      console.warn("[subject-postcheck] mismatch detected:", {
        sessionId: session.id,
        expectedMode: subjectProfile.subjectMode,
        detectedMode: detected.subjectMode,
        detectedCount: detected.subjectCount,
      });

      await sendAlert({
        type: "generation_failed",
        message: "Subject postcheck mismatch",
        details: {
          user: `@${user?.username || telegramId}`,
          sessionId: session.id,
          expectedMode: subjectProfile.subjectMode,
          detectedMode: detected.subjectMode,
          detectedCount: detected.subjectCount ?? "-",
          generationType,
        },
      });
      throw new Error(
        `Subject postcheck mismatch: expected=${subjectProfile.subjectMode} actual=${detected.subjectMode} count=${detected.subjectCount ?? "null"}`
      );
    }
  }

  console.log("Image generated successfully");

  await updateProgress(4);
  const generatedBuffer = Buffer.from(imageBase64, "base64");
  const geminiDebugDumpEnabled = isConfigEnabled(
    await getAppConfig("gemini_debug_dump_enabled", "false")
  );
  if (geminiDebugDumpEnabled) {
    try {
      const uploaded = await uploadTempStickerSourceAndGetPublicUrl(
        generatedBuffer,
        session,
        `gemini_raw_${job.id}`,
        "image/png"
      );
      console.log("[GeminiDebug] raw_image_dump", {
        sessionId: session.id,
        jobId: job.id,
        generationType,
        model: activeModel,
        bytes: generatedBuffer.length,
        sha256: sha256Hex(generatedBuffer),
        mimeType: "image/png",
        bucket: uploaded.bucket,
        storagePath: uploaded.storagePath,
        publicUrl: uploaded.publicUrl,
      });
    } catch (err: any) {
      console.warn("[GeminiDebug] raw_image_dump_failed:", err?.message || err);
    }
  }

  await updateProgress(5);

  const skipBgRemoval =
    isImportedSticker && (generationType === "emotion" || generationType === "motion");
  let noBgBuffer: Buffer | undefined;

  if (skipBgRemoval) {
    console.log("[bgRemoval] SKIPPED — preserving original background", {
      generationType,
      reason: "imported_sticker_edit",
    });
    noBgBuffer = generatedBuffer;
  } else {
    // ============================================================
    // Background removal — configurable primary service
    // app_config key: bg_removal_primary (prod) / bg_removal_primary_test (test)
    // Values: "rembg" | "pixian"
    // ============================================================
    const imageSizeKb = Math.round(generatedBuffer.length / 1024);
    const rembgUrl = process.env.REMBG_URL;
    const bgConfigKey = config.appEnv === "test" ? "bg_removal_primary_test" : "bg_removal_primary";
    const bgPrimary = await getAppConfig(bgConfigKey, "rembg");

    const startTime = Date.now();

    console.log(`[bgRemoval] Primary service: ${bgPrimary}, image size: ${imageSizeKb} KB`);

    if (bgPrimary === "pixian") {
      noBgBuffer = await callPixian(generatedBuffer, imageSizeKb);
      if (!noBgBuffer) {
        console.log(`[bgRemoval] Pixian failed, falling back to rembg`);
        noBgBuffer = await callRembg(generatedBuffer, rembgUrl, imageSizeKb);
      }
    } else {
      noBgBuffer = await callRembg(generatedBuffer, rembgUrl, imageSizeKb);
      if (!noBgBuffer) {
        console.log(`[bgRemoval] rembg failed, falling back to Pixian`);
        noBgBuffer = await callPixian(generatedBuffer, imageSizeKb);
      }
    }

    const bgDuration = Date.now() - startTime;
    console.log(`[bgRemoval] Total background removal took ${bgDuration}ms`);

    if (!noBgBuffer) {
      console.error("=== Background removal failed (all methods) ===");
      console.error("Duration:", bgDuration, "ms");
      
      await sendAlert({
        type: "rembg_failed",
        message: `Background removal failed: all methods exhausted`,
        details: { 
          user: `@${user?.username || telegramId}`,
          sessionId: session.id,
          generationType,
          styleId: session.selected_style_id || "-",
          imageSizeKb,
          durationMs: bgDuration,
          bgPrimary,
          rembgConfigured: !!rembgUrl,
        },
      });
      throw new Error(`Background removal failed: all methods exhausted`);
    }
  }

  await updateProgress(6);

  // At this point noBgBuffer is guaranteed to be set (or we threw above)
  const cleanedBuffer = noBgBuffer!;

  let stickerBuffer: Buffer;
  if (skipBgRemoval) {
    stickerBuffer = await sharp(cleanedBuffer)
      .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 95 })
      .toBuffer();
  } else {
    // Safety padding: add 5% transparent border so trim never eats into character
    const meta = await sharp(cleanedBuffer).metadata();
    const safetyPad = Math.round(Math.max(meta.width || 0, meta.height || 0) * 0.05);
    const paddedBuffer = await sharp(cleanedBuffer)
      .extend({
        top: safetyPad, bottom: safetyPad, left: safetyPad, right: safetyPad,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .toBuffer();

    stickerBuffer = await sharp(paddedBuffer)
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
  }

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

  const withCreditBadge = (label: string, credits: number): string => {
    const cleaned = String(label)
      .replace(/\s*[\(\-–—]?\s*\d+\s*💎\)?\s*$/u, "")
      .trim();
    return `${cleaned} (${credits}💎)`;
  };

  const addToPackText = await getText(lang, "btn.add_to_pack");
  const changeStyleText = withCreditBadge(await getText(lang, "btn.change_style"), 1);
  const changeEmotionText = withCreditBadge(
    lang === "ru" ? "😊 Эмоция" : await getText(lang, "btn.change_emotion"),
    1
  );
  const changeMotionText = withCreditBadge(
    lang === "ru" ? "🏃 Движение" : await getText(lang, "btn.change_motion"),
    1
  );
  const addTextText = lang === "ru" ? "✏️ Текст" : await getText(lang, "btn.add_text");
  const toggleBorderText = lang === "ru" ? "🔲 Обводка" : await getText(lang, "btn.toggle_border");
  const replaceFaceText = withCreditBadge(
    lang === "ru" ? "🧑 Заменить лицо" : "🧑 Replace face",
    1
  );
  const removeBgText = lang === "ru" ? "🖼 Вырезать фон" : "🖼 Remove background";
  const packIdeasText = lang === "ru" ? "💡 Идеи" : "💡 Pack ideas";

  // Use sticker ID in callback_data for message binding
  const replyMarkup = {
    inline_keyboard: [
      [{ text: addToPackText, callback_data: stickerId ? `add_to_pack:${stickerId}` : "add_to_pack" }],
      [{ text: changeStyleText, callback_data: stickerId ? `change_style:${stickerId}` : "change_style" }],
      [
        { text: changeEmotionText, callback_data: stickerId ? `change_emotion:${stickerId}` : "change_emotion" },
        { text: changeMotionText, callback_data: stickerId ? `change_motion:${stickerId}` : "change_motion" },
      ],
      [
        { text: toggleBorderText, callback_data: stickerId ? `toggle_border:${stickerId}` : "toggle_border" },
        { text: addTextText, callback_data: stickerId ? `add_text:${stickerId}` : "add_text" },
      ],
      [
        { text: replaceFaceText, callback_data: stickerId ? `replace_face:${stickerId}` : "replace_face" },
        { text: removeBgText, callback_data: stickerId ? `remove_bg:${stickerId}` : "remove_bg" },
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

  // Post-generation onboarding CTA is disabled.
  // Keep onboarding completion behavior without sending extra text.
  if (!isAvatarDemo && onboardingStep <= 1 && generationType === "style" && stickerId) {
    console.log("post-generation CTA skipped, onboardingStep:", onboardingStep);

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

  // Алерт «Сохранить пример для эмоции» только для batch flow (9 стикеров), не для одиночного (docs/27-02-emotion-carousel-example-images.md).

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
          .select("user_id, photos, credits_spent, session_rev, state, generation_type")
          .eq("id", job.session_id)
          .maybeSingle();

        if (session?.user_id) {
          const processingStates = new Set(["processing", "processing_emotion", "processing_motion", "processing_text"]);
          const sessionState = String(session.state || "");
          if (processingStates.has(sessionState)) {
            // Recover stuck sessions: previous job has already ended with error,
            // so retry button must not be blocked by stale processing_* state.
            await supabase
              .from("sessions")
              .update({
                state: getRetryReadyState(session.generation_type),
                is_active: true,
                progress_message_id: null,
                progress_chat_id: null,
              })
              .eq("id", job.session_id);
          }

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
