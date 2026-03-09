import axios from "axios";
import FormData from "form-data";
import { config } from "../config";

type AlertType = 
  | "generation_failed" 
  | "generation_started"
  | "photo_uploaded"
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
  | "pack_regenerated"
  | "metrika_error"
  | "subject_profile_detected";

interface AlertOptions {
  type: AlertType;
  message: string;
  details?: Record<string, any>;
  stack?: string;
  /** When set, alert is sent as photo with caption (Telegram file_id). */
  photoFileId?: string;
}

const EMOJI: Record<AlertType, string> = {
  generation_failed: "🟡",
  generation_started: "🚀",
  photo_uploaded: "📷",
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
  metrika_error: "📊",
  subject_profile_detected: "👤",
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

  const body = text.slice(0, options.photoFileId ? 1024 : 4000); // caption limit 1024

  const sendMessageFallback = async () => {
    const response = await fetch(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: channelId,
          text,
          parse_mode: "Markdown",
        }),
      }
    );
    if (!response.ok) {
      const errorData = await response.text();
      console.error("[Alert] Failed to send fallback message alert:", errorData);
    }
  };

  try {
    if (options.photoFileId) {
      const response = await fetch(
        `https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: channelId,
            photo: options.photoFileId,
            caption: body,
            parse_mode: "Markdown",
          }),
        }
      );
      if (!response.ok) {
        const errorData = await response.text();
        console.error("[Alert] Failed to send photo alert:", errorData);
        await sendMessageFallback();
      }
    } else {
      await sendMessageFallback();
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
      formData.append("source", options.sourceImageBuffer, { filename: "source.jpg", contentType: "image/jpeg" });
      // Attach result image
      formData.append("result", options.resultImageBuffer, { filename: "result.webp", contentType: "image/webp" });
      
      // Media group JSON
      const media = [
        { type: "photo", media: "attach://source", caption, parse_mode: "Markdown" },
        { type: "photo", media: "attach://result" },
      ];
      formData.append("media", JSON.stringify(media));

      const response = await axios.post(
        `https://api.telegram.org/bot${config.telegramBotToken}/sendMediaGroup`,
        formData,
        { headers: formData.getHeaders() }
      );

      if (response.status !== 200) {
        console.error("[Notification] Failed to send media group:", response.statusText);
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
      formData.append("photo", options.imageBuffer, { filename: "sticker.webp", contentType: "image/webp" });

      const response = await axios.post(
        `https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`,
        formData,
        { headers: formData.getHeaders() }
      );

      if (response.status !== 200) {
        console.error("[Notification] Failed to send photo:", response.statusText);
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

/** Send emotion sticker to alert channel with "Сохранить пример для эмоции" button (after emotion generation). */
export async function sendEmotionExampleAlert(
  emotionId: string,
  imageBuffer: Buffer,
  details?: { user?: string }
): Promise<void> {
  const channelId = config.alertChannelId;
  if (!channelId) {
    console.warn("[Alert] sendEmotionExampleAlert skipped: ALERT_CHANNEL_ID not set");
    return;
  }

  const caption = `😊 Эмоция: ${emotionId}${details?.user ? `\nUser: ${details.user}` : ""}`;
  const replyMarkup = JSON.stringify({
    inline_keyboard: [[
      { text: "✅ Сохранить пример для эмоции", callback_data: `emotion_make_example:${emotionId}` },
    ]],
  });

  try {
    const form = new FormData();
    form.append("chat_id", channelId);
    form.append("caption", caption);
    form.append("photo", imageBuffer, {
      filename: "emotion.webp",
      contentType: "image/webp",
    });
    form.append("reply_markup", replyMarkup);

    const response = await axios.post(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`,
      form,
      { headers: form.getHeaders(), timeout: 30000 }
    );

    if (!response.data?.ok) {
      console.error("[Alert] sendEmotionExampleAlert failed:", response.data);
    } else {
      console.log("[Alert] sendEmotionExampleAlert sent, emotionId:", emotionId);
    }
  } catch (err: any) {
    console.error("[Alert] sendEmotionExampleAlert error:", err?.response?.data ?? err?.message ?? err);
  }
}

/** Send pack completed alert with "Показать на лендинге" button (для вывода пака на лендинг). */
export async function sendPackCompletedLandingAlert(
  batchId: string,
  imageBuffer: Buffer,
  details?: { user?: string; setName?: string; contentSetId?: string; styleId?: string }
): Promise<void> {
  const channelId = config.alertChannelId;
  if (!channelId) return;

  const caption =
    `📦 Пак собран — можно показать на лендинге\n` +
    `Batch: ${batchId}` +
    (details?.user ? `\nUser: ${details.user}` : "") +
    (details?.setName ? `\nSet: ${details.setName}` : "");

  try {
    const form = new FormData();
    form.append("chat_id", channelId);
    form.append("caption", caption);
    form.append("photo", imageBuffer, {
      filename: "pack_completed.webp",
      contentType: "image/webp",
    });
    form.append("reply_markup", JSON.stringify({
      inline_keyboard: [[
        { text: "🌐 Показать на лендинге", callback_data: `pack_landing:${batchId}` },
      ]],
    }));

    const response = await axios.post(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`,
      form,
      { headers: form.getHeaders(), timeout: 30000 }
    );

    if (!response.data?.ok) {
      console.error("[Alert] sendPackCompletedLandingAlert failed:", response.data);
    }
  } catch (err: any) {
    console.error("[Alert] sendPackCompletedLandingAlert error:", err?.response?.data || err);
  }
}
