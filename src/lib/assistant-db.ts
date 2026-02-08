import { supabase } from "./supabase";
import { config } from "../config";
import type { AssistantMessage, AssistantParams } from "./ai-chat";

// ============================================
// Types
// ============================================

export interface AssistantSessionRow {
  id: string;
  session_id: string | null;
  user_id: string;
  goal: string | null;
  style: string | null;
  emotion: string | null;
  pose: string | null;
  sticker_text: string | null;
  confirmed: boolean;
  current_step: number;
  messages: AssistantMessage[];
  error_count: number;
  pending_photo_file_id: string | null;
  status: "active" | "completed" | "abandoned" | "error";
  env: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// ============================================
// CRUD Functions
// ============================================

/**
 * Create a new assistant session linked to a sessions row.
 */
export async function createAssistantSession(
  userId: string,
  sessionId: string,
  initialMessages: AssistantMessage[] = []
): Promise<AssistantSessionRow | null> {
  const { data, error } = await supabase
    .from("assistant_sessions")
    .insert({
      user_id: userId,
      session_id: sessionId,
      messages: initialMessages,
      env: config.appEnv,
    })
    .select()
    .single();

  if (error) {
    console.error("createAssistantSession error:", error.message);
    return null;
  }
  return data;
}

/**
 * Get the active assistant session for a user.
 */
export async function getActiveAssistantSession(userId: string): Promise<AssistantSessionRow | null> {
  const { data, error } = await supabase
    .from("assistant_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("env", config.appEnv)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("getActiveAssistantSession error:", error.message);
    return null;
  }
  return data;
}

/**
 * Update assistant session fields (partial update).
 */
export async function updateAssistantSession(
  id: string,
  data: Partial<Omit<AssistantSessionRow, "id" | "user_id" | "created_at" | "env">>
): Promise<void> {
  const { error } = await supabase
    .from("assistant_sessions")
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("updateAssistantSession error:", error.message);
  }
}

/**
 * Close an assistant session with a final status.
 */
export async function closeAssistantSession(
  id: string,
  status: "completed" | "abandoned" | "error"
): Promise<void> {
  const { error } = await supabase
    .from("assistant_sessions")
    .update({
      status,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    console.error("closeAssistantSession error:", error.message);
  }
}

/**
 * Close all active assistant sessions for a user (when starting new dialog or switching to manual).
 */
export async function closeAllActiveAssistantSessions(
  userId: string,
  status: "abandoned" | "error" = "abandoned"
): Promise<void> {
  const { error } = await supabase
    .from("assistant_sessions")
    .update({
      status,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("env", config.appEnv);

  if (error) {
    console.error("closeAllActiveAssistantSessions error:", error.message);
  }
}

/**
 * Apply parsed AI params to assistant session fields.
 * Extracts goal from conversation if present.
 */
export function mapParamsToSessionFields(params: AssistantParams | null): Partial<AssistantSessionRow> {
  if (!params) return {};
  return {
    style: params.style || undefined,
    emotion: params.emotion || undefined,
    pose: params.pose || undefined,
    sticker_text: params.text || undefined,
    confirmed: params.confirmed || false,
    current_step: params.step || 0,
  };
}

/**
 * Get assistant session params in the format expected by handleAssistantConfirm / buildAssistantPrompt.
 */
export function getAssistantParams(session: AssistantSessionRow): {
  style: string;
  emotion: string;
  pose: string;
  text: string | null;
} {
  return {
    style: session.style || "cartoon",
    emotion: session.emotion || "happy",
    pose: session.pose || "default",
    text: session.sticker_text || null,
  };
}

/**
 * Expire old active assistant sessions (called by background processor).
 */
export async function expireOldAssistantSessions(ttlMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - ttlMs).toISOString();

  const { data, error } = await supabase
    .from("assistant_sessions")
    .update({
      status: "abandoned",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("status", "active")
    .lt("updated_at", cutoff)
    .select("id");

  if (error) {
    console.error("expireOldAssistantSessions error:", error.message);
    return 0;
  }

  return data?.length || 0;
}
