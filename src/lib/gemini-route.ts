import { config } from "../config";
import { getAppConfig } from "./app-config";

const DIRECT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const GEMINI_USE_PROXY_KEY = "gemini_use_proxy";

function parseBooleanConfig(value: string | null | undefined, fallback: boolean): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;

  const normalized = raw.toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "boolean") return parsed;
    if (typeof parsed === "number") return parsed !== 0;
    if (typeof parsed === "string") {
      const parsedNorm = parsed.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(parsedNorm)) return true;
      if (["false", "0", "no", "n", "off"].includes(parsedNorm)) return false;
    }
  } catch {
    // Keep fallback for malformed values.
  }

  return fallback;
}

export async function shouldUseGeminiProxy(): Promise<boolean> {
  const value = await getAppConfig(GEMINI_USE_PROXY_KEY, "true");
  return parseBooleanConfig(value, true);
}

export async function getGeminiBaseUrlRuntime(): Promise<string> {
  const useProxy = await shouldUseGeminiProxy();
  const base = useProxy ? config.geminiApiBaseUrl : DIRECT_GEMINI_BASE_URL;
  return String(base || DIRECT_GEMINI_BASE_URL).replace(/\/+$/, "");
}

export async function getGeminiGenerateContentUrlRuntime(model: string): Promise<string> {
  const baseUrl = await getGeminiBaseUrlRuntime();
  return `${baseUrl}/v1beta/models/${model}:generateContent`;
}

export async function getGeminiRouteInfoRuntime(): Promise<{ baseUrl: string; host: string; viaProxy: boolean }> {
  const baseUrl = await getGeminiBaseUrlRuntime();
  let host = "unknown";
  try {
    host = new URL(baseUrl).host;
  } catch {
    // Keep "unknown" if URL is malformed.
  }
  return {
    baseUrl,
    host,
    viaProxy: host !== "generativelanguage.googleapis.com",
  };
}
