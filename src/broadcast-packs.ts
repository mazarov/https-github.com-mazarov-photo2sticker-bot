/**
 * Broadcast: new pack feature — "Добавили функционал паков — попробуйте"
 *
 * Sends text + one button (open bot). Same rate limit and usage as broadcast-valentine.
 *
 * Usage:
 *   npx tsx src/broadcast-packs.ts              # dry run (count only)
 *   npx tsx src/broadcast-packs.ts --send       # actually send
 *   npx tsx src/broadcast-packs.ts --test       # send to first admin only
 *   npx tsx src/broadcast-packs.ts --test-to=123456789
 */

import "dotenv/config";
import { config } from "./config";
import { createClient } from "@supabase/supabase-js";

const BOT_TOKEN = config.telegramBotToken;
const BOT_USERNAME = config.botUsername || "Photo_2_StickerBot";
const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

const TEST_MODE = process.argv.includes("--test");
const TEST_TO = process.argv.find((a) => a.startsWith("--test-to="))?.split("=")[1];
const DRY_RUN = !process.argv.includes("--send") && !TEST_MODE && !TEST_TO;
const RATE_LIMIT_PER_SEC = 10;
const DELAY_MS = Math.ceil(1000 / RATE_LIMIT_PER_SEC);

const MESSAGE_RU = `📦 Добавили функционал паков!

Теперь можно сделать целый набор стикеров в одном стиле — идеально для подарка или своего набора в Telegram.

Попробуйте 👇`;

const MESSAGE_EN = `📦 We've added sticker packs!

You can now create a full set of stickers in one style — perfect as a gift or your own Telegram set.

Try it 👇`;

function getButtons(lang: string) {
  const tryText = lang === "ru" ? "Попробовать" : "Try it";
  // callback_data: same as tapping "📦 Пак стикеров" in the bot
  return {
    inline_keyboard: [[{ text: tryText, callback_data: "broadcast_try_pack" }]],
  };
}

async function tgApi(method: string, body: any): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendTextWithButton(chatId: number, text: string, lang: string): Promise<boolean> {
  const res = await tgApi("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: getButtons(lang),
  });
  if (!res.ok) {
    if (res.error_code === 403) return false;
    console.error(`sendMessage failed for ${chatId}:`, res.description);
    return false;
  }
  return true;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`=== Broadcast: Packs feature ===`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (add --send to actually send)" : "SENDING"}`);
  console.log(`Bot link: https://t.me/${BOT_USERNAME}`);
  console.log();

  let users: { telegram_id: string; lang: string }[] = [];

  if (TEST_MODE || TEST_TO) {
    const targetId = TEST_TO ? parseInt(TEST_TO, 10) : config.adminIds[0];
    if (!targetId || isNaN(targetId)) {
      console.error("TEST: Use --test-to=TELEGRAM_ID or set ADMIN_IDS in .env");
      process.exit(1);
    }
    users = [{ telegram_id: String(targetId), lang: "ru" }];
    console.log(`Test: sending to ${targetId}`);
  } else {
    const { data, error } = await supabase
      .from("users")
      .select("telegram_id, lang")
      .eq("env", "prod");

    if (error) {
      console.error("Failed to fetch users:", error);
      process.exit(1);
    }
    users = data || [];
    console.log(`Total users: ${users.length}`);
  }

  if (DRY_RUN) {
    console.log("\n--- DRY RUN ---");
    console.log(`Would send to ${users?.length || 0} users`);
    console.log(`Estimated time: ${Math.ceil((users?.length || 0) / RATE_LIMIT_PER_SEC)} seconds`);
    console.log(`\nExample message (RU):\n${MESSAGE_RU}`);
    console.log(`\nRun with --send to actually broadcast.`);
    process.exit(0);
  }

  let sent = 0;
  let failed = 0;
  let blocked = 0;
  const startTime = Date.now();

  for (const user of users!) {
    const chatId = Number(user.telegram_id);
    const lang = user.lang || "en";
    const message = lang === "ru" ? MESSAGE_RU : MESSAGE_EN;

    try {
      const ok = await sendTextWithButton(chatId, message, lang);
      if (!ok) {
        blocked++;
        continue;
      }
      sent++;
      if (sent % 50 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Sent: ${sent}/${users!.length} (${elapsed}s, blocked: ${blocked}, failed: ${failed})`);
      }
    } catch (err: any) {
      failed++;
      console.error(`Error for ${user.telegram_id}:`, err.message);
    }

    await sleep(DELAY_MS);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Done ===`);
  console.log(`Sent: ${sent}`);
  console.log(`Blocked: ${blocked}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total time: ${totalTime}s`);
}

main().catch(console.error);
