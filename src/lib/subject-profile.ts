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

const SUBJECT_LOCK_BEGIN = "[SUBJECT LOCK BEGIN]";
const SUBJECT_LOCK_END = "[SUBJECT LOCK END]";
const LEGACY_SUBJECT_PATTERNS: RegExp[] = [
  /Subject:\s*Analyze the provided photo\.[^\n]*(?:\n|$)/gi,
  /If there is ONE person[^.]*\.(?:\s|$)/gi,
  /If there are MULTIPLE people[^.]*\.(?:\s|$)/gi,
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
  const countHint = count !== null ? ` Detected person count: ${count}.` : "";
  const sourceHint = profile.sourceKind === "sticker" ? "Source image is a sticker." : "Source image is a photo.";

  if (mode === "single") {
    return [
      SUBJECT_LOCK_BEGIN,
      `${sourceHint}${countHint}`,
      "Source contains EXACTLY ONE person.",
      "Never add extra persons, background people, reflections, or duplicates as separate persons.",
      "Keep the same identity and face features.",
      SUBJECT_LOCK_END,
    ].join("\n");
  }

  if (mode === "multi") {
    return [
      SUBJECT_LOCK_BEGIN,
      `${sourceHint}${countHint}`,
      "Source contains MULTIPLE persons.",
      "Include all persons from source; do not add or drop any person.",
      "Keep identities and relative composition/interactions.",
      SUBJECT_LOCK_END,
    ].join("\n");
  }

  return [
    SUBJECT_LOCK_BEGIN,
    `${sourceHint}${countHint}`,
    "Subject count is uncertain; preserve persons visible in source as-is.",
    "Do not invent extra people or remove clearly visible people.",
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

async function hardenDetectedProfile(detected: {
  subjectMode: SubjectMode;
  subjectCount: number | null;
  subjectConfidence: number | null;
}): Promise<{
  subjectMode: SubjectMode;
  subjectCount: number | null;
  subjectConfidence: number | null;
}> {
  let subjectMode = normalizeSubjectMode(detected.subjectMode);
  let subjectCount = normalizeCount(detected.subjectCount);
  const subjectConfidence = normalizeConfidence(detected.subjectConfidence);

  if (subjectMode === "unknown") {
    subjectMode = inferSubjectModeByCount(subjectCount);
  }

  // Guard: avoid forcing "multi" on weak/ambiguous detector output.
  if (subjectMode === "multi") {
    const minConfidence = parseNumberConfig(
      await getAppConfig("subject_multi_confidence_min", "0.85"),
      0.85
    );
    const lowConfidence = subjectConfidence === null || subjectConfidence < minConfidence;
    if (lowConfidence) {
      const fallbackMode = normalizeSubjectMode(
        await getAppConfig("subject_multi_low_confidence_fallback", "unknown")
      );
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
  subjectMode: SubjectMode;
  subjectCount: number | null;
  subjectConfidence: number | null;
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

  let subjectMode = normalizeSubjectMode(
    parsed?.subject_mode ?? parsed?.subjectMode ?? parsed?.mode
  );
  let subjectCount = normalizeCount(parsed?.subject_count ?? parsed?.subjectCount ?? parsed?.count);
  let subjectConfidence = normalizeConfidence(parsed?.subject_confidence ?? parsed?.subjectConfidence ?? parsed?.confidence);

  if (!parsed) {
    const modeMatch = text.match(/\b(single|multi|unknown)\b/i);
    if (modeMatch?.[1]) {
      subjectMode = normalizeSubjectMode(modeMatch[1]);
    }
    const countMatch =
      text.match(/subject[_\s-]*count[^0-9]{0,8}([0-9]+)/i) ||
      text.match(/\b([0-9]+)\s*(?:person|people)\b/i);
    if (countMatch?.[1]) {
      subjectCount = normalizeCount(countMatch[1]);
    }
    const confidenceMatch = text.match(/confidence[^0-9]{0,8}(0(?:\.[0-9]+)?|1(?:\.0+)?)/i);
    if (confidenceMatch?.[1]) {
      subjectConfidence = normalizeConfidence(Number(confidenceMatch[1]));
    }
  }

  if (subjectMode === "unknown") {
    subjectMode = inferSubjectModeByCount(subjectCount);
  }
  if (subjectMode !== "unknown" && subjectCount === null) {
    subjectCount = subjectMode === "single" ? 1 : null;
  }

  return { subjectMode, subjectCount, subjectConfidence };
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
      "Count distinct real people visible in the source image.",
      "Return strict JSON only with keys:",
      '{"subject_mode":"single|multi|unknown","subject_count":number|null,"subject_confidence":0..1}',
      "Rules:",
      "- single = exactly 1 person",
      "- multi = 2 or more persons",
      "- unknown if cannot decide reliably",
      "- Do not count reflections, posters, statues, toys, drawings as people",
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
  const value = await getAppConfig("subject_profile_enabled", "false");
  return parseBooleanConfig(value);
}

export async function isSubjectLockEnabled(): Promise<boolean> {
  const value = await getAppConfig("subject_lock_enabled", "false");
  return parseBooleanConfig(value);
}

export async function isSubjectModePackFilterEnabled(): Promise<boolean> {
  const value = await getAppConfig("subject_mode_pack_filter_enabled", "false");
  return parseBooleanConfig(value);
}

export async function isSubjectPostcheckEnabled(): Promise<boolean> {
  const value = await getAppConfig("subject_postcheck_enabled", "false");
  return parseBooleanConfig(value);
}

