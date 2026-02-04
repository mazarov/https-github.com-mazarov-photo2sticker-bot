import { config } from "../config";

type AlertType = 
  | "generation_failed" 
  | "gemini_error" 
  | "rembg_failed" 
  | "worker_error" 
  | "api_error";

interface AlertOptions {
  type: AlertType;
  message: string;
  details?: Record<string, any>;
  stack?: string;
}

const EMOJI: Record<AlertType, string> = {
  generation_failed: "🟡",
  gemini_error: "🟠",
  rembg_failed: "🟠",
  worker_error: "🔴",
  api_error: "🔴",
};

export async function sendAlert(options: AlertOptions): Promise<void> {
  const channelId = config.alertChannelId;
  if (!channelId) {
    console.log("[Alert] No ALERT_CHANNEL_ID configured, skipping alert");
    return;
  }

  const emoji = EMOJI[options.type] || "⚠️";

  let text = `${emoji} *${options.type}*\n\n`;
  text += `⏰ ${new Date().toISOString()}\n\n`;
  text += `❌ ${escapeMarkdown(options.message)}\n`;

  if (options.details && Object.keys(options.details).length > 0) {
    text += `\n📋 *Details:*\n`;
    for (const [key, value] of Object.entries(options.details)) {
      text += `• ${key}: \`${String(value).slice(0, 100)}\`\n`;
    }
  }

  if (options.stack) {
    text += `\n📜 *Stack:*\n\`\`\`\n${options.stack.slice(0, 500)}\n\`\`\``;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: channelId,
          text: text.slice(0, 4000),
          parse_mode: "Markdown",
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.text();
      console.error("[Alert] Failed to send:", errorData);
    }
  } catch (err) {
    console.error("[Alert] Error sending alert:", err);
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*`\[]/g, "\\$&");
}
