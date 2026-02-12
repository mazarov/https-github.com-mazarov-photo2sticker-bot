import axios from "axios";
import os from "os";
import FormData from "form-data";
import sharp from "sharp";
import { config } from "./config";
import { supabase } from "./lib/supabase";
import { getFilePath, downloadFile, sendMessage, sendSticker, editMessageText, deleteMessage } from "./lib/telegram";
import { getText } from "./lib/texts";
import { sendAlert, sendNotification } from "./lib/alerts";
import { chromaKeyGreen, getGreenPixelRatio } from "./lib/image-utils";

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

  const sourceFileId =
    generationType === "emotion" || generationType === "motion" || generationType === "text"
      ? session.last_sticker_file_id
      : session.current_photo_file_id || photos[photos.length - 1];

  // Debug logging for source file
  console.log("[Worker] Source file debug:", {
    generationType,
    sourceFileId: sourceFileId?.substring(0, 30) + "...",
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

  // Use Gemini 2.5 Flash for all generation types (best balance of quality/speed/cost)
  const model = "gemini-2.5-flash-image";
  console.log("Using model:", model, "generationType:", generationType);

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
    await sendMessage(telegramId, blockedMsg, {
      inline_keyboard: [[
        { text: retryBtnBlocked, callback_data: `retry_generation:${session.id}` },
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
        user: `@${user?.username || telegramId}`,
        sessionId: session.id, 
        generationType,
        styleGroup: session.selected_style_group || "-",
        styleId: session.selected_style_id || "-",
        userInput: (session.user_input || "").slice(0, 100),
        geminiResponse: geminiText.slice(0, 200),
      },
    });
    throw new Error("Gemini returned no image");
  }

  console.log("Image generated successfully");

  await updateProgress(4);
  const generatedBuffer = Buffer.from(imageBase64, "base64");

  // Pre-check: calculate green pixel ratio on original image (before rembg)
  // Used later to decide whether chroma key cleanup is needed
  let greenRatio = 0;
  try {
    const rawOriginal = await sharp(generatedBuffer).ensureAlpha().raw().toBuffer();
    greenRatio = getGreenPixelRatio(rawOriginal, 4);
    console.log(`[chromaKey] Green pixel ratio in original image: ${(greenRatio * 100).toFixed(1)}%`);
  } catch (err: any) {
    console.error(`[chromaKey] Failed to calculate green ratio: ${err.message}`);
  }

  await updateProgress(5);
  // Remove background (rembg first, Pixian fallback)
  const imageSizeKb = Math.round(generatedBuffer.length / 1024);
  const rembgUrl = process.env.REMBG_URL;
  
  let noBgBuffer: Buffer;
  const startTime = Date.now();
  
  // Try rembg (self-hosted) first
  if (rembgUrl) {
    // Resize image for faster rembg processing (max 512px - same as final sticker size)
    const rembgBuffer = await sharp(generatedBuffer)
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
    pixianForm.append("image", generatedBuffer, {
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
          user: `@${user?.username || telegramId}`,
          sessionId: session.id,
          generationType,
          styleId: session.selected_style_id || "-",
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

  // Chroma key cleanup: remove leftover green pixels after rembg
  // Only run if original image had significant green background (> 5%)
  let cleanedBuffer = noBgBuffer;
  if (greenRatio > 0.05) {
    try {
      const ckStart = Date.now();
      cleanedBuffer = await chromaKeyGreen(noBgBuffer);
      console.log(`[chromaKey] Cleanup done in ${Date.now() - ckStart}ms`);
    } catch (err: any) {
      console.error(`[chromaKey] Cleanup failed, using rembg output: ${err.message}`);
      cleanedBuffer = noBgBuffer;
    }
  } else {
    console.log(`[chromaKey] Skipped — green ratio ${(greenRatio * 100).toFixed(1)}% below 5% threshold`);
  }

  // Trim transparent borders and fit into 512x512
  const stickerBuffer = await sharp(cleanedBuffer)
    .trim({ threshold: 2 })
    .resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp()
    .toBuffer();

  await updateProgress(7);
  const filePathStorage = `stickers/${session.user_id}/${session.id}/${Date.now()}.webp`;

  // Insert sticker record first to get ID for callback_data
  const savedSourcePhotoFileId = generationType === "emotion" ? session.current_photo_file_id : sourceFileId;
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
      generated_prompt: session.prompt_final || null,
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

  const addToPackText = await getText(lang, "btn.add_to_pack");
  const changeEmotionText = await getText(lang, "btn.change_emotion");
  const changeMotionText = await getText(lang, "btn.change_motion");
  const addTextText = await getText(lang, "btn.add_text");
  const toggleBorderText = await getText(lang, "btn.toggle_border");
  const packIdeasText = lang === "ru" ? "💡 Идеи для пака" : "💡 Pack ideas";

  // Use sticker ID in callback_data for message binding
  const replyMarkup = {
    inline_keyboard: [
      [{ text: addToPackText, callback_data: stickerId ? `add_to_pack:${stickerId}` : "add_to_pack" }],
      [
        { text: changeEmotionText, callback_data: stickerId ? `change_emotion:${stickerId}` : "change_emotion" },
        { text: changeMotionText, callback_data: stickerId ? `change_motion:${stickerId}` : "change_motion" },
      ],
      [
        { text: toggleBorderText, callback_data: stickerId ? `toggle_border:${stickerId}` : "toggle_border" },
        { text: addTextText, callback_data: stickerId ? `add_text:${stickerId}` : "add_text" },
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

  // Post-generation CTA: show after first sticker (both assistant and manual mode)
  // Only for style generation (not emotion/motion iterations)
  if (!isAvatarDemo && onboardingStep <= 1 && generationType === "style" && stickerId) {
    const onboardingText = lang === "ru"
      ? "👇 Попробуй прямо сейчас:\n😊 **Изменить эмоцию** — сделай грустного, злого, влюблённого\n🏃 **Добавить движение** — танец, прыжок, бег\n💡 **Идеи для пака** — AI подберёт идеи для целого стикерпака!"
      : "👇 Try it now:\n😊 **Change emotion** — make it sad, angry, in love\n🏃 **Add motion** — dance, jump, run\n💡 **Pack ideas** — AI will suggest ideas for a whole sticker pack!";
    
    await sendMessage(telegramId, onboardingText);
    console.log("post-generation CTA sent, onboardingStep:", onboardingStep);

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

            // Notify user with retry button
            if (refundUser.telegram_id) {
              const rlang = refundUser.lang || "en";
              const errorText = rlang === "ru"
                ? "❌ Произошла ошибка при генерации стикера.\n\nКредиты возвращены на баланс."
                : "❌ An error occurred during sticker generation.\n\nCredits have been refunded.";
              const retryBtn = rlang === "ru" ? "🔄 Повторить" : "🔄 Retry";
              await sendMessage(refundUser.telegram_id, errorText, {
                inline_keyboard: [[
                  { text: retryBtn, callback_data: `retry_generation:${job.session_id}` },
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
