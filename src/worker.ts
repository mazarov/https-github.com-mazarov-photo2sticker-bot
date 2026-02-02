import axios from "axios";
import FormData from "form-data";
import sharp from "sharp";
import { config } from "./config";
import { supabase } from "./lib/supabase";
import { getFilePath, downloadFile, getMe, sendMessage } from "./lib/telegram";
import { getText } from "./lib/texts";

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

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
    .select("telegram_id, lang")
    .eq("id", session.user_id)
    .maybeSingle();

  const telegramId = user?.telegram_id;
  const lang = user?.lang || "en";
  if (!telegramId) {
    throw new Error("User telegram_id not found");
  }

  const photos = Array.isArray(session.photos) ? session.photos : [];
  if (photos.length === 0) {
    throw new Error("No photos in session");
  }

  const botUsername = config.botUsername || (await getMe()).username || "bot";
  const shortId = session.id.replace(/-/g, "").substring(0, 8);
  const timestamp = Date.now().toString().slice(-6);
  const stickerSetName = `p2s_${shortId}_${timestamp}_by_${botUsername}`.toLowerCase();

  let createdStickerSet = false;

  for (let i = 0; i < photos.length; i += 1) {
    const fileId = photos[i];
    const filePath = await getFilePath(fileId);
    const fileBuffer = await downloadFile(filePath);

    const base64 = fileBuffer.toString("base64");

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
                    mimeType: "image/jpeg",
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

    const generatedBuffer = Buffer.from(imageBase64, "base64");

    // Remove background with Pixian
    console.log("Calling Pixian to remove background...");
    const pixianForm = new FormData();
    pixianForm.append("image", generatedBuffer, {
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

    // Resize to 512x512 and convert to webp
    const stickerBuffer = await sharp(noBgBuffer)
      .resize(512, 512, { fit: "fill" })
      .webp()
      .toBuffer();

    // Upload to Supabase Storage
    const filePathStorage = `stickers/${session.user_id}/${session.id}/${Date.now()}_${i}.webp`;
    await supabase.storage
      .from(config.supabaseStorageBucket)
      .upload(filePathStorage, stickerBuffer, { contentType: "image/webp", upsert: true });

    // Save sticker to history
    await supabase.from("stickers").insert({
      user_id: session.user_id,
      session_id: session.id,
      source_photo_file_id: fileId,
      user_input: session.user_input || null,
      generated_prompt: session.prompt_final || null,
      result_storage_path: filePathStorage,
      sticker_set_name: stickerSetName,
    });

    // Create or add sticker set
    const form = new FormData();

    if (!createdStickerSet) {
      form.append("user_id", String(telegramId));
      form.append("name", stickerSetName);
      form.append("title", "My Stickers");
      form.append(
        "stickers",
        JSON.stringify([
          {
            sticker: `attach://file${i}`,
            format: "static",
            emoji_list: ["🔥"],
          },
        ])
      );
      form.append("needs_repainting", "false");
    } else {
      form.append("user_id", String(telegramId));
      form.append("name", stickerSetName);
      form.append(
        "sticker",
        JSON.stringify({
          sticker: `attach://file${i}`,
          format: "static",
          emoji_list: ["🔥"],
        })
      );
    }

    form.append(`file${i}`, stickerBuffer, {
      filename: "sticker.webp",
      contentType: "image/webp",
    });

    if (!createdStickerSet) {
      console.log("Creating new sticker set:", stickerSetName);
      try {
        await axios.post(
          `https://api.telegram.org/bot${config.telegramBotToken}/createNewStickerSet`,
          form,
          { headers: form.getHeaders() }
        );
        console.log("Sticker set created successfully");
        createdStickerSet = true;
      } catch (err: any) {
        console.error("Telegram createNewStickerSet error:", err.response?.data || err.message);
        throw err;
      }
    } else {
      console.log("Adding sticker to set:", stickerSetName);
      try {
        await axios.post(
          `https://api.telegram.org/bot${config.telegramBotToken}/addStickerToSet`,
          form,
          { headers: form.getHeaders() }
        );
        console.log("Sticker added successfully");
      } catch (err: any) {
        console.error("Telegram addStickerToSet error:", err.response?.data || err.message);
        throw err;
      }
    }
  }

  await supabase
    .from("sessions")
    .update({ state: "done", is_active: false, sticker_set_name: stickerSetName })
    .eq("id", session.id);

  const doneMessage = await getText(lang, "processing.done", {
    link: `https://t.me/addstickers/${stickerSetName}`,
  });
  await sendMessage(telegramId, doneMessage);
}

async function poll() {
  while (true) {
    const { data: jobs } = await supabase
      .from("jobs")
      .select("*")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1);

    const job = jobs?.[0];
    if (!job) {
      await sleep(config.jobPollIntervalMs);
      continue;
    }

    await supabase
      .from("jobs")
      .update({ status: "processing" })
      .eq("id", job.id);

    try {
      await runJob(job);
      await supabase.from("jobs").update({ status: "done" }).eq("id", job.id);
    } catch (err: any) {
      console.error("Job failed:", job.id, err?.message || err);

      await supabase
        .from("jobs")
        .update({ status: "error", error: String(err?.message || err) })
        .eq("id", job.id);

      // Refund credits on error
      try {
        const { data: session } = await supabase
          .from("sessions")
          .select("user_id, photos")
          .eq("id", job.session_id)
          .maybeSingle();

        if (session?.user_id) {
          const photosCount = Array.isArray(session.photos) ? session.photos.length : 1;

          const { data: refundUser } = await supabase
            .from("users")
            .select("credits, telegram_id, lang")
            .eq("id", session.user_id)
            .maybeSingle();

          if (refundUser) {
            // Refund credits
            await supabase
              .from("users")
              .update({ credits: (refundUser.credits || 0) + photosCount })
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
