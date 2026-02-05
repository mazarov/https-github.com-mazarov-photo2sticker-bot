import axios from "axios";
import os from "os";
import FormData from "form-data";
import sharp from "sharp";
import { config } from "./config";
import { supabase } from "./lib/supabase";
import { getFilePath, downloadFile, sendMessage, sendSticker, editMessageText, deleteMessage } from "./lib/telegram";
import { getText } from "./lib/texts";
import { sendAlert, sendNotification } from "./lib/alerts";

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
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

async function runJob(job: any) {
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
    .select("telegram_id, lang, sticker_set_name, username, credits, total_generations")
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
  const generationType =
    session.generation_type || 
    (session.state === "processing_emotion" ? "emotion" : 
     session.state === "processing_motion" ? "motion" :
     session.state === "processing_text" ? "text" : "style");

  const sourceFileId =
    generationType === "emotion" || generationType === "motion" || generationType === "text"
      ? session.last_sticker_file_id
      : session.current_photo_file_id || photos[photos.length - 1];

  if (!sourceFileId) {
    throw new Error("No source file for generation");
  }

  await updateProgress(2);
  const filePath = await getFilePath(sourceFileId);
  const fileBuffer = await downloadFile(filePath);

  const base64 = fileBuffer.toString("base64");
  const mimeType = filePath.endsWith(".webp")
    ? "image/webp"
    : filePath.endsWith(".png")
      ? "image/png"
      : "image/jpeg";

  await updateProgress(3);
  console.log("Calling Gemini image generation...");
  console.log("generationType:", generationType);
  console.log("session.generation_type:", session.generation_type);
  console.log("session.state:", session.state);
  console.log("Full prompt:", session.prompt_final);
  console.log("text_prompt:", session.text_prompt);

  // Select model: better quality for first free generation
  const model = job.is_first_free 
    ? "gemini-2.5-flash-image"  // TODO: change to better model for wow-effect
    : "gemini-2.5-flash-image"; // Standard model
  console.log("Using model:", model, "is_first_free:", job.is_first_free);

  let geminiRes;
  try {
    geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        contents: [
          {
            role: "user",
            parts: [
              { text: session.prompt_final || "" },
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
        sessionId: session.id, 
        generationType,
        status: errorStatus,
        errorCode: err.code,
        errorData: JSON.stringify(errorData || {}).slice(0, 300),
      },
    });
    throw new Error(`Gemini API failed: ${errorMessage}`);
  }

  const imageBase64 =
    geminiRes.data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData
      ?.data || null;

  if (!imageBase64) {
    console.error("Gemini response:", JSON.stringify(geminiRes.data, null, 2));
    const geminiText = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No text response";
    await sendAlert({
      type: "generation_failed",
      message: "Gemini returned no image",
      details: { 
        sessionId: session.id, 
        generationType,
        geminiResponse: geminiText.slice(0, 200),
      },
    });
    throw new Error("Gemini returned no image");
  }

  console.log("Image generated successfully");

  await updateProgress(4);
  const generatedBuffer = Buffer.from(imageBase64, "base64");
  const paddedBuffer = await sharp(generatedBuffer)
    .extend({
      top: 30,
      bottom: 30,
      left: 30,
      right: 30,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .toBuffer();

  await updateProgress(5);
  // Remove background (rembg first, Pixian fallback)
  const imageSizeKb = Math.round(paddedBuffer.length / 1024);
  const rembgUrl = process.env.REMBG_URL;
  
  let noBgBuffer: Buffer;
  const startTime = Date.now();
  
  // Try rembg (self-hosted) first
  if (rembgUrl) {
    // Resize image for faster rembg processing (max 512px - same as final sticker size)
    const rembgBuffer = await sharp(paddedBuffer)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    const rembgSizeKb = Math.round(rembgBuffer.length / 1024);
    console.log(`[rembg] Starting request to ${rembgUrl} (resized: ${rembgSizeKb} KB, original: ${imageSizeKb} KB)`);
    
    // Health check first to see if rembg is reachable
    try {
      const healthStart = Date.now();
      const healthRes = await axios.get(`${rembgUrl}/health`, { timeout: 5000 });
      console.log(`[rembg] Health check OK (${Date.now() - healthStart}ms):`, healthRes.data);
    } catch (healthErr: any) {
      console.error(`[rembg] Health check FAILED: ${healthErr.code || healthErr.message}`);
      // Continue anyway, maybe just health endpoint is slow
    }
    
    const rembgForm = new FormData();
    rembgForm.append("image", rembgBuffer, {
      filename: "image.png",
      contentType: "image/png",
    });
    
    try {
      let attemptNum = 0;
      const rembgRes = await retryWithBackoff(
        () => {
          attemptNum++;
          const attemptStart = Date.now();
          console.log(`[rembg] Attempt ${attemptNum}/2 starting...`);
          return axios.post(`${rembgUrl}/remove-background`, rembgForm, {
            headers: rembgForm.getHeaders(),
            responseType: "arraybuffer",
            timeout: 90000, // 90 seconds for CPU processing
          }).then(res => {
            console.log(`[rembg] Attempt ${attemptNum} completed in ${Date.now() - attemptStart}ms`);
            return res;
          });
        },
        { maxAttempts: 2, baseDelayMs: 3000, name: "rembg" }
      );
      const duration = Date.now() - startTime;
      const processingTime = rembgRes.headers?.['x-processing-time-ms'] || 'unknown';
      console.log(`[rembg] SUCCESS total=${duration}ms, server_processing=${processingTime}ms`);
      noBgBuffer = Buffer.from(rembgRes.data);
    } catch (rembgErr: any) {
      const duration = Date.now() - startTime;
      console.error(`[rembg] FAILED after ${duration}ms:`);
      console.error(`[rembg]   code: ${rembgErr.code || 'none'}`);
      console.error(`[rembg]   message: ${rembgErr.message}`);
      console.error(`[rembg]   status: ${rembgErr.response?.status || 'no response'}`);
      console.error(`[rembg]   response: ${rembgErr.response?.data ? Buffer.from(rembgErr.response.data).toString().slice(0, 200) : 'none'}`);
      // Fall through to Pixian
    }
  }
  
  // Fallback to Pixian if rembg not configured or failed
  if (!noBgBuffer!) {
    console.log(`Calling Pixian to remove background... (image size: ${imageSizeKb} KB)`);
    const pixianForm = new FormData();
    pixianForm.append("image", paddedBuffer, {
      filename: "image.png",
      contentType: "image/png",
    });

    try {
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
      console.log(`Pixian background removal successful (took ${duration}ms)`);
      noBgBuffer = Buffer.from(pixianRes.data);
    } catch (err: any) {
      const duration = Date.now() - startTime;
      const responseBody = err.response?.data ? 
        (typeof err.response.data === 'string' ? err.response.data : err.response.data.toString?.().slice(0, 500)) : 
        'no response body';
      
      console.error("=== Background removal failed (all methods) ===");
      console.error("Status:", err.response?.status || "no status");
      console.error("Message:", err.message);
      console.error("Code:", err.code);
      console.error("Duration:", duration, "ms");
      
      await sendAlert({
        type: "rembg_failed",
        message: `Background removal failed: ${err.response?.status || err.code || "unknown"} ${err.message}`,
        details: { 
          sessionId: session.id,
          imageSizeKb,
          durationMs: duration,
          errorCode: err.code,
          rembgConfigured: !!rembgUrl,
        },
      });
      throw new Error(`Background removal failed: ${err.message}`);
    }
  }

  await updateProgress(6);
  // Trim transparent borders and fit into 512x512
  const stickerBuffer = await sharp(noBgBuffer)
    .trim({ threshold: 10 })
    .resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp()
    .toBuffer();

  await updateProgress(7);
  const filePathStorage = `stickers/${session.user_id}/${session.id}/${Date.now()}.webp`;

  // Insert sticker record first to get ID for callback_data
  console.time("step7_insert");
  const { data: stickerRecord } = await supabase
    .from("stickers")
    .insert({
      user_id: session.user_id,
      session_id: session.id,
      source_photo_file_id: generationType === "emotion" ? session.current_photo_file_id : sourceFileId,
      user_input: session.user_input || null,
      generated_prompt: session.prompt_final || null,
      result_storage_path: filePathStorage,
      sticker_set_name: user?.sticker_set_name || null,
    })
    .select("id")
    .single();
  console.timeEnd("step7_insert");

  const stickerId = stickerRecord?.id;
  console.log("stickerId after insert:", stickerId);

  const addToPackText = await getText(lang, "btn.add_to_pack");
  const changeStyleText = await getText(lang, "btn.change_style");
  const changeEmotionText = await getText(lang, "btn.change_emotion");
  const changeMotionText = await getText(lang, "btn.change_motion");
  const addTextText = await getText(lang, "btn.add_text");

  // Use sticker ID in callback_data for message binding
  const replyMarkup = {
    inline_keyboard: [
      [{ text: addToPackText, callback_data: stickerId ? `add_to_pack:${stickerId}` : "add_to_pack" }],
      [
        { text: changeStyleText, callback_data: stickerId ? `change_style:${stickerId}` : "change_style" },
        { text: changeEmotionText, callback_data: stickerId ? `change_emotion:${stickerId}` : "change_emotion" },
      ],
      [
        { text: changeMotionText, callback_data: stickerId ? `change_motion:${stickerId}` : "change_motion" },
        { text: addTextText, callback_data: stickerId ? `add_text:${stickerId}` : "add_text" },
      ],
    ],
  };

  // Send sticker first (critical path - user sees result)
  console.time("step7_sendSticker");
  const stickerFileId = await sendSticker(telegramId, stickerBuffer, replyMarkup);
  console.timeEnd("step7_sendSticker");

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

  // Increment total_generations counter
  await supabase
    .from("users")
    .update({ total_generations: (user.total_generations || 0) + 1 })
    .eq("id", session.user_id);
  console.log("total_generations incremented for user:", session.user_id);

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
  }).catch(console.error);

  // Send rating request after 3 seconds (fire-and-forget)
  if (stickerId) {
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
    }, 3000);
  }

  // Create feedback trigger if user has 0 credits (fire-and-forget)
  if (user.credits === 0) {
    (async () => {
      try {
        // Check if pending trigger already exists (partial unique index doesn't work with upsert)
        const { data: existing } = await supabase
          .from("notification_triggers")
          .select("id")
          .eq("user_id", session.user_id)
          .eq("trigger_type", "feedback_zero_credits")
          .eq("status", "pending")
          .maybeSingle();
        
        if (existing) {
          console.log("Feedback trigger already exists for user:", session.user_id);
          return;
        }
        
        const fireAfter = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // +15 min
        await supabase.from("notification_triggers").insert({
          user_id: session.user_id,
          telegram_id: user.telegram_id,
          trigger_type: "feedback_zero_credits",
          fire_after: fireAfter,
          status: "pending",
        });
        console.log("Feedback trigger created for user:", session.user_id);
      } catch (err) {
        console.error("Failed to create feedback trigger:", err);
      }
    })();
  }

  await clearProgress();

  // Upload to storage in background (non-critical, can be slow)
  console.time("step7_upload");
  supabase.storage
    .from(config.supabaseStorageBucket)
    .upload(filePathStorage, stickerBuffer, { contentType: "image/webp", upsert: true })
    .then(() => console.timeEnd("step7_upload"))
    .catch((err) => {
      console.timeEnd("step7_upload");
      console.error("Storage upload failed:", err);
    });

  await supabase
    .from("sessions")
    .update({
      state: "confirm_sticker",
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

      // Refund credits on error
      try {
        const { data: session } = await supabase
          .from("sessions")
          .select("user_id, photos, credits_spent")
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

            // Notify user
            if (refundUser.telegram_id) {
              const errorMessage = await getText(refundUser.lang || "en", "processing.error");
              await sendMessage(refundUser.telegram_id, errorMessage);
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
