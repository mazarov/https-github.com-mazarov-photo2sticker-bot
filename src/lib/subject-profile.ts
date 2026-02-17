import axios from "axios";
import { config } from "../config";
import { getAppConfig } from "./app-config";

export type SubjectMode = "single" | "multi" | "unknown";
export type SubjectSourceKind = "photo" | "sticker";

export interface SubjectProfile {
  subjectMode: SubjectMode;
  subjectCount: number | null;
  subjectConfidence: number | null;
  sourceFileId: string;
  sourceKind: SubjectSourceKind;
  detectedAt: string;
}

type DetectorBBox = { x: number; y: number; width: number; height: number };
type DetectorObjectInstance = {
  bbox: DetectorBBox | null;
  areaRatio: number | null;
  edgeTouch: boolean;
  confidence: number | null;
  isPrimaryCandidate: boolean | null;
};

const SUBJECT_LOCK_BEGIN = "[SUBJECT LOCK BEGIN]";
const SUBJECT_LOCK_END = "[SUBJECT LOCK END]";
const LEGACY_SUBJECT_PATTERNS: RegExp[] = [
  /Subject:\s*Analyze the provided photo\.[^\n]*(?:\n|$)/gi,
  /If there is ONE person[^.]*\.(?:\s|$)/gi,
  /If there are MULTIPLE people[^.]*\.(?:\s|$)/gi,
  /Source contains EXACTLY ONE person\.[^\n]*(?:\n|$)/gi,
  /Source contains MULTIPLE persons\.[^\n]*(?:\n|$)/gi,
];

export function parseBooleanConfig(value: string | null | undefined): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(3));
}

function normalizeCount(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

export function normalizeSubjectMode(value: unknown): SubjectMode {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "single") return "single";
  if (normalized === "multi") return "multi";
  return "unknown";
}

export function normalizeSubjectSourceKind(value: unknown): SubjectSourceKind {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "sticker" ? "sticker" : "photo";
}

export function inferSubjectModeByCount(count: number | null): SubjectMode {
  if (count === null) return "unknown";
  if (count <= 1) return "single";
  return "multi";
}

export function resolveGenerationSource(
  session: any,
  generationType: "style" | "emotion" | "motion" | "text"
): { sourceFileId: string | null; sourceKind: SubjectSourceKind } {
  if (generationType === "emotion" || generationType === "motion" || generationType === "text") {
    return {
      sourceFileId: session?.last_sticker_file_id || null,
      sourceKind: "sticker",
    };
  }
  const photos = Array.isArray(session?.photos) ? session.photos : [];
  return {
    sourceFileId: session?.current_photo_file_id || photos[photos.length - 1] || null,
    sourceKind: "photo",
  };
}

export function buildSubjectLockBlock(profile: Pick<SubjectProfile, "subjectMode" | "subjectCount" | "sourceKind">): string {
  const mode = normalizeSubjectMode(profile.subjectMode);
  const count = normalizeCount(profile.subjectCount);
  const countHint = count !== null ? ` Detected main object count: ${count}.` : "";
  const sourceHint = profile.sourceKind === "sticker" ? "Source image is a sticker." : "Source image is a photo.";

  if (mode === "single") {
    return [
      SUBJECT_LOCK_BEGIN,
      `${sourceHint}${countHint}`,
      "Source contains EXACTLY ONE main object.",
      "Never add extra main objects, duplicates, or prominent secondary characters.",
      "Keep the same identity/appearance of the main object.",
      SUBJECT_LOCK_END,
    ].join("\n");
  }

  if (mode === "multi") {
    return [
      SUBJECT_LOCK_BEGIN,
      `${sourceHint}${countHint}`,
      "Source contains MULTIPLE main objects.",
      "Include all main objects from source; do not add or drop any main object.",
      "Keep identities/appearance and relative composition/interactions.",
      SUBJECT_LOCK_END,
    ].join("\n");
  }

  return [
    SUBJECT_LOCK_BEGIN,
    `${sourceHint}${countHint}`,
    "Main-object count is uncertain; preserve visible main objects as-is.",
    "Do not invent additional prominent objects or remove clearly visible ones.",
    SUBJECT_LOCK_END,
  ].join("\n");
}

export function appendSubjectLock(prompt: string, lockBlock: string): string {
  const cleanPrompt = stripLegacySubjectInstructions((prompt || "").trim());
  const cleanLock = (lockBlock || "").trim();
  if (!cleanLock) return cleanPrompt;
  if (cleanPrompt.includes(SUBJECT_LOCK_BEGIN) && cleanPrompt.includes(SUBJECT_LOCK_END)) {
    return cleanPrompt;
  }
  if (!cleanPrompt) return cleanLock;
  return `${cleanLock}\n\n${cleanPrompt}`;
}

