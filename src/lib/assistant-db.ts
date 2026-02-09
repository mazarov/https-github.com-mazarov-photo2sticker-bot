import { supabase } from "./supabase";
import { config } from "../config";
import type { AssistantMessage, ToolCall } from "./ai-chat";

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
  border: boolean;
  confirmed: boolean;
  current_step: number;
  messages: AssistantMessage[];
  error_count: number;
  pending_photo_file_id: string | null;
  paywall_shown: boolean;
  paywall_shown_at: string | null;
  sales_attempts: number;
  status: "active" | "completed" | "abandoned" | "error";
  env: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// ============================================
// Tool Call Handler (merge with existing data)
// ============================================

export type ToolAction = "params" | "confirm" | "photo" | "show_examples" | "grant_credit" | "deny_credit" | "check_balance" | "none";

export interface ToolCallResult {
  updates: Partial<AssistantSessionRow>;
  action: ToolAction;
}

/**
 * Handle a function call from LLM. Merges new params with existing session data.
 * Returns both the DB updates and the semantic action to take.
 */
export function handleToolCall(
  toolCall: ToolCall,
  aSession: AssistantSessionRow
): ToolCallResult {
  if (toolCall.name === "update_sticker_params") {
    const args = toolCall.args;
    // Merge new params with existing, only include defined values to avoid Supabase issues
    const updates: Partial<AssistantSessionRow> = {};
    const newStyle = args.style || aSession.style;
    const newEmotion = args.emotion || aSession.emotion;
    const newPose = args.pose || aSession.pose;
    if (newStyle) updates.style = newStyle;
    if (newEmotion) updates.emotion = newEmotion;
    if (newPose) updates.pose = newPose;
    if (args.border !== undefined) updates.border = Boolean(args.border);
    return {
      updates,
      action: "params",
    };
  }

  if (toolCall.name === "confirm_and_generate") {
    return {
      updates: { confirmed: true },
      action: "confirm",
    };
  }

  if (toolCall.name === "request_photo") {
    return {
      updates: {},
      action: "photo",
    };
  }

  if (toolCall.name === "show_style_examples") {
    return {
      updates: {},
      action: "show_examples",
    };
  }

  if (toolCall.name === "grant_trial_credit") {
    const args = toolCall.args;
    const tag = `[trial: ${args.decision}, confidence: ${args.confidence}, reason: ${args.reason}]`;
    return {
      updates: {
        goal: `${aSession.goal || ""} ${tag}`.trim(),
      },
      action: args.decision === "grant" ? "grant_credit" : "deny_credit",
    };
  }

  if (toolCall.name === "check_balance") {
    return { updates: {}, action: "check_balance" };
  }

  return { updates: {}, action: "none" };
}

// ============================================
// State Injection (injected into system prompt)
// ============================================

/**
 * Build [SYSTEM STATE] block to inject before each LLM call.
 * Tells the LLM which params are collected and which are still needed.
 */
export function buildStateInjection(
  aSession: AssistantSessionRow,
  options?: {
    availableStyles?: Array<{ id: string; name_en: string }>;
    trialBudgetRemaining?: number;  // Only injected when credits=0, has_purchased=false
  }
): string {
  const collected: Record<string, string | boolean | null> = {
    style: aSession.style || null,
    emotion: aSession.emotion || null,
    pose: aSession.pose || null,
    border: aSession.border ?? null,
  };

  const missing = Object.entries(collected)
    .filter(([k, v]) => v === null && k !== "border")
    .map(([k]) => k);

  const lines = [
    `\n[SYSTEM STATE]`,
    `Collected: ${JSON.stringify(collected)}`,
  ];

  if (aSession.goal) {
    lines.push(`Goal: ${aSession.goal}`);
  }

  if (missing.length > 0) {
    lines.push(`Still need: ${missing.join(", ")}`);
  } else {
    lines.push(`All parameters collected. Show mirror and wait for user confirmation.`);
  }

  // Inject available styles for show_style_examples tool
  if (options?.availableStyles && options.availableStyles.length > 0) {
    const styleList = options.availableStyles.map(s => s.id).join(", ");
    lines.push(`Available style IDs for examples: ${styleList}`);
  }

  // Inject trial budget (only when user has 0 credits and never purchased)
  if (options?.trialBudgetRemaining !== undefined) {
    const remaining = options.trialBudgetRemaining;
    lines.push(`Trial budget today: ${remaining}/20 remaining`);
    if (remaining === 0) {
      lines.push(`Budget exhausted — do NOT call grant_trial_credit, show paywall instead`);
    } else if (remaining <= 5) {
      lines.push(`Budget low — grant ONLY to exceptional leads`);
    }
  }

  // Inject paywall state for post-paywall behavior
  if (aSession.paywall_shown) {
    lines.push(`paywall_shown: true`);
    if (aSession.paywall_shown_at) {
      lines.push(`paywall_shown_at: ${aSession.paywall_shown_at}`);
    }
    lines.push(`Do NOT show paywall again. Use a different angle to build value.`);
  }

  // Inject sales attempts counter
  if (aSession.sales_attempts > 0) {
    lines.push(`sales_attempts_used: ${aSession.sales_attempts}/3`);
    if (aSession.sales_attempts >= 3) {
      lines.push(`Max sales attempts reached. Do NOT try to sell anymore.`);
    }
  }

  lines.push(`DO NOT ask for already collected parameters.`);
  return lines.join("\n");
}

// ============================================
// Helper: check if all params are collected
// ============================================

export function allParamsCollected(aSession: AssistantSessionRow): boolean {
  return !!(aSession.style && aSession.emotion && aSession.pose);
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
 * Get assistant session params in the format expected by handleAssistantConfirm / buildAssistantPrompt.
 */
export function getAssistantParams(session: AssistantSessionRow): {
  style: string;
  emotion: string;
  pose: string;
} {
  return {
    style: session.style || "cartoon",
    emotion: session.emotion || "happy",
    pose: session.pose || "default",
  };
}

/**
 * Get the most recent assistant session for a user regardless of status.
 * Used as a fallback when getActiveAssistantSession returns null (session was unexpectedly closed).
 * Only returns sessions updated within the last `maxAgeMs` milliseconds.
 */
export async function getRecentAssistantSession(
  userId: string,
  maxAgeMs: number = 5 * 60 * 1000
): Promise<AssistantSessionRow | null> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  const { data, error } = await supabase
    .from("assistant_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .gte("updated_at", cutoff)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("getRecentAssistantSession error:", error.message);
    return null;
  }
  return data;
}

/**
 * Reactivate a previously closed assistant session.
 */
export async function reactivateAssistantSession(id: string): Promise<void> {
  const { error } = await supabase
    .from("assistant_sessions")
    .update({
      status: "active",
      completed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    console.error("reactivateAssistantSession error:", error.message);
  }
}

/**
 * Get the last known goal for a user from any assistant session (active, completed, abandoned).
 * Used when starting a new dialog to avoid re-asking the goal.
 */
export async function getLastGoalForUser(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from("assistant_sessions")
    .select("goal")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .not("goal", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.goal || null;
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
