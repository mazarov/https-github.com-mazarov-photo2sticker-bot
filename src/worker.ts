import axios from "axios";
import os from "os";
import FormData from "form-data";
import sharp from "sharp";
import { config } from "./config";
import { supabase } from "./lib/supabase";
import { getFilePath, downloadFile, sendMessage, sendSticker, editMessageText, deleteMessage } from "./lib/telegram";
import { getText } from "./lib/texts";

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
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
    .select("telegram_id, lang, sticker_set_name")
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
     session.state === "processing_motion" ? "motion" : "style");

  const sourceFileId =
    generationType === "emotion" || generationType === "motion"
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
  console.log("Prompt:", session.prompt_final?.substring(0, 100) + "...");

  let geminiRes;
  try {
    geminiRes = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
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
    console.error("Gemini API error:", err.response?.data || err.message);
    throw new Error(`Gemini API failed: ${err.response?.data?.error?.message || err.message}`);
  }

  const imageBase64 =
    geminiRes.data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData
      ?.data || null;

  if (!imageBase64) {
    console.error("Gemini response:", JSON.stringify(geminiRes.data, null, 2));
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
  // Remove background with Pixian
  console.log("Calling Pixian to remove background...");
  const pixianForm = new FormData();
  pixianForm.append("image", paddedBuffer, {
    filename: "image.png",
    contentType: "image/png",
  });

  let pixianRes;
  try {
    pixianRes = await axios.post("https://api.pixian.ai/api/v2/remove-background", pixianForm, {
      auth: {
        username: config.pixianUsername,
        password: config.pixianPassword,
      },
      headers: pixianForm.getHeaders(),
      responseType: "arraybuffer",
    });
    console.log("Pixian background removal successful");
  } catch (err: any) {
    console.error("Pixian API error:", err.response?.status, err.response?.data?.toString?.() || err.message);
    throw new Error(`Pixian API failed: ${err.response?.status} ${err.message}`);
  }

  const noBgBuffer = Buffer.from(pixianRes.data);

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

  // Use sticker ID in callback_data for message binding
  const replyMarkup = {
    inline_keyboard: [
      [{ text: addToPackText, callback_data: stickerId ? `add_to_pack:${stickerId}` : "add_to_pack" }],
      [
        { text: changeStyleText, callback_data: stickerId ? `change_style:${stickerId}` : "change_style" },
        { text: changeEmotionText, callback_data: stickerId ? `change_emotion:${stickerId}` : "change_emotion" },
      ],
      [{ text: changeMotionText, callback_data: stickerId ? `change_motion:${stickerId}` : "change_motion" }],
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
    const { data: jobs } = await supabase
      .from("jobs")
      .update({
        status: "processing",
        worker_id: WORKER_ID,
        started_at: new Date().toISOString(),
      })
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1)
      .select("*");

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

poll().catch((e) => {
  console.error(e);
  process.exit(1);
});
