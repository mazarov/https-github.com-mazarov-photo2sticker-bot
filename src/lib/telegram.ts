import axios from "axios";
import FormData from "form-data";
import { config } from "../config";

const apiBase = `https://api.telegram.org/bot${config.telegramBotToken}`;

export async function getMe() {
  const res = await axios.get(`${apiBase}/getMe`);
  if (!res.data?.ok) {
    throw new Error(`Telegram getMe failed: ${JSON.stringify(res.data)}`);
  }
  return res.data.result as { username?: string };
}

export async function getFilePath(fileId: string): Promise<string> {
  const res = await axios.get(`${apiBase}/getFile`, { params: { file_id: fileId } });
  if (!res.data?.ok) {
    throw new Error(`Telegram getFile failed: ${JSON.stringify(res.data)}`);
  }
  return res.data.result.file_path as string;
}

export async function downloadFile(filePath: string): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

export async function sendMessage(chatId: number, text: string, replyMarkup?: any): Promise<{ message_id: number } | null> {
  try {
    console.log("sendMessage payload:", JSON.stringify({ chat_id: chatId, text: text.substring(0, 50), reply_markup: replyMarkup }));
    const res = await axios.post(`${apiBase}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
    if (res.data?.ok && res.data.result?.message_id) {
      return { message_id: res.data.result.message_id };
    }
    console.error("sendMessage unexpected response:", res.data);
    return null;
  } catch (err: any) {
    console.error("sendMessage error:", err.response?.data || err.message);
    return null;
  }
}

export async function editMessageText(chatId: number, messageId: number, text: string) {
  await axios.post(`${apiBase}/editMessageText`, {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

export async function deleteMessage(chatId: number, messageId: number) {
  await axios.post(`${apiBase}/deleteMessage`, {
    chat_id: chatId,
    message_id: messageId,
  });
}

export async function sendPhoto(
  chatId: number,
  photoBuffer: Buffer,
  caption?: string,
  replyMarkup?: any
): Promise<{ message_id: number; file_id: string } | null> {
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", photoBuffer, {
      filename: "photo.png",
      contentType: "image/png",
    });
    if (caption) {
      form.append("caption", caption);
    }
    if (replyMarkup) {
      form.append("reply_markup", JSON.stringify(replyMarkup));
    }

    const res = await axios.post(`${apiBase}/sendPhoto`, form, { headers: form.getHeaders() });
    if (!res.data?.ok) {
      console.error("sendPhoto unexpected response:", res.data);
      return null;
    }
    const photos = res.data.result?.photo;
    const largestPhoto = photos?.[photos.length - 1];
    return {
      message_id: res.data.result.message_id,
      file_id: largestPhoto?.file_id || "",
    };
  } catch (err: any) {
    console.error("sendPhoto error:", err.response?.data || err.message);
    return null;
  }
}

export async function sendSticker(
  chatId: number,
  stickerBuffer: Buffer,
  replyMarkup?: any
): Promise<string> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("sticker", stickerBuffer, {
    filename: "sticker.webp",
    contentType: "image/webp",
  });
  if (replyMarkup) {
    form.append("reply_markup", JSON.stringify(replyMarkup));
  }

  const res = await axios.post(`${apiBase}/sendSticker`, form, { headers: form.getHeaders() });
  if (!res.data?.ok) {
    throw new Error(`Telegram sendSticker failed: ${JSON.stringify(res.data)}`);
  }

  const fileId = res.data.result?.sticker?.file_id;
  return fileId as string;
}