function stripLegacySubjectInstructions(prompt: string): string {
  let next = prompt;
  for (const pattern of LEGACY_SUBJECT_PATTERNS) {
    next = next.replace(pattern, "");
  }
  return next.replace(/\n{3,}/g, "\n\n").trim();
}

function parseNumberConfig(value: string | null | undefined, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeRatio(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Number(clamp01(value).toFixed(4));
}

function parseBBox(raw: unknown): DetectorBBox | null {
  if (!raw) return null;
  if (Array.isArray(raw) && raw.length === 4) {
    const [x, y, width, height] = raw.map((v) => Number(v));
    if ([x, y, width, height].every((v) => Number.isFinite(v))) {
      return {
        x: clamp01(x),
        y: clamp01(y),
        width: clamp01(width),
        height: clamp01(height),
      };
    }
    return null;
  }
  if (typeof raw !== "object") return null;
  const maybe = raw as any;
  const x = Number(maybe.x);
  const y = Number(maybe.y);
  const width = Number(maybe.width);
  const height = Number(maybe.height);
  if (![x, y, width, height].every((v) => Number.isFinite(v))) return null;
  return {
    x: clamp01(x),
    y: clamp01(y),
    width: clamp01(width),
    height: clamp01(height),
  };
}

function inferAreaRatioFromBBox(bbox: DetectorBBox | null): number | null {
  if (!bbox) return null;
  return normalizeRatio(bbox.width * bbox.height);
}

function inferEdgeTouchFromBBox(bbox: DetectorBBox | null): boolean {
  if (!bbox) return false;
  const eps = 0.03;
  return (
    bbox.x <= eps ||
    bbox.y <= eps ||
    bbox.x + bbox.width >= 1 - eps ||
    bbox.y + bbox.height >= 1 - eps
  );
}

function parseDetectorInstance(raw: unknown): DetectorObjectInstance | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as any;
  const bbox = parseBBox(item.bbox ?? item.box ?? item.rect);
  const areaRatio =
    normalizeRatio(item.area_ratio ?? item.areaRatio) ??
    inferAreaRatioFromBBox(bbox);
  const edgeTouch =
    typeof item.edge_touch === "boolean"
      ? item.edge_touch
      : typeof item.edgeTouch === "boolean"
        ? item.edgeTouch
        : inferEdgeTouchFromBBox(bbox);
  return {
    bbox,
    areaRatio,
    edgeTouch,
    confidence: normalizeConfidence(item.confidence),
    isPrimaryCandidate:
      typeof item.is_primary_candidate === "boolean"
        ? item.is_primary_candidate
        : typeof item.isPrimaryCandidate === "boolean"
          ? item.isPrimaryCandidate
          : null,
  };
}

