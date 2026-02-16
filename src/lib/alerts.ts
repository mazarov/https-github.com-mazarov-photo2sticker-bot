import axios from "axios";
import FormData from "form-data";
import { config } from "../config";

type AlertType = 
  | "generation_failed" 
  | "generation_started"
  | "gemini_error" 
  | "rembg_failed" 
  | "worker_error" 
  | "api_error"
  | "not_enough_credits"
  | "paywall_shown"
  | "assistant_gemini_error"
  | "trial_credit_granted"
  | "trial_credit_denied"
  | "idea_generated"
  | "onboarding_completed"
  | "pack_preview_ordered"
  | "pack_preview_failed"
  | "pack_approved"
  | "pack_completed"
  | "pack_partial"
  | "pack_failed"
  | "pack_regenerated";

interface AlertOptions {
  type: AlertType;
  message: string;
  details?: Record<string, any>;
  stack?: string;
}

const EMOJI: Record<AlertType, string> = {
  generation_failed: "🟡",
  generation_started: "🚀",
  gemini_error: "🟠",
  rembg_failed: "🟠",
  worker_error: "🔴",
  api_error: "🔴",
  not_enough_credits: "💸",
  paywall_shown: "🚪",
  assistant_gemini_error: "🤖",
  trial_credit_granted: "🎁",
  trial_credit_denied: "❌",
  idea_generated: "💡",
  onboarding_completed: "🎓",
  pack_preview_ordered: "📦",
  pack_preview_failed: "❌",
  pack_approved: "✅",
  pack_completed: "🎉",
  pack_partial: "🟡",
  pack_failed: "🔴",
  pack_regenerated: "🔄",
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
      const safeValue = String(value).slice(0, 100).replace(/[`\[\]]/g, "");
      text += `• ${key}: \`${safeValue}\`\n`;
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

// Business notifications
type NotificationType = "new_user" | "new_sticker" | "new_payment" | "abandoned_cart";

const NOTIFICATION_EMOJI: Record<NotificationType, string> = {
  new_user: "👤",
  new_sticker: "🎨",
  new_payment: "💰",
  abandoned_cart: "🛒",
};

const NOTIFICATION_TITLE: Record<NotificationType, string> = {
  new_user: "Новый пользователь",
  new_sticker: "Новый стикер",
  new_payment: "Новая оплата",
  abandoned_cart: "Брошенная корзина",
};

interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

interface NotificationOptions {
  type: NotificationType;
  message: string;
  imageBuffer?: Buffer;
  sourceImageBuffer?: Buffer;  // Исходное фото
  resultImageBuffer?: Buffer;  // Результат генерации
  buttons?: InlineButton[][];  // Inline keyboard buttons
  stickerId?: string;          // For "Make example" button on new_sticker
  styleId?: string;            // Style ID for the sticker
}

export async function sendNotification(options: NotificationOptions): Promise<void> {
  const channelId = config.alertChannelId;
  if (!channelId) {
    return;
  }

  const emoji = NOTIFICATION_EMOJI[options.type];
  const title = NOTIFICATION_TITLE[options.type];
  const escapedMessage = escapeMarkdown(options.message);
  const caption = `${emoji} *${title}*\n\n${escapedMessage}`;

  try {
    // Media group: исходное фото + результат
    if (options.sourceImageBuffer && options.resultImageBuffer) {
      const formData = new FormData();
      formData.append("chat_id", channelId);
      
      // Attach source image
      formData.append("source", new Blob([options.sourceImageBuffer], { type: "image/jpeg" }), "source.jpg");
      // Attach result image
      formData.append("result", new Blob([options.resultImageBuffer], { type: "image/webp" }), "result.webp");
      
      // Media group JSON
      const media = [
        { type: "photo", media: "attach://source", caption, parse_mode: "Markdown" },
        { type: "photo", media: "attach://result" },
      ];
      formData.append("media", JSON.stringify(media));

      const response = await fetch(
        `https://api.telegram.org/bot${config.telegramBotToken}/sendMediaGroup`,
        {
          method: "POST",
          body: formData,
        }
      );

      if (!response.ok) {
        const errorData = await response.text();
        console.error("[Notification] Failed to send media group:", errorData);
      }

      // Send follow-up message with "Make example" button if stickerId provided
      if (options.stickerId && options.styleId) {
        const buttonMessage = `⭐ Сделать примером для стиля "${options.styleId}"?`;
        const buttonResponse = await fetch(
          `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: channelId,
              text: buttonMessage,
              reply_markup: {
                inline_keyboard: [[
                  { text: "✅ Сделать примером", callback_data: `make_example:${options.stickerId}` }
                ]],
              },
            }),
          }
        );

        if (!buttonResponse.ok) {
          const errorData = await buttonResponse.text();
          console.error("[Notification] Failed to send make_example button:", errorData);
        }
      }
    } else if (options.imageBuffer) {
      // Single photo with caption
      const formData = new FormData();
      formData.append("chat_id", channelId);
      formData.append("caption", caption);
      formData.append("parse_mode", "Markdown");
      formData.append("photo", new Blob([options.imageBuffer], { type: "image/webp" }), "sticker.webp");

      const response = await fetch(
        `https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`,
        {
          method: "POST",
          body: formData,
        }
      );

      if (!response.ok) {
        const errorData = await response.text();
        console.error("[Notification] Failed to send photo:", errorData);
      }
    } else {
      // Text only (with optional buttons)
      const body: any = {
        chat_id: channelId,
        text: caption,
        parse_mode: "Markdown",
      };

      // Add inline keyboard if buttons provided
      if (options.buttons && options.buttons.length > 0) {
        body.reply_markup = {
          inline_keyboard: options.buttons,
        };
      }

      const response = await fetch(
        `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (!response.ok) {
        const errorData = await response.text();
        console.error("[Notification] Failed to send:", errorData);
      }
    }
  } catch (err) {
    console.error("[Notification] Error:", err);
  }
}

/** Send pack preview image to alert channel with "Make pack example" button when styleId is set. */
export async function sendPackPreviewAlert(
  styleId: string | null,
  imageBuffer: Buffer,
  details?: { user?: string; batchId?: string }
): Promise<void> {
  const channelId = config.alertChannelId;
  if (!channelId) return;

  const caption = `📦 Pack preview\nStyle: ${styleId ?? "—"}${details?.user ? `\nUser: ${details.user}` : ""}${details?.batchId ? `\nBatch: ${details.batchId}` : ""}`;

  try {
    const form = new FormData();
    form.append("chat_id", channelId);
    form.append("caption", caption);
    form.append("photo", imageBuffer, {
      filename: "pack_preview.png",
      contentType: "image/png",
    });
    if (styleId) {
      form.append("reply_markup", JSON.stringify({
        inline_keyboard: [[
          { text: "✅ Сделать примером", callback_data: `pack_make_example:${styleId}` },
        ]],
      }));
    }

    const response = await axios.post(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`,
      form,
      { headers: form.getHeaders(), timeout: 30000 }
    );

    if (!response.data?.ok) {
      console.error("[Alert] sendPackPreviewAlert failed:", response.data);
    }
  } catch (err: any) {
    console.error("[Alert] sendPackPreviewAlert error:", err?.response?.data || err);
  }
}