function calcIou(a: DetectorBBox, b: DetectorBBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const interWidth = Math.max(0, x2 - x1);
  const interHeight = Math.max(0, y2 - y1);
  const intersection = interWidth * interHeight;
  const aArea = Math.max(0, a.width) * Math.max(0, a.height);
  const bArea = Math.max(0, b.width) * Math.max(0, b.height);
  const union = aArea + bArea - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function dedupInstances(instances: DetectorObjectInstance[]): DetectorObjectInstance[] {
  if (instances.length <= 1) return instances;
  const sorted = [...instances].sort((left, right) => {
    const leftScore = (left.confidence ?? 0) + (left.areaRatio ?? 0);
    const rightScore = (right.confidence ?? 0) + (right.areaRatio ?? 0);
    return rightScore - leftScore;
  });
  const kept: DetectorObjectInstance[] = [];
  for (const candidate of sorted) {
    if (!candidate.bbox) {
      kept.push(candidate);
      continue;
    }
    const overlapped = kept.some((existing) => existing.bbox && calcIou(candidate.bbox!, existing.bbox) >= 0.82);
    if (!overlapped) kept.push(candidate);
  }
  return kept;
}

async function isObjectEdgeFilterEnabled(): Promise<boolean> {
  const value = await getAppConfig("object_edge_filter_enabled", "false");
  return parseBooleanConfig(value);
}

async function getObjectMinAreaRatio(): Promise<number> {
  return parseNumberConfig(await getAppConfig("object_min_area_ratio", "0.06"), 0.06);
}

async function getObjectEdgeSmallAreaMax(): Promise<number> {
  return parseNumberConfig(await getAppConfig("object_edge_small_area_max", "0.12"), 0.12);
}

async function getMultiConfidenceMin(): Promise<number> {
  const objectValue = await getAppConfig("object_multi_confidence_min", "");
  if (String(objectValue).trim() !== "") {
    return parseNumberConfig(objectValue, 0.85);
  }
  return parseNumberConfig(await getAppConfig("subject_multi_confidence_min", "0.85"), 0.85);
}

async function getLowConfidenceFallbackMode(): Promise<SubjectMode> {
  const objectValue = await getAppConfig("object_multi_low_confidence_fallback", "");
  if (String(objectValue).trim() !== "") {
    return normalizeSubjectMode(objectValue);
  }
  return normalizeSubjectMode(await getAppConfig("subject_multi_low_confidence_fallback", "unknown"));
}

async function hardenDetectedProfile(detected: {
  objectMode: SubjectMode;
  objectCount: number | null;
  objectConfidence: number | null;
  objectInstances: DetectorObjectInstance[];
}): Promise<{
  subjectMode: SubjectMode;
  subjectCount: number | null;
  subjectConfidence: number | null;
}> {
  let subjectMode = normalizeSubjectMode(detected.objectMode);
  let subjectCount = normalizeCount(detected.objectCount);
  let subjectConfidence = normalizeConfidence(detected.objectConfidence);

  const deduped = dedupInstances(detected.objectInstances);
  const minAreaRatio = await getObjectMinAreaRatio();
  const edgeSmallAreaMax = await getObjectEdgeSmallAreaMax();
  const edgeFilterEnabled = await isObjectEdgeFilterEnabled();

  const areaFiltered = deduped.filter((item) => {
    if (item.areaRatio === null) return true;
    return item.areaRatio >= minAreaRatio;
  });
  const primary = areaFiltered.filter((item) => {
    if (!edgeFilterEnabled) return true;
    if (!item.edgeTouch) return true;
    const area = item.areaRatio;
    return area === null || area >= edgeSmallAreaMax;
  });

  const preferredPrimary = primary.some((item) => item.isPrimaryCandidate === true)
    ? primary.filter((item) => item.isPrimaryCandidate === true)
    : primary;

  if (preferredPrimary.length > 0) {
    subjectCount = preferredPrimary.length;
    subjectMode = inferSubjectModeByCount(subjectCount);
    const confidenceValues = preferredPrimary
      .map((item) => item.confidence)
      .filter((value): value is number => typeof value === "number");
    if (confidenceValues.length > 0) {
      const avgConfidence = confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length;
      subjectConfidence = normalizeConfidence(avgConfidence);
    }
  }

  if (subjectMode === "unknown") {
    subjectMode = inferSubjectModeByCount(subjectCount);
  }

  // Guard: avoid forcing "multi" on weak/ambiguous detector output.
  if (subjectMode === "multi") {
    const minConfidence = await getMultiConfidenceMin();
    const lowConfidence = subjectConfidence === null || subjectConfidence < minConfidence;
    if (lowConfidence) {
      const fallbackMode = await getLowConfidenceFallbackMode();
      if (fallbackMode === "single") {
        subjectMode = "single";
        subjectCount = 1;
      } else {
        subjectMode = "unknown";
        subjectCount = null;
      }
    }
  }

  if (subjectMode === "single" && subjectCount === null) {
    subjectCount = 1;
  }
  if (subjectMode === "unknown") {
    subjectCount = null;
  }

  return { subjectMode, subjectCount, subjectConfidence };
}

function extractTextFromGeminiResponse(data: any): string {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  const texts = parts
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .filter((text: string) => text.length > 0);
  return texts.join("\n").trim();
}

function parseDetectorPayload(raw: string): {
  objectMode: SubjectMode;
  objectCount: number | null;
  objectConfidence: number | null;
  objectInstances: DetectorObjectInstance[];
} {
  const text = (raw || "").trim();
  let parsed: any = null;

  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!parsed) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }

  let objectMode = normalizeSubjectMode(
    parsed?.object_mode ??
      parsed?.objectMode ??
      parsed?.subject_mode ??
      parsed?.subjectMode ??
      parsed?.mode
  );
  let objectCount = normalizeCount(
    parsed?.object_count ?? parsed?.objectCount ?? parsed?.subject_count ?? parsed?.subjectCount ?? parsed?.count
  );
  let objectConfidence = normalizeConfidence(
    parsed?.object_confidence ??
      parsed?.objectConfidence ??
      parsed?.subject_confidence ??
      parsed?.subjectConfidence ??
      parsed?.confidence
  );
  const rawInstances: unknown[] = Array.isArray(parsed?.object_instances)
    ? parsed.object_instances
    : Array.isArray(parsed?.objectInstances)
      ? parsed.objectInstances
      : Array.isArray(parsed?.instances)
        ? parsed.instances
        : [];
  const objectInstances = rawInstances
    .map(parseDetectorInstance)
    .filter((item): item is DetectorObjectInstance => Boolean(item));

  if (!parsed) {
    const modeMatch = text.match(/\b(single|multi|unknown)\b/i);
    if (modeMatch?.[1]) {
      objectMode = normalizeSubjectMode(modeMatch[1]);
    }
    const countMatch =
      text.match(/object[_\s-]*count[^0-9]{0,8}([0-9]+)/i) ||
      text.match(/subject[_\s-]*count[^0-9]{0,8}([0-9]+)/i) ||
      text.match(/\b([0-9]+)\s*(?:main\s*)?(?:object|objects|person|people)\b/i);
    if (countMatch?.[1]) {
      objectCount = normalizeCount(countMatch[1]);
    }
    const confidenceMatch = text.match(/confidence[^0-9]{0,8}(0(?:\.[0-9]+)?|1(?:\.0+)?)/i);
    if (confidenceMatch?.[1]) {
      objectConfidence = normalizeConfidence(Number(confidenceMatch[1]));
    }
  }

  if (objectMode === "unknown") {
    objectMode = inferSubjectModeByCount(objectCount);
  }
  if (objectMode !== "unknown" && objectCount === null) {
    objectCount = objectMode === "single" ? 1 : null;
  }

  return { objectMode, objectCount, objectConfidence, objectInstances };
}

export async function detectSubjectProfileFromImageBuffer(
  imageBuffer: Buffer,
  mimeType: string
): Promise<{
  subjectMode: SubjectMode;
  subjectCount: number | null;
  subjectConfidence: number | null;
}> {
  try {
    const model = await getAppConfig("gemini_model_subject_detector", "gemini-2.0-flash");
    const prompt = [
      "Count main prominent objects visible in the source image.",
      "Object can be a person, animal, mascot, or character-like entity.",
      "Return strict JSON only with keys:",
      '{"object_mode":"single|multi|unknown","object_count":number|null,"object_confidence":0..1,"object_instances":[{"bbox":{"x":0..1,"y":0..1,"width":0..1,"height":0..1},"area_ratio":0..1,"edge_touch":true|false,"confidence":0..1,"is_primary_candidate":true|false}]}',
      "Rules:",
      "- single = exactly 1 main object",
      "- multi = 2 or more main objects",
      "- unknown if cannot decide reliably",
      "- Ignore tiny peripheral fragments touching edges if they are not primary objects",
      "- Do not count reflections, posters, statues, drawings, toy figurines as separate main objects",
      "- object_instances may be empty if uncertain",
    ].join("\n");

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType,
                  data: imageBuffer.toString("base64"),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      },
      {
        headers: { "x-goog-api-key": config.geminiApiKey },
        timeout: 30000,
      }
    );

    const rawText = extractTextFromGeminiResponse(response.data);
    if (!rawText) {
      return { subjectMode: "unknown", subjectCount: null, subjectConfidence: null };
    }
    return await hardenDetectedProfile(parseDetectorPayload(rawText));
  } catch (err: any) {
    console.warn("[subject-profile] detector failed:", err?.response?.data?.error?.message || err?.message || err);
    return { subjectMode: "unknown", subjectCount: null, subjectConfidence: null };
  }
}

export async function isSubjectProfileEnabled(): Promise<boolean> {
  const subjectEnabled = parseBooleanConfig(await getAppConfig("subject_profile_enabled", "false"));
  const objectEnabled = await isObjectProfileEnabled();
  const objectShadowEnabled = await isObjectProfileShadowEnabled();
  return subjectEnabled || objectEnabled || objectShadowEnabled;
}

export async function isSubjectLockEnabled(): Promise<boolean> {
  const subjectEnabled = parseBooleanConfig(await getAppConfig("subject_lock_enabled", "false"));
  const objectEnabled = await isObjectLockEnabled();
  return subjectEnabled || objectEnabled;
}

export async function isSubjectModePackFilterEnabled(): Promise<boolean> {
  const subjectEnabled = parseBooleanConfig(await getAppConfig("subject_mode_pack_filter_enabled", "false"));
  const objectEnabled = await isObjectModePackFilterEnabled();
  return subjectEnabled || objectEnabled;
}

export async function isSubjectPostcheckEnabled(): Promise<boolean> {
  const value = await getAppConfig("subject_postcheck_enabled", "false");
  return parseBooleanConfig(value);
}

export async function isObjectProfileEnabled(): Promise<boolean> {
  const value = await getAppConfig("object_profile_enabled", "false");
  return parseBooleanConfig(value);
}

export async function isObjectLockEnabled(): Promise<boolean> {
  const value = await getAppConfig("object_lock_enabled", "false");
  return parseBooleanConfig(value);
}

export async function isObjectModePackFilterEnabled(): Promise<boolean> {
  const value = await getAppConfig("object_mode_pack_filter_enabled", "false");
  return parseBooleanConfig(value);
}

export async function isObjectProfileShadowEnabled(): Promise<boolean> {
  const value = await getAppConfig("object_profile_shadow_enabled", "false");
  return parseBooleanConfig(value);
}

